#!/usr/bin/env python3
"""Exercise installed tools in a dedicated empty data root using synthetic media."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

PROJECT = Path(__file__).resolve().parents[1]


def require(condition, message):
    if not condition:
        raise RuntimeError("安装验收失败：" + message)


RUNTIME_COMPONENTS = (
    "tools/node/bin/node",
    "tools/collector/node_modules/playwright-core",
    "tools/imageio-ffmpeg/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1",
    "plugins/bililive-go/bililive-darwin-arm64",
    "plugins/bililive-go/v0.8.3-darwin-arm64.tar.gz",
    "plugins/buzz/whisper.cpp/build/bin/whisper-cli",
    "plugins/buzz/whisper.cpp/models/ggml-small-q5_1.bin",
    "plugins/dailyhot-api",
)


def prepare_runtime_root(installed):
    for relative in RUNTIME_COMPONENTS:
        require((installed / relative).exists(), "缺少已安装组件：" + relative)
    parent = installed / "logs/install"
    parent.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="verification-", dir=parent)).resolve()
    for relative in RUNTIME_COMPONENTS:
        source = installed / relative
        link = root / relative
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(source, target_is_directory=source.is_dir())
    return root


def vacant_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", required=True, type=Path,
                        help="已安装组件的目录；每次验收会在其中创建独立合成数据目录")
    args = parser.parse_args()
    installed = args.data_root.expanduser().resolve()
    require(installed.is_dir(), "安装目录不存在")
    doctor_env = dict(os.environ, LIVEOPS_DATA_ROOT=str(installed))
    subprocess.run([sys.executable, str(PROJECT / "scripts/doctor.py"), "--full"],
                   check=True, env=doctor_env)
    root = prepare_runtime_root(installed)
    os.environ["LIVEOPS_DATA_ROOT"] = str(root)
    os.environ["LIVEOPS_NODE"] = str(root / "tools/node/bin/node")
    os.environ["LIVEOPS_PLAYWRIGHT_MODULE"] = str(root / "tools/collector/node_modules/playwright-core/index.mjs")
    os.environ["LIVEOPS_RPA_DATA"] = str(root / "rpa")
    sys.path.insert(0, str(PROJECT))
    from recorder_service import RecorderManager
    from hot_service import HotService
    import media_pipeline as pipeline

    report = {"root": str(root), "syntheticOnly": True, "checks": {}}
    checks = report["checks"]
    checks["dependencyReport"] = True
    recorder_url = "http://127.0.0.1:" + str(vacant_port())
    manager = RecorderManager(root, recorder_url)
    hot_url = "http://127.0.0.1:" + str(vacant_port())
    hot = HotService(root, PROJECT, hot_url)
    dashboard = None
    log = None
    try:
        print("验证本机热点服务启动与健康检查（不请求上游榜单）…", flush=True)
        hot_state = hot.start()
        require(hot_state["ownedConnection"] and not hot_state["pendingRestart"], "热点服务未由本次验收启动或配置未生效")
        checks["hotspotService"] = {"version": hot_state["version"], "localHealth": True, "upstreamRequested": False}
        print("验证空录制器启动与停止…", flush=True)
        recorder = manager.start()
        require(recorder["connected"] and recorder["recordingCount"] == 0 and recorder["roomCount"] == 0,
                "录制器未连接或存在非验收直播间")
        checks["recorderStart"] = {"version": recorder["version"], "rooms": 0}

        fixture = root / "recordings/安装验证/合成语音样本.flv"
        fixture.parent.mkdir(parents=True)
        audio = root / "installation-speech.aiff"
        subprocess.run(["/usr/bin/say", "-o", str(audio),
                        "This is an offline installation check. The local workbench saves compressed video and subtitles."], check=True)
        subprocess.run([str(pipeline.FFMPEG), "-v", "error", "-nostdin", "-f", "lavfi", "-i",
                        "testsrc2=size=320x240:rate=25", "-i", str(audio), "-shortest", "-c:v", "libx264",
                        "-c:a", "aac", "-f", "flv", str(fixture)], check=True)
        pipeline.CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        config = {**pipeline.read_config(), "enabled": False, "keepOriginal": False, "language": "en"}
        pipeline.CONFIG_FILE.write_text(json.dumps(config))
        job = pipeline._create_job(fixture)
        print("验证压缩、全片解码、原件清理与 TXT/SRT…", flush=True)
        pipeline._process(job, config)
        finished = next(j for j in pipeline._read_jobs() if j["id"] == job["id"])
        require(finished["status"] == "completed" and finished["compressionCompleted"]
                and finished["transcriptionCompleted"], "压缩或转写任务未完成")
        require(finished["sourceDeleted"] and not fixture.exists(), "合成原件未在校验后清理")
        for key in ("compressed", "transcript", "subtitles"):
            require(Path(finished[key]).stat().st_size > 0, key + " 文件不存在或为空")
        checks["media"] = {key: str(finished[key]) for key in ("compressed", "transcript", "subtitles")}
        checks["media"]["sourceDeletedAfterValidation"] = True
        checks["media"]["subtitleText"] = Path(finished["transcript"]).read_text().strip()
        port = vacant_port()
        env = dict(os.environ, LIVEOPS_PORT=str(port), LIVEOPS_BGO_URL=recorder_url,
                   LIVEOPS_HOT_API_URL=hot_url)
        dashboard_log = root / "logs/install/dashboard-check.log"
        dashboard_log.parent.mkdir(parents=True, exist_ok=True)
        log = dashboard_log.open("ab")
        dashboard = subprocess.Popen([sys.executable, str(PROJECT / "server.py")], cwd=PROJECT,
                                     env=env, stdout=log, stderr=log)
        base = f"http://127.0.0.1:{port}"
        for _ in range(60):
            if dashboard.poll() is not None:
                raise RuntimeError("验收网页服务退出，请查看 dashboard-check.log")
            try:
                health = json.load(urllib.request.urlopen(base + "/api/health", timeout=1))
                if health.get("ready"):
                    break
            except OSError:
                pass
            time.sleep(.25)
        else:
            raise RuntimeError("验收网页服务未就绪")
        state = json.load(urllib.request.urlopen(base + "/api/rpa/state", timeout=10))
        require(state["ready"] and state["accounts"] == [], "采集器未就绪或验收目录中已有账号")
        page = urllib.request.urlopen(base + "/", timeout=3).read().decode()
        require("直播操盘台" in page, "网页首页未返回工作台内容")
        checks["dashboard"] = {"health": health, "emptyCollector": True, "html": True}
        result = root / "logs/install/verification.json"
        result.write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(f"安装验收通过：{result}", flush=True)
        return 0
    finally:
        if dashboard and dashboard.poll() is None:
            dashboard.terminate()
            try:
                dashboard.wait(timeout=30)
            except subprocess.TimeoutExpired:
                dashboard.kill()
                dashboard.wait()
        if log:
            log.close()
        if manager.state()["managed"]:
            manager.stop()
        if hot.state()["managed"]:
            hot.stop()


if __name__ == "__main__":
    raise SystemExit(main())
