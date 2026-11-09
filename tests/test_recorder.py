import io
import json
import sys
import tarfile
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from recorder_service import RecorderError, RecorderManager


class RecorderTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.manager = RecorderManager(self.root)
        self.manager.plugin.mkdir(parents=True)
        self.manager.binary.touch()
        self.ffmpeg = Path(self.manager.desired_config()["ffmpeg_path"])
        self.ffmpeg.parent.mkdir(parents=True)
        self.ffmpeg.touch()
        template = b"""rpc:
  enable: false
  bind: :8080
video_split_strategies:
  max_duration: 0s
  max_file_size: '0'
on_record_finished:
  convert_to_mp4: false
ffmpeg_path: ''
out_put_path: ./
live_rooms: []
special_template_default:
  nested: keep-me
"""
        with tarfile.open(self.manager.archive, "w:gz") as archive:
            member = tarfile.TarInfo("config.yml")
            member.size = len(template)
            archive.addfile(member, io.BytesIO(template))
        self.live = False
        self.rooms = []
        self.identity = ("Fri Nov 6 08:00:00 2026 " + str(self.manager.binary)
                         + " --no-launcher --config=" + str(self.manager.runtime_file))
        self.probe = self.stack.enter_context(mock.patch.object(self.manager, "_probe", side_effect=self.fake_probe))
        self.stack.enter_context(mock.patch.object(self.manager, "_port_busy", return_value=False))
        self.stack.enter_context(mock.patch.object(self.manager, "_identity", side_effect=lambda pid: self.identity if pid == 12345 and self.live else None))
        self.child = mock.Mock(pid=12345)
        self.child.poll.side_effect = lambda: None if self.live else 0
        self.popen = self.stack.enter_context(mock.patch("recorder_service.subprocess.Popen", side_effect=self.spawn))
        self.kill = self.stack.enter_context(mock.patch("recorder_service.os.kill", side_effect=self.terminate))

    def fake_probe(self):
        if not self.live:
            raise OSError("offline")
        return {"app_version": "v0.8.3"}, list(self.rooms)

    def spawn(self, *args, **kwargs):
        self.live = True
        self.rooms = [{"live_url": room["url"], "listening": room["is_listening"], "recording": False,
                       "scheme": room.get("scheme", "")} for room in self.runtime_value("live_rooms")]
        return self.child

    def terminate(self, pid, sig):
        self.assertEqual(pid, 12345)
        self.live = False

    def runtime_value(self, key):
        for line in self.manager.runtime_file.read_text().splitlines():
            if line.startswith(key + ": "):
                return json.loads(line.split(": ", 1)[1])
        self.fail("Missing runtime key " + key)

    def save_accounts(self, *urls):
        self.manager._write(self.root / "accounts.json", [{"roomUrl": url} for url in urls])

    def test_simultaneous_connects_spawn_exactly_one_process(self):
        gate = threading.Barrier(6)

        def connect():
            gate.wait(timeout=5)
            return self.manager.start()

        with ThreadPoolExecutor(max_workers=6) as pool:
            states = list(pool.map(lambda _: connect(), range(6)))
        self.assertEqual(self.popen.call_count, 1)
        self.assertTrue(all(state["connected"] and state["managed"] for state in states))
        self.assertEqual(self.manager.start()["pid"], 12345)
        self.assertEqual(self.popen.call_count, 1)

    def test_first_connection_imports_accounts_and_saved_config_paused(self):
        self.save_accounts("https://live.douyin.com/123/", "https://v.douyin.com/abc/")
        self.manager.save_desired({"live_rooms": [{"url": "https://live.douyin.com/456", "is_listening": True}]})
        state = self.manager.start()
        self.assertEqual(state["roomCount"], 3)
        self.assertEqual(state["listeningCount"], 0)
        self.assertEqual(state["recordingCount"], 0)
        self.assertTrue(all(not room["is_listening"] for room in self.runtime_value("live_rooms")))

    def test_restart_preserves_monitoring_and_room_removal(self):
        self.save_accounts("https://live.douyin.com/123", "https://live.douyin.com/456")
        self.manager.start()
        self.rooms = [{"live_url": "https://live.douyin.com/123", "listening": True, "recording": False, "scheme": "archive"}]
        self.save_accounts("https://live.douyin.com/123", "https://live.douyin.com/789")
        # Updating unrelated settings with an old room snapshot must not restore
        # deleted rooms or overwrite the monitoring choice from the live API.
        self.manager.save_desired({"interval": 25, "live_rooms": [{"url": "https://live.douyin.com/456", "is_listening": True}]})
        self.manager.restart()
        rooms = {room["url"]: room for room in self.runtime_value("live_rooms")}
        self.assertEqual(set(rooms), {"https://live.douyin.com/123", "https://live.douyin.com/789"})
        self.assertTrue(rooms["https://live.douyin.com/123"]["is_listening"])
        self.assertEqual(rooms["https://live.douyin.com/123"]["scheme"], "archive")
        self.assertFalse(rooms["https://live.douyin.com/789"]["is_listening"])

    def test_active_recording_blocks_stop_and_restart_without_signalling(self):
        self.manager.start()
        self.rooms = [{"live_url": "https://live.douyin.com/123", "listening": True, "recording": True}]
        self.assertFalse(self.manager.state()["canRestart"])
        for action in (self.manager.stop, self.manager.restart):
            with self.assertRaises(RecorderError) as raised:
                action()
            self.assertEqual(raised.exception.status, 409)
        self.kill.assert_not_called()
        self.assertEqual(self.popen.call_count, 1)

    def test_foreign_recorder_connects_but_cannot_be_stopped_or_restarted(self):
        self.live = True
        state = self.manager.start()
        self.assertTrue(state["connected"])
        self.assertFalse(state["managed"])
        self.popen.assert_not_called()
        for action in (self.manager.stop, self.manager.restart):
            with self.assertRaisesRegex(RecorderError, "其他程序"):
                action()
        self.kill.assert_not_called()

    def test_reused_pid_does_not_establish_ownership(self):
        self.live = True
        self.manager._write(self.manager.owner_file, {"pid": 12345, "identity": "different process identity"})
        self.assertFalse(self.manager.state()["managed"])
        with self.assertRaises(RecorderError):
            self.manager.stop()
        self.kill.assert_not_called()

    def test_disconnected_owned_process_is_not_stopped_blindly(self):
        self.manager.start()
        self.probe.side_effect = OSError("API unavailable")
        with self.assertRaisesRegex(RecorderError, "无法确认录制状态"):
            self.manager.stop()
        self.kill.assert_not_called()

    def test_template_defaults_duration_and_ffmpeg_fallback(self):
        self.manager.save_desired({"ffmpeg_path": "", "video_split_strategies": {"max_duration": 60000000000}})
        self.manager._write_runtime()
        runtime = self.manager.runtime_file.read_text()
        self.assertIn("special_template_default:\n  nested: keep-me", runtime)
        self.assertEqual(self.runtime_value("video_split_strategies")["max_duration"], "60000000000ns")
        self.assertEqual(self.manager.desired_config()["video_split_strategies"]["max_duration"], 60000000000)
        self.assertEqual(self.runtime_value("ffmpeg_path"), str(self.ffmpeg))
        self.assertEqual(self.runtime_value("rpc")["bind"], "127.0.0.1:18080")
        self.assertFalse(self.runtime_value("update")["auto_check"])
        self.assertFalse(self.runtime_value("on_record_finished")["delete_flv_after_convert"])

    def test_invalid_duration_does_not_start_a_process(self):
        self.manager.save_desired({"video_split_strategies": {"max_duration": -1}})
        with self.assertRaises(RecorderError) as raised:
            self.manager.start()
        self.assertEqual(raised.exception.status, 400)
        self.popen.assert_not_called()

    def test_non_loopback_and_credential_urls_rejected(self):
        for url in ("http://example.com:18080", "http://user:secret@127.0.0.1:18080", "https://127.0.0.1:18080", "http://127.0.0.1:18080/path"):
            with self.assertRaises(ValueError):
                RecorderManager(self.root, url)


if __name__ == "__main__":
    unittest.main()
