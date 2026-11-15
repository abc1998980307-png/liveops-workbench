"""Join explicit local account aliases with saved business sessions and reviews."""

from datetime import date
from decimal import Decimal, InvalidOperation


def _metric(row, key, unit):
    metric = (row.get("metrics") or {}).get(key)
    if not isinstance(metric, dict) or metric.get("rawUnit") != unit:
        return None
    value = metric.get("value")
    return value if type(value) is int and value >= 0 else None


def _spend(row):
    reconciliation = (row.get("latest") or {}).get("spendReconciliation") or {}
    side = reconciliation.get("qianchuan") or {}
    if side.get("roomId") != (row.get("room") or {}).get("id"):
        return None
    try:
        amount = Decimal(str(side["amount"]))
    except (KeyError, ValueError, InvalidOperation):
        return None
    return amount if amount.is_finite() and amount >= 0 else None


def _group(name, identifier):
    return {"id": identifier, "name": name, "sessions": 0,
            "watch": {"value": None, "coveredRooms": 0},
            "sales": {"value": None, "coveredRooms": 0},
            "spend": {"value": None, "coveredRooms": 0},
            "reconciliation": {"matched": 0, "compared": 0, "rate": None}}


def _add(group, row):
    group["sessions"] += 1
    for target, source, unit, divisor in (("watch", "entryVisits", "number", 1),
                                          ("sales", "validSales", "price", 100)):
        value = _metric(row, source, unit)
        if value is not None:
            group[target]["value"] = (group[target]["value"] or 0) + value / divisor
            group[target]["coveredRooms"] += 1
    spend = _spend(row)
    if spend is not None:
        group["spend"]["value"] = str(Decimal(group["spend"]["value"] or "0") + spend)
        group["spend"]["coveredRooms"] += 1
    reconciliation = (row.get("latest") or {}).get("spendReconciliation") or {}
    if reconciliation.get("compass") and reconciliation.get("qianchuan"):
        group["reconciliation"]["compared"] += 1
        if reconciliation.get("status") == "匹配":
            group["reconciliation"]["matched"] += 1


def _finalize(groups):
    result = list(groups.values())
    for group in result:
        comparison = group["reconciliation"]
        if comparison["compared"]:
            comparison["rate"] = comparison["matched"] / comparison["compared"]
    return sorted(result, key=lambda item: (-item["sessions"], item["name"]))


def build_team_overview(workspace, business, reviews, *, available=True):
    """Business rows come from the saved room.workspace query, without any collection."""
    members = {item["id"]: item for item in workspace.get("teamMembers", [])}
    stores = {item["id"]: item for item in workspace.get("stores", [])}
    mappings = workspace.get("accountMappings", [])
    by_alias = {item["sourceAlias"].casefold(): item for item in mappings if item.get("active")}
    source_ids = {}
    for row in (business or {}).get("rows", []):
        alias = str(row.get("accountName") or "").casefold()
        source_ids.setdefault(alias, set()).add(row.get("accountId"))
    ambiguous = {alias for alias, ids in source_ids.items() if len(ids) > 1}
    groups = {kind: {} for kind in ("accounts", "stores", "members")}
    unmatched = ambiguous_count = 0
    rows = business.get("rows", []) if isinstance(business, dict) else []
    for row in rows:
        mapping = by_alias.get(str(row.get("accountName") or "").casefold())
        if not mapping or str(row.get("accountName") or "").casefold() in ambiguous:
            unmatched += 1
            if str(row.get("accountName") or "").casefold() in ambiguous:
                ambiguous_count += 1
            continue
        targets = [("accounts", mapping["id"], mapping["name"])]
        for kind, key, parent in (("stores", "storeId", stores), ("members", "memberId", members)):
            linked = parent.get(mapping.get(key))
            if linked:
                targets.append((kind, linked["id"], linked["name"]))
        for kind, identifier, name in targets:
            _add(groups[kind].setdefault(identifier, _group(name, identifier)), row)
    # Keep configured mappings visible even when no saved business session exists.
    for item in mappings:
        groups["accounts"].setdefault(item["id"], _group(item["name"], item["id"]))
    todos = []
    by_name = {item["name"].casefold(): item for item in members.values()}
    for review in reviews:
        owner = str(review.get("owner") or "").strip()
        actions = str(review.get("actions") or "").strip()
        member = by_name.get(owner.casefold())
        if member and actions:
            todos.append({"memberId": member["id"], "memberName": member["name"],
                          "actions": actions, "dueDate": review.get("dueDate") or None,
                          "updatedAt": review.get("updatedAt") or None,
                          "sessionId": review.get("sessionId")})
    todos.sort(key=lambda item: (item["dueDate"] or "9999-12-31", item["memberName"]))
    return {"available": available, "startDate": business.get("startDate") if business else None,
            "endDate": business.get("endDate") if business else None,
            "totalSessions": business.get("total", 0) if business else None,
            "loadedSessions": len(rows), "truncated": bool(business and business.get("hasMore")),
            "unmappedSessions": unmatched, "ambiguousSessions": ambiguous_count, "mappings": mappings,
            "groups": {kind: _finalize(values) for kind, values in groups.items()},
            "todos": todos,
            "notes": {"watch": "历史进房人次，不是去重观众", "sales": "历史结算有效成交金额（元）",
                      "spend": "千川同场报表消耗（元），仅计已匹配场次",
                      "reconciliation": "仅在罗盘与千川都有同场采样时计算匹配率"}}
