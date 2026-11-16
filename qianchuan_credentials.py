"""Optional Qianchuan login details stored only in the OS credential vault."""

import base64
import json
import subprocess
import sys
import threading


SERVICE = "com.liveops.workbench.qianchuan.login"
ENTRY = "official-website"


class CredentialStoreError(RuntimeError):
    pass


class NativeCredentialBackend:
    def read(self):
        if sys.platform == "darwin":
            result = subprocess.run(
                ["/usr/bin/security", "find-generic-password", "-a", ENTRY, "-s", SERVICE, "-w"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False, timeout=15,
            )
            if result.returncode == 44:
                return None
            if result.returncode:
                raise CredentialStoreError("无法读取系统钥匙串")
            return result.stdout.strip().decode("ascii")
        if sys.platform == "win32":
            return _windows_read()
        raise CredentialStoreError("当前系统不支持保存登录账号")

    def write(self, encoded):
        if sys.platform == "darwin":
            # The secret enters security through stdin, never a process argument.
            result = subprocess.run(
                ["/usr/bin/security", "add-generic-password", "-a", ENTRY, "-s", SERVICE, "-U", "-w"],
                input=(encoded + "\n").encode("ascii"), stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, check=False, timeout=15,
            )
            if result.returncode:
                raise CredentialStoreError("无法写入系统钥匙串")
            return
        if sys.platform == "win32":
            _windows_write(encoded)
            return
        raise CredentialStoreError("当前系统不支持保存登录账号")

    def delete(self):
        if sys.platform == "darwin":
            result = subprocess.run(
                ["/usr/bin/security", "delete-generic-password", "-a", ENTRY, "-s", SERVICE],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False, timeout=15,
            )
            if result.returncode not in (0, 44):
                raise CredentialStoreError("无法清除系统钥匙串记录")
            return
        if sys.platform == "win32":
            _windows_delete()
            return
        raise CredentialStoreError("当前系统不支持保存登录账号")


def _windows_api():
    import ctypes
    from ctypes import wintypes

    class Credential(ctypes.Structure):
        _fields_ = [
            ("Flags", wintypes.DWORD), ("Type", wintypes.DWORD),
            ("TargetName", wintypes.LPWSTR), ("Comment", wintypes.LPWSTR),
            ("LastWritten", wintypes.FILETIME), ("CredentialBlobSize", wintypes.DWORD),
            ("CredentialBlob", ctypes.POINTER(ctypes.c_byte)), ("Persist", wintypes.DWORD),
            ("AttributeCount", wintypes.DWORD), ("Attributes", ctypes.c_void_p),
            ("TargetAlias", wintypes.LPWSTR), ("UserName", wintypes.LPWSTR),
        ]

    api = ctypes.WinDLL("Advapi32", use_last_error=True)
    pointer = ctypes.POINTER(Credential)
    api.CredReadW.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(pointer))
    api.CredReadW.restype = wintypes.BOOL
    api.CredWriteW.argtypes = (pointer, wintypes.DWORD)
    api.CredWriteW.restype = wintypes.BOOL
    api.CredDeleteW.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD)
    api.CredDeleteW.restype = wintypes.BOOL
    api.CredFree.argtypes = (ctypes.c_void_p,)
    return ctypes, api, Credential, pointer


def _windows_read():
    ctypes, api, _credential, pointer = _windows_api()
    result = pointer()
    if not api.CredReadW(SERVICE, 1, 0, ctypes.byref(result)):
        if ctypes.get_last_error() == 1168:
            return None
        raise CredentialStoreError("无法读取 Windows 凭据管理器")
    try:
        raw = ctypes.string_at(result.contents.CredentialBlob, result.contents.CredentialBlobSize)
        return raw.decode("utf-16-le")
    finally:
        api.CredFree(result)


def _windows_write(encoded):
    ctypes, api, Credential, _pointer = _windows_api()
    raw = encoded.encode("utf-16-le")
    if len(raw) > 2560:
        raise ValueError("登录保持字段过长")
    blob = (ctypes.c_byte * len(raw)).from_buffer_copy(raw)
    item = Credential()
    item.Type = 1  # CRED_TYPE_GENERIC
    item.TargetName = SERVICE
    item.UserName = ENTRY
    item.CredentialBlobSize = len(raw)
    item.CredentialBlob = blob
    item.Persist = 2  # CRED_PERSIST_LOCAL_MACHINE
    if not api.CredWriteW(ctypes.byref(item), 0):
        raise CredentialStoreError("无法写入 Windows 凭据管理器")


def _windows_delete():
    ctypes, api, _credential, _pointer = _windows_api()
    if not api.CredDeleteW(SERVICE, 1, 0) and ctypes.get_last_error() != 1168:
        raise CredentialStoreError("无法清除 Windows 凭据管理器记录")


class QianchuanCredentialStore:
    def __init__(self, backend=None):
        self.backend = backend or NativeCredentialBackend()
        self.lock = threading.RLock()

    def _read(self):
        encoded = self.backend.read()
        if encoded is None:
            return None
        try:
            value = json.loads(base64.b64decode(encoded, validate=True).decode("utf-8"))
            if isinstance(value, dict) and isinstance(value.get("account"), str) and isinstance(value.get("password"), str):
                return value
        except (ValueError, UnicodeError):
            pass
        raise CredentialStoreError("系统凭据格式无法读取")

    @staticmethod
    def _public(value):
        if value is None:
            return {"saved": False, "maskedAccount": "", "hasPassword": False}
        account = value["account"]
        masked = "*" * max(4, len(account) - 2) + account[-2:] if len(account) > 2 else "*" * len(account)
        return {"saved": True, "maskedAccount": masked, "hasPassword": bool(value["password"])}

    def state(self):
        with self.lock:
            return self._public(self._read())

    def save(self, payload):
        if not isinstance(payload, dict) or set(payload) - {"account", "password"}:
            raise ValueError("登录保持字段无效")
        account, password = payload.get("account"), payload.get("password", "")
        if not isinstance(account, str) or not isinstance(password, str):
            raise ValueError("登录保持字段无效")
        if any(ord(char) < 32 for char in account + password):
            raise ValueError("登录保持字段无效")
        account = account.strip()
        if not account or len(account) > 200 or len(password) > 1000:
            raise ValueError("登录保持字段无效")
        with self.lock:
            value = {"account": account, "password": password}
            encoded = base64.b64encode(json.dumps(value, ensure_ascii=False).encode("utf-8")).decode("ascii")
            self.backend.write(encoded)
            return self._public(value)

    def clear(self):
        with self.lock:
            self.backend.delete()
            return self._public(None)
