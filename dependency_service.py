"""Local dependency inventory and a single bounded installer subprocess."""
import json
import os
import platform
from pathlib import Path
import subprocess
import sys
import threading
from platform_support import file_lock
from platform_support import browser_path


class DependencyManager:
    def __init__(self, root, project):
        self.root, self.project = Path(root), Path(project)
        self.lock = threading.RLock()
        self.process = None
        self.error = None
        self.log = self.root / "logs/install/web-install.log"
        manifest = "dependencies-windows.json" if sys.platform == "win32" else "dependencies.json"
        self.manifest = json.loads((self.project / "scripts" / manifest).read_text(encoding="utf-8"))

    def external_busy(self):
        path = self.root / ".install.lock"
        if not path.exists():
            return False
        try:
            with file_lock(path):
                return False
        except BlockingIOError:
            return True

    def state(self):
        with self.lock:
            code = self.process.poll() if self.process else None
            busy = bool(self.process and code is None) or self.external_busy()
            if self.process and code is not None and code != 0:
                self.error = "安装未完成，请查看下方日志后重试。已有工具和配置未覆盖。"
            items = []
            labels = {"node": "Node.js", "collector": "浏览器采集组件", "ffmpeg": "视频压缩 FFmpeg",
                      "recorder": "直播录制器", "cmake": "Whisper 构建工具", "whisper": "离线转写 Whisper", "model": "中文语音模型", "dailyhot": "热点榜 DailyHotApi"}
            for name in ("node", "collector", "ffmpeg", "recorder", "cmake", "whisper", "model", "dailyhot"):
                spec = self.manifest.get(name, {})
                target = (self.root / spec["target"] / spec.get("binary", "")) if spec else self.root / "tools/collector/node_modules/playwright-core/index.mjs"
                found = target.is_file() and (name in ("model", "collector", "dailyhot") or os.access(target, os.X_OK))
                if name == "dailyhot":
                    found = found and (self.root / spec["target"] / "node_modules/@hono/node-server/package.json").is_file()
                if name == "recorder":
                    template = "config.yml" if sys.platform == "win32" else "v0.8.3-darwin-arm64.tar.gz"
                    found = found and (target.parent / template).is_file()
                items.append({"id": name, "name": labels[name], "found": found, "version": spec.get("version", "项目锁文件")})
            tail = ""
            try:
                with self.log.open("rb") as handle:
                    handle.seek(max(0, self.log.stat().st_size - 6000))
                    tail = handle.read(6000).decode("utf-8", errors="replace")
            except OSError:
                pass
            chrome = browser_path()
            return {"items": items, "busy": busy, "error": self.error, "log": tail,
                    "canInstall": (sys.platform == "darwin" and platform.machine() == "arm64") or
                                  (sys.platform == "win32" and platform.machine().lower() in {"amd64", "x86_64"}),
                    "chromeFound": bool(chrome), "dataDirectory": str(self.root),
                    "completed": bool(self.process and code == 0)}

    def install(self, hotwords_only=False):
        with self.lock:
            state = self.state()
            if state["busy"]:
                return state
            if not state["canInstall"]:
                raise ValueError("目前只支持 macOS Apple Silicon 或 Windows x64")
            self.log.parent.mkdir(parents=True, exist_ok=True)
            self.error = None
            with self.log.open("wb") as output:
                selection = ["--components", "dailyhot"] if hotwords_only else []
                self.process = subprocess.Popen([sys.executable, str(self.project / "scripts/install.py"),
                                                 *selection, "--apply", "--data-root", str(self.root)],
                                                cwd=self.project, stdout=output, stderr=output,
                                                stdin=subprocess.DEVNULL, start_new_session=True)
            return self.state()
