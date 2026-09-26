# Contributing to VoxCode

Thank you for your interest in contributing to VoxCode! We welcome contributions of all kinds: bug reports, documentation improvements, feature suggestions, and code contributions.

## Code of Conduct

This project adheres to the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

---

## Development Setup

### Prerequisites
- **Node.js**: v18.0+ (v20+ recommended)
- **npm**: v9+
- **Python**: v3.10+ (for local speech daemon development)
- **VS Code**: v1.85+

### Getting Started

1. **Clone the repository:**
   ```bash
   git clone https://github.com/danigit/voxcode.git
   cd voxcode
   ```

2. **Install Node.js dependencies:**
   ```bash
   npm install
   ```

3. **Install Python daemon dependencies (for server development):**
   ```bash
   python -m venv .venv
   # On Windows:
   .venv\Scripts\activate
   # On macOS/Linux:
   source .venv/bin/activate

   pip install -r requirements.txt # or: pip install websockets faster-whisper sounddevice numpy pyinstaller
   ```

4. **Compile and build the extension:**
   ```bash
   npm run build
   ```

5. **Run test suite:**
   ```bash
   npm test
   ```

---

## Debugging in VS Code

1. Open the repository root in VS Code.
2. Press <kbd>F5</kbd> (or select **Run and Debug** -> **Launch Extension**).
3. A new **Extension Development Host** window will open with the VoxCode extension active.
4. Set breakpoints in TypeScript files (`src/**/*.ts`) or inspect output in the `VoxCode` output channel.

---

## Submitting Pull Requests

1. **Fork & Branch:** Create a feature branch from `main`:
   ```bash
   git checkout -b feature/my-cool-feature
   ```
2. **Quality Checks:** Before committing, ensure the TypeScript compiles and all tests pass:
   ```bash
   npm run compile
   npm test
   ```
3. **Commit Messages:** Use clear, descriptive commit messages following the Conventional Commits specification:
   - `feat: add whisper model preloading indicator`
   - `fix: prevent premature newline insertion in terminal`
   - `docs: update configuration table`
4. **Push & Open PR:** Push your branch to GitHub and open a Pull Request against `main`. Provide a clear description of the problem solved and any relevant context or screenshots.

---

## Reporting Issues

If you encounter a bug or have a feature request:
- Search existing [GitHub Issues](https://github.com/danigit/voxcode/issues) to avoid duplicates.
- Open a new issue using our issue templates.
- Include your operating system, VS Code version, VoxCode version, and output logs from the `VoxCode` output channel.
