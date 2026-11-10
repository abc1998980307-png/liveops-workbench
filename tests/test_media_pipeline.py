import os
import errno
import json
import sys
import subprocess
import tempfile
import unittest
import threading
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import media_pipeline as pipeline


class MediaPipelineTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.recordings = self.root / "recordings"
        self.recordings.mkdir()
        self.source = self.recordings / "直播.flv"
        self.original = b"synthetic source recording"
        self.source.write_bytes(self.original)
        for name, value in {
            "CONFIG_FILE": self.root / "settings.json",
            "JOBS_FILE": self.root / "jobs.json",
            "RECORDINGS": self.recordings,
            "TRANSCRIPTS": self.root / "transcripts",
            "WHISPER": self.root / "missing-whisper",
            "MODEL": self.root / "missing-model",
            "FFMPEG": self.root / "fake-ffmpeg",
            "_stable": {},
            "_stop": threading.Event(),
            "_wake": threading.Event(),
            "_worker_thread": None,
            "_worker_error": None,
        }.items():
            self.stack.enter_context(mock.patch.object(pipeline, name, value))
        self.config = {
            "enabled": True,
            "keepOriginal": False,
            "codec": "libx264",
            "model": str(pipeline.MODEL),
            "recordingDirectory": str(self.recordings),
        }
        self.stack.enter_context(mock.patch.object(pipeline, "read_config", return_value=self.config))
        self.is_open = self.stack.enter_context(mock.patch.object(pipeline, "_is_open", return_value=False))
        self.run = self.stack.enter_context(mock.patch.object(pipeline, "_run", side_effect=self.successful_command))
        self.stack.enter_context(mock.patch.object(pipeline, "_audio_duration_ms", return_value=3000))
        self.job = pipeline._create_job(self.source)
        self.addCleanup(pipeline.stop_worker)

    def successful_command(self, command):
        # Encoding produces a real temporary file; validation has no output file.
        if command[-1] != "-":
            Path(command[-1]).write_bytes(b"synthetic compressed video")

    def saved_job(self):
        return next(job for job in pipeline._read_jobs() if job["id"] == self.job["id"])

    def assert_source_preserved(self):
        self.assertEqual(self.source.read_bytes(), self.original)
        self.assertFalse(self.saved_job().get("sourceDeleted", False))
        self.assertEqual(list(self.recordings.glob("*.tmp.mp4")), [])

    def test_success_deletes_source_after_compression_and_validation(self):
        pipeline._process(self.job, self.config)
        result = self.saved_job()
        self.assertFalse(self.source.exists())
        self.assertEqual(Path(result["compressed"]).read_bytes(), b"synthetic compressed video")
        self.assertTrue(result["compressionCompleted"])
        self.assertTrue(result["sourceDeleted"])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(self.run.call_count, 2)
        self.assertEqual(list(self.recordings.glob("*.tmp.mp4")), [])

    def test_keep_original_retains_source(self):
        self.config["keepOriginal"] = True
        pipeline._process(self.job, self.config)
        self.assert_source_preserved()
        self.assertTrue(Path(self.saved_job()["compressed"]).is_file())

    def test_compression_failure_keeps_source_and_removes_partial_output(self):
        def fail_encoding(command):
            Path(command[-1]).write_bytes(b"incomplete output")
            raise RuntimeError("encoding failed")

        self.run.side_effect = fail_encoding
        with self.assertRaisesRegex(RuntimeError, "encoding failed"):
            pipeline._process(self.job, self.config)
        self.assert_source_preserved()
        self.assertEqual(list(self.recordings.glob("*.compressed.mp4")), [])

    def test_validation_failure_keeps_source_and_removes_invalid_output(self):
        def fail_validation(command):
            if command[-1] == "-":
                raise RuntimeError("invalid compressed video")
            self.successful_command(command)

        self.run.side_effect = fail_validation
        with self.assertRaisesRegex(RuntimeError, "invalid compressed video"):
            pipeline._process(self.job, self.config)
        self.assert_source_preserved()
        self.assertEqual(list(self.recordings.glob("*.compressed.mp4")), [])

    def test_source_changed_during_compression_is_not_deleted(self):
        def mutate_source(command):
            self.successful_command(command)
            if command[-1] == "-":
                self.source.write_bytes(self.original + b"new live frames")

        self.run.side_effect = mutate_source
        with self.assertRaisesRegex(RuntimeError, "发生变化"):
            pipeline._process(self.job, self.config)
        self.assertEqual(self.source.read_bytes(), self.original + b"new live frames")
        self.assertFalse(self.saved_job().get("sourceDeleted", False))
        self.assertEqual(list(self.recordings.glob("*.tmp.mp4")), [])

    def test_preexisting_output_is_not_reused_or_overwritten(self):
        existing = self.source.with_name(self.source.name + ".compressed.mp4")
        existing.write_bytes(b"unrelated preexisting recording")
        pipeline._process(self.job, self.config)
        result = self.saved_job()
        self.assertEqual(existing.read_bytes(), b"unrelated preexisting recording")
        self.assertNotEqual(Path(result["compressed"]), existing)
        self.assertEqual(Path(result["compressed"]).read_bytes(), b"synthetic compressed video")
        self.assertFalse(self.source.exists())
        self.assertEqual(self.run.call_count, 2)

    def test_source_deletion_failure_keeps_both_files_and_reports_cleanup_error(self):
        real_unlink = Path.unlink

        def protected_unlink(path, *args, **kwargs):
            if path.resolve() == self.source.resolve():
                raise PermissionError("source is read only")
            return real_unlink(path, *args, **kwargs)

        with mock.patch.object(Path, "unlink", protected_unlink):
            with self.assertRaisesRegex(RuntimeError, "压缩成功，但原文件删除失败"):
                pipeline._process(self.job, self.config)
        self.assert_source_preserved()
        self.assertTrue(self.saved_job()["compressionCompleted"])
        self.assertTrue(Path(self.saved_job()["compressed"]).is_file())

    def test_worker_compresses_when_whisper_and_model_are_missing(self):
        pipeline.FFMPEG.touch()
        thread = pipeline.start_worker()
        for _ in range(100):
            if self.saved_job()["status"] == "completed":
                break
            threading.Event().wait(.01)
        self.assertTrue(pipeline.stop_worker())
        self.assertFalse(thread.is_alive())
        result = pipeline._read_jobs()[-1]
        self.assertEqual(result["status"], "completed")
        self.assertIn("转写组件未就绪", result["stage"])
        self.assertTrue(Path(result["compressed"]).is_file())
        self.assertTrue(result["sourceDeleted"])
        self.assertFalse(self.source.exists())

    def test_corrupt_job_ledger_blocks_processing_without_replacing_it(self):
        original_jobs = pipeline.JOBS_FILE.read_bytes()
        damaged = b'{"jobs": broken}'
        pipeline.JOBS_FILE.write_bytes(damaged)
        pipeline.FFMPEG.touch()
        with mock.patch.object(pipeline, "POLL_SECONDS", .02):
            thread = pipeline.start_worker()
            for _ in range(100):
                if pipeline.job_snapshot()["workerError"]:
                    break
                threading.Event().wait(.01)
            snapshot = pipeline.job_snapshot()
            self.assertTrue(thread.is_alive())
            self.assertIn("媒体任务记录不可读", snapshot["storageError"])
            self.assertIn("媒体任务记录不可读", snapshot["workerError"])
            self.assertEqual(pipeline.JOBS_FILE.read_bytes(), damaged)
            self.assertEqual(self.source.read_bytes(), self.original)
            self.run.assert_not_called()
            pipeline.JOBS_FILE.write_bytes(original_jobs)
            pipeline._wake.set()
            for _ in range(200):
                if pipeline._read_jobs()[0]["status"] == "completed":
                    break
                threading.Event().wait(.01)
        self.assertEqual(pipeline._read_jobs()[0]["status"], "completed")
        self.assertIsNone(pipeline.job_snapshot()["workerError"])

    def test_malformed_job_ledger_and_partial_write_never_replace_saved_jobs(self):
        original_jobs = pipeline.JOBS_FILE.read_bytes()
        for damaged in (b"{}", b"[{}]", b"not json"):
            with self.subTest(damaged=damaged):
                pipeline.JOBS_FILE.write_bytes(damaged)
                with self.assertRaisesRegex(RuntimeError, "媒体任务记录"):
                    pipeline._create_job(self.source)
                self.assertEqual(pipeline.JOBS_FILE.read_bytes(), damaged)
                self.assertEqual(self.source.read_bytes(), self.original)
        pipeline.JOBS_FILE.write_bytes(original_jobs)
        original_write = Path.write_text

        def fail_temporary_write(path, content, *args, **kwargs):
            if path == pipeline.JOBS_FILE.with_suffix(".tmp"):
                path.write_bytes(b"partial")
                raise OSError(errno.ENOSPC, "No space left on device")
            return original_write(path, content, *args, **kwargs)

        with mock.patch.object(Path, "write_text", fail_temporary_write):
            with self.assertRaises(OSError):
                pipeline._write_jobs([self.job])
        self.assertEqual(pipeline.JOBS_FILE.read_bytes(), original_jobs)
        self.assertEqual(pipeline._read_jobs()[0]["id"], self.job["id"])

    def test_disk_full_keeps_worker_alive_and_retries_after_space_returns(self):
        pipeline.FFMPEG.touch()
        saved = pipeline.JOBS_FILE.read_bytes()
        writable = threading.Event()
        original_write = pipeline._write_jobs

        def write_when_space_returns(jobs):
            if not writable.is_set():
                raise OSError(errno.ENOSPC, "No space left on device")
            return original_write(jobs)

        with mock.patch.object(pipeline, "POLL_SECONDS", .02), mock.patch.object(pipeline, "_write_jobs", side_effect=write_when_space_returns):
            thread = pipeline.start_worker()
            for _ in range(100):
                if pipeline.job_snapshot()["workerError"]:
                    break
                threading.Event().wait(.01)
            self.assertTrue(thread.is_alive())
            self.assertIn("磁盘空间不足", pipeline.job_snapshot()["workerError"])
            self.assertEqual(pipeline.JOBS_FILE.read_bytes(), saved)
            self.assertEqual(self.source.read_bytes(), self.original)
            self.run.assert_not_called()
            writable.set()
            pipeline._wake.set()
            for _ in range(200):
                if pipeline._read_jobs()[0]["status"] == "completed":
                    break
                threading.Event().wait(.01)
        self.assertEqual(pipeline._read_jobs()[0]["status"], "completed")
        self.assertIsNone(pipeline.job_snapshot()["workerError"])

    def test_published_video_recovers_after_ledger_write_fails_without_reencoding(self):
        original_update = pipeline._update_job
        failed = False

        def fail_after_publish(job_id, **changes):
            nonlocal failed
            if changes.get("compressionCompleted") and not failed:
                failed = True
                self.assertEqual(len(list(self.recordings.glob("*.compressed.mp4"))), 1)
                self.assertEqual(self.source.read_bytes(), self.original)
                raise OSError(errno.ENOSPC, "No space left on device")
            return original_update(job_id, **changes)

        with mock.patch.object(pipeline, "_update_job", side_effect=fail_after_publish):
            with self.assertRaises(OSError):
                pipeline._process(self.job, self.config)
        pending = self.saved_job()["compressionPublishPending"]
        self.assertEqual(Path(pending["path"]).read_bytes(), b"synthetic compressed video")
        self.assertTrue(self.source.exists())
        self.assertEqual(self.run.call_count, 2)

        pipeline._recover_processing_jobs()
        pipeline._process(pipeline._next_job(), self.config)
        self.assertEqual(self.run.call_count, 3)  # Only the full validation runs again.
        self.assertEqual(len(list(self.recordings.glob("*.compressed.mp4"))), 1)
        self.assertFalse(self.source.exists())
        self.assertIsNone(self.saved_job().get("compressionPublishPending"))
        self.assertEqual(self.saved_job()["status"], "completed")

    def test_pending_publish_with_missing_output_reencodes_without_adopting_other_file(self):
        def fail_before_publish(source, target):
            raise InterruptedError("simulated restart before link")

        with mock.patch.object(os, "link", side_effect=fail_before_publish):
            with self.assertRaises(InterruptedError):
                pipeline._process(self.job, self.config)
        pending = self.saved_job()["compressionPublishPending"]
        self.assertFalse(Path(pending["path"]).exists())
        self.assertTrue(self.source.exists())
        pipeline._recover_processing_jobs()
        pipeline._process(pipeline._next_job(), self.config)
        self.assertFalse(self.source.exists())
        self.assertEqual(len(list(self.recordings.glob("*.compressed.mp4"))), 1)
        self.assertEqual(self.saved_job()["status"], "completed")

    def make_pending_publish(self):
        original_update = pipeline._update_job

        def fail_after_publish(job_id, **changes):
            if changes.get("compressionCompleted"):
                raise OSError(errno.ENOSPC, "No space left on device")
            return original_update(job_id, **changes)

        with mock.patch.object(pipeline, "_update_job", side_effect=fail_after_publish):
            with self.assertRaises(OSError):
                pipeline._process(self.job, self.config)
        return Path(self.saved_job()["compressionPublishPending"]["path"])

    def test_pending_publish_refuses_changed_source(self):
        self.make_pending_publish()
        self.source.write_bytes(self.original + b"new frames")
        with self.assertRaisesRegex(RuntimeError, "原录屏已变化"):
            pipeline._process(self.saved_job(), self.config)
        self.assertTrue(self.source.exists())

    def test_pending_publish_refuses_changed_output(self):
        output = self.make_pending_publish()
        output.write_bytes(b"externally changed video")
        with self.assertRaisesRegex(RuntimeError, "压缩视频身份已变化"):
            pipeline._process(self.saved_job(), self.config)
        self.assertTrue(self.source.exists())
        self.assertEqual(self.run.call_count, 2)

    def test_worker_recovers_post_publish_disk_failure_when_space_returns(self):
        pipeline.FFMPEG.touch()
        original_write = pipeline._write_jobs
        writable = threading.Event()
        published = threading.Event()

        def fail_completion_checkpoint(jobs):
            if any(job.get("compressionCompleted") for job in jobs) and not writable.is_set():
                published.set()
                raise OSError(errno.ENOSPC, "No space left on device")
            return original_write(jobs)

        with mock.patch.object(pipeline, "POLL_SECONDS", .02), mock.patch.object(
                pipeline, "_write_jobs", side_effect=fail_completion_checkpoint):
            thread = pipeline.start_worker()
            self.assertTrue(published.wait(2))
            self.assertTrue(thread.is_alive())
            self.assertTrue(self.source.exists())
            self.assertEqual(len(list(self.recordings.glob("*.compressed.mp4"))), 1)
            writable.set()
            pipeline._wake.set()
            for _ in range(200):
                if self.saved_job()["status"] == "completed":
                    break
                threading.Event().wait(.01)
        self.assertEqual(self.saved_job()["status"], "completed")
        self.assertFalse(self.source.exists())
        self.assertEqual(len(list(self.recordings.glob("*.compressed.mp4"))), 1)
        self.assertEqual(self.run.call_count, 3)

    def test_old_sub_megabyte_recording_is_discovered_after_stability_check(self):
        unprocessed = self.recordings / "older small recording.mp4"
        unprocessed.write_bytes(b"small historical recording")
        os.utime(unprocessed, (1, 1))
        self.assertEqual(list(pipeline._candidate_files(self.recordings)), [])
        self.assertEqual(list(pipeline._candidate_files(self.recordings)), [unprocessed])

    def test_generated_archive_is_not_reenqueued_as_a_source(self):
        archive = self.recordings / ".liveops-archives" / "long-session.mp4"
        archive.parent.mkdir()
        archive.write_bytes(b"already merged")
        os.utime(archive, (1, 1))
        self.assertEqual(list(pipeline._candidate_files(self.recordings)), [])

    def test_media_duration_reads_container_duration_not_recorder_counter(self):
        completed = subprocess.CompletedProcess([], 0, stdout="", stderr="Duration: 01:02:03.456, start: 0.000000")
        with mock.patch.object(pipeline.subprocess, "run", return_value=completed) as run:
            self.assertEqual(pipeline.media_duration_ms(self.source), 3723456)
        self.assertIn("-t", run.call_args.args[0])

    def test_setting_changed_during_compression_can_prevent_deletion(self):
        started_config = dict(self.config)

        def disable_cleanup(command):
            self.successful_command(command)
            if command[-1] == "-":
                self.config["keepOriginal"] = True

        self.run.side_effect = disable_cleanup
        pipeline._process(self.job, started_config)
        self.assert_source_preserved()
        self.assertTrue(Path(self.saved_job()["compressed"]).is_file())

    def enable_transcription(self):
        pipeline.WHISPER.touch()
        pipeline.MODEL.touch()

    def transcription_command(self, command, **kwargs):
        if command[0] == str(pipeline.WHISPER):
            Path(command[-1] + ".txt").write_text("合成测试字幕")
            Path(command[-1] + ".srt").write_text("1\n00:00:00,000 --> 00:00:01,000\n合成测试字幕\n")
        else:
            self.successful_command(command)

    def test_retry_after_transcription_failure_reuses_validated_video_without_source(self):
        self.enable_transcription()
        def fail_transcription(command):
            if command[0] == str(pipeline.WHISPER):
                raise RuntimeError("temporary transcription error")
            self.successful_command(command)
        self.run.side_effect = fail_transcription
        with self.assertRaisesRegex(RuntimeError, "transcription error"):
            pipeline._process(self.job, self.config)
        self.assertFalse(self.source.exists())
        saved = self.saved_job()
        output = Path(saved["compressed"])
        pipeline._update_job(saved["id"], status="failed")
        pipeline.retry_job(saved["id"])
        self.run.reset_mock()
        self.run.side_effect = self.transcription_command
        pipeline._process(pipeline._next_job(), self.config)
        saved = self.saved_job()
        self.assertEqual(saved["status"], "completed")
        self.assertEqual(saved["compressed"], str(output))
        self.assertTrue(Path(saved["transcript"]).is_file())
        self.assertTrue(Path(saved["subtitles"]).is_file())
        self.assertEqual(self.run.call_count, 3)  # Validate, extract, transcribe.
        self.assertFalse(any("-c:v" in c.args[0] for c in self.run.call_args_list))

    def test_missing_srt_regenerates_both_atomically_and_preserves_existing_text(self):
        self.enable_transcription()
        self.run.side_effect = self.transcription_command
        pipeline._process(self.job, self.config)
        saved = self.saved_job()
        old_text = Path(saved["transcript"])
        Path(saved["subtitles"]).unlink()
        pipeline.retry_job(saved["id"])
        pipeline._process(pipeline._next_job(), self.config)
        result = self.saved_job()
        self.assertNotEqual(result["transcript"], str(old_text))
        self.assertEqual(old_text.read_text(), "合成测试字幕")
        self.assertTrue(Path(result["subtitles"]).is_file())

    def test_partial_transcription_is_not_published(self):
        self.enable_transcription()
        def partial(command):
            if command[0] == str(pipeline.WHISPER):
                Path(command[-1] + ".txt").write_text("partial")
            else:
                self.successful_command(command)
        self.run.side_effect = partial
        with self.assertRaisesRegex(RuntimeError, "文本或字幕不完整"):
            pipeline._process(self.job, self.config)
        self.assertEqual(list(pipeline.TRANSCRIPTS.rglob("*.txt")), [])
        self.assertTrue(Path(self.saved_job()["compressed"]).is_file())

    def test_missing_validated_output_is_an_explicit_failure(self):
        pipeline._process(self.job, self.config)
        saved = self.saved_job()
        Path(saved["compressed"]).unlink()
        with self.assertRaisesRegex(RuntimeError, "已不存在"):
            pipeline._process(saved, self.config)

    def test_modified_validated_output_is_not_used_or_overwritten(self):
        self.config["keepOriginal"] = True
        pipeline._process(self.job, self.config)
        saved = self.saved_job()
        output = Path(saved["compressed"])
        output.write_bytes(b"externally replaced")
        self.config["keepOriginal"] = False
        with self.assertRaisesRegex(RuntimeError, "已被修改"):
            pipeline._process(saved, self.config)
        self.assert_source_preserved()
        self.assertEqual(output.read_bytes(), b"externally replaced")

    def test_retry_is_idempotent_and_disabled_pipeline_does_not_queue(self):
        pipeline._update_job(self.job["id"], status="failed")
        self.config["enabled"] = False
        with self.assertRaisesRegex(ValueError, "开启自动处理"):
            pipeline.retry_job(self.job["id"])
        self.assertEqual(self.saved_job()["status"], "failed")
        self.config["enabled"] = True
        self.assertFalse(pipeline.retry_job(self.job["id"])["alreadyQueued"])
        self.assertTrue(pipeline.retry_job(self.job["id"])["alreadyQueued"])
        self.assertEqual(len(pipeline._read_jobs()), 1)

    def test_restart_preserves_deleted_source_job_and_resumes_it(self):
        pipeline._process(self.job, self.config)
        self.enable_transcription()
        self.run.side_effect = self.transcription_command
        pipeline._update_job(self.job["id"], status="processing")
        pipeline.FFMPEG.touch()
        first = pipeline.start_worker()
        self.assertIs(pipeline.start_worker(), first)
        for _ in range(200):
            if self.saved_job().get("transcriptionCompleted"):
                break
            threading.Event().wait(.01)
        self.assertTrue(pipeline.stop_worker())
        self.assertEqual(len(pipeline._read_jobs()), 1)
        self.assertTrue(self.saved_job()["transcriptionCompleted"])
        self.assertTrue(self.saved_job()["sourceDeleted"])

    def test_disabled_worker_preserves_queued_jobs(self):
        self.config["enabled"] = False
        pipeline.FFMPEG.touch()
        pipeline.start_worker()
        self.assertTrue(pipeline.stop_worker())
        self.assertEqual(self.saved_job()["status"], "queued")
        self.run.assert_not_called()

    def test_interruption_requeues_same_job(self):
        pipeline.FFMPEG.touch()
        def interrupt(command):
            pipeline._stop.set()
            pipeline._wake.set()
            raise InterruptedError("shutdown")
        self.run.side_effect = interrupt
        thread = pipeline.start_worker()
        thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(self.saved_job()["status"], "queued")
        self.assert_source_preserved()

    def test_retry_refuses_paths_outside_current_root_and_symlinks(self):
        outside = self.root / "outside.flv"
        outside.write_bytes(b"outside")
        link = self.recordings / "link.flv"
        link.symlink_to(outside)
        for path in (outside, link):
            pipeline._update_job(self.job["id"], status="failed", source=str(path))
            with self.assertRaises(ValueError):
                pipeline.retry_job(self.job["id"])

    def test_crash_after_unlink_finishes_cleanup_bookkeeping(self):
        pipeline._process(self.job, self.config)
        pipeline._update_job(self.job["id"], sourceDeletePending=True, sourceDeleted=False)
        pipeline._process(self.saved_job(), self.config)
        self.assertTrue(self.saved_job()["sourceDeleted"])
        self.assertFalse(self.saved_job()["sourceDeletePending"])

    def test_published_transcript_attempt_resumes_without_regenerating(self):
        self.enable_transcription()
        self.run.side_effect = self.transcription_command
        pipeline._process(self.job, self.config)
        saved = self.saved_job()
        pipeline._update_job(self.job["id"], status="processing", transcriptionCompleted=False, transcript=None, subtitles=None)
        self.run.reset_mock()
        pipeline._process(self.saved_job(), self.config)
        self.assertEqual(self.run.call_count, 1)
        self.assertEqual(self.saved_job()["transcript"], saved["transcript"])
        self.assertEqual(self.saved_job()["subtitles"], saved["subtitles"])

    def test_snapshot_exposes_finder_paths_and_both_artifact_links(self):
        self.enable_transcription()
        self.run.side_effect = self.transcription_command
        pipeline._process(self.job, self.config)
        job = pipeline.job_snapshot()["jobs"][0]
        self.assertIsNone(job["compressedUrl"])
        self.assertTrue(job["compressedPath"].endswith(".compressed.mp4"))
        self.assertTrue(job["transcriptUrl"].startswith("/transcripts/"))
        self.assertTrue(job["subtitlesUrl"].startswith("/transcripts/"))
        self.assertFalse(job["canRetry"])


class SubtitleBoundsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "test.srt"

    def test_clips_whisper_padded_tail_and_drops_cues_after_audio(self):
        self.path.write_text("1\n00:00:25,000 --> 00:00:30,000\nfinal words\n\n2\n00:00:30,000 --> 00:00:31,000\npadding\n")
        result = pipeline._clip_subtitles(self.path, 28800)
        self.assertEqual(result, {"audioDurationMs": 28800, "clippedCues": 1, "droppedCues": 1, "zeroDurationCues": 0})
        self.assertEqual(self.path.read_text(), "1\n00:00:25,000 --> 00:00:28,800\nfinal words\n")

    def test_keeps_hour_long_offsets_and_empty_silence_output(self):
        self.path.write_text("1\n01:00:00,000 --> 01:00:01,000\nwords\n")
        pipeline._clip_subtitles(self.path, 3600500)
        self.assertIn("01:00:00,500", self.path.read_text())
        self.path.write_text("")
        self.assertEqual(pipeline._clip_subtitles(self.path, 3000)["clippedCues"], 0)

    def test_malformed_subtitles_fail_without_modifying_input(self):
        for data in ("not SRT", "1\n00:70:00,000 --> 00:71:00,000\nwords", "1\n00:00:05,000 --> 00:00:04,000\nwords"):
            self.path.write_text(data)
            with self.assertRaises(ValueError):
                pipeline._clip_subtitles(self.path, 10000)
            self.assertEqual(self.path.read_text(), data)

    def test_instantaneous_whisper_tokens_have_no_invented_duration(self):
        self.path.write_text("1\n00:00:01,000 --> 00:00:01,000\ninstant\n\n2\n00:00:01,000 --> 00:00:02,000\nwords\n")
        report = pipeline._clip_subtitles(self.path, 3000)
        self.assertEqual(report["zeroDurationCues"], 1)
        self.assertNotIn("instant", self.path.read_text())
        self.assertTrue(self.path.read_text().startswith("1\n"))


if __name__ == "__main__":
    unittest.main()
