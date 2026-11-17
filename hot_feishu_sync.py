"""Opt-in, isolated delivery of public hot-list observations to a user-owned table."""

import hashlib
import json
import os
import re
import sqlite3
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path


FIELDS = {"key": "同步键", "term": "监控词", "title": "榜单标题", "hot": "热度",
          "rank": "排名", "sampledAt": "采样时间", "sourceUpdatedAt": "来源更新时间"}
MAX_QUEUE = 5000


class HotFeishuError(ValueError):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise HotFeishuError("飞书请求发生重定向；已停止投递")


def _destination(url):
    try:
        parsed = urllib.parse.urlsplit(url)
        query = urllib.parse.parse_qs(parsed.query)
        port = parsed.port
    except (ValueError, TypeError) as error:
        raise HotFeishuError("目标表链接无效") from error
    path = re.fullmatch(r"/base/([A-Za-z0-9_-]+)/?", parsed.path)
    table = query.get("table", [])
    if (parsed.scheme != "https" or not parsed.hostname or
            not (parsed.hostname == "feishu.cn" or parsed.hostname.endswith(".feishu.cn")) or
            parsed.username or parsed.password or port or not path or
            len(table) != 1 or not re.fullmatch(r"tbl[A-Za-z0-9_-]+", table[0])):
        raise HotFeishuError("请填写含 table 参数的飞书多维表格链接")
    return path[1], table[0]


class HotFeishuSync:
    def __init__(self, root, *, sender=None, now=None):
        root = Path(root)
        self.file = root / "hot-feishu-config.json"
        self.db_file = root / "hot-feishu-queue.sqlite3"
        self.sender = sender or self._send
        self.now = now or time.time
        self.lock = threading.RLock()
        self.busy = False
        self.persistent = self.db_file.exists()
        self.db = sqlite3.connect(self.db_file if self.persistent else ":memory:", check_same_thread=False)
        self.db.execute("""CREATE TABLE IF NOT EXISTS hot_delivery (
            destination TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL,
            status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt REAL NOT NULL DEFAULT 0, delivered_at REAL,
            error TEXT, PRIMARY KEY(destination, key))""")
        self.db.commit()

    def _persist_queue(self):
        if self.persistent:
            return
        self.db_file.parent.mkdir(parents=True, exist_ok=True)
        disk = sqlite3.connect(self.db_file, check_same_thread=False)
        try:
            self.db.backup(disk)
        except Exception:
            disk.close()
            raise
        self.db.close()
        self.db = disk
        self.persistent = True

    def close(self):
        with self.lock:
            self.db.close()

    def _config(self):
        try:
            data = json.loads(self.file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"enabled": False, "appId": "", "appSecret": "", "appToken": "", "tableId": ""}
        except (OSError, ValueError) as error:
            raise HotFeishuError("热词同步配置无法读取；原文件已保留") from error
        if (not isinstance(data, dict) or type(data.get("enabled")) is not bool or
                any(not isinstance(data.get(key), str) for key in ("appId", "appSecret", "appToken", "tableId"))):
            raise HotFeishuError("热词同步配置无效；原文件已保留")
        return data

    def configure(self, *, enabled, app_id="", app_secret="", table_url=""):
        if type(enabled) is not bool or any(not isinstance(value, str) for value in (app_id, app_secret, table_url)):
            raise HotFeishuError("热词同步设置格式无效")
        with self.lock:
            config = self._config()
            if app_id:
                if not re.fullmatch(r"[A-Za-z0-9_-]{3,100}", app_id):
                    raise HotFeishuError("应用 ID 格式无效")
                config["appId"] = app_id
            if app_secret:
                if len(app_secret) > 200 or any(ord(char) < 33 for char in app_secret):
                    raise HotFeishuError("应用密钥格式无效")
                config["appSecret"] = app_secret
            if table_url:
                config["appToken"], config["tableId"] = _destination(table_url)
            if enabled and not all(config[key] for key in ("appId", "appSecret", "appToken", "tableId")):
                raise HotFeishuError("启用前需填写应用凭据和目标表")
            self._persist_queue()
            config["enabled"] = enabled
            raw = json.dumps(config, ensure_ascii=False).encode("utf-8")
            temporary = None
            try:
                with tempfile.NamedTemporaryFile("wb", dir=self.file.parent, delete=False) as handle:
                    temporary = Path(handle.name)
                    os.chmod(temporary, 0o600)
                    handle.write(raw)
                temporary.replace(self.file)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
            return self.state()

    @staticmethod
    def _dest_key(config):
        return hashlib.sha256(f'{config["appToken"]}:{config["tableId"]}'.encode()).hexdigest()

    def state(self):
        with self.lock:
            config = self._config()
            destination = self._dest_key(config) if config["appToken"] and config["tableId"] else ""
            counts = {row[0]: row[1] for row in self.db.execute(
                "SELECT status,COUNT(*) FROM hot_delivery WHERE destination=? GROUP BY status", (destination,))}
            retry = self.db.execute("SELECT MIN(next_attempt) FROM hot_delivery WHERE destination=? AND status='retry'",
                                    (destination,)).fetchone()[0]
            return {"enabled": config["enabled"], "configured": bool(config["appId"] and config["appSecret"] and destination),
                    "hasTarget": bool(destination), "hasCredentials": bool(config["appId"] and config["appSecret"]),
                    "busy": self.busy, "pending": counts.get("pending", 0), "retry": counts.get("retry", 0),
                    "synced": counts.get("synced", 0), "nextRetry": retry, "fields": list(FIELDS.values())}

    def enqueue(self, insight):
        with self.lock:
            config = self._config()
            if not config["enabled"]:
                return self.state()
            if not self.persistent:
                self._persist_queue()
            latest = insight.get("latest") or {}
            sampled = latest.get("sampledAt")
            if not sampled:
                return self.state()
            destination = self._dest_key(config)
            items = latest.get("items") or []
            pending = []
            for term in insight.get("terms") or []:
                word = term["term"]
                matches = [item for item in items if word.casefold() in item["title"].casefold()]
                if not matches:
                    continue
                item = min(matches, key=lambda row: row["rank"])
                version = latest.get("sourceUpdatedAt") or sampled
                key = hashlib.sha256(f'{word.casefold()}\0{version}'.encode()).hexdigest()
                payload = {"key": key, "term": word, "title": item["title"], "hot": str(item["hot"]),
                           "rank": str(item["rank"]), "sampledAt": sampled,
                           "sourceUpdatedAt": latest.get("sourceUpdatedAt") or ""}
                existing = self.db.execute("SELECT 1 FROM hot_delivery WHERE destination=? AND key=?",
                                           (destination, key)).fetchone()
                if not existing:
                    pending.append((destination, key, json.dumps(payload, ensure_ascii=False)))
            count = self.db.execute("SELECT COUNT(*) FROM hot_delivery WHERE status!='synced'").fetchone()[0]
            if count + len(pending) > MAX_QUEUE:
                raise HotFeishuError("热词同步待投递队列已满")
            self.db.executemany("INSERT OR IGNORE INTO hot_delivery(destination,key,payload,status) VALUES(?,?,?,'pending')",
                                pending)
            self.db.commit()
            return self.state()

    def tick(self):
        with self.lock:
            config = self._config()
            if not config["enabled"] or self.busy:
                return False
            destination = self._dest_key(config)
            row = self.db.execute("""SELECT key,payload,attempts FROM hot_delivery WHERE destination=?
                AND status IN ('pending','retry') AND next_attempt<=? ORDER BY next_attempt,key LIMIT 1""",
                (destination, self.now())).fetchone()
            if not row:
                return False
            self.busy = True
            key, payload, attempts = row
            try:
                self.sender(config, json.loads(payload))
            except Exception:
                delay = min(3600, 60 * 2 ** min(attempts, 6))
                self.db.execute("""UPDATE hot_delivery SET status='retry',attempts=?,next_attempt=?,error=?
                    WHERE destination=? AND key=?""", (attempts + 1, self.now() + delay,
                    "投递失败；等待重试", destination, key))
                self.db.commit()
                self.busy = False
                return False
            self.db.execute("""UPDATE hot_delivery SET status='synced',delivered_at=?,error=NULL
                WHERE destination=? AND key=?""", (self.now(), destination, key))
            self.db.commit()
            self.busy = False
            return True

    def retry_now(self):
        with self.lock:
            config = self._config()
            if not config["enabled"]:
                raise HotFeishuError("热词同步尚未启用")
            self.db.execute("UPDATE hot_delivery SET next_attempt=0 WHERE destination=? AND status='retry'",
                            (self._dest_key(config),))
            self.db.commit()
            return self.state()

    @staticmethod
    def _send(config, payload):
        base = f'https://open.feishu.cn/open-apis/bitable/v1/apps/{config["appToken"]}/tables/{config["tableId"]}'
        opener = urllib.request.build_opener(_NoRedirect())
        def request(url, body=None, method="GET", token=None):
            headers = {"Content-Type": "application/json"}
            if token:
                headers["Authorization"] = f"Bearer {token}"
            data = None if body is None else json.dumps(body).encode()
            with opener.open(urllib.request.Request(url, data=data, headers=headers, method=method), timeout=15) as response:
                result = json.load(response)
            if result.get("code") != 0:
                raise HotFeishuError("飞书返回错误；稍后重试")
            return result.get("data") or result
        auth = request("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
                       {"app_id": config["appId"], "app_secret": config["appSecret"]}, "POST")
        token = auth.get("tenant_access_token")
        if not token:
            raise HotFeishuError("飞书未返回访问令牌")
        fields = request(base + "/fields?page_size=100", token=token)
        if fields.get("has_more") or not isinstance(fields.get("items"), list):
            raise HotFeishuError("目标表字段无法完整核对")
        available = {item.get("field_name"): item.get("type") for item in fields["items"]}
        if any(available.get(name) != 1 for name in FIELDS.values()):
            raise HotFeishuError("目标表需包含全部热词文本字段")
        values = {column: str(payload[key]) for key, column in FIELDS.items()}
        found = request(base + "/records/search?page_size=2", {"filter": {"conjunction": "and",
            "conditions": [{"field_name": FIELDS["key"], "operator": "is", "value": [payload["key"]]}]}}, "POST", token)
        records = found.get("items")
        if not isinstance(records, list) or found.get("has_more") or len(records) > 1:
            raise HotFeishuError("目标表同步键不唯一")
        record_id = records[0].get("record_id") if records else None
        if record_id and not re.fullmatch(r"[A-Za-z0-9_-]+", record_id):
            raise HotFeishuError("飞书记录 ID 无效")
        target = base + "/records" + ("/" + record_id if record_id else "?client_token=" + payload["key"][:32])
        saved = request(target, {"fields": values}, "PUT" if record_id else "POST", token)
        if not re.fullmatch(r"[A-Za-z0-9_-]+", str((saved.get("record") or {}).get("record_id") or "")):
            raise HotFeishuError("飞书写入响应缺少记录 ID；将核对同步键后重试")
