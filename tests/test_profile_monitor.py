import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


PROFILE_ID = "MS4wLjABAAAA1234567890"
PROFILE_URL = f"https://www.douyin.com/user/{PROFILE_ID}"


class ProfileMonitorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.account_file = Path(self.directory.name) / "accounts.json"
        self.patch_file = mock.patch.object(server, "ACCOUNT_FILE", self.account_file)
        self.patch_file.start()
        self.addCleanup(self.patch_file.stop)
        server.write_accounts([{
            "id": "profile-account",
            "name": PROFILE_ID,
            "handle": PROFILE_ID,
            "type": "competitor",
            "profileUrl": PROFILE_URL,
            "secUserId": PROFILE_ID,
            "roomUrl": "",
            "retiredRoomUrls": [],
            "monitoring": True,
            "profileStatus": "checking",
            "profileError": None,
            "profileNextCheckAt": None,
        }])

    def test_profile_lookup_uses_isolated_collector_and_preserves_raw_json_ids(self):
        body = {
            "status_code": 0,
            "user": {"nickname": "主播", "room_data": {"status": 2, "owner": {"web_rid": "1234567890123456789"}}},
        }
        with mock.patch.object(server.COLLECTOR, "call", return_value={"rawJson": json.dumps(body)}) as call:
            result = server.resolve_profile_state(PROFILE_ID)
        self.assertEqual(result["roomUrl"], "https://live.douyin.com/1234567890123456789")
        call.assert_called_once_with("profile.lookup", {"secUserId": PROFILE_ID}, timeout=45)

    def test_profile_lookup_errors_are_reported_as_detection_errors(self):
        with mock.patch.object(server.COLLECTOR, "call", side_effect=RuntimeError("抖音主页请求超时")):
            with self.assertRaisesRegex(server.ProfileLookupError, "超时"):
                server.resolve_profile_state(PROFILE_ID)

    def request_stub(self, rooms):
        calls = []

        def request(base_url, method="GET", path="/", payload=None, timeout=8):
            calls.append({"method": method, "path": path, "payload": payload})
            if method == "GET" and path == "/api/lives":
                return list(rooms)
            return {"ok": True}

        return calls, request

    def test_live_profile_registers_room_once_and_saves_nickname(self):
        calls, request = self.request_stub([])
        live = {"status": "live", "nickname": "主播", "roomUrl": "https://live.douyin.com/1234567890"}
        with mock.patch.object(server, "service_request", side_effect=request):
            server.profile_monitor_tick(now=1_800_000_000, resolver=lambda sec_user_id: live)
        account = server.read_accounts()[0]
        adds = [call for call in calls if call["method"] == "POST" and call["path"] == "/api/lives"]
        self.assertEqual(len(adds), 1)
        self.assertEqual(adds[0]["payload"], [{"url": live["roomUrl"], "listen": True}])
        self.assertEqual(account["profileStatus"], "live")
        self.assertEqual(account["roomUrl"], live["roomUrl"])
        self.assertEqual(account["name"], "主播")
        self.assertEqual(account["profileLastCheck"], "2027-01-15T08:00:00+00:00")

    def test_existing_active_room_is_not_registered_twice(self):
        room_url = "https://live.douyin.com/1234567890"
        rooms = [{"id": 17, "live_url": room_url, "listening": True, "status": True, "recording": False}]
        calls, request = self.request_stub(rooms)
        result = {"status": "live", "nickname": "", "roomUrl": room_url}
        with mock.patch.object(server, "service_request", side_effect=request):
            server.profile_monitor_tick(now=1_800_000_000, resolver=lambda _sec: result)
        self.assertFalse(any(call["method"] == "POST" for call in calls))
        self.assertEqual(server.read_accounts()[0]["roomUrl"], room_url)

    def test_new_room_retires_idle_previous_room(self):
        old_url = "https://live.douyin.com/1111111111"
        server.write_accounts([{**server.read_accounts()[0], "roomUrl": old_url}])
        rooms = [{"id": 3, "live_url": old_url, "listening": True, "status": False, "recording": False}]
        calls, request = self.request_stub(rooms)
        new_url = "https://live.douyin.com/2222222222"
        result = {"status": "live", "nickname": "主播", "roomUrl": new_url}
        with mock.patch.object(server, "service_request", side_effect=request):
            server.profile_monitor_tick(now=1_800_000_000, resolver=lambda _sec: result)
        account = server.read_accounts()[0]
        self.assertEqual(account["roomUrl"], new_url)
        self.assertEqual(account["retiredRoomUrls"], [old_url])
        self.assertIn({"method": "GET", "path": "/api/lives/3/stop", "payload": None}, calls)

    def test_offline_profile_waits_without_adding_room(self):
        calls, request = self.request_stub([])
        result = {"status": "offline", "nickname": "主播", "roomUrl": None}
        with mock.patch.object(server, "service_request", side_effect=request):
            server.profile_monitor_tick(now=1_800_000_000, resolver=lambda _sec: result)
        account = server.read_accounts()[0]
        self.assertEqual(account["profileStatus"], "offline")
        self.assertIsNone(account["roomUrl"] or None)
        self.assertFalse(any(call["method"] == "POST" for call in calls))

    def test_lookup_error_is_visible_and_retries_after_two_intervals(self):
        def fail(_sec):
            raise server.ProfileLookupError("抖音限制了主页查询")

        server.profile_monitor_tick(now=1_800_000_000, resolver=fail)
        account = server.read_accounts()[0]
        self.assertEqual(account["profileStatus"], "error")
        self.assertEqual(account["profileError"], "抖音限制了主页查询")
        self.assertEqual(account["profileNextCheckAt"], "2027-01-15T08:02:00+00:00")

    def test_not_due_accounts_are_not_polled(self):
        server.write_accounts([{**server.read_accounts()[0], "profileNextCheckAt": "2035-01-01T00:00:00+00:00"}])
        resolver = mock.Mock()
        server.profile_monitor_tick(now=1_800_000_000, resolver=resolver)
        resolver.assert_not_called()


if __name__ == "__main__":
    unittest.main()
