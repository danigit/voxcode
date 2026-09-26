"""
VoxCode CUDA 12 Local Speech Engine Subsystem.

Provides ultra-fast local speech-to-text inference powered by faster-whisper / CTranslate2.
Features automatic discovery and registration of NVIDIA CUDA 12 / cuDNN DLL directories
on Windows, synthetic kernel warmup on startup, language locking (en, it, auto),
and explicit on-demand GPU VRAM unloading.
"""

from __future__ import annotations

import gc
import logging
import os
import site
import sys
import time
from typing import Any, Callable, Sequence

import numpy as np

logger = logging.getLogger("voxcode.engine")

# ==============================================================================
# CUDA 12 DLL Bootstrap
# ==============================================================================

_dll_directories_registered: list[str] = []
_dll_handles: list[Any] = []


def bootstrap_cuda_dlls(custom_dir: str | None = None) -> list[str]:
    """
    Discovers and registers NVIDIA CUDA 12 DLL directories into the Windows
    process DLL search path and PATH environment variable.
    Ensures CTranslate2 can load cublas, cudnn, and nvrtc without DLL load errors.
    Searches CUDA Toolkit installations, torch/lib, Conda, system Python site-packages,
    and dedicated VoxCode directories.
    """
    global _dll_directories_registered, _dll_handles

    registered: list[str] = list(_dll_directories_registered) if _dll_directories_registered else []
    seen: set[str] = set(registered)

    def add_dir(d: str | None) -> None:
        if not d or not os.path.isdir(d):
            return
        try:
            abs_d = os.path.abspath(d)
        except Exception:
            return
        if abs_d in seen:
            return
        # Ensure the directory contains at least one DLL
        try:
            entries = os.listdir(abs_d)
            if not any(f.lower().endswith(".dll") for f in entries):
                return
        except Exception:
            return

        seen.add(abs_d)
        registered.append(abs_d)
        if sys.platform == "win32" and hasattr(os, "add_dll_directory"):
            try:
                handle = os.add_dll_directory(abs_d)
                _dll_handles.append(handle)
                logger.info(f"Registered CUDA DLL directory: {abs_d}")
            except Exception as e:
                logger.debug(f"Could not add DLL directory {abs_d}: {e}")

    # Explicit custom directory if provided
    if custom_dir:
        add_dir(custom_dir)
        add_dir(os.path.join(custom_dir, "bin"))

    # 1. Environment variables: CUDA_PATH and versioned CUDA_PATH_V*
    for k, v in list(os.environ.items()):
        if k.upper().startswith("CUDA_PATH") and v and os.path.isdir(v):
            add_dir(os.path.join(v, "bin"))
            add_dir(os.path.join(v, "bin", "crt"))
            add_dir(os.path.join(v, "lib", "x64"))

    # 2. Standard NVIDIA CUDA Toolkit install locations on Windows
    program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
    cuda_base = os.path.join(program_files, "NVIDIA GPU Computing Toolkit", "CUDA")
    if os.path.isdir(cuda_base):
        try:
            for entry in os.listdir(cuda_base):
                sub = os.path.join(cuda_base, entry)
                if os.path.isdir(sub):
                    add_dir(os.path.join(sub, "bin"))
                    add_dir(os.path.join(sub, "lib", "x64"))
        except Exception:
            pass

    # 3. Dedicated VoxCode CUDA locations
    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(sys.executable)
    else:
        exe_dir = os.path.dirname(os.path.abspath(__file__))

    add_dir(os.path.join(exe_dir, "cuda"))
    add_dir(os.path.join(exe_dir, "_internal", "cuda"))
    add_dir(os.path.join(exe_dir, "..", "cuda"))
    add_dir(os.path.join(exe_dir, "..", "bin", "cuda"))

    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        add_dir(os.path.join(local_app_data, "VoxCode", "cuda"))
        add_dir(os.path.join(local_app_data, "Programs", "VoxCode", "cuda"))
    app_data = os.environ.get("APPDATA")
    if app_data:
        add_dir(os.path.join(app_data, "VoxCode", "cuda"))

    # 4. Search PATH environment variable for folders containing cublas or cudnn
    for p in os.environ.get("PATH", "").split(os.pathsep):
        p = p.strip('"').strip()
        if p and os.path.isdir(p):
            try:
                entries = os.listdir(p)
                if any("cublas" in f.lower() or "cudnn" in f.lower() for f in entries):
                    add_dir(p)
            except Exception:
                pass

    # 5. Candidate python site-packages (strictly current virtualenv, sys.prefix, and storage_dir)
    storage_dir = os.environ.get("VOXCODE_STORAGE_DIR")
    if storage_dir:
        add_dir(os.path.join(storage_dir, "cuda"))

    candidate_roots: list[str] = []

    venv_dir = os.environ.get("VIRTUAL_ENV")
    if venv_dir:
        candidate_roots.append(os.path.join(venv_dir, "Lib", "site-packages"))

    candidate_roots.append(os.path.join(sys.prefix, "Lib", "site-packages"))

    try:
        candidate_roots.extend(site.getsitepackages())
    except Exception:
        pass
    try:
        user_site = site.getusersitepackages()
        if user_site:
            candidate_roots.append(user_site)
    except Exception:
        pass

    # Check local virtual environment adjacent to exe_dir
    candidate_roots.append(os.path.join(exe_dir, ".venv", "Lib", "site-packages"))
    candidate_roots.append(os.path.join(exe_dir, "venv", "Lib", "site-packages"))

    for root in candidate_roots:
        if not root or not os.path.isdir(root):
            continue

        # Check nvidia pip packages (cublas, cudnn, etc.)
        nv_dir = os.path.join(root, "nvidia")
        if os.path.isdir(nv_dir):
            for sub in ["cublas", "cudnn", "cuda_nvrtc", "cuda_runtime"]:
                bin_dir = os.path.join(nv_dir, sub, "bin")
                add_dir(bin_dir)

        # Check torch/lib (PyTorch bundles complete CUDA 12 runtime DLLs)
        torch_lib = os.path.join(root, "torch", "lib")
        if os.path.isdir(torch_lib):
            add_dir(torch_lib)

    if registered:
        current_path = os.environ.get("PATH", "")
        paths_to_add = [p for p in registered if p not in current_path]
        if paths_to_add:
            os.environ["PATH"] = ";".join(paths_to_add) + ";" + current_path

    _dll_directories_registered = registered
    logger.info(f"Registered {len(registered)} NVIDIA CUDA DLL paths: {registered}")
    return registered


# Run DLL bootstrap on module import
bootstrap_cuda_dlls()


# ==============================================================================
# Speech Engine Backend Abstraction
# ==============================================================================

class BaseSpeechBackend:
    """Interface for speech-to-text inference backends."""

    def load(self, model_size: str, device: str, compute_type: str) -> None:
        raise NotImplementedError

    def transcribe(
        self,
        audio_data: np.ndarray,
        language: str | None = None,
        beam_size: int = 1,
    ) -> tuple[str, float]:
        raise NotImplementedError

    def unload(self) -> None:
        raise NotImplementedError

    @property
    def is_loaded(self) -> bool:
        raise NotImplementedError


def resolve_local_model_path(model_size_or_path: str, download_root: str | None = None) -> str | None:
    """
    Finds existing local Whisper model weights on disk to guarantee
    instant, zero-network initialization without contacting Hugging Face.
    """
    # 1. Direct path check
    if os.path.isdir(model_size_or_path) and os.path.isfile(os.path.join(model_size_or_path, "model.bin")):
        return os.path.abspath(model_size_or_path)

    model_size = os.path.basename(model_size_or_path)
    candidates: list[str] = []

    # 2. Check download_root directly
    if download_root and os.path.isdir(download_root):
        candidates.append(os.path.join(download_root, model_size))
        candidates.append(os.path.join(download_root, f"faster-whisper-{model_size}"))
        hub_dirs = [
            os.path.join(download_root, f"models--Systran--faster-whisper-{model_size}"),
            os.path.join(download_root, "hub", f"models--Systran--faster-whisper-{model_size}"),
            os.path.join(download_root, f"models--Systran--faster-distil-whisper-{model_size}"),
            os.path.join(download_root, "hub", f"models--Systran--faster-distil-whisper-{model_size}"),
            os.path.join(download_root, f"models--mobiuslabsgmbh--faster-whisper-{model_size}"),
            os.path.join(download_root, "hub", f"models--mobiuslabsgmbh--faster-whisper-{model_size}"),
            os.path.join(download_root, f"models--deepdml--faster-whisper-{model_size}-ct2"),
            os.path.join(download_root, "hub", f"models--deepdml--faster-whisper-{model_size}-ct2"),
            os.path.join(download_root, f"models--deepdml--faster-whisper-{model_size}"),
            os.path.join(download_root, "hub", f"models--deepdml--faster-whisper-{model_size}"),
        ]
        for hub_dir in hub_dirs:
            snap_dir = os.path.join(hub_dir, "snapshots")
            if os.path.isdir(snap_dir):
                try:
                    for entry in os.listdir(snap_dir):
                        candidates.append(os.path.join(snap_dir, entry))
                except Exception:
                    pass

    # 3. Check bundled models directory relative to executable or package
    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(sys.executable)
        candidates.append(os.path.join(exe_dir, "models", model_size))
        candidates.append(os.path.join(exe_dir, "..", "models", model_size))
        candidates.append(os.path.join(exe_dir, "..", "..", "models", model_size))
        if hasattr(sys, "_MEIPASS"):
            candidates.append(os.path.join(sys._MEIPASS, "models", model_size))
    else:
        src_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        repo_root = os.path.dirname(src_root)
        candidates.append(os.path.join(repo_root, "models", model_size))
        candidates.append(os.path.join(src_root, "models", model_size))

    # 4. Check user's standard Hugging Face Hub cache (~/.cache/huggingface/hub)
    user_hf_cache = os.path.expanduser("~/.cache/huggingface/hub")
    if os.path.isdir(user_hf_cache):
        for repo_name in [
            f"models--Systran--faster-whisper-{model_size}",
            f"models--Systran--faster-distil-whisper-{model_size}",
            f"models--mobiuslabsgmbh--faster-whisper-{model_size}",
            f"models--deepdml--faster-whisper-{model_size}-ct2",
            f"models--deepdml--faster-whisper-{model_size}",
        ]:
            snap_dir = os.path.join(user_hf_cache, repo_name, "snapshots")
            if os.path.isdir(snap_dir):
                try:
                    for entry in os.listdir(snap_dir):
                        candidates.append(os.path.join(snap_dir, entry))
                except Exception:
                    pass

    for cand in candidates:
        if os.path.isdir(cand) and os.path.isfile(os.path.join(cand, "model.bin")):
            logger.info(f"Discovered local model for '{model_size}' at: {cand}")
            return os.path.abspath(cand)

    return None


class FasterWhisperBackend(BaseSpeechBackend):
    """Production backend wrapping faster-whisper WhisperModel."""

    def __init__(self, download_root: str | None = None) -> None:
        self._model: Any = None
        self._device: str = "cpu"
        self._compute_type: str = "default"
        self._download_root: str | None = download_root

    def load(
        self,
        model_size: str,
        device: str,
        compute_type: str,
        download_root: str | None = None,
    ) -> None:
        from faster_whisper import WhisperModel

        bootstrap_cuda_dlls()
        root = download_root or self._download_root

        # 1. Search locally first for zero-network execution
        local_path = resolve_local_model_path(model_size, root)
        if local_path:
            logger.info(f"Loading speech engine directly from local model files: {local_path}")
            self._model = WhisperModel(
                local_path,
                device=device,
                compute_type=compute_type,
            )
            self._device = device
            self._compute_type = compute_type
            return

        # 2. Local files not found; download from official repository
        logger.info(f"Model '{model_size}' not found locally. Initiating download...")
        try:
            self._model = WhisperModel(
                model_size,
                device=device,
                compute_type=compute_type,
                download_root=root,
            )
        except Exception as primary_err:
            logger.error(
                f"Failed to load or download Whisper model '{model_size}': {primary_err}"
            )
            raise RuntimeError(
                f"Failed to load or download Whisper model '{model_size}': {primary_err}"
            ) from primary_err

        self._device = device
        self._compute_type = compute_type

    def transcribe(
        self,
        audio_data: np.ndarray,
        language: str | None = None,
        beam_size: int = 1,
    ) -> tuple[str, float]:
        if self._model is None:
            raise RuntimeError("Model is not loaded. Call load() first.")

        # Ensure float32 1D numpy array
        if not isinstance(audio_data, np.ndarray):
            audio_data = np.asarray(audio_data, dtype=np.float32)
        if audio_data.dtype != np.float32:
            audio_data = audio_data.astype(np.float32)
        if audio_data.ndim > 1:
            audio_data = audio_data.squeeze()

        # Treat "auto" or empty string as auto-detection (language=None)
        lang_param = None if (language in (None, "auto", "")) else language

        start = time.perf_counter()
        segments, info = self._model.transcribe(
            audio_data,
            language=lang_param,
            beam_size=beam_size,
            condition_on_previous_text=False,
            temperature=0.0,
        )
        parts = [seg.text for seg in segments]
        text = " ".join(parts).strip()
        elapsed = time.perf_counter() - start
        return text, elapsed

    def unload(self) -> None:
        if self._model is not None:
            del self._model
            self._model = None
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

    @property
    def is_loaded(self) -> bool:
        return self._model is not None


class MockSpeechBackend(BaseSpeechBackend):
    """Deterministic mock backend for testing without downloading ML models."""

    def __init__(
        self,
        transcript: str = "Hello from VoxCode mock speech engine.",
        loaded: bool = True,
    ) -> None:
        self._loaded: bool = loaded
        self._model_size: str = "mock-model"
        self._device: str = "cpu"
        self._compute_type: str = "default"
        self.default_transcript = transcript
        self.transcribe_hook: Callable[[np.ndarray, str | None], str] | None = None
        self.transcribe_delay_s: float = 0.01

    def load(self, model_size: str, device: str, compute_type: str) -> None:
        self._model_size = model_size
        self._device = device
        self._compute_type = compute_type
        self._loaded = True

    def transcribe(
        self,
        audio_data: np.ndarray,
        language: str | None = None,
        beam_size: int = 1,
    ) -> tuple[str, float]:
        if not self._loaded:
            raise RuntimeError("MockSpeechBackend: Model is not loaded.")
        if self.transcribe_delay_s > 0:
            time.sleep(self.transcribe_delay_s)
        if self.transcribe_hook is not None:
            text = self.transcribe_hook(audio_data, language)
        else:
            text = self.default_transcript
        return text, self.transcribe_delay_s

    def unload(self) -> None:
        self._loaded = False

    @property
    def is_loaded(self) -> bool:
        return self._loaded


# ==============================================================================
# Speech Engine Coordinator
# ==============================================================================

class SpeechEngine:
    """
    High-level speech transcription coordinator for VoxCode.
    Handles device fallback (cuda -> cpu), synthetic audio warmup,
    language locking, and performance telemetry.
    """

    def __init__(
        self,
        model_size: str = "distil-large-v3",
        device: str = "cuda",
        compute_type: str = "float16",
        language: str = "en",
        backend: BaseSpeechBackend | None = None,
        download_root: str | None = None,
        auto_load: bool = True,
        auto_warmup: bool = True,
        cuda_dir: str | None = None,
    ) -> None:
        self.model_size = model_size
        self.requested_device = device
        self.cuda_dir = cuda_dir
        # If CUDA is requested with pure int8, automatically promote to float16
        # because CTranslate2 does not support pure int8 on CUDA.
        if device == "cuda" and compute_type == "int8":
            compute_type = "float16"
        self.device = device
        self.requested_compute_type = compute_type
        self.compute_type = compute_type
        self.language = language
        self.download_root = download_root
        self.backend: BaseSpeechBackend = backend or FasterWhisperBackend(download_root=download_root)
        self.last_inference_duration_ms: float = 0.0
        self.device_in_use: str = "none"
        self.compute_type_in_use: str = "none"
        self.cuda_fallback_reason: str | None = None

        if self.cuda_dir:
            bootstrap_cuda_dlls(self.cuda_dir)

        if auto_load:
            self.load_model(auto_warmup=auto_warmup)

    def load_model(self, auto_warmup: bool = True) -> bool:
        """
        Loads the transcription model. If CUDA loading fails, automatically
        falls back to CPU with int8 quantization and records the fallback reason.
        """
        bootstrap_cuda_dlls(self.cuda_dir)


        # Build prioritized list of (device, compute_type) to attempt
        devices_to_try: list[tuple[str, str]] = []
        if self.device == "cuda":
            target_compute = "float16" if self.compute_type == "int8" else self.compute_type
            devices_to_try.append(("cuda", target_compute))
            if target_compute != "float16":
                devices_to_try.append(("cuda", "float16"))
            if target_compute != "int8_float16":
                devices_to_try.append(("cuda", "int8_float16"))
            # Fallback to CPU if CUDA fails
            devices_to_try.append(("cpu", "int8"))
        else:
            devices_to_try.append((self.device, self.compute_type))
            if self.device != "cpu":
                devices_to_try.append(("cpu", "int8"))

        loaded = False
        last_err: Exception | None = None

        for dev, c_type in devices_to_try:
            try:
                logger.info(f"Attempting to load model '{self.model_size}' on {dev} ({c_type})...")
                try:
                    self.backend.load(self.model_size, dev, c_type, download_root=self.download_root)
                except TypeError:
                    self.backend.load(self.model_size, dev, c_type)
                self.device_in_use = dev
                self.compute_type_in_use = c_type
                loaded = True
                logger.info(f"Model successfully loaded on {dev} ({c_type}).")
                break
            except Exception as e:
                last_err = e
                logger.warning(f"Failed loading on {dev} ({c_type}): {e}")

        if not loaded:
            raise RuntimeError(f"Failed to load speech engine model: {last_err}")

        # If user explicitly requested CUDA but engine fell back to CPU:
        if loaded and self.device == "cuda" and self.device_in_use == "cpu":
            self.cuda_fallback_reason = (
                f"NVIDIA CUDA libraries (cublas64_12.dll / cuDNN) not found or unsupported: {last_err}"
            )
            logger.warning(
                f"NOTICE: CUDA was requested, but initialization failed. "
                f"Fell back to CPU ({self.compute_type_in_use}). Reason: {self.cuda_fallback_reason}"
            )

        if auto_warmup:
            self.warmup()

        return True

    def warmup(self, duration_s: float = 0.2) -> float:
        """
        Executes a brief synthetic audio forward pass to eliminate cold-start GPU/CUDA lag.
        If CUDA execution fails during warmup, performs emergency fallback to CPU.
        """
        if not self.backend.is_loaded:
            return 0.0
        try:
            dummy_pcm = np.zeros(int(16000 * duration_s), dtype=np.float32)
            _, elapsed = self.backend.transcribe(dummy_pcm, language="en", beam_size=1)
            logger.info(f"Speech engine warmed up on {self.device_in_use} ({self.compute_type_in_use}) in {elapsed * 1000.0:.1f}ms.")
            return elapsed
        except Exception as e:
            logger.warning(f"Speech engine warmup encountered error on {self.device_in_use}: {e}")
            # If warmup failed on CUDA, GPU kernel execution is non-functional
            if self.device_in_use == "cuda":
                logger.warning("CUDA runtime warmup execution failed. Triggering emergency CPU fallback...")
                self.cuda_fallback_reason = f"CUDA warmup execution failed: {e}"
                try:
                    self.backend.unload()
                    self.backend.load(self.model_size, "cpu", "int8", download_root=self.download_root)
                    self.device_in_use = "cpu"
                    self.compute_type_in_use = "int8"
                    logger.info("Successfully reloaded model on CPU after CUDA warmup failure.")
                except Exception as cpu_err:
                    logger.error(f"CPU fallback after CUDA warmup failure also failed: {cpu_err}")
            return 0.0

    def transcribe(
        self,
        audio_data: np.ndarray | Sequence[float],
        language: str | None = None,
        beam_size: int = 1,
    ) -> str:
        """
        Transcribes audio data (16kHz float32 mono array) into clean text.
        Applies configured language lock unless explicitly overridden.
        """
        if not self.backend.is_loaded:
            raise RuntimeError("SpeechEngine: model is not currently loaded.")

        if not isinstance(audio_data, np.ndarray):
            audio_data = np.asarray(audio_data, dtype=np.float32)

        # Ignore empty audio or audio shorter than 10ms
        if audio_data.size < 160:
            return ""

        effective_lang = language if language is not None else self.language
        if effective_lang == "auto":
            effective_lang = None

        text, elapsed = self.backend.transcribe(audio_data, language=effective_lang, beam_size=beam_size)
        self.last_inference_duration_ms = elapsed * 1000.0
        return text

    def transcribe_partial(
        self,
        audio_data: np.ndarray | Sequence[float],
        language: str | None = None,
    ) -> str:
        """
        Fast greedy inference on partial audio stream for live preview.
        Returns empty string gracefully if model is unloaded or audio too short.
        """
        if not self.backend.is_loaded:
            return ""
        try:
            return self.transcribe(audio_data, language=language, beam_size=1)
        except Exception as e:
            logger.debug(f"Partial transcription error: {e}")
            return ""

    def unload_model(self) -> None:
        """Purges model weights and frees system and GPU memory."""
        self.backend.unload()
        self.device_in_use = "none"
        self.compute_type_in_use = "none"
        logger.info("Speech engine model unloaded and memory cleared.")

    @property
    def is_loaded(self) -> bool:
        return self.backend.is_loaded
