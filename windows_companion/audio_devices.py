from __future__ import annotations

import platform
from _ctypes import COMError
from typing import Any


class AudioBackendUnavailable(RuntimeError):
    pass


class AudioEndpointNotFound(ValueError):
    pass


class AudioEndpointControlError(RuntimeError):
    pass


_FORM_FACTORS = {
    0: "Remote network audio",
    1: "Speakers",
    2: "Line-level audio",
    3: "Headphones",
    5: "Headset",
    6: "Handset",
    7: "Digital passthrough",
    8: "S/PDIF",
    9: "Digital display audio",
    10: "Unknown Windows form factor",
}
_FORM_FACTOR_PROPERTY = "{1DA5D803-D492-4EDD-8C23-E0C0FFEE7F0E} 0"


def _require_windows() -> None:
    if platform.system() != "Windows":
        raise AudioBackendUnavailable(
            "Windows Core Audio endpoint access is available only on Windows."
        )


def _on_com_thread(callback: Any) -> Any:
    _require_windows()
    import comtypes

    comtypes.CoInitialize()
    try:
        return callback()
    finally:
        comtypes.CoUninitialize()


def _endpoint_capabilities(device: Any) -> dict[str, int] | None:
    import ctypes
    import comtypes
    from pycaw.pycaw import IAudioClient

    wave_format = None
    try:
        audio_client = device._dev.Activate(
            IAudioClient._iid_, comtypes.CLSCTX_ALL, None
        ).QueryInterface(IAudioClient)
        wave_format = audio_client.GetMixFormat()
        if wave_format is None:
            return None
        current_format = wave_format.contents
        return {
            "sample_rate_hz": int(current_format.nSamplesPerSec),
            "channels": int(current_format.nChannels),
            "bits_per_sample": int(current_format.wBitsPerSample),
        }
    except (COMError, OSError, ValueError):
        return None
    finally:
        if wave_format is not None:
            ctypes.windll.ole32.CoTaskMemFree(ctypes.cast(wave_format, ctypes.c_void_p))


def _endpoint_to_dict(
    device: Any,
    default_ids: dict[str, str | None],
) -> dict[str, Any]:
    state = device.state.name.lower().replace("notpresent", "not present")
    form_factor_value = device.properties.get(_FORM_FACTOR_PROPERTY.upper())
    try:
        form_factor = _FORM_FACTORS.get(int(form_factor_value), "Windows audio endpoint")
    except (TypeError, ValueError):
        form_factor = "Windows audio endpoint"

    volume_percent = None
    muted = None
    if state == "active":
        try:
            volume_percent = round(float(device.volume_percent), 1)
            muted = bool(device.EndpointVolume.GetMute())
        except (COMError, OSError, ValueError):
            pass

    endpoint_id = str(device.id)
    return {
        "id": endpoint_id,
        "name": device.FriendlyName or "Unnamed Windows audio endpoint",
        "state": state,
        "form_factor": form_factor,
        "is_default_console": endpoint_id == default_ids.get("console"),
        "is_default_multimedia": endpoint_id == default_ids.get("multimedia"),
        "is_default_communications": endpoint_id == default_ids.get("communications"),
        "volume_percent": volume_percent,
        "muted": muted,
        "volume_supported": volume_percent is not None and muted is not None,
        "current_shared_mix_format": _endpoint_capabilities(device) if state == "active" else None,
    }


class WindowsAudioBackend:
    def list_endpoints(self) -> list[dict[str, Any]]:
        def query() -> list[dict[str, Any]]:
            from pycaw.pycaw import AudioUtilities, DEVICE_STATE, EDataFlow, ERole

            enumerator = AudioUtilities.GetDeviceEnumerator()
            default_ids: dict[str, str | None] = {}
            for role_name, role in (
                ("console", ERole.eConsole),
                ("multimedia", ERole.eMultimedia),
                ("communications", ERole.eCommunications),
            ):
                try:
                    default_ids[role_name] = enumerator.GetDefaultAudioEndpoint(
                        EDataFlow.eRender.value, role.value
                    ).GetId()
                except (COMError, OSError, ValueError):
                    default_ids[role_name] = None

            devices = AudioUtilities.GetAllDevices(
                data_flow=EDataFlow.eRender.value,
                device_state=DEVICE_STATE.MASK_ALL.value,
            )
            return [_endpoint_to_dict(device, default_ids) for device in devices]

        try:
            return _on_com_thread(query)
        except (COMError, ImportError, OSError) as error:
            raise AudioBackendUnavailable(
                "Windows audio endpoint support is unavailable. Verify Windows and install the companion requirements."
            ) from error

    def set_default_endpoint(self, endpoint_id: str) -> None:
        def update() -> None:
            from pycaw.pycaw import AudioUtilities, ERole

            device = self._find_active_endpoint(endpoint_id)
            if device is None:
                raise AudioEndpointNotFound(endpoint_id)
            AudioUtilities.SetDefaultDevice(
                endpoint_id, roles=[ERole.eConsole, ERole.eMultimedia]
            )

        self._run_control(update, "Windows could not change the default playback endpoint.")

    def set_volume(self, endpoint_id: str, volume_percent: float) -> None:
        def update() -> None:
            device = self._find_active_endpoint(endpoint_id)
            if device is None:
                raise AudioEndpointNotFound(endpoint_id)
            device.volume_percent = volume_percent

        self._run_control(update, "Windows could not change endpoint volume.")

    def set_mute(self, endpoint_id: str, muted: bool) -> None:
        def update() -> None:
            device = self._find_active_endpoint(endpoint_id)
            if device is None:
                raise AudioEndpointNotFound(endpoint_id)
            device.EndpointVolume.SetMute(muted, None)

        self._run_control(update, "Windows could not change endpoint mute state.")

    @staticmethod
    def _run_control(callback: Any, message: str) -> None:
        try:
            _on_com_thread(callback)
        except AudioEndpointNotFound:
            raise
        except ImportError as error:
            raise AudioBackendUnavailable(
                "Windows audio endpoint support is unavailable. Install the companion requirements."
            ) from error
        except (COMError, OSError) as error:
            raise AudioEndpointControlError(message) from error

    @staticmethod
    def _find_active_endpoint(endpoint_id: str) -> Any | None:
        from pycaw.pycaw import AudioUtilities, DEVICE_STATE, EDataFlow

        devices = AudioUtilities.GetAllDevices(
            data_flow=EDataFlow.eRender.value,
            device_state=DEVICE_STATE.ACTIVE.value,
        )
        return next((device for device in devices if device.id == endpoint_id), None)
