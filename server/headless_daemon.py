"""
VoxCode Headless Daemon (headless_daemon.py)

Lightweight pure-Python daemon without GUI, PySide6, Qt, or Win32 window dependencies.
Integrates:
- Standard asyncio + websockets server
- AudioPipeline (gated WASAPI audio capture)
- SpeechEngine (faster-whisper / CTranslate2)
- Text polisher & formatting
- Stdin watchdog for clean anti-zombie termination on parent process exit
"""

from __future__ import annotations

import argparse
import asyncio
import hmac
import http
import json
import logging
import os
import secrets
import signal
import sys
import tempfile
import threading
import time
from typing import Any, Optional, Set

# Suppress harmless Hugging Face Windows non-admin symlink warnings
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

# Ensure PySide6 is never loaded in headless mode
sys.modules["PySide6"] = None  # type: ignore
sys.modules["PySide6.QtCore"] = None  # type: ignore
sys.modules["PySide6.QtWidgets"] = None  # type: ignore
sys.modules["PySide6.QtGui"] = None  # type: ignore

# Add script directory to sys.path
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [headless_daemon]: %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stdout,
)
logger = logging.getLogger("voxcode.headless")

try:
    from websockets.asyncio.server import serve, ServerConnection
    NEW_WEBSOCKETS_API = True
except ImportError:
    import websockets
    from websockets.server import serve, WebSocketServerProtocol as ServerConnection  # type: ignore
    NEW_WEBSOCKETS_API = False

from enum import Enum

from core.audio import AudioPipeline
from core.engine import SpeechEngine, MockSpeechBackend
from core.polisher import polish_text


class SessionState(str, Enum):
    IDLE = "idle"
    LISTENING = "listening"
    RECORDING = "listening"
    TRANSCRIBING = "transcribing"
    ERROR = "error"

SERVER_VERSION = "0.2.0"
TOKEN_FILE_NAME = "voxcode.token"
AUTH_TIMEOUT_S = 2.0


class ClientConnectionInfo:
    def __init__(self, ws: Any) -> None:
        self.ws = ws
        self.authenticated = False
        self.client_id: Optional[str] = None
        self.workspace_name: str = ""
        self.auth_task: Optional[asyncio.Task] = None


class HeadlessDaemon:
    """Headless WebSocket Daemon managing audio dictation and speech-to-text inference."""

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 7355,
        token: Optional[str] = None,
        model_size: str = "base",
        model_dir: Optional[str] = None,
        device: str = "cpu",
        compute_type: str = "int8",
        language: str = "en",
        use_mock_engine: bool = False,
        cuda_dir: Optional[str] = None,
        storage_dir: Optional[str] = None,
    ) -> None:
        self.host = host
        self.port = port
        self.storage_dir = storage_dir or os.environ.get("VOXCODE_STORAGE_DIR")
        self.user_token = token or os.environ.get("VOXCODE_TOKEN")
        self.token = self.user_token or ""
        self.token_path = os.path.join(self.storage_dir, TOKEN_FILE_NAME) if self.storage_dir else None
        self.generated_token_on_disk = False
        self._watchdog_task: Optional[asyncio.Task] = None

        self.model_size = model_size
        self.model_dir = model_dir
        self.cuda_dir = cuda_dir
        self.device = device
        if compute_type == "auto" or (device == "cuda" and compute_type == "int8"):
            self.compute_type = "float16" if device == "cuda" else "int8"
        else:
            self.compute_type = compute_type

        self.language = language
        self.use_mock_engine = use_mock_engine

        self.session_state = SessionState.IDLE.value
        self.active_client_id: Optional[str] = None
        self.active_style: str = "code"

        self.connections: dict[Any, ClientConnectionInfo] = {}
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.server: Any = None

        # Setup Model Dir Environment if provided
        if self.model_dir:
            os.makedirs(self.model_dir, exist_ok=True)
            if "HF_HOME" not in os.environ:
                os.environ["HF_HOME"] = self.model_dir
            if "HUGGINGFACE_HUB_CACHE" not in os.environ:
                os.environ["HUGGINGFACE_HUB_CACHE"] = self.model_dir

        # Initialize Audio Pipeline
        logger.info("Initializing Audio Pipeline...")
        if use_mock_engine:
            from core.audio import set_audio_backend, MockAudioBackend
            set_audio_backend(MockAudioBackend())
            logger.info("Mock audio backend activated for testing.")
            
        self.audio = AudioPipeline()
        self.audio.rms_emitted.connect(self._on_rms_emitted)
        self.audio.recording_started.connect(self._on_audio_started)
        self.audio.recording_stopped.connect(self._on_audio_stopped)
        self.audio.recording_discarded.connect(self._on_audio_discarded)
        self.audio.error_occurred.connect(self._on_audio_error)

        # Initialize Speech Engine
        logger.info(
            f"Initializing Speech Engine (model={self.model_size}, device={self.device}, compute={self.compute_type})..."
        )
        if use_mock_engine:
            self.engine = SpeechEngine(
                backend=MockSpeechBackend(),
                auto_load=True,
                auto_warmup=False,
            )
            self.session_state = SessionState.IDLE.value
        else:
            self.engine = SpeechEngine(
                model_size=self.model_size,
                device=self.device,
                compute_type=self.compute_type,
                language=self.language,
                download_root=self.model_dir,
                auto_load=False,
                auto_warmup=(self.device == "cuda"),
                cuda_dir=self.cuda_dir,
            )
            self.session_state = "loading_model"

    # =========================================================================
    # Token Lifecycle
    # =========================================================================

    def setup_token(self) -> None:
        if self.user_token:
            self.token = self.user_token
            logger.info("Using provided in-memory authentication token.")
            return

        self.token = secrets.token_urlsafe(32)
        if self.token_path:
            try:
                os.makedirs(os.path.dirname(self.token_path), exist_ok=True)
                if os.path.exists(self.token_path):
                    try:
                        os.remove(self.token_path)
                    except Exception as ex:
                        logger.warning(f"Could not remove existing token file '{self.token_path}': {ex}")

                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
                mode = 0o600
                fd = os.open(self.token_path, flags, mode)
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(self.token)
                self.generated_token_on_disk = True
                logger.info(f"Generated token at '{self.token_path}'")
            except Exception as e:
                logger.error(f"Failed to write token file: {e}")

    def cleanup_token(self) -> None:
        if not self.generated_token_on_disk or not self.token_path:
            return
        try:
            if os.path.exists(self.token_path):
                with open(self.token_path, "r", encoding="utf-8") as f:
                    disk_token = f.read().strip()
                if disk_token == self.token:
                    os.remove(self.token_path)
                    logger.info(f"Cleaned up token file '{self.token_path}'")
        except Exception as e:
            logger.warning(f"Error during token file cleanup: {e}")

    # =========================================================================
    # Audio Callbacks (Invoked from audio thread)
    # =========================================================================

    def _on_rms_emitted(self, value: float) -> None:
        if self.loop and self.loop.is_running():
            asyncio.run_coroutine_threadsafe(self._broadcast_rms(value), self.loop)

    def _on_audio_started(self) -> None:
        logger.info("Audio capture started.")

    def _on_audio_stopped(self, audio_data: Any) -> None:
        logger.info("Audio capture stopped. Starting transcription...")
        threading.Thread(target=self._transcribe_worker, args=(audio_data,), daemon=True).start()

    def _on_audio_discarded(self, *args: Any) -> None:
        logger.info("Audio capture discarded (under 150ms minimum trigger).")
        if getattr(self, "use_mock_engine", False):
            import numpy as np
            logger.info("Mock engine active: proceeding with mock audio frame for testing.")
            threading.Thread(target=self._transcribe_worker, args=(np.zeros(1600, dtype=np.float32),), daemon=True).start()
        else:
            if self.loop and self.loop.is_running():
                asyncio.run_coroutine_threadsafe(self._transition_state(SessionState.IDLE.value), self.loop)

    def _on_audio_error(self, code: str, msg: str = "") -> None:
        if not msg:
            msg = code
            code = "AUDIO_CAPTURE_ERROR"
        logger.error(f"Audio pipeline error [{code}]: {msg}")
        if self.loop and self.loop.is_running():
            asyncio.run_coroutine_threadsafe(self._handle_error(code, msg), self.loop)

    def _transcribe_worker(self, audio_data: Any) -> None:
        client_id = self.active_client_id
        style = self.active_style

        # Background keepalive heartbeat to prevent client websocket timeouts during long inference
        stop_keepalive = threading.Event()

        def keepalive_heartbeat() -> None:
            while not stop_keepalive.wait(2.0):
                if self.loop and self.loop.is_running():
                    asyncio.run_coroutine_threadsafe(self._broadcast_keepalive("transcribing"), self.loop)

        keepalive_thread = threading.Thread(target=keepalive_heartbeat, daemon=True, name="TranscribeKeepalive")
        keepalive_thread.start()

        try:
            if audio_data is None or len(audio_data) == 0:
                if getattr(self, "use_mock_engine", False):
                    import numpy as np
                    audio_data = np.zeros(1600, dtype=np.float32)
                else:
                    logger.info("No audio data received for transcription.")
                    if self.loop and self.loop.is_running():
                        asyncio.run_coroutine_threadsafe(
                            self._transition_state(SessionState.IDLE.value), self.loop
                        )
                    return

            raw_text = self.engine.transcribe(audio_data, language=self.language)
            polished = polish_text(
                raw_text,
                auto_capitalize=(style != "code"),
                remove_fillers=True,
            )
            logger.info(f"Transcription complete: '{polished}' (raw: '{raw_text}')")

            payload = {
                "event": "transcript",
                "client_id": client_id,
                "source": "vscode",
                "text": polished,
                "raw": raw_text,
                "handled_by_daemon": False,
            }

            if self.loop and self.loop.is_running():
                asyncio.run_coroutine_threadsafe(self._dispatch_transcript(payload), self.loop)

        except Exception as e:
            logger.error(f"Transcription failure: {e}", exc_info=True)
            if self.loop and self.loop.is_running():
                asyncio.run_coroutine_threadsafe(
                    self._handle_error("INFERENCE_FAILED", str(e), client_id), self.loop
                )
        finally:
            stop_keepalive.set()
            if self.loop and self.loop.is_running():
                asyncio.run_coroutine_threadsafe(
                    self._transition_state(SessionState.IDLE.value), self.loop
                )

    # =========================================================================
    # Async Event Dispatching
    # =========================================================================

    async def _send_payload(self, ws: Any, data: dict[str, Any]) -> None:
        try:
            msg = json.dumps(data)
            await ws.send(msg)
        except Exception as e:
            logger.debug(f"Failed to send payload to client: {e}")

    async def _broadcast_payload(self, data: dict[str, Any]) -> None:
        authenticated_clients = [
            info.ws for info in self.connections.values() if info.authenticated
        ]
        if authenticated_clients:
            msg = json.dumps(data)
            await asyncio.gather(
                *[ws.send(msg) for ws in authenticated_clients],
                return_exceptions=True,
            )

    async def _broadcast_rms(self, value: float) -> None:
        payload = {"event": "rms_power", "value": round(float(value), 3)}
        await self._broadcast_payload(payload)

    async def _broadcast_keepalive(self, state: str) -> None:
        payload = {
            "event": "keepalive",
            "state": state,
            "device": getattr(self.engine, "device_in_use", "unknown"),
        }
        await self._broadcast_payload(payload)

    async def _transition_state(self, state: str, extra: dict[str, Any] | None = None) -> None:
        self.session_state = state
        payload: dict[str, Any] = {
            "event": "status_changed",
            "state": state,
            "device": getattr(self.engine, "device_in_use", "none"),
            "compute_type": getattr(self.engine, "compute_type_in_use", "none"),
            "model": getattr(self, "model_size", "unknown"),
            "fallback_reason": getattr(self.engine, "cuda_fallback_reason", None),
        }
        if extra:
            payload.update(extra)
        await self._broadcast_payload(payload)

    async def _dispatch_transcript(self, payload: dict[str, Any]) -> None:
        client_id = payload.get("client_id")
        sent = False
        if client_id:
            for info in list(self.connections.values()):
                if info.authenticated and info.client_id == client_id:
                    await self._send_payload(info.ws, payload)
                    sent = True
                    break

        if not sent:
            await self._broadcast_payload(payload)

    async def _handle_error(self, code: str, message: str, client_id: Optional[str] = None) -> None:
        payload = {
            "event": "error",
            "client_id": client_id,
            "code": code,
            "message": message,
        }
        if client_id:
            for info in list(self.connections.values()):
                if info.authenticated and info.client_id == client_id:
                    await self._send_payload(info.ws, payload)
                    break
        else:
            await self._broadcast_payload(payload)
        await self._transition_state(SessionState.IDLE.value)

    # =========================================================================
    # Connection Handshake & Protocol
    # =========================================================================

    def _validate_origin(self, origin: Optional[str]) -> bool:
        if origin is None:
            # Native VS Code desktop client (sets no Origin header)
            return True
        origin_lower = origin.strip().lower()
        if origin_lower == "null" or origin_lower == "":
            logger.warning(f"Rejecting sandboxed or null browser Origin: '{origin}'")
            return False
        if origin_lower.startswith("vscode-webview://"):
            return True
        logger.warning(f"Rejecting unauthorized Origin: '{origin}'")
        return False

    async def _auth_timeout_checker(self, ws: Any) -> None:
        try:
            await asyncio.sleep(AUTH_TIMEOUT_S)
            conn = self.connections.get(ws)
            if conn and not conn.authenticated:
                logger.warning("Client failed to authenticate within 2.0s deadline. Closing connection.")
                await self._send_payload(
                    ws,
                    {
                        "event": "error",
                        "client_id": None,
                        "code": "UNAUTHORIZED",
                        "message": "Authentication timeout (must authenticate within 2.0s)",
                    },
                )
                await ws.close(1008, "Authentication timeout")
        except asyncio.CancelledError:
            pass

    def _start_recording_watchdog(self, client_id: Optional[str]) -> None:
        self._stop_recording_watchdog()

        async def watchdog() -> None:
            try:
                await asyncio.sleep(300)  # 5-minute maximum recording duration
                if self.active_client_id == client_id and self.session_state in (
                    SessionState.RECORDING.value,
                    SessionState.LISTENING.value,
                ):
                    logger.warning("Maximum recording duration ceiling (5m) reached; stopping audio capture.")
                    await self._transition_state(SessionState.TRANSCRIBING.value)
                    self.audio.stop_recording(block=False)
            except asyncio.CancelledError:
                pass

        self._watchdog_task = asyncio.create_task(watchdog())

    def _stop_recording_watchdog(self) -> None:
        if self._watchdog_task:
            self._watchdog_task.cancel()
            self._watchdog_task = None

    async def handle_client(self, ws: Any, *args: Any) -> None:
        # Check Origin header safely across websockets versions
        headers = getattr(ws, "request_headers", None) or getattr(getattr(ws, "request", None), "headers", {})
        origin = None
        if headers:
            origin = headers.get("Origin") or headers.get("origin")

        if not self._validate_origin(origin):
            await ws.close(1008, "Origin not allowed")
            return

        conn = ClientConnectionInfo(ws)
        self.connections[ws] = conn
        conn.auth_task = asyncio.create_task(self._auth_timeout_checker(ws))

        logger.info("New incoming client connection accepted. Awaiting authentication...")

        try:
            async for raw_message in ws:
                try:
                    payload = json.loads(raw_message)
                except Exception:
                    await self._send_payload(
                        ws,
                        {
                            "event": "error",
                            "client_id": conn.client_id,
                            "code": "INVALID_JSON",
                            "message": "Malformed JSON text frame",
                        },
                    )
                    continue

                action = payload.get("action")

                if not conn.authenticated:
                    if action == "authenticate":
                        token_arg = str(payload.get("token") or "")
                        if bool(self.token) and hmac.compare_digest(token_arg, self.token):
                            conn.authenticated = True
                            if conn.auth_task:
                                conn.auth_task.cancel()
                            await self._send_payload(
                                ws,
                                {
                                    "event": "auth_ok",
                                    "version": SERVER_VERSION,
                                    "device": getattr(self.engine, "device_in_use", "none"),
                                    "compute_type": getattr(self.engine, "compute_type_in_use", "none"),
                                    "model": getattr(self, "model_size", "unknown"),
                                    "fallback_reason": getattr(self.engine, "cuda_fallback_reason", None),
                                },
                            )
                            logger.info("Client authenticated successfully.")
                        else:
                            logger.warning("Client authentication failed: invalid token.")
                            await self._send_payload(
                                ws,
                                {
                                    "event": "error",
                                    "client_id": None,
                                    "code": "UNAUTHORIZED",
                                    "message": "Invalid authentication token",
                                },
                            )
                            await ws.close(1008, "Invalid token")
                            return
                    else:
                        await self._send_payload(
                            ws,
                            {
                                "event": "error",
                                "client_id": None,
                                "code": "UNAUTHORIZED",
                                "message": "Connection must authenticate before sending commands",
                            },
                        )
                        await ws.close(1008, "Unauthorized")
                        return
                    continue

                # Authenticated Command Handling
                if action == "register":
                    conn.client_id = payload.get("client_id")
                    conn.workspace_name = payload.get("workspace_name", "")
                    logger.info(f"Registered client: {conn.client_id} ('{conn.workspace_name}')")
                    await self._send_payload(
                        ws,
                        {
                            "event": "status_changed",
                            "state": self.session_state,
                            "device": getattr(self.engine, "device_in_use", "none"),
                            "compute_type": getattr(self.engine, "compute_type_in_use", "none"),
                            "model": getattr(self, "model_size", "unknown"),
                            "fallback_reason": getattr(self.engine, "cuda_fallback_reason", None),
                        },
                    )

                elif action == "start_recording":
                    if self.session_state == "loading_model":
                        logger.warning("Start recording rejected: model is still loading.")
                        await self._send_payload(
                            ws,
                            {
                                "event": "error",
                                "client_id": conn.client_id,
                                "code": "MODEL_LOADING",
                                "message": "Speech model is still downloading or initializing. Please wait a moment...",
                            },
                        )
                        continue

                    if self.session_state == SessionState.TRANSCRIBING.value:
                        logger.warning("Start recording rejected: daemon is busy transcribing.")
                        await self._send_payload(
                            ws,
                            {
                                "event": "error",
                                "client_id": conn.client_id,
                                "code": "BUSY_TRANSCRIBING",
                                "message": "Transcription is currently in progress. Please wait a moment...",
                            },
                        )
                        continue

                    if self.session_state in (SessionState.RECORDING.value, SessionState.LISTENING.value):
                        logger.warning("Start recording rejected: recording session is already active.")
                        await self._send_payload(
                            ws,
                            {
                                "event": "error",
                                "client_id": conn.client_id,
                                "code": "ALREADY_RECORDING",
                                "message": "Recording session is already active.",
                            },
                        )
                        continue

                    self.active_client_id = payload.get("client_id") or conn.client_id
                    self.active_style = payload.get("style", "code")
                    logger.info(
                        f"Start recording requested by '{self.active_client_id}' (style={self.active_style})"
                    )
                    await self._transition_state(SessionState.LISTENING.value)
                    self._start_recording_watchdog(self.active_client_id)
                    try:
                        self.audio.start_recording()
                    except Exception as e:
                        logger.error(f"Failed to start audio recording: {e}")
                        self._stop_recording_watchdog()
                        await self._transition_state(SessionState.IDLE.value)
                        await self._send_payload(
                            ws,
                            {
                                "event": "error",
                                "client_id": conn.client_id,
                                "code": "AUDIO_CAPTURE_ERROR",
                                "message": f"Failed to start audio capture: {e}",
                            },
                        )
                        continue

                elif action == "stop_recording":
                    logger.info("Stop recording requested.")
                    self._stop_recording_watchdog()
                    await self._transition_state(SessionState.TRANSCRIBING.value)
                    self.audio.stop_recording(block=False)

                elif action == "cancel_recording":
                    logger.info("Cancel recording requested.")
                    self._stop_recording_watchdog()
                    self.audio.cancel_recording()
                    await self._transition_state(SessionState.IDLE.value)

                elif action == "get_status":
                    await self._send_payload(
                        ws,
                        {
                            "event": "status_changed",
                            "state": self.session_state,
                            "device": getattr(self.engine, "device_in_use", "none"),
                            "compute_type": getattr(self.engine, "compute_type_in_use", "none"),
                            "model": getattr(self, "model_size", "unknown"),
                            "fallback_reason": getattr(self.engine, "cuda_fallback_reason", None),
                        },
                    )

                else:
                    logger.warning(f"Unknown action received: '{action}'")

        except Exception as e:
            logger.debug(f"Client connection closed with exception: {e}")
        finally:
            if conn.auth_task:
                conn.auth_task.cancel()
            self._stop_recording_watchdog()
            if self.active_client_id == conn.client_id and self.session_state in (
                SessionState.RECORDING.value,
                SessionState.LISTENING.value,
            ):
                logger.warning(
                    f"Client {conn.client_id} disconnected while recording. Stopping audio capture."
                )
                self.audio.stop_recording(block=False)
                self.active_client_id = None
                await self._transition_state(SessionState.IDLE.value)
            self.connections.pop(ws, None)
            logger.info(f"Client disconnected: {conn.client_id}")

    # =========================================================================
    # Server Run Loop
    # =========================================================================

    async def run(self) -> None:
        self.loop = asyncio.get_running_loop()
        self.setup_token()

        if NEW_WEBSOCKETS_API:
            self.server = await serve(self.handle_client, self.host, self.port)
        else:
            self.server = await serve(self.handle_client, self.host, self.port)

        logger.info(f"VoxCode Headless Daemon running on ws://{self.host}:{self.port}")
        # Explicit synchronization line for supervisor child process detection
        print("SERVER_LISTENING", flush=True)

        if not self.use_mock_engine:
            asyncio.create_task(self._async_load_model())

        try:
            await asyncio.Future()  # Run forever
        except asyncio.CancelledError:
            pass
        finally:
            self.cleanup()

    async def _async_load_model(self) -> None:
        logger.info(
            f"Starting background Whisper model load (model={self.model_size}, device={self.device}, compute={self.compute_type})..."
        )
        try:
            success = await asyncio.to_thread(self.engine.load_model, (self.device == "cuda"))
            if success:
                logger.info("Whisper model loaded successfully. Daemon is ready for dictation.")
                await self._transition_state(SessionState.IDLE.value)
            else:
                logger.error("SpeechEngine.load_model returned False.")
                await self._transition_state("error")
        except Exception as e:
            logger.error(f"Error loading Whisper model: {e}", exc_info=True)
            await self._transition_state("error")

    def cleanup(self) -> None:
        logger.info("Shutting down headless daemon...")
        try:
            self.audio.cancel_recording()
        except Exception:
            pass
        self.cleanup_token()


def start_stdin_watchdog() -> None:
    """Watches sys.stdin. If parent VS Code closes standard input, exit immediately."""

    def watchdog() -> None:
        try:
            while True:
                char = sys.stdin.read(1)
                if not char:
                    break
        except Exception:
            pass
        logger.info("Parent stdin EOF detected. Exiting daemon process.")
        os._exit(0)

    t = threading.Thread(target=watchdog, name="StdinWatchdog", daemon=True)
    t.start()


def main() -> None:
    parser = argparse.ArgumentParser(description="VoxCode Headless Daemon")
    parser.add_argument("--host", default="127.0.0.1", help="Host loopback address")
    parser.add_argument("--port", type=int, default=7355, help="Port to bind")
    parser.add_argument("--token", default=None, help="In-memory authentication token")
    parser.add_argument("--model-size", default="base", help="Whisper model size")
    parser.add_argument("--model-path", default=None, help="Explicit local path to bundled or pre-downloaded model directory")
    parser.add_argument("--model-dir", default=None, help="Model storage directory")
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda"], help="Inference device")
    parser.add_argument("--compute-type", default="auto", help="Quantization compute type (auto, float16, int8, etc.)")
    parser.add_argument("--cuda-dir", default=None, help="Explicit directory containing CUDA 12 runtime DLLs")
    parser.add_argument("--storage-dir", default=None, help="Extension global storage directory")
    parser.add_argument("--language", default="en", help="Language code")
    parser.add_argument("--use-mock-engine", action="store_true", help="Use mock STT engine for tests")
    args = parser.parse_args()

    start_stdin_watchdog()

    model_spec = args.model_path if (args.model_path and os.path.exists(args.model_path)) else args.model_size

    daemon = HeadlessDaemon(
        host=args.host,
        port=args.port,
        token=args.token,
        model_size=model_spec,
        model_dir=args.model_dir,
        device=args.device,
        compute_type=args.compute_type,
        cuda_dir=args.cuda_dir,
        storage_dir=args.storage_dir,
        language=args.language,
        use_mock_engine=args.use_mock_engine,
    )

    try:
        asyncio.run(daemon.run())
    except (KeyboardInterrupt, SystemExit):
        daemon.cleanup()


if __name__ == "__main__":
    main()
