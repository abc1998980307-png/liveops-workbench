#!/usr/bin/env python3
"""Read-only local dependency report. Does not log in, start services or install tools."""

import json
import os
import platform
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from rpa_bridge import discover_node, discover_playwright  # noqa: E402


def configured_path(path, key, default):
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
        value = config.get(key) if isinstance(config, dict) else None
        return Path(value).expanduser() if isinstance(value, str) and value else default
    except (OSError, ValueError):
        return default


def main():
    data = Path.home() / "Library/Application Support/LiveOps"
    checks = []

    def report(name, available, detail, required=True):
        checks.append((available, required))
        status = "OK" if available else "MISSING" if required else "OPTIONAL"
        print(f"[{status}] {name}: {detail}")

    report("macOS Apple Silicon", sys.platform == "darwin" and platform.machine() == "arm64",
           "当前录制器和媒体工具路径针对 macOS Apple Silicon")
    report("Python", sys.version_info >= (3, 9), platform.python_version())
    chrome = Path(os.environ.get("LIVEOPS_CHROME") or
                  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome").expanduser()
    chrome_ready = chrome.is_file() and os.access(chrome, os.X_OK)
    report("Chrome", chrome_ready,
           "可运行文件已找到" if chrome_ready else "请安装 Google Chrome 或配置可执行的 LIVEOPS_CHROME")
    for name, finder in (("Node.js >=24", discover_node), ("Playwright Core", discover_playwright)):
        try:
            finder()
            report(name, True, "已找到；未启动浏览器或采集器")
        except RuntimeError as error:
            report(name, False, str(error))

    recorder = data / "plugins/bililive-go/bililive-darwin-arm64"
    ffmpeg = data / "tools/imageio-ffmpeg/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1"
    recorder_ffmpeg = configured_path(data / "plugin-settings/bililive-go.json", "ffmpeg_path", ffmpeg)
    whisper = data / "plugins/buzz/whisper.cpp/build/bin/whisper-cli"
    model = configured_path(data / "plugin-settings/media-pipeline.json", "model",
                            data / "plugins/buzz/whisper.cpp/models/ggml-small-q5_1.bin")
    for name, binary in (("录制器 bililive-go", recorder), ("录制器 FFmpeg", recorder_ffmpeg),
                         ("压缩 FFmpeg", ffmpeg), ("Whisper CLI", whisper)):
        ready = binary.is_file() and os.access(binary, os.X_OK)
        report(name, ready, "可运行文件已找到" if ready else "未在程序使用的位置找到可执行文件", required=False)
    report("Whisper 模型", model.is_file(), "已找到" if model.is_file() else "尚未配置本地模型", required=False)
    print("此检查仅确认本机依赖存在；账号权限、接口连接和真实采集需另行验收。")
    return 0 if all(available for available, required in checks if required) else 1


if __name__ == "__main__":
    raise SystemExit(main())
