"""Local dependency inventory and a single bounded installer subprocess."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import threading


class DependencyManager:
    def __init__(self, root, project):
        self.root, self.project = Path(root), Path(project)
        self.lock = threading.RLock()
        self.process = None
        self.error = None
        self.log = self.root / "logs/install/web-install.log"
        self.manifest = json.loads((self.project / "scripts/dependencies.json").read_text())

    def external_busy(self):
        path = self.root / ".install.lock"
        if not path.exists():
            return False
        with path.open("a") as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
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
                      "recorder": "直播录制器", "cmake": "Whisper 构建工具", "whisper": "离线转写 Whisper", "model": "中文语音模型"}
            for name in ("node", "collector", "ffmpeg", "recorder", "cmake", "whisper", "model"):
                spec = self.manifest.get(name, {})
                target = (self.root / spec["target"] / spec.get("binary", "")) if spec else self.root / "tools/collector/node_modules/playwright-core/index.mjs"
                found = target.is_file() and (name in ("model", "collector") or os.access(target, os.X_OK))
                if name == "recorder":
                    found = found and (target.parent / "v0.8.3-darwin-arm64.tar.gz").is_file()
                items.append({"id": name, "name": labels[name], "found": found, "version": spec.get("version", "项目锁文件")})
            tail = ""
            try:
                with self.log.open("rb") as handle:
                    handle.seek(max(0, self.log.stat().st_size - 6000))
                    tail = handle.read(6000).decode("utf-8", errors="replace")
            except OSError:
                pass
            chrome = Path(os.environ.get("LIVEOPS_CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")).expanduser()
            return {"items": items, "busy": busy, "error": self.error, "log": tail,
                    "canInstall": sys.platform == "darwin" and os.uname().machine == "arm64",
                    "chromeFound": chrome.is_file(), "dataDirectory": str(self.root),
                    "completed": bool(self.process and code == 0)}

    def install(self):
        with self.lock:
            state = self.state()
            if state["busy"]:
                return state
            if not state["canInstall"]:
                raise ValueError("目前只支持 macOS Apple Silicon")
            self.log.parent.mkdir(parents=True, exist_ok=True)
            self.error = None
            with self.log.open("wb") as output:
                self.process = subprocess.Popen([sys.executable, str(self.project / "scripts/install.py"),
                                                 "--apply", "--data-root", str(self.root)],
                                                cwd=self.project, stdout=output, stderr=output,
                                                stdin=subprocess.DEVNULL, start_new_session=True)
            return self.state()
