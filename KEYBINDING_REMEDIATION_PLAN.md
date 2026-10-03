# VoxCode Robust Keybinding & Focus Architecture Remediation Plan

This document provides a complete, autonomous, step-by-step specification for an agent executing with `/goal`. Follow each phase sequentially, run the test suites, and verify all acceptance criteria.

---

## 🎯 Executive Summary & Mission

### Problem Statement
Users report that changing the default keyboard shortcut (`ctrl+alt+v`) in Visual Studio Code (for example, to `ctrl+alt+i`, `ctrl+alt+j`, `F8`, or dedicated keyboard keys like `pausebreak` / `printscreen`) breaks VoxCode. The command fails to toggle dictation, speech is not injected into the terminal or editor, and the keybinding appears unresponsive.

### Root Causes
1. **Loss of Arguments in VS Code UI (`args: { "target": "..." }`)**:
   [`package.json`](file:///E:/projects/voxcode/package.json) declared keybindings with internal arguments: `args: { "target": "editor" }` and `args: { "target": "terminal" }`. When users customize shortcuts via VS Code's Keyboard Shortcuts GUI or `keybindings.json`, VS Code strips `args`. In [`focusTracker.ts`](file:///E:/projects/voxcode/src/focus/focusTracker.ts), when `args` is `undefined`, `snapshot()` returns `{ kind: 'none' }` whenever the text editor loses focus, causing terminal dictation to fail completely.
2. **Terminal Keystroke Swallowing (`terminal.integrated.commandsToSkipShell`)**:
   In VS Code's integrated terminal, keystrokes are forwarded to the underlying shell process (`PowerShell`, `bash`, `agy`) unless the command is explicitly whitelisted in `terminal.integrated.commandsToSkipShell`. Without `voxcode.toggleDictation` in this list, function keys and non-standard combinations are swallowed by the terminal.
3. **Split Keybinding UX Desynchronization**:
   [`package.json`](file:///E:/projects/voxcode/package.json) defined two separate entries for `voxcode.toggleDictation` (`editorTextFocus` and `terminalFocus`). Users editing the shortcut in VS Code change only one entry, leaving the other bound to the old key or unbound.
4. **Overly Restrictive `when` Clauses**:
   Keys scoped strictly to `editorTextFocus` and `terminalFocus` silently do nothing when tested in the Keyboard Shortcuts tab, settings, sidebars, or webviews.
5. **Lack of Diagnostics & Logging**:
   [`extension.ts`](file:///E:/projects/voxcode/src/extension.ts) toggle commands had zero logging, leaving users and developers blind to whether a keystroke reached the extension.

---

## 📋 Table of Affected Files

| Component | File Path | Scope of Work |
| :--- | :--- | :--- |
| **Focus Tracking** | [`src/focus/focusTracker.ts`](file:///E:/projects/voxcode/src/focus/focusTracker.ts) | Eliminate fragile dependency on `args.target`. Intelligently resolve focus between active terminal and visible editors when `args` is undefined. |
| **Command Wiring** | [`src/extension.ts`](file:///E:/projects/voxcode/src/extension.ts) | Add detailed telemetry/execution logging to `toggleHandler` and dictation handlers. Auto-configure `commandsToSkipShell`. |
| **Manifest** | [`package.json`](file:///E:/projects/voxcode/package.json) | Unify keybindings; declare broad, conflict-free `when` clauses; support unified and targeted command aliases. |
| **Unit Tests** | [`test/focusTracker.test.ts`](file:///E:/projects/voxcode/test/focusTracker.test.ts) | Add unit tests covering argument-less snapshotting, active terminal fallback, and multi-pane editor resolution. |
| **Documentation** | [`docs/CONFIGURATION.md`](file:///E:/projects/voxcode/docs/CONFIGURATION.md), [`README.md`](file:///E:/projects/voxcode/README.md) | Document custom keybindings, terminal skip-shell setup, and international/Windows keyboard guidelines. |

---

## 🛠️ Phase 1: Self-Healing Focus Tracking

### File: [`src/focus/focusTracker.ts`](file:///E:/projects/voxcode/src/focus/focusTracker.ts)

### Objective
Make `FocusTracker` resilient when invoked without `targetHint` (`args === undefined`), while preserving backward compatibility when explicit hints are passed.

### Implementation Specification
1. **Dynamic Target Detection in `snapshot(targetHint?)`**:
   - If `targetHint` is explicitly provided, respect it.
   - If `targetHint` is **omitted / undefined**:
     - Check `vscode.window.activeTerminal`. If `lastFocusedKind === 'terminal'` OR if `vscode.window.activeTextEditor` is null/undefined and `vscode.window.activeTerminal` exists, treat the terminal as the active target.
     - If `vscode.window.activeTextEditor` exists and is visible, capture the editor snapshot (including multi-cursor selections).
     - If an editor was previously focused (`lastFocusedKind === 'editor'`), find the active or first visible text editor in `vscode.window.visibleTextEditors`.
     - Only return `{ kind: 'none' }` if neither a text editor nor an active terminal can be resolved.
2. **Robust Focus State Machine**:
   - In `onDidChangeActiveTextEditor`:
     - If `editor` is non-null: `lastFocusedKind = 'editor'`.
     - If `editor` is null: do NOT immediately set `lastFocusedKind = 'none'` if `vscode.window.activeTerminal` is present. Set `lastFocusedKind = 'terminal'`.
   - In `onDidChangeActiveTerminal`:
     - If `terminal` is non-null: `lastFocusedKind = 'terminal'`.
3. **Add `getActiveTargetKind()` method**:
   - Expose a public helper `getActiveTargetKind(): 'editor' | 'terminal' | 'none'` for logging and diagnostics.

---

## 🛠️ Phase 2: Command Logging & Automatic Shell-Bypass

### File: [`src/extension.ts`](file:///E:/projects/voxcode/src/extension.ts)

### Objective
1. Provide diagnostic visibility so users can verify keybindings via the VoxCode Output channel.
2. Automatically ensure `terminal.integrated.commandsToSkipShell` includes VoxCode dictation commands so terminal keys are never swallowed.

### Implementation Specification
1. **Logging in `toggleHandler`**:
   ```typescript
   const toggleHandler = (args?: { target?: 'editor' | 'terminal' }) => {
     extLog('INFO', 'Command voxcode.toggleDictation triggered', {
       args,
       hasActiveEditor: Boolean(vscode.window.activeTextEditor),
       hasActiveTerminal: Boolean(vscode.window.activeTerminal),
       activeTerminalName: vscode.window.activeTerminal?.name,
     });

     if (args?.target === 'terminal') {
       focusTracker?.markTerminalFocused();
     } else if (args?.target === 'editor') {
       focusTracker?.markEditorFocused();
     }

     if (isRecording) {
       stopRecording();
     } else {
       startRecording(args?.target);
     }
   };
   ```
2. **Auto-Whitelisting `commandsToSkipShell`**:
   Add a helper function `ensureTerminalCommandsSkipShell()` called during extension `activate()`:
   ```typescript
   async function ensureTerminalCommandsSkipShell(): Promise<void> {
     try {
       const terminalConfig = vscode.workspace.getConfiguration('terminal.integrated');
       const current = terminalConfig.get<string[]>('commandsToSkipShell') || [];
       const required = ['voxcode.toggleDictation', 'voxcode.cancelDictation', 'voxcode.stopRecording'];
       const missing = required.filter((cmd) => !current.includes(cmd));

       if (missing.length > 0) {
         const updated = [...current, ...missing];
         await terminalConfig.update('commandsToSkipShell', updated, vscode.ConfigurationTarget.Global);
         extLog('INFO', 'Registered VoxCode commands in terminal.integrated.commandsToSkipShell', { added: missing });
       }
     } catch (err: any) {
       extLog('WARN', 'Failed to update terminal.integrated.commandsToSkipShell automatically', { error: err?.message });
     }
   }
   ```
3. **Dedicated Target Commands**:
   Register explicit commands so users who want dedicated shortcuts for terminal vs editor can bind them cleanly:
   - `voxcode.toggleEditorDictation` -> calls `toggleHandler({ target: 'editor' })`
   - `voxcode.toggleTerminalDictation` -> calls `toggleHandler({ target: 'terminal' })`
   Keep `voxcode.toggleDictation` as the primary universal toggle.

---

## 🛠️ Phase 3: Manifest & Keybinding Optimization

### File: [`package.json`](file:///E:/projects/voxcode/package.json)

### Objective
Prevent duplicate conflicting entries in VS Code's Keyboard Shortcuts UI and ensure shortcuts work reliably across all contexts.

### Implementation Specification
1. **Command Contributions**:
   Add `voxcode.toggleEditorDictation` and `voxcode.toggleTerminalDictation` under `contributes.commands`.
2. **Keybinding Contributions**:
   Update `contributes.keybindings`:
   - Keep the universal toggle `voxcode.toggleDictation` with default key `ctrl+alt+v` (mac: `cmd+alt+v`) and `"when": "!voxcode.isRecording"`.
   - Provide dedicated fallback bindings:
     ```json
     "keybindings": [
       {
         "command": "voxcode.toggleDictation",
         "key": "ctrl+alt+v",
         "mac": "cmd+alt+v",
         "when": "!voxcode.isRecording"
       },
       {
         "command": "voxcode.stopRecording",
         "key": "ctrl+alt+v",
         "mac": "cmd+alt+v",
         "when": "voxcode.isRecording"
       },
       {
         "command": "voxcode.cancelDictation",
         "key": "escape",
         "when": "voxcode.isRecording"
       }
     ]
     ```
   *(Note: This unifies the toggle into clean states without duplicating editor vs terminal rows in the Keyboard Shortcuts UI, since `FocusTracker` now detects the target dynamically).*

---

## 🛠️ Phase 4: Unit Testing & Self-Healing Verification

### File: [`test/focusTracker.test.ts`](file:///E:/projects/voxcode/test/focusTracker.test.ts)

### Test Scenarios to Implement & Verify
1. **Argument-less Snapshot with Active Terminal**:
   - `mockVscodeWindow.activeTerminal = { name: 'bash' }`
   - `mockVscodeWindow.activeTextEditor = null`
   - Calling `tracker.snapshot()` without arguments must return `kind: 'terminal'`.
2. **Argument-less Snapshot with Active Editor**:
   - `mockVscodeWindow.activeTextEditor = mockEditor`
   - Calling `tracker.snapshot()` without arguments must return `kind: 'editor'` with correct cursor selections.
3. **Editor Blurred, Terminal Present**:
   - When editor becomes `null` and terminal exists, snapshot must resolve to the active terminal.
4. **Both Present, Terminal Explicitly Focused**:
   - `tracker.markTerminalFocused()` followed by `tracker.snapshot()` resolves to terminal.
5. **Backward Compatibility with Explicit Hint**:
   - `tracker.snapshot('terminal')` returns terminal.
   - `tracker.snapshot('editor')` returns editor.

---

## 🛠️ Phase 5: Build & Packaging Verification

### Commands to Run
1. `npm install` (ensure all dev dependencies including `esbuild` and `typescript` are installed).
2. `npm run compile` (`tsc -p ./ --noEmit`).
3. `npm test` (run node test suite and ensure all tests pass).
4. `npm run build` (build distribution bundle via esbuild).
5. Verify `dist/extension.js` contains the updated focus tracking and skip-shell logic.

---

## 💡 Keyboard Advice for Users (Windows & Non-US Layouts)

When custom shortcuts are desired on Windows with European or Italian layouts:
- **Avoid `Ctrl+Alt+<letter>` on European layouts**: In Windows, `Ctrl+Alt` is physically equivalent to `AltGr`, which conflicts with special character generation (`@`, `#`, `[`, `]`, `{`, `}`).
- **Avoid `PauseBreak` / `Pausa Interr`**: Windows kernel intercepts `VK_PAUSE` for console interrupts, and Chromium does not reliably emit DOM `keydown` events for it.
- **Avoid `PrintScreen`**: On Windows 11, the `PrintScreen` key is hooked globally by the Snipping Tool.
- **Recommended reliable single-key shortcuts**:
  - `F8`, `F9`, or `F10`
  - `Ctrl+Shift+Space`
  - `Alt+Shift+V`
  - `Ctrl+F1`
