"""A conservative wall-clock timeline for one observed recorder session."""

from datetime import datetime, timezone
from pathlib import Path

from recording_sessions import timestamp
from session_links import RECORDING_ID


def offset_ms(value, origin):
    point = timestamp(value)
    return round((point - origin) * 1000) if point is not None and origin is not None else None


def timezone_offset(value):
    if timestamp(value) is None:
        return None
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    offset = parsed.utcoffset()
    if offset is None:
        return None
    minutes = int(offset.total_seconds() // 60)
    sign = "+" if minutes >= 0 else "-"
    return f"{sign}{abs(minutes) // 60:02}:{abs(minutes) % 60:02}"


class SessionTimeline:
    def __init__(self, sessions, archives, links):
        self.sessions = sessions
        self.archives = archives
        self.links = links

    def _recording_path(self, segment):
        if not hasattr(self.sessions, "_file") or not hasattr(self.sessions, "recording_root"):
            return None
        try:
            root = Path(self.sessions.recording_root()).expanduser().resolve()
            if Path(segment.get("root", "")) != root:
                return None
            actual = self.sessions._file(str(root / segment["path"]))
            if all(actual[key] == segment[key] for key in ("device", "inode")):
                return actual["path"]
        except (KeyError, OSError, TypeError, ValueError):
            pass
        return None

    def detail(self, recording_id):
        if not isinstance(recording_id, str) or not RECORDING_ID.fullmatch(recording_id):
            raise ValueError("录制场次 ID 无效")
        sessions = self.sessions._read()["sessions"]
        session = next((item for item in sessions if item.get("id") == recording_id), None)
        if session is None:
            raise FileNotFoundError("录制场次不存在")
        business = self.links.business_snapshot(recording_id, include_history=True)
        link = business.get("link") if business.get("linked") else None
        business_start = business.get("roomStartedAt") or (link or {}).get("roomStartedAt")
        start_candidates = [point for point in (timestamp(session.get("startedAt")), timestamp(business_start)) if point is not None]
        origin = min(start_candidates) if start_candidates else None
        origin_at = datetime.fromtimestamp(origin, timezone.utc).isoformat() if origin is not None else None

        segments = []
        for item in session.get("segments", []):
            segments.append({"id": item.get("id"), "path": item.get("path"),
                             "recordingPath": self._recording_path(item),
                             "firstObservedAt": item.get("firstSeenAt"), "lastObservedAt": item.get("lastSeenAt"),
                             "firstObservedOffsetMs": offset_ms(item.get("firstSeenAt"), origin),
                             "lastObservedOffsetMs": offset_ms(item.get("lastSeenAt"), origin),
                             "mediaDurationMs": item.get("mediaDurationMs"),
                             "timeAlignment": "unverified",
                             "note": "片段起止为观察时间，不是经过校准的画面墙钟时间"})

        events = []
        for item in session.get("events", []):
            events.append({"type": item.get("type"), "fromAt": item.get("from"), "toAt": item.get("to"),
                           "fromOffsetMs": offset_ms(item.get("from"), origin),
                           "toOffsetMs": offset_ms(item.get("to"), origin), "note": item.get("note")})

        gaps = []
        first = segments[0] if segments else None
        if first and timestamp(session.get("startedAt")) is not None and timestamp(first["firstObservedAt"]) is not None \
                and timestamp(first["firstObservedAt"]) > timestamp(session["startedAt"]):
            gaps.append({"fromAt": session["startedAt"], "toAt": first["firstObservedAt"],
                         "fromOffsetMs": offset_ms(session["startedAt"], origin),
                         "toOffsetMs": first["firstObservedOffsetMs"], "status": "unobserved",
                         "note": "首次观察前是否有录屏未知"})
        for before, after in zip(segments, segments[1:]):
            gaps.append({"fromAt": before["lastObservedAt"], "toAt": after["firstObservedAt"],
                         "fromOffsetMs": before["lastObservedOffsetMs"],
                         "toOffsetMs": after["firstObservedOffsetMs"], "status": "unknown",
                         "note": "文件切换边界之间的画面连续性未知"})
        for item in events:
            if item["type"] == "observation_gap":
                gaps.append({"fromAt": item["fromAt"], "toAt": item["toAt"],
                             "fromOffsetMs": item["fromOffsetMs"], "toOffsetMs": item["toOffsetMs"],
                             "status": "observation_gap", "note": "观察中断，不能据此认定画面丢失"})
        if segments and timestamp(session.get("endedAt")) is not None \
                and timestamp(segments[-1]["lastObservedAt"]) is not None \
                and timestamp(session["endedAt"]) > timestamp(segments[-1]["lastObservedAt"]):
            gaps.append({"fromAt": segments[-1]["lastObservedAt"], "toAt": session["endedAt"],
                         "fromOffsetMs": segments[-1]["lastObservedOffsetMs"],
                         "toOffsetMs": offset_ms(session["endedAt"], origin), "status": "unobserved",
                         "note": "末次观察后是否继续录屏未知"})
        if not segments and session.get("endedAt"):
            gaps.append({"fromAt": session.get("startedAt"), "toAt": session.get("endedAt"),
                         "fromOffsetMs": offset_ms(session.get("startedAt"), origin),
                         "toOffsetMs": offset_ms(session.get("endedAt"), origin), "status": "unobserved",
                         "note": "本机没有观察到该场次的片段"})

        archive_error = None
        try:
            stored_archives = self.archives._read()["archives"]
        except (OSError, ValueError):
            stored_archives = []
            archive_error = "录制归档记录无法读取"
        selected_archive = next((item for item in reversed(stored_archives) if item.get("sessionId") == recording_id), None)
        archive = self.archives._public(selected_archive) if selected_archive else None
        if archive:
            archive = {key: archive.get(key) for key in ("status", "stage", "videoPath", "subtitlesPath",
                                                        "transcriptPath", "unknownGaps", "partialObservation", "error")}

        snapshots = []
        if business.get("status") == "ready":
            for item in business.get("history", []):
                snapshots.append({"sampledAt": item["time"], "offsetMs": offset_ms(item["time"], origin),
                                  "metrics": item["metrics"], "source": "compass_live_snapshot"})
        business_result = {"status": business.get("status"), "linked": bool(link),
                           "note": business.get("note"), "link": link, "roomState": business.get("roomState"),
                           "roomStartedAt": business_start,
                           "roomEndedAt": business.get("roomEndedAt"),
                           "accountHealth": business.get("accountHealth"),
                           "snapshots": snapshots,
                           "latest": {"sampledAt": business.get("sampledAt"), "metrics": business.get("metrics"),
                                      "source": business.get("source")} if business.get("status") == "ready" else None,
                           "historyReport": business.get("historyReport") if business.get("status") == "ready" else None}
        compass_state = (business.get("accountHealth") or {}).get("state")
        sources = {
            "recording": {"status": "available" if segments else "missing", "note": "片段时间未与画面逐帧校准" if segments else "未观察到录屏片段"},
            "archive": {"status": "error" if archive_error else archive.get("status") if archive else "missing",
                        "note": archive_error or (archive.get("error") if archive else "尚无录制归档")},
            "compass": {"status": compass_state or business.get("status"), "note": business.get("note"),
                        "lastSuccessAt": (business.get("accountHealth") or {}).get("lastSync")},
            "subtitles": {"status": "available" if archive and archive.get("subtitlesPath") else "error" if archive_error else "missing",
                          "note": "归档字幕按媒体时长合并，实际墙钟位置尚未校准" if archive and archive.get("subtitlesPath") else "没有可用的归档字幕"},
            "comments": {"status": "not_connected", "note": "尚无经核验的场次评论来源"},
            "products": {"status": "not_connected", "note": "尚无经核验的场次商品事件来源"},
            "shifts": {"status": "unlinked", "note": "本机计划班次尚未确认关联到该场次"},
            "shop": {"status": "authorization_unknown", "note": "本机店铺配置不代表平台授权"},
        }
        return {
            "recordingSessionId": recording_id,
            "identity": {"platform": "douyin_ecommerce" if link else None,
                         "liveAccountUid": link.get("accountUid") if link else None,
                         "roomId": link.get("roomId") if link else None,
                         "recordingRoomId": session.get("roomId"),
                         "recorderSessionId": session.get("recorderSessionId"),
                         "recordingStartedAt": session.get("startedAt"),
                         "recordingEndedAt": session.get("endedAt"),
                         "businessStartedAt": business_start,
                         "businessEndedAt": business.get("roomEndedAt"),
                         "timeZone": timezone_offset(business_start),
                         "linked": bool(link)},
            "originAt": origin_at, "partialObservation": bool(session.get("partialObservation", True)),
            "segments": segments, "gaps": gaps, "events": events,
            "archive": archive, "business": business_result, "sources": sources,
        }
