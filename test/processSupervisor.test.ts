import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  findFreePort,
  probePort,
  getManagedLockfilePath,
  isVoxCodeProcess,
  ProcessSupervisor,
} from '../src/supervisor/processSupervisor';

describe('ProcessSupervisor - Port Management & Probing', () => {
  it('findFreePort returns an available port number', async () => {
    const port = await findFreePort();
    assert.ok(typeof port === 'number');
    assert.ok(port > 1024 && port < 65535);

    // Verify port is actually free
    const isBound = await probePort('127.0.0.1', port, 100);
    assert.equal(isBound, false);
  });

  it('probePort returns true on an active listening port', async () => {
    const server = net.createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as net.AddressInfo).port);
      });
    });

    try {
      const isListening = await probePort('127.0.0.1', port, 500);
      assert.equal(isListening, true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('probePort returns false on a closed port without throwing', async () => {
    const closedPort = 59997;
    const isListening = await probePort('127.0.0.1', closedPort, 200);
    assert.equal(isListening, false);
  });

  it('isVoxCodeProcess returns false for invalid PID', async () => {
    assert.equal(await isVoxCodeProcess(0), false);
    assert.equal(await isVoxCodeProcess(-1), false);
  });
});

describe('ProcessSupervisor - Lifecycle & Lockfile Management', () => {
  it('shares running managed daemon across windows via ephemeral lockfile', async () => {
    const activePort = await findFreePort();
    const activeServer = net.createServer();
    await new Promise<void>((resolve, reject) => {
      activeServer.listen(activePort, '127.0.0.1', () => resolve());
      activeServer.on('error', reject);
    });

    const tempStorage = path.join(os.tmpdir(), `supervisor_test_${Date.now()}_1`);
    fs.mkdirSync(tempStorage, { recursive: true });
    const mockContext: any = {
      globalStorageUri: vscode.Uri.file(tempStorage),
      extensionPath: path.resolve(__dirname, '..'),
      subscriptions: [],
    };

    const lockPath = getManagedLockfilePath(mockContext);
    const mockToken = 'shared_managed_token_987654';

    // Seed lockfile inside isolated sandbox storage
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        port: activePort,
        token: mockToken,
        startedAt: Date.now(),
      }),
      'utf-8'
    );

    const supervisor = new ProcessSupervisor(mockContext);

    try {
      const result = await supervisor.start();
      assert.equal(result.mode, 'MANAGED_STANDALONE');
      assert.equal(result.port, activePort);
      assert.equal(result.token, mockToken);
      assert.equal(result.serverUrl, `ws://127.0.0.1:${activePort}`);
      assert.equal(supervisor.isRunning(), true);
    } finally {
      supervisor.dispose();
      await new Promise((resolve) => activeServer.close(resolve));
      try {
        if (fs.existsSync(tempStorage)) {
          fs.rmSync(tempStorage, { recursive: true, force: true });
        }
      } catch {}
    }
  });

  it('detects and cleans up stale lockfile when port is closed', async () => {
    const closedPort = 59995;
    const tempStorage = path.join(os.tmpdir(), `supervisor_test_${Date.now()}_2`);
    fs.mkdirSync(tempStorage, { recursive: true });
    const mockContext: any = {
      globalStorageUri: vscode.Uri.file(tempStorage),
      extensionPath: path.resolve(__dirname, '..'),
      subscriptions: [],
    };

    const lockPath = getManagedLockfilePath(mockContext);

    // Seed stale lockfile pointing to closed port
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 999999,
        port: closedPort,
        token: 'stale_token_123',
        startedAt: Date.now() - 10000,
      }),
      'utf-8'
    );

    assert.equal(fs.existsSync(lockPath), true);

    const supervisor = new ProcessSupervisor(mockContext);

    try {
      // Starting supervisor should detect stale lockfile and unlink it
      await supervisor.start().catch(() => {});
      assert.equal(fs.existsSync(lockPath), false);
    } finally {
      supervisor.dispose();
      try {
        if (fs.existsSync(tempStorage)) {
          fs.rmSync(tempStorage, { recursive: true, force: true });
        }
      } catch {}
    }
  });
});
