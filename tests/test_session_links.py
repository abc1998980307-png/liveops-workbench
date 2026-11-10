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
from session_links import LinkStoreError, SessionLinks
from session_reviews import SessionReviews


RECORDING_A = "a" * 32
RECORDING_B = "b" * 32
ACCOUNT = "12345678-1234-1234-1234-123456789abc"
ROOM = "7612345678901234567"


class FakeSessions:
    def _read(self):
        return {"sessions": [{"id": item, "account": "测试主播", "title": "夜场直播",
                              "startedAt": "2026-11-09T23:30:00+08:00", "endedAt": "2026-11-10T01:30:00+08:00",
                              "segments": [], "events": []} for item in (RECORDING_A, RECORDING_B)]}


class FakeArchives:
    def _read(self):
        return {"archives": []}


class FakeLookup:
    def __init__(self):
        self.calls = []
        self.uid = "99887766"
        self.room = {"id": ROOM, "title": "跨日经营场次", "startedAt": "2026-11-09T23:20:00+08:00", "state": "ended"}
        self.latest = {"time": "2026-11-10T01:25:00+08:00", "metrics": [
            {"key": "pay_amt", "label": "成交金额", "display": "0.00", "value": 0, "unit": "元"},
            {"key": "online_user_cnt", "label": "在线人数", "display": "—", "value": None, "unit": "人"}],
                       "endpoints": {"base": {"ok": True}, "core": {"ok": False, "error": "缺失"}}}

    def __call__(self, account, room):
        self.calls.append((account, room))
        return {"account": {"id": account, "uid": self.uid, "label": "测试账号", "state": "paused", "enabled": False},
                "room": self.room if room == ROOM else None, "latest": self.latest}


class SessionLinksTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.lookup = FakeLookup()
        self.sessions = FakeSessions()
        self.links = SessionLinks(self.temp.name, self.sessions, self.lookup)

    def payload(self, recording=RECORDING_A, room=ROOM, replace=False):
        return {"recordingSessionId": recording, "accountId": ACCOUNT,
                "roomId": room, "confirmed": True, "replace": replace}

    def test_explicit_link_is_idempotent_and_multiple_recordings_may_share_a_business_room(self):
        first = self.links.link(self.payload())
        self.assertEqual(self.links.link(self.payload()), first)
        self.links.link(self.payload(recording=RECORDING_B))
        reopened = SessionLinks(self.temp.name, self.sessions, self.lookup)
        self.assertEqual(len(reopened.list()["links"]), 2)
        self.assertEqual(reopened.get(RECORDING_A)["accountUid"], "99887766")
        self.assertEqual(reopened.get(RECORDING_B)["roomId"], ROOM)
        self.assertEqual(self.lookup.calls, [(ACCOUNT, ROOM)] * 3)

    def test_relink_requires_explicit_replace_and_unlink_requires_confirmation(self):
        self.links.link(self.payload())
        replacement = {**self.payload(), "accountId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}
        with self.assertRaisesRegex(ValueError, "明确确认替换"):
            self.links.link(replacement)
        self.assertEqual(self.links.get(RECORDING_A)["accountId"], ACCOUNT)
        self.links.link({**replacement, "replace": True})
        self.assertEqual(self.links.get(RECORDING_A)["accountId"], replacement["accountId"])
        with self.assertRaises(ValueError):
            self.links.unlink({"recordingSessionId": RECORDING_A, "confirmed": False})
        self.assertTrue(self.links.unlink({"recordingSessionId": RECORDING_A, "confirmed": True})["removed"])
        self.assertFalse(self.links.unlink({"recordingSessionId": RECORDING_A, "confirmed": True})["removed"])

    def test_invalid_or_unverified_targets_never_create_a_link(self):
        invalid = [
            {**self.payload(), "recordingSessionId": "c" * 32},
            {**self.payload(), "accountId": "bad"},
            {**self.payload(), "roomId": "1&other=2"},
            {**self.payload(), "confirmed": False},
        ]
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises((ValueError, FileNotFoundError)):
                self.links.link(payload)
        self.lookup.uid = None
        with self.assertRaisesRegex(ValueError, "尚未核验 UID"):
            self.links.link(self.payload())
        self.lookup.uid = "99887766"
        with self.assertRaises(FileNotFoundError):
            self.links.link(self.payload(room="123456"))
        self.assertEqual(self.links.list()["links"], [])

    def test_identity_change_or_missing_snapshot_preserves_link_but_hides_metrics(self):
        self.links.link(self.payload())
        self.assertEqual(self.links.business_snapshot(RECORDING_A)["status"], "ready")
        self.lookup.uid = "different"
        changed = self.links.business_snapshot(RECORDING_A)
        self.assertEqual(changed["status"], "identity_changed")
        self.assertNotIn("metrics", changed)
        self.lookup.uid = "99887766"
        self.lookup.latest = None
        self.assertEqual(self.links.business_snapshot(RECORDING_A)["status"], "no_snapshot")
        self.assertEqual(self.links.get(RECORDING_A)["accountUid"], "99887766")

    def test_review_export_uses_confirmed_snapshot_time_and_distinguishes_zero_from_missing(self):
        self.links.link(self.payload())
        reviews = SessionReviews(self.temp.name, self.sessions, FakeArchives(), links=self.links)
        reviews.save({"sessionId": RECORDING_A, "summary": "跨日复盘", "actions": "核对数据"})
        text = reviews.export_markdown(RECORDING_A).decode("utf-8")
        self.assertIn("罗盘场次 ID：" + ROOM, text)
        self.assertIn("2026-11-10T01:25:00+08:00", text)
        self.assertIn("成交金额：0.00 元；原值 0", text)
        self.assertIn("在线人数：— 人；原值 未返回", text)
        self.assertIn("部分接口未成功：core", text)
        self.lookup.uid = "changed"
        changed = reviews.export_markdown(RECORDING_A).decode("utf-8")
        self.assertIn("身份", changed)
        self.assertNotIn("成交金额：", changed)

    def test_corrupt_link_file_is_preserved(self):
        original = b'{"version":1,"links":"damaged"}'
        self.links.file.parent.mkdir(parents=True, exist_ok=True)
        self.links.file.write_bytes(original)
        with self.assertRaises(LinkStoreError):
            self.links.link(self.payload())
        self.assertEqual(self.links.file.read_bytes(), original)


class SessionLinksHttpTests(SessionLinksTests):
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
        patcher = mock.patch.object(server, "SESSION_LINKS", self.links)
        patcher.start()
        self.addCleanup(patcher.stop)

    def request(self, method, path, value=None, headers=None):
        body = json.dumps(value).encode() if value is not None else None
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(method, path, body=body, headers={"Content-Type": "application/json", **(headers or {})})
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def test_http_link_read_detail_and_unlink(self):
        status, response = self.request("POST", "/api/session-links", self.payload())
        self.assertEqual(status, 200)
        self.assertEqual(response["link"]["accountUid"], "99887766")
        status, response = self.request("GET", "/api/session-links")
        self.assertEqual(status, 200)
        self.assertEqual(len(response["links"]), 1)
        status, response = self.request("GET", "/api/session-links/detail?recordingSessionId=" + RECORDING_A)
        self.assertEqual(status, 200)
        self.assertEqual(response["status"], "ready")
        self.assertEqual(self.request("POST", "/api/session-links/unlink", {"recordingSessionId": RECORDING_A, "confirmed": True})[1], {"removed": True})

    def test_http_rejects_untrusted_host_and_origin(self):
        for method, path, value in (("GET", "/api/session-links", None), ("GET", "/api/session-links/detail?recordingSessionId=" + RECORDING_A, None),
                                    ("POST", "/api/session-links", self.payload()), ("POST", "/api/session-links/unlink", {"recordingSessionId": RECORDING_A, "confirmed": True})):
            for headers in ({"Host": "attacker.example"}, {"Origin": "https://attacker.example"}):
                with self.subTest(method=method, path=path, headers=headers):
                    self.assertEqual(self.request(method, path, value, headers)[0], 403)
