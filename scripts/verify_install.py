#!/usr/bin/env python3
"""Exercise installed tools in a dedicated empty data root using synthetic media."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request

PROJECT = Path(__file__).resolve().parents[1]


def vacant_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", required=True, type=Path,
                        help="只接受安装了组件但尚无账号、录屏及业务配置的独立目录")
    args = parser.parse_args()
    root = args.data_root.expanduser().resolve()
    production = (Path.home() / "Library/Application Support/LiveOps").resolve()
    if root == production or root.is_relative_to(production):
        raise SystemExit("不能在日常工作台目录运行安装验收")
    for name in ("accounts.json", "dashboard-settings.json", "plugin-settings", "rpa", "recordings", "transcripts"):
        if (root / name).exists():
            raise SystemExit(f"目标不是空业务目录，未启动检查：{root / name}")
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
    subprocess.run([sys.executable, str(PROJECT / "scripts/doctor.py"), "--full"], check=True)
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
        assert hot_state["ownedConnection"] and not hot_state["pendingRestart"]
        checks["hotspotService"] = {"version": hot_state["version"], "localHealth": True, "upstreamRequested": False}
        print("验证空录制器启动与停止…", flush=True)
        recorder = manager.start()
        assert recorder["connected"] and recorder["recordingCount"] == 0 and recorder["roomCount"] == 0
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
        assert finished["status"] == "completed" and finished["compressionCompleted"] and finished["transcriptionCompleted"]
        assert finished["sourceDeleted"] and not fixture.exists()
        for key in ("compressed", "transcript", "subtitles"):
            assert Path(finished[key]).stat().st_size > 0, key
        checks["media"] = {key: str(finished[key]) for key in ("compressed", "transcript", "subtitles")}
        checks["media"]["sourceDeletedAfterValidation"] = True
        checks["media"]["subtitleText"] = Path(finished["transcript"]).read_text().strip()
        port = vacant_port()
        env = dict(os.environ, LIVEOPS_PORT=str(port), LIVEOPS_BGO_URL=recorder_url,
                   LIVEOPS_HOT_API_URL=hot_url)
        log = (root / "logs/install/dashboard-check.log").open("ab")
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
        assert state["ready"] and state["accounts"] == []
        page = urllib.request.urlopen(base + "/", timeout=3).read().decode()
        assert "直播操盘台" in page
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
