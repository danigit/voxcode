# Changelog

All notable changes to the **VoxCode** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.0] - 2026-10-03

### Added
- **Consolidated Single Status Bar Widget**: Replaced multiple status bar icons with a unified status item in the bottom right (`$(mic) VoxCode: Ready [✎ Review]` or `[↵ Auto]`), displaying real-time engine status, device backend (CPU/CUDA), and terminal submission mode.
- **Interactive QuickPick Control Menu (`voxcode.showMenu`)**: Clicking the status bar item or executing the menu command provides 1-click access to toggle Auto-Submit, start/stop dictation, rebind keyboard shortcuts, view daemon output logs, install CUDA runtimes, or restart the engine.
- **Dedicated Terminal Auto-Submit Toggle (`voxcode.toggleTerminalAutoSubmit`)**: Switch seamlessly between **Review Mode** (commands stay on prompt for inspection) and **Auto-Submit Mode** (hands-free execution with trailing newline).
- **Dynamic Argument-Less Focus Resolution**: `FocusTracker` dynamically detects whether the active terminal or visible text editor holds focus when invoked without explicit arguments. Users can now rebind `voxcode.toggleDictation` to custom keys (e.g., `F8`, `Pause`, `Ctrl+Shift+Space`) in VS Code's Keyboard Shortcuts UI without shortcuts breaking due to stripped `args`.
- **Automatic Terminal Skip-Shell Registration**: Automatically registers `voxcode.toggleDictation`, `voxcode.startRecording`, `voxcode.stopRecording`, and `voxcode.cancelDictation` in VS Code's `terminal.integrated.commandsToSkipShell`, ensuring terminal shells (PowerShell, bash, zsh) never swallow dictation hotkeys.
- **Dynamic CUDA 12 Runtime Downloader**: Automated PyPI wheel inspection and extraction for NVIDIA CUDA 12 runtime libraries (`cublas64_12.dll`, `cublasLt64_12.dll`), keeping the packaged extension ultra-compact while providing 1-click GPU acceleration setup.

### Changed
- **Packaging Dimension Reduction**: Optimized `.vscodeignore` to exclude local binaries, models, build specs, and large banners, reducing the packaged `.vsix` from >240 MB to **< 1 MB** (>99.5% reduction).
- **Universal Keybinding Scope**: Removed restrictive `when` clause conditions from `voxcode.toggleDictation` so toggling off active dictation works reliably across all editor, terminal, and panel contexts.
- **Secure Token & Lockfile Storage**: Relocated ephemeral daemon lockfiles and authentication tokens from global `%TEMP%` to VS Code's isolated `globalStorageUri`.

### Fixed
- **Terminal Keybinding Unresponsiveness**: Resolved an issue where customizing keyboard shortcuts in VS Code stripped arguments and caused `snapshot()` to return empty targets.
- **Multi-Cursor Replacement Offset**: Fixed cursor displacement math in `TextDispatcher` when dictating over multi-line text selections across multiple carets.
- **Audio Stream Leaks**: Ensured microphone audio streams and background worker threads are explicitly cleaned up in `headless_daemon.py` on unexpected WebSocket client disconnections.
- **Verbal Filler False Positives**: Adjusted speech polisher regex to protect valid technical terms and foreign words (`er`, `ah`) while continuing to remove hesitations (`um`, `uh`).

---

## [0.1.0] - 2026-09-26

### Added
- **100% Offline Speech-to-Text**: Local Whisper transcription powered by CTranslate2 (`faster-whisper`), with zero telemetry and zero external cloud API calls.
- **In-Editor Native Dictation**: Direct insertion via VS Code's `editor.edit()` API with atomic 1-step undo (`Ctrl+Z`) and full multi-cursor support.
- **Terminal AI Agent Prompt Steering**: Voice dictation into integrated terminals for CLI agents (**Antigravity CLI**, **Claude Code**, **Aider**, **OpenHands**).
- **Code vs. Prose Smart Formatting**: Automatic keyword lowercasing and trailing period suppression in programming languages, with natural sentence casing preserved in Markdown and git commits.
- **AST Auto-Spacing**: Preceding character inspection to automatically insert leading spaces before identifiers and keywords.
- **Real-Time Ghost Text Preview**: Streaming italic ghost text decoration displayed at active cursor positions during speech capture.
- **Headless Daemon & Process Supervisor**: Autonomous background daemon lifecycle management with automatic port allocation and watchdog termination.
