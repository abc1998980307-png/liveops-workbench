"""Local, user-entered team and commerce planning records."""

import json
import hashlib
import os
import re
import threading
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from decimal import Decimal, InvalidOperation


COLLECTION_FIELDS = {
    "teamMembers": {"name": 80, "role": 40, "platform": 40, "account": 120, "active": None},
    "shifts": {"date": 10, "start": 5, "end": 5, "memberId": 36, "role": 40,
               "liveAccount": 120, "notes": 500, "status": 16},
    "stores": {"name": 100, "platform": 20, "shopId": 100, "active": None},
    "products": {"storeId": 36, "name": 120, "sku": 100, "price": 30, "status": 20},
    "brands": {"name": 100, "storeId": 36, "notes": 500, "active": None},
    "goals": {"date": 10, "account": 120, "targetGmv": 30, "targetOrders": 20, "notes": 500},
    "accountMappings": {"name": 80, "sourceAlias": 80, "storeId": 36,
                        "memberId": 36, "qianchuanAlias": 80, "active": None},
}
ENUMS = {
    ("teamMembers", "role"): {"主播", "助播", "场控", "中控", "投手", "其他"},
    ("shifts", "role"): {"主播", "助播", "场控", "中控", "投手"},
    ("shifts", "status"): {"planned", "live", "completed", "invalid"},
    ("stores", "platform"): {"douyin", "kuaishou", "wechat"},
    ("products", "status"): {"active", "inactive"},
}


class WorkspaceError(ValueError):
    pass


class OperationsWorkspace:
    def __init__(self, root):
        self.file = Path(root) / "operations-workspace.json"
        self.lock = threading.RLock()

    @staticmethod
    def _empty():
        return {"schemaVersion": 1, **{name: [] for name in COLLECTION_FIELDS}, "sourceConfirmations": []}

    def _read(self):
        try:
            data = json.loads(self.file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return self._empty()
        except (OSError, ValueError) as error:
            raise WorkspaceError("本机经营配置不可读取；原文件已保留") from error
        if not isinstance(data, dict) or data.get("schemaVersion") != 1:
            raise WorkspaceError("本机经营配置格式不受支持；原文件已保留")
        collections = {}
        for name in COLLECTION_FIELDS:
            records = data.get(name, [])
            if not isinstance(records, list) or any(not isinstance(record, dict) for record in records):
                raise WorkspaceError("本机经营配置内容无效；原文件已保留")
            collections[name] = records
        confirmations = data.get("sourceConfirmations", [])
        if not isinstance(confirmations, list) or any(not isinstance(item, dict) for item in confirmations):
            raise WorkspaceError("本机来源确认记录无效；原文件已保留")
        return {"schemaVersion": 1, **collections, "sourceConfirmations": confirmations}

    @staticmethod
    def source_ref(source_id):
        if not isinstance(source_id, str) or not source_id:
            return None
        return hashlib.sha256(source_id.encode("utf-8")).hexdigest()

    @staticmethod
    def _actor(value):
        if (not isinstance(value, str) or not 1 <= len(value.strip()) <= 80
                or re.search(r"https?://|(?:cookie|token|password)\s*[:=]|\d{8,}", value, re.I)):
            raise WorkspaceError("确认人需填写本机显示名，不得填写标识或凭据")
        return value.strip()

    def _persist(self, data):
        self.file.parent.mkdir(parents=True, exist_ok=True)
        temp = self.file.with_suffix(".tmp")
        temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.chmod(temp, 0o600)
        temp.replace(self.file)

    def confirm_source(self, source_ref, source_alias, mapping_id, actor, candidates):
        actor = self._actor(actor)
        if (not isinstance(source_ref, str) or not re.fullmatch(r"[0-9a-f]{64}", source_ref)
                or not isinstance(source_alias, str) or not source_alias.strip()
                or not isinstance(mapping_id, str)):
            raise WorkspaceError("来源确认参数无效")
        candidate = next((item for item in candidates if item["sourceRef"] == source_ref
                          and item["sourceAlias"] == source_alias), None)
        if not candidate:
            raise WorkspaceError("该重名来源已不在当前本机来源列表，请刷新后重试")
        with self.lock:
            data = self._read()
            mapping = next((item for item in data["accountMappings"] if item["id"] == mapping_id
                            and item["active"] and item["sourceAlias"].casefold() == source_alias.casefold()), None)
            if not mapping:
                raise WorkspaceError("所选直播号对应关系无效")
            now = datetime.now(timezone.utc).isoformat(timespec="seconds")
            for item in data["sourceConfirmations"]:
                if item.get("sourceRef") == source_ref and not item.get("revokedAt"):
                    if item.get("mappingId") == mapping_id:
                        return item
                    item.update({"revokedAt": now, "revokedBy": actor})
            record = {"id": str(uuid.uuid4()), "sourceRef": source_ref, "sourceAlias": source_alias,
                      "mappingId": mapping_id, "confirmedBy": actor, "confirmedAt": now,
                      "revokedBy": None, "revokedAt": None}
            data["sourceConfirmations"].append(record)
            self._persist(data)
            return record

    def revoke_source(self, confirmation_id, actor):
        actor = self._actor(actor)
        with self.lock:
            data = self._read()
            item = next((item for item in data["sourceConfirmations"] if item.get("id") == confirmation_id), None)
            if not item or item.get("revokedAt"):
                raise WorkspaceError("有效的来源确认记录不存在")
            item["revokedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
            item["revokedBy"] = actor
            self._persist(data)
            return item

    def snapshot(self):
        with self.lock:
            return self._read()

    def delete(self, collection, record_id):
        if collection not in COLLECTION_FIELDS:
            raise WorkspaceError("未知的经营配置类别")
        try:
            if not isinstance(record_id, str) or str(uuid.UUID(record_id)) != record_id:
                raise ValueError
        except ValueError as error:
            raise WorkspaceError("记录 ID 无效") from error
        with self.lock:
            data = self._read()
            records = data[collection]
            record = next((item for item in records if item.get("id") == record_id), None)
            if not record:
                raise WorkspaceError("记录不存在")
            references = {
                "teamMembers": (("shifts", "memberId"), ("accountMappings", "memberId")),
                "stores": (("products", "storeId"), ("brands", "storeId"), ("accountMappings", "storeId")),
            }
            for related_collection, field in references.get(collection, ()):
                if any(item.get(field) == record_id for item in data[related_collection]):
                    raise WorkspaceError("该记录仍被其他经营登记引用，请先移除关联记录或修改关联")
            if collection == "accountMappings" and any(
                item.get("mappingId") == record_id and not item.get("revokedAt")
                for item in data["sourceConfirmations"]
            ):
                raise WorkspaceError("该对应关系仍有有效来源确认，请先撤销确认")
            records.remove(record)
            self._persist(data)
            return record

    def save(self, collection, payload):
        if collection not in COLLECTION_FIELDS:
            raise WorkspaceError("未知的经营配置类别")
        if not isinstance(payload, dict):
            raise WorkspaceError("记录必须是 JSON 对象")
        allowed = set(COLLECTION_FIELDS[collection]) | {"id"}
        if set(payload) - allowed:
            raise WorkspaceError("记录包含不支持的字段")
        record = {}
        for field, limit in COLLECTION_FIELDS[collection].items():
            value = payload.get(field, False if field == "active" else "")
            if limit is None:
                if not isinstance(value, bool):
                    raise WorkspaceError(f"{field} 必须是布尔值")
            elif not isinstance(value, str) or len(value) > limit:
                raise WorkspaceError(f"{field} 必须是长度不超过 {limit} 的文本")
            if value and (collection, field) in ENUMS and value not in ENUMS[(collection, field)]:
                raise WorkspaceError(f"{field} 的选项无效")
            record[field] = value
        if collection == "teamMembers" and not record["name"]:
            raise WorkspaceError("成员姓名不能为空")
        if collection == "accountMappings" and (not record["name"] or not record["sourceAlias"]):
            raise WorkspaceError("直播号显示名和来源别名不能为空")
        if collection == "accountMappings":
            for key in ("name", "sourceAlias", "qianchuanAlias"):
                record[key] = record[key].strip()
                value = record[key]
                if (value and (re.search(r"https?://|(?:cookie|token|password)\s*[:=]", value, re.I)
                               or re.fullmatch(r"\d{8,}", value)
                               or re.fullmatch(r"[0-9a-f]{8}-[0-9a-f-]{27,}", value, re.I))):
                    raise WorkspaceError("只允许填写本机显示名或别名，不保存账户标识或凭据")
            if not record["name"] or not record["sourceAlias"]:
                raise WorkspaceError("直播号显示名和来源别名不能为空")
        if collection == "stores" and (not record["name"] or not record["platform"]):
            raise WorkspaceError("店铺名称和平台不能为空")
        if collection == "shifts":
            if not record["date"] or not record["memberId"] or not record["role"]:
                raise WorkspaceError("排班日期、成员和岗位不能为空")
            try:
                parsed_date = date.fromisoformat(record["date"])
            except ValueError as error:
                raise WorkspaceError("排班日期无效") from error
            if parsed_date.isoformat() != record["date"]:
                raise WorkspaceError("排班日期需使用 YYYY-MM-DD 格式")
            for value in (record["start"], record["end"]):
                if value and (len(value) != 5 or value[2] != ":" or not value[:2].isdigit() or not value[3:].isdigit() or int(value[:2]) > 23 or int(value[3:]) > 59):
                    raise WorkspaceError("时间需使用 24 小时制 HH:MM")
        if collection == "products" and (not record["name"] or not record["storeId"]):
            raise WorkspaceError("商品名称和所属店铺不能为空")
        if collection == "products" and record["price"]:
            if not re.fullmatch(r"\d+(?:\.\d{1,2})?", record["price"]):
                raise WorkspaceError("商品标价需填写最多两位小数的非负金额")
            try:
                price = Decimal(record["price"])
            except InvalidOperation as error:
                raise WorkspaceError("商品标价需填写非负金额") from error
            if not price.is_finite() or price < 0 or price.as_tuple().exponent < -2:
                raise WorkspaceError("商品标价需填写最多两位小数的非负金额")
        if collection == "brands" and not record["name"]:
            raise WorkspaceError("品牌名称不能为空")
        if collection == "goals":
            if not record["date"] or not record["account"]:
                raise WorkspaceError("目标日期和账号不能为空")
            try:
                parsed_date = date.fromisoformat(record["date"])
            except ValueError as error:
                raise WorkspaceError("目标日期无效") from error
            if parsed_date.isoformat() != record["date"]:
                raise WorkspaceError("目标日期需使用 YYYY-MM-DD 格式")
            for key in ("targetGmv", "targetOrders"):
                value = record[key]
                if value and (not value.isdigit() or len(value) > 16):
                    raise WorkspaceError("目标金额和订单数需填写非负整数")

        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with self.lock:
            data = self._read()
            records = data[collection]
            if collection == "shifts" and not any(item.get("id") == record["memberId"] for item in data["teamMembers"]):
                raise WorkspaceError("排班关联的团队成员不存在")
            if collection in {"products", "brands"} and record.get("storeId") and not any(
                item.get("id") == record["storeId"] for item in data["stores"]
            ):
                raise WorkspaceError("关联店铺不存在")
            if collection == "accountMappings":
                for key, parent in (("storeId", "stores"), ("memberId", "teamMembers")):
                    if record[key] and not any(item.get("id") == record[key] for item in data[parent]):
                        raise WorkspaceError("关联成员或店铺不存在")
                if any(item.get("sourceAlias", "").casefold() == record["sourceAlias"].casefold()
                       and item.get("id") != payload.get("id") for item in records):
                    raise WorkspaceError("来源别名已被其他直播号使用")
            record_id = payload.get("id")
            if record_id:
                if not isinstance(record_id, str) or len(record_id) != 36:
                    raise WorkspaceError("记录 ID 无效")
                try:
                    if str(uuid.UUID(record_id)) != record_id:
                        raise ValueError
                except ValueError as error:
                    raise WorkspaceError("记录 ID 无效") from error
                existing = next((item for item in records if item.get("id") == record_id), None)
                if not existing:
                    raise WorkspaceError("记录不存在")
                record.update({"id": record_id, "createdAt": existing.get("createdAt", now), "updatedAt": now})
                records[records.index(existing)] = record
            else:
                record.update({"id": str(uuid.uuid4()), "createdAt": now, "updatedAt": now})
                records.append(record)
            self._persist(data)
            return record
