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
import subprocess
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

    def _read(self):
        try:
            value = json.loads(self.file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"version": ARCHIVES_VERSION, "archives": []}
        if (not isinstance(value, dict) or value.get("version") != ARCHIVES_VERSION
                or not isinstance(value.get("archives"), list)
                or any(not isinstance(item, dict) or not isinstance(item.get("id"), str)
                       for item in value["archives"])):
            raise ValueError("录制归档记录格式异常，原记录未覆盖")
        return value

    def _write(self, value):
        self.file.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.file.parent, delete=False) as handle:
            temp = Path(handle.name)
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            temp.replace(self.file)
        finally:
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
        if not isinstance(saved, list) or self._signature(compressed) != saved:
            raise ValueError("压缩片段已被修改，未生成合并归档")
        return job, compressed

    def _validate(self, path):
        validator = getattr(self.pipeline, "validate_video", None)
        if validator is None:
            raise RuntimeError("后处理组件不支持视频校验")
        validator(path)

    def _duration(self, path, fallback=None):
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
            if runner is None:
                subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            else:
                runner(command)

        try:
            command = [str(ffmpeg), "-hide_banner", "-nostdin", "-v", "error", "-xerror", "-y",
                       "-f", "concat", "-safe", "0", "-i", str(list_path),
                       "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-movflags", "+faststart", str(output)]
            try:
                run(command)
                return {"mode": "stream_copy", "audioPreserved": True}
            except Exception as first_error:
                output.unlink(missing_ok=True)
                inputs_args = []
                filters = []
                labels = []
                for index, path in enumerate(inputs):
                    inputs_args.extend(["-i", str(path)])
                    filters.extend([f"[{index}:v:0]setpts=PTS-STARTPTS[v{index}]",
                                    f"[{index}:a:0]asetpts=PTS-STARTPTS[a{index}]"])
                    labels.extend([f"[v{index}]", f"[a{index}]"])
                filters.append("".join(labels) + f"concat=n={len(inputs)}:v=1:a=1[v][a]")
                reencode = [str(ffmpeg), "-hide_banner", "-nostdin", "-v", "error", "-xerror", "-y",
                            *inputs_args, "-filter_complex", ";".join(filters), "-map", "[v]", "-map", "[a]",
                            "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-c:a", "aac",
                            "-b:a", "128k", "-movflags", "+faststart", str(output)]
                try:
                    run(reencode)
                    return {"mode": "reencode", "audioPreserved": True}
                except Exception:
                    output.unlink(missing_ok=True)
                    raise RuntimeError("片段音频布局不兼容，未生成丢失音频的归档") from first_error
        finally:
            list_path.unlink(missing_ok=True)

    def _archive_dir(self):
        root = Path(self.recording_root()).expanduser().resolve()
        root.mkdir(parents=True, exist_ok=True)
        return root / ".liveops-archives"

    def create(self, session_id):
        if not isinstance(session_id, str) or not re.fullmatch(r"[a-f0-9]{32}", session_id):
            raise ValueError("录制场次 ID 格式不正确")
        with self.lock:
            data = self.sessions._read()
            session = next((item for item in data["sessions"] if item.get("id") == session_id), None)
            if session is None:
                raise FileNotFoundError("找不到录制场次")
            if not session.get("endedAt"):
                raise ValueError("当前录制尚未收到录制器结束事件，暂不合并")
            segments = session.get("segments") or []
            if not segments:
                raise ValueError("录制场次没有已观察到的片段")
            archive_store = self._read()
            existing = next((item for item in archive_store["archives"] if item.get("sessionId") == session_id), None)
            if existing and existing.get("status", "completed") == "completed" and existing.get("video"):
                try:
                    existing_video = self._safe_file(existing["video"], self.recording_root())
                    if existing_video.is_file() and existing_video.stat().st_size > 0:
                        return self._public(existing)
                except (OSError, ValueError):
                    pass
            if existing:
                temp_path = existing.get("temp")
                if temp_path:
                    try:
                        self._safe_file(temp_path, self.recording_root()).unlink(missing_ok=True)
                    except (OSError, ValueError):
                        pass
                archive_store["archives"] = [item for item in archive_store["archives"] if item.get("id") != existing.get("id")]
                self._write(archive_store)
            jobs = self._jobs()
            resolved = [self._find_job(segment, jobs) for segment in segments]
            for _job, path in resolved:
                self._validate(path)
            archive_id = uuid.uuid4().hex
            directory = self._archive_dir()
            directory.mkdir(parents=True, exist_ok=True)
            output = directory / f"{session_id}.mp4"
            temp_output = directory / f".{session_id}.{archive_id}.tmp.mp4"
            processing = {"version": 1, "id": archive_id, "sessionId": session_id, "status": "processing",
                          "createdAt": datetime.fromtimestamp(self.now(), timezone.utc).isoformat(),
                          "temp": str(temp_output), "video": None, "transcript": None, "subtitles": None,
                          "note": "合并任务尚未完成；再次点击将清理临时文件并重试。"}
            archive_store["archives"].append(processing)
            self._write(archive_store)
            try:
                merge_report = self._merge_video([path for _job, path in resolved], temp_output)
                if not temp_output.is_file() or temp_output.stat().st_size == 0:
                    raise RuntimeError("FFmpeg 没有生成合并视频")
                self._validate(temp_output)
                temp_output.replace(output)
            finally:
                temp_output.unlink(missing_ok=True)

            offsets = []
            transcript_contents = []
            subtitle_contents = []
            can_publish_text = True
            can_publish_subtitles = True
            offset = 0
            for segment, (job, _path) in zip(segments, resolved):
                offsets.append(offset)
                bounds = job.get("subtitleBounds") or {}
                duration = self._duration(_path, segment.get("mediaDurationMs"))
                if not isinstance(duration, int) or duration < 0:
                    can_publish_subtitles = False
                    duration = 0
                offset += duration
                transcript = Path(job["transcript"]).expanduser() if job.get("transcript") else None
                subtitles = Path(job["subtitles"]).expanduser() if job.get("subtitles") else None
                if transcript and transcript.is_file():
                    transcript_contents.append(transcript.read_text(encoding="utf-8"))
                else:
                    can_publish_text = False
                if subtitles and subtitles.is_file():
                    subtitle_contents.append(subtitles.read_text(encoding="utf-8"))
                else:
                    can_publish_subtitles = False

            transcript_path = None
            subtitles_path = None
            if can_publish_text and len(transcript_contents) == len(resolved):
                transcript_path = output.with_suffix(".txt")
                self._atomic_text(transcript_path, merge_text(transcript_contents))
            if can_publish_subtitles and len(subtitle_contents) == len(resolved) and len(offsets) == len(subtitle_contents):
                subtitles_path = output.with_suffix(".srt")
                self._atomic_text(subtitles_path, merge_srt(subtitle_contents, offsets))

            gaps = []
            for before, after in zip(segments, segments[1:]):
                first = after.get("firstSeenAt")
                last = before.get("lastSeenAt")
                gap_ms = None
                try:
                    from datetime import datetime as _datetime
                    gap_ms = max(0, int((_datetime.fromisoformat(first.replace("Z", "+00:00")).timestamp()
                                         - _datetime.fromisoformat(last.replace("Z", "+00:00")).timestamp()) * 1000))
                except (AttributeError, TypeError, ValueError):
                    pass
                gaps.append({"from": before.get("path"), "to": after.get("path"),
                             "observedGapMs": gap_ms, "status": "unknown",
                             "note": "文件切换时间只能说明观察到的边界，不能恢复或精确计算未接收画面"})
            manifest = {
                "version": 1, "id": archive_id, "sessionId": session_id, "status": "completed",
                "createdAt": datetime.fromtimestamp(self.now(), timezone.utc).isoformat(),
                "endedAt": session.get("endedAt"), "endReason": session.get("endReason"),
                "segments": [{"path": segment.get("path"), "compressed": str(path),
                              "durationMs": self._duration(path, segment.get("mediaDurationMs")),
                              "compressedSignature": job.get("compressedSignature")} for segment, (job, path) in zip(segments, resolved)],
                "gaps": gaps, "partialObservation": bool(session.get("partialObservation", True)),
                "unknownGaps": bool(gaps) or bool(session.get("partialObservation", True)),
                "merge": merge_report,
                "video": str(output), "transcript": str(transcript_path) if transcript_path else None,
                "subtitles": str(subtitles_path) if subtitles_path else None,
                "note": "归档只合并已收到且已校验的片段；未知间断中的画面没有被补回。",
            }
            manifest_path = output.with_suffix(".manifest.json")
            self._atomic_text(manifest_path, json.dumps(manifest, ensure_ascii=False, indent=2))
            archive_store = self._read()
            archive_store["archives"] = [item for item in archive_store["archives"] if item.get("id") != archive_id]
            archive_store["archives"].append(manifest)
            self._write(archive_store)
            return self._public(manifest)

    def _public(self, item):
        value = copy.deepcopy(item)
        value.setdefault("status", "completed")
        root = Path(self.recording_root()).expanduser().resolve()
        for key in ("video", "transcript", "subtitles"):
            path = value.get(key)
            if not path:
                continue
            try:
                value[key + "Path"] = str(Path(path).resolve().relative_to(root))
            except (OSError, ValueError):
                value[key + "Path"] = None
            value[key] = None
        value.pop("segments", None)
        value.pop("temp", None)
        return value

    def snapshot(self):
        try:
            data = self._read()
        except (OSError, ValueError):
            return {"archives": [], "error": "录制归档记录无法读取，原记录已保留"}
        return {"archives": [self._public(item) for item in reversed(data["archives"][-50:])], "error": None}
