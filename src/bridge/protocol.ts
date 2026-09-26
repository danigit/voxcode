/**
 * Protocol specification for VoxCode VS Code Bridge.
 * Corresponds to VSCODE_EXTENSION_PLAN.md Section 3.
 */

export type DictationStyle = 'code' | 'prose';

export type DaemonSessionState = 'idle' | 'listening' | 'transcribing' | 'loading_model' | 'error';

// =============================================================================
// Client -> Daemon Actions
// =============================================================================

export interface AuthenticateAction {
  action: 'authenticate';
  token: string;
}

export interface RegisterAction {
  action: 'register';
  client_id: string;
  workspace_name: string;
}

export interface StartRecordingAction {
  action: 'start_recording';
  client_id: string;
  style: DictationStyle;
}

export interface StopRecordingAction {
  action: 'stop_recording';
  client_id: string;
}

export interface CancelRecordingAction {
  action: 'cancel_recording';
  client_id: string;
}

export interface GetStatusAction {
  action: 'get_status';
  client_id: string;
}

export type ClientMessage =
  | AuthenticateAction
  | RegisterAction
  | StartRecordingAction
  | StopRecordingAction
  | CancelRecordingAction
  | GetStatusAction;

// =============================================================================
// Daemon -> Client Events
// =============================================================================

export interface AuthOkEvent {
  event: 'auth_ok';
  version: string;
  device?: string;
  compute_type?: string;
  model?: string;
  fallback_reason?: string | null;
}

export interface StatusChangedEvent {
  event: 'status_changed';
  state: DaemonSessionState;
  device?: string;
  compute_type?: string;
  model?: string;
  fallback_reason?: string | null;
}

export interface KeepaliveEvent {
  event: 'keepalive';
  state: DaemonSessionState;
  device?: string;
}

export interface RmsPowerEvent {
  event: 'rms_power';
  value: number;
}

export interface PartialTranscriptEvent {
  event: 'partial_transcript';
  client_id?: string | null;
  text: string;
}

export interface TranscriptEvent {
  event: 'transcript';
  client_id?: string | null;
  source: 'vscode' | 'system';
  text: string;
  raw: string;
  handled_by_daemon: boolean;
}

export interface DaemonErrorEvent {
  event: 'error';
  client_id?: string | null;
  code: string;
  message: string;
}

export type DaemonMessage =
  | AuthOkEvent
  | StatusChangedEvent
  | KeepaliveEvent
  | RmsPowerEvent
  | PartialTranscriptEvent
  | TranscriptEvent
  | DaemonErrorEvent;
