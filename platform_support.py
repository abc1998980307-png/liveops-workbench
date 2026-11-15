"""Small OS boundary for local tools and advisory file locks."""
import contextlib
import os
import shutil
import sys
from pathlib import Path

from runtime_config import DATA_ROOT

try:
    import fcntl
except ImportError:
    fcntl = None
try:
    import msvcrt
except ImportError:
    msvcrt = None


def tool_path(name, platform=None, environ=None, root=None, finder=None):
    platform = platform or sys.platform
    environ = os.environ if environ is None else environ
    root = DATA_ROOT if root is None else Path(root)
    finder = shutil.which if finder is None else finder
    names = {
        "ffmpeg": ("LIVEOPS_FFMPEG", "ffmpeg.exe", "ffmpeg", "tools/imageio-ffmpeg/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1"),
        "recorder": ("LIVEOPS_RECORDER", "bililive-go.exe", "bililive-go", "plugins/bililive-go/bililive-darwin-arm64"),
        "whisper": ("LIVEOPS_WHISPER", "whisper-cli.exe", "whisper-cli", "plugins/buzz/whisper.cpp/build/bin/whisper-cli"),
        "node": ("LIVEOPS_NODE", "node.exe", "node", "tools/node/bin/node"),
    }
    key, windows_name, command, mac_relative = names[name]
    if environ.get(key):
        return Path(environ[key]).expanduser()
    if platform == "win32":
        managed = {"ffmpeg": "tools/imageio-ffmpeg/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe",
                   "recorder": "plugins/bililive-go/bililive-windows-amd64.exe",
                   "whisper": "plugins/buzz/whisper.cpp/build/bin/Release/whisper-cli.exe", "node": "tools/node/node.exe"}[name]
        path = root / managed
        return path if path.is_file() else Path(finder(windows_name) or finder(command) or path)
    return root / mac_relative


def browser_path(platform=None, environ=None):
    platform = platform or sys.platform
    environ = os.environ if environ is None else environ
    explicit = environ.get("LIVEOPS_CHROME")
    if explicit:
        path = Path(explicit).expanduser()
        return path if path.is_file() else None
    if platform == "win32":
        candidates = []
        for base in (environ.get("PROGRAMFILES"), environ.get("PROGRAMFILES(X86)"), environ.get("LOCALAPPDATA")):
            if base:
                candidates.extend((Path(base) / "Google/Chrome/Application/chrome.exe",
                                   Path(base) / "Microsoft/Edge/Application/msedge.exe"))
    else:
        candidates = [Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")]
    return next((candidate for candidate in candidates if candidate.is_file()), None)


@contextlib.contextmanager
def file_lock(path):
    """Non-blocking, single-byte advisory lock on either host OS."""
    with Path(path).open("a+b") as handle:
        try:
            if fcntl:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            elif msvcrt:
                handle.seek(0, os.SEEK_END)
                if handle.tell() == 0:
                    handle.write(b"\0")
                    handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                raise OSError("当前系统不支持文件锁")
        except (OSError, BlockingIOError):
            raise BlockingIOError("文件已被其他进程锁定") from None
        try:
            yield
        finally:
            if fcntl:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            elif msvcrt:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
