import * as child_process from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { extLog } from '../logger';
import { AssetManager } from './assetManager';
import { CudaManager } from './cudaManager';

export type SupervisorMode = 'MANAGED_STANDALONE' | 'OFFLINE';

export interface SupervisorStartResult {
  mode: SupervisorMode;
  port: number;
  serverUrl: string;
  token?: string;
}

export const MANAGED_LOCKFILE_NAME = 'voxcode_managed.json';

/**
 * Returns the path to the ephemeral managed daemon lockfile.
 * Prefers globalStorageUri, then VOXCODE_STORAGE_DIR, falling back to %TEMP%.
 */
export function getManagedLockfilePath(storage?: vscode.ExtensionContext | string): string {
  if (storage) {
    const dir = typeof storage === 'string' ? storage : storage.globalStorageUri.fsPath;
    return path.join(dir, MANAGED_LOCKFILE_NAME);
  }
  if (process.env.VOXCODE_STORAGE_DIR) {
    return path.join(process.env.VOXCODE_STORAGE_DIR, MANAGED_LOCKFILE_NAME);
  }
  const tempDir = process.env.TEMP || process.env.TMP || os.tmpdir();
  return path.join(tempDir, MANAGED_LOCKFILE_NAME);
}

export interface ManagedLockData {
  pid: number;
  port: number;
  token: string;
  startedAt: number;
}

/**
 * Verifies that a target PID corresponds to a legitimate VoxCode daemon process
 * before allowing termination, guarding against lockfile tampering.
 */
export async function isVoxCodeProcess(pid: number): Promise<boolean> {
  if (!pid || pid <= 0) {
    return false;
  }
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      child_process.execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
        ],
        { timeout: 3000 },
        (err, stdout) => {
          if (err || !stdout) {
            resolve(false);
            return;
          }
          const cmd = stdout.toLowerCase();
          if (cmd.includes('voxcode') || cmd.includes('headless_daemon')) {
            resolve(true);
          } else {
            resolve(false);
          }
        }
      );
    } else {
      child_process.execFile(
        'ps',
        ['-p', pid.toString(), '-o', 'command='],
        { timeout: 3000 },
        (err, stdout) => {
          if (err || !stdout) {
            resolve(false);
            return;
          }
          const cmd = stdout.toLowerCase();
          if (cmd.includes('voxcode') || cmd.includes('headless_daemon')) {
            resolve(true);
          } else {
            resolve(false);
          }
        }
      );
    }
  });
}

/**
 * Finds a free TCP loopback port by briefly binding to port 0.
 */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/**
 * Probes a TCP port with a strict timeout to verify if a server is listening.
 */
export async function probePort(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        socket.removeAllListeners();
        socket.destroy();
      }
    };

    socket.setTimeout(timeoutMs);

    socket.once('connect', () => {
      cleanup();
      resolve(true);
    });

    socket.once('timeout', () => {
      cleanup();
      resolve(false);
    });

    socket.once('error', () => {
      cleanup();
      resolve(false);
    });

    try {
      socket.connect(port, host);
    } catch {
      cleanup();
      resolve(false);
    }
  });
}

/**
 * Process Supervisor managing the self-contained background daemon lifecycle.
 * Spawns a dedicated headless background daemon or connects to an existing instance
 * tracked via an isolated lockfile in globalStorageUri.
 */
export class ProcessSupervisor implements vscode.Disposable {
  private childProcess: child_process.ChildProcess | null = null;
  private isChildOwner = false;
  private currentMode: SupervisorMode = 'OFFLINE';
  private currentPort = 0;
  private inMemoryToken?: string;
  private outputChannel: vscode.OutputChannel;
  private isDisposing = false;
  private secondaryLivenessTimer: NodeJS.Timeout | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel('VoxCode Daemon');
    context.subscriptions.push(this.outputChannel);
  }

  private getLockPath(): string {
    return getManagedLockfilePath(this.context);
  }

  public getMode(): SupervisorMode {
    return this.currentMode;
  }

  public getPort(): number {
    return this.currentPort;
  }

  public getToken(): string | undefined {
    return this.inMemoryToken;
  }

  public isRunning(): boolean {
    return (
      (this.childProcess !== null && !this.childProcess.killed) ||
      (this.currentMode === 'MANAGED_STANDALONE' && !this.isDisposing)
    );
  }

  public showLogs(): void {
    this.outputChannel.show(true);
  }

  /**
   * Resets secondary supervisor state when bridge client disconnects.
   */
  public handleClientDisconnect(): void {
    if (!this.isChildOwner && this.currentMode === 'MANAGED_STANDALONE') {
      extLog('INFO', 'Client disconnected in secondary window mode; resetting supervisor to OFFLINE');
      this.currentMode = 'OFFLINE';
      this.stopSecondaryLivenessProbe();
    }
  }

  private startSecondaryLivenessProbe(port: number): void {
    this.stopSecondaryLivenessProbe();
    this.secondaryLivenessTimer = setInterval(async () => {
      if (this.currentMode !== 'MANAGED_STANDALONE' || this.isChildOwner || this.isDisposing) {
        this.stopSecondaryLivenessProbe();
        return;
      }
      const isAlive = await probePort('127.0.0.1', port, 500);
      if (!isAlive) {
        extLog('WARN', `Secondary supervisor detected daemon on port ${port} is no longer running.`);
        this.currentMode = 'OFFLINE';
        this.stopSecondaryLivenessProbe();
      }
    }, 3000);
  }

  private stopSecondaryLivenessProbe(): void {
    if (this.secondaryLivenessTimer) {
      clearInterval(this.secondaryLivenessTimer);
      this.secondaryLivenessTimer = null;
    }
  }

  /**
   * Evaluates existing lockfile and starts or connects to the managed standalone daemon.
   */
  public async start(): Promise<SupervisorStartResult> {
    if (this.isDisposing) {
      return { mode: 'OFFLINE', port: this.currentPort, serverUrl: `ws://127.0.0.1:${this.currentPort}` };
    }

    extLog('INFO', 'ProcessSupervisor start() called');

    const storageDir = this.context.globalStorageUri.fsPath;
    if (!fs.existsSync(storageDir)) {
      try {
        fs.mkdirSync(storageDir, { recursive: true });
      } catch (e) {
        extLog('WARN', 'Could not create globalStorage directory', { error: String(e) });
      }
    }

    // 1. Check for existing ephemeral lockfile to share daemon across VS Code windows
    const lockPath = this.getLockPath();
    if (fs.existsSync(lockPath)) {
      try {
        const raw = fs.readFileSync(lockPath, 'utf-8');
        const lockData: ManagedLockData = JSON.parse(raw);
        if (lockData.port && lockData.token) {
          extLog('INFO', `Found managed daemon lockfile at ${lockPath}, probing port ${lockData.port}...`);
          const isListening = await probePort('127.0.0.1', lockData.port, 600);
          if (isListening) {
            extLog(
              'INFO',
              `Active managed daemon detected on port ${lockData.port} (PID ${lockData.pid}). Attaching shared session.`
            );
            this.currentMode = 'MANAGED_STANDALONE';
            this.currentPort = lockData.port;
            this.inMemoryToken = lockData.token;
            this.isChildOwner = false;
            this.startSecondaryLivenessProbe(lockData.port);
            return {
              mode: 'MANAGED_STANDALONE',
              port: lockData.port,
              token: lockData.token,
              serverUrl: `ws://127.0.0.1:${lockData.port}`,
            };
          } else {
            extLog('WARN', `Managed lockfile on port ${lockData.port} is inactive or stale. Cleaning up.`);
            try {
              fs.unlinkSync(lockPath);
            } catch {}
          }
        }
      } catch (e) {
        extLog('WARN', 'Failed reading lockfile, removing corrupted lockfile', { error: String(e) });
        try {
          fs.unlinkSync(lockPath);
        } catch {}
      }
    }

    // 2. Spawn Managed Standalone Daemon
    return this.spawnManagedDaemon();
  }

  /**
   * Spawns headless daemon child process with dynamic port and in-memory security token.
   */
  private async spawnManagedDaemon(): Promise<SupervisorStartResult> {
    // 1. Terminate any pre-existing managed child process
    await this.stop();

    const voxConfig = vscode.workspace.getConfiguration('voxcode');
    const customDir = voxConfig.get<string>('daemonDirectory', '').trim();
    const modelSize = voxConfig.get<string>('modelSize', 'base');
    const device = voxConfig.get<string>('device', 'cpu');
    const computeTypeSetting = voxConfig.get<string>('computeType', 'auto');
    let effectiveComputeType = computeTypeSetting;
    if (effectiveComputeType === 'auto') {
      effectiveComputeType = device === 'cuda' ? 'float16' : 'int8';
    }

    // 2. Allocate free port and generate 32-byte in-memory token
    const allocatedPort = await findFreePort();
    const token = crypto.randomBytes(32).toString('hex');
    const modelDir = AssetManager.getModelDirectory(this.context);
    const bundledModelPath = AssetManager.getBundledModelPath(this.context, modelSize);
    const storageDir = this.context.globalStorageUri.fsPath;

    // 3. Locate or auto-provision executable or script
    const target = await AssetManager.resolveDaemon(this.context, customDir);
    if (!target) {
      const msg = 'Could not locate VoxCode daemon executable or Python runtime.';
      extLog('ERROR', msg);
      this.outputChannel.appendLine(`[Supervisor Error] ${msg}`);
      vscode.window.showErrorMessage(msg);
      this.currentMode = 'OFFLINE';
      return { mode: 'OFFLINE', port: allocatedPort, serverUrl: `ws://127.0.0.1:${allocatedPort}` };
    }

    // Security: Token is passed via environment variable VOXCODE_TOKEN instead of command line arguments
    const spawnArgs = [
      ...target.args,
      '--port',
      allocatedPort.toString(),
      '--model-dir',
      modelDir,
      '--model-size',
      modelSize,
      '--device',
      device,
      '--compute-type',
      effectiveComputeType,
    ];

    // Only pass modern optional CLI flags to script target; precompiled binaries read from environment variables
    if (target.args.length > 0) {
      spawnArgs.push('--storage-dir', storageDir);
      if (device === 'cuda') {
        const cudaDir = CudaManager.getCudaDirectory(this.context);
        if (fs.existsSync(cudaDir)) {
          spawnArgs.push('--cuda-dir', cudaDir);
        }
      }
    }

    if (bundledModelPath) {
      spawnArgs.push('--model-path', bundledModelPath);
    }

    extLog('INFO', `Spawning managed daemon: ${target.executable} ${spawnArgs.join(' ')}`);
    this.outputChannel.appendLine(
      `[Supervisor] Spawning managed daemon on port ${allocatedPort} with model '${modelSize}' on ${device} (${effectiveComputeType})...`
    );

    return new Promise<SupervisorStartResult>((resolve, reject) => {
      let isReady = false;
      let exitHandler: ((code: number | null) => void) | null = null;
      const lockPath = this.getLockPath();

      try {
        const child = child_process.spawn(target.executable, spawnArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: {
            ...process.env,
            PYTHONUNBUFFERED: '1',
            HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
            VOXCODE_TOKEN: token,
            VOXCODE_STORAGE_DIR: storageDir,
          },
        });

        this.childProcess = child;
        this.isChildOwner = true;
        let lineBuffer = '';
        let errBuffer = '';

        const markReady = () => {
          if (isReady) {
            return;
          }
          isReady = true;
          this.currentMode = 'MANAGED_STANDALONE';
          this.currentPort = allocatedPort;
          this.inMemoryToken = token;

          // Write lockfile inside globalStorage so other VS Code windows can connect to this instance
          try {
            const lockData: ManagedLockData = {
              pid: child.pid || 0,
              port: allocatedPort,
              token,
              startedAt: Date.now(),
            };
            fs.writeFileSync(lockPath, JSON.stringify(lockData, null, 2), { encoding: 'utf-8' });
            extLog('INFO', `Managed daemon lockfile written to ${lockPath}`);
          } catch (err) {
            extLog('WARN', 'Failed to write daemon lockfile', { error: String(err) });
          }

          resolve({
            mode: 'MANAGED_STANDALONE',
            port: allocatedPort,
            token,
            serverUrl: `ws://127.0.0.1:${allocatedPort}`,
          });
        };

        child.stdout?.on('data', (data: Buffer) => {
          const text = data.toString('utf-8');
          lineBuffer += text;
          const lines = lineBuffer.split(/\r?\n/);
          lineBuffer = lines.pop() || '';

          for (const line of lines) {
            this.outputChannel.appendLine(`[Daemon] ${line}`);
            if (line.includes('SERVER_LISTENING') && !isReady) {
              extLog('INFO', `Daemon signaled SERVER_LISTENING on port ${allocatedPort}`);
              markReady();
            }
          }
        });

        child.stderr?.on('data', (data: Buffer) => {
          const text = data.toString('utf-8');
          errBuffer += text;
          const trimmed = text.trim();
          if (trimmed) {
            this.outputChannel.appendLine(`[Daemon STDERR] ${trimmed}`);
          }
        });

        exitHandler = (code: number | null) => {
          this.outputChannel.appendLine(`[Supervisor] Daemon exited with code ${code}`);
          extLog('INFO', `Daemon exited with code ${code}`);
          if (this.childProcess === child) {
            this.childProcess = null;
            this.isChildOwner = false;
            this.currentMode = 'OFFLINE';

            // Clean up lockfile if it belongs to this child process
            try {
              if (fs.existsSync(lockPath)) {
                const existing = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
                if (existing.pid === child.pid) {
                  fs.unlinkSync(lockPath);
                }
              }
            } catch {}
          }
          if (!isReady) {
            this.currentMode = 'OFFLINE';
            const detail = errBuffer.trim() || lineBuffer.trim() || `Exit code ${code}`;
            reject(new Error(`Daemon exited prematurely: ${detail}`));
          } else {
            this.currentMode = 'OFFLINE';
          }
        };

        child.on('exit', exitHandler);

        // Fallback port poller in case stdout buffer doesn't flush SERVER_LISTENING immediately
        const pollInterval = setInterval(async () => {
          if (isReady || this.childProcess !== child) {
            clearInterval(pollInterval);
            return;
          }
          const connected = await probePort('127.0.0.1', allocatedPort, 200);
          if (connected && !isReady) {
            clearInterval(pollInterval);
            extLog('INFO', `Daemon port ${allocatedPort} responding to probe.`);
            markReady();
          }
        }, 300);

        // 120-second readiness timeout (allows for initial model download/loading)
        setTimeout(() => {
          clearInterval(pollInterval);
          if (!isReady) {
            extLog('ERROR', 'Timed out waiting for managed daemon to start.');
            this.outputChannel.appendLine('[Supervisor] Timed out waiting for daemon to start.');
            this.stop();
            reject(new Error('Timed out waiting for VoxCode daemon to start.'));
          }
        }, 120000);

      } catch (err: any) {
        extLog('ERROR', 'Exception spawning daemon', { error: err.message });
        this.outputChannel.appendLine(`[Supervisor Error] Failed to spawn daemon: ${err.message}`);
        this.currentMode = 'OFFLINE';
        reject(err);
      }
    });
  }

  /**
   * Restarts the daemon. Validates process identity before taskkill to eliminate termination hijacking.
   */
  public async restart(): Promise<SupervisorStartResult> {
    extLog('INFO', 'ProcessSupervisor restart() requested');
    this.outputChannel.appendLine('[Supervisor] Restarting VoxCode daemon...');

    const lockPath = this.getLockPath();
    if (this.childProcess) {
      await this.stop();
    } else if (fs.existsSync(lockPath)) {
      try {
        const raw = fs.readFileSync(lockPath, 'utf-8');
        const lockData: ManagedLockData = JSON.parse(raw);
        if (lockData.pid) {
          // Security verification: verify target process is a legitimate VoxCode daemon
          const isVoxCode = await isVoxCodeProcess(lockData.pid);
          if (isVoxCode) {
            if (process.platform === 'win32') {
              await new Promise<void>((resolve) => {
                child_process.execFile('taskkill', ['/F', '/T', '/PID', lockData.pid.toString()], () => resolve());
              });
            } else {
              try {
                process.kill(lockData.pid, 'SIGKILL');
              } catch {}
            }
          } else {
            extLog('WARN', `Refusing to terminate PID ${lockData.pid}; does not match VoxCode daemon process.`);
          }
        }
      } catch {}
      try {
        if (fs.existsSync(lockPath)) {
          fs.unlinkSync(lockPath);
        }
      } catch {}
    }

    this.currentMode = 'OFFLINE';
    await new Promise((r) => setTimeout(r, 600));
    return this.start();
  }

  /**
   * Gracefully stops the child daemon process.
   * Closes stdin pipe to trigger child process anti-zombie watchdog,
   * then falls back to SIGTERM and SIGKILL if required.
   */
  public async stop(): Promise<void> {
    this.stopSecondaryLivenessProbe();

    if (!this.childProcess) {
      this.currentMode = 'OFFLINE';
      return;
    }

    const child = this.childProcess;
    this.childProcess = null;
    this.isChildOwner = false;
    this.currentMode = 'OFFLINE';

    // Clean up lockfile if it belongs to this child PID
    const lockPath = this.getLockPath();
    try {
      if (fs.existsSync(lockPath)) {
        const existing = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
        if (existing.pid === child.pid) {
          fs.unlinkSync(lockPath);
        }
      }
    } catch {}

    try {
      this.outputChannel.appendLine('[Supervisor] Stopping background daemon...');
      // 1. Close stdin to signal child's stdin watchdog to exit immediately
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.end();
      }

      // 2. Send SIGTERM
      child.kill('SIGTERM');

      // 3. Safety 2-second timeout before forcing SIGKILL / taskkill
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | null = null;

        const onExit = () => {
          if (timer) {
            clearTimeout(timer);
          }
          resolve();
        };

        child.once('exit', onExit);

        timer = setTimeout(() => {
          if (!child.killed) {
            this.outputChannel.appendLine('[Supervisor] Forcing process termination (SIGKILL/taskkill)...');
            try {
              if (process.platform === 'win32' && child.pid) {
                child_process.execFile('taskkill', ['/F', '/T', '/PID', child.pid.toString()], () => resolve());
              } else {
                child.kill('SIGKILL');
                resolve();
              }
            } catch {
              resolve();
            }
          } else {
            resolve();
          }
        }, 2000);
      });
    } catch (err) {
      extLog('WARN', 'Error stopping child daemon', { error: String(err) });
    }
  }

  public dispose(): void {
    this.isDisposing = true;
    this.stopSecondaryLivenessProbe();
    if (this.isChildOwner) {
      this.stop().catch(() => {});
    } else {
      this.currentMode = 'OFFLINE';
    }
  }
}
