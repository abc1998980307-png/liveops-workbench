import http.client
import json
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from session_reviews import ReviewStoreError, SessionReviews


SESSION_ID = "a" * 32


class FakeSessions:
    def __init__(self):
        self.session = {"id": SESSION_ID, "roomId": "123", "account": "测试主播",
                        "title": "今晚直播", "startedAt": "2026-11-09T10:00:00+00:00",
                        "endedAt": "2026-11-09T12:00:00+00:00", "segments": [{}, {}]}

    def _read(self):
        return {"sessions": [self.session]}


class FakeArchives:
    def _read(self):
        return {"archives": [{"sessionId": SESSION_ID, "status": "completed",
                              "unknownGaps": True}]}

    def _public(self, item):
        return {**item, "videoPath": "archive/video.mp4", "subtitlesPath": "archive/subtitles.srt"}


class SessionReviewsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.sessions = FakeSessions()
        self.archives = FakeArchives()
        self.now = datetime(2026, 11, 10, 1, 2, 3, tzinfo=timezone.utc)
        self.store = SessionReviews(self.temp.name, self.sessions, self.archives, now=lambda: self.now)

    def test_upsert_survives_reopen_and_exports_current_recording_metadata(self):
        first = self.store.save({"sessionId": SESSION_ID, "summary": "首播复盘", "actions": "检查字幕"})
        self.now = datetime(2026, 11, 10, 2, 3, 4, tzinfo=timezone.utc)
        second = self.store.save({"sessionId": SESSION_ID, "summary": "更新复盘", "actions": "检查归档"})
        self.assertEqual(first["createdAt"], second["createdAt"])
        self.assertNotEqual(first["updatedAt"], second["updatedAt"])
        reopened = SessionReviews(self.temp.name, self.sessions, self.archives)
        self.assertEqual(reopened.list()["total"], 1)
        self.assertEqual(reopened.list(SESSION_ID)["reviews"][0]["summary"], "更新复盘")
        self.sessions.session["title"] = "直播标题已更新"
        exported = reopened.export_markdown(SESSION_ID).decode("utf-8")
        self.assertIn("直播标题已更新", exported)
        self.assertIn("2026-11-09T12:00:00+00:00", exported)
        self.assertIn("archive/video.mp4", exported)
        self.assertIn("归档未知间断：是", exported)
        self.assertIn("不包含成交、消耗等经营指标", exported)
        self.assertNotIn(self.temp.name, exported)

    def test_rejects_unknown_session_invalid_fields_and_empty_review(self):
        valid = {"sessionId": SESSION_ID, "summary": "有效", "actions": ""}
        invalid = [
            {**valid, "sessionId": "wrong"},
            {**valid, "sessionId": "b" * 32},
            {**valid, "summary": None},
            {**valid, "actions": "x" * 3001},
            {**valid, "summary": "", "actions": ""},
            {**valid, "secret": "must not persist"},
        ]
        for payload in invalid:
            with self.subTest(payload=repr(payload)[:60]), self.assertRaises((ValueError, FileNotFoundError)):
                self.store.save(payload)
        self.assertEqual(self.store.list()["reviews"], [])

    def test_corrupt_store_is_preserved_and_user_content_is_escaped_in_export(self):
        self.store.save({"sessionId": SESSION_ID, "summary": "<script>alert(1)</script>\n# 伪标题\n![远程图](https://example.com/a.png)", "actions": "核对"})
        markdown = self.store.export_markdown(SESSION_ID).decode("utf-8")
        self.assertNotIn("<script>", markdown)
        self.assertIn("&lt;script&gt;", markdown)
        self.assertIn(r"> \# 伪标题", markdown)
        self.assertIn(r"\!\[远程图\]\(https://example\.com/a\.png\)", markdown)
        original = b'{"version":1,"reviews":"damaged"}'
        self.store.file.write_bytes(original)
        with self.assertRaises(ReviewStoreError):
            self.store.save({"sessionId": SESSION_ID, "summary": "new", "actions": ""})
        self.assertEqual(self.store.file.read_bytes(), original)

    def test_capacity_limit_rejects_new_content_before_replacing_saved_review(self):
        self.store.save({"sessionId": SESSION_ID, "summary": "old", "actions": ""})
        original = self.store.file.read_bytes()
        with mock.patch("session_reviews.MAX_FILE_BYTES", len(original) + 5):
            with self.assertRaisesRegex(ReviewStoreError, "容量上限"):
                self.store.save({"sessionId": SESSION_ID, "summary": "new " * 50, "actions": ""})
        self.assertEqual(self.store.file.read_bytes(), original)

    def test_concurrent_upserts_keep_one_review(self):
        errors = []
        def save(index):
            try:
                self.store.save({"sessionId": SESSION_ID, "summary": f"draft {index}", "actions": ""})
            except Exception as error:
                errors.append(error)
        threads = [threading.Thread(target=save, args=(index,)) for index in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        self.assertEqual(self.store.list()["total"], 1)


class SessionReviewsHttpTests(SessionReviewsTests):
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
        patcher = mock.patch.object(server, "SESSION_REVIEWS", self.store)
        patcher.start()
        self.addCleanup(patcher.stop)

    def request(self, method, path, value=None, headers=None):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8") if value is not None else None
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(method, path, body=body, headers={"Content-Type": "application/json", **(headers or {})})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_http_save_list_and_download(self):
        status, _, data = self.request("POST", "/api/session-reviews",
                                       {"sessionId": SESSION_ID, "summary": "一场复盘", "actions": "核对录屏"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["review"]["summary"], "一场复盘")
        status, _, data = self.request("GET", "/api/session-reviews?sessionId=" + SESSION_ID)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["total"], 1)
        status, headers, data = self.request("GET", "/api/session-reviews/export?sessionId=" + SESSION_ID)
        self.assertEqual(status, 200)
        self.assertIn("attachment", headers["Content-Disposition"])
        self.assertIn("text/markdown", headers["Content-Type"])
        self.assertIn("一场复盘", data.decode("utf-8"))

    def test_http_guard_and_missing_review(self):
        for method, path, payload in (("GET", "/api/session-reviews", None),
                                      ("GET", "/api/session-reviews/export?sessionId=" + SESSION_ID, None),
                                      ("POST", "/api/session-reviews", {"sessionId": SESSION_ID,
                                                                          "summary": "a", "actions": ""})):
            for headers in ({"Host": "attacker.example"}, {"Origin": "https://attacker.example"}):
                with self.subTest(method=method, path=path, headers=headers):
                    self.assertEqual(self.request(method, path, payload, headers)[0], 403)
        self.assertEqual(self.request("GET", "/api/session-reviews/export?sessionId=" + SESSION_ID)[0], 404)
        self.assertEqual(self.request("POST", "/api/session-reviews", {"sessionId": "invalid",
                                                                       "summary": "a", "actions": ""})[0], 400)


if __name__ == "__main__":
    unittest.main()
