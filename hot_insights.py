"""Bounded local observations of a public hot list and its session context."""

import json
import math
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path


MAX_TERMS = 50
MAX_SNAPSHOTS = 72
MAX_ITEMS = 100
MAX_FILE_BYTES = 2 * 1024 * 1024


class HotInsightsError(ValueError):
    pass


def _instant(value):
    if not isinstance(value, str):
        return None
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return result.astimezone(timezone.utc) if result.tzinfo else None
    except ValueError:
        return None


def _term(value):
    if (not isinstance(value, str) or not 1 <= len(value.strip()) <= 40
            or any(ord(char) < 32 for char in value)):
        raise HotInsightsError("监控词需为 1–40 个可见字符")
    return value.strip()


class HotInsights:
    def __init__(self, root, now=None):
        self.file = Path(root) / "hot-insights.json"
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.lock = threading.RLock()

    @staticmethod
    def _empty():
        return {"version": 1, "terms": [], "snapshots": []}

    def _read(self):
        try:
            if self.file.stat().st_size > MAX_FILE_BYTES:
                raise HotInsightsError("热词记录超过容量上限，原文件已保留")
            data = json.loads(self.file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return self._empty()
        except (OSError, ValueError) as error:
            if isinstance(error, HotInsightsError):
                raise
            raise HotInsightsError("热词记录无法读取，原文件已保留") from error
        if (not isinstance(data, dict) or data.get("version") != 1
                or not isinstance(data.get("terms"), list) or len(data["terms"]) > MAX_TERMS
                or not isinstance(data.get("snapshots"), list) or len(data["snapshots"]) > MAX_SNAPSHOTS):
            raise HotInsightsError("热词记录格式无效，原文件已保留")
        for term in data["terms"]:
            if not isinstance(term, dict) or set(term) != {"term", "addedAt", "firstSeenAt", "lastSeenAt"}:
                raise HotInsightsError("热词记录格式无效，原文件已保留")
            _term(term["term"])
            if any(value and not _instant(value) for value in (term["addedAt"], term["firstSeenAt"], term["lastSeenAt"])):
                raise HotInsightsError("热词记录时间无效，原文件已保留")
        if len({item["term"].casefold() for item in data["terms"]}) != len(data["terms"]):
            raise HotInsightsError("监控词重复，原文件已保留")
        for sample in data["snapshots"]:
            if (not isinstance(sample, dict) or set(sample) != {"sampledAt", "sourceUpdatedAt", "items"}
                    or not _instant(sample["sampledAt"]) or not isinstance(sample["items"], list)
                    or len(sample["items"]) > MAX_ITEMS):
                raise HotInsightsError("热词采样格式无效，原文件已保留")
            for item in sample["items"]:
                if (not isinstance(item, dict) or set(item) != {"title", "hot", "rank", "sourceTime"}
                        or not isinstance(item["title"], str) or len(item["title"]) > 120
                        or type(item["hot"]) not in (int, float) or not math.isfinite(item["hot"])
                        or item["hot"] < 0 or type(item["rank"]) is not int or not 1 <= item["rank"] <= MAX_ITEMS):
                    raise HotInsightsError("热词采样条目无效，原文件已保留")
        return data

    def _write(self, data):
        raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        while len(raw) > MAX_FILE_BYTES and len(data["snapshots"]) > 1:
            data["snapshots"].pop(0)
            raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(raw) > MAX_FILE_BYTES:
            raise HotInsightsError("热词记录超过容量上限，原文件未覆盖")
        self.file.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile("wb", dir=self.file.parent, delete=False) as handle:
                temporary = Path(handle.name)
                os.chmod(temporary, 0o600)
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
            temporary.replace(self.file)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def watch(self, value):
        term = _term(value)
        with self.lock:
            data = self._read()
            existing = next((item for item in data["terms"] if item["term"].casefold() == term.casefold()), None)
            if existing:
                return self.snapshot()
            if len(data["terms"]) >= MAX_TERMS:
                raise HotInsightsError("最多监控 50 个词")
            added = self.now().astimezone(timezone.utc).isoformat()
            data["terms"].append({"term": term, "addedAt": added, "firstSeenAt": None, "lastSeenAt": None})
            self._write(data)
            return self._view(data)

    def unwatch(self, value):
        term = _term(value)
        with self.lock:
            data = self._read()
            data["terms"] = [item for item in data["terms"] if item["term"].casefold() != term.casefold()]
            self._write(data)
            return self._view(data)

    def refresh(self, fetcher):
        """Fetch an already validated public list; do not start the source service."""
        response = fetcher(MAX_ITEMS)
        if (not isinstance(response, dict) or response.get("code") != 200
                or response.get("name") != "douyin" or not isinstance(response.get("data"), list)):
            raise HotInsightsError("公开榜单响应无效")
        items = []
        for rank, row in enumerate(response["data"][:MAX_ITEMS], 1):
            if not isinstance(row, dict) or not isinstance(row.get("title"), str):
                raise HotInsightsError("公开榜单条目无效")
            title = row["title"].strip()
            hot = row.get("hot")
            if (not title or len(title) > 120 or type(hot) not in (int, float)
                    or not math.isfinite(hot) or hot < 0):
                raise HotInsightsError("公开榜单热度无效")
            source_time = row.get("timestamp")
            items.append({"title": title, "hot": hot, "rank": rank,
                          "sourceTime": source_time if isinstance(source_time, str) and len(source_time) <= 64 else None})
        observed = self.now().astimezone(timezone.utc).isoformat()
        updated = response.get("updateTime")
        sample = {"sampledAt": observed,
                  "sourceUpdatedAt": updated if isinstance(updated, str) and len(updated) <= 64 else None,
                  "items": items}
        with self.lock:
            data = self._read()
            # An unchanged upstream timestamp is one observation, even after manual refresh.
            if data["snapshots"] and updated and data["snapshots"][-1]["sourceUpdatedAt"] == updated:
                data["snapshots"][-1] = sample
            else:
                data["snapshots"].append(sample)
                data["snapshots"] = data["snapshots"][-MAX_SNAPSHOTS:]
            for term in data["terms"]:
                if any(term["term"].casefold() in item["title"].casefold() for item in items):
                    term["firstSeenAt"] = term["firstSeenAt"] or observed
                    term["lastSeenAt"] = observed
            self._write(data)
            return self._view(data)

    @staticmethod
    def _view(data):
        latest = data["snapshots"][-1] if data["snapshots"] else None
        monitored = []
        for saved in data["terms"]:
            series = []
            for sample in data["snapshots"]:
                matching = [item for item in sample["items"] if saved["term"].casefold() in item["title"].casefold()]
                series.append({"sampledAt": sample["sampledAt"], "hot": max((item["hot"] for item in matching), default=None),
                               "rank": min((item["rank"] for item in matching), default=None)})
            monitored.append({**saved, "currentHot": series[-1]["hot"] if series else None,
                              "currentRank": series[-1]["rank"] if series else None,
                              "trend": series})
        return {"terms": monitored, "latest": latest, "sampleCount": len(data["snapshots"]),
                "source": "DailyHotApi", "note": "热度为公开榜单原值；首次观察时间是本机记录时间，不是实际首次上榜时间"}

    def snapshot(self, sessions=None):
        with self.lock:
            data = self._read()
            view = self._view(data)
        if sessions is not None:
            view["sessions"] = self.correlate(data, sessions)
        return view

    @staticmethod
    def correlate(data, sessions):
        """Sessions contain title, startedAt, endedAt, reviewSummary and reviewActions."""
        result = []
        for session in sessions[:100]:
            if not isinstance(session, dict):
                continue
            start = _instant(session.get("startedAt"))
            end = _instant(session.get("endedAt"))
            if not start or (end and end < start):
                continue
            title = session.get("title") if isinstance(session.get("title"), str) else ""
            review = " ".join(str(session.get(key) or "") for key in ("reviewSummary", "reviewActions"))
            matches = []
            for term in data["terms"]:
                word = term["term"].casefold()
                reasons = [label for label, text in (("title", title), ("review", review)) if word in text.casefold()]
                during = []
                for sample in data["snapshots"]:
                    observed = _instant(sample["sampledAt"])
                    if start <= observed and (end is None or observed <= end):
                        during.extend({"title": item["title"], "hot": item["hot"], "sampledAt": sample["sampledAt"]}
                                      for item in sample["items"] if word in item["title"].casefold())
                        if len(during) >= 20:
                            break
                if reasons or during:
                    matches.append({"term": term["term"], "matchedIn": reasons, "hotDuringSession": during[:20]})
            if matches:
                result.append({"title": title[:120], "startedAt": session["startedAt"],
                               "endedAt": session.get("endedAt"), "matches": matches})
        return result
