"""Persist recorder session identities and observed file transitions without controlling recording."""
import copy
import hashlib
import json
import math
import os
import re
import tempfile
import threading
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path


POLL_SECONDS = 10
MAX_ROOMS = 100


def timestamp(value):
    if not isinstance(value, str) or value.startswith("0001-"):
        return None
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return result.timestamp() if result.tzinfo else None
    except (ValueError, OverflowError):
        return None


def iso(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat()


class RecordingSessions:
    def __init__(self, data_root, request, recording_root, now=time.time):
        self.file = Path(data_root) / "plugin-settings/recording-sessions.json"
        self.request, self.recording_root, self.now = request, recording_root, now
        self.lock = threading.RLock()
        self.poll_lock = threading.Lock()
        self.stop = threading.Event()
        self.thread = None
        self.error = None
        self.checked_at = None

    def _read(self):
        try:
            data = json.loads(self.file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"version": 1, "sessions": []}
        if (not isinstance(data, dict) or data.get("version") != 1
                or not isinstance(data.get("sessions"), list)
                or any(not isinstance(s, dict) or not isinstance(s.get("segments"), list)
                       or not isinstance(s.get("events"), list)
                       or any(not isinstance(s.get(k), str) for k in ("id", "roomId", "startedAt"))
                       or any(not isinstance(p, dict) or any(k not in p for k in
                              ("path", "root", "device", "inode", "lastSeenAt")) for p in s["segments"])
                       or any(not isinstance(e, dict) for e in s["events"]) for s in data["sessions"])):
            raise ValueError("录制场次记录格式异常，原记录未覆盖")
        return data

    def _save(self, data):
        self.file.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.file.parent, delete=False) as f:
            temp = Path(f.name)
            try:
                json.dump(data, f, ensure_ascii=False, indent=2)
                f.flush()
                os.fsync(f.fileno())
            except BaseException:
                temp.unlink(missing_ok=True)
                raise
        try:
            temp.replace(self.file)
        finally:
            temp.unlink(missing_ok=True)

    def _file(self, value):
        root = Path(self.recording_root()).expanduser().resolve()
        path = Path(value)
        if not path.is_absolute() or path.is_symlink() or not path.resolve().is_relative_to(root):
            raise ValueError("录制器返回的文件不在当前录屏目录内")
        path = path.resolve(strict=True)
        if not path.is_file() or path.suffix.lower() not in {".flv", ".ts", ".mp4", ".mkv", ".aac"}:
            raise ValueError("录制器返回的文件类型不支持")
        stat = path.stat()
        return {"path": path.relative_to(root).as_posix(), "root": str(root), "device": stat.st_dev,
                "inode": stat.st_ino, "bytes": stat.st_size}

    def observe(self):
        """Only a recorder history end event closes a session; outages never mean ended."""
        now = self.now()
        rooms = self.request("/api/lives")
        if not isinstance(rooms, list) or any(not isinstance(r, dict) for r in rooms):
            raise ValueError("录制器直播间列表格式异常")
        if len(rooms) > MAX_ROOMS:
            raise ValueError("录制场次检查最多支持 100 个直播间，未将部分结果当作完整记录")
        with self.poll_lock:
            data = self._read()
            current = {str(r.get("id")): r for r in rooms}
            ids = set(current) | {s["roomId"] for s in data["sessions"] if not s.get("endedAt")}
            if len(ids) > MAX_ROOMS:
                raise ValueError("未结束的录制间过多，已保留原记录")
            errors = []
            for room_id in sorted(ids):
                if self.stop.is_set():
                    return
                if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", room_id):
                    errors.append("录制间标识无效")
                    continue
                try:
                    self._room(data, room_id, current.get(room_id), now)
                except (OSError, ValueError, RuntimeError) as error:
                    # Do not expose upstream URLs, headers or arbitrary response bodies.
                    errors.append("部分直播间记录读取失败（" + type(error).__name__ + "），结束状态待确认")
            self._save(data)
            self.checked_at = iso(now)
            self.error = "；".join(dict.fromkeys(errors)) or None

    def _room(self, data, room_id, room, now):
        base = "/api/lives/" + urllib.parse.quote(room_id, safe="")
        history = self.request(base + "/history?page=1&page_size=100")
        if not isinstance(history, dict) or not isinstance(history.get("events"), list):
            raise ValueError("录制历史格式异常")
        active = []
        for event in history["events"]:
            if not isinstance(event, dict) or event.get("type") != "session":
                continue
            entry = event.get("data", {})
            if not isinstance(entry, dict) or str(entry.get("live_id")) != room_id:
                raise ValueError("录制场次与直播间不匹配")
            if not re.fullmatch(r"[1-9]\d{0,19}", str(entry.get("id", ""))):
                raise ValueError("录制场次标识无效")
            started = timestamp(entry.get("start_time"))
            ended = timestamp(entry.get("end_time"))
            if started is None or (ended is not None and ended < started):
                raise ValueError("录制场次时间无效")
            key = hashlib.sha256((room_id + ":" + str(entry.get("id")) + ":" + iso(started)).encode()).hexdigest()[:32]
            session = next((s for s in data["sessions"] if s["id"] == key), None)
            if session is None:
                session = {"id": key, "roomId": room_id, "recorderSessionId": str(entry.get("id")),
                           "account": str(entry.get("host_name", ""))[:200], "title": str(entry.get("room_name", ""))[:300],
                           "startedAt": iso(started), "firstObservedAt": iso(now), "endedAt": None,
                           "endReason": None, "segments": [], "events": [], "partialObservation": True}
                data["sessions"].append(session)
            if ended is not None:
                session.update(endedAt=iso(ended), endReason=str(entry.get("end_reason") or "unknown")[:100])
                if session["segments"]:
                    segment = session["segments"][-1]
                    if not segment.get("closedObservedAt"):
                        segment.update(closedObservedAt=iso(now), closeReason="session_ended")
            elif not session.get("endedAt"):
                active.append(session)
        # Omitted pages or missing/removed rooms are never evidence of an end.
        if not room or not room.get("recording"):
            for session in active:
                session.update(lastCheckedAt=iso(now), lastRecording=False)
            return
        started = room.get("last_start_time_unix")
        if isinstance(started, bool) or not isinstance(started, (int, float)) or not math.isfinite(started):
            raise ValueError("当前录制缺少明确开始时间")
        candidates = [s for s in active if int(timestamp(s["startedAt"])) == int(started)]
        if len(candidates) != 1:
            raise ValueError("无法唯一关联当前录制场次")
        session = candidates[0]
        detail = self.request(base)
        if not isinstance(detail, dict) or str(detail.get("live_id")) != room_id or not detail.get("recording"):
            raise ValueError("读取期间录制状态变化，等待下一次检查")
        status = detail.get("recorder_status") or {}
        if not isinstance(status, dict):
            raise ValueError("录制进度格式异常")
        file_path = status.get("file_path")
        if not isinstance(file_path, str) or not file_path:
            session.update(lastCheckedAt=iso(now), lastRecording=True)
            return
        info = self._file(file_path)
        previous_check = timestamp(session.get("lastCheckedAt"))
        if previous_check is not None and now - previous_check > POLL_SECONDS * 3:
            session["events"].append({"type": "observation_gap", "from": iso(previous_check), "to": iso(now),
                                      "note": "场次观察中断，不等于直播断流；期间可能遗漏片段"})
        segments = session["segments"]
        last = segments[-1] if segments else None
        same_file = last and all(last.get(k) == info[k] for k in ("path", "root", "device", "inode"))
        if not same_file:
            if last:
                last.update(closedObservedAt=iso(now), closeReason="file_changed_unknown")
                session["events"].append({"type": "file_changed", "from": last["lastSeenAt"], "to": iso(now),
                                          "note": "观察到录制文件切换；不能仅凭此判断断流原因或精确缺口"})
            last = {**info, "id": hashlib.sha256((session["id"] + str(info)).encode()).hexdigest()[:32],
                    "firstSeenAt": iso(now), "lastSeenAt": iso(now), "mediaDurationMs": None,
                    "closedObservedAt": None, "closeReason": None}
            segments.append(last)
        duration = status.get("out_time_ms")
        if isinstance(duration, (str, int)) and re.fullmatch(r"\d{1,15}", str(duration)):
            last["mediaDurationMs"] = int(duration) // 1000  # FFmpeg out_time_ms is actually microseconds.
        last.update(bytes=info["bytes"], lastSeenAt=iso(now))
        session.update(lastCheckedAt=iso(now), lastRecording=True)

    def snapshot(self):
        with self.lock:
            try:
                sessions = copy.deepcopy(self._read()["sessions"])
            except (OSError, ValueError):
                return {"sessions": [], "error": "录制场次记录无法读取，原记录已保留", "checkedAt": self.checked_at}
            for session in sessions:
                last = timestamp(session.get("lastCheckedAt"))
                session["state"] = ("ended" if session.get("endedAt") else "unknown" if last is None or self.now() - last > 30
                                    else "recording" if session.get("lastRecording") else "waiting")
                for segment in session["segments"]:
                    segment["recordingPath"] = None
                    try:
                        root = Path(self.recording_root()).expanduser().resolve()
                        path = Path(segment["root"]) / segment["path"]
                        actual = self._file(str(path)) if Path(segment["root"]) == root else None
                        if actual and all(actual[k] == segment[k] for k in ("device", "inode")):
                            segment["recordingPath"] = segment["path"]
                    except (OSError, ValueError):
                        pass
                    segment.pop("root", None)
                    segment.pop("device", None)
                    segment.pop("inode", None)
            sessions.sort(key=lambda s: s["startedAt"], reverse=True)
            return {"sessions": sessions[:50], "total": len(sessions), "truncated": len(sessions) > 50,
                    "checkedAt": self.checked_at, "error": self.error,
                    "note": "本机录制场次；从接入后观察文件，历史片段可能缺失。录制器确认结束后可生成合并归档。"}

    def _loop(self):
        while not self.stop.is_set():
            try:
                self.observe()
            except (OSError, ValueError, RuntimeError) as error:
                self.error = "录制场次检查失败（" + type(error).__name__ + "），已保留历史，未推断下播"
            self.stop.wait(POLL_SECONDS)

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.stop.clear()
        self.thread = threading.Thread(target=self._loop, name="recording-session-observer", daemon=True)
        self.thread.start()

    def close(self):
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=12)
