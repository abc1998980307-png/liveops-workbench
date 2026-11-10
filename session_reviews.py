"""Local, durable drafts attached to observed recorder sessions."""

import copy
import html
import json
import os
import re
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path


SESSION_ID = re.compile(r"[0-9a-f]{32}\Z")
MAX_REVIEWS = 1000
MAX_FILE_BYTES = 10 * 1024 * 1024


class ReviewStoreError(RuntimeError):
    pass


class SessionReviews:
    def __init__(self, data_root, sessions, archives, now=None):
        self.file = Path(data_root) / "plugin-settings" / "session-reviews.json"
        self.sessions = sessions
        self.archives = archives
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.lock = threading.RLock()

    def _read(self):
        try:
            if self.file.stat().st_size > MAX_FILE_BYTES:
                raise ReviewStoreError("复盘记录过大，原文件未覆盖")
            value = json.loads(self.file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"version": 1, "reviews": []}
        except (OSError, ValueError) as error:
            raise ReviewStoreError("复盘记录无法读取，原文件未覆盖") from error
        reviews = value.get("reviews") if isinstance(value, dict) else None
        if (not isinstance(value, dict) or value.get("version") != 1 or not isinstance(reviews, list)
                or len(reviews) > MAX_REVIEWS or any(not self._valid_saved(item) for item in reviews)
                or len({item["sessionId"] for item in reviews}) != len(reviews)):
            raise ReviewStoreError("复盘记录格式异常，原文件未覆盖")
        return value

    @staticmethod
    def _valid_saved(item):
        return (isinstance(item, dict) and set(item) ==
                {"sessionId", "summary", "actions", "createdAt", "updatedAt"}
                and isinstance(item["sessionId"], str) and SESSION_ID.fullmatch(item["sessionId"])
                and isinstance(item["summary"], str) and len(item["summary"]) <= 5000
                and isinstance(item["actions"], str) and len(item["actions"]) <= 3000
                and all(isinstance(item[key], str) and len(item[key]) <= 64
                        for key in ("createdAt", "updatedAt")))

    def _write(self, value):
        raw = json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")
        if len(raw) > MAX_FILE_BYTES:
            raise ReviewStoreError("复盘记录已达容量上限，原文件未覆盖")
        self.file.parent.mkdir(parents=True, exist_ok=True)
        temp = None
        try:
            with tempfile.NamedTemporaryFile("wb", dir=self.file.parent, delete=False) as handle:
                temp = Path(handle.name)
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
            temp.replace(self.file)
        finally:
            if temp is not None:
                temp.unlink(missing_ok=True)

    def _session(self, session_id):
        if not isinstance(session_id, str) or not SESSION_ID.fullmatch(session_id):
            raise ValueError("录制场次 ID 无效")
        try:
            sessions = self.sessions._read()["sessions"]
        except (OSError, ValueError) as error:
            raise ReviewStoreError("录制场次记录无法读取") from error
        session = next((item for item in sessions if item.get("id") == session_id), None)
        if session is None:
            raise FileNotFoundError("录制场次不存在")
        return session

    def list(self, session_id=None):
        if session_id is not None and (not isinstance(session_id, str) or not SESSION_ID.fullmatch(session_id)):
            raise ValueError("录制场次 ID 无效")
        with self.lock:
            reviews = copy.deepcopy(self._read()["reviews"])
        if session_id is not None:
            reviews = [item for item in reviews if item["sessionId"] == session_id]
        reviews.sort(key=lambda item: item["updatedAt"], reverse=True)
        return {"reviews": reviews, "total": len(reviews), "truncated": False}

    def save(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"sessionId", "summary", "actions"}:
            raise ValueError("仅接受录制场次 ID、复盘摘要和后续动作")
        session_id = payload["sessionId"]
        self._session(session_id)
        summary, actions = payload["summary"], payload["actions"]
        if (not isinstance(summary, str) or not isinstance(actions, str)
                or len(summary) > 5000 or len(actions) > 3000
                or "\x00" in summary or "\x00" in actions):
            raise ValueError("复盘摘要最多 5000 字，后续动作最多 3000 字")
        summary, actions = summary.strip(), actions.strip()
        if not summary and not actions:
            raise ValueError("请填写复盘摘要或后续动作")
        now = self.now().astimezone(timezone.utc).isoformat()
        with self.lock:
            value = self._read()
            existing = next((item for item in value["reviews"] if item["sessionId"] == session_id), None)
            if existing is None:
                if len(value["reviews"]) >= MAX_REVIEWS:
                    raise ReviewStoreError("复盘记录已达上限，请先导出并整理旧记录")
                existing = {"sessionId": session_id, "createdAt": now}
                value["reviews"].append(existing)
            existing.update(summary=summary, actions=actions, updatedAt=now)
            self._write(value)
            return copy.deepcopy(existing)

    @staticmethod
    def _plain_markdown(value, block=False):
        escaped = html.escape(str(value or ""), quote=False)
        special = r"([\\`*_{}\[\]()#+.!|>~-])" if block else r"([\\`*_{}\[\]()!|~])"
        return re.sub(special, r"\\\1", escaped)

    @classmethod
    def _quote(cls, value):
        lines = cls._plain_markdown(value, block=True).splitlines() or [""]
        return "\n".join("> " + line for line in lines)

    @classmethod
    def _inline(cls, value):
        return cls._plain_markdown(" ".join(str(value or "").splitlines()))

    def export_markdown(self, session_id):
        session = self._session(session_id)
        with self.lock:
            review = next((item for item in self._read()["reviews"] if item["sessionId"] == session_id), None)
        if review is None:
            raise FileNotFoundError("尚未保存这场录制的复盘")
        try:
            archives = self.archives._read()["archives"]
        except (OSError, ValueError) as error:
            raise ReviewStoreError("录制归档记录无法读取，未导出不完整复盘") from error
        archive = next((item for item in reversed(archives) if item.get("sessionId") == session_id), None)
        archive = self.archives._public(archive) if archive else None
        lines = ["# 直播录制场次复盘", "", "## 来源与范围", "",
                 "- 来源：本机 bililive-go 录制场次观察记录", "- 录制场次 ID：" + session_id,
                 "- 直播间：" + self._inline(session.get("account") or session.get("roomId") or "未记录"),
                 "- 标题：" + self._inline(session.get("title") or "未记录"),
                 "- 开始：" + self._inline(session.get("startedAt") or "未记录"),
                 "- 结束：" + self._inline(session.get("endedAt") or "尚未确认结束"),
                 "- 观察到的片段数：" + str(len(session.get("segments") or [])),
                 "- 归档状态：" + self._inline(archive.get("status") if archive else "未生成"),
                 "- 复盘更新：" + self._inline(review["updatedAt"]), ""]
        if archive:
            for key, label in (("videoPath", "压缩视频"), ("transcriptPath", "文本"),
                               ("subtitlesPath", "字幕"), ("manifestPath", "归档清单")):
                if archive.get(key):
                    lines.append("- " + label + "（录屏目录内相对路径）：" + self._inline(archive[key]))
            lines.append("")
        lines.extend(["## 复盘摘要", "", self._quote(review["summary"] or "未填写"), "",
                      "## 后续动作", "", self._quote(review["actions"] or "未填写"), "",
                      "## 数据边界", "",
                      "- 此文档只依据本机录制观察、归档状态与手工填写的复盘内容；尚未关联罗盘经营场次，不包含成交、消耗等经营指标。",
                      "- 接入观察前的片段可能缺失；文件切换及观察中断无法证明直播连续或准确的断流时长。",
                      "- 归档未知间断：" + ("是" if archive and archive.get("unknownGaps") else "未由归档确认；仍需核对原始记录"),
                      ""])
        return "\n".join(lines).encode("utf-8")
