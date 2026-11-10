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
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from douyin_profile import ProfileLookupError, normalize_profile_link, profile_state_from_response
from rpa_bridge import COLLECTOR
from recorder_service import RecorderManager, RecorderError
from runtime_config import DATA_ROOT
from dependency_service import DependencyManager
from recording_sessions import RecordingSessions
from recording_archives import RecordingArchiveManager
from session_reviews import SessionReviews, ReviewStoreError
from session_links import SessionLinks, LinkStoreError
from keyword_service import KeywordService
from hot_service import HotService, HotServiceError
from service_status import compass_status, feishu_status


ROOT = Path(__file__).resolve().parent
RECORDINGS = DATA_ROOT / "recordings"
TRANSCRIPTS = DATA_ROOT / "transcripts"
ACCOUNT_FILE = DATA_ROOT / "accounts.json"
SETTINGS_FILE = DATA_ROOT / "dashboard-settings.json"
EGO_SETUP_FILE = DATA_ROOT / "ego-setup.json"
BGO_SETTINGS_FILE = DATA_ROOT / "plugin-settings" / "bililive-go.json"
DAILYHOT_DIR = DATA_ROOT / "plugins" / "dailyhot-api"
DAILYHOT_ENV_FILE = DATA_ROOT / "plugin-settings" / "dailyhot.env"
MEDIA_PIPELINE_DIR = DATA_ROOT / "plugins" / "media-pipeline"
MEDIA_PIPELINE_FILE = ROOT / "media_pipeline.py"
if not MEDIA_PIPELINE_FILE.is_file():
    MEDIA_PIPELINE_FILE = MEDIA_PIPELINE_DIR / "media_pipeline.py"
MEDIA_SETTINGS_FILE = DATA_ROOT / "plugin-settings" / "media-pipeline.json"
KEYWORDS = KeywordService(DATA_ROOT, ROOT)
BGO = os.environ.get("LIVEOPS_BGO_URL", "http://127.0.0.1:18080").rstrip("/")
HOT_API = os.environ.get("LIVEOPS_HOT_API_URL", "http://127.0.0.1:16688").rstrip("/")
PORT = int(os.environ.get("LIVEOPS_PORT", "8765"))
DOUYIN_HOSTS = {"live.douyin.com", "v.douyin.com"}
RECORDER = RecorderManager(DATA_ROOT, BGO)
DEPENDENCIES = DependencyManager(DATA_ROOT, ROOT)
HOTWORDS = HotService(DATA_ROOT, ROOT, HOT_API)
RECORDING_SESSIONS = RecordingSessions(DATA_ROOT, lambda path: service_request(BGO, path=path, timeout=3),
                                      lambda: read_settings()["recordingDirectory"])
ACCOUNT_LOCK = threading.RLock()
PROFILE_MONITOR_LOCK = threading.Lock()
PROFILE_MONITOR_WAKE = threading.Event()
PROFILE_POLL_SECONDS = 60
SESSION_SEARCH_MAX_FILES = 2000
SESSION_SEARCH_MAX_FILE_BYTES = 8 * 1024 * 1024
SESSION_SEARCH_MAX_BYTES = 64 * 1024 * 1024
SESSION_SEARCH_MAX_RESULTS = 100
SUBTITLE_TIME_RE = re.compile(
    r"^\s*(?P<start>\d{1,6}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*"
    r"(?P<end>\d{1,6}:\d{2}:\d{2}[,.]\d{1,3})(?:\s+.*)?\s*$"
)

DATA_ROOT.mkdir(parents=True, exist_ok=True)
RECORDINGS.mkdir(parents=True, exist_ok=True)
TRANSCRIPTS.mkdir(parents=True, exist_ok=True)

_pipeline_spec = importlib.util.spec_from_file_location("liveops_media_pipeline", MEDIA_PIPELINE_FILE)
MEDIA_PIPELINE = importlib.util.module_from_spec(_pipeline_spec) if _pipeline_spec else None
if _pipeline_spec and _pipeline_spec.loader:
    _pipeline_spec.loader.exec_module(MEDIA_PIPELINE)

RECORDING_ARCHIVES = RecordingArchiveManager(DATA_ROOT, RECORDING_SESSIONS, MEDIA_PIPELINE,
                                             lambda: read_settings()["recordingDirectory"])
SESSION_LINKS = SessionLinks(DATA_ROOT, RECORDING_SESSIONS,
                             lambda account, room: COLLECTOR.call("room.review", {"account": account, "room": room}, timeout=5))
SESSION_REVIEWS = SessionReviews(DATA_ROOT, RECORDING_SESSIONS, RECORDING_ARCHIVES, links=SESSION_LINKS)


def read_accounts():
    with ACCOUNT_LOCK:
        try:
            value = json.loads(ACCOUNT_FILE.read_text(encoding="utf-8"))
            return value if isinstance(value, list) else []
        except (OSError, ValueError):
            return []


def write_accounts(accounts):
    with ACCOUNT_LOCK:
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
    env = parse_env_file(DAILYHOT_ENV_FILE if DAILYHOT_ENV_FILE.exists() else DAILYHOT_DIR / ".env")
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
            "pendingRestart": None,
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


def account_by_id(accounts, account_id):
    return next((item for item in accounts if item.get("id") == account_id), None)


def has_profile_link_candidate(value):
    return isinstance(value, str) and bool(re.search(
        r"https://(?:(?:www\.)?douyin\.com/(?:user|share/user)/|v\.douyin\.com/)", value, re.IGNORECASE
    ))


def set_profile_result(account_id, profile_url, now, result=None, error=None):
    with ACCOUNT_LOCK:
        accounts = read_accounts()
        account = account_by_id(accounts, account_id)
        if not account or not account.get("monitoring") or account.get("profileUrl") != profile_url:
            return None
        account["profileLastCheck"] = datetime.fromtimestamp(now, timezone.utc).isoformat()
        retry_seconds = PROFILE_POLL_SECONDS * (2 if error else 1)
        account["profileNextCheckAt"] = datetime.fromtimestamp(now + retry_seconds, timezone.utc).isoformat()
        if error:
            account["profileStatus"] = "error"
            account["profileError"] = str(error).replace("\n", " ")[:220]
        else:
            account["profileStatus"] = result["status"]
            account["profileError"] = None
            if result.get("status") == "live" and result.get("roomUrl"):
                account["roomUrl"] = result["roomUrl"]
                account["retiredRoomUrls"] = result.get("retiredRoomUrls", account.get("retiredRoomUrls", []))
            nickname = result.get("nickname")
            if nickname and (not account.get("name") or account["name"] == account.get("handle")):
                account["name"] = nickname
        write_accounts(accounts)
        return dict(account)


def resolve_profile_state(sec_user_id):
    """Read the public profile in an isolated browser, then validate its response."""
    try:
        payload = COLLECTOR.call("profile.lookup", {"secUserId": sec_user_id}, timeout=45)
    except RuntimeError as error:
        raise ProfileLookupError(str(error)) from error
    if isinstance(payload, dict) and isinstance(payload.get("rawJson"), str):
        try:
            payload = json.loads(payload["rawJson"])
        except ValueError as error:
            raise ProfileLookupError("抖音主页接口没有返回有效 JSON 数据") from error
    return profile_state_from_response(payload)


def _profile_check_due(account, now):
    value = account.get("profileNextCheckAt")
    if not value:
        return True
    try:
        due = datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError, OverflowError):
        return True
    return due <= now


def _other_account_uses_room(accounts, account_id, room_url):
    target = normalized_url(room_url)
    for account in accounts:
        if account.get("id") == account_id:
            continue
        urls = [account.get("roomUrl", ""), *account.get("retiredRoomUrls", [])]
        if any(url and normalized_url(url) == target for url in urls):
            return True
    return False


def _sync_profile_room(account, room_url):
    rooms = service_request(BGO, path="/api/lives", timeout=5) or []
    room = next((item for item in rooms if normalized_url(item.get("live_url", "")) == normalized_url(room_url)), None)
    if not room:
        service_request(BGO, method="POST", path="/api/lives", payload=[{"url": room_url, "listen": True}], timeout=15)
    elif not room.get("listening"):
        service_request(BGO, path=f"/api/lives/{urllib.parse.quote(str(room['id']))}/start", timeout=10)

    previous = normalized_url(account.get("roomUrl", ""))
    retired = list(dict.fromkeys(
        normalized_url(url) for url in account.get("retiredRoomUrls", []) if url
    ))
    if previous and previous != normalized_url(room_url):
        retired.append(previous)
    retired = [url for url in dict.fromkeys(retired) if url != normalized_url(room_url)]
    all_accounts = read_accounts()
    for old_url in retired:
        if _other_account_uses_room(all_accounts, account.get("id"), old_url):
            continue
        old = next((item for item in rooms if normalized_url(item.get("live_url", "")) == old_url), None)
        if old and old.get("listening") and not old.get("recording") and not old.get("status"):
            service_request(BGO, path=f"/api/lives/{urllib.parse.quote(str(old['id']))}/stop", timeout=10)
    return retired


def _retire_offline_profile_room(account):
    room_url = normalized_url(account.get("roomUrl", ""))
    if not room_url:
        return
    accounts = read_accounts()
    if _other_account_uses_room(accounts, account.get("id"), room_url):
        return
    rooms = service_request(BGO, path="/api/lives", timeout=5) or []
    room = next((item for item in rooms if normalized_url(item.get("live_url", "")) == room_url), None)
    if room and room.get("listening") and not room.get("recording") and not room.get("status"):
        service_request(BGO, path=f"/api/lives/{urllib.parse.quote(str(room['id']))}/stop", timeout=10)


def profile_monitor_tick(now=None, resolver=None):
    """Poll enabled profile links without coupling checks to browser page refreshes."""
    if not PROFILE_MONITOR_LOCK.acquire(blocking=False):
        return
    try:
        checked_at = time.time() if now is None else now
        resolver = resolver or resolve_profile_state
        due_accounts = [
            dict(account) for account in read_accounts()
            if account.get("profileUrl") and account.get("secUserId")
            and account.get("monitoring") and _profile_check_due(account, checked_at)
        ]
        for account in due_accounts:
            try:
                result = resolver(account["secUserId"])
                if result.get("status") == "live" and result.get("roomUrl"):
                    with ACCOUNT_LOCK:
                        current = account_by_id(read_accounts(), account["id"])
                        if not current or not current.get("monitoring") or current.get("profileUrl") != account["profileUrl"]:
                            continue
                        retired = _sync_profile_room(current, result["roomUrl"])
                        set_profile_result(account["id"], account["profileUrl"], checked_at,
                                           result={**result, "retiredRoomUrls": retired})
                else:
                    with ACCOUNT_LOCK:
                        current = account_by_id(read_accounts(), account["id"])
                        if not current or not current.get("monitoring") or current.get("profileUrl") != account["profileUrl"]:
                            continue
                        if result.get("status") == "offline":
                            _retire_offline_profile_room(current)
                        set_profile_result(account["id"], account["profileUrl"], checked_at, result=result)
            except (OSError, ValueError, ProfileLookupError, urllib.error.URLError) as error:
                set_profile_result(account["id"], account["profileUrl"], checked_at, error=error)
    finally:
        PROFILE_MONITOR_LOCK.release()


def profile_monitor_worker(stop_event):
    while not stop_event.is_set():
        profile_monitor_tick()
        PROFILE_MONITOR_WAKE.wait(timeout=5)
        PROFILE_MONITOR_WAKE.clear()


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
        tracked_urls.update(normalized_url(url) for url in [room_url, *account.get("retiredRoomUrls", [])] if url)
        is_profile = bool(account.get("profileUrl"))
        profile_candidate = not is_profile and not room_url and has_profile_link_candidate(account.get("handle") or account.get("name"))
        monitoring = bool(account.get("monitoring")) if is_profile else bool(room and room.get("listening"))
        profile_status = account.get("profileStatus")
        profile_error = account.get("profileError")
        if room and room.get("last_error"):
            state = "error"
        elif room and room.get("status"):
            state = "live"
        elif is_profile:
            if not monitoring:
                state = "paused"
            elif profile_error or profile_status == "error":
                state = "error"
            elif profile_status == "offline":
                state = "offline"
            else:
                state = "pending"
        else:
            state = (
                "paused" if room and not room.get("listening")
                else "offline" if room
                else "pending"
            )
        if room:
            room_label = room.get("room_name") or "直播间"
        elif is_profile and monitoring and profile_status == "live":
            room_label = "已发现直播间，等待录制器状态"
        elif is_profile and monitoring and profile_status == "offline":
            room_label = "主页未开播，继续检测"
        elif is_profile and monitoring and profile_error:
            room_label = profile_error
        elif is_profile and monitoring:
            room_label = "正在检查主页开播状态"
        elif is_profile:
            room_label = "主页已添加，尚未开启监测"
        elif profile_candidate:
            room_label = "已识别主页分享链接，可开启监测"
        else:
            room_label = "尚未绑定直播间链接" if not room_url else "等待开播"
        output.append({
            **account,
            "profileCandidate": profile_candidate,
            "bgoId": room.get("id") if room else None,
            "state": state,
            "monitoring": monitoring,
            "recording": bool(room and room.get("recording")),
            "minutes": live_minutes(room) if room else None,
            "lastError": (room.get("last_error") if room else None) or profile_error,
            "room": room_label,
            "hostName": room.get("host_name") if room else None,
            "viewers": "—",
            "gmv": "—",
            "origin": "抖音主页检测 + bililive-go" if is_profile else "抖音主页分享链接" if profile_candidate else "bililive-go 状态" if room else "待连接直播间",
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
        if (path.suffix.lower() not in allowed or ".tmp." in path.name or path.is_symlink()
                or any(part.endswith(".tmp") for part in path.relative_to(root).parts[:-1])):
            continue
        try:
            if not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
                continue
            stat = path.stat()
        except OSError:
            # A completed compression can remove its source during discovery.
            continue
        results.append({
            "name": path.name,
            "path": str(path.relative_to(root)),
            "size": stat.st_size,
            "modified": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
            "url": "/recordings/" + urllib.parse.quote(str(path.relative_to(root))),
        })
    return sorted(results, key=lambda item: item["modified"], reverse=True)


def reveal_recording(relative_path):
    """Ask Finder to reveal a file listed inside the configured recordings directory."""
    if not isinstance(relative_path, str) or not relative_path.strip():
        raise ValueError("请选择一个录屏文件")
    relative = Path(relative_path)
    if relative.is_absolute() or ".." in relative.parts:
        raise PermissionError("只能打开录制目录内的文件")
    root = recording_directory().resolve()
    requested = root / relative
    candidate = requested.resolve(strict=True)
    if not candidate.is_relative_to(root) or requested.is_symlink():
        raise PermissionError("只能打开录制目录内的文件")
    if not candidate.is_file():
        raise IsADirectoryError("请选择一个录屏文件")
    subprocess.run(["/usr/bin/open", "-R", str(candidate)], check=True, timeout=10)


def open_recording_directory():
    directory = recording_directory().resolve(strict=True)
    if not directory.is_dir():
        raise NotADirectoryError("录制保存目录不可用")
    subprocess.run(["/usr/bin/open", str(directory)], check=True, timeout=10)


def _subtitle_seconds(value):
    hours, minutes, seconds = value.replace(",", ".").split(":")
    hours = int(hours)
    minutes = int(minutes)
    seconds = float(seconds)
    if minutes > 59 or seconds >= 60:
        raise ValueError("字幕时间码超出有效范围")
    return hours * 3600 + minutes * 60 + seconds


def _playable_video_index():
    """Match local media for Finder; omit ambiguous cross-platform matches."""
    root = recording_directory().resolve()
    index = {}
    media_extensions = {".mp4", ".m4v", ".mov", ".flv", ".mkv", ".ts", ".aac", ".mp3"}
    for item in recording_files():
        relative = Path(item["path"])
        candidate = (root / relative).resolve()
        if (not candidate.is_relative_to(root) or not candidate.is_file()
                or (root / relative).is_symlink()):
            continue
        filename = candidate.name
        compressed = filename.endswith(".compressed.mp4")
        if compressed:
            source_name = filename[:-len(".compressed.mp4")]
            possible_id = source_name.rsplit(".", 1)
            if len(possible_id) == 2 and re.fullmatch(r"[a-f0-9]{32}", possible_id[1]):
                source_name = possible_id[0]
        elif candidate.suffix.lower() not in media_extensions:
            continue
        else:
            source_name = filename
        stem = Path(source_name).stem if Path(source_name).suffix.lower() in media_extensions else source_name
        key = (relative.parent.name, stem)
        priority = 2 if compressed else 1
        # Transcripts currently use the account directory name, without platform.
        # Do not silently associate a caption with a different platform's video.
        candidates = index.setdefault(key, {})
        previous = candidates.get(str(relative.parent))
        if previous and previous[0] >= priority:
            continue
        candidates[str(relative.parent)] = (priority, str(relative))
    return {key: next(iter(value.values()))[1] for key, value in index.items() if len(value) == 1}


def _caption_excerpt(caption, needle):
    """Keep the matched words visible even in unusually long subtitle cues."""
    folded = caption.casefold()
    offset = folded.index(needle)
    # Case folding can expand characters (for example, ß -> ss).
    original_offset = 0
    consumed = 0
    while consumed < offset:
        consumed += len(caption[original_offset].casefold())
        original_offset += 1
    start = max(0, original_offset - 70)
    end = min(len(caption), max(start + 240, original_offset + len(needle)))
    return ("…" if start else "") + caption[start:end] + ("…" if end < len(caption) else "")


def search_subtitles(query, limit=50):
    if not isinstance(query, str) or not query.strip() or len(query.strip()) > 100:
        raise ValueError("搜索词需为 1 到 100 个字符")
    query = query.strip()
    limit = min(max(int(limit), 1), SESSION_SEARCH_MAX_RESULTS)
    transcript_root = TRANSCRIPTS.resolve()
    video_index = _playable_video_index()
    subtitle_files = []
    truncated = False
    for path in TRANSCRIPTS.rglob("*.srt"):
        if path.is_symlink():
            continue
        try:
            candidate = path.resolve(strict=True)
            size = candidate.stat().st_size
        except OSError:
            continue
        if not candidate.is_relative_to(transcript_root) or not candidate.is_file():
            continue
        if size > SESSION_SEARCH_MAX_FILE_BYTES:
            truncated = True
            continue
        if len(subtitle_files) >= SESSION_SEARCH_MAX_FILES:
            truncated = True
            break
        subtitle_files.append((candidate.stat().st_mtime, candidate, size))
    subtitle_files.sort(key=lambda item: item[0], reverse=True)

    results = []
    bytes_scanned = 0
    files_scanned = 0
    needle = query.casefold()
    for _modified, path, size in subtitle_files:
        if bytes_scanned + size > SESSION_SEARCH_MAX_BYTES:
            truncated = True
            break
        try:
            with path.open("rb") as handle:
                raw = handle.read(min(SESSION_SEARCH_MAX_FILE_BYTES, SESSION_SEARCH_MAX_BYTES - bytes_scanned) + 1)
        except OSError:
            continue
        if len(raw) > min(SESSION_SEARCH_MAX_FILE_BYTES, SESSION_SEARCH_MAX_BYTES - bytes_scanned):
            truncated = True
            continue
        content = raw.decode("utf-8-sig", errors="replace")
        bytes_scanned += len(raw)
        files_scanned += 1
        relative = path.relative_to(transcript_root)
        recording_path = video_index.get((relative.parent.name, path.stem))
        for block in re.split(r"\n\s*\n", content.replace("\r\n", "\n").replace("\r", "\n")):
            lines = block.splitlines()
            time_index = next((i for i, line in enumerate(lines) if SUBTITLE_TIME_RE.search(line)), None)
            if time_index is None:
                continue
            match = SUBTITLE_TIME_RE.search(lines[time_index])
            caption = " ".join(line.strip() for line in lines[time_index + 1:] if line.strip())
            if not caption or needle not in caption.casefold():
                continue
            try:
                seconds = _subtitle_seconds(match.group("start"))
                end_seconds = _subtitle_seconds(match.group("end"))
                if end_seconds < seconds:
                    continue
            except (ValueError, TypeError):
                continue
            results.append({
                "file": relative.stem,
                "account": relative.parent.name,
                "timestamp": match.group("start").replace(".", ","),
                "seconds": seconds,
                "endSeconds": end_seconds,
                "text": _caption_excerpt(caption, needle),
                "recordingPath": recording_path,
                "subtitleUrl": "/transcripts/" + urllib.parse.quote(str(relative)),
            })
            if len(results) > limit:
                truncated = True
                break
        if len(results) > limit:
            break
    return {
        "query": query,
        "results": results[:limit],
        "count": min(len(results), limit),
        "filesScanned": files_scanned,
        "bytesScanned": bytes_scanned,
        "truncated": truncated,
    }


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
        if path == "/api/dependencies/state":
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机工作台检查安装状态"}, 403)
                return
            self.send_json(DEPENDENCIES.state())
            return
        if path == "/api/hotwords/state":
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机工作台管理热点服务"}, 403)
                return
            self.send_json(HOTWORDS.state())
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
            elif path == "/api/rpa/rooms":
                self.rpa_call("rooms.list", {"account": (query.get("account") or [""])[0],
                                             "offset": (query.get("offset") or ["0"])[0],
                                             "limit": (query.get("limit") or ["50"])[0]})
            else:
                self.send_json({"error": "not found"}, 404)
            return
        if path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        if path == "/api/status":
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机工作台检查数据源状态"}, 403)
                return
            try:
                rpa = COLLECTOR.call("state", timeout=5)
                compass = compass_status(rpa)
                rpa_service = {"connected": True, "state": "ready", "label": "本机服务可用",
                               "accounts": len(rpa["accounts"]), "note": "采集进程可用；罗盘登录、暂停及数据状态单独显示。"}
            except (OSError, RuntimeError, ValueError) as error:
                rpa_service = {"connected": False, "state": "unavailable", "label": "采集器不可用",
                               "error": str(error), "note": str(error)}
                compass = {"connected": False, "state": "unknown", "label": "状态待确认",
                           "note": "无法读取本机采集器状态，请先检查组件。", "error": str(error)}
            try:
                feishu = feishu_status(COLLECTOR.call("feishu.state", timeout=5)) if rpa_service["connected"] else {
                    "connected": False, "state": "unknown", "label": "状态待确认", "note": "本机采集器不可用，无法读取飞书同步状态。"}
            except (OSError, RuntimeError, ValueError) as error:
                feishu = {"connected": False, "state": "unknown", "label": "状态待确认", "note": str(error)}
            try:
                bgo, bgo_error = service_request(BGO, path="/api/info", timeout=3), None
            except (OSError, ValueError, urllib.error.URLError) as error:
                bgo, bgo_error = None, str(error)
            hot = HOTWORDS.state()
            self.send_json({
                "services": {
                    "bililive": {"connected": bgo is not None, "version": bgo.get("app_version") if bgo else None, "error": bgo_error},
                    "dailyhot": {key: hot[key] for key in ("connected", "installed", "dataReady", "updatedAt", "error", "dataError")},
                    "buzz": {"connected": bool(MEDIA_PIPELINE and MEDIA_PIPELINE.job_snapshot().get("transcriptionReady")), "engine": "whisper.cpp", "note": "本地中文离线转写"},
                    "keybert": {"connected": KEYWORDS.state()["installed"], "engine": "KeyBERT", "note": "本机中文语料分析；热词洞察可安装、分析及导出"},
                    "playwright": rpa_service,
                    "compass": compass,
                    "feishu": feishu,
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
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机操盘台访问处理队列"}, 403)
                return
            self.send_json(MEDIA_PIPELINE.job_snapshot() if MEDIA_PIPELINE else {"enabled": False, "ready": False, "jobs": []})
            return
        if path == "/api/recording-sessions":
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机工作台读取录制场次"}, 403)
                return
            snapshot = RECORDING_SESSIONS.snapshot()
            archives = RECORDING_ARCHIVES.snapshot()
            snapshot["archives"] = archives.get("archives", [])
            if archives.get("error"):
                snapshot["error"] = "；".join(filter(None, [snapshot.get("error"), archives["error"]]))
            self.send_json(snapshot)
            return
        if path == "/api/session-reviews":
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机工作台读取复盘"}, 403)
                return
            try:
                self.send_json(SESSION_REVIEWS.list((query.get("sessionId") or [None])[0]))
            except ValueError as error:
                self.send_json({"error": str(error)}, 400)
            except (ReviewStoreError, OSError) as error:
                self.send_json({"error": str(error)}, 500)
            return
        if path == "/api/session-links":
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机工作台读取场次关联"}, 403)
                return
            try:
                self.send_json(SESSION_LINKS.list())
            except (LinkStoreError, OSError) as error:
                self.send_json({"error": str(error)}, 500)
            return
        if path == "/api/session-links/detail":
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机工作台读取场次关联"}, 403)
                return
            try:
                self.send_json(SESSION_LINKS.business_snapshot((query.get("recordingSessionId") or [""])[0]))
            except ValueError as error:
                self.send_json({"error": str(error)}, 400)
            except (LinkStoreError, OSError) as error:
                self.send_json({"error": str(error)}, 500)
            return
        if path == "/api/session-reviews/export":
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机工作台导出复盘"}, 403)
                return
            session_id = (query.get("sessionId") or [""])[0]
            try:
                raw = SESSION_REVIEWS.export_markdown(session_id)
            except FileNotFoundError as error:
                self.send_json({"error": str(error)}, 404)
                return
            except ValueError as error:
                self.send_json({"error": str(error)}, 400)
                return
            except (ReviewStoreError, LinkStoreError, OSError) as error:
                self.send_json({"error": str(error)}, 500)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/markdown; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="liveops-review-' + session_id + '.md"')
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)
            return
        if path == "/api/recording-archives":
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机工作台读取录制归档"}, 403)
                return
            self.send_json(RECORDING_ARCHIVES.snapshot())
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
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机工作台读取榜单"}, 403)
                return
            try:
                limit = int((query.get("limit") or ["50"])[0])
                self.send_json(HOTWORDS.hotwords(limit))
            except ValueError as error:
                self.send_json({"code": 400, "error": str(error), "data": []}, 400)
            except (OSError, HotServiceError) as error:
                self.send_json({"code": 503, "error": str(error), "data": []}, 503)
            return
        if path == "/api/transcript-keywords":
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机工作台分析转写语料"}, 403)
                return
            self.send_json(KEYWORDS.state())
            return
        if path == "/api/sessions":
            self.send_json({"recordings": recording_files(), "directory": str(recording_directory())})
            return
        if path == "/api/session-search":
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机操盘台搜索字幕"}, 403)
                return
            try:
                limit = int((query.get("limit") or ["50"])[0])
                self.send_json(search_subtitles((query.get("q") or [""])[0], limit))
            except ValueError as error:
                self.send_json({"error": str(error)}, 400)
            except OSError as error:
                self.send_json({"error": "字幕搜索失败：" + str(error)}, 500)
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

        if path in ("/api/transcript-keywords/install", "/api/transcript-keywords/analyze", "/api/transcript-keywords/cancel"):
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机工作台管理关键词任务"}, 403)
                return
            if not isinstance(payload, dict) or payload:
                self.send_json({"error": "只接受空对象，语料范围固定为本机转写目录"}, 400)
                return
            try:
                self.send_json(KEYWORDS.start(path.rsplit("/", 1)[-1]))
            except ValueError as error:
                self.send_json({"error": str(error)}, 400)
            except (OSError, RuntimeError) as error:
                self.send_json({"error": str(error)}, 503)
            return
        if path == "/api/dependencies/install":
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机工作台安装组件"}, 403)
                return
            if not isinstance(payload, dict) or payload:
                self.send_json({"error": "此入口只接受空对象，安装版本与目录由工作台确定"}, 400)
                return
            try:
                self.send_json(DEPENDENCIES.install())
            except ValueError as error:
                self.send_json({"error": str(error)}, 400)
            except (OSError, RuntimeError) as error:
                self.send_json({"error": "无法启动安装：" + str(error)}, 503)
            return

        if path in ("/api/hotwords/install", "/api/hotwords/start", "/api/hotwords/stop", "/api/hotwords/restart"):
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机工作台管理热点服务"}, 403)
                return
            if not isinstance(payload, dict) or payload:
                self.send_json({"error": "只接受空对象，服务地址及组件版本由工作台确定"}, 400)
                return
            try:
                action = path.rsplit("/", 1)[-1]
                result = DEPENDENCIES.install(hotwords_only=True) if action == "install" else getattr(HOTWORDS, action)()
                self.send_json(result)
            except ValueError as error:
                self.send_json({"error": str(error)}, 400)
            except (OSError, RuntimeError) as error:
                self.send_json({"error": str(error)}, getattr(error, "status", 503))
            return

        if path == "/api/media/retry":
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机操盘台重试任务"}, 403)
                return
            if not isinstance(payload, dict):
                self.send_json({"error": "请求必须是 JSON 对象"}, 400)
                return
            if not MEDIA_PIPELINE:
                self.send_json({"error": "后处理组件未就绪"}, 503)
                return
            try:
                self.send_json(MEDIA_PIPELINE.retry_job(payload.get("id"), payload.get("recoverTail", False)))
            except FileNotFoundError as error:
                self.send_json({"error": str(error)}, 404)
            except ValueError as error:
                self.send_json({"error": str(error)}, 400)
            except OSError as error:
                self.send_json({"error": "无法保存重试任务：" + str(error)}, 500)
            return

        if path == "/api/recording-sessions/archive":
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机工作台生成录制归档"}, 403)
                return
            if not isinstance(payload, dict):
                self.send_json({"error": "请求必须是 JSON 对象"}, 400)
                return
            try:
                result = RECORDING_ARCHIVES.submit(payload.get("sessionId"))
                self.send_json(result, 202 if result.get("status") in {"queued", "processing"} else 200)
            except FileNotFoundError as error:
                self.send_json({"error": str(error)}, 404)
            except ValueError as error:
                self.send_json({"error": str(error)}, 400)
            except (OSError, RuntimeError, subprocess.SubprocessError) as error:
                self.send_json({"error": str(error)}, 500)
            return

        if path == "/api/session-reviews":
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机工作台保存复盘"}, 403)
                return
            try:
                self.send_json({"review": SESSION_REVIEWS.save(payload)})
            except FileNotFoundError as error:
                self.send_json({"error": str(error)}, 404)
            except ValueError as error:
                self.send_json({"error": str(error)}, 400)
            except (ReviewStoreError, OSError) as error:
                self.send_json({"error": str(error)}, 500)
            return

        if path in ("/api/session-links", "/api/session-links/unlink"):
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机工作台管理场次关联"}, 403)
                return
            try:
                result = SESSION_LINKS.link(payload) if path == "/api/session-links" else SESSION_LINKS.unlink(payload)
                self.send_json({"link": result} if path == "/api/session-links" else result)
            except FileNotFoundError as error:
                self.send_json({"error": str(error)}, 404)
            except ValueError as error:
                self.send_json({"error": str(error)}, 400)
            except (LinkStoreError, OSError) as error:
                self.send_json({"error": str(error)}, 503)
            return

        if path == "/api/recordings/reveal":
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机操盘台打开录屏文件"}, 403)
                return
            if not isinstance(payload, dict):
                self.send_json({"error": "请求必须是 JSON 对象"}, 400)
                return
            try:
                reveal_recording(payload.get("path"))
                self.send_json({"ok": True})
            except ValueError as error:
                self.send_json({"error": str(error)}, 400)
            except PermissionError as error:
                self.send_json({"error": str(error)}, 403)
            except FileNotFoundError as error:
                self.send_json({"error": "录屏文件不存在"}, 404)
            except IsADirectoryError as error:
                self.send_json({"error": str(error)}, 400)
            except (OSError, subprocess.SubprocessError) as error:
                self.send_json({"error": "Finder 无法定位文件：" + str(error)}, 500)
            return

        if path == "/api/recordings/open-directory":
            if not self.rpa_request_allowed():
                self.send_json({"error": "仅允许从本机操盘台打开录制保存目录"}, 403)
                return
            if not isinstance(payload, dict):
                self.send_json({"error": "请求必须是 JSON 对象"}, 400)
                return
            try:
                open_recording_directory()
                self.send_json({"ok": True})
            except FileNotFoundError as error:
                self.send_json({"error": "录制保存目录不存在"}, 404)
            except NotADirectoryError as error:
                self.send_json({"error": str(error)}, 400)
            except (OSError, subprocess.SubprocessError) as error:
                self.send_json({"error": "Finder 无法打开录制保存目录：" + str(error)}, 500)
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
            match = re.fullmatch(r"/api/rpa/accounts/([a-f0-9-]{36})/(login|sync|monitor|settings|history)", path)
            if match:
                action = "history.page" if match[2] == "history" else match[2]
                self.rpa_call(action, {**payload, "id": match[1]}, timeout=55 if match[2] == "history" else 45 if match[2] == "login" else 12)
            else:
                self.send_json({"error": "not found"}, 404)
            return

        if path == "/api/accounts":
            name = str(payload.get("name", "")).strip()
            handle = str(payload.get("handle", "")).strip()
            account_type = payload.get("type", "own")
            profile_url = str(payload.get("profileUrl", "")).strip()
            room_url = normalized_url(str(payload.get("roomUrl", "")))
            profile = None
            if profile_url:
                try:
                    profile = normalize_profile_link(profile_url)
                except ProfileLookupError as error:
                    self.send_json({"error": str(error)}, 400)
                    return
                profile_url = profile["profileUrl"]
                handle = handle or profile["secUserId"]
                name = name or handle
            if not name or not handle or account_type not in ("own", "competitor"):
                self.send_json({"error": "请提供抖音主页链接和账号类型"}, 400)
                return
            parsed = urllib.parse.urlparse(room_url) if room_url else None
            if parsed and (parsed.scheme != "https" or parsed.hostname not in DOUYIN_HOSTS or not parsed.path.strip("/") or parsed.username or parsed.password):
                self.send_json({"error": "请使用 https://live.douyin.com/... 直播间地址或 https://v.douyin.com/... 分享短链"}, 400)
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
            if profile:
                account.update({
                    "profileUrl": profile_url,
                    "secUserId": profile["secUserId"],
                    "profileStatus": "not_checked",
                    "profileError": None,
                    "profileLastCheck": None,
                    "profileNextCheckAt": None,
                    "retiredRoomUrls": [],
                })
            with ACCOUNT_LOCK:
                accounts = read_accounts()
                if any(
                    item.get("handle", "").lower() == handle.lower()
                    or (profile_url and item.get("profileUrl") == profile_url)
                    for item in accounts
                ):
                    self.send_json({"error": "该账号已经存在"}, 409)
                    return
                if room_url:
                    try:
                        service_request(BGO, method="POST", path="/api/lives", payload=[{"url": room_url, "listen": False}], timeout=15)
                    except (OSError, ValueError, urllib.error.URLError) as error:
                        self.send_json({"error": "bililive-go 添加直播间失败：" + str(error)}, 502)
                        return
                accounts.append(account)
                write_accounts(accounts)
            RECORDER.state()
            self.send_json({"account": account, "needsRoomUrl": not bool(room_url or profile_url)}, 201)
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
            enabled = payload.get("enabled")
            if not isinstance(enabled, bool):
                self.send_json({"error": "监测开关必须为布尔值"}, 400)
                return
            try:
                with ACCOUNT_LOCK:
                    accounts = read_accounts()
                    account = account_by_id(accounts, account_id)
                    if not account:
                        self.send_json({"error": "账号不存在"}, 404)
                        return
                    if (enabled and not account.get("roomUrl") and not account.get("profileUrl")
                            and has_profile_link_candidate(account.get("handle") or account.get("name"))):
                        try:
                            profile = normalize_profile_link(account.get("handle") or account.get("name"))
                        except ProfileLookupError as error:
                            self.send_json({"error": str(error)}, 400)
                            return
                        if account.get("name") == account.get("handle"):
                            account["name"] = profile["secUserId"]
                        account["handle"] = profile["secUserId"]
                        account.update({
                            "profileUrl": profile["profileUrl"],
                            "secUserId": profile["secUserId"],
                            "profileStatus": "not_checked",
                            "profileError": None,
                            "profileLastCheck": None,
                            "profileNextCheckAt": None,
                            "retiredRoomUrls": [],
                        })
                    if not (account.get("roomUrl") or account.get("profileUrl")):
                        self.send_json({"error": "请先添加抖音主页链接"}, 409)
                        return
                    if account.get("profileUrl"):
                        account["monitoring"] = enabled
                        account["profileStatus"] = "checking" if enabled else "paused"
                        account["profileError"] = None
                        account["profileNextCheckAt"] = datetime.now(timezone.utc).isoformat() if enabled else None
                        write_accounts(accounts)
                        if enabled:
                            PROFILE_MONITOR_WAKE.set()
                        elif account.get("roomUrl") and not _other_account_uses_room(accounts, account["id"], account["roomUrl"]):
                            rooms = service_request(BGO, path="/api/lives", timeout=5) or []
                            room = next((item for item in rooms if normalized_url(item.get("live_url", "")) == normalized_url(account["roomUrl"])), None)
                            if room and room.get("listening"):
                                service_request(BGO, path=f"/api/lives/{urllib.parse.quote(str(room['id']))}/stop", timeout=10)
                    else:
                        rooms = service_request(BGO, path="/api/lives")
                        room = next((item for item in rooms or [] if normalized_url(item.get("live_url", "")) == normalized_url(account["roomUrl"])), None)
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
            room_urls = list(dict.fromkeys(
                normalized_url(url) for url in [account.get("roomUrl", ""), *account.get("retiredRoomUrls", [])] if url
            ))
            if room_urls:
                rooms = service_request(BGO, path="/api/lives")
                for room_url in room_urls:
                    if _other_account_uses_room(remaining_accounts, account["id"], room_url):
                        continue
                    room = next((item for item in rooms or [] if normalized_url(item.get("live_url", "")) == room_url), None)
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
        if requested not in ("", "/", "/直播操盘台.html", "/rpa-ui.js", "/rpa-ui.css", "/feishu-ui.js", "/feishu-ui.css", "/dependency-ui.js", "/recording-sessions-ui.js", "/keyword-ui.js", "/hot-service-ui.js"):
            self.send_json({"error": "not found"}, 404)
            return
        candidate = ROOT / (requested.lstrip("/") if requested in ("/rpa-ui.js", "/rpa-ui.css", "/feishu-ui.js", "/feishu-ui.css", "/dependency-ui.js", "/recording-sessions-ui.js", "/keyword-ui.js", "/hot-service-ui.js") else "直播操盘台.html")
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
    RECORDING_SESSIONS.start()
    RECORDING_ARCHIVES.start()
    profile_stop = threading.Event()
    profile_worker = threading.Thread(target=profile_monitor_worker, args=(profile_stop,), name="douyin-profile-monitor", daemon=True)
    profile_worker.start()
    print(f"Live Ops adapter listening at http://127.0.0.1:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        RECORDING_SESSIONS.close()
        RECORDING_ARCHIVES.close()
        profile_stop.set()
        PROFILE_MONITOR_WAKE.set()
        profile_worker.join(timeout=12)
        KEYWORDS.close()
        COLLECTOR.close()
        if MEDIA_PIPELINE:
            MEDIA_PIPELINE.stop_worker()
        server.server_close()
