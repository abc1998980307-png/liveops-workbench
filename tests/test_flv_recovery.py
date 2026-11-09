import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from flv_recovery import inspect_tail
import media_pipeline as pipeline
import test_media_pipeline as fixtures


def tag(kind, payload, timestamp=0):
    header = bytes([kind]) + len(payload).to_bytes(3, "big") + (timestamp & 0xffffff).to_bytes(3, "big") + bytes([timestamp >> 24]) + b"\0\0\0"
    return header + payload + (len(payload) + 11).to_bytes(4, "big")


def avc(payload=b"good", declared=None, timestamp=0):
    return tag(9, b"\x27\x01\0\0\0" + (len(payload) if declared is None else declared).to_bytes(4, "big") + payload, timestamp)


HEADER = b"FLV\x01\x05\0\0\0\x09\0\0\0\0"
CONFIG = tag(9, b"\x17\0\0\0\0\x01\x64\0\x1f\xff\xe1\0\0")
END = tag(9, b"\x27\x02\0\0\0", 3600000)
PREFIX = HEADER + CONFIG + avc(timestamp=3599966)


class TailInspectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "sample.flv"

    def inspect(self, data):
        self.path.write_bytes(data)
        result = inspect_tail(self.path)
        self.assertEqual(self.path.read_bytes(), data)
        return result

    def test_only_final_avc_packet_is_removed_including_optional_end_tag(self):
        for suffix in (b"", END):
            with self.subTest(end_tag=bool(suffix)):
                result = self.inspect(PREFIX + avc(b"half", 200, 3600000) + suffix)
                self.assertEqual(result["prefixBytes"], len(PREFIX))
                self.assertEqual(result["packetTimeSeconds"], 3600)
                self.assertEqual(result["lastGoodVideoTimeSeconds"], 3599.966)

    def test_partial_raw_final_tag_can_be_isolated(self):
        good_tail = avc(b"a" * 100, timestamp=3600000)
        result = self.inspect(PREFIX + good_tail[:-54])
        self.assertEqual(result["prefixBytes"], len(PREFIX))

    def test_middle_damage_followed_by_valid_content_is_refused(self):
        for extra in (avc(), tag(8, b"audio"), END + END):
            self.path.write_bytes(PREFIX + avc(b"half", 200) + extra)
            with self.assertRaises(ValueError):
                inspect_tail(self.path)

    def test_valid_file_and_unsupported_headers_are_refused(self):
        for content in (PREFIX + END, b"not FLV", HEADER + avc(b"half", 200),
                        HEADER + tag(9, b"\x1c\0\0\0\0") + avc(b"half", 200)):
            self.path.write_bytes(content)
            with self.assertRaises(ValueError):
                inspect_tail(self.path)

    def test_bad_previous_tag_size_is_refused(self):
        self.path.write_bytes(PREFIX + avc(b"half", 200)[:-4] + b"\0\0\0\0")
        with self.assertRaisesRegex(ValueError, "边界损坏"):
            inspect_tail(self.path)

    def test_partial_audio_and_partial_container_header_are_refused(self):
        for data in (PREFIX + tag(8, b"audio")[:-7], PREFIX + b"\x09\x00"):
            self.path.write_bytes(data)
            with self.assertRaises(ValueError):
                inspect_tail(self.path)

    def test_cancellation_interrupts_read_only_scan(self):
        self.path.write_bytes(PREFIX + avc(b"half", 200))
        with self.assertRaises(InterruptedError):
            inspect_tail(self.path, lambda: True)


class TailPipelineTests(unittest.TestCase):
    # Reuse the isolated pipeline fixture, without inheriting its test methods.
    setUp = fixtures.MediaPipelineTests.setUp
    successful_command = fixtures.MediaPipelineTests.successful_command
    saved_job = fixtures.MediaPipelineTests.saved_job
    assert_source_preserved = fixtures.MediaPipelineTests.assert_source_preserved
    def test_tail_recovery_keeps_original_even_when_cleanup_is_enabled(self):
        data = PREFIX + avc(b"half", 200) + END
        self.source.write_bytes(data)
        self.original = data
        self.job["recoverTailRequested"] = True
        def run(command, **kwargs):
            self.successful_command(command)
            if "pipe:0" in command:
                self.assertEqual(kwargs["input_limit"], len(PREFIX))
                self.assertEqual(Path(kwargs["input_path"]), self.source.resolve())
        self.run.side_effect = run
        pipeline._process(self.job, self.config)
        self.assert_source_preserved()
        result = self.saved_job()
        self.assertTrue(result["compressionCompleted"])
        self.assertEqual(result["tailRecovery"]["prefixBytes"], len(PREFIX))
        self.assertEqual(self.run.call_count, 2)

    def test_live_file_is_never_recovered(self):
        self.source.write_bytes(PREFIX + avc(b"half", 200))
        self.is_open.return_value = True
        self.job["recoverTailRequested"] = True
        with self.assertRaisesRegex(RuntimeError, "仍被使用"):
            pipeline._process(self.job, self.config)
        self.run.assert_not_called()

    def test_recovery_validation_failure_keeps_original(self):
        self.original = PREFIX + avc(b"half", 200)
        self.source.write_bytes(self.original)
        self.job["recoverTailRequested"] = True
        def fail(command, **kwargs):
            if command[-1] == "-":
                raise RuntimeError("strict decode failed")
            self.successful_command(command)
        self.run.side_effect = fail
        with self.assertRaisesRegex(RuntimeError, "strict decode failed"):
            pipeline._process(self.job, self.config)
        self.assert_source_preserved()
        self.assertEqual(list(self.recordings.glob("*.compressed.mp4")), [])


class CommandLifecycleTests(unittest.TestCase):
    def test_stop_terminates_only_owned_processing_command_and_reports_interruption(self):
        stop = threading.Event()
        started = threading.Event()
        results = []
        real_popen = pipeline.subprocess.Popen
        def popen(*args, **kwargs):
            child = real_popen(*args, **kwargs)
            started.set()
            return child
        def work():
            try:
                pipeline._run([sys.executable, "-c", "import time; time.sleep(60)"])
            except Exception as error:
                results.append(error)
        with mock.patch.object(pipeline, "_stop", stop), mock.patch.object(pipeline.subprocess, "Popen", side_effect=popen):
            thread = threading.Thread(target=work)
            thread.start()
            self.assertTrue(started.wait(3))
            stop.set()
            thread.join(timeout=8)
            self.assertFalse(thread.is_alive())
        self.assertEqual(len(results), 1)
        self.assertIsInstance(results[0], InterruptedError)

    def test_prefix_feeding_does_not_copy_tail(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(pipeline, "_stop", threading.Event()):
            source = Path(d) / "source"
            output = Path(d) / "output"
            source.write_bytes(b"valid prefix damaged tail")
            pipeline._run([sys.executable, "-c", "import sys; from pathlib import Path; Path(sys.argv[1]).write_bytes(sys.stdin.buffer.read())", str(output)], input_path=source, input_limit=12)
            self.assertEqual(output.read_bytes(), b"valid prefix")
            self.assertEqual(source.read_bytes(), b"valid prefix damaged tail")


if __name__ == "__main__":
    unittest.main()
