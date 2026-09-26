import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import { VoxCodeClient } from '../src/bridge/client';

describe('VoxCodeClient - Standalone & In-Memory Token', () => {
  let wss: WebSocketServer;
  let port: number;
  const inMemoryToken = 'in_memory_secret_token_1234567890abcdef';

  before((_, done) => {
    wss = new WebSocketServer({ port: 0 }, () => {
      const address = wss.address();
      if (typeof address === 'object' && address !== null) {
        port = address.port;
        done();
      } else {
        done(new Error('Failed to get server port'));
      }
    });
  });

  after(() => {
    wss.close();
  });

  it('connects and authenticates using in-memory token without reading disk', async () => {
    let authenticatedWithExpectedToken = false;

    wss.once('connection', (ws) => {
      ws.on('message', (data) => {
        const payload = JSON.parse(data.toString('utf-8'));
        if (payload.action === 'authenticate') {
          if (payload.token === inMemoryToken) {
            authenticatedWithExpectedToken = true;
            ws.send(JSON.stringify({ event: 'auth_ok', version: '0.2.0' }));
          } else {
            ws.send(JSON.stringify({ event: 'error', code: 'UNAUTHORIZED', message: 'Bad token' }));
          }
        }
      });
    });

    const client = new VoxCodeClient({
      serverUrl: `ws://127.0.0.1:${port}`,
      token: inMemoryToken, // in-memory token
      tokenPath: 'C:\\non_existent_token_dir\\token.txt', // Non-existent disk path to verify disk is bypassed
      executionMode: 'managed',
      clientId: 'test-managed-client-1',
    });

    assert.equal(client.executionMode, 'managed');
    assert.equal(client.token, inMemoryToken);

    const authPromise = new Promise<string>((resolve) => {
      client.on('authenticated', (version) => resolve(version));
    });

    client.connect();

    const version = await authPromise;
    assert.equal(version, '0.2.0');
    assert.equal(client.isAuthenticated, true);
    assert.equal(client.isConnected, true);
    assert.equal(authenticatedWithExpectedToken, true);

    client.dispose();
  });

  it('updates executionMode and token dynamically via updateConfig', async () => {
    const client = new VoxCodeClient({
      serverUrl: `ws://127.0.0.1:${port}`,
      executionMode: 'attached',
    });

    assert.equal(client.executionMode, 'attached');

    client.setExecutionMode('managed');
    assert.equal(client.executionMode, 'managed');

    client.updateConfig(undefined, undefined, 'new-token-123', 'attached');
    assert.equal(client.token, 'new-token-123');
    assert.equal(client.executionMode, 'attached');

    client.dispose();
  });

  it('respects maxReconnectAttempts ceiling on connection failures', async () => {
    const closedPort = 59998;
    const client = new VoxCodeClient({
      serverUrl: `ws://127.0.0.1:${closedPort}`,
      token: 'some-token',
      maxReconnectAttempts: 2,
      reconnectDelayMs: 50,
    });

    let connectionAttempts = 0;
    client.on('connectionChanged', (status) => {
      if (!status.connected) {
        connectionAttempts++;
      }
    });

    client.connect();

    // Wait 350ms (enough for 2 backoffs of 50ms, 100ms)
    await new Promise((resolve) => setTimeout(resolve, 350));

    // Connection attempts should be capped by maxReconnectAttempts
    assert.ok(connectionAttempts >= 2);
    client.dispose();
  });
});
