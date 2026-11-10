"""Durable, reviewable archives for recorder sessions.

The recorder can create more than one file for a single live session when an
upstream connection ends.  This module joins only sessions with an explicit
recorder end event.  It never treats an observation gap as proof that frames
were lost, and it keeps the original compressed segment files beside the
archive so a merge can be audited or retried.
"""

import copy
import json
import os
import re
import shutil
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path


ARCHIVES_VERSION = 1
SRT_RE = re.compile(
    r"^(?P<start>\d{2,}:\d{2}:\d{2}[,.]\d{3})\s+-->\s+"
    r"(?P<end>\d{2,}:\d{2}:\d{2}[,.]\d{3})(?:\s+.*)?$"
)


def _stamp(milliseconds):
    milliseconds = max(0, int(milliseconds))
    seconds, millis = divmod(milliseconds, 1000)
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours:02}:{minutes:02}:{seconds:02},{millis:03}"


def _milliseconds(value):
    hours, minutes, seconds, millis = (int(part) for part in re.split(r"[:,.]", value))
    if minutes >= 60 or seconds >= 60:
        raise ValueError("字幕时间格式异常")
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis


def merge_srt(contents, offsets):
    """Return one SRT with per-segment offsets and validated cue ordering."""
    if len(contents) != len(offsets):
        raise ValueError("字幕片段与时间偏移数量不一致")
    blocks = []
    for content, offset in zip(contents, offsets):
        if not isinstance(content, str) or not isinstance(offset, int) or offset < 0:
            raise ValueError("字幕片段或时间偏移无效")
        raw = content.replace("\r\n", "\n").replace("\r", "\n").strip()
        if not raw:
            continue
        for block in re.split(r"\n\s*\n", raw):
            lines = block.splitlines()
            match = SRT_RE.fullmatch(lines[1].strip()) if len(lines) >= 3 and lines[0].strip().isdigit() else None
            if not match:
                raise ValueError("字幕内容格式异常，未发布合并字幕")
            start = _milliseconds(match.group("start")) + offset
            end = _milliseconds(match.group("end")) + offset
            if end <= start:
                raise ValueError("字幕结束时间不晚于开始时间")
            blocks.append((start, end, lines[2:]))
    blocks.sort(key=lambda item: (item[0], item[1]))
    output = []
    for index, (start, end, lines) in enumerate(blocks, 1):
        output.append(str(index) + "\n" + _stamp(start) + " --> " + _stamp(end) + "\n" + "\n".join(lines))
    return "\n\n".join(output) + ("\n" if output else "")


def merge_text(contents):
    """Join per-segment transcripts while keeping segment boundaries visible."""
    values = []
    for content in contents:
        if not isinstance(content, str):
            raise ValueError("转写文本格式异常")
        value = content.replace("\r\n", "\n").replace("\r", "\n").strip()
        if value:
            values.append(value)
    return "\n\n".join(values) + ("\n" if values else "")


class RecordingArchiveManager:
    def __init__(self, data_root, sessions, pipeline, recording_root, now=None):
        self.file = Path(data_root) / "plugin-settings/recording-archives.json"
        self.sessions = sessions
        self.pipeline = pipeline
        self.recording_root = recording_root
        self.now = now or (lambda: datetime.now(timezone.utc).timestamp())
        self.lock = threading.RLock()
        self.execution_lock = threading.Lock()
        self.stop = threading.Event()
        self.wake = threading.Event()
        self.thread = None
        self.closed = False
        self.error = None

    def _read(self):
        try:
            value = json.loads(self.file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"version": ARCHIVES_VERSION, "archives": []}
        if (not isinstance(value, dict) or value.get("version") != ARCHIVES_VERSION
                or not isinstance(value.get("archives"), list)
                or any(not isinstance(item, dict)
                       or not re.fullmatch(r"[a-f0-9]{32}", str(item.get("id", "")))
                       or not re.fullmatch(r"[a-f0-9]{32}", str(item.get("sessionId", "")))
                       for item in value["archives"])):
            raise ValueError("录制归档记录格式异常，原记录未覆盖")
        return value

    def _write(self, value):
        self.file.parent.mkdir(parents=True, exist_ok=True)
        temp = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.file.parent, delete=False) as handle:
                temp = Path(handle.name)
                json.dump(value, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            temp.replace(self.file)
        finally:
            if temp is not None:
                temp.unlink(missing_ok=True)

    @staticmethod
    def _safe_file(value, root=None):
        path = Path(value).expanduser()
        if not path.is_absolute() or path.is_symlink() or not path.is_file():
            raise ValueError("归档输入不是可用的普通文件")
        resolved = path.resolve()
        if root is not None and not resolved.is_relative_to(Path(root).expanduser().resolve()):
            raise ValueError("归档输入不在录制目录内")
        return resolved

    @staticmethod
    def _signature(path):
        stat = path.stat()
        return [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]

    @staticmethod
    def _same_content_identity(current, saved):
        # macOS metadata updates can change ctime while leaving file content untouched.
        return (isinstance(saved, list) and len(saved) == 5
                and current[:4] == saved[:4])

    def _jobs(self):
        reader = getattr(self.pipeline, "archive_jobs", None)
        if reader is None:
            raise RuntimeError("后处理组件不支持录制归档")
        jobs = reader()
        if not isinstance(jobs, list):
            raise RuntimeError("后处理任务记录格式异常")
        return copy.deepcopy(jobs)

    def _find_job(self, segment, jobs):
        root = Path(segment["root"]).expanduser().resolve()
        source = (root / segment["path"]).resolve()
        matches = []
        for job in jobs:
            if not isinstance(job, dict) or not job.get("compressionCompleted"):
                continue
            try:
                job_source = Path(job.get("source", "")).expanduser().resolve()
            except (OSError, RuntimeError):
                continue
            if job_source == source:
                matches.append(job)
                continue
            identity = job.get("sourceSignature")
            if isinstance(identity, list) and len(identity) >= 2 and [segment.get("device"), segment.get("inode")] == identity[:2]:
                matches.append(job)
        if len(matches) != 1:
            raise ValueError("找不到唯一已校验的压缩片段：" + segment["path"])
        job = matches[0]
        compressed = self._safe_file(job.get("compressed", ""), self.recording_root())
        saved = job.get("compressedSignature")
        if not self._same_content_identity(self._signature(compressed), saved):
            raise ValueError("压缩片段已被修改，未生成合并归档")
        return job, compressed

    def _validate(self, path):
        validator = getattr(self.pipeline, "validate_video", None)
        if validator is None:
            raise RuntimeError("后处理组件不支持视频校验")
        validator(path, cancel_event=self.stop)

    def _duration(self, path, fallback=None):
        inspect = getattr(self.pipeline, "inspect_media", None)
        if inspect is not None:
            return int(inspect(path)["durationMs"])
        probe = getattr(self.pipeline, "media_duration_ms", None)
        if probe is not None:
            return int(probe(path))
        if isinstance(fallback, int) and fallback >= 0:
            return fallback
        raise RuntimeError("无法读取压缩片段的实际时长")

    @staticmethod
    def _atomic_text(path, value):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as handle:
            temp = Path(handle.name)
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            temp.replace(path)
        finally:
            temp.unlink(missing_ok=True)

    def _merge_video(self, inputs, output):
        ffmpeg = getattr(self.pipeline, "ffmpeg_path", None)
        if ffmpeg is None:
            ffmpeg = getattr(self.pipeline, "FFMPEG", None)
        if not ffmpeg:
            raise RuntimeError("FFmpeg 未配置")
        list_path = output.with_suffix(".concat.txt")
        list_path.write_text("\n".join("file '" + str(path).replace("'", "'\\''") + "'" for path in inputs) + "\n", encoding="utf-8")
        runner = getattr(self.pipeline, "run_command", None)

        def run(command):
            self._cancelled()
            if runner is None:
                raise RuntimeError("后处理组件不支持可停止的归档命令")
            runner(command, cancel_event=self.stop)

        try:
            inspect = getattr(self.pipeline, "inspect_media", None)
            compatible = True
            if inspect is not None:
                metadata = [inspect(path) for path in inputs]
                first = metadata[0]
                compatible = all(item["tracks"] == first["tracks"] and item["width"] == first["width"]
                                 and item["height"] == first["height"] for item in metadata[1:])
            command = [str(ffmpeg), "-hide_banner", "-nostdin", "-v", "error", "-xerror", "-y",
                       "-f", "concat", "-safe", "0", "-i", str(list_path),
                       "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-movflags", "+faststart", str(output)]
            first_error = None
            if compatible:
                try:
                    run(command)
                    return {"mode": "stream_copy", "audioPreserved": True}
                except InterruptedError:
                    raise
                except Exception as error:
                    first_error = error
            else:
                first_error = RuntimeError("片段编码或轨道布局不一致")
            if first_error is not None:
                output.unlink(missing_ok=True)
                inputs_args = []
                filters = []
                labels = []
                target_width = metadata[0]["width"] if inspect is not None else None
                target_height = metadata[0]["height"] if inspect is not None else None
                for index, path in enumerate(inputs):
                    inputs_args.extend(["-i", str(path)])
                    video = f"[{index}:v:0]setpts=PTS-STARTPTS"
                    if target_width and target_height:
                        video += (f",scale={target_width}:{target_height}:force_original_aspect_ratio=decrease"
                                  f",pad={target_width}:{target_height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p")
                    filters.extend([video + f"[v{index}]",
                                    f"[{index}:a:0]aresample=48000,aformat=channel_layouts=stereo,"
                                    f"asetpts=PTS-STARTPTS[a{index}]"])
                    labels.extend([f"[v{index}]", f"[a{index}]"])
                filters.append("".join(labels) + f"concat=n={len(inputs)}:v=1:a=1[v][a]")
                reencode = [str(ffmpeg), "-hide_banner", "-nostdin", "-v", "error", "-xerror", "-y",
                            *inputs_args, "-filter_complex", ";".join(filters), "-map", "[v]", "-map", "[a]",
                            "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-c:a", "aac",
                            "-b:a", "128k", "-movflags", "+faststart", str(output)]
                try:
                    run(reencode)
                    return {"mode": "reencode", "audioPreserved": True}
                except InterruptedError:
                    raise
                except Exception:
                    output.unlink(missing_ok=True)
                    raise RuntimeError("片段音频布局不兼容，未生成丢失音频的归档") from first_error
        finally:
            list_path.unlink(missing_ok=True)

    def _stamp_now(self):
        return datetime.fromtimestamp(self.now(), timezone.utc).isoformat()

    def _session(self, session_id):
        if not isinstance(session_id, str) or not re.fullmatch(r"[a-f0-9]{32}", session_id):
            raise ValueError("录制场次 ID 格式不正确")
        session = next((item for item in self.sessions._read()["sessions"] if item.get("id") == session_id), None)
        if session is None:
            raise FileNotFoundError("找不到录制场次")
        if not session.get("endedAt"):
            raise ValueError("当前录制尚未收到录制器结束事件，暂不合并")
        if not session.get("segments"):
            raise ValueError("录制场次没有已观察到的片段")
        return copy.deepcopy(session)

    def _inputs(self, session):
        jobs = self._jobs()
        resolved = [self._find_job(segment, jobs) for segment in session["segments"]]
        if any(job.get("status") in {"processing", "queued"} for job, _path in resolved):
            raise ValueError("片段仍在压缩或转写，请等待后处理完成再归档")
        return resolved

    def _put(self, item):
        with self.lock:
            data = self._read()
            data["archives"] = [old for old in data["archives"] if old.get("sessionId") != item["sessionId"]]
            data["archives"].append(copy.deepcopy(item))
            self._write(data)

    def _update(self, archive_id, **changes):
        with self.lock:
            data = self._read()
            item = next(item for item in data["archives"] if item["id"] == archive_id)
            item.update(changes, updatedAt=self._stamp_now())
            self._write(data)

    def _cancelled(self):
        if self.stop.is_set():
            raise InterruptedError("归档已暂停，启动后继续")

    def _existing_complete(self, item):
        if not item or item.get("status", "completed") != "completed":
            return False
        try:
            for key in ("video", "transcript", "subtitles", "manifest"):
                if item.get(key):
                    path = self._safe_file(item[key], self.recording_root())
                    saved = (item.get("outputSignatures") or {}).get(key)
                    if saved and not self._same_content_identity(self._signature(path), saved):
                        return False
            return bool(item.get("video"))
        except (OSError, ValueError):
            return False

    def start(self):
        with self.lock:
            if self.thread and self.thread.is_alive():
                return
            if self.closed:
                raise RuntimeError("归档服务正在停止，请稍后重试")
            try:
                data = self._read()
            except (OSError, ValueError) as error:
                self.error = "无法启动归档后台服务：" + str(error)[:400]
                return
            changed = False
            for item in data["archives"]:
                if item.get("status") == "processing":
                    item.update(status="queued", stage="等待恢复中断归档", error=None)
                    changed = True
            if changed:
                try:
                    self._write(data)
                except OSError as error:
                    self.error = "无法恢复归档后台任务：" + str(error)[:400]
                    return
            self.error = None
            self.thread = threading.Thread(target=self._worker, name="liveops-recording-archives", daemon=True)
            self.thread.start()

    def submit(self, session_id):
        # Validate and persist quickly; no decoding runs in an HTTP request.
        with self.lock:
            self.start()
            session = self._session(session_id)
            existing = next((item for item in self._read()["archives"] if item.get("sessionId") == session_id), None)
            if existing and existing.get("status") in {"queued", "processing"}:
                return self._public(existing)
            if self._existing_complete(existing):
                return self._public(existing)
            self._inputs(session)
            retry_id = existing["id"] if existing and existing.get("status") == "failed" else uuid.uuid4().hex
            item = {"version": 1, "id": retry_id, "sessionId": session_id, "status": "queued",
                    "stage": "等待归档", "createdAt": self._stamp_now(), "updatedAt": self._stamp_now(), "error": None}
            self._put(item)
            self.wake.set()
            return self._public(item)

    def _worker(self):
        try:
            self._work_loop()
        except Exception as error:
            self.error = "归档后台服务停止：" + str(error)[:400]

    def _work_loop(self):
        while not self.stop.is_set():
            with self.lock:
                item = next((item for item in self._read()["archives"] if item.get("status") == "queued"), None)
                if item:
                    self._update(item["id"], status="processing", stage="准备归档", startedAt=self._stamp_now(), error=None)
            if item:
                try:
                    self.create(item["sessionId"], item["id"])
                except Exception:
                    # If saving the failure also failed, surface the worker error
                    # instead of leaving an apparently live processing task forever.
                    saved = next((saved for saved in self._read()["archives"] if saved["id"] == item["id"]), None)
                    if saved and saved.get("status") == "processing":
                        raise
                continue
            self.wake.wait(1)
            self.wake.clear()

    def close(self, timeout=12):
        with self.lock:
            self.closed = True
            self.stop.set()
            self.wake.set()
            thread = self.thread
        if thread and thread is not threading.current_thread():
            thread.join(timeout)
        return not (thread and thread.is_alive())

    def _archive_dir(self):
        root = Path(self.recording_root()).expanduser().resolve()
        root.mkdir(parents=True, exist_ok=True)
        directory = root / ".liveops-archives"
        if directory.is_symlink():
            raise ValueError("归档目录不能是符号链接")
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def create(self, session_id, archive_id=None):
        """Synchronous worker body; the HTTP endpoint always uses submit()."""
        if archive_id is not None and not re.fullmatch(r"[a-f0-9]{32}", str(archive_id)):
            raise ValueError("归档任务 ID 格式不正确")
        with self.execution_lock:
            try:
                self._cancelled()
                session = self._session(session_id)
                existing = next((item for item in self._read()["archives"] if item.get("sessionId") == session_id), None)
                if archive_id is None:
                    if self._existing_complete(existing):
                        return self._public(existing)
                    archive_id = uuid.uuid4().hex
                    self._put({"version": 1, "id": archive_id, "sessionId": session_id, "status": "processing",
                               "stage": "准备归档", "createdAt": self._stamp_now(), "startedAt": self._stamp_now()})
                elif not existing or existing["id"] != archive_id or existing.get("status") != "processing":
                    raise RuntimeError("归档任务状态已变化，请重新检查")
                return self._build(session, archive_id)
            except InterruptedError:
                if archive_id:
                    self._update(archive_id, status="queued", stage="等待恢复中断归档", error=None)
                raise
            except Exception as error:
                if archive_id:
                    self._update(archive_id, status="failed", stage="归档失败", error=str(error)[:1200])
                raise

    def _build(self, session, archive_id):
        segments = session["segments"]
        resolved = self._inputs(session)
        source_signatures = [(path, job["compressedSignature"]) for job, path in resolved]
        root = Path(self.recording_root()).expanduser().resolve()
        directory = self._archive_dir()
        # Each attempt publishes one complete directory, never overwrites another
        # artifact, and only cleans its own known temporary directory on restart.
        staging = directory / f".{session['id']}.{archive_id}.tmp"
        target = directory / f"{session['id']}.{archive_id}"
        if target.exists() or target.is_symlink():
            if target.is_symlink() or not target.is_dir():
                raise ValueError("已发布归档目录格式异常，原文件未修改")
            saved = json.loads((target / "video.manifest.json").read_text(encoding="utf-8"))
            expected_video = resolved[0][1] if len(resolved) == 1 else target / "video.mp4"
            if (saved.get("id") != archive_id or saved.get("sessionId") != session["id"]
                    or saved.get("video") != str(expected_video) or not saved.get("outputSignatures")
                    or saved.get("manifest") != str(target / "video.manifest.json")
                    or any(saved.get(k) and saved[k] != str(target / name)
                           for k, name in (("transcript", "video.txt"), ("subtitles", "video.srt")))
                    or not self._existing_complete(saved)):
                raise ValueError("已发布归档与任务不一致，原文件未修改")
            self._put(saved)
            return self._public(saved)
        for index, (_job, path) in enumerate(resolved, 1):
            self._cancelled()
            self._update(archive_id, stage=f"校验片段 {index}/{len(resolved)}")
            self._validate(path)
        if staging.exists() or staging.is_symlink():
            if staging.is_symlink() or not staging.is_dir():
                raise ValueError("归档临时目录格式异常，原文件未删除")
            shutil.rmtree(staging)
        staging.mkdir()
        try:
            if len(resolved) == 1:
                video = resolved[0][1]
                merge_report = {"mode": "single_segment", "audioPreserved": True}
            else:
                self._update(archive_id, stage="合并视频")
                temp_video = staging / "video.tmp.mp4"
                merge_report = self._merge_video([path for _job, path in resolved], temp_video)
                if not temp_video.is_file() or temp_video.stat().st_size == 0:
                    raise RuntimeError("FFmpeg 没有生成合并视频")
                self._update(archive_id, stage="校验合并视频")
                self._validate(temp_video)
                temp_video.rename(staging / "video.mp4")
                video = target / "video.mp4"

            self._cancelled()
            self._update(archive_id, stage="整理文本、字幕与归档清单")
            offsets, durations, texts, subtitles, text_signatures = [], [], [], [], []
            offset = 0
            for segment, (job, path) in zip(segments, resolved):
                self._cancelled()
                duration = self._duration(path, segment.get("mediaDurationMs"))
                if not isinstance(duration, int) or duration <= 0:
                    raise ValueError("压缩视频时长无效，未发布归档")
                offsets.append(offset)
                durations.append(duration)
                offset += duration
                for key, contents in (("transcript", texts), ("subtitles", subtitles)):
                    if job.get(key):
                        artifact = self._safe_file(job[key])
                        text_signatures.append((artifact, self._signature(artifact)))
                        contents.append(artifact.read_text(encoding="utf-8"))
                    else:
                        contents.append(None)
            transcript = target / "video.txt" if all(t is not None for t in texts) else None
            subtitle = target / "video.srt" if all(s is not None for s in subtitles) else None
            if transcript:
                self._atomic_text(staging / transcript.name, merge_text(texts))
            if subtitle:
                self._atomic_text(staging / subtitle.name, merge_srt(subtitles, offsets))

            gaps = []
            for before, after in zip(segments, segments[1:]):
                gap_ms = None
                try:
                    gap_ms = max(0, int((datetime.fromisoformat(after["firstSeenAt"].replace("Z", "+00:00")).timestamp()
                                         - datetime.fromisoformat(before["lastSeenAt"].replace("Z", "+00:00")).timestamp()) * 1000))
                except (KeyError, AttributeError, TypeError, ValueError):
                    pass
                gaps.append({"from": before.get("path"), "to": after.get("path"), "observedGapMs": gap_ms,
                             "status": "unknown", "note": "文件切换时间只能说明观察到的边界，不能恢复或精确计算未接收画面"})
            manifest = {
                "version": 1, "id": archive_id, "sessionId": session["id"], "status": "completed", "stage": "归档完成",
                "createdAt": self._stamp_now(), "updatedAt": self._stamp_now(), "error": None,
                "endedAt": session.get("endedAt"), "endReason": session.get("endReason"),
                "segments": [{"path": segment.get("path"), "compressed": str(path), "durationMs": duration,
                              "compressedSignature": job.get("compressedSignature")} for segment, (job, path), duration in zip(segments, resolved, durations)],
                "gaps": gaps, "partialObservation": bool(session.get("partialObservation", True)),
                "unknownGaps": bool(gaps) or bool(session.get("partialObservation", True)), "merge": merge_report,
                "video": str(video), "transcript": str(transcript) if transcript else None,
                "subtitles": str(subtitle) if subtitle else None, "manifest": str(target / "video.manifest.json"),
                "missingArtifacts": [name for name, artifact in (("转写文本", transcript), ("字幕", subtitle)) if artifact is None],
                "note": "归档只包含已收到且已校验的片段；未知间断中的画面没有被补回。" +
                        ("单片段直接使用压缩视频，不另存一份。" if len(resolved) == 1 else ""),
            }
            manifest["outputSignatures"] = {"video": self._signature(video if len(resolved) == 1 else staging / "video.mp4")}
            for key, path in (("transcript", transcript), ("subtitles", subtitle)):
                if path:
                    manifest["outputSignatures"][key] = self._signature(staging / path.name)
            self._atomic_text(staging / "video.manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
            self._cancelled()
            for path, signature in source_signatures + text_signatures:
                if not path.is_file() or path.is_symlink() or not self._same_content_identity(self._signature(path), signature):
                    raise ValueError("归档期间输入文件发生变化，未发布结果")
            if Path(self.recording_root()).expanduser().resolve() != root:
                raise ValueError("录制目录已更改，未发布归档")
            staging.rename(target)
            self._put(manifest)
            return self._public(manifest)
        finally:
            if staging.is_dir() and not staging.is_symlink():
                shutil.rmtree(staging)

    def _public(self, item):
        value = copy.deepcopy(item)
        value.setdefault("status", "completed")
        if value["status"] == "completed" and not self._existing_complete(item):
            value.update(status="failed", stage="归档文件不可用", error="归档文件已被移动、删除或修改，请检查后重试")
        root = Path(self.recording_root()).expanduser().resolve()
        for key in ("video", "transcript", "subtitles", "manifest"):
            path = value.pop(key, None)
            if path:
                try:
                    value[key + "Path"] = str(self._safe_file(path, root).relative_to(root))
                except (OSError, ValueError):
                    value[key + "Path"] = None
        for key in ("segments", "temp", "outputSignatures"):
            value.pop(key, None)
        if self.error and value["status"] in {"queued", "processing"}:
            value.update(status="failed", stage="归档后台服务停止", error=self.error)
        value["canRetry"] = value["status"] == "failed"
        return value

    def snapshot(self):
        try:
            data = self._read()
        except (OSError, ValueError):
            return {"archives": [], "error": "录制归档记录无法读取，原记录已保留"}
        return {"archives": [self._public(item) for item in reversed(data["archives"][-50:])], "error": self.error}
