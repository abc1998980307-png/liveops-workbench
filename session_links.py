"""Explicit local links between recorder sessions and saved Compass rooms."""

import copy
import json
import os
import re
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path


RECORDING_ID = re.compile(r"[0-9a-f]{32}\Z")
ROOM_ID = re.compile(r"\d{1,30}\Z")
UID = re.compile(r"\d{1,30}\Z")
MAX_LINKS = 2000
MAX_BYTES = 2 * 1024 * 1024


class LinkStoreError(RuntimeError):
    pass


def valid_account_id(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except ValueError:
        return False


class SessionLinks:
    def __init__(self, data_root, recording_sessions, lookup, now=None):
        self.file = Path(data_root) / "plugin-settings" / "session-links.json"
        self.recording_sessions = recording_sessions
        self.lookup = lookup
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.lock = threading.RLock()

    @staticmethod
    def _valid_link(item):
        return (isinstance(item, dict) and set(item) == {
            "recordingSessionId", "accountId", "accountUid", "roomId", "roomTitle",
            "accountLabel", "roomStartedAt", "linkedAt"}
            and isinstance(item["recordingSessionId"], str) and RECORDING_ID.fullmatch(item["recordingSessionId"])
            and valid_account_id(item["accountId"])
            and isinstance(item["accountUid"], str) and UID.fullmatch(item["accountUid"])
            and isinstance(item["roomId"], str) and ROOM_ID.fullmatch(item["roomId"])
            and isinstance(item["roomTitle"], str) and len(item["roomTitle"]) <= 200
            and isinstance(item["accountLabel"], str) and len(item["accountLabel"]) <= 100
            and (item["roomStartedAt"] is None or isinstance(item["roomStartedAt"], str) and len(item["roomStartedAt"]) <= 100)
            and isinstance(item["linkedAt"], str) and len(item["linkedAt"]) <= 64)

    def _read(self):
        try:
            if self.file.stat().st_size > MAX_BYTES:
                raise LinkStoreError("场次关联记录过大，原文件未覆盖")
            data = json.loads(self.file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"version": 1, "links": []}
        except (OSError, ValueError) as error:
            raise LinkStoreError("场次关联记录无法读取，原文件未覆盖") from error
        links = data.get("links") if isinstance(data, dict) else None
        if (not isinstance(data, dict) or data.get("version") != 1 or not isinstance(links, list)
                or len(links) > MAX_LINKS or any(not self._valid_link(item) for item in links)
                or len({item["recordingSessionId"] for item in links}) != len(links)):
            raise LinkStoreError("场次关联记录格式异常，原文件未覆盖")
        return data

    def _write(self, data):
        raw = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
        if len(raw) > MAX_BYTES:
            raise LinkStoreError("场次关联记录已达容量上限，原文件未覆盖")
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

    @staticmethod
    def _recording_id(value):
        if not isinstance(value, str) or not RECORDING_ID.fullmatch(value):
            raise ValueError("录制场次 ID 无效")
        return value

    def _recording_exists(self, recording_id):
        try:
            sessions = self.recording_sessions._read()["sessions"]
        except (OSError, ValueError) as error:
            raise LinkStoreError("录制场次记录无法读取") from error
        if not any(item.get("id") == recording_id for item in sessions):
            raise FileNotFoundError("录制场次不存在")

    def list(self):
        with self.lock:
            return {"links": copy.deepcopy(self._read()["links"])}

    def get(self, recording_id):
        self._recording_id(recording_id)
        with self.lock:
            item = next((link for link in self._read()["links"] if link["recordingSessionId"] == recording_id), None)
            return copy.deepcopy(item)

    def link(self, payload):
        if (not isinstance(payload, dict) or set(payload) != {
                "recordingSessionId", "accountId", "roomId", "confirmed", "replace"}):
            raise ValueError("请选择录制场次和经营场次并明确确认")
        recording_id = self._recording_id(payload["recordingSessionId"])
        account_id, room_id = payload["accountId"], payload["roomId"]
        if (not valid_account_id(account_id) or not isinstance(room_id, str) or not ROOM_ID.fullmatch(room_id)
                or payload["confirmed"] is not True or type(payload["replace"]) is not bool):
            raise ValueError("经营账号、场次或确认参数无效")
        self._recording_exists(recording_id)
        try:
            business = self.lookup(account_id, room_id)
        except (OSError, RuntimeError, ValueError) as error:
            raise LinkStoreError("无法核对本机已保存的经营场次：" + str(error)) from error
        if not isinstance(business, dict):
            raise LinkStoreError("本机经营场次响应格式异常")
        account, room = business.get("account"), business.get("room")
        if not isinstance(account, dict) or account.get("id") != account_id:
            raise LinkStoreError("经营账号身份无法核对")
        if not isinstance(room, dict) or str(room.get("id")) != room_id:
            raise FileNotFoundError("所选经营场次不存在于该账号的本机记录")
        uid = account.get("uid")
        if not isinstance(uid, str) or not UID.fullmatch(uid):
            raise ValueError("经营账号尚未核验 UID，不能建立场次关联")
        with self.lock:
            data = self._read()
            existing = next((item for item in data["links"] if item["recordingSessionId"] == recording_id), None)
            if existing:
                if all(existing[key] == value for key, value in (("accountId", account_id), ("roomId", room_id), ("accountUid", uid))):
                    return copy.deepcopy(existing)
                if not payload["replace"]:
                    raise ValueError("该录制场次已有经营关联；更改时请明确确认替换")
            elif len(data["links"]) >= MAX_LINKS:
                raise LinkStoreError("场次关联记录已达上限")
            link = {
                "recordingSessionId": recording_id, "accountId": account_id, "accountUid": uid,
                "roomId": room_id, "roomTitle": str(room.get("title") or "")[:200],
                "accountLabel": str(account.get("label") or "")[:100],
                "roomStartedAt": str(room["startedAt"])[:100] if room.get("startedAt") is not None and not isinstance(room["startedAt"], (dict, list, bool)) else None,
                "linkedAt": self.now().astimezone(timezone.utc).isoformat(),
            }
            if existing:
                data["links"].remove(existing)
            data["links"].append(link)
            self._write(data)
            return copy.deepcopy(link)

    def unlink(self, payload):
        if (not isinstance(payload, dict) or set(payload) != {"recordingSessionId", "confirmed"}
                or payload["confirmed"] is not True):
            raise ValueError("解除关联需要明确确认录制场次")
        recording_id = self._recording_id(payload["recordingSessionId"])
        with self.lock:
            data = self._read()
            remaining = [item for item in data["links"] if item["recordingSessionId"] != recording_id]
            removed = len(remaining) != len(data["links"])
            if removed:
                data["links"] = remaining
                self._write(data)
            return {"removed": removed}

    def business_snapshot(self, recording_id):
        link = self.get(recording_id)
        if not link:
            return {"linked": False, "status": "unlinked"}
        result = {"linked": True, "link": link}
        try:
            business = self.lookup(link["accountId"], link["roomId"])
        except (OSError, RuntimeError, ValueError) as error:
            return {**result, "status": "unavailable", "note": "本机经营数据暂不可读取：" + str(error)[:180]}
        if not isinstance(business, dict):
            return {**result, "status": "unavailable", "note": "本机经营场次响应格式异常，未展示指标"}
        account, room = business.get("account"), business.get("room")
        if not isinstance(account, dict) or account.get("uid") != link["accountUid"]:
            return {**result, "status": "identity_changed", "note": "经营账号身份（UID）与关联时不同，未展示指标"}
        if not isinstance(room, dict) or str(room.get("id")) != link["roomId"]:
            return {**result, "status": "room_missing", "note": "原经营场次不在本机记录中，未展示指标"}
        latest = business.get("latest")
        if not isinstance(latest, dict) or not isinstance(latest.get("metrics"), list):
            return {**result, "status": "no_snapshot", "note": "该经营场次尚无本机指标快照"}
        return {**result, "status": "ready", "sampledAt": latest.get("time"),
                "metrics": latest["metrics"], "endpoints": latest.get("endpoints") if isinstance(latest.get("endpoints"), dict) else {},
                "roomState": room.get("state", "unknown")}
