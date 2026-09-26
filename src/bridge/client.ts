import WebSocket from 'ws';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import {
  AuthOkEvent,
  ClientMessage,
  DaemonErrorEvent,
  DaemonMessage,
  DaemonSessionState,
  DictationStyle,
  KeepaliveEvent,
  PartialTranscriptEvent,
  RmsPowerEvent,
  StatusChangedEvent,
  TranscriptEvent,
} from './protocol';
import { readToken } from './token';

export type ExecutionMode = 'attached' | 'managed';

export interface VoxCodeClientOptions {
  serverUrl?: string;
  clientId?: string;
  workspaceName?: string;
  tokenPath?: string;
  token?: string; // In-memory token override (bypasses disk read)
  executionMode?: ExecutionMode;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
}

export class VoxCodeClient extends EventEmitter {
  private serverUrl: string;
  public readonly clientId: string;
  private workspaceName: string;
  private tokenPath?: string;
  public token?: string;
  public executionMode: ExecutionMode = 'attached';

  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private isAlive = false;
  private isDisposed = false;

  private reconnectDelay = 1000;
  private readonly minReconnectDelay = 1000;
  private readonly maxReconnectDelay = 10000;
  private readonly pingIntervalMs = 30000;
  private missedPings = 0;
  private lastActivityTime = Date.now();
  private readonly activityTimeoutCeilingMs = 30000;
  private maxReconnectAttempts?: number;
  private reconnectAttempts = 0;
  private lastConnectionState: { connected: boolean; authenticated: boolean } | null = null;

  public isConnected = false;
  public isAuthenticated = false;
  public sessionState: DaemonSessionState = 'idle';
  public activeDevice = 'unknown';
  public activeComputeType = 'unknown';
  public activeModel = 'unknown';
  public cudaFallbackReason: string | null = null;

  constructor(options: VoxCodeClientOptions = {}) {
    super();
    this.serverUrl = options.serverUrl || 'ws://127.0.0.1:7355';
    this.clientId = options.clientId || crypto.randomUUID();
    this.workspaceName = options.workspaceName || 'VSCode';
    this.tokenPath = options.tokenPath;
    this.token = options.token;
    this.executionMode = options.executionMode || 'attached';
    this.maxReconnectAttempts = options.maxReconnectAttempts;
    if (options.reconnectDelayMs) {
      this.reconnectDelay = options.reconnectDelayMs;
    }
  }

  public setExecutionMode(mode: ExecutionMode): void {
    this.executionMode = mode;
  }

  public setToken(token: string | undefined): void {
    this.token = token;
  }

  public setServerUrl(url: string): void {
    this.serverUrl = url;
  }

  /**
   * Update configuration dynamically if settings change.
   */
  public updateConfig(
    serverUrl?: string,
    workspaceName?: string,
    token?: string,
    executionMode?: ExecutionMode
  ): void {
    let shouldReconnect = false;
    if (serverUrl && serverUrl !== this.serverUrl) {
      this.serverUrl = serverUrl;
      shouldReconnect = true;
    }
    if (token !== undefined && token !== this.token) {
      this.token = token;
      shouldReconnect = true;
    }
    if (executionMode && executionMode !== this.executionMode) {
      this.executionMode = executionMode;
    }
    if (workspaceName && workspaceName !== this.workspaceName) {
      this.workspaceName = workspaceName;
      if (this.isAuthenticated) {
        this.sendRegister();
      }
    }
    if (shouldReconnect && !this.isDisposed && (this.isConnected || this.ws !== null)) {
      this.reconnect();
    }
  }

  private emitConnectionChanged(state: { connected: boolean; authenticated: boolean }): void {
    if (
      this.lastConnectionState &&
      this.lastConnectionState.connected === state.connected &&
      this.lastConnectionState.authenticated === state.authenticated
    ) {
      return;
    }
    this.lastConnectionState = state;
    this.emit('connectionChanged', state);
  }

  /**
   * Initiates connection to the daemon WebSocket bridge.
   */
  public connect(): void {
    if (this.ws) {
      return;
    }
    this.isDisposed = false;
    this.lastConnectionState = null;

    this.clearTimers();

    const token = this.token || readToken(this.tokenPath);
    if (!token) {
      // Daemon might not have started yet or token not written yet
      this.emitConnectionChanged({ connected: false, authenticated: false });
      this.scheduleReconnect('Token not provided and token file not found or empty');
      return;
    }

    try {
      // Create WebSocket without browser origin header
      this.ws = new WebSocket(this.serverUrl, {
        headers: {
          'User-Agent': 'VoxCode-VSCode-Extension',
        },
      });

      this.ws.on('open', () => this.onOpen(token));
      this.ws.on('message', (data: WebSocket.RawData) => this.onMessage(data));
      this.ws.on('pong', () => this.onPong());
      this.ws.on('close', (code: number, reason: Buffer) => this.onClose(code, reason.toString()));
      this.ws.on('error', (err: Error) => this.onError(err));
    } catch (err) {
      this.scheduleReconnect(`WebSocket creation error: ${err}`);
    }
  }

  private onOpen(token: string): void {
    this.isConnected = true;
    this.isAlive = true;
    this.emitConnectionChanged({ connected: true, authenticated: false });

    // Send handshake authenticate immediately within 2.0s deadline
    this.sendPayload({
      action: 'authenticate',
      token,
    });
  }

  private onPong(): void {
    this.isAlive = true;
    this.missedPings = 0;
    this.lastActivityTime = Date.now();
  }

  private onMessage(data: WebSocket.RawData): void {
    this.lastActivityTime = Date.now();
    try {
      const messageStr = data.toString('utf-8');
      const payload = JSON.parse(messageStr) as DaemonMessage;
      this.handleDaemonMessage(payload);
    } catch (err) {
      console.error('[VoxCode] Failed to parse message from daemon:', err);
    }
  }

  private handleDaemonMessage(msg: DaemonMessage): void {
    switch (msg.event) {
      case 'auth_ok': {
        const evt = msg as AuthOkEvent;
        this.isAuthenticated = true;
        this.reconnectAttempts = 0;
        this.reconnectDelay = this.minReconnectDelay; // reset backoff
        if (evt.device) { this.activeDevice = evt.device; }
        if (evt.compute_type) { this.activeComputeType = evt.compute_type; }
        if (evt.model) { this.activeModel = evt.model; }
        if (evt.fallback_reason !== undefined) { this.cudaFallbackReason = evt.fallback_reason; }
        this.startHeartbeat();
        this.sendRegister();
        this.sendStatusQuery();
        this.emitConnectionChanged({ connected: true, authenticated: true });
        this.emit('authenticated', evt.version);
        break;
      }

      case 'status_changed': {
        const evt = msg as StatusChangedEvent;
        this.sessionState = evt.state;
        if (evt.device) { this.activeDevice = evt.device; }
        if (evt.compute_type) { this.activeComputeType = evt.compute_type; }
        if (evt.model) { this.activeModel = evt.model; }
        if (evt.fallback_reason !== undefined) { this.cudaFallbackReason = evt.fallback_reason; }
        this.emit('statusChanged', evt.state, {
          device: this.activeDevice,
          compute_type: this.activeComputeType,
          model: this.activeModel,
          fallback_reason: this.cudaFallbackReason,
        });
        break;
      }

      case 'keepalive': {
        this.lastActivityTime = Date.now();
        break;
      }

      case 'rms_power': {
        const evt = msg as RmsPowerEvent;
        this.emit('rmsPower', evt.value);
        break;
      }

      case 'partial_transcript': {
        const evt = msg as PartialTranscriptEvent;
        // Check if targeted to this client or broadcast
        if (!evt.client_id || evt.client_id === this.clientId) {
          this.emit('partialTranscript', evt.text, evt.client_id);
        }
        break;
      }

      case 'transcript': {
        const evt = msg as TranscriptEvent;
        // Targeted to this client or broadcast
        if (!evt.client_id || evt.client_id === this.clientId) {
          this.emit('transcript', evt);
        }
        break;
      }

      case 'error': {
        const evt = msg as DaemonErrorEvent;
        if (!evt.client_id || evt.client_id === this.clientId) {
          this.emit('daemonError', evt.code, evt.message);
        }
        break;
      }

      default:
        console.debug('[VoxCode] Unhandled daemon message:', msg);
        break;
    }
  }

  private onClose(code: number, reason: string): void {
    const wasAuth = this.isAuthenticated;
    this.cleanupSocket();
    this.emitConnectionChanged({ connected: false, authenticated: false });
    this.sessionState = 'idle';
    this.emit('statusChanged', 'idle', {
      device: this.activeDevice,
      compute_type: this.activeComputeType,
      model: this.activeModel,
      fallback_reason: this.cudaFallbackReason,
    });

    if (!this.isDisposed) {
      this.scheduleReconnect(`WebSocket closed (code ${code}: ${reason || 'no reason'})`);
    }
  }

  private onError(err: Error): void {
    console.warn('[VoxCode] WebSocket error:', err.message);
    // onClose will be triggered by WebSocket if connection terminates
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.isAlive = true;
    this.missedPings = 0;
    this.lastActivityTime = Date.now();
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      // Check inactivity timeout ceiling during active session state
      if (this.sessionState === 'listening' || this.sessionState === 'transcribing') {
        const silenceDuration = Date.now() - this.lastActivityTime;
        // Allow up to 120s during transcribing before considering the daemon hung
        const ceiling = this.sessionState === 'transcribing' ? 120000 : this.activityTimeoutCeilingMs;
        if (silenceDuration >= ceiling) {
          console.warn(
            `[VoxCode] Inactivity timeout ceiling (${silenceDuration}ms) exceeded during ${this.sessionState}, terminating socket`
          );
          this.sessionState = 'idle';
          this.emit('statusChanged', 'idle', {
            device: this.activeDevice,
            compute_type: this.activeComputeType,
            model: this.activeModel,
            fallback_reason: this.cudaFallbackReason,
          });
          this.emitConnectionChanged({ connected: false, authenticated: false });
          this.ws.terminate();
          return;
        }

        // Send a ping to verify socket responsiveness even while recording/transcribing
        try {
          this.ws.ping();
        } catch (err) {
          console.error('[VoxCode] Error sending ping during session:', err);
        }
        return;
      }

      if (!this.isAlive) {
        this.missedPings++;
        if (this.missedPings >= 3) {
          console.warn('[VoxCode] Heartbeat ping timed out (3 missed pings), terminating socket');
          this.ws.terminate();
          return;
        }
      } else {
        this.missedPings = 0;
      }
      this.isAlive = false;
      try {
        this.ws.ping();
      } catch (err) {
        console.error('[VoxCode] Error sending ping:', err);
      }
    }, this.pingIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.isDisposed || this.reconnectTimer) {
      return;
    }

    if (
      this.maxReconnectAttempts !== undefined &&
      this.reconnectAttempts >= this.maxReconnectAttempts
    ) {
      console.warn(
        `[VoxCode] Max reconnect attempts (${this.maxReconnectAttempts}) reached.`
      );
      return;
    }
    this.reconnectAttempts++;

    const delay = this.reconnectDelay;
    // Exponential backoff with ceiling
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);

    console.debug(`[VoxCode] Reconnecting in ${delay}ms (${reason}). Next backoff: ${this.reconnectDelay}ms`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  public reconnect(): void {
    this.isDisposed = false;
    this.cleanupSocket();
    this.clearTimers();
    this.reconnectDelay = this.minReconnectDelay;
    this.connect();
  }

  private cleanupSocket(): void {
    this.stopHeartbeat();
    this.isConnected = false;
    this.isAuthenticated = false;
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      try {
        socket.on('error', () => {});
        socket.close();
        socket.removeAllListeners();
      } catch {
        // ignore
      }
    }
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ===========================================================================
  // Outbound Commands
  // ===========================================================================

  public sendPayload(payload: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      console.error('[VoxCode] Failed to send payload:', err);
      return false;
    }
  }

  public sendRegister(): boolean {
    return this.sendPayload({
      action: 'register',
      client_id: this.clientId,
      workspace_name: this.workspaceName,
    });
  }

  public sendStatusQuery(): boolean {
    return this.sendPayload({
      action: 'get_status',
      client_id: this.clientId,
    });
  }

  public startRecording(style: DictationStyle = 'code'): boolean {
    return this.sendPayload({
      action: 'start_recording',
      client_id: this.clientId,
      style,
    });
  }

  public stopRecording(): boolean {
    return this.sendPayload({
      action: 'stop_recording',
      client_id: this.clientId,
    });
  }

  public cancelRecording(): boolean {
    return this.sendPayload({
      action: 'cancel_recording',
      client_id: this.clientId,
    });
  }

  public dispose(): void {
    this.isDisposed = true;
    this.clearTimers();
    this.cleanupSocket();
    this.removeAllListeners();
    this.lastConnectionState = null;
  }
}
