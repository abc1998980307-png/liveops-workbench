import http.client
import json
import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class MediaHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = server.LocalHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.http.server_address[1]
        cls.previous_port = server.PORT
        server.PORT = cls.port
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()
        server.PORT = cls.previous_port

    def setUp(self):
        self.mock = mock.patch.object(server, "MEDIA_PIPELINE")
        self.pipeline = self.mock.start()
        self.addCleanup(self.mock.stop)
        self.pipeline.retry_job.return_value = {"ok": True, "alreadyQueued": False}
        self.pipeline.job_snapshot.return_value = {"jobs": []}

    def request(self, payload=None, headers=None, method="POST"):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(method, "/api/media/retry" if method == "POST" else "/api/media/jobs",
                           json.dumps(payload) if method == "POST" else None,
                           {"Content-Type": "application/json", **(headers or {})})
        response = connection.getresponse()
        value = json.loads(response.read())
        connection.close()
        return response.status, value

    def test_normal_retry_and_explicit_tail_recovery(self):
        for enabled in (False, True):
            status, data = self.request({"id": "a" * 32, "recoverTail": enabled})
            self.assertEqual(status, 200)
            self.assertTrue(data["ok"])
            self.pipeline.retry_job.assert_called_with("a" * 32, enabled)

    def test_foreign_host_and_origin_cannot_read_or_change_jobs(self):
        for method in ("GET", "POST"):
            for headers in ({"Host": "attacker.example"}, {"Origin": "https://attacker.example"}):
                self.assertEqual(self.request({"id": "a" * 32}, headers, method)[0], 403)
        self.pipeline.retry_job.assert_not_called()
        self.pipeline.job_snapshot.assert_not_called()

    def test_requires_json_object_and_content_type(self):
        self.assertEqual(self.request([])[0], 400)
        self.assertEqual(self.request({}, {"Content-Type": "text/plain"})[0], 415)
        self.pipeline.retry_job.assert_not_called()

    def test_missing_invalid_and_persistence_failures_return_distinct_status(self):
        for error, expected in [(FileNotFoundError("missing"), 404), (ValueError("invalid"), 400), (OSError("disk full"), 500)]:
            self.pipeline.retry_job.side_effect = error
            self.assertEqual(self.request({"id": "a" * 32})[0], expected)

    def test_missing_component_is_reported(self):
        with mock.patch.object(server, "MEDIA_PIPELINE", None):
            self.assertEqual(self.request({"id": "a" * 32})[0], 503)


if __name__ == "__main__":
    unittest.main()
