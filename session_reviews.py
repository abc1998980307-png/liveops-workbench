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
    def __init__(self, data_root, sessions, archives, now=None, links=None):
        self.file = Path(data_root) / "plugin-settings" / "session-reviews.json"
        self.sessions = sessions
        self.archives = archives
        self.links = links
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
        escaped = html.escape(str(value if value is not None else ""), quote=False)
        special = r"([\\`*_{}\[\]()#+.!|>~-])" if block else r"([\\`*_{}\[\]()!|~])"
        return re.sub(special, r"\\\1", escaped)

    @classmethod
    def _quote(cls, value):
        lines = cls._plain_markdown(value, block=True).splitlines() or [""]
        return "\n".join("> " + line for line in lines)

    @classmethod
    def _inline(cls, value):
        return cls._plain_markdown(" ".join(str(value if value is not None else "").splitlines()))

    def _append_business_metrics(self, lines, metrics, endpoints):
        for metric in metrics:
            if not isinstance(metric, dict):
                continue
            label = self._inline(metric.get("label") or metric.get("key") or "未命名指标")
            display = self._inline(metric.get("display") if metric.get("display") is not None else "—")
            unit = self._inline(metric.get("unit") or "")
            original = metric.get("value")
            raw_unit = self._inline(metric.get("rawUnit") or "")
            lines.append("- " + label + "：" + display + (" " + unit if unit else "")
                         + "；原值 " + self._inline(original if original is not None else "未返回")
                         + (" " + raw_unit if raw_unit else ""))
        failed = [name for name, result in endpoints.items()
                  if isinstance(result, dict) and not result.get("ok")]
        if failed:
            lines.append("- 部分接口未成功：" + self._inline("、".join(failed)))

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
                      "## 后续动作", "", self._quote(review["actions"] or "未填写"), ""])
        business = self.links.business_snapshot(session_id) if self.links else {"linked": False, "status": "unlinked"}
        lines.extend(["## 经营场次", ""])
        if business.get("linked"):
            link = business["link"]
            lines.extend(["- 关联方式：用户明确确认", "- 经营账号：" + self._inline(link["accountLabel"]),
                          "- 账号 UID：" + self._inline(link["accountUid"]),
                          "- 罗盘场次 ID：" + self._inline(link["roomId"]),
                          "- 罗盘场次标题：" + self._inline(link["roomTitle"]),
                          "- 关联时间：" + self._inline(link["linkedAt"]),
                          "- 数据状态：" + self._inline(business["status"])])
            if business["status"] == "ready":
                historical = business.get("source") == "history_report"
                lines.extend([("- 报表读取时间：" if historical else "- 指标采样时间：") + self._inline(business.get("sampledAt") or "未记录"),
                              "- 数据来源：" + ("罗盘历史直播间详情" if historical else "本机实时采样"),
                              "- 场次状态：" + self._inline(business.get("roomState") or "unknown"),
                              "", "### 历史报表指标" if historical else "### 本机快照指标", ""])
                self._append_business_metrics(lines, business["metrics"], business.get("endpoints", {}))
                report = business.get("historyReport")
                if not historical and isinstance(report, dict):
                    lines.extend(["", "### 历史报表指标", "", "- 报表读取时间：" + self._inline(report.get("retrievedAt") or "未记录"),
                                  "- 数据来源：罗盘历史直播间详情；与实时采样分开保存", ""])
                    self._append_business_metrics(lines, report.get("metrics") or [], report.get("endpoints") or {})
            else:
                lines.append("- 缺失说明：" + self._inline(business.get("note") or "经营快照不可用"))
        else:
            lines.append("- 尚未确认与罗盘经营场次的对应关系。")
        lines.extend(["", "## 数据边界", "",
                      ("- 经营指标来自已确认关联的本机罗盘实时快照及/或按读取时间保存的历史报表；结算值可能变化，历史报表不进入飞书自动同步；不把整体成交除以消耗当作官方归因 ROI。"
                       if business.get("status") == "ready" else
                       "- 此文档只依据本机录制观察、归档状态与手工填写的复盘内容；尚未关联罗盘经营场次或经营快照不可用，不包含成交、消耗等经营指标。"),
                      "- 接入观察前的片段可能缺失；文件切换及观察中断无法证明直播连续或准确的断流时长。",
                      "- 归档未知间断：" + ("是" if archive and archive.get("unknownGaps") else "未由归档确认；仍需核对原始记录"),
                      ""])
        return "\n".join(lines).encode("utf-8")
