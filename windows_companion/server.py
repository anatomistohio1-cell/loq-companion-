from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import platform
import secrets
import time
from typing import Any
from urllib.parse import urlsplit

import psutil
from fastapi import (
    Depends,
    FastAPI,
    Header,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from .audio_devices import (
    AudioBackendUnavailable,
    AudioEndpointControlError,
    AudioEndpointNotFound,
    WindowsAudioBackend,
)

app = FastAPI(
    title="NERV LOQ Companion",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

_PAIRING_TOKEN = os.getenv("NERV_PAIRING_TOKEN")
_RELAY_URL = os.getenv("NERV_RELAY_URL")
_RELAY_DEVICE_ID = os.getenv("NERV_RELAY_DEVICE_ID")
_RELAY_DEVICE_TOKEN = os.getenv("NERV_RELAY_DEVICE_TOKEN")
_SESSION_TTL_SECONDS = 8 * 60 * 60
_sessions: dict[str, float] = {}
_audio = WindowsAudioBackend()
_logger = logging.getLogger("nerv-companion")
_relay_task: asyncio.Task[None] | None = None

_raw_origins = os.getenv("NERV_ALLOWED_ORIGINS", "").split(",")
_allowed_origins = [
    origin.strip()
    for origin in _raw_origins
    if origin.strip()
]
if not _allowed_origins or "*" in _allowed_origins:
    _allowed_origins = ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class PairRequest(BaseModel):
    token: str = Field(min_length=1, max_length=512)


class EndpointRequest(BaseModel):
    endpoint_id: str = Field(min_length=1, max_length=1024)


class VolumeRequest(EndpointRequest):
    volume_percent: float = Field(ge=0, le=100)


class MuteRequest(EndpointRequest):
    muted: bool


def _relay_websocket_url() -> str:
    if not _RELAY_URL or not _RELAY_DEVICE_ID:
        raise RuntimeError("The LOQ relay URL and device ID must be configured together.")
    parsed = urlsplit(_RELAY_URL)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("NERV_RELAY_URL must be an origin-only HTTPS URL.")
    return f"wss://{parsed.netloc}/v1/connect/{_RELAY_DEVICE_ID}"


def _relay_snapshot() -> dict[str, Any]:
    try:
        devices = _audio.list_endpoints()
    except AudioBackendUnavailable as error:
        devices = []
        _logger.warning("Unable to read Windows audio endpoints for relay snapshot: %s", error)
    return {
        "metrics": _run_metrics(),
        "devices": devices,
        "captured_at": time.time(),
    }


def _execute_relay_command(path: str, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    if path == "/metrics":
        return 200, _run_metrics()
    if path == "/audio/devices":
        try:
            return 200, {
                "devices": _audio.list_endpoints(),
                "captured_at": time.time(),
                "source": "Windows Core Audio",
            }
        except AudioBackendUnavailable as error:
            return 503, {"detail": str(error)}

    try:
        if path == "/audio/default":
            request = EndpointRequest.model_validate(body)
            _audio.set_default_endpoint(request.endpoint_id)
        elif path == "/audio/volume":
            request = VolumeRequest.model_validate(body)
            _audio.set_volume(request.endpoint_id, request.volume_percent)
        elif path == "/audio/mute":
            request = MuteRequest.model_validate(body)
            _audio.set_mute(request.endpoint_id, request.muted)
        else:
            return 400, {"detail": "The requested companion command is not allowed."}
    except ValidationError as error:
        return 422, {"detail": error.errors(include_input=False)}
    except AudioEndpointNotFound:
        return 409, {"detail": "The selected Windows audio endpoint is no longer active."}
    except AudioBackendUnavailable as error:
        return 503, {"detail": str(error)}
    except AudioEndpointControlError as error:
        return 503, {"detail": str(error)}

    return 200, {"status": "updated"}


async def _send_relay_snapshots(websocket: Any, send_lock: asyncio.Lock) -> None:
    while True:
        await asyncio.sleep(30)
        snapshot = await asyncio.to_thread(_relay_snapshot)
        async with send_lock:
            await websocket.send(json.dumps({"type": "snapshot", "snapshot": snapshot}))


async def _handle_relay_command(websocket: Any, payload: dict[str, Any], send_lock: asyncio.Lock) -> None:
    request_id = payload.get("id")
    path = payload.get("path")
    body = payload.get("body")
    if (
        not isinstance(request_id, str)
        or len(request_id) > 64
        or not isinstance(path, str)
        or not isinstance(body, dict)
    ):
        return

    status, result = await asyncio.to_thread(_execute_relay_command, path, body)
    response = {
        "type": "response",
        "id": request_id,
        "ok": 200 <= status < 300,
        "status": status,
        "result": result if 200 <= status < 300 else None,
        "error": result.get("detail") if not 200 <= status < 300 else None,
    }
    async with send_lock:
        await websocket.send(json.dumps(response))


async def _run_relay_connection() -> None:
    import websockets

    url = _relay_websocket_url()
    if not _RELAY_DEVICE_TOKEN:
        raise RuntimeError("NERV_RELAY_DEVICE_TOKEN must be configured when cloud relay is enabled.")

    retry_delay = 1
    while True:
        try:
            async with websockets.connect(
                url,
                additional_headers={"Authorization": f"Bearer {_RELAY_DEVICE_TOKEN}"},
                open_timeout=10,
                ping_interval=20,
                ping_timeout=20,
                close_timeout=5,
                max_size=128_000,
            ) as websocket:
                _logger.info("Connected to the authenticated LOQ cloud relay.")
                retry_delay = 1
                send_lock = asyncio.Lock()
                initial_snapshot = await asyncio.to_thread(_relay_snapshot)
                await websocket.send(json.dumps({"type": "snapshot", "snapshot": initial_snapshot}))
                snapshot_task = asyncio.create_task(_send_relay_snapshots(websocket, send_lock))
                try:
                    async for message in websocket:
                        if not isinstance(message, str) or len(message) > 128_000:
                            continue
                        try:
                            payload = json.loads(message)
                        except json.JSONDecodeError:
                            _logger.warning("Discarded invalid JSON from the cloud relay.")
                            continue
                        if isinstance(payload, dict) and payload.get("type") == "command":
                            await _handle_relay_command(websocket, payload, send_lock)
                finally:
                    snapshot_task.cancel()
                    try:
                        await snapshot_task
                    except asyncio.CancelledError:
                        pass
        except (OSError, asyncio.TimeoutError, websockets.exceptions.WebSocketException) as error:
            _logger.warning("LOQ cloud relay disconnected: %s; retrying in %s seconds.", error, retry_delay)
            await asyncio.sleep(retry_delay)
            retry_delay = min(retry_delay * 2, 30)


@app.on_event("startup")
async def start_cloud_relay() -> None:
    configured = (_RELAY_URL, _RELAY_DEVICE_ID, _RELAY_DEVICE_TOKEN)
    if any(configured) and not all(configured):
        raise RuntimeError(
            "Configure NERV_RELAY_URL, NERV_RELAY_DEVICE_ID, and "
            "NERV_RELAY_DEVICE_TOKEN together, or leave all three unset."
        )
    global _relay_task
    if all(configured):
        _relay_task = asyncio.create_task(_run_relay_connection())


@app.on_event("shutdown")
async def stop_cloud_relay() -> None:
    if _relay_task is None:
        return
    _relay_task.cancel()
    try:
        await _relay_task
    except asyncio.CancelledError:
        pass


def _session_from_authorization(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="A paired session is required.")

    token = authorization[7:].strip()
    expires_at = _sessions.get(token)
    if expires_at is None or expires_at <= time.monotonic():
        _sessions.pop(token, None)
        raise HTTPException(status_code=401, detail="The paired session has expired.")
    return token


def require_session(authorization: str | None = Header(default=None)) -> str:
    return _session_from_authorization(authorization)


def _run_metrics() -> dict[str, Any]:
    battery = psutil.sensors_battery()
    return {
        "device_name": platform.node(),
        "cpu_percent": psutil.cpu_percent(interval=None),
        "memory_percent": psutil.virtual_memory().percent,
        "battery_percent": battery.percent if battery else None,
        "charging": battery.power_plugged if battery else None,
        "uptime_seconds": round(time.time() - psutil.boot_time(), 1),
    }


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "device_name": platform.node(),
        "pairing_configured": bool(_PAIRING_TOKEN),
    }


@app.post("/pair")
def pair(request: PairRequest) -> dict[str, Any]:
    if not _PAIRING_TOKEN:
        raise HTTPException(
            status_code=503,
            detail="Pairing is disabled. Configure NERV_PAIRING_TOKEN on the LOQ.",
        )
    if not hmac.compare_digest(request.token, _PAIRING_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid pairing code.")

    session_token = secrets.token_urlsafe(32)
    _sessions[session_token] = time.monotonic() + _SESSION_TTL_SECONDS
    return {
        "status": "paired",
        "device_name": platform.node(),
        "access_token": session_token,
        "expires_in_seconds": _SESSION_TTL_SECONDS,
    }


@app.post("/disconnect")
def disconnect(session_token: str = Depends(require_session)) -> dict[str, str]:
    _sessions.pop(session_token, None)
    return {"status": "disconnected"}


@app.get("/metrics")
def metrics(_: str = Depends(require_session)) -> dict[str, Any]:
    return _run_metrics()


@app.get("/audio/devices")
def audio_devices(_: str = Depends(require_session)) -> dict[str, Any]:
    try:
        endpoints = _audio.list_endpoints()
    except AudioBackendUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    return {
        "devices": endpoints,
        "captured_at": time.time(),
        "source": "Windows Core Audio",
    }


@app.post("/audio/default")
def set_default_endpoint(
    request: EndpointRequest,
    _: str = Depends(require_session),
) -> dict[str, str]:
    try:
        _audio.set_default_endpoint(request.endpoint_id)
    except AudioBackendUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except AudioEndpointControlError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except AudioEndpointNotFound as error:
        raise HTTPException(
            status_code=409,
            detail="The selected Windows audio endpoint is no longer active.",
        ) from error
    return {"status": "updated"}


@app.post("/audio/volume")
def set_endpoint_volume(
    request: VolumeRequest,
    _: str = Depends(require_session),
) -> dict[str, str]:
    try:
        _audio.set_volume(request.endpoint_id, request.volume_percent)
    except AudioBackendUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except AudioEndpointControlError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except AudioEndpointNotFound as error:
        raise HTTPException(
            status_code=409,
            detail="The selected Windows audio endpoint is no longer active.",
        ) from error
    return {"status": "updated"}


@app.post("/audio/mute")
def set_endpoint_mute(
    request: MuteRequest,
    _: str = Depends(require_session),
) -> dict[str, str]:
    try:
        _audio.set_mute(request.endpoint_id, request.muted)
    except AudioBackendUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except AudioEndpointControlError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except AudioEndpointNotFound as error:
        raise HTTPException(
            status_code=409,
            detail="The selected Windows audio endpoint is no longer active.",
        ) from error
    return {"status": "updated"}


@app.websocket("/ws")
async def metrics_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        message = await asyncio.wait_for(websocket.receive_json(), timeout=10)
        session_token = message.get("token") if isinstance(message, dict) else None
        if not isinstance(session_token, str) or _session_from_websocket(session_token) is False:
            await websocket.close(code=4401, reason="A paired session is required.")
            return

        while True:
            await websocket.send_json(await asyncio.to_thread(_run_metrics))
            await websocket.send_json({"type": "heartbeat", "ok": True})
            await asyncio.sleep(2)
    except (asyncio.TimeoutError, WebSocketDisconnect):
        return


_static_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if os.path.exists(os.path.join(_static_root, "index.html")):
    app.mount("/", StaticFiles(directory=_static_root, html=True), name="static")


def _session_from_websocket(token: str) -> bool:
    expires_at = _sessions.get(token)
    if expires_at is None or expires_at <= time.monotonic():
        _sessions.pop(token, None)
        return False
    return True


def _run_server() -> None:
    import uvicorn

    host = os.getenv("NERV_COMPANION_HOST", "127.0.0.1")
    certificate = os.getenv("NERV_TLS_CERT")
    private_key = os.getenv("NERV_TLS_KEY")
    is_loopback = host in {"127.0.0.1", "localhost", "::1"}
    allow_insecure_lan = os.getenv("NERV_ALLOW_INSECURE_LAN", "1").lower() in {"1", "true", "yes"}
    if not is_loopback and (not certificate or not private_key) and not allow_insecure_lan:
        raise SystemExit(
            "LAN binding requires NERV_TLS_CERT and NERV_TLS_KEY (or set NERV_ALLOW_INSECURE_LAN=1). "
            "The companion will not expose pairing credentials over plain HTTP."
        )

    uvicorn.run(
        app,
        host=host,
        port=int(os.getenv("NERV_COMPANION_PORT", "8000")),
        ssl_certfile=certificate,
        ssl_keyfile=private_key,
    )


if __name__ == "__main__":
    _run_server()
