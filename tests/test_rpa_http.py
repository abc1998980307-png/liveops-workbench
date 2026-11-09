import http.client
import json
import threading
import tempfile
import urllib.error
import unittest
import sys
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class FakeCollector:
    def call(self, method, args=None, timeout=12):
        return {"method": method, "args": args, "accounts": []}


class RpaHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original = server.COLLECTOR
        server.COLLECTOR = FakeCollector()
        cls.http = server.LocalHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.http.server_address[1]
        cls.old_port = server.PORT
        server.PORT = cls.port
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()
        server.COLLECTOR = cls.original
        server.PORT = cls.old_port

    def request(self, method, route, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(method, route, body=body, headers=headers or {})
        response = connection.getresponse()
        data = response.read()
        connection.close()
        return response.status, data

    def test_state_and_session_routes(self):
        status, data = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["service"], "liveops-dashboard")
        status, data = self.request("GET", "/api/rpa/state")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["method"], "state")
        status, data = self.request("GET", "/api/rpa/session?account=a&room=123&raw=1")
        self.assertTrue(json.loads(data)["args"]["raw"])

    def test_cross_site_and_untrusted_host_rejected(self):
        status, _ = self.request("GET", "/api/rpa/state", headers={"Host": "attacker.example"})
        self.assertEqual(status, 403)
        status, _ = self.request("POST", "/api/rpa/accounts", "{}", {"Origin": "https://attacker.example", "Content-Type": "application/json"})
        self.assertEqual(status, 403)

    def test_create_and_action_inputs(self):
        status, data = self.request("POST", "/api/rpa/accounts", '{"label":"测试"}'.encode(), {"Content-Type":"application/json"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["args"]["label"], "测试")
        status, _ = self.request("POST", "/api/rpa/accounts", "[]", {"Content-Type":"application/json"})
        self.assertEqual(status, 400)
        status, _ = self.request("POST", "/api/rpa/accounts/x/login", "{}", {"Content-Type":"application/json"})
        self.assertEqual(status, 404)

    def test_ego_state_returns_only_validated_verification_fields(self):
        record = {
            "provider": "compass", "accountName": "测试账号",
            "authorId": "1000000000000001",
            "localAccountId": "00000000-0000-4000-8000-000000000001",
            "verifiedAt": "2026-11-08T10:00:00+08:00", "liveRoomCount": 0,
            "historySummary": "最近核验时未发现正在直播的场次。",
            "spendStatus": "pending_verification", "nextStep": "核验千川数据权限。",
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ego-setup.json"
            path.write_text(json.dumps({**record, "cookie": "private", "connected": True,
                                        "extra": {"secret": "private"}}), encoding="utf-8")
            with mock.patch.object(server, "EGO_SETUP_FILE", path):
                status, data = self.request("GET", "/api/rpa/ego/state")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data), {"configured": True, **record})

    def test_ego_state_missing_invalid_and_wrong_typed_records_are_unconfigured(self):
        valid = {"provider": "compass", "accountName": "测试账号",
                 "authorId": "1000000000000001", "verifiedAt": "2026-11-08T10:00:00+08:00"}
        records = ["invalid json", "[]", json.dumps({}),
                   json.dumps({**valid, "liveRoomCount": True}),
                   json.dumps({**valid, "liveRoomCount": "0"}),
                   json.dumps({**valid, "liveRoomCount": -1}),
                   json.dumps({**valid, "authorId": 1000000000000001}),
                   json.dumps({**valid, "accountName": {"secret": "private"}}),
                   json.dumps({**valid, "historySummary": "x" * 1001}),
                   json.dumps({**valid, "verifiedAt": "2026-11-08T10:00:00"}),
                   json.dumps({**valid, "localAccountId": "not-an-id"}),
                   json.dumps({**valid, "spendStatus": "connected"}),
                   json.dumps({**valid, "extra": "x" * 32768})]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ego-setup.json"
            with mock.patch.object(server, "EGO_SETUP_FILE", path):
                self.assertEqual(json.loads(self.request("GET", "/api/rpa/ego/state")[1]), {"configured": False})
                for record in records:
                    with self.subTest(record=record[:100]):
                        path.write_text(record, encoding="utf-8")
                        status, data = self.request("GET", "/api/rpa/ego/state")
                        self.assertEqual(status, 200)
                        self.assertEqual(json.loads(data), {"configured": False})
                path.write_text(json.dumps(valid), encoding="utf-8")
                data = json.loads(self.request("GET", "/api/rpa/ego/state")[1])
                self.assertTrue(data["configured"])
                self.assertIsNone(data["liveRoomCount"])
                self.assertEqual(data["spendStatus"], "pending_verification")

    def test_ego_state_is_local_only_and_has_no_write_endpoint(self):
        route = "/api/rpa/ego/state"
        for headers in ({"Host": "attacker.example"}, {"Origin": "https://attacker.example"}):
            self.assertEqual(self.request("GET", route, headers=headers)[0], 403)
        self.assertEqual(self.request("POST", route, "{}", {"Content-Type": "application/json"})[0], 404)
        self.assertEqual(self.request("GET", "/ego-setup.json")[0], 404)

    def test_static_allowlist_never_serves_collector_or_evidence(self):
        for route in ["/rpa-ui.js", "/rpa-ui.css", "/feishu-ui.js", "/feishu-ui.css", "/"]:
            self.assertEqual(self.request("GET", route)[0], 200)
        for route in ["/rpa/collector.mjs", "/rpa/feishu.mjs", "/rpa_bridge.py", "/../server.py", "/rpa/data.sqlite"]:
            self.assertEqual(self.request("GET", route)[0], 404)

    def test_feishu_routes_and_protection(self):
        status, data = self.request("GET", "/api/rpa/feishu/state")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["method"], "feishu.state")
        for action, method in [("settings", "config"), ("destination", "destination"), ("check", "test"), ("sync", "sync"), ("monitor", "monitor")]:
            route = "/api/rpa/feishu/" + action
            status, data = self.request("POST", route, '{"enabled":false}', {"Content-Type":"application/json"})
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(data)["method"], "feishu." + method)
            self.assertEqual(self.request("POST", route, "{}", {"Content-Type":"application/json", "Origin":"https://attacker.example"})[0], 403)
        self.assertEqual(self.request("GET", "/api/rpa/feishu/state", headers={"Host":"attacker.example"})[0], 403)
        self.assertEqual(self.request("POST", "/api/rpa/feishu/settings", "[]", {"Content-Type":"application/json"})[0], 400)

    def test_recorder_controls_and_local_access(self):
        state = {"connected": True, "managed": True, "recordingCount": 0}
        with mock.patch.object(server, "RECORDER") as recorder:
            recorder.state.return_value = state
            self.assertEqual(json.loads(self.request("GET", "/api/recorder/state")[1]), state)
            for action in ("start", "stop", "restart"):
                getattr(recorder, action).return_value = state
                status, data = self.request("POST", "/api/recorder/" + action, "{}", {"Content-Type":"application/json"})
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(data), state)
                getattr(recorder, action).assert_called_once_with()
            for action in ("start", "stop", "restart"):
                route = "/api/recorder/" + action
                self.assertEqual(self.request("POST", route, "{}", {"Content-Type":"application/json", "Origin":"https://attacker.example"})[0], 403)
                self.assertEqual(self.request("POST", route, "[]", {"Content-Type":"application/json"})[0], 400)
            self.assertEqual(self.request("GET", "/api/recorder/state", headers={"Host":"attacker.example"})[0], 403)
            recorder.stop.side_effect = server.RecorderError("正在录制", 409)
            status, data = self.request("POST", "/api/recorder/stop", "{}", {"Content-Type":"application/json"})
            self.assertEqual(status, 409)
            self.assertEqual(json.loads(data)["error"], "正在录制")

    def test_recorder_duration_units(self):
        self.assertEqual(server.duration_seconds(600_000_000_000), 600)
        self.assertEqual(server.duration_seconds("1h2m3s"), 3723)
        self.assertEqual(server.duration_seconds("600s"), 600)
        self.assertEqual(server.duration_seconds("0s"), 0)

    def test_settings_save_recording_directory_when_bililive_is_offline(self):
        names = (
            "RECORDINGS", "SETTINGS_FILE", "BGO_SETTINGS_FILE", "DAILYHOT_ENV_FILE",
            "MEDIA_PIPELINE_DIR", "MEDIA_SETTINGS_FILE", "service_request",
        )
        original = {name: getattr(server, name) for name in names}
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                server.RECORDINGS = root / "recordings"
                server.SETTINGS_FILE = root / "dashboard-settings.json"
                server.BGO_SETTINGS_FILE = root / "plugin-settings" / "bililive-go.json"
                server.DAILYHOT_ENV_FILE = root / "dailyhot" / ".env"
                server.MEDIA_PIPELINE_DIR = root / "media-pipeline"
                server.MEDIA_SETTINGS_FILE = root / "plugin-settings" / "media-pipeline.json"
                selected = root / "custom recordings"
                selected.mkdir()

                def unavailable(*_args, **_kwargs):
                    raise urllib.error.URLError("bililive-go offline")

                server.service_request = unavailable
                payload = {
                    "dashboard": {},
                    "bililive": {"out_put_path": str(selected)},
                    "dailyhot": {},
                    "mediaPipeline": {"enabled": False, "keepOriginal": False},
                }
                status, data = self.request(
                    "POST", "/api/settings", json.dumps(payload),
                    {"Content-Type": "application/json"},
                )

                self.assertEqual(status, 200, data.decode("utf-8"))
                self.assertEqual(json.loads(data)["ok"], True)
                dashboard = json.loads(server.SETTINGS_FILE.read_text(encoding="utf-8"))
                self.assertEqual(dashboard["recordingDirectory"], str(selected))
                recorder_saved = json.loads(server.BGO_SETTINGS_FILE.read_text())
                self.assertEqual(recorder_saved["out_put_path"], str(selected))
                self.assertEqual(recorder_saved["video_split_strategies"]["max_duration"], "0s")
                media_saved = json.loads(server.MEDIA_SETTINGS_FILE.read_text())
                self.assertIs(media_saved["keepOriginal"], False)
                self.assertEqual(media_saved["recordingDirectory"], str(selected))
                payload["mediaPipeline"]["keepOriginal"] = True
                status, data = self.request("POST", "/api/settings", json.dumps(payload), {"Content-Type": "application/json"})
                self.assertEqual(status, 200)
                self.assertIs(json.loads(server.MEDIA_SETTINGS_FILE.read_text())["keepOriginal"], True)
                payload["mediaPipeline"]["keepOriginal"] = "false"
                status, data = self.request("POST", "/api/settings", json.dumps(payload), {"Content-Type": "application/json"})
                self.assertEqual(status, 400)
                self.assertIs(json.loads(server.MEDIA_SETTINGS_FILE.read_text())["keepOriginal"], True)
                self.assertEqual(server.recording_directory(), selected.resolve())
        finally:
            for name, value in original.items():
                setattr(server, name, value)


if __name__ == "__main__":
    unittest.main()
