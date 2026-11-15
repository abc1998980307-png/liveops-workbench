import http.client
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from session_links import SessionLinks
from session_timeline import SessionTimeline


RECORDING = "a" * 32
ACCOUNT = "12345678-1234-1234-1234-123456789abc"
ROOM = "7612345678901234567"


class FakeSessions:
    def _read(self):
        return {"sessions": [{"id": RECORDING, "roomId": "recorder-room", "recorderSessionId": "91",
                              "startedAt": "2026-11-09T23:30:00+08:00",
                              "endedAt": "2026-11-10T01:30:00+08:00", "partialObservation": True,
                              "segments": [
                                  {"id": "first", "path": "first.flv", "firstSeenAt": "2026-11-09T23:35:00+08:00",
                                   "lastSeenAt": "2026-11-10T00:10:00+08:00", "mediaDurationMs": 1800000},
                                  {"id": "second", "path": "second.flv", "firstSeenAt": "2026-11-10T00:20:00+08:00",
                                   "lastSeenAt": "2026-11-10T01:20:00+08:00", "mediaDurationMs": 3300000}],
                              "events": [{"type": "observation_gap", "from": "2026-11-10T00:05:00+08:00",
                                          "to": "2026-11-10T00:06:00+08:00", "note": "观察中断"}]}]}


class FakeArchives:
    def _read(self):
        return {"archives": []}


class FakeLookup:
    def __init__(self):
        self.uid = "99887766"
        self.calls = 0

    def __call__(self, account, room):
        self.calls += 1
        return {"account": {"id": account, "uid": self.uid, "label": "测试账号", "state": "paused",
                            "enabled": False, "lastSync": "2026-11-10T01:25:00+08:00"},
                "room": {"id": ROOM, "title": "跨日经营场次", "startedAt": "2026-11-09T23:20:00+08:00",
                         "state": "ended"} if room == ROOM else None,
                "latest": {"time": "2026-11-10T01:25:00+08:00", "metrics": [
                    {"key": "pay_amt", "value": 0, "display": "0.00", "unit": "元"}]},
                "history": [{"time": "2026-11-09T23:50:00+08:00", "metrics": [
                    {"key": "online_user_cnt", "value": None, "display": "—", "unit": "人"}]},
                    {"time": "2026-11-10T01:25:00+08:00", "metrics": [
                        {"key": "pay_amt", "value": 0, "display": "0.00", "unit": "元"}]}],
                "historyReport": None}


class SessionTimelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.lookup = FakeLookup()
        self.links = SessionLinks(self.temp.name, FakeSessions(), self.lookup)
        self.timeline = SessionTimeline(FakeSessions(), FakeArchives(), self.links)

    def link(self):
        self.links.link({"recordingSessionId": RECORDING, "accountId": ACCOUNT,
                         "roomId": ROOM, "confirmed": True, "replace": False})

    def test_unconfirmed_session_has_no_business_identity_or_metrics(self):
        result = self.timeline.detail(RECORDING)
        self.assertEqual(self.lookup.calls, 0)
        self.assertIsNone(result["identity"]["liveAccountUid"])
        self.assertIsNone(result["identity"]["roomId"])
        self.assertIsNone(result["identity"]["timeZone"])
        self.assertEqual(result["business"]["snapshots"], [])
        self.assertIsNone(result["business"]["latest"])
        self.assertEqual(result["business"]["status"], "unlinked")
        self.assertEqual(result["sources"]["shop"]["status"], "authorization_unknown")

    def test_confirmed_cross_day_timeline_keeps_missing_and_zero_distinct(self):
        self.link()
        result = self.timeline.detail(RECORDING)
        self.assertEqual(result["identity"]["roomId"], ROOM)
        self.assertEqual(result["identity"]["liveAccountUid"], "99887766")
        self.assertEqual(result["identity"]["timeZone"], "+08:00")
        self.assertEqual(result["originAt"], "2026-11-09T15:20:00+00:00")
        self.assertEqual([item["offsetMs"] for item in result["business"]["snapshots"]], [30 * 60000, 125 * 60000])
        self.assertIsNone(result["business"]["snapshots"][0]["metrics"][0]["value"])
        self.assertEqual(result["business"]["snapshots"][1]["metrics"][0]["value"], 0)
        self.assertEqual([item["status"] for item in result["gaps"]],
                         ["unobserved", "unknown", "observation_gap", "unobserved"])
        self.assertEqual(result["segments"][0]["timeAlignment"], "unverified")
        self.assertEqual(result["sources"]["compass"]["status"], "paused")
        self.assertEqual(result["sources"]["comments"]["status"], "not_connected")

    def test_identity_change_hides_all_business_values_but_keeps_local_recording(self):
        self.link()
        self.lookup.uid = "different"
        result = self.timeline.detail(RECORDING)
        self.assertEqual(result["business"]["status"], "identity_changed")
        self.assertEqual(result["business"]["snapshots"], [])
        self.assertIsNone(result["business"]["latest"])
        self.assertIsNone(result["business"]["historyReport"])
        self.assertEqual(len(result["segments"]), 2)

    def test_invalid_or_missing_recording_id_fails_closed(self):
        with self.assertRaises(ValueError):
            self.timeline.detail("not-an-id")
        with self.assertRaises(FileNotFoundError):
            self.timeline.detail("b" * 32)


class SessionTimelineHttpTests(SessionTimelineTests):
    @classmethod
    def setUpClass(cls):
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
        server.PORT = cls.old_port

    def setUp(self):
        super().setUp()
        patcher = mock.patch.object(server, "SESSION_TIMELINE", self.timeline)
        patcher.start()
        self.addCleanup(patcher.stop)

    def request(self, recording_id=RECORDING, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request("GET", "/api/session-timeline?recordingSessionId=" + recording_id,
                           headers=headers or {})
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def test_http_enforces_local_origin_and_not_found(self):
        self.assertEqual(self.request()[0], 200)
        self.assertEqual(self.request("b" * 32)[0], 404)
        self.assertEqual(self.request("bad")[0], 400)
        self.assertEqual(self.request(headers={"Origin": "https://attacker.example"})[0], 403)
