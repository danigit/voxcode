import * as child_process from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { extLog } from '../logger';
import { AssetManager } from './assetManager';
import type { ProcessSupervisor } from './processSupervisor';

export interface CudaInstallProgress {
  message?: string;
  increment?: number;
}

/**
 * Manages automated detection, configuration, and in-app download
 * of NVIDIA CUDA 12 runtime acceleration libraries (cublas).
 */
export class CudaManager {
  /**
   * Checks if an NVIDIA GPU driver or device is present on the host system.
   * On Windows, nvcuda.dll is guaranteed to exist in System32 if any NVIDIA driver is installed.
   */
  public static isNvidiaGpuPresent(): boolean {
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const nvcudaCandidates = [
        path.join(systemRoot, 'System32', 'nvcuda.dll'),
        path.join(systemRoot, 'SysWOW64', 'nvcuda.dll'),
      ];
      for (const p of nvcudaCandidates) {
        if (fs.existsSync(p)) {
          return true;
        }
      }
      try {
        const out = child_process
          .execSync('where.exe nvidia-smi.exe', { stdio: 'pipe' })
          .toString()
          .trim();
        if (out.length > 0) {
          return true;
        }
      } catch {
        // nvidia-smi not in PATH
      }
      return false;
    }

    if (process.platform === 'linux') {
      const candidates = [
        '/usr/lib/x86_64-linux-gnu/libcuda.so.1',
        '/usr/lib64/libcuda.so.1',
        '/usr/lib/libcuda.so.1',
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          return true;
        }
      }
      try {
        const out = child_process
          .execSync('which nvidia-smi', { stdio: 'pipe' })
          .toString()
          .trim();
        if (out.length > 0) {
          return true;
        }
      } catch {
        // nvidia-smi not in PATH
      }
      return false;
    }

    return false;
  }

  /**
   * Returns the dedicated directory where VoxCode stores downloaded CUDA 12 runtime DLLs.
   * Defaults to %LOCALAPPDATA%\VoxCode\cuda on Windows.
   */
  public static getCudaDirectory(context?: vscode.ExtensionContext): string {
    if (process.platform === 'win32') {
      const localAppData =
        process.env.LOCALAPPDATA ||
        (process.env.USERPROFILE
          ? path.join(process.env.USERPROFILE, 'AppData', 'Local')
          : null);
      if (localAppData) {
        const dir = path.join(localAppData, 'VoxCode', 'cuda');
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        return dir;
      }
    }

    if (context) {
      const dir = path.join(context.globalStorageUri.fsPath, 'cuda');
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      return dir;
    }

    const fallback = path.join(os.homedir(), '.voxcode', 'cuda');
    if (!fs.existsSync(fallback)) {
      fs.mkdirSync(fallback, { recursive: true });
    }
    return fallback;
  }

  /**
   * Checks if required CUDA 12 runtime DLLs (cublas64_12.dll and cublasLt64_12.dll)
   * are present in the dedicated VoxCode directory or in system CUDA paths.
   */
  public static isCudaRuntimeInstalled(context?: vscode.ExtensionContext): boolean {
    const requiredDlls = ['cublas64_12.dll', 'cublasLt64_12.dll'];
    const searchDirs: string[] = [];

    // 1. Dedicated VoxCode CUDA directory
    const voxCudaDir = this.getCudaDirectory(context);
    searchDirs.push(voxCudaDir);

    // 2. Extension globalStorage cuda directory
    if (context) {
      searchDirs.push(path.join(context.globalStorageUri.fsPath, 'cuda'));
    }

    // 3. CUDA_PATH environment variable
    if (process.env.CUDA_PATH) {
      searchDirs.push(path.join(process.env.CUDA_PATH, 'bin'));
    }

    // 4. Standard CUDA Toolkit directories
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const cudaBase = path.join(programFiles, 'NVIDIA GPU Computing Toolkit', 'CUDA');
    if (fs.existsSync(cudaBase)) {
      try {
        const subdirs = fs.readdirSync(cudaBase);
        for (const sub of subdirs) {
          searchDirs.push(path.join(cudaBase, sub, 'bin'));
        }
      } catch {}
    }

    // Verify if both required DLLs exist in at least one search directory
    for (const dir of searchDirs) {
      if (fs.existsSync(dir)) {
        const hasAll = requiredDlls.every((dll) => fs.existsSync(path.join(dir, dll)));
        if (hasAll) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Queries the official PyPI API to dynamically find the latest Windows x64 wheel
   * for nvidia-cublas-cu12 without needing python or pip installed.
   */
  public static async resolvePyPiWheelUrl(): Promise<{
    url: string;
    filename: string;
    size: number;
  } | null> {
    return new Promise((resolve) => {
      const req = https.get(
        'https://pypi.org/pypi/nvidia-cublas-cu12/json',
        { headers: { 'User-Agent': 'VoxCode-VSCode-Extension/0.2.0' }, timeout: 15000 },
        (res) => {
          if (res.statusCode !== 200) {
            resolve(null);
            return;
          }
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              const urls = json.urls || [];
              const winWheel = urls.find(
                (u: any) =>
                  typeof u.filename === 'string' &&
                  u.filename.includes('win_amd64') &&
                  u.filename.endsWith('.whl')
              );
              if (winWheel) {
                resolve({
                  url: winWheel.url,
                  filename: winWheel.filename,
                  size: winWheel.size || 0,
                });
              } else {
                resolve(null);
              }
            } catch {
              resolve(null);
            }
          });
        }
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
    });
  }

  /**
   * Downloads a remote file over HTTPS with HTTP redirect support and progress reporting.
   */
  public static async downloadFile(
    url: string,
    destPath: string,
    onProgress?: (progress: { message: string; increment?: number }) => void,
    cancellationToken?: vscode.CancellationToken,
    redirectCount = 0
  ): Promise<void> {
    if (redirectCount > 5) {
      throw new Error('Too many HTTP redirects encountered.');
    }

    return new Promise<void>((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      const req = client.get(
        url,
        { headers: { 'User-Agent': 'VoxCode-Downloader/0.2.0' } },
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            let nextUrl = res.headers.location;
            if (!nextUrl.startsWith('http')) {
              const u = new URL(url);
              nextUrl = `${u.protocol}//${u.host}${nextUrl}`;
            }
            res.resume();
            this.downloadFile(nextUrl, destPath, onProgress, cancellationToken, redirectCount + 1)
              .then(resolve)
              .catch(reject);
            return;
          }

          if (res.statusCode !== 200) {
            reject(new Error(`Download failed with HTTP status ${res.statusCode}`));
            return;
          }

          const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
          let receivedBytes = 0;
          let lastReportedPct = 0;

          const fileStream = fs.createWriteStream(destPath);

          res.on('data', (chunk: Buffer) => {
            if (cancellationToken?.isCancellationRequested) {
              req.destroy();
              fileStream.close();
              try { fs.unlinkSync(destPath); } catch {}
              reject(new Error('Download cancelled by user.'));
              return;
            }

            receivedBytes += chunk.length;
            if (totalBytes > 0 && onProgress) {
              const currentPct = Math.floor((receivedBytes / totalBytes) * 100);
              if (currentPct > lastReportedPct) {
                const diff = currentPct - lastReportedPct;
                lastReportedPct = currentPct;
                const mbReceived = (receivedBytes / (1024 * 1024)).toFixed(1);
                const mbTotal = (totalBytes / (1024 * 1024)).toFixed(1);
                onProgress({
                  message: `Downloading CUDA runtime: ${mbReceived}MB / ${mbTotal}MB (${currentPct}%)`,
                  increment: diff,
                });
              }
            }
          });

          res.pipe(fileStream);

          fileStream.on('finish', () => {
            fileStream.close();
            resolve();
          });

          fileStream.on('error', (err) => {
            try { fs.unlinkSync(destPath); } catch {}
            reject(err);
          });
        }
      );

      req.on('error', (err) => {
        try { fs.unlinkSync(destPath); } catch {}
        reject(err);
      });

      if (cancellationToken) {
        cancellationToken.onCancellationRequested(() => {
          req.destroy();
          try { fs.unlinkSync(destPath); } catch {}
          reject(new Error('Download cancelled by user.'));
        });
      }
    });
  }

  /**
   * Extracts a .zip or .whl archive to a destination directory using Windows built-in tools.
   * Handles .whl files safely without shell injection.
   */
  public static async extractArchive(archivePath: string, extractDir: string): Promise<void> {
    if (!fs.existsSync(extractDir)) {
      fs.mkdirSync(extractDir, { recursive: true });
    }

    // Try Python zipfile if Python is available (natively handles .whl and .zip)
    const basePython = AssetManager.findBasePython();
    if (basePython) {
      const pythonSuccess = await new Promise<boolean>((resolve) => {
        child_process.execFile(
          basePython,
          ['-m', 'zipfile', '-e', archivePath, extractDir],
          { timeout: 120000 },
          (err) => {
            resolve(!err);
          }
        );
      });
      if (pythonSuccess) {
        return;
      }
    }

    // Try tar.exe (fast, native in Windows 10/11, extracts zip & whl)
    const canUseTar = await new Promise<boolean>((resolve) => {
      child_process.execFile('tar.exe', ['--help'], (err) => {
        resolve(!err);
      });
    });

    if (canUseTar) {
      return new Promise<void>((resolve, reject) => {
        child_process.execFile(
          'tar.exe',
          ['-xf', archivePath, '-C', extractDir],
          { timeout: 120000 },
          (err, _stdout, stderr) => {
            if (err) {
              reject(new Error(`tar extraction failed: ${stderr || err.message}`));
            } else {
              resolve();
            }
          }
        );
      });
    }

    // Fallback: PowerShell Expand-Archive (requires .zip extension for Expand-Archive)
    let fileToExtract = archivePath;
    let cleanupZip = false;
    if (fileToExtract.toLowerCase().endsWith('.whl')) {
      const zipPath = path.join(
        path.dirname(fileToExtract),
        `whl_extract_${Date.now()}.zip`
      );
      try {
        fs.copyFileSync(fileToExtract, zipPath);
        fileToExtract = zipPath;
        cleanupZip = true;
      } catch {}
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const escapedArchive = fileToExtract.replace(/'/g, "''");
        const escapedExtract = extractDir.replace(/'/g, "''");
        const psCmd = `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedExtract}' -Force`;
        child_process.execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', psCmd],
          { timeout: 180000 },
          (err, _stdout, stderr) => {
            if (err) {
              reject(new Error(`PowerShell Expand-Archive failed: ${stderr || err.message}`));
            } else {
              resolve();
            }
          }
        );
      });
    } finally {
      if (cleanupZip && fs.existsSync(fileToExtract)) {
        try {
          fs.unlinkSync(fileToExtract);
        } catch {}
      }
    }
  }

  /**
   * Recursively finds all .dll files in a source directory and copies them into the target directory.
   */
  public static copyDllsRecursively(srcDir: string, targetDir: string): number {
    let copiedCount = 0;
    if (!fs.existsSync(srcDir)) {
      return copiedCount;
    }

    const traverse = (currentDir: string) => {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          traverse(fullPath);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.dll')) {
          const destFile = path.join(targetDir, entry.name);
          fs.copyFileSync(fullPath, destFile);
          copiedCount++;
        }
      }
    };

    traverse(srcDir);
    return copiedCount;
  }

  /**
   * Performs an automated in-app download and installation of the CUDA 12 runtime.
   * If pip is available, it installs into the isolated VoxCode CUDA directory.
   * Otherwise, it downloads the runtime directly via HTTPS and extracts it with built-in tools.
   */
  public static async installCudaRuntime(
    context: vscode.ExtensionContext,
    supervisor?: ProcessSupervisor
  ): Promise<boolean> {
    const targetDir = this.getCudaDirectory(context);

    // If already installed and functional, notify user
    if (this.isCudaRuntimeInstalled(context)) {
      vscode.window.showInformationMessage(
        'VoxCode: NVIDIA CUDA 12 runtime is already installed and ready.'
      );
      return true;
    }

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'VoxCode: Setting up NVIDIA CUDA 12 GPU Acceleration...',
        cancellable: true,
      },
      async (progress, cancellationToken) => {
        extLog('INFO', `Starting automated CUDA runtime installation into ${targetDir}`);

        // Strategy 1: Check if Python + pip is available to perform an isolated target installation
        const basePython = AssetManager.findBasePython();
        if (basePython) {
          try {
            progress.report({ message: 'Installing CUDA runtime packages via pip...' });
            extLog('INFO', `Attempting pip target install using ${basePython}`);

            await new Promise<void>((resolve, reject) => {
              const pipProcess = child_process.execFile(
                basePython,
                [
                  '-m',
                  'pip',
                  'install',
                  '--no-cache-dir',
                  '--target',
                  targetDir,
                  'nvidia-cublas-cu12',
                ],
                { timeout: 300000, maxBuffer: 20 * 1024 * 1024 },
                (err, _stdout, stderr) => {
                  if (err) {
                    if (cancellationToken.isCancellationRequested) {
                      reject(new Error('CUDA install cancelled by user.'));
                    } else {
                      reject(new Error(stderr || err.message));
                    }
                  } else {
                    resolve();
                  }
                }
              );

              if (cancellationToken) {
                cancellationToken.onCancellationRequested(() => {
                  try {
                    pipProcess.kill('SIGTERM');
                    if (process.platform === 'win32' && pipProcess.pid) {
                      child_process.execFile(
                        'taskkill',
                        ['/F', '/T', '/PID', pipProcess.pid.toString()],
                        () => {}
                      );
                    }
                  } catch {}
                  reject(new Error('CUDA install cancelled by user.'));
                });
              }
            });

            // Flatten any DLLs in subfolders (e.g. nvidia/cublas/bin/*.dll) to targetDir root
            this.copyDllsRecursively(targetDir, targetDir);

            if (this.isCudaRuntimeInstalled(context)) {
              extLog('INFO', 'CUDA runtime installed successfully via pip');
              await this.postInstallSuccess(context, supervisor);
              return true;
            }
          } catch (pipErr: any) {
            if (cancellationToken.isCancellationRequested || pipErr?.message?.includes('cancelled')) {
              extLog('INFO', 'CUDA installation cancelled by user.');
              vscode.window.showInformationMessage('VoxCode: CUDA download was cancelled.');
              return false;
            }
            extLog('WARN', `Pip target install attempt failed, falling back to direct download: ${pipErr.message}`);
          }
        }

        // Strategy 2: Direct HTTPS Download of standalone wheel/zip (Zero Python / Zero pip dependency)
        try {
          const config = vscode.workspace.getConfiguration('voxcode');
          const customUrl = config.get<string>('cudaDownloadUrl', '').trim();

          let downloadUrl = customUrl;
          let downloadFilename = 'nvidia_cublas_cu12.whl';

          if (!downloadUrl) {
            progress.report({ message: 'Locating CUDA 12 runtime package...' });
            const pypiInfo = await this.resolvePyPiWheelUrl();
            if (pypiInfo) {
              downloadUrl = pypiInfo.url;
              downloadFilename = pypiInfo.filename;
            } else {
              // Direct fallback URL
              downloadUrl =
                'https://github.com/danigit/voxcode/releases/download/v0.2.0/cuda12-win32-x64.zip';
              downloadFilename = 'cuda12-win32-x64.zip';
            }
          }

          const tempDir = path.join(os.tmpdir(), `voxcode_cuda_${Date.now()}`);
          fs.mkdirSync(tempDir, { recursive: true });
          const tempDownloadPath = path.join(tempDir, downloadFilename);
          const tempExtractPath = path.join(tempDir, 'extracted');

          try {
            extLog('INFO', `Downloading CUDA runtime from ${downloadUrl}`);
            await this.downloadFile(
              downloadUrl,
              tempDownloadPath,
              (p) => progress.report(p),
              cancellationToken
            );

            if (cancellationToken.isCancellationRequested) {
              vscode.window.showInformationMessage('VoxCode: CUDA download was cancelled.');
              return false;
            }

            progress.report({ message: 'Extracting CUDA 12 runtime libraries...' });
            extLog('INFO', `Extracting CUDA archive to ${tempExtractPath}`);
            await this.extractArchive(tempDownloadPath, tempExtractPath);

            // Copy all extracted .dll files into targetDir
            const copied = this.copyDllsRecursively(tempExtractPath, targetDir);
            extLog('INFO', `Copied ${copied} DLL files into ${targetDir}`);
          } finally {
            // Cleanup temp download and extract folder
            try {
              fs.rmSync(tempDir, { recursive: true, force: true });
            } catch {}
          }

          if (this.isCudaRuntimeInstalled(context)) {
            extLog('INFO', 'CUDA runtime installed successfully via direct HTTPS download');
            await this.postInstallSuccess(context, supervisor);
            return true;
          } else {
            throw new Error(
              `Extraction completed but cublas64_12.dll was not found in ${targetDir}`
            );
          }
        } catch (downloadErr: any) {
          if (cancellationToken.isCancellationRequested || downloadErr?.message?.includes('cancelled')) {
            extLog('INFO', 'CUDA installation cancelled by user.');
            vscode.window.showInformationMessage('VoxCode: CUDA download was cancelled.');
            return false;
          }
          extLog('ERROR', `Failed to install CUDA runtime: ${downloadErr.message}`);
          vscode.window.showErrorMessage(
            `VoxCode: Failed to download CUDA runtime: ${downloadErr.message}`
          );
          return false;
        }
      }
    );
  }

  private static async postInstallSuccess(
    context: vscode.ExtensionContext,
    supervisor?: ProcessSupervisor
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('voxcode');
    const currentDevice = config.get<string>('device', 'cpu');

    vscode.window.showInformationMessage(
      'VoxCode: NVIDIA CUDA 12 acceleration runtime installed successfully! Fast GPU inference is now enabled.'
    );

    if (currentDevice !== 'cuda') {
      // Configuration change listener in extension.ts handles restarting the supervisor cleanly.
      await config.update('device', 'cuda', vscode.ConfigurationTarget.Global);
    } else if (supervisor && supervisor.isRunning()) {
      // Device is already cuda; restart supervisor directly since no config change event will fire.
      await supervisor.restart();
    }
  }
}
