#!/usr/bin/env python3
"""Serial post-recording compression and Chinese transcription worker."""

import json
import os
import re
import signal
import subprocess
import tempfile
import threading
import time
import uuid
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

from flv_recovery import inspect_tail


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
_jobs_lock = threading.RLock()
_worker_lock = threading.Lock()
_wake = threading.Event()
_worker_thread = None
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
    # Keep source identities: forgetting a failed/retained job re-enqueues it.
    temp.write_text(json.dumps(jobs, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(JOBS_FILE)


def job_snapshot():
    config = read_config()
    with _jobs_lock:
        jobs = _read_jobs()
    for job in jobs:
        root = Path(config["recordingDirectory"]).expanduser().resolve()
        job["compressedPath"] = _relative_file(job.get("compressed"), root)
        job["sourcePath"] = _relative_file(job.get("source"), root)
        job["compressedUrl"] = None  # Video actions reveal files in Finder.
        for key in ("transcript", "subtitles"):
            relative = _relative_file(job.get(key), TRANSCRIPTS.resolve())
            job[key + "Url"] = "/transcripts/" + urllib.parse.quote(relative) if relative else None
        job["canRetry"] = job.get("status") == "failed" or (job.get("status") == "completed" and
                          (not job.get("transcriptionCompleted") or not job["transcriptUrl"] or not job["subtitlesUrl"]))
        job["canRecoverTail"] = bool(job.get("status") == "failed" and job["sourcePath"]
                                     and Path(job["sourcePath"]).suffix.lower() == ".flv"
                                     and not job.get("compressionCompleted"))
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


def _relative_file(value, root):
    if not value:
        return None
    try:
        path = _checked_path(value, root)
        return str(path.relative_to(root)) if path.is_file() else None
    except (OSError, ValueError):
        return None


def _checked_path(value, root):
    path = Path(value).expanduser()
    root = Path(root).expanduser().resolve()
    if not path.is_absolute() or path.is_symlink() or not path.resolve().is_relative_to(root):
        raise ValueError("任务文件不在当前保存目录内，或为符号链接")
    return path.resolve()


def retry_job(job_id, recover_tail=False):
    if not isinstance(job_id, str) or not re.fullmatch(r"[a-f0-9]{32}", job_id):
        raise ValueError("任务 ID 格式不正确")
    if not isinstance(recover_tail, bool):
        raise ValueError("恢复选项必须是布尔值")
    config = read_config()
    if not config["enabled"]:
        raise ValueError("请先在运行设置中开启自动处理")
    with _jobs_lock:
        jobs = _read_jobs()
        job = next((item for item in jobs if item.get("id") == job_id), None)
        if job is None:
            raise FileNotFoundError("找不到处理任务")
        if job.get("status") in {"queued", "processing"}:
            return {"ok": True, "alreadyQueued": True, "id": job_id}
        if (job.get("status") == "completed" and job.get("transcriptionCompleted")
                and all(_relative_file(job.get(key), TRANSCRIPTS.resolve()) for key in ("transcript", "subtitles"))):
            raise ValueError("此任务已经完成")
        source = _checked_path(job["source"], config["recordingDirectory"])
        if recover_tail and (not source.is_file() or source.suffix.lower() != ".flv" or job.get("compressionCompleted")):
            raise ValueError("此任务不支持末尾残包恢复")
        if not source.is_file() and not job.get("compressionCompleted"):
            raise FileNotFoundError("原录屏已不存在，且没有已验证的压缩视频")
        job.update(status="queued", stage="等待末尾残包恢复" if recover_tail else "等待重试", error=None,
                   recoverTailRequested=recover_tail, updatedAt=datetime.now(timezone.utc).isoformat())
        _write_jobs(jobs)
    _wake.set()
    return {"ok": True, "alreadyQueued": False, "id": job_id}


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
        existing = next((item for item in jobs if item.get("source") == str(source)), None)
        if existing:
            return existing
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


def _run(command, input_path=None, input_limit=None):
    """Bound shutdown to our own child process; never signal the recorder."""
    if _stop.is_set():
        raise InterruptedError("处理已暂停，重启后继续")
    feeder_errors = []
    with tempfile.TemporaryFile() as log:
        child = subprocess.Popen(command, stdin=subprocess.PIPE if input_path else subprocess.DEVNULL,
                                 stdout=log, stderr=log, start_new_session=True)
        def feed():
            try:
                with Path(input_path).open("rb") as source:
                    remaining = input_limit
                    while remaining > 0 and not _stop.is_set():
                        chunk = source.read(min(remaining, 1024 * 1024))
                        if not chunk:
                            raise RuntimeError("原录屏提前结束，未生成恢复视频")
                        child.stdin.write(chunk)
                        remaining -= len(chunk)
            except BrokenPipeError:
                pass
            except Exception as error:
                feeder_errors.append(error)
            finally:
                try:
                    child.stdin.close()
                except BrokenPipeError:
                    pass
        feeder = threading.Thread(target=feed, daemon=True) if input_path else None
        if feeder:
            feeder.start()
        interrupted = False
        try:
            while child.poll() is None:
                if _stop.wait(.2):
                    interrupted = True
                    try:
                        os.killpg(child.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        try:
                            os.killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    break
            child.wait()
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            if feeder:
                feeder.join(timeout=5)
        if interrupted:
            raise InterruptedError("处理已暂停，重启后继续")
        if feeder_errors:
            raise feeder_errors[0]
        if child.returncode:
            log.seek(max(0, log.tell() - 8000))
            detail = log.read().decode("utf-8", errors="replace").strip()
            raise RuntimeError(detail[-1800:] or "处理命令失败")


def _validate_video(path):
    _run([str(FFMPEG), "-hide_banner", "-nostdin", "-v", "error", "-xerror", "-err_detect", "explode",
          "-i", str(path), "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"])


def _finish_cleanup(job, config):
    source = _checked_path(job["source"], config["recordingDirectory"])
    if not source.exists():
        if job.get("sourceDeletePending"):
            _update_job(job["id"], sourceDeleted=True, sourceDeletePending=False)
        return
    # Restoring a damaged source is a separate operation: keep its evidence.
    if job.get("tailRecovery") or config.get("keepOriginal", True) is not False or read_config().get("keepOriginal", True) is not False:
        return
    saved_signature = job.get("sourceSignature")
    if not saved_signature:
        return  # Older jobs have no identity proof; never delete blindly.
    if list(_signature(source)) != saved_signature or _is_open(source):
        raise RuntimeError("压缩成功，但原文件发生变化或仍被使用，未删除原文件")
    _update_job(job["id"], sourceDeletePending=True)
    try:
        source.unlink()
    except OSError as error:
        raise RuntimeError("压缩成功，但原文件删除失败：" + str(error)) from error
    _update_job(job["id"], sourceDeleted=True, sourceDeletePending=False, originalBytes=saved_signature[2])


def _compress(job, config):
    source = _checked_path(job["source"], config["recordingDirectory"])
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
    recovery = inspect_tail(source, _stop.is_set) if job.get("recoverTailRequested") else None
    if recovery:
        _update_job(job["id"], tailRecovery=recovery)
    with tempfile.NamedTemporaryFile(dir=source.parent, prefix=source.name + ".compressed.", suffix=".tmp.mp4", delete=False) as handle:
        temp = Path(handle.name)
    _update_job(job["id"], status="processing", stage="压缩视频", sourceDeleted=False)
    try:
        command = [
            str(FFMPEG), "-hide_banner", "-nostdin", "-v", "error", "-xerror", "-y", "-i", "pipe:0" if recovery else str(source),
            "-map", "0:v:0", "-map", "0:a?", "-c:v", codec, "-b:v", f"{bitrate}k",
            "-c:a", "aac", "-b:a", f"{audio_bitrate}k", "-movflags", "+faststart",
            "-f", "mp4", str(temp),
        ]
        if recovery:
            _run(command, input_path=source, input_limit=recovery["prefixBytes"])
        else:
            _run(command)
        if not temp.is_file() or temp.stat().st_size == 0:
            raise RuntimeError("FFmpeg 没有生成压缩视频")
        _update_job(job["id"], stage="校验压缩视频")
        _validate_video(temp)
        if _signature(source) != before or _is_open(source):
            raise RuntimeError("压缩期间原录屏发生变化或仍被使用，已保留原文件")
        with temp.open("rb") as handle:
            os.fsync(handle.fileno())
        # Link atomically without overwriting any file created during encoding.
        os.link(temp, compressed)
    finally:
        temp.unlink(missing_ok=True)

    job.update(compressed=str(compressed), compressionCompleted=True, sourceSignature=list(before),
               compressedSignature=list(_signature(compressed)), tailRecovery=recovery)
    _update_job(job["id"], **{key: job[key] for key in ("compressed", "compressionCompleted", "sourceSignature", "compressedSignature", "tailRecovery")})
    _finish_cleanup(job, config)
    return compressed


def _process(job, config):
    if not re.fullmatch(r"[a-f0-9]{32}", str(job.get("id", ""))):
        raise ValueError("任务 ID 格式不正确")
    source = _checked_path(job["source"], config["recordingDirectory"])
    if job.get("compressionCompleted"):
        compressed = _checked_path(job.get("compressed", ""), config["recordingDirectory"])
        if not compressed.is_file():
            raise RuntimeError("已验证的压缩视频已不存在；请找回文件后重试")
        before = _signature(compressed)
        if job.get("compressedSignature") and list(before) != job["compressedSignature"]:
            raise RuntimeError("压缩视频已被修改，未使用或删除任何原件")
        _update_job(job["id"], status="processing", stage="重新校验压缩视频")
        _validate_video(compressed)
        if _signature(compressed) != before:
            raise RuntimeError("校验期间压缩视频发生变化")
        _finish_cleanup(job, config)
    else:
        compressed = _compress(job, config)

    config_model = Path(config.get("model", str(MODEL)))
    if not WHISPER.is_file() or not config_model.is_file():
        _update_job(job["id"], status="completed", stage="压缩完成（转写组件未就绪）",
                    transcript=None, subtitles=None, transcriptionCompleted=False, error=None)
        return

    # An attempt is published as one directory only after TXT and SRT both exist.
    # Stable per-job ownership prevents cross-platform/name collisions and lets
    # a restart recover publication even before the final job update was saved.
    parent = TRANSCRIPTS.resolve() / "_jobs" / job["id"]
    parent.mkdir(parents=True, exist_ok=True)
    target = job.get("transcriptOutputDirectory")
    if target:
        target = _checked_path(target, parent)
    if not target or not target.is_dir():
        target = parent / uuid.uuid4().hex
        _update_job(job["id"], transcriptOutputDirectory=str(target))
    transcript = target / source.parent.name / (source.stem + ".txt")
    subtitles = target / source.parent.name / (source.stem + ".srt")
    manifest = target / "manifest.json"
    signature = list(_signature(compressed))
    published = False
    try:
        metadata = json.loads(manifest.read_text())
        published = (metadata.get("jobId") == job["id"] and metadata.get("compressedSignature") == signature
                     and all(path.is_file() and not path.is_symlink() for path in (transcript, subtitles)))
    except (OSError, ValueError):
        pass
    if not published:
        # Incomplete or externally changed published attempts are preserved.
        if target.exists():
            target = parent / uuid.uuid4().hex
            transcript = target / source.parent.name / (source.stem + ".txt")
            subtitles = target / source.parent.name / (source.stem + ".srt")
            _update_job(job["id"], transcriptOutputDirectory=str(target))
        TRANSCRIPTS.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="liveops-transcript-", dir=TRANSCRIPTS.parent) as staging:
            staging = Path(staging)
            content = staging / "published"
            prefix = content / source.parent.name / source.stem
            prefix.parent.mkdir(parents=True)
            wav = staging / "audio.wav"
            _update_job(job["id"], status="processing", stage="提取压缩视频音轨")
            _run([str(FFMPEG), "-hide_banner", "-nostdin", "-v", "error", "-xerror", "-y", "-i", str(compressed),
                  "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav)])
            _update_job(job["id"], status="processing", stage="中文语音转写")
            _run([str(WHISPER), "-m", str(config_model), "-f", str(wav), "-l", str(config.get("language", "zh")),
                  "-otxt", "-osrt", "-of", str(prefix)])
            for extension in (".txt", ".srt"):
                artifact = Path(str(prefix) + extension)
                if not artifact.is_file() or artifact.is_symlink():
                    raise RuntimeError("转写结束但文本或字幕不完整，已保留压缩视频")
                artifact.read_text(encoding="utf-8")  # Empty files are valid for silence.
            if list(_signature(compressed)) != signature:
                raise RuntimeError("转写期间压缩视频发生变化")
            (content / "manifest.json").write_text(json.dumps({"jobId": job["id"], "compressedSignature": signature}))
            content.rename(target)
    _update_job(job["id"], status="completed", stage="恢复完成（原件保留）" if job.get("tailRecovery") else "完成",
                transcript=str(transcript), subtitles=str(subtitles), transcriptionCompleted=True, error=None)


def _next_job():
    with _jobs_lock:
        jobs = _read_jobs()
        for job in jobs:
            if job.get("status") == "queued":
                job.update(status="processing", stage="准备处理", updatedAt=datetime.now(timezone.utc).isoformat())
                _write_jobs(jobs)
                return dict(job)
    return None


def worker_loop():
    global _active_source
    while not _stop.is_set():
        config = read_config()
        if config["enabled"] and FFMPEG.is_file():
            root = Path(config.get("recordingDirectory", str(RECORDINGS))).expanduser()
            for source in _candidate_files(root):
                if _stop.is_set():
                    break
                _create_job(source)
            while not _stop.is_set():
                config = read_config()
                if not config["enabled"]:
                    break
                job = _next_job()
                if job is None:
                    break
                _active_source = Path(job["source"])
                try:
                    _process(job, config)
                except InterruptedError:
                    _update_job(job["id"], status="queued", stage="处理已暂停，启动后继续", error=None)
                except Exception as error:
                    with _jobs_lock:
                        saved = next((item for item in _read_jobs() if item["id"] == job["id"]), {})
                    stage = "压缩完成，后续处理失败" if saved.get("compressionCompleted") else "压缩失败，原文件保留"
                    _update_job(job["id"], status="failed", stage=stage, error=str(error))
                finally:
                    _active_source = None
        _wake.wait(POLL_SECONDS)
        _wake.clear()


def start_worker():
    global _worker_thread
    with _worker_lock:
        if _worker_thread and _worker_thread.is_alive():
            return _worker_thread
        with _jobs_lock:
            jobs = _read_jobs()
            for job in jobs:
                if job.get("status") == "processing":
                    job.update(status="queued", stage="等待恢复中断任务", error=None)
            _write_jobs(jobs)
        _stop.clear()
        _wake.clear()
        _worker_thread = threading.Thread(target=worker_loop, name="liveops-media-pipeline", daemon=True)
        _worker_thread.start()
        return _worker_thread


def stop_worker(timeout=12):
    _stop.set()
    _wake.set()
    thread = _worker_thread
    if thread and thread is not threading.current_thread():
        thread.join(timeout=timeout)
    return not (thread and thread.is_alive())
