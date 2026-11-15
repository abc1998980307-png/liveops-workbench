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
from operations_workspace import OperationsWorkspace, WorkspaceError


class OperationsWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = OperationsWorkspace(self.temp.name)

    def test_local_records_upsert_and_keep_related_ids(self):
        member = self.store.save("teamMembers", {"name":"主播甲", "role":"主播", "active":True})
        shift = self.store.save("shifts", {"date":"2026-11-11", "memberId":member["id"], "role":"主播",
                                             "start":"10:00", "end":"12:00", "status":"planned"})
        store = self.store.save("stores", {"name":"示例店铺", "platform":"douyin", "active":True})
        product = self.store.save("products", {"storeId":store["id"], "name":"商品甲", "price":"12.50", "status":"active"})
        brand = self.store.save("brands", {"name":"品牌甲", "storeId":store["id"], "active":True})
        goal = self.store.save("goals", {"date":"2026-11-11", "account":"直播号甲", "targetGmv":"10000", "targetOrders":"50"})

        snapshot = OperationsWorkspace(self.temp.name).snapshot()
        self.assertEqual(len(snapshot["teamMembers"]), 1)
        self.assertEqual(snapshot["shifts"][0]["memberId"], member["id"])
        self.assertEqual(snapshot["products"][0]["storeId"], store["id"])
        self.assertEqual(snapshot["brands"][0]["storeId"], store["id"])
        self.assertEqual(snapshot["goals"][0]["id"], goal["id"])
        self.assertEqual(product["price"], "12.50")
        self.assertEqual(shift["status"], "planned")
        self.assertEqual(brand["name"], "品牌甲")

    def test_update_preserves_id_and_creation_time(self):
        created = self.store.save("teamMembers", {"name":"主播甲", "role":"主播", "active":True})
        updated = self.store.save("teamMembers", {"id":created["id"], "name":"主播乙", "role":"主播", "active":False})
        self.assertEqual(updated["id"], created["id"])
        self.assertEqual(updated["createdAt"], created["createdAt"])
        self.assertEqual(updated["name"], "主播乙")
        self.assertFalse(updated["active"])
        self.assertEqual(len(self.store.snapshot()["teamMembers"]), 1)

    def test_rejects_invalid_dates_prices_enums_and_missing_relationships(self):
        invalid_records = [
            ("shifts", {"date":"20261111", "memberId":"missing", "role":"主播"}),
            ("shifts", {"date":"2026-11-11", "memberId":"missing", "role":"主播"}),
            ("products", {"storeId":"missing", "name":"商品甲", "price":"1e4", "status":"active"}),
            ("products", {"storeId":"missing", "name":"商品甲", "price":"-1", "status":"active"}),
            ("stores", {"name":"示例店铺", "platform":"unknown", "active":True}),
            ("goals", {"date":"20261111", "account":"直播号甲", "targetGmv":"10000"}),
        ]
        for collection, payload in invalid_records:
            with self.subTest(collection=collection, payload=payload), self.assertRaises(WorkspaceError):
                self.store.save(collection, payload)
        self.assertTrue(all(not rows for rows in self.store.snapshot().values() if isinstance(rows, list)))

    def test_corrupt_file_is_preserved(self):
        original = b'{"schemaVersion":1,"teamMembers":"bad"}'
        self.store.file.write_bytes(original)
        with self.assertRaises(WorkspaceError):
            self.store.snapshot()
        self.assertEqual(self.store.file.read_bytes(), original)


class OperationsWorkspaceHttpTests(unittest.TestCase):
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
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        patcher = mock.patch.object(server, "OPERATIONS_WORKSPACE", OperationsWorkspace(self.temp.name))
        patcher.start()
        self.addCleanup(patcher.stop)

    def request(self, method, path, value=None, origin=None):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8") if value is not None else None
        headers = {"Host":f"127.0.0.1:{self.port}", "Content-Type":"application/json"}
        if origin:
            headers["Origin"] = origin
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        result = response.status, response.read()
        connection.close()
        return result

    def test_local_get_and_post_share_saved_workspace(self):
        status, body = self.request("POST", "/api/operations-workspace/teamMembers",
                                    {"name":"主播甲", "role":"主播", "active":True},
                                    f"http://127.0.0.1:{self.port}")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["record"]["name"], "主播甲")
        status, body = self.request("GET", "/api/operations-workspace")
        self.assertEqual(status, 200)
        self.assertEqual(len(json.loads(body)["teamMembers"]), 1)

    def test_static_page_serves_the_operations_module(self):
        status, body = self.request("GET", "/operations-ui.js")
        self.assertEqual(status, 200)
        self.assertIn(b"LiveOperations", body)

    def test_foreign_origin_cannot_read_or_write_local_records(self):
        status, _ = self.request("GET", "/api/operations-workspace", origin="https://attacker.example")
        self.assertEqual(status, 403)
        status, _ = self.request("POST", "/api/operations-workspace/teamMembers",
                                 {"name":"主播甲", "role":"主播", "active":True},
                                 origin="https://attacker.example")
        self.assertEqual(status, 403)


if __name__ == "__main__":
    unittest.main()
