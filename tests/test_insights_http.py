"""Synthetic HTTP integration for hot insights and team aggregation."""

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
from hot_insights import HotInsights
from operations_workspace import OperationsWorkspace


class SavedCollector:
    def __init__(self):
        self.calls = []

    def call(self, method, args=None, **options):
        self.calls.append((method, options))
        if method != "room.workspace":
            raise AssertionError("unexpected collector request")
        rows = [{"accountId": "synthetic-account", "accountName": "演示来源",
                 "room": {"id": "synthetic-room", "title": "普通演示场次",
                          "startedAt": "2026-11-12T09:00:00Z", "endedAt": "2026-11-12T11:00:00Z"},
                 "metrics": {"entryVisits": {"value": 20, "rawUnit": "number"},
                             "validSales": {"value": 1234, "rawUnit": "price"}},
                 "latest": None}]
        offset = args.get("offset", 0)
        return {"rows": rows[offset:offset + args.get("limit", 100)], "total": 1,
                "hasMore": False, "startDate": "2026-11-01", "endDate": "2026-11-15",
                "accounts": [{"name": "演示来源"}]}


class SavedReviews:
    def list(self, _session_id=None):
        return {"reviews": [{"sessionId": "synthetic-recording", "owner": "演示成员",
                              "actions": "跟进动作词", "summary": "", "dueDate": "2026-11-20"}]}


class SavedLinks:
    def list(self):
        return {"links": [{"accountId": "synthetic-account", "roomId": "synthetic-room",
                            "recordingSessionId": "synthetic-recording"}]}


class PublicHotList:
    def hotwords(self, limit):
        return {"code": 200, "name": "douyin", "updateTime": "2026-11-12T10:00:00Z",
                "data": [{"title": "动作词讨论", "hot": 123, "timestamp": "2026-11-12T10:00:00Z"}]}


class InsightsHttpTests(unittest.TestCase):
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
        self.collector = SavedCollector()
        workspace = OperationsWorkspace(self.temp.name)
        member = workspace.save("teamMembers", {"name": "演示成员", "role": "主播", "active": True})
        workspace.save("accountMappings", {"name": "演示直播号", "sourceAlias": "演示来源",
                                           "memberId": member["id"], "active": True})
        for name, value in (("COLLECTOR", self.collector), ("OPERATIONS_WORKSPACE", workspace),
                            ("HOT_INSIGHTS", HotInsights(self.temp.name)),
                            ("SESSION_REVIEWS", SavedReviews()), ("SESSION_LINKS", SavedLinks()),
                            ("HOTWORDS", PublicHotList())):
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

    def test_hot_refresh_uses_only_saved_sessions_and_confirmed_review_link(self):
        origin = f"http://127.0.0.1:{self.port}"
        self.assertEqual(self.request("POST", "/api/hot-insights/watch", {"term": "动作词"}, origin)[0], 200)
        status, result = self.request("POST", "/api/hot-insights/refresh", {}, origin)
        self.assertEqual(status, 200)
        self.assertEqual(result["terms"][0]["currentHot"], 123)
        self.assertEqual(result["sessions"][0]["matches"][0]["matchedIn"], ["review"])
        self.assertTrue(all(options.get("allow_start") is False for _, options in self.collector.calls))

    def test_team_mapping_and_read_only_mcp_resources(self):
        status, result = self.request("GET", "/api/team-overview")
        self.assertEqual(status, 200)
        self.assertEqual(result["groups"]["accounts"][0]["watch"]["value"], 20)
        self.assertEqual(result["todos"][0]["memberName"], "演示成员")
        status, mcp = self.request("GET", "/api/mcp/read?resource=team_overview")
        self.assertEqual(status, 200)
        self.assertEqual(mcp["loadedSessions"], 1)
        self.assertEqual(self.request("POST", "/api/mcp/read", {})[0], 405)
        self.assertEqual(self.request("GET", "/api/team-overview?startDate=bad")[0], 400)
        self.assertTrue(all(options.get("allow_start") is False for _, options in self.collector.calls))

    def test_foreign_origin_cannot_read_or_mutate_insights(self):
        self.assertEqual(self.request("GET", "/api/hot-insights", origin="https://other.invalid")[0], 403)
        self.assertEqual(self.request("GET", "/api/team-overview", origin="https://other.invalid")[0], 403)
        self.assertEqual(self.request("POST", "/api/hot-insights/watch", {"term": "词"},
                                      origin="https://other.invalid")[0], 403)


if __name__ == "__main__":
    unittest.main()
