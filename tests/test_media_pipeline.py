import os
import sys
import tempfile
import unittest
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
        self.job = pipeline._create_job(self.source)

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
            if path == self.source:
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
        with mock.patch.object(pipeline, "_stop") as stop, mock.patch.object(
            pipeline, "_candidate_files", return_value=iter([self.source])
        ):
            stop.wait.side_effect = [False, True]
            pipeline.worker_loop()
        result = pipeline._read_jobs()[-1]
        self.assertEqual(result["status"], "completed")
        self.assertIn("转写组件未就绪", result["stage"])
        self.assertTrue(Path(result["compressed"]).is_file())
        self.assertTrue(result["sourceDeleted"])
        self.assertFalse(self.source.exists())

    def test_old_sub_megabyte_recording_is_discovered_after_stability_check(self):
        unprocessed = self.recordings / "older small recording.mp4"
        unprocessed.write_bytes(b"small historical recording")
        os.utime(unprocessed, (1, 1))
        self.assertEqual(list(pipeline._candidate_files(self.recordings)), [])
        self.assertEqual(list(pipeline._candidate_files(self.recordings)), [unprocessed])

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


if __name__ == "__main__":
    unittest.main()
