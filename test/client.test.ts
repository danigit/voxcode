import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { VoxCodeClient } from '../src/bridge/client';

describe('VoxCodeClient - Bridge Integration', () => {
  let wss: WebSocketServer;
  let port: number;
  let tempTokenFile: string;
  const mockToken = 'mock_token_abcdef1234567890';

  before((_, done) => {
    tempTokenFile = path.join(os.tmpdir(), `test_token_${Date.now()}.token`);
    fs.writeFileSync(tempTokenFile, mockToken, 'utf-8');

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
    if (fs.existsSync(tempTokenFile)) {
      try {
        fs.unlinkSync(tempTokenFile);
      } catch {}
    }
    wss.close();
  });

  it('completes authentication handshake, registration, and status query', async () => {
    const receivedActions: any[] = [];

    const connectionPromise = new Promise<WebSocket>((resolve) => {
      wss.once('connection', (ws) => {
        ws.on('message', (data) => {
          const payload = JSON.parse(data.toString('utf-8'));
          receivedActions.push(payload);

          if (payload.action === 'authenticate') {
            if (payload.token === mockToken) {
              ws.send(JSON.stringify({ event: 'auth_ok', version: '0.2.0' }));
            } else {
              ws.send(JSON.stringify({ event: 'error', code: 'UNAUTHORIZED', message: 'Bad token' }));
            }
          }
        });
        resolve(ws);
      });
    });

    const client = new VoxCodeClient({
      serverUrl: `ws://127.0.0.1:${port}`,
      tokenPath: tempTokenFile,
      clientId: 'test-client-id-1',
      workspaceName: 'test-workspace',
    });

    const authPromise = new Promise<string>((resolve) => {
      client.on('authenticated', (version) => resolve(version));
    });

    client.connect();

    const serverWs = await connectionPromise;
    const version = await authPromise;

    assert.equal(version, '0.2.0');
    assert.equal(client.isAuthenticated, true);
    assert.equal(client.isConnected, true);

    // Wait a brief moment for register and get_status to arrive at server
    await new Promise((r) => setTimeout(r, 50));

    const authAction = receivedActions.find((a) => a.action === 'authenticate');
    assert.ok(authAction);
    assert.equal(authAction.token, mockToken);

    const regAction = receivedActions.find((a) => a.action === 'register');
    assert.ok(regAction);
    assert.equal(regAction.client_id, 'test-client-id-1');
    assert.equal(regAction.workspace_name, 'test-workspace');

    const statusAction = receivedActions.find((a) => a.action === 'get_status');
    assert.ok(statusAction);

    // Test sending lifecycle commands
    client.startRecording('code');
    await new Promise((r) => setTimeout(r, 20));
    const startAction = receivedActions.find((a) => a.action === 'start_recording');
    assert.ok(startAction);
    assert.equal(startAction.style, 'code');

    client.stopRecording();
    await new Promise((r) => setTimeout(r, 20));
    const stopAction = receivedActions.find((a) => a.action === 'stop_recording');
    assert.ok(stopAction);

    client.cancelRecording();
    await new Promise((r) => setTimeout(r, 20));
    const cancelAction = receivedActions.find((a) => a.action === 'cancel_recording');
    assert.ok(cancelAction);

    // Test receiving daemon events
    const partialPromise = new Promise<string>((resolve) => {
      client.on('partialTranscript', (text) => resolve(text));
    });
    serverWs.send(
      JSON.stringify({
        event: 'partial_transcript',
        client_id: 'test-client-id-1',
        text: 'streaming text preview',
      })
    );
    const partialText = await partialPromise;
    assert.equal(partialText, 'streaming text preview');

    const transcriptPromise = new Promise<any>((resolve) => {
      client.on('transcript', (event) => resolve(event));
    });
    serverWs.send(
      JSON.stringify({
        event: 'transcript',
        client_id: 'test-client-id-1',
        source: 'vscode',
        text: 'final sentence',
        raw: 'final sentence',
        handled_by_daemon: false,
      })
    );
    const transcriptEvent = await transcriptPromise;
    assert.equal(transcriptEvent.text, 'final sentence');
    assert.equal(transcriptEvent.handled_by_daemon, false);

    client.dispose();
  });

  it('emits connectionChanged with false when token is missing on cold boot', async () => {
    const nonExistentTokenPath = path.join(os.tmpdir(), `non_existent_${Date.now()}.token`);
    const client = new VoxCodeClient({
      serverUrl: `ws://127.0.0.1:${port}`,
      tokenPath: nonExistentTokenPath,
      clientId: 'test-client-coldboot',
    });

    const connPromise = new Promise<{ connected: boolean; authenticated: boolean }>((resolve) => {
      client.once('connectionChanged', (status) => resolve(status));
    });

    client.connect();

    const status = await connPromise;
    assert.equal(status.connected, false);
    assert.equal(status.authenticated, false);

    client.dispose();
  });
});
