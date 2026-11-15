"""MCP contract tests against synthetic HTTP data; never contact production."""

import copy
import json
import os
from pathlib import Path
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mcp_server


ROOT = Path(__file__).resolve().parents[1]
ACCOUNT = "00000000-0000-4000-8000-000000000001"
UID = "9000000000000000001"
ROOM = "8000000000000000001"
RECORDING = "a" * 32
TIME = "2026-11-14T02:01:00Z"
SECRET = "synthetic-private-marker"
PRIVATE_URL = "https://synthetic.feishu.cn/base/synthetic-app?table=synthetic-table"
PRIVATE_APP = "cli_synthetic_private_app"
TOOLS = {
    "get_health", "list_sessions", "get_session",
    "get_spend_reconciliation", "get_hourly_metrics", "get_session_timeline",
    "get_hot_keywords", "list_team_overview",
}
READ_RESOURCES = {
    "state": "/api/rpa/state", "feishu": "/api/rpa/feishu/state",
    "qianchuan": "/api/rpa/providers/qianchuan/status", "sessions": "/api/rpa/room-workspace",
    "session": "/api/rpa/session", "links": "/api/session-links", "timeline": "/api/session-timeline",
    "hot_keywords": "/api/hot-insights", "team_overview": "/api/team-overview",
}


def objects(value):
    """Inspect semantic fields without depending on presentation wrappers."""
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from objects(child)
    elif isinstance(value, list):
        for child in value:
            yield from objects(child)


def find_ref(value, name):
    return next(item[name] for item in objects(value) if item.get(name))


def fixtures():
    metric = {"key": "pay_amt", "value": 12345, "display": "123.45", "unit": "元",
              "rawUnit": "price", "source": "compass_live_snapshot", "note": SECRET}
    account = {"id": ACCOUNT, "uid": UID, "name": SECRET, "label": SECRET,
               "state": "ready", "enabled": True, "busy": False,
               "lastCheck": TIME, "lastSync": TIME, "interval": 60,
               "cookie": SECRET, "token": SECRET, "error": SECRET}
    room = {"id": ROOM, "title": SECRET, "state": "ended",
            "startedAt": "2026-11-14T08:00:00+08:00",
            "endedAt": "2026-11-14T10:00:00+08:00", "url": PRIVATE_URL}
    spend = {
        "compass": {"roomId": ROOM, "amount": "103.00", "display": "103.00", "unit": "元", "time": TIME},
        "qianchuan": {"roomId": ROOM, "amount": "100.00", "display": "100.00", "unit": "元", "time": TIME},
        "status": "匹配", "toleranceYuan": "5", "reason": "差额在 5 元容差内（用户确认）",
        "token": SECRET,
    }
    common = {"account": ACCOUNT, "room": ROOM, "sessionKey": SECRET, "accountAlias": SECRET,
              "hourStart": "2026-11-14 09:00:00", "hourEnd": "2026-11-14 10:00:00",
              "sampledAt": TIME, "status": "已读取", "reason": "", "unit": "元"}
    hourly = [
        {**common, "metricKey": "stat_cost", "metricName": "整体消耗(元)", "value": 12.5, "display": "12.50",
         "source": "巨量千川", "grain": "官方小时", "valueKind": "官方值", "streamState": "下播后重报",
         "version": "post-live:2026-11-14 10:00:00",
         "statisticalWindow": "2026-11-14 00:00:00 至 2026-11-14 23:59:59；当前户、目标直播间、全域直播间报表"},
        {**common, "metricKey": "pay_amt", "metricName": "成交金额", "value": 12345, "display": "123.45",
         "source": "电商罗盘", "grain": "边界快照", "valueKind": "官方页面快照", "streamState": "下播后",
         "version": "post-live:2026-11-14 10:00:00",
         "statisticalWindow": "目标直播间实时大屏；小时边界读数，字段级小时映射未核实"},
        {**common, "metricKey": "stat_cost", "metricName": "千川消耗", "value": 103, "display": "103.00",
         "source": "电商罗盘", "grain": "独立对照", "valueKind": "官方页面快照", "streamState": "下播后",
         "version": "post-live:2026-11-14 10:00:00",
         "statisticalWindow": "罗盘目标直播间实时大屏；账户范围及准确统计起止未定义；非小时消耗"},
        {**common, "metricKey": "online_user_cnt", "metricName": "在线人数", "value": None, "display": "",
         "source": "电商罗盘", "grain": "边界快照", "valueKind": "官方页面快照", "streamState": "下播后",
         "version": "post-live:2026-11-14 10:00:00", "status": "缺失", "reason": SECRET,
         "statisticalWindow": "目标直播间实时大屏；小时边界读数，字段级小时映射未核实"},
    ]
    latest = {"time": TIME, "metrics": [metric], "spendReconciliation": spend,
              "raw": {"cookie": SECRET}, "error": SECRET}
    detail = {"room": room, "latest": latest,
              "history": [{"time": TIME, "metrics": [metric]}], "hourly": hourly,
              "historyReport": {"roomId": ROOM, "retrievedAt": TIME, "endedAt": room["endedAt"],
                                "metrics": [metric], "raw": {"password": SECRET}},
              "raw": {"cookie": SECRET}, "historyRaw": {"token": SECRET}}
    row = {"accountId": ACCOUNT, "accountName": SECRET, "account": account,
           "room": room, "latest": latest, "historyReport": detail["historyReport"],
           "metrics": {"paidAmount": metric},
           "fieldSources": {"liveSnapshot": {"source": "compass_live_snapshot", "sampledAt": TIME}}}
    timeline = {
        "recordingSessionId": RECORDING,
        "identity": {"liveAccountUid": UID, "roomId": ROOM, "recordingRoomId": SECRET,
                     "recorderSessionId": SECRET, "linked": True, "timeZone": "+08:00",
                     "businessStartedAt": room["startedAt"], "businessEndedAt": room["endedAt"]},
        "originAt": room["startedAt"], "partialObservation": True,
        "segments": [{"id": SECRET, "path": "/synthetic/private.flv", "recordingPath": "/synthetic/private.flv",
                      "firstObservedAt": TIME, "lastObservedAt": TIME, "firstObservedOffsetMs": 0,
                      "lastObservedOffsetMs": 60000, "mediaDurationMs": 60000,
                      "timeAlignment": "unverified", "note": SECRET}],
        "gaps": [{"fromAt": TIME, "toAt": TIME, "fromOffsetMs": 0, "toOffsetMs": 0,
                  "status": "unknown", "note": SECRET}],
        "events": [{"type": "observation_gap", "fromAt": TIME, "toAt": TIME,
                    "fromOffsetMs": 0, "toOffsetMs": 0, "note": SECRET}],
        "archive": {"status": "ready", "stage": "complete", "videoPath": "/synthetic/private.mp4", "error": SECRET},
        "business": {"status": "ready", "linked": True, "roomState": "ended", "note": SECRET,
                     "link": {"accountId": ACCOUNT, "accountUid": UID, "roomId": ROOM},
                     "snapshots": [{"sampledAt": TIME, "offsetMs": 60000, "source": "compass_live_snapshot", "metrics": [metric]}],
                     "latest": {"sampledAt": TIME, "metrics": [metric], "source": "compass_live_snapshot"}},
        "sources": {"recording": {"status": "available", "note": SECRET},
                    "comments": {"status": "not_connected", "note": SECRET}},
    }
    return {
        "/api/health": {"service": "liveops-dashboard", "ready": True, "cookie": SECRET},
        "/api/rpa/state": {"ready": True, "accounts": [account], "events": [{"message": SECRET}], "targetName": SECRET},
        "/api/rpa/providers/qianchuan/status": {"state": "logged_in", "checkedAt": TIME,
                                                "pages": [{"origin": PRIVATE_URL, "pathname": SECRET}]},
        "/api/rpa/feishu/state": {"configured": True, "enabled": True, "busy": False, "verified": True,
                                  "lastSuccess": TIME, "lastTest": TIME, "pending": 0, "synced": 3,
                                  "hourlyPending": 0, "hourlySynced": 4, "error": None,
                                  "url": PRIVATE_URL, "appId": PRIVATE_APP, "appSecret": SECRET,
                                  "accountIds": [ACCOUNT], "accounts": [account]},
        "/api/rpa/room-workspace": {"accounts": [account], "startDate": "2026-11-01", "endDate": "2026-11-14",
                                    "total": 1, "offset": 0, "limit": 50, "hasMore": False,
                                    "rows": [row], "rooms": [room], "totals": {}, "summary": {}},
        "/api/rpa/session": detail,
        "/api/session-links": {"links": [{"accountId": ACCOUNT, "accountUid": UID, "roomId": ROOM,
                                           "recordingSessionId": RECORDING, "roomTitle": SECRET}]},
        "/api/session-timeline": timeline,
        "/api/hot-insights": {"terms": [{"term": "合成话题", "firstSeenAt": TIME,
                              "lastSeenAt": TIME, "currentHot": 120, "currentRank": 3,
                              "trend": [{"sampledAt": TIME, "hot": 120, "rank": 3}]}],
                              "sampleCount": 1, "latest": {"items": [{"title": SECRET, "url": PRIVATE_URL}]},
                              "sessions": [{"title": SECRET, "reviewActions": SECRET}]},
        "/api/team-overview": {"available": True, "startDate": "2026-11-01", "endDate": "2026-11-14",
                               "totalSessions": 1, "loadedSessions": 1, "truncated": False, "unmappedSessions": 0,
                               "groups": {"accounts": [{"id": ACCOUNT, "name": SECRET, "sessions": 1,
                                          "watch": {"value": 40, "coveredRooms": 1},
                                          "sales": {"value": 12.34, "coveredRooms": 1},
                                          "spend": {"value": "5.00", "coveredRooms": 1},
                                          "reconciliation": {"matched": 1, "compared": 1, "rate": 1.0}}],
                                          "stores": [], "members": []},
                               "mappings": [{"sourceAlias": SECRET, "accountId": ACCOUNT}],
                               "todos": [{"memberId": ACCOUNT, "actions": SECRET}]},
    }


class SyntheticHttp:
    def __init__(self):
        self.data = fixtures()
        self.calls = []
        self.wire_calls = []
        self.errors = {}
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                parsed = urlsplit(self.path)
                query = parse_qs(parsed.query)
                owner.wire_calls.append(("GET", parsed.path, copy.deepcopy(query)))
                logical_path = parsed.path
                if parsed.path == "/api/mcp/read":
                    logical_path = READ_RESOURCES.get(query.pop("resource", [""])[0], "unknown")
                owner.calls.append(("GET", logical_path, query))
                configured_error = owner.errors.get(parsed.path) or owner.errors.get(logical_path)
                if configured_error:
                    status, body, headers = configured_error
                    encoded = body if isinstance(body, bytes) else json.dumps(body).encode()
                else:
                    status, headers = 200, {}
                    value = copy.deepcopy(owner.data.get(logical_path, {"error": SECRET}))
                    if logical_path == "/api/rpa/room-workspace":
                        offset = int(query.get("offset", [0])[0])
                        limit = int(query.get("limit", [50])[0])
                        value.update(offset=offset, limit=limit, rows=value["rows"][offset:offset + limit])
                    encoded = json.dumps(value, ensure_ascii=False).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                for name, value in headers.items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(encoded)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class McpTests(unittest.TestCase):
    def setUp(self):
        self.http = SyntheticHttp()
        self.addCleanup(self.http.close)
        self.server = mcp_server.MCPServer(mcp_server.LocalAPI(port=self.http.port, timeout=2))
        self.counter = 0
        self.initialize()

    def tearDown(self):
        for method, path, query in self.http.wire_calls:
            self.assertEqual(method, "GET")
            self.assertIn(path, {"/api/health", "/api/mcp/read"})
            if path == "/api/mcp/read":
                self.assertEqual(len(query.get("resource", [])), 1)
                self.assertIn(query["resource"][0], READ_RESOURCES)

    def dispatch(self, method, params=None, server=None):
        self.counter += 1
        message = {"jsonrpc": "2.0", "id": self.counter, "method": method}
        if params is not None:
            message["params"] = params
        return (server or self.server).dispatch(message)

    def initialize(self, server=None, version="2025-11-25"):
        server = server or self.server
        response = self.dispatch("initialize", {"protocolVersion": version,
                                                "capabilities": {}, "clientInfo": {"name": "synthetic-client", "version": "1"}}, server)
        self.assertEqual(response["result"]["protocolVersion"], version)
        self.assertIsNone(server.dispatch({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        return response

    def call(self, name, arguments=None):
        return self.dispatch("tools/call", {"name": name, "arguments": arguments or {}})

    def payload(self, response):
        result = response["result"]
        self.assertFalse(result.get("isError", False), result)
        self.assertIsInstance(result["structuredContent"], dict)
        self.assertEqual(json.loads(result["content"][0]["text"]), result["structuredContent"])
        self.assert_redacted(response)
        return result["structuredContent"]

    def assert_redacted(self, value):
        serialized = json.dumps(value, ensure_ascii=False)
        for private in (ACCOUNT, UID, ROOM, RECORDING, SECRET, PRIVATE_URL, PRIVATE_APP,
                        "/synthetic/private.flv", "/synthetic/private.mp4"):
            self.assertNotIn(private, serialized)

    def session_ref(self):
        return find_ref(self.payload(self.call("list_sessions")), "sessionRef")

    def assert_error(self, response):
        self.assertTrue("error" in response or response.get("result", {}).get("isError"), response)
        self.assert_redacted(response)

    def test_handshake_versions_ping_and_read_only_tool_schemas(self):
        for version in ("2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"):
            candidate = mcp_server.MCPServer(mcp_server.LocalAPI(port=self.http.port))
            reply = self.initialize(candidate, version)
            self.assertIn("tools", reply["result"]["capabilities"])
        self.assertEqual(self.dispatch("ping")["result"], {})
        listed = self.dispatch("tools/list")["result"]["tools"]
        self.assertEqual({tool["name"] for tool in listed}, TOOLS)
        self.assertEqual(self.dispatch("tools/list", {"_meta": {"synthetic": True}})["result"]["tools"], listed)
        for tool in listed:
            self.assertTrue(tool["annotations"]["readOnlyHint"])
            self.assertFalse(tool["annotations"].get("destructiveHint", False))
            self.assertEqual(tool["inputSchema"]["type"], "object")
            self.assertFalse(tool["inputSchema"]["additionalProperties"])
        self.assertEqual(self.http.calls, [])

    def test_health_retains_states_and_hides_all_identity_and_credentials(self):
        value = self.payload(self.call("get_health"))
        self.assertTrue(any(item.get("ready") is True for item in objects(value)))
        self.assertTrue(find_ref(value, "accountRef"))
        self.assertEqual(value["qianchuan"]["state"], "logged_in")
        self.assertEqual(value["feishu"]["synced"], 3)
        self.assertEqual(value["feishu"]["hourlySynced"], 4)
        self.assertEqual({call[1] for call in self.http.calls}, {
            "/api/health", "/api/rpa/state", "/api/rpa/providers/qianchuan/status", "/api/rpa/feishu/state"})

    def test_hot_and_team_tools_project_only_approved_fields(self):
        hot = self.payload(self.call("get_hot_keywords"))
        self.assertEqual(hot["terms"][0]["term"], "合成话题")
        self.assertEqual(hot["terms"][0]["trend"][0]["hot"], 120)
        self.assertNotIn("latest", hot)
        team = self.payload(self.call("list_team_overview"))
        group = team["groups"]["accounts"][0]
        self.assertTrue(group["groupRef"].startswith("group_"))
        self.assertEqual(group["watch"]["coveredRooms"], 1)
        self.assertNotIn("name", group)
        self.assertNotIn("mappings", team)
        self.assertNotIn("todos", team)

    def test_list_detail_and_account_filter_are_opaque(self):
        account_ref = find_ref(self.payload(self.call("get_health")), "accountRef")
        listed = self.payload(self.call("list_sessions", {"accountRef": account_ref,
                                                                  "startDate": "2026-11-01", "endDate": "2026-11-14",
                                                                  "offset": 0, "limit": 1}))
        reference = find_ref(listed, "sessionRef")
        self.assertNotEqual(reference, ROOM)
        detail = self.payload(self.call("get_session", {"sessionRef": reference}))
        self.assertTrue(any(item.get("value") == 12345 for item in objects(detail)))
        query = next(query for _, path, query in self.http.calls if path == "/api/rpa/room-workspace")
        self.assertEqual(query["accounts"], [ACCOUNT])
        detail_query = next(query for _, path, query in self.http.calls if path == "/api/rpa/session")
        self.assertEqual(detail_query["account"], [ACCOUNT])
        self.assertEqual(detail_query["room"], [ROOM])
        self.assertNotIn("raw", detail_query)

    def test_spend_passthrough_keeps_five_yuan_rule_and_missing_distinct(self):
        ref = self.session_ref()
        value = self.payload(self.call("get_spend_reconciliation", {"sessionRef": ref}))
        spend = next(item for item in objects(value) if item.get("status") == "匹配")
        self.assertEqual(spend["toleranceYuan"], "5")
        self.assertEqual(spend["compass"]["amount"], "103.00")
        self.assertEqual(spend["qianchuan"]["amount"], "100.00")
        self.http.data["/api/rpa/session"]["latest"]["spendReconciliation"] = {
            "status": "缺一边", "compass": {**spend["compass"], "roomId": ROOM}, "qianchuan": None,
            "reasons": {"compass": None, "qianchuan": SECRET}}
        value = self.payload(self.call("get_spend_reconciliation", {"sessionRef": ref}))
        self.assertTrue(any(item.get("status") == "缺一边" and item.get("qianchuan") is None for item in objects(value)))

    def test_spend_mismatched_room_is_rejected_without_recalculation(self):
        ref = self.session_ref()
        self.http.data["/api/rpa/session"]["latest"]["spendReconciliation"]["qianchuan"]["roomId"] = "8000000000000000002"
        response = self.call("get_spend_reconciliation", {"sessionRef": ref})
        self.assert_error(response)
        self.assertEqual(response["result"]["structuredContent"]["error"]["code"], "SCOPE_MISMATCH")

    def test_hourly_preserves_sources_grains_versions_zero_and_missing(self):
        ref = self.session_ref()
        value = self.payload(self.call("get_hourly_metrics", {"sessionRef": ref}))
        rows = [item for item in objects(value) if "metricKey" in item]
        self.assertEqual(len(rows), 4)
        self.assertEqual({item["grain"] for item in rows}, {"官方小时", "边界快照", "独立对照"})
        official = next(item for item in rows if item["grain"] == "官方小时")
        self.assertEqual(official["value"], 12.5)
        self.assertEqual(official["streamState"], "下播后重报")
        self.assertEqual(official["version"], "post-live:2026-11-14 10:00:00")
        comparison = next(item for item in rows if item["grain"] == "独立对照")
        self.assertIn("非小时消耗", comparison["statisticalWindow"])
        missing = next(item for item in rows if item["metricKey"] == "online_user_cnt")
        self.assertIsNone(missing["value"])
        self.http.data["/api/rpa/session"]["hourly"][0].update(value=0, display="0.00")
        zero = self.payload(self.call("get_hourly_metrics", {"sessionRef": ref}))
        self.assertTrue(any(item.get("grain") == "官方小时" and item.get("value") == 0 for item in objects(zero)))

    def test_hourly_filter_and_pagination(self):
        ref = self.session_ref()
        value = self.payload(self.call("get_hourly_metrics", {"sessionRef": ref, "source": "电商罗盘",
                                                                 "grain": "边界快照", "offset": 1, "limit": 1}))
        rows = [item for item in objects(value) if "metricKey" in item]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["metricKey"], "online_user_cnt")
        self.assertIsNone(rows[0]["value"])

    def test_timeline_reuses_confirmed_links_and_removes_paths(self):
        value = self.payload(self.call("get_session_timeline", {"sessionRef": self.session_ref()}))
        self.assertTrue(any(item.get("partialObservation") is True for item in objects(value)))
        self.assertTrue(any(item.get("timeAlignment") == "unverified" for item in objects(value)))
        query = next(query for _, path, query in self.http.calls if path == "/api/session-timeline")
        self.assertEqual(query["recordingSessionId"], [RECORDING])

    def test_timeline_statuses_and_source_distinctions_survive_projection(self):
        ref = self.session_ref()
        timeline = self.http.data["/api/session-timeline"]
        for status in ("identity_changed", "room_missing", "no_snapshot", "offline"):
            for source in ("realtime_snapshot", "history_report"):
                with self.subTest(status=status, source=source):
                    timeline["business"]["status"] = status
                    timeline["business"]["latest"]["source"] = source
                    value = self.payload(self.call("get_session_timeline", {"sessionRef": ref}))
                    business = value["timelines"][0]["business"]
                    self.assertEqual(business["status"], status)
                    self.assertEqual(business["latest"]["source"], source)

    def test_history_endpoint_reuse_and_retrieval_times_remain_distinct(self):
        ref = self.session_ref()
        report = self.http.data["/api/rpa/session"]["historyReport"]
        report["endpoints"] = {
            "historyCore": {"ok": True, "reused": True, "retrievedAt": "2026-11-13T02:01:00Z", "error": SECRET},
            "historyTrade": {"ok": False, "reused": False, "retrievedAt": TIME, "url": PRIVATE_URL},
        }
        value = self.payload(self.call("get_session", {"sessionRef": ref}))["historyReport"]
        self.assertEqual(value["endpoints"]["historyCore"], {
            "ok": True, "reused": True, "retrievedAt": "2026-11-13T02:01:00Z"})
        self.assertEqual(value["endpoints"]["historyTrade"], {"ok": False, "reused": False, "retrievedAt": TIME})

    def test_unknown_metric_names_cannot_smuggle_numeric_identity(self):
        ref = self.session_ref()
        private_metric = {"key": "uid", "value": int(UID), "display": UID, "unit": "人", "source": "compass_live_snapshot"}
        detail = self.http.data["/api/rpa/session"]
        detail["latest"]["metrics"].append(copy.deepcopy(private_metric))
        detail["history"][0]["metrics"].append(copy.deepcopy(private_metric))
        detail["historyReport"]["metrics"].append(copy.deepcopy(private_metric))
        detail["hourly"].append({**detail["hourly"][0], "metricKey": "uid", "value": int(UID), "display": UID})
        timeline = self.http.data["/api/session-timeline"]
        timeline["business"]["latest"]["metrics"].append(copy.deepcopy(private_metric))
        for name in ("get_session", "get_hourly_metrics", "get_session_timeline"):
            with self.subTest(tool=name):
                value = self.payload(self.call(name, {"sessionRef": ref}))
                self.assertTrue(all(item.get("key") != "uid" and item.get("metricKey") != "uid" for item in objects(value)))

    def test_unlinked_timeline_does_not_fetch_arbitrary_recording(self):
        ref = self.session_ref()
        self.http.data["/api/session-links"] = {"links": []}
        response = self.call("get_session_timeline", {"sessionRef": ref})
        self.assert_redacted(response)
        self.assertNotIn("/api/session-timeline", [call[1] for call in self.http.calls])

    def test_unknown_and_expired_refs_are_rejected_without_http(self):
        ref = self.session_ref()
        other = mcp_server.MCPServer(mcp_server.LocalAPI(port=self.http.port))
        self.initialize(other)
        before = len(self.http.calls)
        for invalid in (ROOM, "session_unknown", "../" + SECRET):
            self.assert_error(self.call("get_session", {"sessionRef": invalid}))
        self.assert_error(self.dispatch("tools/call", {"name": "get_session", "arguments": {"sessionRef": ref}}, other))
        self.assertEqual(len(self.http.calls), before)

    def test_invalid_tool_arguments_never_reach_http(self):
        before = len(self.http.calls)
        for name, arguments in [
            ("get_health", {"token": SECRET}),
            ("list_sessions", {"accountRef": ACCOUNT}),
            ("list_sessions", {"offset": -1}),
            ("list_sessions", {"offset": True}),
            ("list_sessions", {"limit": 101}),
            ("list_sessions", {"limit": 0}),
            ("list_sessions", {"startDate": "2026-02-30"}),
            ("list_sessions", {"startDate": "2026-11-14", "endDate": "2026-11-01"}),
            ("get_session", {}),
            ("get_session", {"sessionRef": 1}),
            ("get_hourly_metrics", {"sessionRef": "unknown", "limit": 101}),
            ("get_hourly_metrics", {"sessionRef": "unknown", "source": PRIVATE_URL}),
            ("liveops_delete_data", {}),
        ]:
            with self.subTest(name=name, arguments=arguments):
                self.assert_error(self.call(name, arguments))
        self.assertEqual(len(self.http.calls), before)

    def test_unavailable_service_is_clear_and_does_not_start_anything(self):
        with socket.socket() as reserved:
            reserved.bind(("127.0.0.1", 0))
            port = reserved.getsockname()[1]
            unavailable = mcp_server.MCPServer(mcp_server.LocalAPI(port=port, timeout=0.2))
            self.initialize(unavailable)
            response = self.dispatch("tools/call", {"name": "get_health", "arguments": {}}, unavailable)
        self.assert_error(response)
        serialized = json.dumps(response, ensure_ascii=False)
        self.assertTrue(any(word in serialized for word in ("未启动", "不可用", "无法连接")), serialized)
        self.assertEqual(self.http.calls, [])

    def test_http_failure_body_and_redirect_are_never_exposed_or_followed(self):
        ref = self.session_ref()
        for status, body, headers in (
            (503, {"error": SECRET, "url": PRIVATE_URL}, {}),
            (200, b"<html>" + SECRET.encode() + b"</html>", {}),
            (302, {"error": SECRET}, {"Location": f"http://127.0.0.1:{self.http.port}/synthetic-redirect"}),
        ):
            with self.subTest(status=status):
                self.http.errors["/api/rpa/session"] = (status, body, headers)
                self.assert_error(self.call("get_session", {"sessionRef": ref}))
        self.assertNotIn("/synthetic-redirect", [call[1] for call in self.http.calls])

    def test_old_dashboard_without_read_only_endpoint_has_no_legacy_fallback(self):
        self.http.errors["/api/mcp/read"] = (404, {"error": SECRET}, {})
        response = self.call("list_sessions")
        self.assert_error(response)
        self.assertEqual(response["result"]["structuredContent"]["error"]["code"], "READ_ONLY_API_REQUIRED")
        self.assertEqual(len(self.http.wire_calls), 1)
        self.assertEqual(self.http.wire_calls[0], ("GET", "/api/mcp/read", {"resource": ["sessions"]}))
        health = self.payload(self.call("get_health"))
        self.assertTrue(health["dashboard"]["ready"])
        for provider in ("compass", "qianchuan", "feishu"):
            self.assertEqual(health[provider]["error"]["code"], "READ_ONLY_API_REQUIRED")

    def test_poisoned_public_text_and_unknown_fields_fail_closed(self):
        ref = self.session_ref()
        detail = self.http.data["/api/rpa/session"]
        detail["room"]["state"] = SECRET
        detail["room"]["startedAt"] = PRIVATE_URL
        for metric in detail["latest"]["metrics"]:
            metric.update(label=SECRET, unit=SECRET, source=PRIVATE_URL, display=SECRET)
        for row in detail["hourly"]:
            row.update(metricName=SECRET, unit=SECRET, source=SECRET, grain=SECRET,
                       status=SECRET, streamState=SECRET, valueKind=SECRET,
                       statisticalWindow=PRIVATE_URL, version=SECRET, sampledAt=PRIVATE_URL,
                       newUnknownField={"password": SECRET})
        detail["latest"]["spendReconciliation"].update(status=SECRET, reason=SECRET)
        self.payload(self.call("get_session", {"sessionRef": ref}))
        self.payload(self.call("get_hourly_metrics", {"sessionRef": ref}))
        self.payload(self.call("get_spend_reconciliation", {"sessionRef": ref}))

    def test_malformed_upstream_shapes_do_not_crash_or_echo_payload(self):
        ref = self.session_ref()
        for malformed in (None, [], SECRET, {"room": None, "latest": SECRET, "hourly": SECRET}):
            with self.subTest(shape=type(malformed).__name__):
                self.http.data["/api/rpa/session"] = malformed
                response = self.call("get_session", {"sessionRef": ref})
                self.assertIsInstance(response, dict)
                self.assert_redacted(response)

    def test_local_http_client_rejects_invalid_ports(self):
        for port in (0, -1, 65536, True, PRIVATE_URL):
            with self.subTest(port=port), self.assertRaises((TypeError, ValueError)):
                mcp_server.LocalAPI(port=port)

    def test_protocol_errors_notifications_and_handshake_order(self):
        before = len(self.http.calls)
        self.assertEqual(self.dispatch("synthetic/unknown")["error"]["code"], -32601)
        self.assertIsNone(self.server.dispatch({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 1}}))
        self.assertIsNone(self.server.dispatch({"jsonrpc": "2.0", "method": "tools/call", "params": {"name": "get_health"}}))
        uninitialized = mcp_server.MCPServer(mcp_server.LocalAPI(port=self.http.port))
        self.assert_error(self.dispatch("tools/list", server=uninitialized))
        self.assertEqual(len(self.http.calls), before)


class McpStdioTests(unittest.TestCase):
    def test_real_stdio_process_handshake_and_each_tool(self):
        http = SyntheticHttp()
        self.addCleanup(http.close)
        temp = tempfile.TemporaryDirectory(prefix="liveops-mcp-中文 空格-")
        self.addCleanup(temp.cleanup)
        env = dict(os.environ, LIVEOPS_DATA_ROOT=temp.name, LIVEOPS_MCP_PORT=str(http.port), PYTHONUTF8="1")
        process = subprocess.Popen([sys.executable, "-u", str(ROOT / "mcp_server.py")],
                                   cwd=temp.name, env=env, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
        output = queue.Queue()
        reader = threading.Thread(target=lambda: [output.put(line) for line in process.stdout], daemon=True)
        reader.start()

        def cleanup():
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()
            reader.join(timeout=5)

        self.addCleanup(cleanup)
        identifier = 0

        def send(method, params=None, notification=False):
            nonlocal identifier
            identifier += 1
            message = {"jsonrpc": "2.0", "method": method}
            if not notification:
                message["id"] = identifier
            if params is not None:
                message["params"] = params
            process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
            process.stdin.flush()
            if notification:
                return None
            response = json.loads(output.get(timeout=8))
            self.assertEqual(response["id"], identifier)
            return response

        def call(name, arguments=None):
            response = send("tools/call", {"name": name, "arguments": arguments or {}})
            result = response["result"]
            self.assertFalse(result.get("isError", False), result)
            self.assertEqual(json.loads(result["content"][0]["text"]), result["structuredContent"])
            serialized = json.dumps(response, ensure_ascii=False)
            for private in (ACCOUNT, UID, ROOM, SECRET, PRIVATE_URL, PRIVATE_APP):
                self.assertNotIn(private, serialized)
            return result["structuredContent"]

        initialized = send("initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
                                          "clientInfo": {"name": "synthetic-stdio-client", "version": "1"}})
        self.assertEqual(initialized["result"]["protocolVersion"], "2025-11-25")
        send("notifications/initialized", notification=True)
        process.stdin.write("{malformed synthetic json}\n")
        process.stdin.flush()
        malformed = json.loads(output.get(timeout=8))
        self.assertEqual(malformed["error"]["code"], -32700)
        self.assertIsNone(malformed["id"])
        self.assertEqual({item["name"] for item in send("tools/list")["result"]["tools"]}, TOOLS)
        call("get_health")
        reference = find_ref(call("list_sessions"), "sessionRef")
        for name in TOOLS - {"get_health", "list_sessions", "get_hot_keywords", "list_team_overview"}:
            call(name, {"sessionRef": reference})
        call("get_hot_keywords")
        call("list_team_overview")
        process.stdin.close()
        self.assertEqual(process.wait(timeout=8), 0)
        reader.join(timeout=5)
        self.assertTrue(output.empty(), "stdout must contain protocol responses only")
        self.assertEqual(process.stderr.read(), "")
        self.assertEqual(list(Path(temp.name).iterdir()), [], "MCP must not create a data directory or state files")
        self.assertEqual({method for method, _, _ in http.wire_calls}, {"GET"})
        self.assertEqual({path for _, path, _ in http.wire_calls}, {"/api/health", "/api/mcp/read"})
        self.assertEqual({query["resource"][0] for _, path, query in http.wire_calls if path == "/api/mcp/read"},
                         set(READ_RESOURCES))


if __name__ == "__main__":
    unittest.main()
