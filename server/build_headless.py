"""
Build script to freeze headless_daemon.py using PyInstaller.

Compiles headless_daemon.py into a standalone CPU-optimized executable:
    dist/voxcode-daemon/voxcode-daemon.exe

Excludes heavy PySide6, Qt, and NVIDIA CUDA dependencies to keep binary size compact.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys

import PyInstaller.__main__


def build_headless(copy_to: str | None = None) -> None:
    root_dir = os.path.dirname(os.path.abspath(__file__))
    entry_script = os.path.join(root_dir, "headless_daemon.py")
    dist_dir = os.path.join(root_dir, "dist")
    work_dir = os.path.join(root_dir, "build", "headless")

    core_data = f"{os.path.join(root_dir, 'core')}{os.pathsep}core"

    args = [
        entry_script,
        "--name=voxcode-daemon",
        "--noconfirm",
        "--clean",
        "--onedir",
        f"--distpath={dist_dir}",
        f"--workpath={work_dir}",
        f"--paths={root_dir}",
        f"--add-data={core_data}",
        # Hidden imports
        "--hidden-import=core",
        "--hidden-import=core.audio",
        "--hidden-import=core.engine",
        "--hidden-import=core.polisher",
        "--hidden-import=ctranslate2",
        "--hidden-import=sounddevice",
        "--hidden-import=numpy",
        "--hidden-import=websockets",
        "--hidden-import=huggingface_hub",
        "--hidden-import=faster_whisper",
        # Exclude UI & heavy GPU dependencies
        "--exclude-module=PySide6",
        "--exclude-module=PySide6.QtCore",
        "--exclude-module=PySide6.QtWidgets",
        "--exclude-module=PySide6.QtGui",
        "--exclude-module=shiboken6",
        "--exclude-module=nvidia",
        "--exclude-module=nvidia_cublas_cu12",
        "--exclude-module=nvidia_cudnn_cu12",
        "--exclude-module=nvidia_cuda_nvrtc_cu12",
        "--exclude-module=torch",
        "--exclude-module=tkinter",
        "--exclude-module=matplotlib",
    ]

    print(f"[Build] Freezing {entry_script} with PyInstaller...")
    PyInstaller.__main__.run(args)

    daemon_dir = os.path.join(dist_dir, "voxcode-daemon")
    exe_name = "voxcode-daemon.exe" if sys.platform == "win32" else "voxcode-daemon"
    exe_path = os.path.join(daemon_dir, exe_name)

    if os.path.exists(exe_path):
        print(f"[Build] Successfully built: {exe_path}")

        if copy_to:
            dest = os.path.abspath(copy_to)
            os.makedirs(dest, exist_ok=True)
            print(f"[Build] Copying binary distribution to: {dest}")
            shutil.copytree(daemon_dir, dest, dirs_exist_ok=True)
            print(f"[Build] Copied to {dest} successfully.")
    else:
        print(f"[Build Error] Expected executable not found at: {exe_path}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Freeze VoxCode Headless Daemon")
    parser.add_argument(
        "--copy-to",
        default=None,
        help="Optional destination directory to copy the frozen daemon into (e.g. ./bin/win32-x64)",
    )
    cli_args = parser.parse_args()
    build_headless(copy_to=cli_args.copy_to)
