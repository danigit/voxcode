import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Manages isolated storage directories for Whisper models and binaries
 * inside context.globalStorageUri to avoid polluting user home directory.
 */
export class AssetManager {
  /**
   * Returns the directory path used to store/cache Whisper models.
   * Creates the directory if it does not already exist.
   */
  public static getModelDirectory(context: vscode.ExtensionContext): string {
    const modelsDir = path.join(context.globalStorageUri.fsPath, 'models');
    if (!fs.existsSync(modelsDir)) {
      fs.mkdirSync(modelsDir, { recursive: true });
    }
    return modelsDir;
  }

  /**
   * Returns the path to pre-bundled Whisper model weights inside the extension package
   * (e.g. extensionPath/models/<size>). Enables 100% offline, zero-network instant start.
   */
  public static getBundledModelPath(context: vscode.ExtensionContext, modelSize: string): string | null {
    const platformArch = `${process.platform}-${process.arch}`;
    const candidates = [
      path.join(context.extensionPath, 'models', modelSize),
      path.join(context.extensionPath, 'bin', platformArch, 'models', modelSize),
      path.join(context.extensionPath, 'bin', 'models', modelSize),
    ];
    for (const cand of candidates) {
      if (fs.existsSync(path.join(cand, 'model.bin'))) {
        return cand;
      }
    }
    return null;
  }

  /**
   * Returns the directory path for standalone binaries.
   */
  public static getBinDirectory(context: vscode.ExtensionContext): string {
    const binDir = path.join(context.globalStorageUri.fsPath, 'bin');
    if (!fs.existsSync(binDir)) {
      fs.mkdirSync(binDir, { recursive: true });
    }
    return binDir;
  }

  /**
   * Locates the daemon executable or python entrypoint script.
   */
  public static locateDaemon(
    context: vscode.ExtensionContext,
    customDir?: string
  ): { executable: string; args: string[] } | null {
    const candidates: { exe: string; script?: string }[] = [];

    // 1. Bundled standalone binary inside extension bin/ (prioritized for zero-dependency execution)
    const platformArch = `${process.platform}-${process.arch}`; // e.g. win32-x64, darwin-arm64
    const binNames = process.platform === 'win32'
      ? ['voxcode-daemon.exe']
      : ['voxcode-daemon'];

    for (const binName of binNames) {
      candidates.push({
        exe: path.join(context.extensionPath, 'bin', platformArch, binName),
      });
      candidates.push({
        exe: path.join(context.extensionPath, 'bin', binName),
      });
    }

    // 2. Custom configured directory
    if (customDir && fs.existsSync(customDir)) {
      for (const binName of binNames) {
        candidates.push({
          exe: path.join(customDir, binName),
        });
      }
      candidates.push({
        exe: path.join(customDir, '.venv', 'bin', 'python'),
        script: path.join(customDir, 'headless_daemon.py'),
      });
      candidates.push({
        exe: path.join(customDir, '.venv', 'Scripts', 'python.exe'),
        script: path.join(customDir, 'headless_daemon.py'),
      });
    }

    // 3. User global storage bin/
    for (const binName of binNames) {
      candidates.push({
        exe: path.join(context.globalStorageUri.fsPath, 'bin', binName),
      });
    }

    // 4. Bundled Python server inside extension server/
    const bundledServer = path.join(context.extensionPath, 'server', 'headless_daemon.py');
    if (fs.existsSync(bundledServer)) {
      // 4a. Check managed virtualenv in globalStorageUri
      const globalVenvPosix = path.join(context.globalStorageUri.fsPath, 'venv', 'bin', 'python');
      const globalVenvWin = path.join(context.globalStorageUri.fsPath, 'venv', 'Scripts', 'python.exe');
      if (fs.existsSync(globalVenvPosix)) {
        candidates.push({ exe: globalVenvPosix, script: bundledServer });
      }
      if (fs.existsSync(globalVenvWin)) {
        candidates.push({ exe: globalVenvWin, script: bundledServer });
      }

      // 4b. Check standard macOS Homebrew / Framework Python installations
      if (process.platform === 'darwin') {
        const macPythonPaths = [
          '/opt/homebrew/bin/python3',
          '/usr/local/bin/python3',
          '/Library/Frameworks/Python.framework/Versions/Current/bin/python3',
          path.join(os.homedir(), '.pyenv', 'shims', 'python3'),
        ];
        for (const macPy of macPythonPaths) {
          if (fs.existsSync(macPy)) {
            candidates.push({ exe: macPy, script: bundledServer });
          }
        }
      }

      // 4c. Fallback to PATH commands
      candidates.push({ exe: 'python3', script: bundledServer });
      candidates.push({ exe: 'python', script: bundledServer });
    }

    for (const c of candidates) {
      if (c.script) {
        if (fs.existsSync(c.script)) {
          if (path.isAbsolute(c.exe) && fs.existsSync(c.exe)) {
            if (process.platform !== 'win32') {
              try { fs.chmodSync(c.exe, 0o755); } catch {}
            }
            return { executable: c.exe, args: [c.script] };
          } else if (!path.isAbsolute(c.exe)) {
            return { executable: c.exe, args: [c.script] };
          }
        }
      } else {
        if (path.isAbsolute(c.exe) && fs.existsSync(c.exe)) {
          if (process.platform !== 'win32') {
            try { fs.chmodSync(c.exe, 0o755); } catch {}
          }
          return { executable: c.exe, args: [] };
        }
      }
    }

    return null;
  }

  /**
   * Constructs an environment object with standard macOS and UNIX toolchain paths.
   */
  public static getEnhancedEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (process.platform === 'darwin') {
      const extraPaths = [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/Library/Frameworks/Python.framework/Versions/Current/bin',
        path.join(os.homedir(), '.pyenv', 'shims'),
        path.join(os.homedir(), '.local', 'bin'),
      ];
      const currentPath = env.PATH || '';
      const toAdd = extraPaths.filter((p) => fs.existsSync(p) && !currentPath.includes(p));
      if (toAdd.length > 0) {
        env.PATH = toAdd.join(':') + ':' + currentPath;
      }
    }
    return env;
  }

  /**
   * Verifies if a given Python executable has the required speech packages installed.
   */
  public static async verifyPythonDeps(pythonExe: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      child_process.execFile(
        pythonExe,
        ['-c', 'import websockets, sounddevice, numpy, faster_whisper'],
        { env: this.getEnhancedEnv(), timeout: 15000 },
        (err) => {
          resolve(!err);
        }
      );
    });
  }

  /**
   * Discovers a base Python 3 interpreter on the host system.
   */
  public static findBasePython(): string | null {
    const candidates: string[] = [];
    if (process.platform === 'darwin') {
      candidates.push(
        '/opt/homebrew/bin/python3',
        '/usr/local/bin/python3',
        '/Library/Frameworks/Python.framework/Versions/Current/bin/python3',
        path.join(os.homedir(), '.pyenv', 'shims', 'python3'),
        'python3',
        'python'
      );
    } else if (process.platform === 'win32') {
      candidates.push('python.exe', 'python3.exe', 'python', 'py.exe', 'py');
    } else {
      candidates.push('python3', 'python');
    }

    for (const cand of candidates) {
      if (path.isAbsolute(cand) && fs.existsSync(cand)) {
        return cand;
      }
      if (!path.isAbsolute(cand)) {
        try {
          const command = process.platform === 'win32' ? 'where.exe' : 'which';
          const out = child_process
            .execFileSync(command, [cand], { env: this.getEnhancedEnv(), stdio: 'pipe' })
            .toString()
            .trim();
          const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          for (const line of lines) {
            if (line.toLowerCase().includes('windowsapps')) {
              continue;
            }
            if (fs.existsSync(line)) {
              return line;
            }
          }
        } catch {
          // command not found in PATH
        }
      }
    }
    return null;
  }

  /**
   * Automatically creates an isolated virtualenv and installs dependencies inside globalStorageUri.
   */
  public static async autoBootstrapVenv(
    context: vscode.ExtensionContext,
    basePython: string
  ): Promise<string> {
    const venvDir = path.join(context.globalStorageUri.fsPath, 'venv');
    const venvPy = process.platform === 'win32'
      ? path.join(venvDir, 'Scripts', 'python.exe')
      : path.join(venvDir, 'bin', 'python');

    return this.withProgress('VoxCode', async (progress) => {
      progress.report({ message: 'Setting up speech engine environment (one-time setup)...' });
      if (!fs.existsSync(context.globalStorageUri.fsPath)) {
        fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
      }

      // Step 1: Create isolated virtualenv
      await new Promise<void>((resolve, reject) => {
        child_process.execFile(
          basePython,
          ['-m', 'venv', venvDir],
          { env: this.getEnhancedEnv(), timeout: 60000 },
          (err, _stdout, stderr) => {
            if (err) {
              reject(new Error(`Failed to create virtual environment: ${stderr || err.message}`));
            } else {
              resolve();
            }
          }
        );
      });

      // Step 2: Install dependencies
      progress.report({ message: 'Installing speech dependencies (faster-whisper, sounddevice, websockets)...' });
      await new Promise<void>((resolve, reject) => {
        child_process.execFile(
          venvPy,
          ['-m', 'pip', 'install', 'websockets', 'faster-whisper', 'sounddevice', 'numpy'],
          { env: this.getEnhancedEnv(), timeout: 300000, maxBuffer: 20 * 1024 * 1024 },
          (err, _stdout, stderr) => {
            if (err) {
              reject(new Error(`Failed to install speech dependencies: ${stderr || err.message}`));
            } else {
              resolve();
            }
          }
        );
      });

      return venvPy;
    });
  }

  /**
   * Asynchronously resolves or auto-provisions a fully working daemon executable.
   * If Python dependencies are missing, auto-provisions an isolated virtual environment
   * in context.globalStorageUri/venv so the user never has to run terminal commands.
   */
  public static async resolveDaemon(
    context: vscode.ExtensionContext,
    customDir?: string
  ): Promise<{ executable: string; args: string[] } | null> {
    // 1. First check if a pre-compiled binary exists (bundled in bin/ or globalStorage/bin)
    const syncTarget = this.locateDaemon(context, customDir);
    if (syncTarget && syncTarget.args.length === 0) {
      // Standalone pre-compiled binary (.exe / Mach-O executable)
      return syncTarget;
    }

    const bundledServer = path.join(context.extensionPath, 'server', 'headless_daemon.py');
    if (!fs.existsSync(bundledServer)) {
      return syncTarget;
    }

    // 2. Check if a managed venv already exists in globalStorageUri
    const venvDir = path.join(context.globalStorageUri.fsPath, 'venv');
    const venvPy = process.platform === 'win32'
      ? path.join(venvDir, 'Scripts', 'python.exe')
      : path.join(venvDir, 'bin', 'python');
    if (fs.existsSync(venvPy)) {
      const venvValid = await this.verifyPythonDeps(venvPy);
      if (venvValid) {
        return { executable: venvPy, args: [bundledServer] };
      }
    }

    // 3. Collect candidate python interpreters (without sibling repo references)
    const candidatePythons: string[] = [];
    if (customDir && fs.existsSync(customDir)) {
      candidatePythons.push(
        path.join(customDir, '.venv', 'bin', 'python'),
        path.join(customDir, '.venv', 'Scripts', 'python.exe')
      );
    }
    if (process.platform === 'darwin') {
      candidatePythons.push(
        '/opt/homebrew/bin/python3',
        '/usr/local/bin/python3',
        '/Library/Frameworks/Python.framework/Versions/Current/bin/python3',
        path.join(os.homedir(), '.pyenv', 'shims', 'python3')
      );
    }
    candidatePythons.push('python3', 'python');

    // 4. Test candidate pythons to see if one already has the packages installed
    for (const py of candidatePythons) {
      if (path.isAbsolute(py) && !fs.existsSync(py)) {
        continue;
      }
      const hasDeps = await this.verifyPythonDeps(py);
      if (hasDeps) {
        return { executable: py, args: [bundledServer] };
      }
    }

    // 5. No candidate has the speech dependencies: Auto-provision in globalStorageUri/venv!
    const basePython = this.findBasePython();
    if (basePython) {
      try {
        const provisionedPy = await this.autoBootstrapVenv(context, basePython);
        return { executable: provisionedPy, args: [bundledServer] };
      } catch (err: any) {
        vscode.window.showErrorMessage(`VoxCode auto-setup failed: ${err.message}`);
        return null;
      }
    }

    if (syncTarget && syncTarget.args.length === 0) {
      return syncTarget;
    }

    return null;
  }

  /**
   * Displays native VS Code progress bar while preparing models or assets.
   */
  public static async withProgress<T>(
    title: string,
    task: (progress: vscode.Progress<{ message?: string; increment?: number }>) => Promise<T>
  ): Promise<T> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: false,
      },
      task
    );
  }
}
