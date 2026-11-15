#!/usr/bin/env python3
"""Read-only local dependency report. Does not log in, start services or install tools."""

import json
import argparse
import os
import platform
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from rpa_bridge import discover_node, discover_playwright  # noqa: E402
from runtime_config import DATA_ROOT  # noqa: E402
from platform_support import browser_path, tool_path  # noqa: E402


def configured_path(path, key, default):
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
        value = config.get(key) if isinstance(config, dict) else None
        return Path(value).expanduser() if isinstance(value, str) and value else default
    except (OSError, ValueError):
        return default


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--full", action="store_true", help="录制、压缩和转写组件也必须就绪")
    args = parser.parse_args()
    data = DATA_ROOT
    print(f"数据目录：{data}")
    checks = []

    def report(name, available, detail, required=True):
        checks.append((available, required))
        status = "OK" if available else "MISSING" if required else "OPTIONAL"
        print(f"[{status}] {name}: {detail}")

    supported = (sys.platform == "darwin" and platform.machine() == "arm64") or \
                (sys.platform == "win32" and platform.machine().lower() in {"amd64", "x86_64"})
    report("运行平台", supported, "macOS Apple Silicon / Windows x64")
    report("Python", sys.version_info >= (3, 9), platform.python_version())
    chrome = browser_path()
    report("Chrome / Edge", bool(chrome),
           "可运行文件已找到" if chrome else "请安装 Chrome / Edge 或配置 LIVEOPS_CHROME")
    for name, finder in (("Node.js >=24", discover_node), ("Playwright Core", discover_playwright)):
        try:
            finder()
            report(name, True, "已找到；未启动浏览器或采集器")
        except RuntimeError as error:
            report(name, False, str(error))

    recorder = tool_path("recorder", root=data)
    ffmpeg = tool_path("ffmpeg", root=data)
    recorder_ffmpeg = configured_path(data / "plugin-settings/bililive-go.json", "ffmpeg_path", ffmpeg)
    whisper = tool_path("whisper", root=data)
    model = configured_path(data / "plugin-settings/media-pipeline.json", "model",
                            data / "plugins/buzz/whisper.cpp/models/ggml-small-q5_1.bin")
    for name, binary in (("录制器 bililive-go", recorder), ("录制器 FFmpeg", recorder_ffmpeg),
                         ("压缩 FFmpeg", ffmpeg), ("Whisper CLI", whisper)):
        ready = binary.is_file() and os.access(binary, os.X_OK)
        report(name, ready, "可运行文件已找到" if ready else "未在程序使用的位置找到可执行文件", required=args.full)
    report("Whisper 模型", model.is_file(), "已找到" if model.is_file() else "尚未配置本地模型", required=args.full)
    template = data / ("plugins/bililive-go/config.yml" if sys.platform == "win32" else
                       "plugins/bililive-go/v0.8.3-darwin-arm64.tar.gz")
    report("录制器配置模板", template.is_file(), "已找到" if template.is_file() else "缺少安装包中的配置模板", required=args.full)
    from hot_service import HotService
    hot = HotService(data, ROOT)
    report("热点榜 DailyHotApi", hot.installed(), "组件已找到；未请求榜单或启动服务" if hot.installed() else "运行安装器或在网页安装热点组件", required=args.full)
    if not all(available for available, _ in checks):
        print("缺少组件时运行：python3 scripts/install.py --apply；Chrome 请从 Google 官网安装。")
    print("此检查仅确认本机依赖存在；账号权限、接口连接和真实采集需另行验收。")
    return 0 if all(available for available, required in checks if required) else 1


if __name__ == "__main__":
    raise SystemExit(main())
