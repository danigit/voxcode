"""
VoxCode Gated WASAPI Audio Pipeline Subsystem.

Provides low-latency 16kHz mono float32 audio capture via Windows Audio Session API
(WASAPI) with automatic sample-rate conversion (sd.WasapiSettings(auto_convert=True)).
Enforces a strict zero-idle lifecycle to keep Bluetooth headsets in high-definition
stereo A2DP mode when not dictating. Computes real-time 30ms AC-coupled RMS power
normalized to [0.0, 1.0] for the floating HUD waveform glow. Appends a 150ms trailing
audio padding buffer upon hotkey release to eliminate word-final phoneme clipping, and
filters accidental triggers under 150ms.
"""

from __future__ import annotations

import math
import logging
import threading
from abc import ABC, abstractmethod
from contextlib import contextmanager
from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable, Generator, Sequence

logger = logging.getLogger("voxcode.audio")

# ==============================================================================
# PySide6 Fallback (Zero-Dependency for Headless / Test Runner)
# ==============================================================================

try:
    from PySide6.QtCore import QObject
    HAS_PYSIDE6 = True
except ImportError:
    HAS_PYSIDE6 = False

    class QObject:  # type: ignore[no-redef]
        """Stub QObject for headless runtime."""

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass


class _BoundSignal:
    """Lightweight pure-Python bound signal mimicking PySide6.QtCore.Signal with direct thread dispatch."""

    def __init__(self, types: tuple[Any, ...]) -> None:
        self._types = types
        self._slots: list[Callable[..., Any]] = []
        self.emit_count: int = 0

    def connect(self, slot: Callable[..., Any]) -> None:
        if slot not in self._slots:
            self._slots.append(slot)

    def disconnect(self, slot: Callable[..., Any] | None = None) -> None:
        if slot is None:
            self._slots.clear()
        elif slot in self._slots:
            self._slots.remove(slot)

    def emit(self, *args: Any) -> None:
        self.emit_count += 1
        for slot in list(self._slots):
            try:
                slot(*args)
            except Exception as e:
                logger.debug(f"Exception in signal slot: {e}")


class Signal:  # type: ignore[no-redef]
    """Descriptor returning a per-instance bound signal."""

    def __init__(self, *types: Any) -> None:
        self._types = types
        self._instances: dict[int, _BoundSignal] = {}

    def __get__(self, instance: Any, owner: Any = None) -> Any:
        if instance is None:
            return self
        obj_id = id(instance)
        if obj_id not in self._instances:
            self._instances[obj_id] = _BoundSignal(self._types)
        return self._instances[obj_id]


# ==============================================================================
# NumPy Fallback (Zero-Dependency for Python 3.14 Test Sandbox)
# ==============================================================================

try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False

    class _ArrayFlags:
        def __init__(self, c_contiguous: bool = True) -> None:
            self.c_contiguous = c_contiguous

    class MockNDArray:
        """
        Pure-Python fallback for 1D/2D float32 arrays implementing identical
        attributes, indexing, and vector math as numpy.ndarray.
        """

        def __init__(self, data: Any, dtype: str = "float32") -> None:
            self.dtype = dtype
            self.flags = _ArrayFlags(c_contiguous=True)
            if isinstance(data, MockNDArray):
                self._data = list(data._data)
                self.shape = data.shape
            elif isinstance(data, (list, tuple)):
                if len(data) > 0 and isinstance(data[0], (list, tuple, MockNDArray)):
                    rows = [list(r) for r in data]
                    self._data = [float(x) for r in rows for x in r]
                    self.shape = (len(rows), len(rows[0]))
                else:
                    self._data = [float(x) for x in data]
                    self.shape = (len(self._data),)
            else:
                self._data = [float(data)]
                self.shape = (1,)

        @property
        def ndim(self) -> int:
            return len(self.shape)

        @property
        def size(self) -> int:
            return len(self._data)

        def flatten(self) -> MockNDArray:
            return MockNDArray(list(self._data), dtype=self.dtype)

        def reshape(self, *shape: Any) -> MockNDArray:
            if len(shape) == 1 and shape[0] == -1:
                return self.flatten()
            return self

        def astype(self, dtype: Any, copy: bool = True) -> MockNDArray:
            return MockNDArray(self._data, dtype=str(dtype))

        def copy(self) -> MockNDArray:
            return MockNDArray(self._data, dtype=self.dtype)

        def tolist(self) -> list[float]:
            return list(self._data)

        def __len__(self) -> int:
            return self.shape[0]

        def __getitem__(self, idx: Any) -> Any:
            if isinstance(idx, slice):
                return MockNDArray(self._data[idx], dtype=self.dtype)
            return self._data[idx]

        def __setitem__(self, idx: int, val: Any) -> None:
            self._data[idx] = float(val)

        def __iter__(self) -> Any:
            return iter(self._data)

        def __sub__(self, other: Any) -> MockNDArray:
            if isinstance(other, (int, float)):
                return MockNDArray([x - other for x in self._data], dtype=self.dtype)
            return MockNDArray([x - y for x, y in zip(self._data, other)], dtype=self.dtype)

        def __isub__(self, other: Any) -> MockNDArray:
            if isinstance(other, (int, float)):
                self._data = [x - other for x in self._data]
            else:
                self._data = [x - y for x, y in zip(self._data, other)]
            return self

        def __add__(self, other: Any) -> MockNDArray:
            if isinstance(other, (int, float)):
                return MockNDArray([x + other for x in self._data], dtype=self.dtype)
            return MockNDArray([x + y for x, y in zip(self._data, other)], dtype=self.dtype)

        def __mul__(self, other: Any) -> MockNDArray:
            if isinstance(other, (int, float)):
                return MockNDArray([x * other for x in self._data], dtype=self.dtype)
            return MockNDArray([x * y for x, y in zip(self._data, other)], dtype=self.dtype)

        def __truediv__(self, other: Any) -> MockNDArray:
            if isinstance(other, (int, float)):
                return MockNDArray([x / other for x in self._data], dtype=self.dtype)
            return MockNDArray([x / y for x, y in zip(self._data, other)], dtype=self.dtype)

        def __pow__(self, other: Any) -> MockNDArray:
            return MockNDArray([x ** other for x in self._data], dtype=self.dtype)

        def __repr__(self) -> str:
            preview = self._data[:5]
            return f"array({preview}..., shape={self.shape}, dtype={self.dtype})"

    class _MockNumpyModule:
        float32 = "float32"
        ndarray = MockNDArray
        pi = math.pi

        @staticmethod
        def array(data: Any, dtype: Any = "float32") -> MockNDArray:
            if isinstance(data, MockNDArray) and str(data.dtype) == str(dtype):
                return data
            return MockNDArray(data, dtype=str(dtype))

        @staticmethod
        def zeros(shape: int | tuple[int, ...], dtype: Any = "float32") -> MockNDArray:
            if isinstance(shape, int):
                return MockNDArray([0.0] * shape, dtype=str(dtype))
            count = 1
            for s in shape:
                count *= s
            res = MockNDArray([0.0] * count, dtype=str(dtype))
            res.shape = shape
            return res

        @staticmethod
        def empty(shape: int | tuple[int, ...], dtype: Any = "float32") -> MockNDArray:
            return _MockNumpyModule.zeros(shape, dtype=dtype)

        @staticmethod
        def full(shape: int | tuple[int, ...], val: Any, dtype: Any = "float32") -> MockNDArray:
            if isinstance(shape, int):
                return MockNDArray([float(val)] * shape, dtype=str(dtype))
            count = 1
            for s in shape:
                count *= s
            res = MockNDArray([float(val)] * count, dtype=str(dtype))
            res.shape = shape
            return res

        @staticmethod
        def concatenate(arrays: Sequence[Any], axis: int = 0) -> MockNDArray:
            flat_all: list[float] = []
            for a in arrays:
                if isinstance(a, MockNDArray):
                    flat_all.extend(a._data)
                elif isinstance(a, (list, tuple)):
                    flat_all.extend(float(x) for x in a)
            return MockNDArray(flat_all)

        @staticmethod
        def ascontiguousarray(a: Any, dtype: Any = "float32") -> MockNDArray:
            if isinstance(a, MockNDArray) and a.ndim == 1 and str(a.dtype) == str(dtype) and a.flags.c_contiguous:
                return a
            return _MockNumpyModule.array(a, dtype=dtype)

        @staticmethod
        def std(a: Any) -> float:
            data = a._data if isinstance(a, MockNDArray) else list(a)
            if not data:
                return 0.0
            m = sum(data) / len(data)
            v = sum((x - m) ** 2 for x in data) / len(data)
            return math.sqrt(v)

        @staticmethod
        def mean(a: Any) -> float:
            data = a._data if isinstance(a, MockNDArray) else list(a)
            if not data:
                return 0.0
            return sum(data) / len(data)

        @staticmethod
        def clip(a: Any, a_min: float, a_max: float, out: Any = None) -> Any:
            target = out if out is not None else a
            if isinstance(target, MockNDArray):
                src = a._data if isinstance(a, MockNDArray) else list(a)
                target._data = [min(a_max, max(a_min, x)) for x in src]
                return target
            if isinstance(a, (int, float)):
                return min(a_max, max(a_min, float(a)))
            if isinstance(a, (list, tuple)):
                return [min(a_max, max(a_min, x)) for x in a]
            return a

        @staticmethod
        def isfinite(a: Any) -> Any:
            if isinstance(a, MockNDArray):
                return [math.isfinite(x) for x in a._data]
            if isinstance(a, (list, tuple)):
                return [math.isfinite(x) for x in a]
            return math.isfinite(a)

        @staticmethod
        def all(a: Any) -> bool:
            if isinstance(a, MockNDArray):
                return all(bool(x) for x in a._data)
            if isinstance(a, (list, tuple)):
                return all(bool(x) for x in a)
            return bool(a)

        @staticmethod
        def nan_to_num(a: Any, nan: float = 0.0, posinf: float = 0.0, neginf: float = 0.0) -> Any:
            if isinstance(a, (int, float)):
                if math.isnan(a):
                    return nan
                if math.isinf(a):
                    return posinf if a > 0 else neginf
                return a
            data = a._data if isinstance(a, MockNDArray) else list(a)
            out: list[float] = []
            for x in data:
                if math.isnan(x):
                    out.append(nan)
                elif math.isinf(x):
                    out.append(posinf if x > 0 else neginf)
                else:
                    out.append(x)
            return MockNDArray(out)

        @staticmethod
        def sin(x: Any) -> Any:
            if isinstance(x, (int, float)):
                return math.sin(x)
            if isinstance(x, MockNDArray):
                return MockNDArray([math.sin(v) for v in x._data])
            return [math.sin(v) for v in x]

        @staticmethod
        def sqrt(x: Any) -> Any:
            if isinstance(x, (int, float)):
                return math.sqrt(x)
            if isinstance(x, MockNDArray):
                return MockNDArray([math.sqrt(v) for v in x._data])
            return [math.sqrt(v) for v in x]

        @staticmethod
        def log10(x: Any) -> Any:
            if isinstance(x, (int, float)):
                return math.log10(x)
            if isinstance(x, MockNDArray):
                return MockNDArray([math.log10(v) for v in x._data])
            return [math.log10(v) for v in x]

        @staticmethod
        def power(x: Any, y: Any) -> Any:
            if isinstance(x, (int, float)):
                return x ** y
            if isinstance(x, MockNDArray):
                return MockNDArray([v ** y for v in x._data])
            return [v ** y for v in x]

    np = _MockNumpyModule()  # type: ignore[assignment]


# ==============================================================================
# sounddevice Optional Import
# ==============================================================================

try:
    import sounddevice as sd  # type: ignore[import-untyped]
    HAS_SOUNDDEVICE = True
except ImportError:
    HAS_SOUNDDEVICE = False


# ==============================================================================
# Constants & Audio Specifications
# ==============================================================================

SAMPLE_RATE: int = 16000                                           # Standard input rate for faster-whisper
CHANNELS: int = 1                                                 # Mono
DTYPE: str = "float32"                                            # IEEE 754 float32 PCM [-1.0, 1.0]
BLOCK_SIZE_MS: int = 30                                           # 30ms RMS power chunk cadence
BLOCK_SIZE_SAMPLES: int = int(SAMPLE_RATE * (BLOCK_SIZE_MS / 1000.0))  # 480 samples
TRAILING_PADDING_MS: int = 150                                    # 150ms trailing buffer to prevent phoneme clipping
TRAILING_PADDING_SAMPLES: int = int(SAMPLE_RATE * (TRAILING_PADDING_MS / 1000.0))  # 2400 samples
MIN_RECORDING_MS: int = 150                                       # Accidental hotkey tap filter
MIN_RECORDING_SAMPLES: int = int(SAMPLE_RATE * (MIN_RECORDING_MS / 1000.0))  # 2400 samples


# ==============================================================================
# Enums, Dataclasses & Custom Exceptions
# ==============================================================================

class AudioState(Enum):
    """Finite state machine states for audio capture lifecycle."""
    IDLE = "IDLE"
    RECORDING = "RECORDING"
    STOPPING = "STOPPING"
    PROCESSING = "PROCESSING"
    CANCELLED = "CANCELLED"


@dataclass(frozen=True)
class AudioDeviceInfo:
    """Immutable descriptor for an audio input endpoint."""
    index: int
    name: str
    host_api: str
    host_api_index: int
    max_input_channels: int
    default_samplerate: float
    is_default_input: bool
    is_wasapi: bool


class AudioCaptureError(Exception):
    """Raised when an audio stream fails to open or encounters fatal driver errors."""
    pass


# ==============================================================================
# Backend Abstraction (ABC, SoundDeviceBackend, MockAudioBackend)
# ==============================================================================

class AudioStreamInterface(ABC):
    """Abstract interface representing an active or closed input stream."""

    @abstractmethod
    def start(self) -> None:
        """Starts capturing audio."""

    @abstractmethod
    def stop(self) -> None:
        """Stops capturing audio."""

    @abstractmethod
    def close(self) -> None:
        """Closes stream and releases underlying OS audio endpoints."""

    @property
    @abstractmethod
    def is_active(self) -> bool:
        """Returns True if the stream is actively capturing."""


class AudioBackend(ABC):
    """Abstract driver interface for audio hardware enumeration and stream creation."""

    @abstractmethod
    def open_input_stream(
        self,
        samplerate: int,
        channels: int,
        dtype: str,
        blocksize: int,
        device: int | None,
        callback: Callable[[Any, int, Any, Any], None],
    ) -> AudioStreamInterface:
        """Opens an audio input stream."""

    @abstractmethod
    def query_devices(self, device: int | None = None) -> list[dict[str, Any]] | dict[str, Any]:
        """Queries PortAudio / driver device records."""

    @abstractmethod
    def query_hostapis(self, index: int | None = None) -> list[dict[str, Any]] | dict[str, Any]:
        """Queries host API descriptors."""

    @abstractmethod
    def get_default_wasapi_device(self) -> int | None:
        """Resolves the system default WASAPI input device index."""

    @abstractmethod
    def get_device_info(self, index: int) -> AudioDeviceInfo:
        """Retrieves structured AudioDeviceInfo for a given device index."""


class _SoundDeviceStreamWrapper(AudioStreamInterface):
    """Wraps a live sounddevice.InputStream to conform to AudioStreamInterface."""

    def __init__(self, stream: Any) -> None:
        self._stream = stream

    def start(self) -> None:
        self._stream.start()

    def stop(self) -> None:
        self._stream.stop()

    def close(self) -> None:
        self._stream.close()

    @property
    def is_active(self) -> bool:
        return bool(self._stream.active)


class SoundDeviceBackend(AudioBackend):
    """
    Production audio backend utilizing sounddevice with Windows WASAPI auto-convert.
    Enforces sd.WasapiSettings(auto_convert=True) to avoid PaErrorCode -9997.
    """

    def __init__(self) -> None:
        if not HAS_SOUNDDEVICE:
            logger.warning("sounddevice module is not installed; SoundDeviceBackend will fail on stream open.")

    def query_devices(self, device: int | None = None) -> list[dict[str, Any]] | dict[str, Any]:
        if not HAS_SOUNDDEVICE:
            return [] if device is None else {}
        return sd.query_devices(device)

    def query_hostapis(self, index: int | None = None) -> list[dict[str, Any]] | dict[str, Any]:
        if not HAS_SOUNDDEVICE:
            return [] if index is None else {}
        return sd.query_hostapis(index)

    def get_default_wasapi_device(self) -> int | None:
        if not HAS_SOUNDDEVICE:
            return None
        try:
            hostapis = sd.query_hostapis()
            wasapi_index: int | None = None
            for idx, api in enumerate(hostapis):
                if "WASAPI" in api.get("name", "").upper():
                    wasapi_index = idx
                    default_dev = api.get("default_input_device", -1)
                    if default_dev >= 0:
                        return int(default_dev)
                    break

            # If default_input_device not specified in hostapi, find first WASAPI device with input
            if wasapi_index is not None:
                devices = sd.query_devices()
                for dev_idx, dev in enumerate(devices):
                    if dev.get("hostapi") == wasapi_index and dev.get("max_input_channels", 0) > 0:
                        return dev_idx
        except Exception as e:
            logger.warning(f"Failed to query WASAPI host API: {e}")

        return None

    def get_device_info(self, index: int) -> AudioDeviceInfo:
        if not HAS_SOUNDDEVICE:
            raise AudioCaptureError("sounddevice is not available")
        dev = sd.query_devices(index)
        hostapis = sd.query_hostapis()
        host_api_idx = dev.get("hostapi", 0)
        host_api_name = hostapis[host_api_idx].get("name", "Unknown") if host_api_idx < len(hostapis) else "Unknown"
        is_wasapi = "WASAPI" in host_api_name.upper()
        return AudioDeviceInfo(
            index=index,
            name=dev.get("name", f"Device {index}"),
            host_api=host_api_name,
            host_api_index=host_api_idx,
            max_input_channels=dev.get("max_input_channels", 0),
            default_samplerate=float(dev.get("default_samplerate", 44100.0)),
            is_default_input=bool(index == sd.default.device[0]),
            is_wasapi=is_wasapi,
        )

    def open_input_stream(
        self,
        samplerate: int,
        channels: int,
        dtype: str,
        blocksize: int,
        device: int | None,
        callback: Callable[[Any, int, Any, Any], None],
    ) -> AudioStreamInterface:
        if not HAS_SOUNDDEVICE:
            raise AudioCaptureError("sounddevice library is not installed")

        target_device = device
        if target_device is None:
            target_device = self.get_default_wasapi_device()

        extra_settings: Any = None
        if target_device is not None:
            try:
                dev = sd.query_devices(target_device)
                hostapis = sd.query_hostapis()
                h_idx = dev.get("hostapi", 0)
                if h_idx < len(hostapis) and "WASAPI" in hostapis[h_idx].get("name", "").upper():
                    extra_settings = sd.WasapiSettings(auto_convert=True)
            except Exception as e:
                logger.debug(f"Could not apply WasapiSettings: {e}")

        # Tier 1: Target WASAPI device with WasapiSettings(auto_convert=True)
        try:
            stream = sd.InputStream(
                samplerate=samplerate,
                channels=channels,
                dtype=dtype,
                blocksize=blocksize,
                device=target_device,
                callback=callback,
                extra_settings=extra_settings,
            )
            return _SoundDeviceStreamWrapper(stream)
        except Exception as e1:
            logger.warning(f"Failed to open primary audio stream (device={target_device}): {e1}")

        # Tier 2: Target device without extra_settings (standard audio driver)
        if extra_settings is not None:
            try:
                stream = sd.InputStream(
                    samplerate=samplerate,
                    channels=channels,
                    dtype=dtype,
                    blocksize=blocksize,
                    device=target_device,
                    callback=callback,
                )
                return _SoundDeviceStreamWrapper(stream)
            except Exception as e2:
                logger.warning(f"Failed to open audio stream without extra settings (device={target_device}): {e2}")

        # Tier 3: System default audio input device (device=None)
        if target_device is not None:
            try:
                stream = sd.InputStream(
                    samplerate=samplerate,
                    channels=channels,
                    dtype=dtype,
                    blocksize=blocksize,
                    device=None,
                    callback=callback,
                )
                return _SoundDeviceStreamWrapper(stream)
            except Exception as e3:
                logger.warning(f"Failed to open fallback default system audio stream: {e3}")

        raise AudioCaptureError("No audio input device available. Please verify your microphone is connected and accessible.")


class MockAudioStream(AudioStreamInterface):
    """Simulates a sounddevice / WASAPI InputStream for deterministic unit testing."""

    def __init__(
        self,
        samplerate: int,
        channels: int,
        dtype: str,
        blocksize: int,
        callback: Callable[[Any, int, Any, Any], None],
        device: int | None = None,
    ) -> None:
        self.samplerate = samplerate
        self.channels = channels
        self.dtype = dtype
        self.blocksize = blocksize
        self.callback = callback
        self.device = device

        self._is_active: bool = False
        self.is_closed: bool = False
        self.frames_pushed: int = 0
        self.start_calls: int = 0
        self.stop_calls: int = 0
        self.close_calls: int = 0

    @property
    def is_active(self) -> bool:
        return self._is_active

    def start(self) -> None:
        if self.is_closed:
            raise RuntimeError("Cannot start a closed stream")
        self._is_active = True
        self.start_calls += 1

    def stop(self) -> None:
        self._is_active = False
        self.stop_calls += 1

    def close(self) -> None:
        self._is_active = False
        self.is_closed = True
        self.close_calls += 1

    def push_pcm_frame(self, pcm_chunk: Any, status: int = 0) -> None:
        """Injects a PCM frame into the audio callback as if delivered by PortAudio."""
        if not self._is_active or self.is_closed:
            return
        frame_len = len(pcm_chunk)
        self.frames_pushed += frame_len
        self.callback(pcm_chunk, frame_len, None, status)


class MockAudioBackend(AudioBackend):
    """Mock audio driver maintaining stream registry and deterministic device simulation."""

    def __init__(self) -> None:
        self.streams: list[MockAudioStream] = []
        self.default_device_index: int = 1
        self.devices: list[dict[str, Any]] = [
            {"index": 0, "name": "Default Output", "hostapi": 0, "max_input_channels": 0, "default_samplerate": 48000.0},
            {"index": 1, "name": "Trust GXT 232 Microphone", "hostapi": 2, "max_input_channels": 1, "default_samplerate": 48000.0},
            {"index": 2, "name": "USB Audio Device", "hostapi": 2, "max_input_channels": 2, "default_samplerate": 44100.0},
        ]
        self.hostapis: list[dict[str, Any]] = [
            {"index": 0, "name": "MME", "default_input_device": 0, "default_output_device": 0},
            {"index": 1, "name": "Windows DirectSound", "default_input_device": 0, "default_output_device": 0},
            {"index": 2, "name": "Windows WASAPI", "default_input_device": 1, "default_output_device": 0},
        ]
        self.should_fail_open: bool = False
        self.open_failure_exception: Exception | None = None

    @property
    def active_stream_count(self) -> int:
        return sum(1 for s in self.streams if s.is_active and not s.is_closed)

    @property
    def total_stream_count(self) -> int:
        return sum(1 for s in self.streams if not s.is_closed)

    def query_devices(self, device: int | None = None) -> list[dict[str, Any]] | dict[str, Any]:
        if device is None:
            return list(self.devices)
        for d in self.devices:
            if d["index"] == device:
                return dict(d)
        raise ValueError(f"Invalid device index {device}")

    def query_hostapis(self, index: int | None = None) -> list[dict[str, Any]] | dict[str, Any]:
        if index is None:
            return list(self.hostapis)
        for h in self.hostapis:
            if h["index"] == index:
                return dict(h)
        raise ValueError(f"Invalid hostapi index {index}")

    def get_default_wasapi_device(self) -> int | None:
        return self.default_device_index

    def get_device_info(self, index: int) -> AudioDeviceInfo:
        dev = self.query_devices(index)
        assert isinstance(dev, dict)
        host_api_name = "Windows WASAPI" if dev.get("hostapi") == 2 else "MME"
        return AudioDeviceInfo(
            index=index,
            name=str(dev.get("name", f"Device {index}")),
            host_api=host_api_name,
            host_api_index=int(dev.get("hostapi", 0)),
            max_input_channels=int(dev.get("max_input_channels", 0)),
            default_samplerate=float(dev.get("default_samplerate", 48000.0)),
            is_default_input=bool(index == self.default_device_index),
            is_wasapi=bool(dev.get("hostapi") == 2),
        )

    def open_input_stream(
        self,
        samplerate: int,
        channels: int,
        dtype: str,
        blocksize: int,
        device: int | None,
        callback: Callable[[Any, int, Any, Any], None],
    ) -> MockAudioStream:
        if self.should_fail_open:
            exc = self.open_failure_exception or AudioCaptureError("WASAPI Device Unavailable")
            raise exc

        stream = MockAudioStream(samplerate, channels, dtype, blocksize, callback, device)
        self.streams.append(stream)
        return stream

    create_input_stream = open_input_stream


# Global Backend Registry
_global_backend: AudioBackend | None = None


def get_audio_backend() -> AudioBackend:
    """Returns the active audio backend (SoundDeviceBackend or MockAudioBackend)."""
    global _global_backend
    if _global_backend is not None:
        return _global_backend
    if HAS_SOUNDDEVICE:
        return SoundDeviceBackend()
    return MockAudioBackend()


def set_audio_backend(backend: AudioBackend) -> None:
    """Sets the active global audio backend."""
    global _global_backend
    _global_backend = backend


def reset_audio_backend() -> None:
    """Resets active global audio backend to default detection."""
    global _global_backend
    _global_backend = None


@contextmanager
def use_mock_audio_backend(mock: MockAudioBackend | None = None) -> Generator[MockAudioBackend, None, None]:
    """Context manager activating an isolated MockAudioBackend."""
    global _global_backend
    previous = _global_backend
    mock_instance = mock if mock is not None else MockAudioBackend()
    _global_backend = mock_instance
    try:
        yield mock_instance
    finally:
        _global_backend = previous


# ==============================================================================
# Signal Processing & Mathematics
# ==============================================================================

def compute_ac_rms(chunk: Any) -> float:
    """
    Computes AC-coupled Root-Mean-Square power (standard deviation) of an audio chunk.
    Rejects static DC bias from USB microphones to prevent false UI pulsing in silence.
    """
    if chunk is None:
        return 0.0
    if not isinstance(chunk, np.ndarray):
        chunk = np.array(chunk, dtype=np.float32)
    if chunk.size == 0:
        return 0.0

    # Sanitize non-finite values (driver disconnect / NaN guard)
    if not np.all(np.isfinite(chunk)):
        chunk = np.nan_to_num(chunk, nan=0.0, posinf=0.0, neginf=0.0)

    # AC-coupled RMS equals population standard deviation
    ac_rms = float(np.std(chunk))
    if ac_rms < 1e-6:
        return 0.0
    return max(0.0, ac_rms)


compute_rms = compute_ac_rms  # Convenience alias


def normalize_rms(
    rms: float,
    min_db: float = -50.0,
    max_db: float = -10.0,
    gamma: float = 1.2,
) -> float:
    """
    Normalizes raw RMS energy to [0.0, 1.0] using logarithmic dBFS scaling.
    Levels below min_db map strictly to 0.0 (ambient noise suppression).
    Levels at or above max_db clamp to 1.0 (vocal peak ceiling).
    Intermediate values are shaped with gamma curve for dynamic visual glow.
    """
    if rms <= 1e-5:
        return 0.0

    db = 20.0 * np.log10(rms)
    if db <= min_db + 1e-4:
        return 0.0
    if db >= max_db - 1e-3:
        return 1.0

    norm = (db - min_db) / (max_db - min_db)
    if gamma != 1.0:
        norm = float(np.power(norm, gamma))

    return float(np.clip(norm, 0.0, 1.0))


def format_audio_for_whisper(chunks: Sequence[Any]) -> np.ndarray:
    """
    Concatenates and formats collected audio chunks into a single contiguous
    np.ndarray (dtype=float32, shape=(N,), 16kHz mono) ready for faster-whisper.
    Applies DC offset removal, [-1.0, 1.0] hard-clipping, and NaN sanitization.
    """
    if not chunks:
        return np.empty(0, dtype=np.float32)

    arr_chunks = [c if isinstance(c, np.ndarray) else np.array(c, dtype=np.float32) for c in chunks]
    audio = np.concatenate(arr_chunks, axis=0)

    if audio.ndim > 1:
        audio = audio.flatten()

    if str(audio.dtype) != "float32":
        audio = audio.astype(np.float32)

    # Sanitize non-finite values
    if not np.all(np.isfinite(audio)):
        audio = np.nan_to_num(audio, nan=0.0, posinf=1.0, neginf=-1.0)

    # Remove static DC offset across entire recording
    if audio.size > 0:
        dc_bias = np.mean(audio)
        audio -= dc_bias

    # Guard against hard clipping exceeding [-1.0, 1.0]
    np.clip(audio, -1.0, 1.0, out=audio)

    # Enforce C-contiguous 1D memory layout
    return np.ascontiguousarray(audio, dtype=np.float32)


class SampleAccumulator:
    """Buffers arbitrary hardware frame sizes and emits exact 30ms (480-sample) chunks."""

    def __init__(self, chunk_size: int = BLOCK_SIZE_SAMPLES) -> None:
        self.chunk_size = chunk_size
        self._buffer: list[np.ndarray] = []
        self._buffered_samples: int = 0

    def feed(self, data: Any) -> list[np.ndarray]:
        """Ingests incoming audio frames and returns complete 480-sample chunks."""
        if not isinstance(data, np.ndarray):
            data = np.array(data, dtype=np.float32)
        if data.size == 0:
            return []

        flat = data.flatten().astype(np.float32, copy=False)
        self._buffer.append(flat)
        self._buffered_samples += flat.size

        chunks: list[np.ndarray] = []
        while self._buffered_samples >= self.chunk_size:
            merged = np.concatenate(self._buffer, axis=0)
            chunk = merged[: self.chunk_size]
            remaining = merged[self.chunk_size :]

            chunks.append(chunk)
            self._buffer = [remaining] if remaining.size > 0 else []
            self._buffered_samples = remaining.size

        return chunks

    def flush(self) -> np.ndarray:
        """Returns and clears all remaining buffered samples."""
        if not self._buffer:
            return np.empty(0, dtype=np.float32)
        merged = np.concatenate(self._buffer, axis=0)
        self._buffer.clear()
        self._buffered_samples = 0
        return merged


# ==============================================================================
# AudioProcessor Engine (Pure NumPy / Algorithmic)
# ==============================================================================

class AudioProcessor:
    """
    Pure algorithmic signal processing engine for VoxCode.
    Zero sounddevice or GUI dependencies. Manages AC-coupled RMS calculation,
    150ms trailing buffer countdown, <150ms duration filter, and Whisper formatting.
    """

    SAMPLE_RATE: int = SAMPLE_RATE
    CHUNK_SAMPLES: int = BLOCK_SIZE_SAMPLES         # 480 samples (30ms)
    TRAILING_SAMPLES: int = TRAILING_PADDING_SAMPLES  # 2400 samples (150ms)
    MIN_RECORD_SAMPLES: int = MIN_RECORDING_SAMPLES  # 2400 samples (150ms)

    def __init__(
        self,
        min_db: float = -50.0,
        max_db: float = -10.0,
        gamma: float = 1.2,
    ) -> None:
        self.min_db = min_db
        self.max_db = max_db
        self.gamma = gamma

        self._state = AudioState.IDLE
        self._active_chunks: list[np.ndarray] = []
        self._trailing_chunks: list[np.ndarray] = []
        self._active_sample_count: int = 0
        self._trailing_samples_collected: int = 0
        self._accumulator = SampleAccumulator(self.CHUNK_SAMPLES)

    @property
    def state(self) -> AudioState:
        return self._state

    def reset(self) -> None:
        """Resets all internal chunk buffers and restores IDLE state."""
        self._state = AudioState.IDLE
        self._active_chunks.clear()
        self._trailing_chunks.clear()
        self._active_sample_count = 0
        self._trailing_samples_collected = 0
        self._accumulator = SampleAccumulator(self.CHUNK_SAMPLES)

    def start(self) -> None:
        """Starts recording session."""
        self.reset()
        self._state = AudioState.RECORDING

    def stop(self) -> bool:
        """
        Signals intent to stop active recording.
        Returns False if active recording < 150ms (discarded as accidental tap).
        Returns True if proceeding to capture 150ms trailing buffer in STOPPING state.
        """
        if self._state != AudioState.RECORDING:
            return False

        # Minimum duration filter (< 150ms active samples)
        if self._active_sample_count < self.MIN_RECORD_SAMPLES:
            self.reset()
            return False

        self._state = AudioState.STOPPING
        self._trailing_samples_collected = 0
        return True

    def cancel(self) -> None:
        """Immediately discards all audio buffers and transitions to IDLE."""
        self.reset()

    def process_incoming_pcm(self, data: Any) -> tuple[list[float], bool]:
        """
        Ingests arbitrary-length float32 PCM data from audio callback.

        Returns:
            (rms_values, trailing_finished):
                rms_values: List of normalized [0.0, 1.0] floats (one per 480 samples).
                trailing_finished: True if the 150ms trailing buffer has completed.
        """
        if self._state not in (AudioState.RECORDING, AudioState.STOPPING):
            return [], False

        if not isinstance(data, np.ndarray):
            data = np.array(data, dtype=np.float32)

        flat = data.flatten().astype(np.float32, copy=False)
        if flat.size == 0:
            return [], False

        trailing_finished = False

        if self._state == AudioState.RECORDING:
            self._active_chunks.append(flat)
            self._active_sample_count += flat.size

        elif self._state == AudioState.STOPPING:
            needed = self.TRAILING_SAMPLES - self._trailing_samples_collected
            if flat.size <= needed:
                self._trailing_chunks.append(flat)
                self._trailing_samples_collected += flat.size
            else:
                # Truncate oversized chunk to capture exactly the remaining trailing samples
                slice_chunk = flat[:needed]
                self._trailing_chunks.append(slice_chunk)
                self._trailing_samples_collected += needed

            if self._trailing_samples_collected >= self.TRAILING_SAMPLES:
                trailing_finished = True
                self._state = AudioState.PROCESSING

        # Accumulate 480-sample blocks for real-time RMS emission
        chunks = self._accumulator.feed(flat)
        rms_emissions: list[float] = []
        for c in chunks:
            rms_raw = self.compute_ac_rms(c)
            rms_norm = self.normalize_rms(rms_raw, self.min_db, self.max_db, self.gamma)
            rms_emissions.append(rms_norm)

        return rms_emissions, trailing_finished

    def get_current_audio_snapshot(self) -> np.ndarray:
        """Assembles currently recorded chunks into contiguous float32 array without resetting state."""
        if not self._active_chunks:
            return np.zeros(0, dtype=np.float32)
        return format_audio_for_whisper(list(self._active_chunks))

    def finalize_audio(self) -> np.ndarray:
        """Assembles all active and trailing chunks into contiguous float32 array."""
        all_chunks = self._active_chunks + self._trailing_chunks
        audio = format_audio_for_whisper(all_chunks)
        self.reset()
        return audio

    @staticmethod
    def compute_ac_rms(chunk: Any) -> float:
        return compute_ac_rms(chunk)

    @staticmethod
    def normalize_rms(
        rms: float,
        min_db: float = -50.0,
        max_db: float = -10.0,
        gamma: float = 1.2,
    ) -> float:
        return normalize_rms(rms, min_db, max_db, gamma)


# ==============================================================================
# Synthetic Audio Generator (Reference & Test Signal Utility)
# ==============================================================================

class SyntheticAudioGenerator:
    """Generates mathematically precise synthetic audio signals at 16kHz mono."""

    SAMPLE_RATE: int = SAMPLE_RATE

    @staticmethod
    def silence(duration_s: float) -> list[float]:
        num_samples = int(duration_s * SyntheticAudioGenerator.SAMPLE_RATE)
        return [0.0] * num_samples

    @staticmethod
    def dc_bias(duration_s: float, offset: float = 0.05) -> list[float]:
        num_samples = int(duration_s * SyntheticAudioGenerator.SAMPLE_RATE)
        return [float(offset)] * num_samples

    @staticmethod
    def sine(duration_s: float, frequency: float = 1000.0, amplitude: float = 1.0) -> list[float]:
        num_samples = int(duration_s * SyntheticAudioGenerator.SAMPLE_RATE)
        step = 2.0 * math.pi * frequency / SyntheticAudioGenerator.SAMPLE_RATE
        return [amplitude * math.sin(i * step) for i in range(num_samples)]

    @staticmethod
    def calibrated_tone(duration_s: float, dbfs: float, frequency: float = 1000.0) -> list[float]:
        rms = 10.0 ** (dbfs / 20.0)
        peak = rms * math.sqrt(2.0)
        return SyntheticAudioGenerator.sine(duration_s, frequency, peak)

    @staticmethod
    def speech_burst(duration_s: float) -> list[float]:
        num_samples = int(duration_s * SyntheticAudioGenerator.SAMPLE_RATE)
        samples: list[float] = []
        for i in range(num_samples):
            t = i / SyntheticAudioGenerator.SAMPLE_RATE
            f1 = 0.4 * math.sin(2.0 * math.pi * 300.0 * t)
            f2 = 0.3 * math.sin(2.0 * math.pi * 1200.0 * t)
            f3 = 0.2 * math.sin(2.0 * math.pi * 2500.0 * t)
            env = 0.5 * (1.0 + math.sin(2.0 * math.pi * 4.0 * t))
            samples.append((f1 + f2 + f3) * env)
        return samples

    @staticmethod
    def corrupted_vector(duration_s: float) -> list[float]:
        samples = SyntheticAudioGenerator.sine(duration_s, 440.0, 0.5)
        if len(samples) > 10:
            samples[2] = float("nan")
            samples[5] = float("inf")
            samples[8] = float("-inf")
        return samples


# ==============================================================================
# AudioPipeline Subsystem (Qt Coordinator & Stream Driver)
# ==============================================================================

class _PipelineSignalsHelper:
    """Helper providing property-based signal emission counters for tests."""

    def __init__(self, pipeline: AudioPipeline) -> None:
        self._pipeline = pipeline

    @property
    def recording_started_count(self) -> int:
        return self._pipeline._recording_started_count

    @property
    def recording_stopped_count(self) -> int:
        return self._pipeline._recording_stopped_count

    @property
    def recording_discarded_count(self) -> int:
        return self._pipeline._recording_discarded_count

    @property
    def error_occurred_count(self) -> int:
        return self._pipeline._error_occurred_count


class AudioPipeline(QObject):
    """
    Gated WASAPI Audio Pipeline Subsystem for VoxCode.
    Maintains zero open streams while idle (preserving Bluetooth A2DP audio mode).
    Emits 30ms RMS chunks for glowing waveform animation.
    Preserves 150ms trailing audio padding upon key release.
    """

    rms_emitted = Signal(float)          # Emitted every 30ms with normalized RMS (0.0 - 1.0)
    recording_started = Signal()         # Emitted when audio capture begins
    recording_stopped = Signal(object)    # Emits formatted np.ndarray (float32, 16000Hz, mono)
    recording_discarded = Signal(str)    # Emits reason string when <150ms or cancelled
    error_occurred = Signal(str)         # Emits error description on hardware failure

    def __init__(
        self,
        device_index: int | None = None,
        backend: AudioBackend | None = None,
    ) -> None:
        super().__init__()
        self._lock = threading.RLock()
        self.device_index = device_index
        self._backend = backend or get_audio_backend()
        self.processor = AudioProcessor()

        self._stream: AudioStreamInterface | None = None
        self._trailing_event = threading.Event()
        self._final_audio: np.ndarray | None = None

        # Diagnostic counters
        self._recording_started_count = 0
        self._recording_stopped_count = 0
        self._recording_discarded_count = 0
        self._error_occurred_count = 0
        self._signals_helper = _PipelineSignalsHelper(self)

    @property
    def signals(self) -> _PipelineSignalsHelper:
        return self._signals_helper

    @property
    def state(self) -> AudioState:
        with self._lock:
            return self.processor.state

    def is_recording(self) -> bool:
        with self._lock:
            return self.processor.state in (AudioState.RECORDING, AudioState.STOPPING)

    def get_recorded_audio_snapshot(self) -> np.ndarray | None:
        """Returns snapshot of current recorded audio without altering pipeline state."""
        with self._lock:
            if self.processor.state not in (AudioState.RECORDING, AudioState.STOPPING):
                return None
            return self.processor.get_current_audio_snapshot()

    def start_recording(self) -> bool:
        """Opens WASAPI stream and begins capturing audio."""
        if self.processor.state != AudioState.IDLE:
            self.cancel_recording()

        with self._lock:
            self._final_audio = None
            self._trailing_event.clear()
            self.processor.start()
            dev_idx = self.device_index

        try:
            stream = self._backend.open_input_stream(
                samplerate=SAMPLE_RATE,
                channels=CHANNELS,
                dtype=DTYPE,
                blocksize=BLOCK_SIZE_SAMPLES,
                device=dev_idx,
                callback=self._audio_callback,
            )
            # Start stream OUTSIDE lock so audio callback thread can safely acquire _lock without deadlocking
            stream.start()
            with self._lock:
                self._stream = stream
                self._recording_started_count += 1
            self.recording_started.emit()
            return True
        except Exception as e:
            with self._lock:
                self.processor.reset()
            self._close_stream()
            err_msg = f"Failed to open audio stream: {e}"
            logger.error(err_msg)
            self._error_occurred_count += 1
            self.error_occurred.emit(err_msg)
            raise AudioCaptureError(err_msg) from e

    def stop_recording(
        self,
        block: bool = True,
        timeout_s: float = 0.5,
        timeout: float | None = None,
    ) -> np.ndarray | None:
        """
        Initiates 150ms trailing audio padding capture, closes stream, and returns
        the formatted float32 array. Returns None if discarded (<150ms duration filter).
        """
        if timeout is not None:
            timeout_s = timeout

        stream_to_close = None
        with self._lock:
            if self.processor.state != AudioState.RECORDING:
                return None

            target_stream = self._stream

            can_proceed = self.processor.stop()
            if not can_proceed:
                # Active recording duration was < 150ms (< 2,400 samples); discard immediately
                stream_to_close = self._stream
                self._stream = None
                reason = "Duration < 150ms (accidental trigger)"
                self._recording_discarded_count += 1

        if not can_proceed:
            if stream_to_close is not None:
                try:
                    stream_to_close.stop()
                except Exception:
                    pass
                try:
                    stream_to_close.close()
                except Exception:
                    pass
            self.recording_discarded.emit(reason)
            return None

        # State is now STOPPING. Audio callback is gathering trailing 150ms frames.
        if block:
            completed = self._trailing_event.wait(timeout=timeout_s)
            if not completed:
                logger.warning(f"Trailing audio capture timed out after {timeout_s}s; finalizing available frames.")
            return self._finalize_recording(target_stream=target_stream)
        else:
            threading.Thread(target=self._async_stop_worker, args=(timeout_s, target_stream), daemon=True).start()
            return None

    def _async_stop_worker(self, timeout_s: float, target_stream: Any = None) -> None:
        self._trailing_event.wait(timeout=timeout_s)
        self._finalize_recording(target_stream=target_stream)

    def _finalize_recording(self, target_stream: Any = None) -> np.ndarray | None:
        stream_to_close = None
        with self._lock:
            if self.processor.state not in (AudioState.STOPPING, AudioState.PROCESSING):
                if target_stream is not None and self._stream is not target_stream:
                    stream_to_close = target_stream
                audio = None
            else:
                if target_stream is not None:
                    if self._stream is target_stream:
                        stream_to_close = self._stream
                        self._stream = None
                        audio = self.processor.finalize_audio()
                        self._final_audio = audio
                        self._recording_stopped_count += 1
                    else:
                        stream_to_close = target_stream
                        audio = None
                else:
                    stream_to_close = self._stream
                    self._stream = None
                    audio = self.processor.finalize_audio()
                    self._final_audio = audio
                    self._recording_stopped_count += 1

        if stream_to_close is not None:
            try:
                stream_to_close.stop()
            except Exception:
                pass
            try:
                stream_to_close.close()
            except Exception:
                pass

        if audio is not None:
            self.recording_stopped.emit(audio)
        return audio

    def cancel_recording(self) -> None:
        """Immediately closes stream, purges audio buffers, and transitions to IDLE."""
        with self._lock:
            if self.processor.state == AudioState.IDLE:
                return
            self.processor.cancel()
            self._trailing_event.set()
            self._recording_discarded_count += 1
            stream = self._stream
            self._stream = None

        if stream is not None:
            try:
                stream.stop()
            except Exception:
                pass
            try:
                stream.close()
            except Exception:
                pass

        self.recording_discarded.emit("Recording cancelled by user")

    def _audio_callback(self, indata: Any, frames: int, time_info: Any, status: Any) -> None:
        """PortAudio real-time callback executing on high-priority audio thread."""
        if status:
            logger.warning(f"PortAudio status warning: {status}")

        with self._lock:
            if self.processor.state not in (AudioState.RECORDING, AudioState.STOPPING):
                return
            try:
                rms_list, trailing_finished = self.processor.process_incoming_pcm(indata)
            except Exception as e:
                logger.error(f"Exception inside audio callback: {e}")
                return

        # Emit RMS signals outside lock to prevent GUI deadlocks
        for val in rms_list:
            self.rms_emitted.emit(val)

        if trailing_finished:
            self._trailing_event.set()

    def _close_stream(self) -> None:
        """Closes and releases the active audio stream."""
        with self._lock:
            stream = self._stream
            self._stream = None

        if stream is not None:
            try:
                stream.stop()
            except Exception:
                pass
            try:
                stream.close()
            except Exception:
                pass

    def enumerate_devices(self) -> list[AudioDeviceInfo]:
        """Enumerates available audio input endpoints."""
        raw_devices = self._backend.query_devices()
        assert isinstance(raw_devices, list)
        infos: list[AudioDeviceInfo] = []
        for dev in raw_devices:
            idx = int(dev["index"]) if "index" in dev else len(infos)
            if int(dev.get("max_input_channels", 0)) > 0:
                try:
                    infos.append(self._backend.get_device_info(idx))
                except Exception:
                    pass
        return infos

    def get_current_device(self) -> AudioDeviceInfo | None:
        """Returns AudioDeviceInfo for currently configured input device."""
        target_idx = self.device_index
        if target_idx is None:
            target_idx = self._backend.get_default_wasapi_device()
        if target_idx is None:
            return None
        try:
            return self._backend.get_device_info(target_idx)
        except Exception:
            return None

    def set_device(self, device_index: int | None) -> None:
        """Updates target input device index."""
        with self._lock:
            if self.is_recording():
                raise RuntimeError("Cannot change audio device while recording is active")
            self.device_index = device_index


__all__ = [
    "SAMPLE_RATE",
    "CHANNELS",
    "DTYPE",
    "BLOCK_SIZE_MS",
    "BLOCK_SIZE_SAMPLES",
    "TRAILING_PADDING_MS",
    "TRAILING_PADDING_SAMPLES",
    "MIN_RECORDING_MS",
    "MIN_RECORDING_SAMPLES",
    "AudioState",
    "AudioDeviceInfo",
    "AudioCaptureError",
    "AudioStreamInterface",
    "AudioBackend",
    "SoundDeviceBackend",
    "MockAudioStream",
    "MockAudioBackend",
    "get_audio_backend",
    "set_audio_backend",
    "reset_audio_backend",
    "use_mock_audio_backend",
    "compute_ac_rms",
    "compute_rms",
    "normalize_rms",
    "format_audio_for_whisper",
    "SampleAccumulator",
    "AudioProcessor",
    "SyntheticAudioGenerator",
    "AudioPipeline",
    "np",
]
