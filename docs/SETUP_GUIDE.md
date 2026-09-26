# VoxCode VS Code Extension: Setup & Development Guide

This guide covers everything required to set up, build, test, and package the **VoxCode VS Code Extension** locally.

---

## 1. Prerequisites

### 1.1 Node.js & Toolchain
- **Node.js**: `v18.x` or `v20.x`+ (LTS recommended)
- **npm**: `v9.x`+
- **TypeScript**: `v5.3+`
- **Visual Studio Code**: `^1.85.0`

### 1.2 Python Runtime (for development/source mode)
When testing directly from TypeScript and Python sources:
- **Python**: `3.10+`
- **Dependencies**: `faster-whisper`, `websockets`, `sounddevice`, `numpy` (automatically provisioned in `globalStorageUri/venv` if missing).
- (Optional) `PyInstaller` if freezing the standalone binary via `python server/build_headless.py`.

---

## 2. Getting Started

### 2.1 Clone & Install Dependencies

```bash
git clone https://github.com/danigit/voxcode.git
cd voxcode
npm install
```

### 2.2 Compilation & Build Scripts

The project uses `esbuild` for high-performance bundling and `tsc` for strict type-checking:

| Command | Purpose |
| :--- | :--- |
| `npm run compile` | Runs TypeScript compiler type-checking (`tsc -p ./ --noEmit`) without emitting files. |
| `npm run build` | Bundles `src/extension.ts` into `dist/extension.js` via `node esbuild.js`. |
| `npm run build:production` | Creates a minified, production-optimized bundle. |
| `npm run watch` | Runs esbuild in watch mode, automatically rebuilding on file changes. |
| `npm run build:daemon` | Freezes the standalone daemon binary into `bin/win32-x64/` using `server/build_headless.py`. |
| `npm test` | Compiles tests (`esbuild.test.js`) and runs the Node.js native test runner against `out/test/*.test.js`. |
| `npm run package` | Packages the extension into a `.vsix` archive using `@vscode/vsce`. |

---

## 3. Running Unit Tests

The test suite runs using Node.js's built-in test runner (`node --test`), testing the complete injection logic, auto-spacer, token discovery, process supervisor with lockfile management, and mock VS Code editor APIs:

```bash
npm test
```

### Test Coverage Areas (45 Tests):
- **AssetManager**: Model cache directory creation, binary location priority, and progress notification wrappers.
- **AutoSpacer**: Code mode keyword lowercasing, trailing period suppression, punctuation regex handling, delimiter awareness (`(`, `[`, `{`, `"`, `'`), and prose vs code document detection.
- **FocusTracker**: Active editor vs integrated terminal resolution, multi-cursor snapshotting, snapshot clearing, and fallback visible editor scanning.
- **Headless Daemon Integration**: Stdin anti-zombie watchdog, environment variable token authentication (`VOXCODE_TOKEN` / `VOXCODE_TOKEN`), mock STT inference, and WebSocket dictation lifecycle.
- **ProcessSupervisor**: Free loopback port allocation, port probing, multi-window lockfile sharing (`%TEMP%\voxcode_managed.json`), and stale lockfile cleanup.
- **TextDispatcher**: Line and character coordinate math for single/multi-line inputs, cumulative multi-cursor deltas, atomic `editor.edit` execution, `workspace.applyEdit` fallback, and `terminal.sendText`.
- **VoxCodeClient**: In-memory token authentication handshake, registration flow, ping heartbeats, reconnection backoff, and event dispatch.
- **Token**: Discovery of ephemeral tokens and validation.

---

## 4. Debugging in Visual Studio Code

1. Open this repository folder in VS Code.
2. Ensure dependencies are built:
   ```bash
   npm run build
   ```
3. Press `F5` (or go to the **Run and Debug** view and launch **"Run Extension"**).
4. A new **Extension Development Host** window will open with VoxCode loaded.
5. Open the Output panel (`Ctrl+Shift+U` / `Cmd+Shift+U`) and switch to the **"VoxCode"** channel to inspect live log events.

---

## 5. Freezing the Standalone Daemon

To produce the zero-dependency executable bundled into `bin/win32-x64/`:

```bash
python server/build_headless.py --copy-to ./bin/win32-x64
```

This compiles `server/headless_daemon.py` into a compact executable without heavy GUI or PySide6 dependencies.

---

## 6. Packaging as a VSIX Extension

To build an installable `.vsix` package:

```bash
npm run package
```

The resulting `voxcode-0.2.0.vsix` is self-contained and ready for direct installation (`code --install-extension voxcode-0.2.0.vsix`) or publishing to the VS Code Marketplace.
