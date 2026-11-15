"""Local selection of the current Qianchuan advertising account."""

import json
import os
import threading
import uuid
from pathlib import Path


class QianchuanAccountStore:
    def __init__(self, data_root):
        self.path = Path(data_root) / "qianchuan-current-account.json"
        self.lock = threading.RLock()

    def _read(self):
        try:
            if self.path.stat().st_size > 4096:
                return {}
            value = json.loads(self.path.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            return {}

    @staticmethod
    def _public(value):
        name = value.get("name", "")
        account_id = value.get("accountId", "")
        if not isinstance(name, str) or not isinstance(account_id, str):
            return {"configured": False, "name": "", "maskedId": ""}
        masked = ("*" * (len(account_id) - 4) + account_id[-4:]) if len(account_id) >= 8 else "*" * len(account_id)
        return {"configured": bool(name or account_id), "name": name, "maskedId": masked}

    def state(self):
        with self.lock:
            return self._public(self._read())

    def current_id(self):
        with self.lock:
            account_id = self._read().get("accountId")
        if not isinstance(account_id, str) or not account_id or len(account_id) > 64 or not account_id.isascii() or not account_id.isdigit():
            raise ValueError("请先在“当前使用的户”填写并保存户 ID。")
        return account_id

    def save(self, payload):
        name = payload.get("name", "")
        account_id = payload.get("accountId", "")
        if not isinstance(name, str) or not isinstance(account_id, str):
            raise ValueError("户名称和户 ID 必须是文本")
        if any(ord(char) < 32 for char in name + account_id):
            raise ValueError("户名称或户 ID 含无效字符")
        name, account_id = name.strip(), account_id.strip()
        if len(name) > 80:
            raise ValueError("户名称无效或超过 80 字")
        if account_id and (len(account_id) > 64 or not account_id.isascii() or not account_id.isdigit()):
            raise ValueError("户 ID 只能填写最多 64 位数字")
        with self.lock:
            if not account_id:
                account_id = self._read().get("accountId", "")
            if not name and not account_id:
                raise ValueError("请填写户名称或户 ID")
            value = {"name": name, "accountId": account_id}
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temp_path = self.path.with_name(f".{self.path.name}.{uuid.uuid4().hex}.tmp")
            try:
                descriptor = os.open(temp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, "w", encoding="utf-8") as file:
                    json.dump(value, file, ensure_ascii=False)
                    file.write("\n")
                os.replace(temp_path, self.path)
            finally:
                temp_path.unlink(missing_ok=True)
            return self._public(value)

    def clear(self):
        with self.lock:
            self.path.unlink(missing_ok=True)
            return self._public({})
