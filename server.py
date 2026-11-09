#!/usr/bin/env python3
"""Local-only adapter between the dashboard and its companion services."""

import json
import importlib.util
import mimetypes
import os
import re
import shutil
import signal
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from rpa_bridge import COLLECTOR
from recorder_service import RecorderManager, RecorderError


ROOT = Path(__file__).resolve().parent
DATA_ROOT = Path.home() / "Library" / "Application Support" / "LiveOps"
RECORDINGS = DATA_ROOT / "recordings"
TRANSCRIPTS = DATA_ROOT / "transcripts"
ACCOUNT_FILE = DATA_ROOT / "accounts.json"
SETTINGS_FILE = DATA_ROOT / "dashboard-settings.json"
EGO_SETUP_FILE = DATA_ROOT / "ego-setup.json"
BGO_SETTINGS_FILE = DATA_ROOT / "plugin-settings" / "bililive-go.json"
DAILYHOT_DIR = DATA_ROOT / "plugins" / "dailyhot-api"
DAILYHOT_ENV_FILE = DAILYHOT_DIR / ".env"
MEDIA_PIPELINE_DIR = DATA_ROOT / "plugins" / "media-pipeline"
MEDIA_PIPELINE_FILE = ROOT / "media_pipeline.py"
if not MEDIA_PIPELINE_FILE.is_file():
    MEDIA_PIPELINE_FILE = MEDIA_PIPELINE_DIR / "media_pipeline.py"
MEDIA_SETTINGS_FILE = DATA_ROOT / "plugin-settings" / "media-pipeline.json"
BGO = os.environ.get("LIVEOPS_BGO_URL", "http://127.0.0.1:18080").rstrip("/")
HOT_API = os.environ.get("LIVEOPS_HOT_API_URL", "http://127.0.0.1:16688").rstrip("/")
PORT = int(os.environ.get("LIVEOPS_PORT", "8765"))
DOUYIN_HOSTS = {"live.douyin.com", "v.douyin.com"}
RECORDER = RecorderManager(DATA_ROOT, BGO)

DATA_ROOT.mkdir(parents=True, exist_ok=True)
RECORDINGS.mkdir(parents=True, exist_ok=True)
TRANSCRIPTS.mkdir(parents=True, exist_ok=True)

_pipeline_spec = importlib.util.spec_from_file_location("liveops_media_pipeline", MEDIA_PIPELINE_FILE)
MEDIA_PIPELINE = importlib.util.module_from_spec(_pipeline_spec) if _pipeline_spec else None
if _pipeline_spec and _pipeline_spec.loader:
    _pipeline_spec.loader.exec_module(MEDIA_PIPELINE)


def read_accounts():
    try:
        value = json.loads(ACCOUNT_FILE.read_text(encoding="utf-8"))
        return value if isinstance(value, list) else []
    except (OSError, ValueError):
        return []


def write_accounts(accounts):
    temp_file = ACCOUNT_FILE.with_suffix(".tmp")
    temp_file.write_text(json.dumps(accounts, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_file.replace(ACCOUNT_FILE)


def ego_setup_snapshot():
    """Expose a bounded verification record, never a live browser-session claim."""
    try:
        if EGO_SETUP_FILE.stat().st_size > 32768:
            return {"configured": False}
        record = json.loads(EGO_SETUP_FILE.read_text(encoding="utf-8"))
        if not isinstance(record, dict) or record.get("provider") not in ("compass", "qianchuan"):
            return {"configured": False}
        limits = {"accountName": 100, "authorId": 30, "verifiedAt": 64,
                  "localAccountId": 36, "historySummary": 1000, "nextStep": 500}
        fields = {}
        for key, limit in limits.items():
            value = record.get(key, "")
            if not isinstance(value, str) or len(value) > limit:
                return {"configured": False}
            fields[key] = value.strip()
        if not fields["accountName"] or not re.fullmatch(r"[0-9]{1,30}", fields["authorId"]):
            return {"configured": False}
        verified_at = datetime.fromisoformat(fields["verifiedAt"].replace("Z", "+00:00"))
        if verified_at.tzinfo is None:
            return {"configured": False}
        local_id = fields["localAccountId"]
        if local_id and (str(uuid.UUID(local_id)) != local_id):
            return {"configured": False}
        room_count = record.get("liveRoomCount")
        if room_count is not None and (type(room_count) is not int or not 0 <= room_count <= 10000):
            return {"configured": False}
        spend_status = record.get("spendStatus", "pending_verification")
        if spend_status not in ("pending_authorization", "pending_verification", "verified", "unavailable"):
            return {"configured": False}
        return {"configured": True, "provider": record["provider"], **fields,
                "liveRoomCount": room_count, "spendStatus": spend_status}
    except (OSError, ValueError):
        return {"configured": False}


def read_settings():
    defaults = {"accountRefreshSeconds": 10, "hotwordsRefreshSeconds": 300, "recordingDirectory": str(RECORDINGS)}
    try:
        value = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        if isinstance(value, dict):
            defaults.update({key: value[key] for key in defaults if key in value})
    except (OSError, ValueError):
        pass
    return defaults


def parse_env_file(path):
    values = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return values
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values[key.strip()] = value.strip().strip("\"'")
    return values


def write_env_values(path, updates):
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        lines = []
    remaining = {key: str(value) for key, value in updates.items()}
    output = []
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key = stripped.split("=", 1)[0].strip()
            if key in remaining:
                output.append(f"{key}={remaining.pop(key)}")
                continue
        output.append(line)
    output.extend(f"{key}={value}" for key, value in remaining.items())
    content = "\n".join(output) + "\n"
    temp_file = path.with_suffix(".tmp")
    temp_file.write_text(content, encoding="utf-8")
    temp_file.replace(path)


def selected_bgo_settings(config):
    split = config.get("video_split_strategies") or {}
    finished = config.get("on_record_finished") or {}
    return {
        "interval": config.get("interval", 20),
        "out_put_path": config.get("out_put_path", str(RECORDINGS)),
        "ffmpeg_path": config.get("ffmpeg_path") or str(DATA_ROOT / "tools/imageio-ffmpeg/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1"),
        "out_put_tmpl": config.get("out_put_tmpl", ""),
        "split_on_title": bool(split.get("on_room_name_changed", False)),
        "max_duration": duration_seconds(split.get("max_duration", 0)),
        "max_file_size": split.get("max_file_size", "0"),
        "fix_flv_at_first": bool(finished.get("fix_flv_at_first", True)),
        "convert_to_mp4": bool(finished.get("convert_to_mp4", False)),
        "danmaku_enable": bool(config.get("danmaku_enable", False)),
        "timeout_seconds": max(1, int(config.get("timeout_in_us", 60000000)) // 1000000),
    }


def duration_seconds(value):
    """The recorder API serializes Go durations as nanoseconds."""
    if isinstance(value, (int, float)):
        return int(value / 1_000_000_000)
    text = str(value)
    parts = re.findall(r"(\d+(?:\.\d+)?)(h|ms|us|ns|m|s)", text)
    if parts and "".join(number + unit for number, unit in parts) == text:
        factors = {"h": 3600, "m": 60, "s": 1, "ms": .001, "us": .000001, "ns": .000000001}
        return int(sum(float(number) * factors[unit] for number, unit in parts))
    return 0


def settings_snapshot():
    try:
        config = service_request(BGO, path="/api/config", timeout=3)
        bgo_error = None
        bgo_current = selected_bgo_settings(config)
    except (OSError, ValueError, urllib.error.URLError, TypeError) as error:
        config, bgo_error, bgo_current = {}, str(error), {}
    pending = {}
    try:
        pending = json.loads(BGO_SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    env = parse_env_file(DAILYHOT_ENV_FILE)
    media = MEDIA_PIPELINE.read_config() if MEDIA_PIPELINE else {}
    dailyhot = {
        "cacheTTL": int(env.get("CACHE_TTL", "3600") or 3600),
        "requestTimeout": int(env.get("REQUEST_TIMEOUT", "6000") or 6000),
        "filterWeiboAds": env.get("FILTER_WEIBO_ADVERTISEMENT", "false").lower() == "true",
    }
    desired_config = {**config, **pending}
    for key in ("video_split_strategies", "on_record_finished"):
        desired_config[key] = {**(config.get(key) or {}), **(pending.get(key) or {})}
    desired_config.setdefault("out_put_path", read_settings()["recordingDirectory"])
    bgo_desired = selected_bgo_settings(desired_config)
    return {
        "dashboard": read_settings(),
        "bililive": {
            "connected": bool(config),
            "current": selected_bgo_settings(config) if config else {},
            "desired": bgo_desired,
            "pendingRestart": bool(config and pending and bgo_desired != bgo_current),
            "configFile": str(BGO_SETTINGS_FILE),
            "error": bgo_error,
        },
        "dailyhot": {
            **dailyhot,
            "pendingRestart": bool(env),
            "envFile": str(DAILYHOT_ENV_FILE),
        },
        "mediaPipeline": {
            **media,
            **(MEDIA_PIPELINE.job_snapshot() if MEDIA_PIPELINE else {}),
        },
    }


def service_request(base_url, method="GET", path="/", payload=None, timeout=8):
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        base_url + path,
        data=body,
        headers={"Content-Type": "application/json"} if body is not None else {},
        method=method,
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
        if not raw:
            return None
        return json.loads(raw.decode("utf-8"))


def normalized_url(value):
    return value.strip().rstrip("/")


def live_minutes(room):
    try:
        started_at = int(room.get("last_start_time_unix") or 0)
    except (TypeError, ValueError):
        return None
    if not started_at:
        return None
    elapsed = datetime.now(timezone.utc).timestamp() - started_at
    return max(0, int(elapsed // 60))


def account_snapshot():
    rooms = service_request(BGO, path="/api/lives", timeout=5)
    room_by_url = {normalized_url(room.get("live_url", "")): room for room in rooms or []}
    output = []
    tracked_urls = set()

    for account in read_accounts():
        room_url = normalized_url(account.get("roomUrl", ""))
        room = room_by_url.get(room_url) if room_url else None
        if room_url:
            tracked_urls.add(room_url)
        output.append({
            **account,
            "bgoId": room.get("id") if room else None,
            "state": (
                "error" if room and room.get("last_error")
                else "live" if room and room.get("status")
                else "paused" if room and not room.get("listening")
                else "offline" if room
                else "pending"
            ),
            "monitoring": bool(room and room.get("listening")),
            "recording": bool(room and room.get("recording")),
            "minutes": live_minutes(room) if room else None,
            "lastError": room.get("last_error") if room else None,
            "room": room.get("room_name") if room else ("尚未绑定直播间链接" if not room_url else "等待开播"),
            "hostName": room.get("host_name") if room else None,
            "viewers": "—",
            "gmv": "—",
            "origin": "bililive-go 状态" if room else "待连接直播间",
        })

    for room in rooms or []:
        room_url = normalized_url(room.get("live_url", ""))
        if room_url in tracked_urls:
            continue
        output.append({
            "id": "bgo_" + str(room.get("id", uuid.uuid4().hex)),
            "name": room.get("host_name") or room.get("room_name") or "未命名直播间",
            "handle": room_url,
            "type": "competitor",
            "roomUrl": room_url,
            "bgoId": room.get("id"),
            "state": "live" if room.get("status") else "offline",
            "monitoring": bool(room.get("listening")),
            "recording": bool(room.get("recording")),
            "minutes": live_minutes(room),
            "lastError": room.get("last_error"),
            "room": room.get("room_name") or "",
            "viewers": "—",
            "gmv": "—",
            "origin": "bililive-go 状态",
        })
    return output


def recording_files():
    allowed = {".mp4", ".flv", ".mkv", ".ts", ".m4v", ".mov", ".mp3", ".aac"}
    results = []
    root = recording_directory()
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in allowed or ".tmp." in path.name:
            continue
        stat = path.stat()
        results.append({
            "name": path.name,
            "path": str(path.relative_to(root)),
            "size": stat.st_size,
            "modified": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
            "url": "/recordings/" + urllib.parse.quote(str(path.relative_to(root))),
        })
    return sorted(results, key=lambda item: item["modified"], reverse=True)


def recording_directory():
    pending = {}
    try:
        pending = json.loads(BGO_SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    configured = pending.get("out_put_path") if isinstance(pending, dict) else None
    if not configured:
        configured = read_settings().get("recordingDirectory")
    if not configured:
        try:
            config = service_request(BGO, path="/api/config", timeout=2)
            configured = config.get("out_put_path") if isinstance(config, dict) else None
        except (OSError, ValueError, urllib.error.URLError, TypeError):
            pass
    return (Path(configured).expanduser() if configured else RECORDINGS).resolve()


def choose_recording_directory():
    script = 'POSIX path of (choose folder with prompt "选择直播录屏保存文件夹")'
    result = subprocess.run(["/usr/bin/osascript", "-e", script], capture_output=True, text=True, timeout=180)
    if result.returncode != 0:
        if "-128" in result.stderr:
            return None
        raise RuntimeError("无法打开系统文件夹选择器")
    selected = Path(result.stdout.strip()).expanduser()
    if not selected.is_absolute() or not selected.is_dir():
        raise ValueError("选择的录屏目录不存在")
    return str(selected.resolve())


class Handler(BaseHTTPRequestHandler):
    server_version = "LiveOpsLocal/1.0"

    def log_message(self, _format, *_args):
        return

    def send_json(self, value, status=200):
        raw = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def read_json(self):
        size = int(self.headers.get("Content-Length", "0"))
        if size > 32768:
            raise ValueError("请求内容过大")
        return json.loads(self.rfile.read(size).decode("utf-8")) if size else {}

    def mutation_origin_allowed(self):
        origin = self.headers.get("Origin")
        if not origin:
            return True
        try:
            parsed = urllib.parse.urlparse(origin)
            return parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost") and parsed.port == PORT
        except ValueError:
            return False

    def rpa_request_allowed(self):
        """Only this dashboard may reach the account-session controls."""
        try:
            host = urllib.parse.urlsplit("http://" + self.headers.get("Host", ""))
            return host.hostname in ("127.0.0.1", "localhost") and host.port == PORT and self.mutation_origin_allowed()
        except ValueError:
            return False

    def rpa_call(self, method, args=None, timeout=12):
        try:
            self.send_json(COLLECTOR.call(method, args, timeout=timeout))
        except (OSError, RuntimeError, ValueError) as error:
            self.send_json({"error": str(error)}, 503)

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        if path == "/api/health":
            self.send_json({"service": "liveops-dashboard", "ready": True})
            return
        if path == "/api/recorder/state":
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机工作台管理录制器"}, 403)
                return
            try:
                self.send_json(RECORDER.state())
            except (OSError, ValueError, RuntimeError) as error:
                self.send_json({"error": str(error)}, getattr(error, "status", 503))
            return
        if path.startswith("/api/rpa/"):
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机操盘台访问"}, 403)
            elif path == "/api/rpa/state":
                self.rpa_call("state")
            elif path == "/api/rpa/ego/state":
                self.send_json(ego_setup_snapshot())
            elif path in ("/api/rpa/feishu", "/api/rpa/feishu/state"):
                self.rpa_call("feishu.state")
            elif path == "/api/rpa/session":
                self.rpa_call("detail", {"account": (query.get("account") or [""])[0], "room": (query.get("room") or [""])[0], "raw": (query.get("raw") or [""])[0] == "1"})
            else:
                self.send_json({"error": "not found"}, 404)
            return
        if path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        if path == "/api/status":
            try:
                rpa = COLLECTOR.call("state", timeout=5)
                rpa_service = {"connected": True, "accounts": len(rpa["accounts"]), "authenticated": sum(bool(a.get("uid")) and a.get("state") in ("ready", "partial") for a in rpa["accounts"])}
            except (OSError, RuntimeError, ValueError) as error:
                rpa_service = {"connected": False, "error": str(error)}
            try:
                bgo, bgo_error = service_request(BGO, path="/api/info", timeout=3), None
            except (OSError, ValueError, urllib.error.URLError) as error:
                bgo, bgo_error = None, str(error)
            try:
                hot, hot_error = service_request(HOT_API, path="/douyin?limit=1", timeout=8), None
            except (OSError, ValueError, urllib.error.URLError) as error:
                hot, hot_error = None, str(error)
            self.send_json({
                "services": {
                    "bililive": {"connected": bgo is not None, "version": bgo.get("app_version") if bgo else None, "error": bgo_error},
                    "dailyhot": {"connected": hot is not None and hot.get("code") == 200, "updatedAt": hot.get("updateTime") if hot else None, "error": hot_error},
                    "buzz": {"connected": bool(MEDIA_PIPELINE and MEDIA_PIPELINE.job_snapshot().get("transcriptionReady")), "engine": "whisper.cpp", "note": "本地中文离线转写"},
                    "keybert": {"connected": False, "note": "可在转写语料积累后安装配置"},
                    "playwright": rpa_service,
                    "compass": {"connected": bool(rpa_service.get("authenticated")), "note": "本机罗盘登录会话"},
                },
                "recordingsDirectory": str(recording_directory()),
                "lastChecked": datetime.now().astimezone().isoformat(),
            })
            return
        if path == "/api/settings":
            try:
                self.send_json(settings_snapshot())
            except (OSError, ValueError, urllib.error.URLError) as error:
                self.send_json({"error": str(error)}, 502)
            return
        if path == "/api/media/jobs":
            self.send_json(MEDIA_PIPELINE.job_snapshot() if MEDIA_PIPELINE else {"enabled": False, "ready": False, "jobs": []})
            return
        if path.startswith("/transcripts/"):
            self.serve_transcript(path[len("/transcripts/"):])
            return
        if path == "/api/accounts":
            try:
                self.send_json({"accounts": account_snapshot(), "connected": True})
            except (OSError, ValueError, urllib.error.URLError) as error:
                self.send_json({"connected": False, "error": str(error), "accounts": read_accounts()}, 503)
            return
        if path == "/api/hotwords":
            limit = min(max(int((query.get("limit") or ["50"])[0]), 1), 100)
            try:
                payload = service_request(HOT_API, path=f"/douyin?cache=false&limit={limit}", timeout=15)
                self.send_json(payload)
            except (OSError, ValueError, urllib.error.URLError) as error:
                self.send_json({"code": 503, "error": str(error), "data": []}, 503)
            return
        if path == "/api/sessions":
            self.send_json({"recordings": recording_files(), "directory": str(recording_directory())})
            return
        if path.startswith("/recordings/"):
            self.serve_recording(path[len("/recordings/"):])
            return
        if path.startswith("/api/"):
            self.send_json({"error": "not found"}, 404)
            return
        self.serve_static(path)

    def do_HEAD(self):
        path = urllib.parse.urlsplit(self.path).path
        if path.startswith("/recordings/"):
            self.serve_recording(path[len("/recordings/"):], head_only=True)
        elif path.startswith("/transcripts/"):
            self.serve_transcript(path[len("/transcripts/"):], head_only=True)
        else:
            self.serve_static(path, head_only=True)

    def do_POST(self):
        if not self.mutation_origin_allowed():
            self.send_json({"error": "跨站请求已拒绝"}, 403)
            return
        content_type = self.headers.get("Content-Type", "").lower().split(";", 1)[0].strip()
        if content_type != "application/json":
            self.send_json({"error": "请求需使用 application/json"}, 415)
            return
        path = urllib.parse.urlsplit(self.path).path
        try:
            payload = self.read_json()
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as error:
            self.send_json({"error": str(error)}, 400)
            return

        if path == "/api/choose-recording-directory":
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机操盘台选择目录"}, 403)
                return
            try:
                self.send_json({"path": choose_recording_directory()})
            except ValueError as error:
                self.send_json({"error": str(error)}, 400)
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
                self.send_json({"error": str(error)}, 500)
            return

        if path.startswith("/api/recorder/"):
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机工作台管理录制器"}, 403)
                return
            if not isinstance(payload, dict):
                self.send_json({"error": "请求必须是 JSON 对象"}, 400)
                return
            action = path.removeprefix("/api/recorder/")
            if action not in {"start", "stop", "restart"}:
                self.send_json({"error": "not found"}, 404)
                return
            try:
                self.send_json(getattr(RECORDER, action)())
            except (OSError, ValueError, RuntimeError) as error:
                self.send_json({"error": str(error)}, getattr(error, "status", 503))
            return

        if path.startswith("/api/rpa/"):
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机操盘台访问"}, 403)
                return
            if not isinstance(payload, dict):
                self.send_json({"error": "请求必须是 JSON 对象"}, 400)
                return
            if path == "/api/rpa/accounts":
                self.rpa_call("create", {"label": str(payload.get("label", ""))})
                return
            feishu_match = re.fullmatch(r"/api/rpa/feishu/(config|settings|destination|test|check|sync|monitor)", path)
            if feishu_match:
                action = {"settings": "config", "check": "test"}.get(feishu_match[1], feishu_match[1])
                self.rpa_call("feishu." + action, payload)
                return
            match = re.fullmatch(r"/api/rpa/accounts/([a-f0-9-]{36})/(login|sync|monitor|settings)", path)
            if match:
                self.rpa_call(match[2], {**payload, "id": match[1]}, timeout=45 if match[2] == "login" else 12)
            else:
                self.send_json({"error": "not found"}, 404)
            return

        if path == "/api/accounts":
            name = str(payload.get("name", "")).strip()
            handle = str(payload.get("handle", "")).strip()
            account_type = payload.get("type")
            room_url = normalized_url(str(payload.get("roomUrl", "")))
            if not name or not handle or account_type not in ("own", "competitor"):
                self.send_json({"error": "账号名称、抖音号和账号类型必填"}, 400)
                return
            parsed = urllib.parse.urlparse(room_url) if room_url else None
            if parsed and (parsed.scheme != "https" or parsed.hostname not in DOUYIN_HOSTS or not parsed.path.strip("/") or parsed.username or parsed.password):
                self.send_json({"error": "请使用 https://live.douyin.com/... 直播间地址或 https://v.douyin.com/... 分享短链"}, 400)
                return
            accounts = read_accounts()
            if any(item.get("handle", "").lower() == handle.lower() for item in accounts):
                self.send_json({"error": "该账号已经存在"}, 409)
                return
            account = {
                "id": uuid.uuid4().hex,
                "name": name,
                "handle": handle,
                "type": account_type,
                "roomUrl": room_url,
                "monitoring": False,
                "createdAt": datetime.now(timezone.utc).isoformat(),
            }
            if room_url:
                try:
                    service_request(BGO, method="POST", path="/api/lives", payload=[{"url": room_url, "listen": False}], timeout=15)
                except (OSError, ValueError, urllib.error.URLError) as error:
                    self.send_json({"error": "bililive-go 添加直播间失败：" + str(error)}, 502)
                    return
            accounts.append(account)
            write_accounts(accounts)
            RECORDER.state()
            self.send_json({"account": account, "needsRoomUrl": not bool(room_url)}, 201)
            return

        if path == "/api/settings":
            dashboard = payload.get("dashboard") or {}
            bililive = payload.get("bililive") or {}
            dailyhot = payload.get("dailyhot") or {}
            media = payload.get("mediaPipeline") or {}
            try:
                account_refresh = int(dashboard.get("accountRefreshSeconds", 10))
                hotwords_refresh = int(dashboard.get("hotwordsRefreshSeconds", 300))
                if not 5 <= account_refresh <= 300 or not 60 <= hotwords_refresh <= 3600:
                    raise ValueError("刷新间隔超出允许范围")

                interval = int(bililive.get("interval", 20))
                max_duration = int(bililive.get("max_duration", 0))
                timeout_seconds = int(bililive.get("timeout_seconds", 60))
                max_file_size = str(bililive.get("max_file_size", "0")).strip()
                out_path = Path(str(bililive.get("out_put_path", RECORDINGS))).expanduser()
                ffmpeg_path = str(bililive.get("ffmpeg_path", "")).strip()
                output_template = str(bililive.get("out_put_tmpl", ""))
                if not 5 <= interval <= 300:
                    raise ValueError("bililive-go 监测间隔需为 5–300 秒")
                if max_duration < 0 or max_duration > 86400:
                    raise ValueError("分段时长需为 0–86400 秒，0 表示关闭")
                if not max_file_size.isdigit():
                    raise ValueError("分段文件大小需填写 MB 数值，0 表示关闭")
                if not 5 <= timeout_seconds <= 300:
                    raise ValueError("流读取超时需为 5–300 秒")
                if not out_path.is_absolute():
                    raise ValueError("录制目录必须是绝对路径")
                if ffmpeg_path and not Path(ffmpeg_path).expanduser().is_absolute():
                    raise ValueError("FFmpeg 路径必须是绝对路径")
                if len(output_template) > 500:
                    raise ValueError("文件名模板不能超过 500 个字符")

                cache_ttl = int(dailyhot.get("cacheTTL", 3600))
                request_timeout = int(dailyhot.get("requestTimeout", 6000))
                if not 60 <= cache_ttl <= 86400:
                    raise ValueError("热点缓存时间需为 60–86400 秒")
                if not 1000 <= request_timeout <= 60000:
                    raise ValueError("热点请求超时需为 1000–60000 毫秒")
                video_bitrate = int(media.get("videoBitrateKbps", 2500))
                audio_bitrate = int(media.get("audioBitrateKbps", 96))
                codec = str(media.get("codec", "hevc_videotoolbox"))
                keep_original = media.get("keepOriginal", (MEDIA_PIPELINE.read_config() if MEDIA_PIPELINE else {}).get("keepOriginal", True))
                if not isinstance(keep_original, bool):
                    raise ValueError("源文件保留选项必须为布尔值")
                language = str(media.get("language", "zh"))
                model = Path(str(media.get("model", str(DATA_ROOT / "plugins" / "buzz" / "whisper.cpp" / "models" / "ggml-small-q5_1.bin")))).expanduser()
                if not 500 <= video_bitrate <= 12000:
                    raise ValueError("压缩视频码率需为 500–12000 Kbps")
                if not 32 <= audio_bitrate <= 320:
                    raise ValueError("压缩音频码率需为 32–320 Kbps")
                if codec not in {"hevc_videotoolbox", "h264_videotoolbox", "libx265", "libx264"}:
                    raise ValueError("不支持的压缩编码器")
                if language not in {"zh", "auto", "en", "ja", "ko"}:
                    raise ValueError("请选择支持的转写语言")
                if not model.is_absolute():
                    raise ValueError("Whisper 模型路径必须是绝对路径")

                try:
                    bgo_pending = service_request(BGO, path="/api/config", timeout=3)
                except (OSError, ValueError, urllib.error.URLError):
                    try:
                        bgo_pending = json.loads(BGO_SETTINGS_FILE.read_text(encoding="utf-8"))
                    except (OSError, ValueError):
                        bgo_pending = {}
                if not isinstance(bgo_pending, dict):
                    raise ValueError("录制器配置格式错误")

                settings = {
                    "accountRefreshSeconds": account_refresh,
                    "hotwordsRefreshSeconds": hotwords_refresh,
                    "recordingDirectory": str(out_path),
                }
                SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
                temp_file = SETTINGS_FILE.with_suffix(".tmp")
                temp_file.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")
                temp_file.replace(SETTINGS_FILE)

                bgo_pending["interval"] = interval
                bgo_pending["out_put_path"] = str(out_path)
                bgo_pending["ffmpeg_path"] = str(Path(ffmpeg_path).expanduser()) if ffmpeg_path else ""
                bgo_pending["out_put_tmpl"] = output_template
                bgo_pending.setdefault("video_split_strategies", {}).update({
                    "on_room_name_changed": bool(bililive.get("split_on_title")),
                    "max_duration": str(max_duration) + "s",
                    "max_file_size": f"{max_file_size}M" if int(max_file_size) else "0",
                })
                bgo_pending.setdefault("on_record_finished", {}).update({
                    "fix_flv_at_first": bool(bililive.get("fix_flv_at_first")),
                    "convert_to_mp4": bool(bililive.get("convert_to_mp4")),
                })
                bgo_pending["danmaku_enable"] = bool(bililive.get("danmaku_enable"))
                bgo_pending["timeout_in_us"] = timeout_seconds * 1000000
                BGO_SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
                bgo_temp = BGO_SETTINGS_FILE.with_suffix(".tmp")
                bgo_temp.write_text(json.dumps(bgo_pending, ensure_ascii=False, indent=2), encoding="utf-8")
                bgo_temp.replace(BGO_SETTINGS_FILE)
                write_env_values(DAILYHOT_ENV_FILE, {
                    "CACHE_TTL": cache_ttl,
                    "REQUEST_TIMEOUT": request_timeout,
                    "FILTER_WEIBO_ADVERTISEMENT": str(bool(dailyhot.get("filterWeiboAds"))).lower(),
                })
                MEDIA_PIPELINE_DIR.mkdir(parents=True, exist_ok=True)
                media_config = {
                    "enabled": bool(media.get("enabled", True)),
                    "codec": codec,
                    "videoBitrateKbps": video_bitrate,
                    "audioBitrateKbps": audio_bitrate,
                    "language": language,
                    "model": str(model),
                    "keepOriginal": keep_original,
                    "recordingDirectory": str(out_path),
                }
                MEDIA_SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
                media_temp = MEDIA_SETTINGS_FILE.with_suffix(".tmp")
                media_temp.write_text(json.dumps(media_config, ensure_ascii=False, indent=2), encoding="utf-8")
                media_temp.replace(MEDIA_SETTINGS_FILE)
                self.send_json({"ok": True, "settings": settings_snapshot()})
            except (TypeError, ValueError, OSError) as error:
                self.send_json({"error": str(error)}, 400)
            return

        parts = path.strip("/").split("/")
        if len(parts) == 4 and parts[:2] == ["api", "accounts"] and parts[3] == "monitor":
            account_id = parts[2]
            accounts = read_accounts()
            account = next((item for item in accounts if item.get("id") == account_id), None)
            if not account or not account.get("roomUrl"):
                self.send_json({"error": "请先添加抖音直播间链接，个人抖音号本身不能交给录制器监控"}, 409)
                return
            try:
                rooms = service_request(BGO, path="/api/lives")
                room = next((item for item in rooms or [] if normalized_url(item.get("live_url", "")) == normalized_url(account["roomUrl"])), None)
                enabled = bool(payload.get("enabled"))
                if not room and enabled:
                    service_request(BGO, method="POST", path="/api/lives", payload=[{"url": account["roomUrl"], "listen": True}])
                elif room:
                    action = "start" if enabled else "stop"
                    service_request(BGO, path=f"/api/lives/{urllib.parse.quote(str(room['id']))}/{action}")
                account["monitoring"] = enabled
                write_accounts(accounts)
                RECORDER.state()
                self.send_json({"ok": True, "accounts": account_snapshot()})
            except (OSError, ValueError, urllib.error.URLError) as error:
                self.send_json({"error": str(error)}, 502)
            return
        self.send_json({"error": "not found"}, 404)

    def do_DELETE(self):
        if not self.mutation_origin_allowed():
            self.send_json({"error": "跨站请求已拒绝"}, 403)
            return
        path = urllib.parse.urlsplit(self.path).path
        parts = path.strip("/").split("/")
        if len(parts) != 3 or parts[:2] != ["api", "accounts"]:
            self.send_json({"error": "not found"}, 404)
            return
        accounts = read_accounts()
        account = next((item for item in accounts if item.get("id") == parts[2]), None)
        if not account:
            self.send_json({"error": "账号不存在"}, 404)
            return
        try:
            remaining_accounts = [item for item in accounts if item.get("id") != account["id"]]
            shared_room = account.get("roomUrl") and any(
                normalized_url(item.get("roomUrl", "")) == normalized_url(account["roomUrl"])
                for item in remaining_accounts
            )
            if account.get("roomUrl") and not shared_room:
                rooms = service_request(BGO, path="/api/lives")
                room = next((item for item in rooms or [] if normalized_url(item.get("live_url", "")) == normalized_url(account["roomUrl"])), None)
                if room:
                    service_request(BGO, method="DELETE", path=f"/api/lives/{urllib.parse.quote(str(room['id']))}")
            write_accounts(remaining_accounts)
            RECORDER.state()
            self.send_json({"ok": True})
        except (OSError, ValueError, urllib.error.URLError) as error:
            self.send_json({"error": str(error)}, 502)

    def serve_recording(self, encoded_path, head_only=False):
        relative = Path(urllib.parse.unquote(encoded_path))
        root = recording_directory()
        candidate = (root / relative).resolve()
        if not candidate.is_relative_to(root) or not candidate.is_file():
            self.send_json({"error": "录屏文件不存在"}, 404)
            return
        self.serve_file(candidate, head_only=head_only)

    def serve_transcript(self, encoded_path, head_only=False):
        relative = Path(urllib.parse.unquote(encoded_path))
        candidate = (TRANSCRIPTS / relative).resolve()
        if not candidate.is_relative_to(TRANSCRIPTS.resolve()) or not candidate.is_file():
            self.send_json({"error": "转写文件不存在"}, 404)
            return
        self.serve_file(candidate, head_only=head_only)

    def serve_static(self, url_path, head_only=False):
        requested = urllib.parse.unquote(url_path)
        if requested not in ("", "/", "/直播操盘台.html", "/rpa-ui.js", "/rpa-ui.css", "/feishu-ui.js", "/feishu-ui.css"):
            self.send_json({"error": "not found"}, 404)
            return
        candidate = ROOT / (requested.lstrip("/") if requested in ("/rpa-ui.js", "/rpa-ui.css", "/feishu-ui.js", "/feishu-ui.css") else "直播操盘台.html")
        if not candidate.is_file():
            self.send_json({"error": "not found"}, 404)
            return
        self.serve_file(candidate, head_only=head_only)

    def serve_file(self, path, head_only=False):
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        file_size = path.stat().st_size
        start, end = 0, file_size - 1
        status = 200
        range_header = self.headers.get("Range")
        if range_header:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
            if not match or file_size == 0:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{file_size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            first, last = match.groups()
            if not first and not last:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{file_size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if first:
                start = int(first)
                end = min(int(last), file_size - 1) if last else file_size - 1
            elif last:
                suffix_length = int(last)
                start = max(file_size - suffix_length, 0)
            if start >= file_size or end < start:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{file_size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            status = 206
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", content_type + ("; charset=utf-8" if content_type.startswith("text/") else ""))
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if head_only:
            return
        with path.open("rb") as source:
            source.seek(start)
            remaining = length
            while remaining:
                chunk = source.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)


class LocalHTTPServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        if sys.exc_info()[0] is BrokenPipeError:
            return
        super().handle_error(request, client_address)


if __name__ == "__main__":
    def stop_on_signal(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop_on_signal)
    server = LocalHTTPServer(("127.0.0.1", PORT), Handler)
    media_worker = MEDIA_PIPELINE.start_worker() if MEDIA_PIPELINE else None
    print(f"Live Ops adapter listening at http://127.0.0.1:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        COLLECTOR.close()
        if MEDIA_PIPELINE:
            MEDIA_PIPELINE.stop_worker()
        server.server_close()
