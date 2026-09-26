import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { findFreePort } from '../src/supervisor/processSupervisor';
import { VoxCodeClient } from '../src/bridge/client';

describe('Headless Daemon - End-to-End Integration & Stdin Watchdog', () => {
  it('launches headless daemon, performs WebSocket dictation, and terminates cleanly on stdin EOF', async (t) => {
    const root = process.cwd();
    const candidatePythons = [
      process.env.PYTHON_PATH,
      process.env.VOXCODE_PYTHON,
      process.env.PYTHON_PATH,
      path.resolve(root, '.venv', 'Scripts', 'python.exe'),
      path.resolve(root, '.venv', 'bin', 'python'),
      'python3',
      'python',
    ].filter(Boolean) as string[];

    let pythonExe: string | null = null;
    for (const cand of candidatePythons) {
      if (path.isAbsolute(cand)) {
        if (fs.existsSync(cand)) {
          pythonExe = cand;
          break;
        }
      } else {
        const check = child_process.spawnSync(cand, ['--version'], { stdio: 'ignore' });
        if (check.status === 0) {
          pythonExe = cand;
          break;
        }
      }
    }

    if (!pythonExe) {
      t.skip('Skipping headless daemon integration test: python executable not found');
      return;
    }

    const checkWebsockets = child_process.spawnSync(pythonExe, ['-c', 'import websockets'], { stdio: 'ignore' });
    if (checkWebsockets.status !== 0) {
      t.skip(
        `Skipping headless daemon integration test: '${pythonExe}' does not have required dependency 'websockets' installed`
      );
      return;
    }

    const serverScript = path.resolve(root, 'server', 'headless_daemon.py');
    assert.ok(fs.existsSync(serverScript), 'headless_daemon.py must exist');

    const port = await findFreePort();
    const token = 'integration_test_secret_token_12345';

    // 1. Spawn daemon with pipe stdio to activate anti-zombie watchdog
    // Pass authentication token via VOXCODE_TOKEN environment variable
    const child = child_process.spawn(
      pythonExe,
      [
        serverScript,
        '--port',
        port.toString(),
        '--use-mock-engine',
        '--device',
        'cpu',
      ],
      {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          VOXCODE_TOKEN: token,
        },
      }
    );

    // Wait for SERVER_LISTENING
    const readyPromise = new Promise<void>((resolve, reject) => {
      let lineBuf = '';
      let errBuf = '';
      child.stdout?.on('data', (data) => {
        lineBuf += data.toString('utf-8');
        if (lineBuf.includes('SERVER_LISTENING')) {
          resolve();
        }
      });
      child.stderr?.on('data', (errData) => {
        errBuf += errData.toString('utf-8');
      });
      child.once('exit', (code) => {
        reject(new Error(`Daemon exited prematurely with code ${code}. Stderr: ${errBuf.trim()}`));
      });
    });

    await readyPromise;

    // 2. Connect VoxCodeClient
    const client = new VoxCodeClient({
      serverUrl: `ws://127.0.0.1:${port}`,
      token,
      executionMode: 'managed',
      clientId: 'integration-test-client',
      workspaceName: 'IntegrationTest',
    });

    const authPromise = new Promise<string>((resolve) => {
      client.on('authenticated', (version) => resolve(version));
    });

    try {
      client.connect();

      const version = await authPromise;
      assert.equal(version, '0.2.0');
      assert.equal(client.isAuthenticated, true);

      // 3. Test recording lifecycle
      const statusListeningPromise = new Promise<string>((resolve) => {
        const listener = (state: string) => {
          if (state === 'listening') {
            client.off('statusChanged', listener);
            resolve(state);
          }
        };
        client.on('statusChanged', listener);
      });

      client.startRecording('code');
      const stateListening = await statusListeningPromise;
      assert.equal(stateListening, 'listening');

      // Wait 200ms to allow audio recording buffer accumulation
      await new Promise((r) => setTimeout(r, 200));

      // 4. Test stop recording and transcript arrival
      const transcriptPromise = new Promise<any>((resolve) => {
        client.once('transcript', (evt) => resolve(evt));
      });

      client.stopRecording();
      const transcriptEvent = await transcriptPromise;
      assert.ok(transcriptEvent);
      assert.ok(transcriptEvent.text.length > 0);
      assert.equal(transcriptEvent.source, 'vscode');
      assert.equal(transcriptEvent.handled_by_daemon, false);
    } finally {
      client.dispose();
    }

    // 5. Verify Anti-Zombie Stdin Watchdog
    // When stdin pipe is closed, watchdog reads EOF and calls os._exit(0)
    const exitPromise = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code));
    });

    child.stdin?.end();

    const exitCode = await Promise.race([
      exitPromise,
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error('Daemon failed to exit within 3000ms after stdin EOF')), 3000)
      ),
    ]);

    assert.equal(exitCode, 0, 'Daemon must exit with code 0 on parent stdin EOF');
  });
});
