# VoxCode VS Code Extension: Configuration & Keybindings Reference

This document provides a comprehensive guide to all contributed configuration settings, commands, keybindings, and custom context keys for VoxCode.

---

## 1. Extension Settings

Configuration settings are scoped under the `voxcode` namespace. You can configure them through the VS Code Settings UI (`Ctrl+,` or `Cmd+,`) or directly in your `settings.json`.

| Setting | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `voxcode.modelSize` | `string` | `"base"` | Whisper model size (`base`, `base.en`, `small`, `small.en`, `large-v3-turbo`). |
| `voxcode.device` | `string` | `"cpu"` | Compute device for speech recognition (`cpu` for universal compatibility, `cuda` for NVIDIA GPUs). |
| `voxcode.codeMode` | `boolean` | `true` | When `true`, automatically formats speech for programming code (lower-cases initial identifier letters and suppresses trailing sentence periods). |
| `voxcode.terminalAutoSubmit` | `boolean` | `false` | When `true`, appends a trailing newline (`\n`) to automatically execute dictated commands when speaking into the integrated terminal. |
| `voxcode.autoStartDaemon` | `boolean` | `false` | When `true`, automatically attempts to spawn the daemon if connection is lost. |
| `voxcode.serverUrl` | `string` | `"ws://127.0.0.1:7355"` | WebSocket bridge server URL for custom daemon endpoints. |
| `voxcode.daemonDirectory` | `string` | `""` | Optional custom working directory containing `voxcode-daemon` executable or script. |

### Example `settings.json`:

```json
{
  "voxcode.modelSize": "base",
  "voxcode.device": "cpu",
  "voxcode.codeMode": true,
  "voxcode.terminalAutoSubmit": false,
  "voxcode.autoStartDaemon": true
}
```

---

## 2. Contributed Commands

These commands are registered in VS Code's command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

| Command ID | Title | Description |
| :--- | :--- | :--- |
| `voxcode.toggleDictation` | **VoxCode: Toggle Dictation** | Universal primary toggle: toggles voice dictation on or off for the active editor or terminal dynamically without requiring arguments. |
| `voxcode.toggleEditorDictation` | **VoxCode: Toggle Editor Dictation** | Dedicated command to toggle dictation targeting the editor pane. |
| `voxcode.toggleTerminalDictation` | **VoxCode: Toggle Terminal Dictation** | Dedicated command to toggle dictation targeting the integrated terminal. |
| `voxcode.startRecording` | **VoxCode: Start Dictation** | Starts recording speech and captures editor/terminal focus snapshot. |
| `voxcode.stopRecording` | **VoxCode: Stop Dictation** | Stops recording and begins Whisper speech-to-text inference. |
| `voxcode.cancelDictation` | **VoxCode: Cancel Dictation** | Immediately discards the recording, clears ghost text, and resets state without modifying the buffer. |
| `voxcode.startDaemon` | **VoxCode: Start Daemon** | Spawns the managed background daemon process. |
| `voxcode.restartDaemon` | **VoxCode: Restart Background Daemon** | Restarts the managed background daemon. |
| `voxcode.showDaemonLogs` | **VoxCode: Show Daemon Output Logs** | Opens the daemon log output channel in VS Code. |
| `voxcode.reconnect` | **VoxCode: Reconnect to Bridge** | Forces an immediate reconnect to the WebSocket daemon bridge. |
| `voxcode.configureKeybinding` | **VoxCode: Configure Keyboard Shortcut** | Opens keyboard shortcuts settings focused on dictation. |
| `voxcode.toggleTerminalAutoSubmit` | **VoxCode: Toggle Terminal Auto-Submit (Auto-Enter / Review)** | Toggles terminal auto-submit on/off without opening settings and updates the status bar button. |
| `voxcode.installCudaRuntime` | **VoxCode: Download & Install NVIDIA CUDA 12 Runtime** | Downloads and configures CUDA 12 DLLs for GPU acceleration. |

---

## 3. Keybindings

The extension ships with unified, conflict-free shortcuts for effortless dictation:

| Shortcut (Win / Linux) | Shortcut (macOS) | Command | When Expression | Description |
| :--- | :--- | :--- | :--- | :--- |
| `Ctrl+Alt+V` | `Cmd+Alt+V` | `voxcode.toggleDictation` | — | Universal toggle: start or stop dictation in active editor or terminal (dynamically detected) |
| `Escape` | `Escape` | `voxcode.cancelDictation` | `voxcode.isRecording` | Discard recording and reset state |

> [!NOTE]
> Custom keybindings customized in VS Code's Keyboard Shortcuts UI (`keybindings.json`) do NOT require any arguments (`args`) or when clauses. `voxcode.toggleDictation` autonomously starts dictation when idle, stops dictation and injects text when recording, and dynamically inspects whether your terminal or editor has active focus.

---

## 3.1 Custom Keybinding Guidelines & Terminal Shell Bypass

### Terminal Shell Bypass (`terminal.integrated.commandsToSkipShell`)
In VS Code's integrated terminal, keystrokes are forwarded directly to the active shell (`PowerShell`, `bash`, `zsh`) unless whitelisted.
VoxCode automatically registers its dictation commands in `terminal.integrated.commandsToSkipShell` on activation. If you configure a custom shortcut and need to verify manually, ensure your `settings.json` includes:

```json
{
  "terminal.integrated.commandsToSkipShell": [
    "voxcode.toggleDictation",
    "voxcode.toggleTerminalDictation",
    "voxcode.cancelDictation",
    "voxcode.stopRecording"
  ]
}
```

### Keyboard Advice for Windows & Non-US Layouts
When configuring custom shortcuts on Windows with European, Italian, or German keyboard layouts:
- **Avoid `Ctrl+Alt+<letter>` on European layouts**: On Windows, `Ctrl+Alt` is physically equivalent to `AltGr`, which conflicts with special character generation (`@`, `#`, `[`, `]`, `{`, `}`).
- **Avoid `PauseBreak` / `Pausa Interr`**: Windows kernel intercepts `VK_PAUSE` for console break interrupts, and Chromium/VS Code does not reliably emit DOM events for it.
- **Avoid `PrintScreen`**: On Windows 11, the `PrintScreen` key is hooked globally by the Snipping Tool.
- **Recommended reliable single-key and chord shortcuts**:
  - `F8`, `F9`, or `F10`
  - `Ctrl+Shift+Space`
  - `Alt+Shift+V`
  - `Ctrl+F1`

### Example Custom `keybindings.json`:
```json
[
  {
    "key": "f8",
    "command": "voxcode.toggleDictation"
  }
]
```

> [!NOTE]
> The `Escape` cancellation keybinding is strictly guarded by `voxcode.isRecording`. When you are not dictating, `Escape` retains its default VS Code behavior.

---

## 4. Context Keys

The extension updates internal VS Code context keys that you can use in custom `keybindings.json` rules:

| Context Key | Type | Description |
| :--- | :--- | :--- |
| `voxcode.connected` | `boolean` | `true` when the extension has established an authenticated WebSocket connection with the daemon. |
| `voxcode.isRecording` | `boolean` | `true` when local dictation is active and recording audio. |

---

## 5. Status Bar Indicators

VoxCode displays a dedicated item in the VS Code status bar (bottom right):

| Status Bar Display | State | Meaning |
| :--- | :--- | :--- |
| `$(mic-off) VoxCode: Offline` | Offline | Daemon is offline. Click to launch daemon. |
| `$(sync~spin) VoxCode: Loading Model...` | Model Loading | Whisper model is downloading/loading. Click to show logs. |
| `$(mic) VoxCode: Ready` | Ready | Authenticated and awaiting dictation. Click to start. |
| `$(record) VoxCode: Listening...` | Listening | Microphone active. Click to finish recording. |
| `$(loading~spin) VoxCode: Transcribing...` | Transcribing | Whisper speech-to-text inference running. |
| `$(error) VoxCode: Error` | Error | An error occurred. Click to reconnect. |

### Terminal Auto-Submit Status Bar Button (Bottom Right)

Located immediately adjacent to the main mic status item:

| Button Display | Mode | Action on Click |
| :--- | :--- | :--- |
| `$(terminal) ↵ Auto-Enter` | Auto-Enter Active | Instantly switches to **Review Mode** |
| `$(terminal) Review` | Review Mode Active | Instantly switches to **Auto-Enter Mode** |
