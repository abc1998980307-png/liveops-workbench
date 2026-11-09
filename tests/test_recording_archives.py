import copy
import json
import sys
import tempfile
import unittest
import subprocess
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from recording_archives import RecordingArchiveManager, merge_srt
import media_pipeline


class FakeSessions:
    def __init__(self, session):
        self.session = session

    def _read(self):
        return {"version": 1, "sessions": [copy.deepcopy(self.session)]}


class FakePipeline:
    def __init__(self, jobs):
        self.jobs = jobs
        self.FFMPEG = "fake-ffmpeg"
        self.validated = []
        self.merges = 0
        self.fail_calls = 0
        self.fail_next = False

    def archive_jobs(self):
        return copy.deepcopy(self.jobs)

    def validate_video(self, path):
        self.validated.append(Path(path).name)

    def media_duration_ms(self, path):
        return 2000

    def inspect_media(self, path):
        return {"durationMs": 2000, "tracks": [{"type": "vide", "codec": "avc1"}, {"type": "soun", "codec": "mp4a"}], "width": 64, "height": 64}

    def run_command(self, command):
        self.merges += 1
        if self.merges <= self.fail_calls or self.fail_next:
            self.fail_next = False
            raise RuntimeError("stream layout differs")
        Path(command[-1]).write_bytes(b"merged video")


class RecordingArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.recordings = self.root / "recordings"
        self.recordings.mkdir()
        self.inputs = [self.recordings / "one.compressed.mp4", self.recordings / "two.compressed.mp4"]
        for index, path in enumerate(self.inputs, 1):
            path.write_bytes((f"input-{index}").encode())
        self.texts = []
        self.subtitles = []
        for index, path in enumerate(self.inputs, 1):
            text = self.root / f"{index}.txt"
            subtitle = self.root / f"{index}.srt"
            text.write_text(f"片段{index}\n", encoding="utf-8")
            subtitle.write_text(f"1\n00:00:00,500 --> 00:00:01,000\n片段{index}\n", encoding="utf-8")
            self.texts.append(text)
            self.subtitles.append(subtitle)
        self.segments = []
        for index, path in enumerate(self.inputs, 1):
            self.segments.append({
                "root": str(self.recordings), "path": f"{index}.flv", "device": 1, "inode": index,
                "firstSeenAt": f"2026-11-09T10:00:0{index}+00:00",
                "lastSeenAt": f"2026-11-09T10:00:1{index}+00:00", "mediaDurationMs": 2000,
            })
        self.session = {
            "id": "a" * 32, "roomId": "room", "startedAt": "2026-11-09T10:00:00+00:00",
            "endedAt": "2026-11-09T10:00:30+00:00", "endReason": "normal",
            "segments": self.segments, "events": [], "partialObservation": True,
        }
        jobs = []
        for index, (input_path, text, subtitle) in enumerate(zip(self.inputs, self.texts, self.subtitles), 1):
            source = self.recordings / f"{index}.flv"
            job = {
                "id": f"{index:032x}", "source": str(source), "compressionCompleted": True,
                "compressed": str(input_path),
                "compressedSignature": RecordingArchiveManager._signature(input_path),
                "sourceSignature": [1, index, 10, 1, 1],
                "transcript": str(text), "subtitles": str(subtitle),
                "subtitleBounds": {"audioDurationMs": 2000},
            }
            jobs.append(job)
        self.pipeline = FakePipeline(jobs)
        self.sessions = FakeSessions(self.session)
        self.manager = RecordingArchiveManager(self.root, self.sessions, self.pipeline,
                                               lambda: self.recordings, now=lambda: 1794218430)

    def test_srt_offsets_and_hour_timecodes(self):
        result = merge_srt([
            "1\n00:59:59,500 --> 01:00:00,000\n前\n",
            "1\n00:00:00,500 --> 00:00:01,000\n后\n",
        ], [0, 3_600_000])
        self.assertIn("01:00:00,500 --> 01:00:01,000", result)
        self.assertIn("00:59:59,500 --> 01:00:00,000", result)
        self.assertEqual(result.count("\n\n"), 1)

    def test_archive_merges_in_order_and_publishes_manifest_text_and_subtitles(self):
        result = self.manager.create(self.session["id"])
        self.assertEqual(self.pipeline.merges, 1)
        self.assertEqual(self.pipeline.validated[:2], ["one.compressed.mp4", "two.compressed.mp4"])
        self.assertTrue(self.pipeline.validated[2].endswith(".tmp.mp4"))
        video = self.recordings / result["videoPath"]
        self.assertTrue(video.is_file())
        transcript = self.recordings / result["transcriptPath"]
        subtitle = self.recordings / result["subtitlesPath"]
        self.assertEqual(transcript.read_text(), "片段1\n\n片段2\n")
        self.assertIn("00:00:02,500 --> 00:00:03,000", subtitle.read_text())
        self.assertTrue(result["unknownGaps"])
        manifest = json.loads(video.with_suffix(".manifest.json").read_text())
        self.assertEqual(manifest["gaps"][0]["status"], "unknown")
        self.assertIn("没有被补回", manifest["note"])

    def test_archive_is_idempotent_and_rejects_active_or_changed_input(self):
        self.manager.create(self.session["id"])
        self.manager.create(self.session["id"])
        self.assertEqual(self.pipeline.merges, 1)
        active = copy.deepcopy(self.session)
        active["id"] = "b" * 32
        active["endedAt"] = None
        self.sessions.session = active
        with self.assertRaisesRegex(ValueError, "尚未收到"):
            self.manager.create(active["id"])
        self.sessions.session = self.session
        self.inputs[0].write_bytes(b"changed")
        changed = copy.deepcopy(self.session)
        changed["id"] = "c" * 32
        self.sessions.session = changed
        with self.assertRaisesRegex(ValueError, "已被修改"):
            self.manager.create(changed["id"])

    def test_failed_merge_leaves_retryable_state_and_reencode_fallback(self):
        self.pipeline.fail_calls = 3
        with self.assertRaisesRegex(RuntimeError, "音频布局不兼容"):
            self.manager.create(self.session["id"])
        pending = self.manager.snapshot()["archives"][0]
        self.assertEqual(pending["status"], "processing")
        self.pipeline.fail_calls = 0
        result = self.manager.create(self.session["id"])
        self.assertEqual(result["status"], "completed")
        self.assertIn(result["merge"]["mode"], {"stream_copy", "reencode"})
        self.assertEqual(self.pipeline.merges, 3)

        second = copy.deepcopy(self.session)
        second["id"] = "d" * 32
        self.sessions.session = second
        self.pipeline.fail_next = True
        fallback = self.manager.create(second["id"])
        self.assertEqual(fallback["merge"]["mode"], "reencode")

    def test_real_ffmpeg_merge_preserves_audio_and_uses_container_duration(self):
        ffmpeg = str(media_pipeline.FFMPEG)
        real_root = self.recordings / "real"
        real_root.mkdir()
        jobs, segments = [], []
        for index, color in enumerate(("red", "blue"), 1):
            output = real_root / f"{index}.compressed.mp4"
            subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                            "-i", f"color=c={color}:s=64x64:r=10", "-f", "lavfi",
                            "-i", "sine=frequency=1000:sample_rate=48000", "-t", "1.0",
                            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
                            "-movflags", "+faststart", str(output)], check=True)
            source = self.recordings / f"{index}.flv"
            segments.append({"root": str(self.recordings), "path": source.name, "device": 1, "inode": index,
                             "firstSeenAt": f"2026-11-09T10:00:0{index}+00:00",
                             "lastSeenAt": f"2026-11-09T10:00:0{index}+00:00", "mediaDurationMs": 1000})
            jobs.append({"id": f"{index:032x}", "source": str(source), "compressionCompleted": True,
                         "compressed": str(output), "compressedSignature": RecordingArchiveManager._signature(output),
                         "sourceSignature": [1, index, 1, 1, 1]})
        session = {"id": "e" * 32, "roomId": "room", "startedAt": "2026-11-09T10:00:00+00:00",
                   "endedAt": "2026-11-09T10:00:03+00:00", "endReason": "normal", "segments": segments,
                   "events": [], "partialObservation": False}
        pipeline = type("RealPipeline", (), {
            "FFMPEG": media_pipeline.FFMPEG,
            "archive_jobs": lambda self: copy.deepcopy(jobs),
            "validate_video": lambda self, path: media_pipeline.validate_video(path),
            "run_command": lambda self, command: media_pipeline.run_command(command),
            "inspect_media": lambda self, path: media_pipeline.inspect_media(path),
        })()
        manager = RecordingArchiveManager(self.root, FakeSessions(session), pipeline, lambda: self.recordings)
        result = manager.create(session["id"])
        self.assertIn(result["merge"]["mode"], {"stream_copy", "reencode"})
        self.assertTrue(result["merge"]["audioPreserved"])
        archive_path = self.recordings / result["videoPath"]
        metadata = media_pipeline.inspect_media(archive_path)
        self.assertTrue(metadata["hasAudio"])
        self.assertGreaterEqual(metadata["durationMs"], 1900)


if __name__ == "__main__":
    unittest.main()
