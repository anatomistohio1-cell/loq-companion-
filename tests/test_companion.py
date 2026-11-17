from __future__ import annotations

import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from windows_companion import server
from windows_companion.audio_devices import (
    AudioBackendUnavailable,
    WindowsAudioBackend,
    _endpoint_to_dict,
)


class CompanionSessionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original_pairing_token = server._PAIRING_TOKEN
        server._PAIRING_TOKEN = "test-pairing-secret-123"
        server._sessions.clear()

    def tearDown(self) -> None:
        server._PAIRING_TOKEN = self.original_pairing_token
        server._sessions.clear()

    def test_pairing_issues_a_session_and_invalid_code_is_rejected(self) -> None:
        with self.assertRaises(HTTPException) as error:
            server.pair(server.PairRequest(token="incorrect-pairing-secret"))
        self.assertEqual(error.exception.status_code, 401)

        result = server.pair(server.PairRequest(token=server._PAIRING_TOKEN))
        self.assertEqual(result["status"], "paired")
        self.assertTrue(server.require_session(f"Bearer {result['access_token']}"))

    def test_expired_session_is_rejected(self) -> None:
        token = "expired-session-token"
        server._sessions[token] = time.monotonic() - 1

        with self.assertRaises(HTTPException) as error:
            server.require_session(f"Bearer {token}")

        self.assertEqual(error.exception.status_code, 401)

    def test_metrics_does_not_report_placeholder_hardware_values(self) -> None:
        metrics = server._run_metrics()

        self.assertIn("cpu_percent", metrics)
        self.assertIn("memory_percent", metrics)
        self.assertNotIn("gpu_percent", metrics)
        self.assertNotIn("cpu_temperature_c", metrics)


class WindowsAudioBackendTests(unittest.TestCase):
    def test_refuses_endpoint_discovery_outside_windows(self) -> None:
        backend = WindowsAudioBackend()
        with patch("windows_companion.audio_devices.platform.system", return_value="Linux"):
            with self.assertRaises(AudioBackendUnavailable):
                backend.list_endpoints()

    def test_endpoint_snapshot_uses_reported_name_state_and_default(self) -> None:
        endpoint = SimpleNamespace(
            id="windows-endpoint-id",
            state=SimpleNamespace(name="Active"),
            properties={
                "{1DA5D803-D492-4EDD-8C23-E0C0FFEE7F0E} 0": 9,
            },
            FriendlyName="Windows HDMI output",
            volume_percent=64.0,
            EndpointVolume=SimpleNamespace(GetMute=lambda: False),
        )
        with patch(
            "windows_companion.audio_devices._endpoint_capabilities",
            return_value={"sample_rate_hz": 48000, "channels": 2, "bits_per_sample": 24},
        ):
            result = _endpoint_to_dict(endpoint, {"console": "windows-endpoint-id"})

        self.assertEqual(result["name"], "Windows HDMI output")
        self.assertEqual(result["state"], "active")
        self.assertEqual(result["form_factor"], "Digital display audio")
        self.assertTrue(result["is_default_console"])
        self.assertEqual(result["volume_percent"], 64.0)
        self.assertEqual(result["current_shared_mix_format"]["sample_rate_hz"], 48000)


if __name__ == "__main__":
    unittest.main()
