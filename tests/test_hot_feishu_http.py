"""Local-only HTTP checks for the isolated hot-term sync channel."""

import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from hot_feishu_sync import HotFeishuSync
from hot_insights import HotInsights


class HotFeishuHttpTests(unittest.TestCase):
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
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        sync = HotFeishuSync(temp.name, sender=lambda config, payload: None)
        self.addCleanup(sync.close)
        for name, value in (("HOT_FEISHU", sync), ("HOT_INSIGHTS", HotInsights(temp.name))):
            patcher = mock.patch.object(server, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def request(self, method, path, payload=None, origin=None):
        headers = {"Host": f"127.0.0.1:{self.port}"}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if origin:
            headers["Origin"] = origin
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(method, path, json.dumps(payload).encode() if payload is not None else None, headers)
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def test_default_off_target_gate_and_redacted_status(self):
        origin = f"http://127.0.0.1:{self.port}"
        self.assertFalse(self.request("GET", "/api/hot-insights/sync")[1]["enabled"])
        self.assertEqual(self.request("POST", "/api/hot-insights/sync/config", {
            "enabled": True, "appId": "", "appSecret": "", "tableUrl": ""}, origin)[0], 400)
        status, result = self.request("POST", "/api/hot-insights/sync/config", {
            "enabled": True, "appId": "synthetic_app", "appSecret": "dummy_secret",
            "tableUrl": "https://demo.feishu.cn/base/synthetic?table=tblSynthetic"}, origin)
        self.assertEqual(status, 200)
        self.assertTrue(result["enabled"])
        self.assertNotIn("appId", result)
        self.assertNotIn("appSecret", result)
        self.assertNotIn("tableUrl", result)
        self.assertEqual(self.request("POST", "/api/hot-insights/sync/retry", {}, origin)[0], 200)
        self.assertEqual(self.request("POST", "/api/hot-insights/sync/config", {
            "enabled": False, "appId": "", "appSecret": "", "tableUrl": ""}, origin)[0], 200)
        self.assertEqual(self.request("GET", "/api/hot-insights/sync", origin="https://other.invalid")[0], 403)


if __name__ == "__main__":
    unittest.main()
