#!/usr/bin/env python3
"""Serial post-recording compression and Chinese transcription worker."""

import json
import os
import subprocess
import tempfile
import threading
import time
import uuid
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path


DATA_ROOT = Path.home() / "Library" / "Application Support" / "LiveOps"
PLUGIN_ROOT = DATA_ROOT / "plugins" / "media-pipeline"
CONFIG_FILE = DATA_ROOT / "plugin-settings" / "media-pipeline.json"
JOBS_FILE = DATA_ROOT / "plugin-settings" / "media-jobs.json"
RECORDINGS = DATA_ROOT / "recordings"
TRANSCRIPTS = DATA_ROOT / "transcripts"
FFMPEG = DATA_ROOT / "tools" / "imageio-ffmpeg" / "imageio_ffmpeg" / "binaries" / "ffmpeg-macos-aarch64-v7.1"
WHISPER = DATA_ROOT / "plugins" / "buzz" / "whisper.cpp" / "build" / "bin" / "whisper-cli"
MODEL = DATA_ROOT / "plugins" / "buzz" / "whisper.cpp" / "models" / "ggml-small-q5_1.bin"
POLL_SECONDS = 30
MIN_IDLE_SECONDS = 60
_stop = threading.Event()
_jobs_lock = threading.Lock()
_stable = {}
_active_source = None


def read_config():
    defaults = {
        "enabled": True,
        "codec": "hevc_videotoolbox",
        "videoBitrateKbps": 2500,
        "audioBitrateKbps": 96,
        "language": "zh",
        "model": str(MODEL),
        "keepOriginal": True,
        "recordingDirectory": str(RECORDINGS),
    }
    try:
        value = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        if isinstance(value, dict):
            defaults.update(value)
    except (OSError, ValueError):
        pass
    return defaults


def _read_jobs():
    try:
        value = json.loads(JOBS_FILE.read_text(encoding="utf-8"))
        return value if isinstance(value, list) else []
    except (OSError, ValueError):
        return []


def _write_jobs(jobs):
    JOBS_FILE.parent.mkdir(parents=True, exist_ok=True)
    temp = JOBS_FILE.with_suffix(".tmp")
    temp.write_text(json.dumps(jobs[-300:], ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(JOBS_FILE)


def job_snapshot():
    config = read_config()
    with _jobs_lock:
        jobs = _read_jobs()
    for job in jobs:
        compressed = job.get("compressed")
        job["compressedUrl"] = None
        if compressed and Path(compressed).is_file():
            try:
                relative = Path(compressed).resolve().relative_to(Path(config["recordingDirectory"]).expanduser().resolve())
                job["compressedUrl"] = "/recordings/" + urllib.parse.quote(str(relative))
            except ValueError:
                pass
        path = job.get("transcript")
        if path:
            try:
                relative = Path(path).resolve().relative_to(TRANSCRIPTS.resolve())
                job["transcriptUrl"] = "/transcripts/" + urllib.parse.quote(str(relative))
            except ValueError:
                job["transcriptUrl"] = None
    return {
        "ready": FFMPEG.is_file(),
        "compressionReady": FFMPEG.is_file(),
        "transcriptionReady": WHISPER.is_file() and Path(config["model"]).is_file(),
        "keepOriginal": config["keepOriginal"] is not False,
        "enabled": bool(config["enabled"]),
        "workerRunning": _active_source is not None,
        "activeSource": str(_active_source) if _active_source else None,
        "jobs": list(reversed(jobs[-40:])),
        "pluginDirectory": str(PLUGIN_ROOT),
    }


def _update_job(job_id, **changes):
    with _jobs_lock:
        jobs = _read_jobs()
        for job in jobs:
            if job["id"] == job_id:
                job.update(changes)
                job["updatedAt"] = datetime.now(timezone.utc).isoformat()
                break
        _write_jobs(jobs)


def _create_job(source):
    job = {
        "id": uuid.uuid4().hex,
        "source": str(source),
        "name": source.name,
        "status": "queued",
        "stage": "等待处理",
        "compressed": None,
        "transcript": None,
        "error": None,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    with _jobs_lock:
        jobs = _read_jobs()
        jobs.append(job)
        _write_jobs(jobs)
    return job


def _has_job(source):
    with _jobs_lock:
        return any(item.get("source") == str(source) for item in _read_jobs())


def _is_open(source):
    result = subprocess.run(["/usr/sbin/lsof", "-t", "--", str(source)], capture_output=True, text=True, timeout=10)
    if result.returncode not in (0, 1) or result.stderr.strip():
        raise RuntimeError("无法确认录屏是否仍被使用，已保留原文件")
    return result.returncode == 0 or bool(result.stdout.strip())


def _signature(source):
    if source.is_symlink() or not source.is_file():
        raise RuntimeError("原录屏不是普通文件，已停止处理")
    stat = source.stat()
    return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)


def _candidate_files(recording_root=None):
    root = Path(recording_root or RECORDINGS).expanduser()
    for source in root.rglob("*"):
        if source.is_symlink() or not source.is_file() or source.suffix.lower() not in {".flv", ".mkv", ".ts", ".mov", ".mp4", ".m4v"} or ".compressed" in source.stem:
            continue
        try:
            stat = source.stat()
        except OSError:
            continue
        if stat.st_size == 0 or _has_job(source):
            continue
        previous = _stable.get(str(source))
        signature = (stat.st_ino, stat.st_size, stat.st_mtime_ns)
        if previous and previous[0] == signature:
            stable_count = previous[1] + 1
        else:
            stable_count = 0
        _stable[str(source)] = (signature, stable_count)
        if stable_count >= 1 and time.time() - stat.st_mtime >= MIN_IDLE_SECONDS:
            try:
                if not _is_open(source):
                    yield source
            except (OSError, RuntimeError, subprocess.TimeoutExpired):
                continue


def _run(command):
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        detail = (result.stderr or result.stdout or "处理命令失败").strip()
        raise RuntimeError(detail[-1800:])


def _compress(job, config):
    source = Path(job["source"])
    before = _signature(source)
    if _is_open(source):
        raise RuntimeError("原录屏仍被使用，已保留原文件")
    # Include the source extension so a.flv and a.mp4 never share an output.
    compressed = source.with_name(source.name + ".compressed.mp4")
    if compressed.exists() or compressed.is_symlink():
        compressed = source.with_name(source.name + "." + uuid.uuid4().hex + ".compressed.mp4")
    bitrate = max(500, min(12000, int(config.get("videoBitrateKbps", 2500))))
    audio_bitrate = max(32, min(320, int(config.get("audioBitrateKbps", 96))))
    codec = config.get("codec", "hevc_videotoolbox")
    if codec not in {"hevc_videotoolbox", "h264_videotoolbox", "libx265", "libx264"}:
        raise ValueError("不支持的视频编码器")
    with tempfile.NamedTemporaryFile(dir=source.parent, prefix=source.name + ".compressed.", suffix=".tmp.mp4", delete=False) as handle:
        temp = Path(handle.name)
    _update_job(job["id"], status="processing", stage="压缩视频", sourceDeleted=False)
    try:
        _run([
            str(FFMPEG), "-hide_banner", "-nostdin", "-v", "error", "-xerror", "-y", "-i", str(source),
            "-map", "0:v:0", "-map", "0:a?", "-c:v", codec, "-b:v", f"{bitrate}k",
            "-c:a", "aac", "-b:a", f"{audio_bitrate}k", "-movflags", "+faststart",
            "-f", "mp4", str(temp),
        ])
        if not temp.is_file() or temp.stat().st_size == 0:
            raise RuntimeError("FFmpeg 没有生成压缩视频")
        _update_job(job["id"], stage="校验压缩视频")
        _run([
            str(FFMPEG), "-hide_banner", "-nostdin", "-v", "error", "-xerror", "-err_detect", "explode",
            "-i", str(temp), "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-",
        ])
        if _signature(source) != before or _is_open(source):
            raise RuntimeError("压缩期间原录屏发生变化或仍被使用，已保留原文件")
        with temp.open("rb") as handle:
            os.fsync(handle.fileno())
        # Link atomically without overwriting any file created during encoding.
        os.link(temp, compressed)
    finally:
        temp.unlink(missing_ok=True)

    _update_job(job["id"], compressed=str(compressed), compressionCompleted=True)
    # Respect a setting changed while a long compression job was running.
    if config.get("keepOriginal", True) is False and read_config().get("keepOriginal", True) is False:
        if _signature(source) != before or _is_open(source):
            raise RuntimeError("压缩成功，但原文件发生变化或仍被使用，未删除原文件")
        try:
            source.unlink()
        except OSError as error:
            raise RuntimeError("压缩成功，但原文件删除失败：" + str(error)) from error
        _update_job(job["id"], sourceDeleted=True, originalBytes=before[2])
    return compressed


def _process(job, config):
    source = Path(job["source"])
    compressed = _compress(job, config)

    config_model = Path(config.get("model", str(MODEL)))
    if not WHISPER.is_file() or not config_model.is_file():
        _update_job(
            job["id"], status="completed", stage="压缩完成（转写组件未就绪）",
            compressed=str(compressed), transcript=None, subtitles=None, error=None,
        )
        return

    transcript_dir = TRANSCRIPTS / source.parent.name
    transcript_dir.mkdir(parents=True, exist_ok=True)
    prefix = transcript_dir / source.stem
    transcript = Path(str(prefix) + ".txt")
    subtitles = Path(str(prefix) + ".srt")
    if not transcript.is_file():
        _update_job(job["id"], status="processing", stage="提取压缩视频音轨", compressed=str(compressed))
        with tempfile.NamedTemporaryFile(prefix="liveops-audio-", suffix=".wav", delete=False) as audio:
            wav_path = Path(audio.name)
        try:
            _run([str(FFMPEG), "-hide_banner", "-nostdin", "-y", "-i", str(compressed), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav_path)])
            _update_job(job["id"], status="processing", stage="中文语音转写", compressed=str(compressed))
            _run([str(WHISPER), "-m", str(config_model), "-f", str(wav_path), "-l", str(config.get("language", "zh")), "-otxt", "-osrt", "-of", str(prefix)])
        finally:
            wav_path.unlink(missing_ok=True)
    if not transcript.is_file():
        raise RuntimeError("转写结束但没有生成文本文件")
    _update_job(job["id"], status="completed", stage="完成", compressed=str(compressed), transcript=str(transcript), subtitles=str(subtitles) if subtitles.exists() else None, error=None)


def worker_loop():
    global _active_source
    while not _stop.wait(POLL_SECONDS):
        config = read_config()
        if not config["enabled"] or not FFMPEG.is_file():
            continue
        recording_root = Path(config.get("recordingDirectory", str(RECORDINGS))).expanduser()
        for source in _candidate_files(recording_root):
            job = _create_job(source)
            _active_source = source
            try:
                _process(job, config)
            except Exception as error:
                with _jobs_lock:
                    saved = next((item for item in _read_jobs() if item["id"] == job["id"]), {})
                stage = "压缩完成，后续处理失败" if saved.get("compressionCompleted") else "压缩失败，原文件保留"
                _update_job(job["id"], status="failed", stage=stage, error=str(error))
            finally:
                _active_source = None


def start_worker():
    # Interrupted jobs can be retried using the original retained on disk.
    with _jobs_lock:
        jobs = [job for job in _read_jobs() if job.get("status") not in {"queued", "processing"} or job.get("sourceDeleted")]
        _write_jobs(jobs)
    thread = threading.Thread(target=worker_loop, name="liveops-media-pipeline", daemon=True)
    thread.start()
    return thread


def stop_worker():
    _stop.set()
