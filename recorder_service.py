"""Manage this dashboard's local bililive-go process without shell commands."""

import copy
import json
import os
import re
import signal
import socket
import subprocess
import tarfile
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path


class RecorderError(RuntimeError):
    def __init__(self, message, status=500):
        super().__init__(message)
        self.status = status


def _merge(base, updates):
    result = copy.deepcopy(base)
    for key, value in updates.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


class RecorderManager:
    def __init__(self, data_root, base_url="http://127.0.0.1:18080"):
        self.root = Path(data_root)
        parsed = urllib.parse.urlsplit(base_url)
        if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}
                or parsed.username or parsed.password or parsed.path not in {"", "/"}
                or parsed.query or parsed.fragment):
            raise ValueError("录制器只能绑定本机地址")
        self.port = parsed.port or 80
        self.base_url = "http://127.0.0.1:" + str(self.port)
        self.plugin = self.root / "plugins" / "bililive-go"
        self.binary = self.plugin / "bililive-darwin-arm64"
        self.archive = self.plugin / "v0.8.3-darwin-arm64.tar.gz"
        self.settings_file = self.root / "plugin-settings" / "bililive-go.json"
        self.runtime_file = self.root / "plugin-settings" / "bililive-runtime.yml"
        self.owner_file = self.root / "plugin-settings" / "bililive-process.json"
        self.rooms_file = self.root / "plugin-settings" / "bililive-rooms.json"
        self.log_file = self.root / "logs" / "recorder.log"
        self._lock = threading.RLock()
        self._child = None
        self._error = None
        self.start_timeout = 15
        self.stop_timeout = 15

    @staticmethod
    def _read(path, default):
        try:
            result = json.loads(path.read_text(encoding="utf-8"))
            return result if isinstance(result, type(default)) else copy.deepcopy(default)
        except (OSError, ValueError):
            return copy.deepcopy(default)

    @staticmethod
    def _write(path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=path.parent, mode="w", encoding="utf-8", delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(value, handle, ensure_ascii=False, indent=2)
        try:
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)

    def desired_config(self):
        """Return BGO fields; max_duration is BGO nanoseconds, not UI seconds."""
        dashboard = self._read(self.root / "dashboard-settings.json", {})
        defaults = {
            "interval": 20,
            "out_put_path": dashboard.get("recordingDirectory", str(self.root / "recordings")),
            "ffmpeg_path": str(self.root / "tools/imageio-ffmpeg/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1"),
            "out_put_tmpl": "",
            "video_split_strategies": {"on_room_name_changed": False, "max_duration": 0, "max_file_size": "0"},
            "on_record_finished": {"convert_to_mp4": False, "delete_flv_after_convert": False,
                                   "custom_commandline": "", "fix_flv_at_first": True, "save_cover": False,
                                   "cloud_upload": {"enable": False, "storage_name": "",
                                                    "upload_path_tmpl": "/录播归档/{{ .Platform }}/{{ .HostName }}/{{ .FileName }}",
                                                    "delete_after_upload": False, "delete_all_after_upload": False},
                                   "upload_timing": "after_process", "burn_subtitles": False,
                                   "burn_subtitles_codec": "libx264", "burn_subtitles_crf": "18",
                                   "burn_subtitles_preset": "medium", "burn_delete_ass": False, "burn_delete_source": False},
            "timeout_in_us": 60000000,
            "danmaku_enable": False,
        }
        with self._lock:
            config = _merge(defaults, self._read(self.settings_file, {}))
            if not config.get("ffmpeg_path"):
                config["ffmpeg_path"] = defaults["ffmpeg_path"]
            return config

    def save_desired(self, config):
        if not isinstance(config, dict):
            raise RecorderError("录制器设置必须是对象", 400)
        with self._lock:
            merged = _merge(self.desired_config(), config)
            self._write(self.settings_file, merged)
            return merged

    def _request(self, path):
        with urllib.request.urlopen(self.base_url + path, timeout=2) as response:
            return json.load(response)

    def _probe(self):
        info = self._request("/api/info")
        if not isinstance(info, dict) or "app_version" not in info:
            raise RecorderError("端口上的服务不是 bililive-go", 409)
        rooms = self._request("/api/lives")
        if not isinstance(rooms, list) or any(not isinstance(item, dict) for item in rooms):
            raise RecorderError("录制器直播间状态格式异常", 502)
        return info, rooms

    @staticmethod
    def _identity(pid):
        if not isinstance(pid, int) or pid <= 1:
            return None
        try:
            result = subprocess.run(
                ["/bin/ps", "-ww", "-p", str(pid), "-o", "lstart=", "-o", "command="],
                capture_output=True, text=True, timeout=3,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        return result.stdout.strip() if result.returncode == 0 else None

    def _owned_pid(self):
        owner = self._read(self.owner_file, {})
        pid = owner.get("pid")
        identity = self._identity(pid)
        if (identity and identity == owner.get("identity")
                and str(self.binary) in identity
                and "--config=" + str(self.runtime_file) in identity
                and "--no-launcher" in identity):
            return pid
        return None

    def _port_busy(self):
        with socket.socket() as sock:
            sock.settimeout(.3)
            return sock.connect_ex(("127.0.0.1", self.port)) == 0

    def _capture_rooms(self, rooms):
        saved = []
        for room in rooms:
            url = str(room.get("live_url", "")).strip().rstrip("/")
            if url:
                saved.append({"url": url, "is_listening": bool(room.get("listening")), "scheme": str(room.get("scheme", ""))})
        if saved != self._read(self.rooms_file, []):
            self._write(self.rooms_file, saved)
        elif not self.rooms_file.exists():
            self._write(self.rooms_file, saved)

    def _state(self):
        pid = self._owned_pid()
        info, rooms, connected = {}, [], False
        error = self._error
        try:
            info, rooms = self._probe()
            connected = True
            error = None
            if pid:
                self._capture_rooms(rooms)
        except (OSError, ValueError, RecorderError):
            pass
        recording_count = sum(bool(room.get("recording")) for room in rooms)
        message = ("录制器已连接" if connected else "录制器正在启动或状态异常" if pid else "录制器未启动，点击连接即可启动")
        if connected and not pid:
            message = "已连接到本机已有录制器；停止和重启仅管理由工作台启动的进程"
        return {
            "connected": connected, "installed": self.binary.is_file(), "managed": bool(pid),
            "running": bool(pid), "pid": pid, "message": message, "error": error,
            "version": info.get("app_version"), "recordingCount": recording_count,
            "listeningCount": sum(bool(room.get("listening")) for room in rooms), "roomCount": len(rooms),
            "canStop": bool(pid and connected and not recording_count),
            "canRestart": bool(pid and connected and not recording_count),
        }

    def state(self):
        with self._lock:
            return self._state()

    def _rooms_for_start(self, desired):
        # A first connection imports room links paused. Further starts restore
        # their explicitly chosen monitoring state, captured from the live API.
        stored = self._read(self.rooms_file, [])
        rooms = {str(room.get("url", "")).rstrip("/"): copy.deepcopy(room)
                 for room in stored if isinstance(room, dict) and room.get("url")}
        initial = not self.rooms_file.exists()
        if initial:
            for room in desired.get("live_rooms", []):
                if isinstance(room, dict) and room.get("url"):
                    url = str(room["url"]).rstrip("/")
                    rooms[url] = {"url": url, "is_listening": False, "scheme": ""}
        for account in self._read(self.root / "accounts.json", []):
            if not isinstance(account, dict):
                continue
            url = str(account.get("roomUrl", "")).strip().rstrip("/")
            if url and url not in rooms:
                parsed = urllib.parse.urlsplit(url)
                if parsed.scheme == "https" and parsed.hostname in {"live.douyin.com", "v.douyin.com"} and not parsed.username and not parsed.password:
                    rooms[url] = {"url": url, "is_listening": False, "scheme": ""}
        return list(rooms.values())

    def _write_runtime(self):
        try:
            with tarfile.open(self.archive, "r:gz") as archive:
                members = [m for m in archive.getmembers() if m.name == "config.yml" or m.name.endswith("/config.yml")]
                if len(members) != 1 or not members[0].isfile():
                    raise RecorderError("安装包缺少唯一的录制器配置模板")
                template = archive.extractfile(members[0]).read().decode("utf-8")
        except (OSError, tarfile.TarError, UnicodeError) as error:
            raise RecorderError("无法读取录制器配置模板：" + str(error)) from error
        config = self.desired_config()
        output = Path(str(config["out_put_path"])).expanduser()
        if not output.is_absolute():
            raise RecorderError("录屏保存目录必须是绝对路径", 400)
        output.mkdir(parents=True, exist_ok=True)
        config["out_put_path"] = str(output)
        if not config.get("ffmpeg_path"):
            config["ffmpeg_path"] = str(self.root / "tools/imageio-ffmpeg/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1")
        if not Path(config["ffmpeg_path"]).is_file():
            raise RecorderError("找不到 FFmpeg，请在设置中指定程序路径", 400)
        # The JSON API represents Go time.Duration as nanoseconds, while its
        # YAML decoder requires a duration string (including the zero value).
        split = config.get("video_split_strategies", {})
        duration = split.get("max_duration", 0)
        if isinstance(duration, (int, float)) and not isinstance(duration, bool):
            if duration < 0 or int(duration) != duration:
                raise RecorderError("录屏分段时长必须是非负整数纳秒", 400)
            split["max_duration"] = str(int(duration)) + "ns"
        elif not isinstance(duration, str):
            raise RecorderError("录屏分段时长格式不正确", 400)
        config["rpc"] = {"enable": True, "bind": "127.0.0.1:" + str(self.port), "sse_list_threshold": 50}
        config["update"] = {"auto_check": False, "auto_download": False, "check_interval_hours": 6, "include_prerelease": False}
        config["live_rooms"] = self._rooms_for_start(config)
        config["app_data_path"] = str(self.plugin / ".appdata")
        config["log"] = {"out_put_folder": str(self.root / "logs"), "save_last_log": True, "save_every_log": False, "rotate_days": 7}
        # JSON values are valid YAML values. Replace whole top-level blocks,
        # retaining all unmodified packaged defaults without a YAML dependency.
        lines, output_lines = template.splitlines(), []
        i, replaced = 0, set()
        while i < len(lines):
            match = re.match(r"^([A-Za-z_][A-Za-z_0-9]*):", lines[i])
            if match and match[1] in config:
                key = match[1]
                output_lines.append(key + ": " + json.dumps(config[key], ensure_ascii=False))
                replaced.add(key)
                i += 1
                while i < len(lines) and not re.match(r"^[A-Za-z_][A-Za-z_0-9]*:", lines[i]):
                    i += 1
                continue
            output_lines.append(lines[i])
            i += 1
        for key in config.keys() - replaced:
            if re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", key):
                output_lines.append(key + ": " + json.dumps(config[key], ensure_ascii=False))
        self.runtime_file.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=self.runtime_file.parent, mode="w", encoding="utf-8", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write("\n".join(output_lines) + "\n")
        temporary.replace(self.runtime_file)

    def _start(self):
        state = self._state()
        if state["connected"]:
            return state
        if state["managed"] or self._port_busy():
            raise RecorderError("录制器正在启动或端口被占用，请检查连接状态", 409)
        if not self.binary.is_file():
            raise RecorderError("本机未安装 bililive-go", 503)
        self._write_runtime()
        self.log_file.parent.mkdir(parents=True, exist_ok=True)
        self._error = None
        with self.log_file.open("ab") as log:
            child = subprocess.Popen(
                [str(self.binary), "--no-launcher", "--config=" + str(self.runtime_file)],
                cwd=self.plugin, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                start_new_session=True,
            )
        self._child = child
        identity = self._identity(child.pid)
        if not identity:
            self._error = "录制器启动后立即退出，请查看本机录制器日志"
            raise RecorderError(self._error, 502)
        self._write(self.owner_file, {"pid": child.pid, "identity": identity})
        deadline = time.monotonic() + self.start_timeout
        while time.monotonic() < deadline:
            if child.poll() is not None:
                self.owner_file.unlink(missing_ok=True)
                self._error = "录制器启动失败，请查看本机录制器日志"
                raise RecorderError(self._error, 502)
            state = self._state()
            if state["connected"]:
                return state
            time.sleep(.2)
        self._error = "录制器启动超时，请稍后点击检查连接"
        raise RecorderError(self._error, 504)

    def start(self):
        with self._lock:
            return self._start()

    def _stop(self):
        state = self._state()
        if not state["managed"]:
            if state["connected"]:
                raise RecorderError("这是其他程序启动的录制器，请在原程序中停止", 409)
            return state
        if not state["connected"]:
            raise RecorderError("暂时无法确认录制状态，未停止进程；请稍后检查连接", 409)
        if state["recordingCount"]:
            raise RecorderError("仍有直播正在录制，请先在直播监控中暂停监测，再停止或重启", 409)
        # Recheck ownership immediately before signalling (protect against PID reuse).
        pid = self._owned_pid()
        if pid != state["pid"]:
            raise RecorderError("录制器进程已变化，请重新检查连接", 409)
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + self.stop_timeout
        while time.monotonic() < deadline:
            if self._child and self._child.pid == pid:
                self._child.poll()
            if self._owned_pid() is None:
                self.owner_file.unlink(missing_ok=True)
                self._error = None
                return self._state()
            time.sleep(.2)
        raise RecorderError("录制器仍在退出，请稍后检查连接；未强制终止", 504)

    def stop(self):
        with self._lock:
            return self._stop()

    def restart(self):
        with self._lock:
            self._stop()
            return self._start()
