#!/usr/bin/env python3
"""Read-only MCP stdio adapter. No dashboard imports, storage or collector startup.

Only schema-approved scalars leave this process. Identity references are random,
in-memory handles, valid for the lifetime of this MCP connection.
"""
import argparse
from datetime import date
import http.client
import json
import math
import os
import re
import sys
import uuid

from service_status import compass_status, feishu_status

PROTOCOLS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
MAX_HTTP_BYTES = 16 * 1024 * 1024
MAX_REQUEST_BYTES = 64 * 1024
STATES = set("unknown ready paused needs_login account_changed rate_limited partial error unconfigured checking stale unverified pending waiting_data unavailable live ended authenticated account_selection logged_in logged_out login_required not_logged_in logged_in_select_account logged_in_account_home".split())
STATES.update({"needs_account", "select_account", "account_home", "not_connected", "authorization_unknown", "unlinked", "missing", "available", "unobserved", "observation_gap", "running", "completed", "failed", "queued", "identity_changed", "room_missing", "no_snapshot", "offline"})
METRICS = {
    "online_user_cnt": "在线人数", "pay_ucnt": "支付人数", "pay_amt": "成交金额",
    "pay_combo_cnt": "成交订单", "gpm": "千次观看成交额", "watch_pay_ucnt_ratio": "观看支付转化",
    "avg_watch_duration": "平均观看时长", "follow_anchor_ucnt": "新增关注",
    "watch_ucnt": "进入直播间人次", "t7payin8d_predstl_ord_cnt": "结算有效成交订单量",
    "t7payin8d_predstl_ord_amt": "结算有效成交金额", "stat_cost": "消耗",
}
SOURCES = {"compass_live_snapshot", "compass_history", "compass_history_detail", "realtime_snapshot", "history_report", "historyCore", "historyTrade", "historyBasic", "电商罗盘", "巨量千川", "千川同场报表"}
UNITS = {"", "元", "分", "人", "人次", "单", "次", "%", "秒", "分钟", "万", "万次", "万人", "万元", "number", "price", "ratio", "duration", "time"}
REASONS = {"", "未采集", "采集失败", "采样已过期", "单位未对齐", "采样时间未对齐",
           "差额在 5 元容差内（用户确认）", "小时边界快照指标未返回可核验数值", "罗盘千川消耗未返回"}
WINDOWS = {
    "目标直播间实时大屏；小时边界读数，字段级小时映射未核实",
    "罗盘目标直播间实时大屏；账户范围及准确统计起止未定义；非小时消耗",
    "当前户、目标直播间、全域直播间报表；官方小时桶未取得",
}


class ToolError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def number(value):
    return value if type(value) in (int, float) and math.isfinite(value) else None


def boolean(value):
    return value if type(value) is bool else None


def choice(values):
    return lambda value: value if isinstance(value, str) and value in values else None


def pattern(expression):
    compiled = re.compile(expression)
    return lambda value: value if isinstance(value, str) and compiled.fullmatch(value) else None


stamp = pattern(r"\d{4}[-/]\d{2}[-/]\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?")
decimal = pattern(r"-?\d{1,24}(?:\.\d{1,12})?")
display = pattern(r"(?:—|[-+]?\d[\d,.]*(?:\s*(?:元|万|亿|人|次|单|%|秒|分钟))?)?")
state = choice(STATES)
reason = lambda value: value if isinstance(value, str) and value in REASONS else (None if value is None else "原始说明已脱敏，请在工作台查看")


def statistical_window(value):
    if isinstance(value, str) and (value in WINDOWS or re.fullmatch(
            r"\d{4}-\d{2}-\d{2} 00:00:00 至 \d{4}-\d{2}-\d{2} 23:59:59；当前户、目标直播间、全域直播间报表", value)):
        return value
    return None


def project(value, schema):
    """Deny unknown fields and free text, including nested errors/URLs/identities."""
    if value is None:
        return None
    if isinstance(schema, dict):
        if not isinstance(value, dict):
            return None
        return {key: project(value[key], rule) for key, rule in schema.items() if key in value}
    if isinstance(schema, list):
        if not isinstance(value, list):
            return None
        # Unknown metric names must not turn into unlabeled numeric identities.
        key = "key" if schema[0] is METRIC else "metricKey" if schema[0] is HOURLY else None
        return [project(item, schema[0]) for item in value
                if key is None or (isinstance(item, dict) and item.get(key) in METRICS)]
    return schema(value)


METRIC = {"key": choice(set(METRICS)), "label": choice(set(METRICS.values())), "value": number, "display": display,
          "unit": choice(UNITS), "rawUnit": choice(UNITS), "source": choice(SOURCES), "retrievedAt": stamp}
SPEND_SIDE = {"amount": decimal, "display": display, "unit": choice(UNITS), "time": stamp}
SPEND = {"compass": SPEND_SIDE, "qianchuan": SPEND_SIDE,
         "status": choice({"匹配", "不匹配", "缺一边", "尚未采集"}),
         "reason": reason, "reasons": {"compass": reason, "qianchuan": reason}, "toleranceYuan": decimal}
ROOM = {"state": state, "startedAt": stamp, "endedAt": stamp, "updatedAt": stamp}
SNAPSHOT = {"time": stamp, "sampledAt": stamp, "state": state, "metrics": [METRIC],
            "spendReconciliation": SPEND, "source": choice(SOURCES)}
REPORT = {"retrievedAt": stamp, "startedAt": stamp, "endedAt": stamp, "roomState": state,
          "source": choice(SOURCES), "metrics": [METRIC],
          "endpoints": {key: {"ok": boolean, "reused": boolean, "retrievedAt": stamp}
                        for key in ("historyBasic", "historyCore", "historyTrade")}}
HOURLY = {"source": choice(SOURCES), "metricKey": choice(set(METRICS)),
          "metricName": choice(set(METRICS.values()) | {"千川消耗", "整体消耗(元)"}),
          "value": number, "display": display, "unit": choice(UNITS),
          "grain": choice({"官方小时", "边界快照", "独立对照"}), "statisticalWindow": statistical_window,
          "hourStart": stamp, "hourEnd": stamp, "sampledAt": stamp,
          "streamState": choice({"在播读数", "下播后重报", "在播观测", "下播后", "直播状态待确认"}),
          "valueKind": choice({"官方值", "官方页面快照", "未取得官方值"}),
          "status": choice({"已读取", "缺失", "失败"}), "reason": reason,
          "version": pattern(r"(?:live|post-live|unknown):\d{4}-\d{2}-\d{2} \d{2}:00:00")}
ACCOUNT = {"state": state, "enabled": boolean, "busy": boolean, "historyBusy": boolean,
           "lastCheck": stamp, "lastSync": stamp, "nextSync": stamp}
TIMED = {"fromAt": stamp, "toAt": stamp, "fromOffsetMs": number, "toOffsetMs": number,
         "status": state, "type": choice({"observation_gap", "file_change", "started", "ended", "segment_changed"})}
TIMELINE = {
    "originAt": stamp, "partialObservation": boolean,
    "identity": {"recordingStartedAt": stamp, "recordingEndedAt": stamp, "businessStartedAt": stamp,
                 "businessEndedAt": stamp, "timeZone": pattern(r"[+-]\d{2}:\d{2}"), "linked": boolean},
    "segments": [{"firstObservedAt": stamp, "lastObservedAt": stamp,
                  "firstObservedOffsetMs": number, "lastObservedOffsetMs": number,
                  "mediaDurationMs": number, "timeAlignment": choice({"unverified"})}],
    "gaps": [TIMED], "events": [TIMED],
    "archive": {"status": state, "stage": choice({"merge", "transcribe", "completed", "complete", "failed", "等待归档", "准备归档", "归档完成"}),
                "unknownGaps": boolean, "partialObservation": boolean},
    "business": {"status": state, "linked": boolean, "roomState": state,
                 "roomStartedAt": stamp, "roomEndedAt": stamp,
                 "accountHealth": ACCOUNT, "historyReport": REPORT, "latest": SNAPSHOT,
                 "snapshots": [{"sampledAt": stamp, "offsetMs": number, "metrics": [METRIC], "source": choice(SOURCES)}]},
    "sources": {key: {"status": state, "lastSuccessAt": stamp} for key in
                ("recording", "archive", "compass", "subtitles", "comments", "products", "shifts", "shop")},
}


class LocalAPI:
    RESOURCES = {"/api/rpa/state": "state", "/api/rpa/feishu/state": "feishu",
                 "/api/rpa/providers/qianchuan/status": "qianchuan",
                 "/api/rpa/room-workspace": "sessions", "/api/rpa/session": "session",
                 "/api/session-links": "links", "/api/session-timeline": "timeline",
                 "/api/hot-insights": "hot_keywords", "/api/team-overview": "team_overview"}

    def __init__(self, port=8765, timeout=15):
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError("端口必须为 1–65535")
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= 60:
            raise ValueError("超时必须大于 0 且不超过 60 秒")
        self.port, self.timeout = port, timeout

    def get(self, path, **params):
        from urllib.parse import urlencode
        if path != "/api/health" and path not in self.RESOURCES:
            raise ToolError("ENDPOINT_NOT_ALLOWED", "未开放此接口")
        readonly = path != "/api/health"
        if readonly:
            params = {"resource": self.RESOURCES[path], **params}
            path = "/api/mcp/read"
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=self.timeout)
        try:
            connection.request("GET", path + ("?" + urlencode(params) if params else ""),
                               headers={"Accept": "application/json"})
            response = connection.getresponse()
            # Never follow redirects or echo an upstream error body.
            if response.status in (401, 403):
                raise ToolError("ACCESS_REQUIRED", "本地接口拒绝访问；已停止此调用，不执行登录或扫码")
            if response.status == 404:
                raise ToolError("READ_ONLY_API_REQUIRED" if readonly else "NOT_FOUND",
                                "本地只读接口或场次不存在；请确认工作台版本支持 /api/mcp/read；MCP 不会回退到可能启动采集器的旧接口")
            if response.status != 200:
                raise ToolError("UPSTREAM_ERROR", "本地工作台接口暂不可用；未启动或重启任何服务")
            raw = response.read(MAX_HTTP_BYTES + 1)
            if len(raw) > MAX_HTTP_BYTES:
                raise ToolError("RESPONSE_TOO_LARGE", "本地响应过大，请缩小查询范围")
            data = json.loads(raw)
            if not isinstance(data, dict) or data.get("error"):
                raise ToolError("UPSTREAM_ERROR", "本地接口返回异常；原始错误已隐藏")
            return data
        except (OSError, http.client.HTTPException):
            raise ToolError("SERVICE_UNAVAILABLE", "无法连接本机工作台，请确认服务已在配置端口运行；MCP 不会自动启动或重启服务") from None
        except (ValueError, UnicodeError, RecursionError):
            raise ToolError("INVALID_RESPONSE", "本地接口返回了无效数据；原始内容已隐藏") from None
        finally:
            connection.close()


def tool(name, description, properties=None, required=()):
    return {"name": name, "description": description,
            "inputSchema": {"type": "object", "properties": properties or {},
                            "required": list(required), "additionalProperties": False},
            "annotations": {"readOnlyHint": True, "destructiveHint": False,
                            "idempotentHint": True, "openWorldHint": False}}


REF = {"type": "string", "pattern": "^session_[a-f0-9]{32}$", "description": "本连接 list_sessions 返回的 sessionRef；重连后重新列出"}
PAGE = {"offset": {"type": "integer", "minimum": 0, "maximum": 1000000, "default": 0},
        "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 50}}
TOOLS = [
    tool("get_health", "读取工作台健康、罗盘采集、千川已观测登录状态及飞书同步状态；不核验登录、不采集"),
    tool("list_sessions", "列出已保存经营场次；日期默认沿用工作台近30天；不采集历史记录", {
        "accountRef": {"type": "string", "pattern": "^account_[a-f0-9]{32}$", "description": "get_health 或本工具返回的 accountRef；省略为全部"},
        "startDate": {"type": "string", "format": "date"}, "endDate": {"type": "string", "format": "date"},
        "omitLive": {"type": "boolean", "default": False}, **PAGE}),
    tool("get_session", "读取单场已保存详情、最近最多120个快照及历史报表；原值、单位和来源分别保留", {"sessionRef": REF}, ("sessionRef",)),
    tool("get_spend_reconciliation", "读取同场罗盘/千川现有消耗对账结果，沿用5元容差，不重新计算", {"sessionRef": REF}, ("sessionRef",)),
    tool("get_hourly_metrics", "读取小时明细，保留官方小时/边界快照/独立对照、统计窗口和版本；不刷新、不做差分", {
        "sessionRef": REF, "source": {"type": "string", "enum": ["电商罗盘", "巨量千川"]},
        "grain": {"type": "string", "enum": ["官方小时", "边界快照", "独立对照"]}, **PAGE}, ("sessionRef",)),
    tool("get_session_timeline", "读取经营场次已确认关联的录制复盘时间轴；无关联时明确返回空，不自动建立关联", {"sessionRef": REF}, ("sessionRef",)),
    tool("get_hot_keywords", "读取本机监控的公开热点词、采样趋势和首次观察时间；不刷新榜单"),
    tool("list_team_overview", "读取本机已保存的团队/店铺/直播号聚合与复盘待办数量；不采集、不返回账户身份或复盘原文"),
]


def validate(arguments, schema):
    if not isinstance(arguments, dict) or set(arguments) - set(schema["properties"]) or set(schema["required"]) - set(arguments):
        raise ToolError("INVALID_ARGUMENTS", "参数缺失或包含未开放字段，请按工具参数定义调用")
    for key, value in arguments.items():
        rule = schema["properties"][key]
        kind = rule["type"]
        if ((kind == "string" and (not isinstance(value, str) or len(value) > 128)) or
                (kind == "integer" and type(value) is not int) or (kind == "boolean" and type(value) is not bool)):
            raise ToolError("INVALID_ARGUMENTS", "参数类型无效")
        if "enum" in rule and value not in rule["enum"]:
            raise ToolError("INVALID_ARGUMENTS", "参数不在支持范围内")
        if "pattern" in rule and not re.fullmatch(rule["pattern"], value):
            raise ToolError("INVALID_ARGUMENTS", "引用格式无效，请先列出本连接中的场次")
        if kind == "integer" and not rule["minimum"] <= value <= rule["maximum"]:
            raise ToolError("INVALID_ARGUMENTS", "分页参数超出支持范围")
        if rule.get("format") == "date":
            try:
                if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                    raise ValueError()
                date.fromisoformat(value)
            except ValueError:
                raise ToolError("INVALID_ARGUMENTS", "日期必须是有效的 YYYY-MM-DD") from None
    if arguments.get("startDate", "") > arguments.get("endDate", "9999-12-31"):
        raise ToolError("INVALID_ARGUMENTS", "开始日期不能晚于结束日期")


class LiveOpsTools:
    def __init__(self, api):
        self.api = api
        self.references = {}
        self.reverse = {}

    def reference(self, kind, value):
        key = (kind, tuple(value))
        if key not in self.reverse:
            if len(self.references) >= 100000:
                raise ToolError("REFERENCE_LIMIT", "本连接引用数已达上限，请重新连接 MCP")
            ref = kind + "_" + uuid.uuid4().hex
            self.reverse[key] = ref
            self.references[ref] = key
        return self.reverse[key]

    def resolve(self, kind, ref):
        saved = self.references.get(ref)
        if not saved or saved[0] != kind:
            raise ToolError("UNKNOWN_REFERENCE", "引用不存在或已随 MCP 重连失效，请重新列出场次")
        return saved[1]

    def account(self, account):
        result = project(account, ACCOUNT)
        if isinstance(account.get("id"), str) and account["id"]:
            result["accountRef"] = self.reference("account", (account["id"],))
        result["hasError"] = bool(account.get("error"))
        return result

    def health(self):
        health = self.api.get("/api/health")
        if health.get("service") != "liveops-dashboard" or health.get("ready") is not True:
            raise ToolError("WRONG_SERVICE", "配置端口未返回直播操盘台健康标识")
        result = {"dashboard": {"service": "liveops-dashboard", "ready": True,
                                "readOnlyMcp": health.get("readOnlyMcp") is True}}
        readers = (
            ("compass", "/api/rpa/state"),
            ("qianchuan", "/api/rpa/providers/qianchuan/status"),
            ("feishu", "/api/rpa/feishu/state"),
        )
        for name, path in readers:
            try:
                data = self.api.get(path)
                if name == "compass":
                    summary = compass_status(data)
                    result[name] = {"state": summary["state"], "connected": summary["connected"],
                                    "lastCheck": stamp(summary["lastCheck"]), "counts": summary["counts"],
                                    "accounts": [self.account(a) for a in data["accounts"]]}
                elif name == "qianchuan":
                    result[name] = project(data, {"state": state, "checkedAt": stamp})
                else:
                    summary = feishu_status(data)
                    result[name] = project(data, {**{key: boolean for key in ("configured", "enabled", "busy", "verified", "historyEnabled", "hourlyTableReady")},
                                                  **{key: number for key in ("pending", "synced", "historyPending", "historySynced", "hourlyPending", "hourlySynced")},
                                                  **{key: stamp for key in ("lastSuccess", "lastTest", "nextRetry")}})
                    result[name].update(state=summary["state"], connected=summary["connected"], hasError=bool(data.get("error")))
            except ToolError as error:
                result[name] = {"state": "unavailable", "error": {"code": error.code, "message": str(error)}}
                if error.code == "ACCESS_REQUIRED":
                    break
        return result

    def list_sessions(self, args):
        params = {key: value for key, value in args.items() if key != "accountRef"}
        if "accountRef" in args:
            params["accounts"] = self.resolve("account", args["accountRef"])[0]
        if "omitLive" in params:
            params["omitLive"] = int(params["omitLive"])
        data = self.api.get("/api/rpa/room-workspace", **params)
        result = project(data, {"total": number, "offset": number, "limit": number, "hasMore": boolean,
                                "startDate": stamp, "endDate": stamp})
        result["accounts"] = [self.account(a) for a in data.get("accounts", [])]
        sessions = []
        for row in data.get("rows", []):
            room, account_id = row.get("room"), row.get("accountId")
            if not isinstance(room, dict) or not isinstance(room.get("id"), str) or not isinstance(account_id, str):
                raise ToolError("INVALID_RESPONSE", "场次接口缺少内部关联字段")
            sessions.append({"sessionRef": self.reference("session", (account_id, room["id"])),
                             "accountRef": self.reference("account", (account_id,)),
                             "room": project(room, ROOM), "latest": project(row.get("latest"), SNAPSHOT),
                             "historyReport": project(row.get("historyReport"), REPORT)})
        result["sessions"] = sessions
        return result

    def hot_keywords(self):
        data = self.api.get("/api/hot-insights")
        terms = []
        for row in data.get("terms", [])[:50]:
            if not isinstance(row, dict) or not isinstance(row.get("term"), str):
                continue
            term = row["term"]
            if not 1 <= len(term) <= 40 or any(ord(char) < 32 for char in term):
                continue
            terms.append({"term": term, "firstSeenAt": stamp(row.get("firstSeenAt")),
                          "lastSeenAt": stamp(row.get("lastSeenAt")),
                          "currentHot": number(row.get("currentHot")),
                          "currentRank": number(row.get("currentRank")),
                          "trend": [project(point, {"sampledAt": stamp, "hot": number, "rank": number})
                                    for point in row.get("trend", [])[:72] if isinstance(point, dict)]})
        return {"terms": terms, "sampleCount": number(data.get("sampleCount")),
                "source": "DailyHotApi", "note": "首次观察时间是本机记录时间，不代表实际首次上榜时间"}

    def team_overview(self):
        data = self.api.get("/api/team-overview")
        groups = {}
        todo_counts = {}
        for todo in data.get("todos", []):
            if isinstance(todo, dict) and isinstance(todo.get("memberId"), str):
                todo_counts[todo["memberId"]] = todo_counts.get(todo["memberId"], 0) + 1
        for kind in ("accounts", "stores", "members"):
            groups[kind] = []
            for row in (data.get("groups") or {}).get(kind, [])[:100]:
                if not isinstance(row, dict) or not isinstance(row.get("id"), str):
                    continue
                result = {"groupRef": self.reference("group", (kind, row["id"])),
                          "sessions": number(row.get("sessions"))}
                for key in ("watch", "sales", "spend"):
                    metric = row.get(key) or {}
                    result[key] = {"value": decimal(metric.get("value")) if key == "spend" else number(metric.get("value")),
                                   "coveredRooms": number(metric.get("coveredRooms"))}
                reconciliation = row.get("reconciliation") or {}
                result["reconciliation"] = project(reconciliation,
                    {"matched": number, "compared": number, "rate": number})
                if kind == "members":
                    result["todoCount"] = todo_counts.get(row["id"], 0)
                groups[kind].append(result)
        return {"available": boolean(data.get("available")), "startDate": stamp(data.get("startDate")),
                "endDate": stamp(data.get("endDate")), "totalSessions": number(data.get("totalSessions")),
                "loadedSessions": number(data.get("loadedSessions")),
                "truncated": boolean(data.get("truncated")), "unmappedSessions": number(data.get("unmappedSessions")),
                "ambiguousSessions": number(data.get("ambiguousSessions")),
                "groups": groups,
                "note": "仅汇总明确映射的历史进房人次、历史结算有效成交金额和千川同场消耗；缺失为 null"}

    def detail(self, ref):
        account, room = self.resolve("session", ref)
        data = self.api.get("/api/rpa/session", account=account, room=room)
        if not isinstance(data.get("room"), dict) or data["room"].get("id") != room:
            raise ToolError("NOT_FOUND", "已保存场次不存在或返回场次不一致，请重新列出场次")
        return data

    def invoke(self, name, args):
        definition = next((item for item in TOOLS if item["name"] == name), None)
        if definition is None:
            raise ToolError("UNKNOWN_TOOL", "工具不存在；仅开放只读工具")
        validate(args, definition["inputSchema"])
        if name == "get_health":
            return self.health()
        if name == "list_sessions":
            return self.list_sessions(args)
        if name == "get_hot_keywords":
            return self.hot_keywords()
        if name == "list_team_overview":
            return self.team_overview()
        ref = args["sessionRef"]
        if name == "get_session_timeline":
            account, room = self.resolve("session", ref)
            links = self.api.get("/api/session-links").get("links", [])
            timelines = []
            for link in links:
                if link.get("accountId") == account and link.get("roomId") == room:
                    data = self.api.get("/api/session-timeline", recordingSessionId=link["recordingSessionId"])
                    timelines.append(project(data, TIMELINE))
            return {"sessionRef": ref, "linked": bool(timelines), "timelines": timelines,
                    "note": "片段时间为观察时间，未与画面逐帧校准；不推断片段连续或指标小时增量" if timelines else "该经营场次没有已确认的录制场次关联"}
        data = self.detail(ref)
        if name == "get_session":
            return {"sessionRef": ref, **project(data, {"room": ROOM, "latest": SNAPSHOT,
                                                        "history": [SNAPSHOT], "historyReport": REPORT}),
                    "historyLimit": 120, "historyNote": "沿用现有详情接口最近最多120个快照，不代表完整采集历史"}
        if name == "get_spend_reconciliation":
            reconciliation = (data.get("latest") or {}).get("spendReconciliation")
            _, room = self.resolve("session", ref)
            if isinstance(reconciliation, dict) and any(side and side.get("roomId") != room for side in
                    (reconciliation.get("compass"), reconciliation.get("qianchuan"))):
                raise ToolError("SCOPE_MISMATCH", "保存的消耗采样与场次不一致，已隐藏结果")
            return {"sessionRef": ref, "toleranceYuan": "5", "reconciliation": project(reconciliation, SPEND),
                    "available": reconciliation is not None, "sampledAt": stamp((data.get("latest") or {}).get("time")),
                    "note": "返回保存的对账结论；不重新判定时效、不调整容差、不合并其他账户或统计范围"}
        rows = data.get("hourly", [])
        rows = [row for row in rows if all(key not in args or row.get(key) == args[key] for key in ("source", "grain"))]
        offset, limit = args.get("offset", 0), args.get("limit", 50)
        return {"sessionRef": ref, "total": len(rows), "offset": offset, "limit": limit,
                "hasMore": offset + limit < len(rows), "timeZone": "Asia/Shanghai",
                "rows": project(rows[offset:offset + limit], [HOURLY]),
                "note": "官方小时、边界快照、独立对照分别保留；快照不做差分，独立对照不是小时消耗；缺失为null"}


class MCPServer:
    def __init__(self, api):
        self.tools = LiveOpsTools(api)
        self.initialized = False
        self.ready = False

    @staticmethod
    def error(identifier, code, message):
        return {"jsonrpc": "2.0", "id": identifier, "error": {"code": code, "message": message}}

    def dispatch(self, request):
        if not isinstance(request, dict):
            return self.error(None, -32600, "Invalid Request")
        identifier = request.get("id")
        if (request.get("jsonrpc") != "2.0" or not isinstance(request.get("method"), str) or
                ("id" in request and (type(identifier) not in (int, str) or (isinstance(identifier, str) and len(identifier) > 128)))):
            return self.error(None, -32600, "Invalid Request")
        method, params = request["method"], request.get("params", {})
        if "id" not in request:
            if method == "notifications/initialized" and self.initialized:
                self.ready = True
            return None
        if not isinstance(params, dict):
            return self.error(identifier, -32602, "Invalid params")
        if method == "initialize":
            if self.initialized or not isinstance(params.get("protocolVersion"), str):
                return self.error(identifier, -32602, "Invalid initialize params")
            self.initialized = True
            version = params["protocolVersion"] if params["protocolVersion"] in PROTOCOLS else PROTOCOLS[0]
            result = {"protocolVersion": version, "capabilities": {"tools": {"listChanged": False}},
                      "serverInfo": {"name": "liveops-readonly", "version": "1.0.0"},
                      "instructions": "先 list_sessions 获取临时 sessionRef；引用仅在本连接有效。只读本机已保存数据；不执行登录、采集或服务启动。"}
        elif method == "ping":
            result = {}
        elif not self.ready:
            return self.error(identifier, -32002, "Initialize and send notifications/initialized first")
        elif method == "tools/list":
            if set(params) - {"_meta"}:
                return self.error(identifier, -32602, "Invalid tools/list params")
            result = {"tools": TOOLS}
        elif method == "tools/call":
            if not isinstance(params.get("name"), str) or set(params) - {"name", "arguments", "_meta"}:
                return self.error(identifier, -32602, "Invalid tools/call params")
            try:
                data = self.tools.invoke(params["name"], params.get("arguments", {}))
                result = {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False, allow_nan=False)}],
                          "structuredContent": data, "isError": False}
            except ToolError as error:
                data = {"error": {"code": error.code, "message": str(error)}}
                result = {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}],
                          "structuredContent": data, "isError": True}
            except Exception:
                # An upstream shape change must not disclose raw values or traceback.
                data = {"error": {"code": "INVALID_RESPONSE", "message": "本地数据格式异常；原始内容已隐藏"}}
                result = {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}],
                          "structuredContent": data, "isError": True}
        else:
            return self.error(identifier, -32601, "Method not found")
        return {"jsonrpc": "2.0", "id": identifier, "result": result}

    def run(self, reader, writer):
        while True:
            line = reader.readline(MAX_REQUEST_BYTES + 1)
            if not line:
                return
            if len(line) > MAX_REQUEST_BYTES:
                while line and not line.endswith(b"\n"):
                    line = reader.readline(MAX_REQUEST_BYTES + 1)
                response = self.error(None, -32600, "Request too large")
            else:
                try:
                    request = json.loads(line, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
                    response = self.dispatch(request)
                except (ValueError, UnicodeError, RecursionError):
                    response = self.error(None, -32700, "Parse error")
            if response is not None:
                writer.write((json.dumps(response, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8"))
                writer.flush()


def main(argv=None):
    parser = argparse.ArgumentParser(description="直播操盘台只读 MCP stdio 接口；不会启动工作台")
    parser.add_argument("--port", default=os.environ.get("LIVEOPS_MCP_PORT", os.environ.get("LIVEOPS_PORT", "8765")))
    parser.add_argument("--timeout", default="15")
    args = parser.parse_args(argv)
    try:
        api = LocalAPI(int(args.port), float(args.timeout))
    except (ValueError, TypeError):
        print("MCP 配置无效：端口须为 1–65535，超时须大于 0 且不超过 60 秒", file=sys.stderr)
        return 2
    try:
        MCPServer(api).run(sys.stdin.buffer, sys.stdout.buffer)
    except (BrokenPipeError, KeyboardInterrupt):
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
