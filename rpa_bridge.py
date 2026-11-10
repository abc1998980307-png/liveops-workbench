"""Private stdio connection to the local browser collector; no extra listening port."""
import atexit
import json
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import threading
import uuid
from runtime_config import DATA_ROOT, MANAGED_NODE, MANAGED_PLAYWRIGHT

try:
    import fcntl
except ImportError:  # Windows
    fcntl = None
try:
    import msvcrt
except ImportError:  # macOS and Linux
    msvcrt = None

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("LIVEOPS_RPA_DATA", str(DATA_ROOT / "rpa")))
RUNTIME = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node"


def _acquire_instance_lock(directory):
    lock = (directory / "collector.instance.lock").open("a+b")
    try:
        if fcntl:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        elif msvcrt:
            lock.seek(0, os.SEEK_END)
            if lock.tell() == 0:
                lock.write(b"\0")
                lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            raise RuntimeError("当前系统不支持采集器单实例锁")
        return lock
    except (BlockingIOError, OSError) as error:
        lock.close()
        raise RuntimeError("同一数据目录已有罗盘采集器运行，请使用现有工作台") from error
    except Exception:
        lock.close()
        raise


def _release_instance_lock(lock):
    if lock is None:
        return
    try:
        if fcntl:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
        elif msvcrt:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
    finally:
        lock.close()


def _wait_for_collector_exit(process):
    try:
        process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            if process.poll() is None:
                process.kill()
            process.wait()


def _node_major(executable):
    """Probe only the runtime version; never start the collector during discovery."""
    try:
        result = subprocess.run([str(executable), "--version"], capture_output=True,
                                text=True, timeout=5, check=False)
        match = re.fullmatch(r"v(\d+)\.\d+\.\d+[^\s]*", result.stdout.strip())
        return int(match[1]) if result.returncode == 0 and match else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def discover_node():
    explicit = os.environ.get("LIVEOPS_NODE")
    candidates = [explicit] if explicit else [shutil.which("node"), MANAGED_NODE, RUNTIME / "bin/node"]
    for candidate in candidates:
        if not candidate:
            continue
        executable = Path(candidate).expanduser().resolve()
        if executable.is_file() and os.access(executable, os.X_OK):
            major = _node_major(executable)
            if major is not None and major >= 24:
                return str(executable)
    if explicit:
        raise RuntimeError("LIVEOPS_NODE 必须指向可运行的 Node.js 24 或更新版本。")
    raise RuntimeError("未找到 Node.js 24，请运行 python3 scripts/install.py --apply --components node,collector，或配置 LIVEOPS_NODE。")


def discover_playwright():
    explicit = os.environ.get("LIVEOPS_PLAYWRIGHT_MODULE")
    candidates = ([explicit] if explicit else
                  [ROOT / "node_modules/playwright-core/index.mjs",
                   MANAGED_PLAYWRIGHT,
                   RUNTIME / "node_modules/playwright-core/index.mjs"])
    for candidate in candidates:
        module = Path(candidate).expanduser().resolve()
        if module.is_file():
            return str(module)
    if explicit:
        raise RuntimeError("LIVEOPS_PLAYWRIGHT_MODULE 指定的文件不存在。")
    raise RuntimeError("未找到浏览器采集组件，请在项目目录运行 npm ci，或配置 LIVEOPS_PLAYWRIGHT_MODULE。")


class CollectorBridge:
    def __init__(self):
        self.process = None
        self.lock = threading.RLock()
        self.pending = {}
        self.log = None
        self.instance_lock = None

    def _start(self):
        if self.process and self.process.poll() is None:
            return
        if self.process:
            for target in self.pending.values():
                target.put({"error": "本机采集器已停止，请刷新页面重试。"})
            self.pending.clear()
            self.process = None
        if self.instance_lock:
            _release_instance_lock(self.instance_lock)
            self.instance_lock = None
        node = discover_node()
        module = discover_playwright()
        DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
        instance_lock = _acquire_instance_lock(DATA)
        try:
            if self.log:
                self.log.close()
            self.log = (DATA / "collector.log").open("a", encoding="utf-8")
            env = dict(os.environ, LIVEOPS_PLAYWRIGHT_MODULE=module, LIVEOPS_RPA_DATA=str(DATA))
            self.process = subprocess.Popen(
                [node, str(ROOT / "rpa/collector.mjs")], cwd=ROOT, env=env,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log,
                text=True, bufsize=1,
            )
        except Exception:
            _release_instance_lock(instance_lock)
            raise
        self.instance_lock = instance_lock
        threading.Thread(target=self._read, args=(self.process,), daemon=True).start()

    def _read(self, process):
        try:
            for line in process.stdout:
                try:
                    response = json.loads(line)
                except ValueError:
                    continue
                with self.lock:
                    target = self.pending.pop(response.get("id"), None)
                if target:
                    target.put(response)
        finally:
            _wait_for_collector_exit(process)
            with self.lock:
                if self.process is process:
                    for target in self.pending.values():
                        target.put({"error": "本机采集器已停止，请刷新页面重试。"})
                    self.pending.clear()
                    self.process = None
                    _release_instance_lock(self.instance_lock)
                    self.instance_lock = None

    def call(self, method, args=None, timeout=12):
        identifier, target = uuid.uuid4().hex, queue.Queue(maxsize=1)
        with self.lock:
            self._start()
            self.pending[identifier] = target
            try:
                self.process.stdin.write(json.dumps({"id": identifier, "method": method, "args": args or {}}) + "\n")
                self.process.stdin.flush()
            except (OSError, ValueError):
                self.pending.pop(identifier, None)
                raise RuntimeError("采集器连接中断，请刷新后重试。")
        try:
            response = target.get(timeout=timeout)
        except queue.Empty:
            raise RuntimeError("采集器响应超时，请稍后刷新状态。")
        finally:
            with self.lock:
                self.pending.pop(identifier, None)
        if response.get("error"):
            raise RuntimeError(response["error"])
        return response.get("result")

    def close(self):
        process = self.process
        if process and process.poll() is None:
            try:
                process.stdin.close()
            except OSError:
                pass
            _wait_for_collector_exit(process)
        if self.log:
            self.log.close()
        with self.lock:
            if self.process is process and self.instance_lock:
                _release_instance_lock(self.instance_lock)
                self.instance_lock = None
                self.process = None


COLLECTOR = CollectorBridge()
atexit.register(COLLECTOR.close)
