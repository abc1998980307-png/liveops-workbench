"""Synthetic tests for the HTTP read barrier; never start a real collector."""
import http.client
import json
import sys
import tempfile
import threading
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import rpa_bridge
import server


class ReadOnlyBridgeTests(unittest.TestCase):
    def test_unstarted_or_exited_collector_is_not_started_or_reconnected(self):
        for process in (None, mock.Mock(poll=mock.Mock(return_value=0))):
            with self.subTest(process=process), tempfile.TemporaryDirectory() as directory:
                bridge = rpa_bridge.CollectorBridge()
                bridge.process = process
                with mock.patch.object(bridge, "_start") as start, \
                        mock.patch.object(rpa_bridge, "DATA", Path(directory) / "not-created"):
                    with self.assertRaisesRegex(RuntimeError, "只读请求不会启动或重连"):
                        bridge.call("state", allow_start=False)
                    start.assert_not_called()
                    self.assertEqual(bridge.pending, {})
                    self.assertEqual(list(Path(directory).iterdir()), [])
                    if process is not None:
                        process.stdin.write.assert_not_called()

    def test_running_collector_uses_existing_pipe_without_start(self):
        bridge = rpa_bridge.CollectorBridge()
        bridge.process = mock.Mock(poll=mock.Mock(return_value=None))

        def respond(line):
            message = json.loads(line)
            self.assertEqual(message["method"], "state")
            bridge.pending[message["id"]].put({"result": {"accounts": []}})

        bridge.process.stdin.write.side_effect = respond
        with mock.patch.object(bridge, "_start") as start:
            self.assertEqual(bridge.call("state", allow_start=False), {"accounts": []})
            start.assert_not_called()
        bridge.process.stdin.flush.assert_called_once()
        self.assertEqual(bridge.pending, {})

    def test_pipe_failure_does_not_retry_and_original_call_still_starts(self):
        bridge = rpa_bridge.CollectorBridge()
        bridge.process = mock.Mock(poll=mock.Mock(return_value=None))
        bridge.process.stdin.write.side_effect = BrokenPipeError("synthetic private error")
        with mock.patch.object(bridge, "_start") as start:
            with self.assertRaisesRegex(RuntimeError, "采集器连接中断"):
                bridge.call("state", allow_start=False)
            start.assert_not_called()
            self.assertEqual(bridge.pending, {})
            with self.assertRaisesRegex(RuntimeError, "采集器连接中断"):
                bridge.call("state")
            start.assert_called_once()


class ReadOnlyMcpHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = server.LocalHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.http.server_address[1]
        cls.port_patch = mock.patch.object(server, "PORT", cls.port)
        cls.port_patch.start()
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()
        cls.port_patch.stop()

    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.stack.enter_context(mock.patch.object(server, "DATA_ROOT", self.root))
        self.collector = self.stack.enter_context(mock.patch.object(server, "COLLECTOR"))
        self.collector.call.return_value = {"synthetic": True}
        self.links = self.stack.enter_context(mock.patch.object(server, "SESSION_LINKS"))
        self.links.list.return_value = {"links": []}

    def request(self, route, method="GET", headers=None, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request(method, route, body=body, headers=headers or {})
            response = connection.getresponse()
            data = response.read()
            return response.status, json.loads(data) if data and response.getheader("Content-Type", "").startswith("application/json") else data
        finally:
            connection.close()

    def test_health_declares_safe_read_support(self):
        status, data = self.request("/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(data["readOnlyMcp"])
        self.collector.call.assert_not_called()

    def test_every_collector_read_disallows_start(self):
        for resource, method in (("state", "state"), ("qianchuan", "provider.qianchuan.status"),
                                 ("feishu", "feishu.state")):
            with self.subTest(resource=resource):
                self.collector.call.reset_mock()
                self.assertEqual(self.request("/api/mcp/read?resource=" + resource), (200, {"synthetic": True}))
                self.collector.call.assert_called_once_with(method, None, allow_start=False)

    def test_session_and_list_forward_only_existing_query_options(self):
        status, _ = self.request("/api/mcp/read?resource=session&account=synthetic&room=123")
        self.assertEqual(status, 200)
        self.collector.call.assert_called_once_with("detail", {"account": "synthetic", "room": "123", "raw": False}, allow_start=False)
        self.collector.call.reset_mock()
        status, _ = self.request("/api/mcp/read?resource=sessions&accounts=a,b&startDate=2026-11-01&endDate=2026-11-02&omitLive=1&sortBy=pay_amt&sortDirection=asc&offset=10&limit=20")
        self.assertEqual(status, 200)
        self.collector.call.assert_called_once_with("room.workspace", {
            "accounts": ["a", "b"], "startDate": "2026-11-01", "endDate": "2026-11-02", "omitLive": True,
            "sortBy": "pay_amt", "sortDirection": "asc", "offset": "10", "limit": "20"}, allow_start=False)

    def test_links_do_not_access_collector(self):
        self.assertEqual(self.request("/api/mcp/read?resource=links"), (200, {"links": []}))
        self.links.list.assert_called_once_with()
        self.collector.call.assert_not_called()

    def test_unknown_resources_raw_and_repeated_queries_are_rejected(self):
        for query in ("", "resource=login", "resource=sync", "resource=session&raw=1", "resource=session&raw=",
                      "resource=state&resource=feishu", "resource=state&token=synthetic", "resource=state&token="):
            with self.subTest(query=query):
                self.assertEqual(self.request("/api/mcp/read?" + query)[0], 400)
        self.collector.call.assert_not_called()
        self.links.list.assert_not_called()

    def test_foreign_origins_and_hosts_are_rejected_before_reading(self):
        for headers in ({"Origin": "https://synthetic.invalid"}, {"Host": "synthetic.invalid"}):
            with self.subTest(headers=headers):
                self.assertEqual(self.request("/api/mcp/read?resource=state", headers=headers)[0], 403)
        self.collector.call.assert_not_called()

    def test_non_get_methods_never_read_or_parse_payload(self):
        for method in ("POST", "DELETE", "HEAD", "PUT", "PATCH", "OPTIONS"):
            with self.subTest(method=method):
                status, data = self.request("/api/mcp/read?resource=state", method=method,
                                            headers={"Content-Type": "application/json"}, body="synthetic secret invalid JSON")
                self.assertIn(status, (405, 501))
                self.assertNotIn("synthetic secret", str(data))
        self.collector.call.assert_not_called()

    def test_backend_exceptions_use_static_messages_and_do_not_create_files(self):
        for error, expected in ((RuntimeError("synthetic private token"), 503),
                                (ValueError("synthetic private token"), 400),
                                (TypeError("synthetic private token"), 503),
                                (FileNotFoundError("synthetic private token"), 404)):
            with self.subTest(error=type(error).__name__):
                self.collector.call.side_effect = error
                status, data = self.request("/api/mcp/read?resource=state")
                self.assertEqual(status, expected)
                self.assertNotIn("synthetic private token", str(data))
        self.assertEqual(list(self.root.iterdir()), [])

    def test_unstarted_collector_http_fails_without_start_or_writes(self):
        bridge = rpa_bridge.CollectorBridge()
        with mock.patch.object(server, "COLLECTOR", bridge), mock.patch.object(bridge, "_start") as start:
            self.assertEqual(self.request("/api/mcp/read?resource=state")[0], 503)
            start.assert_not_called()
        self.assertEqual(list(self.root.iterdir()), [])

    def test_timeline_uses_readonly_lookup_and_masks_lookup_errors(self):
        recording = "a" * 32
        account = "00000000-0000-4000-8000-000000000001"
        link = {"recordingSessionId": recording, "accountId": account, "roomId": "123", "accountUid": "synthetic-uid"}
        records = mock.Mock()
        records._read.return_value = {"sessions": [{"id": recording, "segments": [], "events": []}]}
        archives = mock.Mock()
        archives._read.return_value = {"archives": []}
        with mock.patch.object(server, "RECORDING_SESSIONS", records), \
                mock.patch.object(server, "RECORDING_ARCHIVES", archives), \
                mock.patch.object(server.SessionLinks, "_read", return_value={"links": [link]}):
            self.collector.call.side_effect = RuntimeError("synthetic private token")
            status, data = self.request("/api/mcp/read?resource=timeline&recordingSessionId=" + recording)
        self.assertEqual(status, 200)
        self.assertEqual(data["business"]["status"], "unavailable")
        self.assertNotIn("synthetic private token", json.dumps(data))
        self.collector.call.assert_called_once_with("room.review", {"account": account, "room": "123"}, timeout=5, allow_start=False)
        self.assertEqual(list(self.root.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
