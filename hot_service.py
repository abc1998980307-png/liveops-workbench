"""Manage the local public-hotlist service without confusing it with upstream data."""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from recorder_service import RecorderManager


class HotServiceError(RuntimeError):
    def __init__(self, message, status=503):
        super().__init__(message)
        self.status = status


class HotService:
    def __init__(self, root, project, base_url="http://127.0.0.1:16688"):
        self.root, self.project = Path(root), Path(project)
        parsed = urllib.parse.urlsplit(base_url)
        if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}
                or parsed.username or parsed.password or parsed.path not in {"", "/"}
                or parsed.query or parsed.fragment):
            raise ValueError("热点服务只能绑定本机地址")
        self.port = parsed.port or 80
        self.base_url = "http://127.0.0.1:" + str(self.port)
        # This URL is validated loopback traffic, regardless of system proxies.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.plugin = self.root / "plugins/dailyhot-api"
        self.node = self.root / "tools/node/bin/node"
        self.runner = self.project / "scripts/dailyhot_runner.mjs"
        self.owner_file = self.root / "plugin-settings/dailyhot-process.json"
        self.settings_file = self.root / "plugin-settings/dailyhot.env"
        self.log_file = self.root / "logs/dailyhot.log"
        self.lock = threading.RLock()
        self.data_lock = threading.Lock()
        self.process = None
        self.error = None
        self.last_read = {}
        self.start_timeout, self.stop_timeout = 12, 12

    def installed(self):
        try:
            package = json.loads((self.plugin / "package.json").read_text())
            return (package.get("name") == "dailyhot-api" and package.get("version") == "2.0.8"
                    and (self.plugin / "dist/app.js").is_file()
                    and (self.plugin / "node_modules/@hono/node-server/package.json").is_file())
        except (OSError, ValueError):
            return False

    def desired_settings(self):
        values = {}
        try:
            path = self.settings_file if self.settings_file.exists() else self.plugin / ".env"
            for line in path.read_text().splitlines():
                if line.strip() and not line.lstrip().startswith("#") and "=" in line:
                    key, value = line.strip().split("=", 1)
                    values[key] = value.strip().strip("\"'")
        except FileNotFoundError:
            pass
        cache = int(values.get("CACHE_TTL", "3600"))
        timeout = int(values.get("REQUEST_TIMEOUT", "6000"))
        if not 60 <= cache <= 86400 or not 1000 <= timeout <= 60000:
            raise ValueError("热点缓存或超时设置超出范围，请在运行设置中修正")
        return {"cacheTTL": cache, "requestTimeout": timeout,
                "filterWeiboAds": values.get("FILTER_WEIBO_ADVERTISEMENT", "false").lower() == "true"}

    def _request(self, path, timeout=2):
        with self.opener.open(self.base_url + path, timeout=timeout) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError("热点服务响应过大")
        return json.loads(raw)

    def _probe(self):
        try:
            health = self._request("/__liveops_health")
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
        except (ValueError, UnicodeError):
            pass
        else:
            if isinstance(health, dict) and health.get("service") == "liveops-dailyhot":
                return health
        routes = self._request("/all")
        if (not isinstance(routes, dict) or routes.get("code") != 200
                or not isinstance(routes.get("routes"), list)
                or not any(isinstance(r, dict) and r.get("name") == "douyin"
                           and r.get("path") == "/douyin" for r in routes["routes"])):
            raise ValueError("端口上的服务不是可识别的 DailyHotApi")
        return {"service": "dailyhot-api", "legacy": True}

    def _owned_pid(self):
        owner = RecorderManager._read(self.owner_file, {})
        if self.process:
            self.process.poll()
        identity = RecorderManager._identity(owner.get("pid"))
        if (identity and identity == owner.get("identity") and str(self.runner) in identity
                and str(self.plugin) in identity and owner.get("instance")
                and owner["instance"] in identity and owner.get("port") == self.port):
            return owner["pid"]
        return None

    def _port_busy(self):
        with socket.socket() as sock:
            sock.settimeout(.2)
            return sock.connect_ex(("127.0.0.1", self.port)) == 0

    def state(self):
        with self.lock:
            pid = self._owned_pid()
            owner = RecorderManager._read(self.owner_file, {})
            health, connection_error = {}, None
            try:
                health = self._probe()
            except (OSError, ValueError) as error:
                connection_error = str(error)
            connected = bool(health)
            owned_connection = bool(pid and health.get("instance") == owner.get("instance"))
            try:
                desired, config_error = self.desired_settings(), None
            except (OSError, ValueError) as error:
                desired, config_error = {}, str(error)
            actual = health.get("settings")
            pending = desired != actual if actual and desired else None
            if connected and not owned_connection:
                message = "已连接已有热点服务；停止和重启需在原启动工具中操作。"
            elif connected:
                message = "本机热点服务已启动；榜单可用性以最近读取结果为准。"
            elif pid:
                message = "热点进程仍在运行，服务暂未响应；可检查日志或停止后重试。"
            else:
                message = "热点服务未启动，请先安装，再点击启动。"
            return {"installed": self.installed(), "nodeReady": self.node.is_file() and os.access(self.node, os.X_OK),
                    "connected": connected, "managed": bool(pid), "ownedConnection": owned_connection,
                    "pid": pid, "canStop": bool(pid),
                    "canStart": not connected and not pid, "canRestart": bool(pid),
                    "version": health.get("version"), "pendingRestart": pending, "settings": actual,
                    "message": message, "error": self.error or config_error,
                    "connectionError": connection_error if not connected else None,
                    "dataReady": self.last_read.get("ok") if connected else None,
                    "dataError": self.last_read.get("error"), "lastReadAt": self.last_read.get("checkedAt"),
                    "updatedAt": self.last_read.get("updatedAt"), "log": self.log_tail()}

    def log_tail(self):
        try:
            with self.log_file.open("rb") as handle:
                handle.seek(max(0, self.log_file.stat().st_size - 6000))
                return handle.read(6000).decode("utf-8", errors="replace")
        except OSError:
            return ""

    @contextlib.contextmanager
    def operation(self):
        self.owner_file.parent.mkdir(parents=True, exist_ok=True)
        with self.lock, self.owner_file.with_suffix(".lock").open("a") as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise HotServiceError("另一个热点服务操作正在进行，请稍后检查", 409) from error
            yield

    def start(self):
        with self.operation():
            return self._start()

    def _start(self):
        state = self.state()
        if state["connected"]:
            return state
        if state["managed"] or self._port_busy():
            raise HotServiceError("热点服务正在启动或端口被占用，请先检查状态", 409)
        if not state["installed"] or not state["nodeReady"]:
            raise HotServiceError("请先安装热点服务及 Node.js", 400)
        settings = self.desired_settings()
        self.log_file.parent.mkdir(parents=True, exist_ok=True)
        # Bound the log retained across deliberate starts.
        if self.log_file.exists() and self.log_file.stat().st_size > 1024 * 1024:
            self.log_file.write_text(self.log_tail(), encoding="utf-8")
        instance = uuid.uuid4().hex
        env = dict(os.environ, NODE_ENV="production", USE_LOG_FILE="false",
                   CACHE_TTL=str(settings["cacheTTL"]), REQUEST_TIMEOUT=str(settings["requestTimeout"]),
                   FILTER_WEIBO_ADVERTISEMENT=str(settings["filterWeiboAds"]).lower())
        self.error = None
        self.last_read = {}
        with self.log_file.open("ab") as log:
            child = subprocess.Popen([str(self.node), str(self.runner), str(self.plugin), str(self.port), instance],
                                     cwd=self.plugin, env=env, stdin=subprocess.DEVNULL,
                                     stdout=log, stderr=log, start_new_session=True)
        self.process = child
        identity = RecorderManager._identity(child.pid)
        if not identity:
            child.poll()
            raise HotServiceError("热点服务启动后立即退出，请查看日志")
        RecorderManager._write(self.owner_file, {"pid": child.pid, "identity": identity,
                                                 "instance": instance, "port": self.port})
        deadline = time.monotonic() + self.start_timeout
        while time.monotonic() < deadline:
            if child.poll() is not None:
                self.owner_file.unlink(missing_ok=True)
                self.error = "热点服务启动失败，请查看日志后重试。"
                raise HotServiceError(self.error)
            # A launcher may exec its final interpreter after Popen returns.
            # Refresh only this still-live child, with all unique arguments.
            current = RecorderManager._identity(child.pid)
            if (current and current != identity and str(self.runner) in current
                    and str(self.plugin) in current and instance in current):
                identity = current
                RecorderManager._write(self.owner_file, {"pid": child.pid, "identity": identity,
                                                         "instance": instance, "port": self.port})
            state = self.state()
            if state["ownedConnection"]:
                return state
            time.sleep(.15)
        self.error = "热点服务启动尚未确认，请检查状态；未重复创建进程。"
        raise HotServiceError(self.error, 504)

    def stop(self):
        with self.operation():
            return self._stop()

    def _stop(self):
        state = self.state()
        if not state["managed"]:
            if state["connected"]:
                raise HotServiceError("已有热点服务由其他工具启动，请在原工具中停止", 409)
            return state
        pid = self._owned_pid()
        if pid != state["pid"]:
            raise HotServiceError("热点进程身份已变化，请重新检查", 409)
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + self.stop_timeout
        while time.monotonic() < deadline:
            if not self._owned_pid():
                self.owner_file.unlink(missing_ok=True)
                self.error = None
                self.last_read = {}
                return self.state()
            time.sleep(.15)
        raise HotServiceError("热点服务仍在退出，未强制终止；请稍后检查", 504)

    def restart(self):
        with self.operation():
            self._stop()
            return self._start()

    def hotwords(self, limit):
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("榜单数量必须是 1–100 的整数")
        with self.data_lock:
            try:
                settings = self.desired_settings()
                data = self._request("/douyin?limit=" + str(limit),
                                     timeout=min(125, 2 * settings["requestTimeout"] / 1000 + 5))
                if (not isinstance(data, dict) or data.get("code") != 200
                        or data.get("name") != "douyin" or not isinstance(data.get("data"), list)):
                    raise ValueError("抖音榜单响应格式异常")
                for item in data["data"]:
                    if not isinstance(item, dict) or not isinstance(item.get("title"), str):
                        raise ValueError("抖音榜单条目格式异常")
                    for key in ("url", "mobileUrl"):
                        if key in item:
                            link = urllib.parse.urlsplit(str(item[key]))
                            if link.scheme != "https" or link.hostname not in {"www.douyin.com", "douyin.com"} or link.username or link.password:
                                raise ValueError("抖音榜单链接格式异常")
                self.last_read = {"ok": True, "checkedAt": time.time(), "updatedAt": data.get("updateTime")}
                return data
            except (OSError, ValueError) as error:
                self.last_read = {"ok": False, "checkedAt": time.time(), "error": str(error)}
                raise HotServiceError("本机服务或抖音榜单读取失败，请检查热点服务状态：" + str(error)) from error
