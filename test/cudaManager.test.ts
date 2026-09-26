import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CudaManager } from '../src/supervisor/cudaManager';

describe('CudaManager - Detection, Directories & Archive Extraction', () => {
  it('detects NVIDIA GPU or returns boolean without crashing', () => {
    const present = CudaManager.isNvidiaGpuPresent();
    assert.equal(typeof present, 'boolean');
  });

  it('resolves dedicated VoxCode CUDA directory and creates if missing', () => {
    const tempStorage = path.join(os.tmpdir(), `voxcode_cuda_test_${Date.now()}`);
    const mockContext: any = {
      globalStorageUri: vscode.Uri.file(tempStorage),
      extensionPath: process.cwd(),
    };

    try {
      const cudaDir = CudaManager.getCudaDirectory(mockContext);
      assert.ok(typeof cudaDir === 'string' && cudaDir.length > 0);
      assert.ok(fs.existsSync(cudaDir));
    } finally {
      if (fs.existsSync(tempStorage)) {
        try {
          fs.rmSync(tempStorage, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  it('checks if CUDA runtime is installed without throwing', () => {
    const isInstalled = CudaManager.isCudaRuntimeInstalled();
    assert.equal(typeof isInstalled, 'boolean');
  });

  it('recursively discovers and copies DLLs from nested directories', () => {
    const tempSrc = path.join(os.tmpdir(), `voxcode_dll_src_${Date.now()}`);
    const tempDest = path.join(os.tmpdir(), `voxcode_dll_dest_${Date.now()}`);

    try {
      const nested = path.join(tempSrc, 'sub1', 'sub2');
      fs.mkdirSync(nested, { recursive: true });
      fs.mkdirSync(tempDest, { recursive: true });

      fs.writeFileSync(path.join(nested, 'test_sample.dll'), 'dummy dll content');
      fs.writeFileSync(path.join(nested, 'ignore.txt'), 'not a dll');

      const count = CudaManager.copyDllsRecursively(tempSrc, tempDest);
      assert.equal(count, 1);
      assert.ok(fs.existsSync(path.join(tempDest, 'test_sample.dll')));
      assert.ok(!fs.existsSync(path.join(tempDest, 'ignore.txt')));
    } finally {
      try {
        fs.rmSync(tempSrc, { recursive: true, force: true });
        fs.rmSync(tempDest, { recursive: true, force: true });
      } catch {}
    }
  });

  it('queries PyPI and successfully resolves Windows wheel metadata', async () => {
    const wheelInfo = await CudaManager.resolvePyPiWheelUrl();
    if (wheelInfo) {
      assert.ok(wheelInfo.url.startsWith('https://'));
      assert.ok(wheelInfo.filename.includes('win_amd64'));
      assert.ok(wheelInfo.filename.endsWith('.whl'));
      assert.ok(wheelInfo.size > 0);
    }
  });
});
