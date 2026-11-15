import tempfile
import io
import json
import unittest
from pathlib import Path
import sys
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hot_feishu_sync import HotFeishuSync, HotFeishuError, FIELDS


class HotFeishuSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.clock = 1000
        self.sent = []
        self.fail = False
        def sender(config, payload):
            if self.fail:
                raise RuntimeError("fake delivery failed")
            self.sent.append(payload)
        self.sync = HotFeishuSync(self.temp.name, sender=sender, now=lambda: self.clock)
        self.addCleanup(self.sync.db.close)
        self.insight = {"latest": {"sampledAt": "2026-11-12T10:00:00Z",
                                   "sourceUpdatedAt": "2026-11-12T09:58:00Z",
                                   "items": [{"title": "合成热点", "hot": 42, "rank": 1}]},
                        "terms": [{"term": "合成"}]}

    def configure(self, enabled=True):
        return self.sync.configure(enabled=enabled, app_id="synthetic_app", app_secret="dummy_secret",
                                   table_url="https://demo.feishu.cn/base/synthetic?table=tblSynthetic")

    def test_opt_in_separate_queue_and_idempotent_retry(self):
        self.assertFalse(self.sync.state()["enabled"])
        self.sync.enqueue(self.insight)
        self.assertEqual(self.sync.state()["pending"], 0)
        with self.assertRaises(HotFeishuError):
            self.sync.configure(enabled=True)
        self.configure()
        self.sync.enqueue(self.insight)
        self.sync.enqueue(self.insight)
        self.assertEqual(self.sync.state()["pending"], 1)
        reopened = HotFeishuSync(self.temp.name, sender=lambda config, payload: self.sent.append(payload), now=lambda: self.clock)
        self.assertEqual(reopened.state()["pending"], 1)
        reopened.db.close()
        self.fail = True
        self.assertFalse(self.sync.tick())
        self.assertEqual(self.sync.state()["retry"], 1)
        self.assertFalse(self.sync.tick())
        self.sync.retry_now()
        self.fail = False
        self.assertTrue(self.sync.tick())
        self.assertEqual(self.sync.state()["synced"], 1)
        self.assertFalse(self.sync.tick())
        self.assertEqual(len(self.sent), 1)
        self.assertNotIn("appId", self.sync.state())
        self.assertNotIn("tableUrl", self.sync.state())
        self.assertTrue((Path(self.temp.name) / "hot-feishu-queue.sqlite3").exists())

    def test_target_required_and_disable_prevents_delivery(self):
        with self.assertRaises(HotFeishuError):
            self.sync.configure(enabled=True, app_id="synthetic_app", app_secret="dummy_secret",
                                table_url="https://invalid.example/base/synthetic?table=tblSynthetic")
        self.configure()
        self.sync.enqueue(self.insight)
        self.sync.configure(enabled=False)
        self.assertFalse(self.sync.tick())
        self.assertEqual(self.sent, [])

    def test_fake_feishu_reconciles_by_key_and_checks_write_response(self):
        calls = []
        class Opener:
            def open(self, request, timeout):
                calls.append(request)
                url = request.full_url
                if url.endswith("tenant_access_token/internal"):
                    result = {"code": 0, "tenant_access_token": "fake-access"}
                elif "/fields?" in url:
                    result = {"code": 0, "data": {"has_more": False,
                        "items": [{"field_name": name, "type": 1} for name in FIELDS.values()]}}
                elif "/records/search" in url:
                    result = {"code": 0, "data": {"items": []}}
                else:
                    result = {"code": 0, "data": {"record": {"record_id": "recSynthetic"}}}
                return io.BytesIO(json.dumps(result).encode())
        config = {"appId": "synthetic_app", "appSecret": "dummy_secret",
                  "appToken": "synthetic", "tableId": "tblSynthetic"}
        payload = {"key": "a" * 64, "term": "合成", "title": "合成热点", "hot": "42",
                   "rank": "1", "sampledAt": "2026-11-12T10:00:00Z", "sourceUpdatedAt": ""}
        with mock.patch("hot_feishu_sync.urllib.request.build_opener", return_value=Opener()):
            HotFeishuSync._send(config, payload)
        self.assertEqual(len(calls), 4)
        self.assertEqual(json.loads(calls[-1].data)["fields"][FIELDS["term"]], "合成")
        self.assertIn("client_token=", calls[-1].full_url)


if __name__ == "__main__":
    unittest.main()
