"""Summarize observed collector state without signing in or starting collection."""
from datetime import datetime, timezone


def _time(value):
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return stamp.timestamp() if stamp.tzinfo is not None else None
    except (AttributeError, ValueError, TypeError, OverflowError):
        return None


def compass_status(snapshot, now=None):
    now = datetime.now(timezone.utc).timestamp() if now is None else now
    accounts = snapshot.get("accounts") if isinstance(snapshot, dict) else None
    if not isinstance(accounts, list) or any(not isinstance(a, dict) for a in accounts):
        raise ValueError("采集器账号状态格式异常")
    counts = {"accounts": len(accounts), "paused": 0, "enabled": 0, "busy": 0,
              "fresh": 0, "stale": 0, "needsLogin": 0, "accountChanged": 0, "errors": 0, "limited": 0}
    for account in accounts:
        enabled = account.get("enabled") is True
        if enabled:
            counts["enabled"] += 1
        state = account.get("state")
        if not enabled and state not in {"needs_login", "account_changed", "rate_limited", "partial", "error"}:
            counts["paused"] += 1
        if account.get("busy"):
            counts["busy"] += 1
            continue
        if not enabled and state not in {"needs_login", "account_changed", "rate_limited", "partial", "error"}:
            continue
        if state == "needs_login":
            counts["needsLogin"] += 1
        elif state == "account_changed":
            counts["accountChanged"] += 1
        elif state == "rate_limited":
            counts["limited"] += 1
        elif state in {"partial", "error"}:
            counts["errors"] += 1
        else:
            checked, synced = _time(account.get("lastCheck")), _time(account.get("lastSync"))
            interval = 3600
            fresh = (state == "ready" and bool(account.get("uid")) and checked is not None
                     and synced is not None and 0 <= now - checked <= interval * 3
                     and 0 <= now - synced <= interval * 3)
            counts["fresh" if fresh else "stale"] += 1
    recent = [(_time(a.get("lastCheck")), a.get("lastCheck")) for a in accounts]
    recent = [(stamp, raw) for stamp, raw in recent if stamp is not None]
    last_check = max(recent)[1] if recent else None
    errors = counts["needsLogin"] + counts["accountChanged"] + counts["errors"] + counts["limited"]
    if not accounts:
        state, label, note = "unconfigured", "未添加账号", "到经营数据添加罗盘账号并登录。"
    elif counts["busy"]:
        state, label, note = "checking", "正在检查", f"{counts['busy']} 个账号正在同步；请等待本次检查结果。"
    elif counts["paused"] == len(accounts):
        state, label, note = "paused", "采集已暂停", f"{counts['paused']} 个账号已暂停；恢复后再检查登录有效性。"
    elif errors:
        if errors != counts["accounts"] - counts["paused"]:
            state, label = "partial", "部分账号异常"
        elif counts["needsLogin"] == errors:
            state, label = "needs_login", "需要登录"
        elif counts["accountChanged"] == errors:
            state, label = "account_changed", "账号待核对"
        elif counts["limited"] == errors:
            state, label = "rate_limited", "限流等待重试"
        else:
            state, label = "error", "同步异常"
        note = "到经营数据查看账号的检查结果；已保存的数据保留在本机。"
    elif counts["stale"]:
        state, label, note = "stale", "等待重新检查", "已有检查结果过期或尚未取得结果；当前登录有效性待确认。"
    else:
        state, label, note = "ready", "最近同步正常", "最近采集成功；是否有直播场次和经营数据请到经营数据查看。"
    if counts["paused"] and counts["paused"] < len(accounts):
        note += f" 另有 {counts['paused']} 个账号暂停。"
    return {"connected": counts["fresh"] > 0, "state": state, "label": label, "note": note,
            "lastCheck": last_check, "counts": counts, "error": None}


def feishu_status(snapshot):
    if not isinstance(snapshot, dict) or "configured" not in snapshot:
        raise ValueError("飞书同步状态格式异常")
    if not snapshot.get("configured"):
        state, label, note = "unconfigured", "未配置", "到经营数据连接目标多维表格和专用应用。"
    elif snapshot.get("busy"):
        state, label, note = "checking", "正在同步 / 检查", "正在核对表格或处理待同步记录。"
    elif snapshot.get("error"):
        state, label, note = "error", "同步异常", str(snapshot["error"])[:400]
    elif not snapshot.get("enabled"):
        state, label, note = "paused", "自动同步已暂停", "已保存连接配置；可在经营数据检查连接或单次同步。"
    elif not snapshot.get("verified"):
        state, label, note = "unverified", "等待授权检查", "自动同步已开启，尚未确认表格权限与字段。"
    elif snapshot.get("pending", 0):
        state, label, note = "pending", "有待同步数据", f"{snapshot['pending']} 个场次等待写入；失败后自动重试。"
    elif not snapshot.get("lastSuccess"):
        state, label, note = "waiting_data", "等待经营数据", "自动同步已开启，尚无真实场次写入记录。"
    else:
        state, label, note = "ready", "最近写入成功", "已处理当前待同步数据；新采样会更新对应场次。"
    return {"connected": bool(snapshot.get("verified")) and not bool(snapshot.get("error")),
            "state": state, "label": label, "note": note, "lastCheck": snapshot.get("lastTest"),
            "lastSuccess": snapshot.get("lastSuccess"), "pending": snapshot.get("pending", 0),
            "synced": snapshot.get("synced", 0), "error": snapshot.get("error")}
