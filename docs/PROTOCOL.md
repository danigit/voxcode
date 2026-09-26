# VoxCode Bridge: WebSocket Protocol Specification

This document specifies the bidirectional JSON protocol between the **VoxCode Headless Python Daemon** and the **VS Code Extension Client**.

The communication occurs over loopback WebSocket on dynamically allocated ports (or configured `voxcode.serverUrl`).

---

## 1. Handshake & Authentication

### 1.1 Ephemeral Token Exchange

1. On boot, the Process Supervisor supplies a cryptographically random 32-byte token to the headless daemon via the `VOXCODE_TOKEN` (or `VOXCODE_TOKEN`) environment variable. Alternatively, when started without a pre-set environment variable, the daemon generates a token and writes it to `%TEMP%\voxcode.token`.
2. The VS Code extension connects using the in-memory token (or reads the ephemeral token file).
3. The extension immediately sends an `authenticate` message:
   ```json
   {
     "action": "authenticate",
     "token": "<ephemeral-token>"
   }
   ```
4. If authentication succeeds, the daemon replies with:
   ```json
   {
     "event": "auth_ok",
     "version": "0.2.0"
   }
   ```
5. If invalid or missing within 2.0 seconds, the connection is terminated by the server.

### 1.2 Client Registration

Following authentication, the extension identifies its workspace and client instance:

```json
{
  "action": "register",
  "client_id": "vscode-win32-1725560000000",
  "workspace_name": "voxcode"
}
```

---

## 2. Client Action Messages (Extension $\rightarrow$ Daemon)

All client actions are JSON objects containing an `"action"` field.

### `start_recording`
Instructs the daemon to begin capturing audio and streaming partial transcriptions.

```json
{
  "action": "start_recording",
  "client_id": "vscode-win32-1725560000000",
  "style": "code"
}
```
- `style`: `"code"` or `"prose"`. Dictates Whisper prompt biasing and text formatting options.

### `stop_recording`
Tells the daemon to stop audio recording and perform final Whisper transcription.

```json
{
  "action": "stop_recording",
  "client_id": "vscode-win32-1725560000000"
}
```

### `cancel_recording`
Discards the current recording buffer immediately without generating a transcript.

```json
{
  "action": "cancel_recording",
  "client_id": "vscode-win32-1725560000000"
}
```

### `get_status`
Queries current daemon status.

```json
{
  "action": "get_status",
  "client_id": "vscode-win32-1725560000000"
}
```

---

## 3. Daemon Event Messages (Daemon $\rightarrow$ Extension)

All daemon events are JSON objects containing an `"event"` field.

### `status_changed`
Emitted whenever the daemon session changes state.

```json
{
  "event": "status_changed",
  "state": "listening"
}
```
Possible values for `state`:
- `"idle"`: Daemon is ready and waiting for dictation.
- `"loading_model"`: Whisper speech recognition model is downloading or initializing.
- `"listening"`: Microphone capture is active.
- `"transcribing"`: Audio segment is undergoing Whisper model inference.
- `"error"`: Daemon encountered an error.

### `rms_power`
Streams live audio input level (root-mean-square power) for visualization:

```json
{
  "event": "rms_power",
  "value": 0.42
}
```

### `partial_transcript`
Real-time partial hypotheses streamed during speech:

```json
{
  "event": "partial_transcript",
  "client_id": "vscode-win32-1725560000000",
  "text": "function calculate"
}
```

### `transcript`
Final speech-to-text result after inference completes:

```json
{
  "event": "transcript",
  "client_id": "vscode-win32-1725560000000",
  "source": "vscode",
  "text": "function calculateTotal(items: Item[]) {",
  "raw": "Function calculate total items: item array.",
  "handled_by_daemon": false
}
```
- `handled_by_daemon`: Set to `false` for native VS Code buffer/terminal injection.

### `error`
Reports an error from the daemon:

```json
{
  "event": "error",
  "client_id": "vscode-win32-1725560000000",
  "code": "MODEL_LOADING",
  "message": "Speech model is still downloading or initializing. Please wait a moment..."
}
```

Common error codes:
- `MODEL_LOADING`: Speech model is downloading or initializing; recording request was queued/rejected gracefully.
- `MIC_UNAVAILABLE`: Audio capture stream could not be opened.
- `INFERENCE_FAILED`: Whisper model evaluation failed.
- `UNAUTHORIZED`: Provided authentication token did not match.

---

## 4. Heartbeat & Reconnection

- **Ping**: The extension client sends a WebSocket ping frame every 30 seconds.
- **Backoff**: If the connection drops or the daemon is restarting, the client automatically attempts to reconnect using exponential backoff starting at 1,000ms up to a 10,000ms ceiling.
