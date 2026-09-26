import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AssetManager } from '../src/supervisor/assetManager';

describe('AssetManager - Model & Binary Directory Management', () => {
  it('creates and returns model cache directory inside globalStorageUri', () => {
    const tempStorage = path.join(os.tmpdir(), `voxcode_test_storage_${Date.now()}`);
    const mockContext: any = {
      globalStorageUri: vscode.Uri.file(tempStorage),
      extensionPath: process.cwd(),
    };

    try {
      const modelDir = AssetManager.getModelDirectory(mockContext);
      assert.ok(fs.existsSync(modelDir));
      assert.equal(modelDir, path.join(tempStorage, 'models'));

      const binDir = AssetManager.getBinDirectory(mockContext);
      assert.ok(fs.existsSync(binDir));
      assert.equal(binDir, path.join(tempStorage, 'bin'));
    } finally {
      if (fs.existsSync(tempStorage)) {
        try {
          fs.rmSync(tempStorage, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  it('locates daemon script or binary in candidate locations', () => {
    const root = process.cwd();
    const mockContext: any = {
      globalStorageUri: vscode.Uri.file(path.join(os.tmpdir(), 'test_storage')),
      extensionPath: root,
    };

    const target = AssetManager.locateDaemon(mockContext);
    assert.ok(target, 'Should find daemon target');
    assert.ok(target.executable, 'Should have executable path');
    assert.ok(Array.isArray(target.args), 'Args should be an array');
  });

  it('runs withProgress wrapper successfully', async () => {
    let executed = false;
    const result = await AssetManager.withProgress('Testing progress', async (progress) => {
      progress.report({ message: 'Doing work...' });
      executed = true;
      return 42;
    });

    assert.equal(executed, true);
    assert.equal(result, 42);
  });
});
