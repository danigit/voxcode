# VoxCode Comprehensive Audit & Remediation Plan

This document contains the complete specification of issues, vulnerabilities, bloat factors, and logic bugs identified in the VoxCode repository, along with step-by-step instructions and code-level remediation guidance for an autonomous agent executing with `/goal`.

---

## 🎯 Primary Goal & Scope

Execute all remediation phases below to transform VoxCode into a secure, lightweight, race-free, and robust VS Code extension:
1. **Dimension Reduction**: Reduce the packaged `.vsix` from **247.2 MB to < 1 MB (>99.8% reduction)** by fixing packaging ignore rules.
2. **Security Hardening**: Eliminate process termination hijacking (`taskkill`), cleartext tokens, PowerShell path injections, sibling DLL loading, and insecure mirror fallbacks.
3. **Core Logic & Concurrency**: Eliminate dual daemon restart race conditions, focus hijacking to background terminals, audio capture memory leaks on client disconnect, and multi-cursor multi-line selection displacement.
4. **Build & CI/CD Stability**: Repair GitHub Actions workflows, PyInstaller spec paths, and unit test temporary file pollution.

---

## 📋 Table of Affected Files

| Component | File Path | Key Changes Required |
| :--- | :--- | :--- |
| **Packaging** | [`.vscodeignore`](file:///C:/Users/surpa/Desktop/projects/voxcode/.vscodeignore) | Exclude `bin/**`, `models/**`, `*.spec`, `.github/**`, `__pycache__/**` |
| **Supervisor** | [`src/supervisor/processSupervisor.ts`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/supervisor/processSupervisor.ts) | Move lockfile/token from `%TEMP%` to `globalStorageUri`; validate process before `taskkill`; fix multi-window status |
| **CUDA Manager** | [`src/supervisor/cudaManager.ts`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/supervisor/cudaManager.ts) | Fix dual restart race; escape PowerShell paths; handle cancellation tokens; fix `.whl` extraction; remove redundant cuDNN |
| **Focus** | [`src/focus/focusTracker.ts`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/focus/focusTracker.ts) | Do not route speech to background terminals on editor blur |
| **Text Injector** | [`src/injector/textDispatcher.ts`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/injector/textDispatcher.ts) | Correct multi-line selection line delta calculations; prevent dirty buffer inspection |
| **Formatting** | [`src/injector/autoSpacer.ts`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/injector/autoSpacer.ts) | Preserve casing for acronyms (e.g. `HTTPClient`, `SQL`) and PascalCase types |
| **Bridge Client** | [`src/bridge/client.ts`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/bridge/client.ts) | Allow reconnecting after dispose; debounce/deduplicate disconnect events |
| **Token Handling**| [`src/bridge/token.ts`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/bridge/token.ts) | Read token from `globalStorageUri` instead of `%TEMP%`; remove dead duplicated constants |
| **Daemon Server** | [`server/headless_daemon.py`](file:///C:/Users/surpa/Desktop/projects/voxcode/server/headless_daemon.py) | Cleanup recording on client disconnect; guard transcribe concurrency; fix origin check header access; remove token in `%TEMP%` |
| **Engine / Polisher** | [`server/core/engine.py`](file:///C:/Users/surpa/Desktop/projects/voxcode/server/core/engine.py), [`server/core/polisher.py`](file:///C:/Users/surpa/Desktop/projects/voxcode/server/core/polisher.py) | Remove sibling `.venv` DLL search; remove untrusted `hf-mirror.com`; prevent stripping valid words (`er`, `ah`) |
| **CI / Build** | [`.github/workflows/build-and-release.yml`](file:///C:/Users/surpa/Desktop/projects/voxcode/.github/workflows/build-and-release.yml), [`voxcode-daemon.spec`](file:///C:/Users/surpa/Desktop/projects/voxcode/voxcode-daemon.spec) | Fix macOS runner (`macos-13`); make PyInstaller spec relative |
| **Tests** | [`test/processSupervisor.test.ts`](file:///C:/Users/surpa/Desktop/projects/voxcode/test/processSupervisor.test.ts) | Isolate lockfile paths so `npm test` does not wipe out live `%TEMP%\voxcode_managed.json` |

---

## 🛠️ Phase 1: Extension Dimension & Package Bloat

### Issue 1.1: Packaged VSIX is 247.2 MB
- **Root Cause**: [`.vscodeignore`](file:///C:/Users/surpa/Desktop/projects/voxcode/.vscodeignore) does not exclude compiled binaries (`bin/**`), base models (`models/**`), PyInstaller build specs (`*.spec`), GitHub workflows (`.github/**`), and root bytecode (`__pycache__/**`).
- **Required Changes**:
  1. Edit [`.vscodeignore`](file:///C:/Users/surpa/Desktop/projects/voxcode/.vscodeignore) to add:
     ```text
     bin/**
     models/**
     *.spec
     voxcode-daemon.spec
     .github/**
     __pycache__/**
     media/hero_banner.png
     ```
  2. Optimize [`media/icon.png`](file:///C:/Users/surpa/Desktop/projects/voxcode/media/icon.png) to reduce asset footprint.
- **Verification**: Run `npx vsce package` and verify that the output `.vsix` size is under **1 MB** (target ~480 KB).

---

## 🔒 Phase 2: Security & Trust Boundary Fixes

### Issue 2.1: Insecure Temp Lockfile & Arbitrary Process Termination (`taskkill`)
- **Location**: [`src/supervisor/processSupervisor.ts#L410-L430`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/supervisor/processSupervisor.ts#L410-L430)
- **Problem**: Any local process can write an arbitrary PID into `%TEMP%\voxcode_managed.json`. When restarting, the extension blindly invokes `taskkill /F /T /PID <pid>`.
- **Fix**:
  1. Change lockfile location from `os.tmpdir()` to `context.globalStorageUri.fsPath`.
  2. Before executing `taskkill`, verify that the target process is actually a VoxCode daemon process (e.g. check process executable name via `wmic` or PowerShell, or verify child ownership).
  3. Ensure directory permissions on `globalStorageUri` are standard user-isolated permissions.

### Issue 2.2: Cleartext Auth Token in World-Readable `%TEMP%`
- **Location**: [`src/supervisor/processSupervisor.ts#L296-L303`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/supervisor/processSupervisor.ts#L296-L303), [`server/headless_daemon.py#L195-L201`](file:///C:/Users/surpa/Desktop/projects/voxcode/server/headless_daemon.py#L195-L201), [`src/bridge/token.ts`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/bridge/token.ts)
- **Problem**: Writing tokens to `%TEMP%\voxcode.token` and `%TEMP%\voxcode_managed.json` exposes the WebSocket authentication token to any local program. Windows ignores `0o600` POSIX mode.
- **Fix**:
  1. Pass the generated 32-byte secret strictly via the `VOXCODE_TOKEN` environment variable to child processes.
  2. If file-based token storage is needed for standalone multi-window sync, store it inside `context.globalStorageUri` rather than `%TEMP%`.
  3. Update [`src/bridge/token.ts`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/bridge/token.ts) to read from `globalStorageUri` with fallback to environment variables.

### Issue 2.3: PowerShell Command / Path Injection in `cudaManager.ts`
- **Location**: [`src/supervisor/cudaManager.ts#L347-L362`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/supervisor/cudaManager.ts#L347-L362)
- **Problem**: Single quotes in username paths (e.g. `C:\Users\Liam O'Connor\...`) break `'${archivePath}'` interpolation in PowerShell scripts.
- **Fix**:
  1. Escape single quotes by replacing `'` with `''` in path variables before PowerShell interpolation, or pass paths via PowerShell environment variables / `-LiteralPath` parameter arguments using `child_process.execFile('powershell.exe', ['-NoProfile', '-Command', ...])`.
  2. For `.whl` files, rename the archive to `.zip` before invoking `Expand-Archive`, or prefer using Python standard library `zipfile` module when Python is available.

### Issue 2.4: Sibling Directory DLL Scanning
- **Location**: [`server/core/engine.py#L150-L161, L211-L232`](file:///C:/Users/surpa/Desktop/projects/voxcode/server/core/engine.py#L150-L161)
- **Problem**: `bootstrap_cuda_dlls()` climbs two directories above `exe_dir` and scans all sibling folders for `.venv` or `venv` to register DLL directories. This allows untrusted sibling projects to inject DLLs into VoxCode.
- **Fix**: Remove the broad parent directory traversal. Restrict DLL scanning strictly to:
  - The current daemon virtual environment (`sys.prefix`).
  - The extension global storage directory passed via an explicit command-line argument (`--storage-dir`) or environment variable (`VOXCODE_STORAGE_DIR`).
  - Standard system CUDA installation paths (`CUDA_PATH`).

### Issue 2.5: Untrusted Third-Party Model Mirror (`hf-mirror.com`)
- **Location**: [`server/core/engine.py#L392-L406`](file:///C:/Users/surpa/Desktop/projects/voxcode/server/core/engine.py#L392-L406)
- **Problem**: If Hugging Face is unreachable, the engine silently falls back to `https://hf-mirror.com` without integrity checks.
- **Fix**: Remove the automatic fallback to `hf-mirror.com`. If connection fails, prompt the user or allow configuring a trusted mirror via settings with explicit opt-in.

### Issue 2.6: WebSocket Origin Validation Bypasses
- **Location**: [`server/headless_daemon.py#L390-L397, L420-L425`](file:///C:/Users/surpa/Desktop/projects/voxcode/server/headless_daemon.py#L390-L397)
- **Problem**:
  1. `_validate_origin` only blocks `http://` and `https://`; sandboxed iframes (`null`) and local schemes pass.
  2. `ws.request.headers` fails on `websockets < 12`, causing origin to evaluate to `None`, which then bypasses origin validation completely.
- **Fix**:
  1. Safely retrieve headers: `headers = getattr(ws, "request_headers", None) or getattr(getattr(ws, "request", None), "headers", {})`.
  2. Whitelist valid origins: only allow connections where `Origin` is missing (native VS Code desktop client) or strictly matches approved VS Code webview origins (`vscode-webview://*`). Explicitly reject `Origin: null` from browser contexts.

---

## ⚡ Phase 3: Core Concurrency, Lifecycle & Logic Fixes

### Issue 3.1: Dual Daemon Spawn Race Condition in `postInstallSuccess`
- **Location**: [`src/supervisor/cudaManager.ts#L545-L555`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/supervisor/cudaManager.ts#L545-L555), [`src/extension.ts#L82-L107`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/extension.ts#L82-L107)
- **Problem**:
  ```typescript
  // cudaManager.ts
  await config.update('device', 'cuda', vscode.ConfigurationTarget.Global);
  ...
  if (supervisor && supervisor.isRunning()) {
    await supervisor.restart(); // <-- RACE!
  }
  ```
  Updating `voxcode.device` triggers the listener in `extension.ts`:
  ```typescript
  // extension.ts
  if (e.affectsConfiguration('voxcode.device')) {
    await supervisor.restart(); // <-- CONCURRENT RESTART!
  }
  ```
- **Fix**: Remove the explicit `supervisor.restart()` call in [`cudaManager.ts`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/supervisor/cudaManager.ts#L554). The configuration change event in `extension.ts` will cleanly handle the restart on its own.

### Issue 3.2: Editor Blur Inadvertently Types into Background Terminal
- **Location**: [`src/focus/focusTracker.ts#L34-L43`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/focus/focusTracker.ts#L34-L43)
- **Problem**: When the active text editor loses focus (e.g. user opens Settings, Diff, or an Output panel), `onDidChangeActiveTextEditor` fires with `editor = undefined`. Line 38 immediately sets `this.lastFocusedKind = 'terminal'` if an active terminal exists in the background.
- **Fix**: Do not switch focus kind to `'terminal'` simply because an editor was blurred. Track terminal focus explicitly via `vscode.window.onDidChangeActiveTerminal` and `vscode.window.onDidOpenTerminal`. If neither an editor nor a terminal is focused, set `lastFocusedKind = 'none'` or preserve the previous state without defaulting to background terminals.

### Issue 3.3: Unbounded Microphone Audio Accumulation on Client Disconnect
- **Location**: [`server/headless_daemon.py#L563-L570`](file:///C:/Users/surpa/Desktop/projects/voxcode/server/headless_daemon.py#L563-L570)
- **Problem**: When a WebSocket client disconnects abruptly (window reload, crash), the `finally` block in `handle_client` does not stop active audio recording. The capture loop continues indefinitely, consuming memory and locking the microphone.
- **Fix**: In the `finally` block of `handle_client`:
  ```python
  if self.active_client_id == conn.client_id and self.session_state == SessionState.RECORDING.value:
      logger.warning(f"Client {conn.client_id} disconnected while recording. Stopping audio capture.")
      self.audio.stop_recording()
      self.active_client_id = None
      await self._transition_state(SessionState.IDLE.value)
  ```
  Add a maximum recording duration ceiling (e.g. 5 minutes) in `audio.py` / `headless_daemon.py` to prevent runaway memory consumption.

### Issue 3.4: Concurrency Guard for Daemon Transcription Worker
- **Location**: [`server/headless_daemon.py#L248-L308, L515-L536`](file:///C:/Users/surpa/Desktop/projects/voxcode/server/headless_daemon.py#L248-L308)
- **Problem**: `start_recording` does not check if `_transcribe_worker` is currently running. Starting a new recording while transcribing leads to overwritten client IDs, premature state transitions to `idle`, and concurrent access to the non-thread-safe `WhisperModel`.
- **Fix**: Check `if self.session_state != SessionState.IDLE.value:` before accepting a new `start_recording` request. If busy transcribing, reject with an error code `BUSY_TRANSCRIBING` or await worker completion.

### Issue 3.5: Reconnection Guard in `VoxCodeClient`
- **Location**: [`src/bridge/client.ts#L126`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/bridge/client.ts#L126), [`src/extension.ts#L390-L396`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/extension.ts#L390-L396)
- **Problem**: `connect()` immediately returns if `this.isDisposed`. In `src/extension.ts`, `startDaemonHandler` does not re-instantiate `client` if it was disposed.
- **Fix**: Reset `isDisposed = false` or ensure `extension.ts` recreates the `VoxCodeClient` instance whenever the daemon is started or restarted.

### Issue 3.6: Detached Daemon State in Multi-Window Mode
- **Location**: [`src/supervisor/processSupervisor.ts#L131-L136, L169-L172`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/supervisor/processSupervisor.ts#L131-L136)
- **Problem**: Secondary windows attach to the daemon with `isChildOwner = false`. When the daemon terminates, secondary windows never know it died because they have no child exit hook. `isRunning()` remains `true` indefinitely.
- **Fix**: In secondary mode, implement a periodic liveness probe or monitor client WebSocket disconnection. When the socket disconnects and reconnection fails, reset `currentMode = 'UNMANAGED'` so `isRunning()` returns `false` and auto-start can trigger if needed.

---

## ✏️ Phase 4: Text Dispatcher & Formatting Fixes

### Issue 4.1: Multi-Cursor Selection Calculation with Multi-Line Selections
- **Location**: [`src/injector/textDispatcher.ts#L88-L94`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/injector/textDispatcher.ts#L88-L94), [`L296-L302`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/injector/textDispatcher.ts#L296-L302)
- **Problem**:
  1. Multi-line replacement math:
     ```typescript
     if (lines.length > 1) {
       lineDelta += lines.length - 1;
       charDeltaOnLine = endChar - origEnd.character;
     }
     ```
     `lineDelta` only adds lines inserted. It never subtracts lines removed (`origEnd.line - origStart.line`).
  2. `endChar - origEnd.character` subtracts character offsets from two different lines when the selection spans multiple lines.
  3. In `applyWorkspaceEditDirectly`, `computeNewSelections` is executed *after* the workspace edit is applied, reading from a mutated document buffer.
- **Fix**:
  1. Calculate `linesRemoved = origEnd.line - origStart.line`.
  2. Set `lineDelta += (lines.length - 1) - linesRemoved`.
  3. Track `lastLineLengthDelta = endChar - (linesRemoved === 0 ? origEnd.character : 0)` correctly per line.
  4. Compute selection targets using pre-edit document snapshots or calculate new selections prior to applying the workspace edit.

### Issue 4.2: Acronym Lowercasing in Code Mode
- **Location**: [`src/injector/autoSpacer.ts#L44-L47`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/injector/autoSpacer.ts#L44-L47)
- **Problem**:
  ```typescript
  if (/^[A-Z]/.test(result)) {
    result = result.charAt(0).toLowerCase() + result.slice(1);
  }
  ```
  Lowercases words like `"HTTPClient"`, `"SQL"`, `"URL"`, `"API"`, and PascalCase classes.
- **Fix**: Only lowercase if the word is followed by lowercase characters and is not an acronym:
  ```typescript
  // Only lowercase the first character if it's Titlecase (e.g. "Function" -> "function"),
  // but preserve acronyms (e.g. "HTTP", "SQLClient") and already camelCased terms.
  if (/^[A-Z][a-z]/.test(result) && !/^[A-Z]{2,}/.test(result)) {
    result = result.charAt(0).toLowerCase() + result.slice(1);
  }
  ```

### Issue 4.3: Filler Polisher Stripping Valid Language & Technical Words
- **Location**: [`server/core/polisher.py#L26-L29`](file:///C:/Users/surpa/Desktop/projects/voxcode/server/core/polisher.py#L26-L29)
- **Problem**: `\b(?:um+|uh+|er+|ah+)\b` removes "er" (German pronoun "he", or English "ER diagram") and "ah" (Ampere-hour).
- **Fix**: Make filler word removal language-aware or restrict to confirmed conversational English hesitations with context (e.g. require punctuation or hesitation markers, or verify against language setting).

---

## ⚙️ Phase 5: CUDA Installer & Download Robustness

### Issue 5.1: PowerShell `Expand-Archive` Rejects `.whl` Files
- **Location**: [`src/supervisor/cudaManager.ts#L348`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/supervisor/cudaManager.ts#L348)
- **Problem**: `Expand-Archive` throws an error if the file does not have a `.zip` extension.
- **Fix**: If using `Expand-Archive`, temporarily copy or rename `file.whl` to `file.zip` before extracting, or invoke Python's built-in `zipfile` module: `python -m zipfile -e <archive> <dest>`.

### Issue 5.2: Strategy 1 (pip) Ignores Cancellation Token
- **Location**: [`src/supervisor/cudaManager.ts#L426-L448`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/supervisor/cudaManager.ts#L426-L448)
- **Fix**: Hook `cancellationToken.onCancellationRequested` to kill the `child_process` spawned by `execFile`.

### Issue 5.3: Error Alert Shown on User Cancellation
- **Location**: [`src/supervisor/cudaManager.ts#L499-L532`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/supervisor/cudaManager.ts#L499-L532)
- **Fix**: In the catch block:
  ```typescript
  if (cancellationToken.isCancellationRequested || err.message?.includes('cancelled')) {
    vscode.window.showInformationMessage('VoxCode: CUDA download was cancelled.');
    return;
  }
  ```

### Issue 5.4: Redundant cuDNN Download for CTranslate2
- **Location**: [`src/supervisor/cudaManager.ts#L426`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/supervisor/cudaManager.ts#L426)
- **Problem**: `ctranslate2.dll` on Windows does not link against `cudnn`—only `cublas64_12.dll` and `cuda.dll`. Downloading `nvidia-cudnn-cu12` wastes ~600 MB of bandwidth.
- **Fix**: In Strategy 1, install only `nvidia-cublas-cu12`.

---

## 🏗️ Phase 6: Build, CI/CD, Spec & Test Suite

### Issue 6.1: Unit Test Suite Destroys Production Lockfiles
- **Location**: [`test/processSupervisor.test.ts#L58-L71, L100-L114`](file:///C:/Users/surpa/Desktop/projects/voxcode/test/processSupervisor.test.ts#L58-L71)
- **Problem**: Tests write fixtures to `getManagedLockfilePath()`, resolving directly to the live `%TEMP%\voxcode_managed.json`.
- **Fix**: Parameterize `ProcessSupervisor` with a custom storage path or mock `getManagedLockfilePath()` during tests to use a temporary isolated sandbox directory.

### Issue 6.2: Hardcoded Local Paths in PyInstaller Spec
- **Location**: [`voxcode-daemon.spec#L4-L8`](file:///C:/Users/surpa/Desktop/projects/voxcode/voxcode-daemon.spec#L4-L8)
- **Problem**: Hardcodes `pathex=['C:/Users/surpa/Desktop/projects/voxcode/server']`.
- **Fix**: Use relative paths or `SPECPATH`:
  ```python
  import os
  spec_root = os.path.abspath(SPECPATH)
  server_dir = os.path.join(spec_root, 'server')
  ```

### Issue 6.3: Non-Existent GitHub Actions Runner
- **Location**: [`.github/workflows/build-and-release.yml#L25`](file:///C:/Users/surpa/Desktop/projects/voxcode/.github/workflows/build-and-release.yml#L25)
- **Problem**: `macos-15-intel` does not exist on GitHub Actions.
- **Fix**: Update to `macos-13` (Intel) or `macos-14`/`macos-15` (ARM64 Apple Silicon).

### Issue 6.4: GhostText Decorator Dead Code Clean-up
- **Location**: [`src/decorations/ghostText.ts`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/decorations/ghostText.ts), [`src/extension.ts#L261-L276`](file:///C:/Users/surpa/Desktop/projects/voxcode/src/extension.ts#L261-L276)
- **Decision**: Either:
  1. Implement streaming partial transcription events (`partial_transcript`) in `headless_daemon.py` using a lightweight VAD/partial decoder; OR
  2. Deprecate and remove `GhostTextManager` and related listeners from `extension.ts` to reduce bundle complexity.

---

## 🧪 Phase 7: Verification & Testing Checklist

When all code changes are complete, execute these verification commands in sequence:

1. **Compile & Lint**:
   ```powershell
   npm run compile
   ```
   *Must complete with 0 errors.*

2. **Run Unit & Integration Tests**:
   ```powershell
   npm test
   ```
   *Verify all tests pass without mutating `%TEMP%\voxcode_managed.json`.*

3. **Verify VSIX Package Dimension**:
   ```powershell
   npx vsce package
   ```
   *Verify that the generated `.vsix` file is < 1 MB.*

4. **Verify Concurrency & Supervisor**:
   - Start daemon $\rightarrow$ confirm single process in Task Manager.
   - Trigger CUDA install / device change $\rightarrow$ confirm exactly one daemon restarts, no dual spawns.
   - Open Settings (`Ctrl+,`) and speak $\rightarrow$ confirm no characters are sent to background terminal.
