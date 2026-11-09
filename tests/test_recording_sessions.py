import copy
import http.client
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from recording_sessions import RecordingSessions, timestamp
import server


class RecordingSessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.recordings = self.root / "recordings"
        self.recordings.mkdir()
        self.source = self.recordings / "first.flv"
        self.source.write_bytes(b"synthetic test source")
        self.start = timestamp("2026-11-09T10:00:00+08:00")
        self.clock = self.start + 7200
        self.room = {"id": "room1", "recording": True, "last_start_time_unix": self.start}
        self.entry = {"id": 1, "live_id": "room1", "host_name": "<script>account</script>",
                      "room_name": "synthetic", "start_time": "2026-11-09T10:00:00+08:00",
                      "end_time": "0001-01-01T00:00:00Z", "end_reason": "normal"}
        self.detail = {"live_id": "room1", "recording": True,
                       "recorder_status": {"file_path": str(self.source), "out_time_ms": "7200123456"}}
        self.requests = []
        self.observer = RecordingSessions(self.root, self.request, lambda: self.recordings, lambda: self.clock)

    def request(self, path):
        self.requests.append(path)
        if path == "/api/lives":
            return [self.room]
        if "/history?" in path:
            return {"events": [{"type": "session", "data": copy.deepcopy(self.entry)}]}
        if path == "/api/lives/room1":
            return copy.deepcopy(self.detail)
        raise AssertionError("Unexpected API: " + path)

    def current(self):
        return self.observer.snapshot()["sessions"][0]

    def test_open_history_default_normal_does_not_mean_ended_and_hours_are_not_ms(self):
        self.observer.observe()
        item = self.current()
        self.assertEqual(item["state"], "recording")
        self.assertIsNone(item["endReason"])
        self.assertIsNone(item["endedAt"])
        self.assertEqual(item["segments"][0]["mediaDurationMs"], 7200123)
        self.assertTrue(item["partialObservation"])
        self.assertEqual(item["segments"][0]["recordingPath"], "first.flv")
        self.assertNotIn(str(self.root), json.dumps(self.observer.snapshot()))
        self.assertFalse(any("startRecord" in p or "/stop" in p for p in self.requests))

    def test_same_file_updates_without_duplicates_and_persists_across_restart(self):
        self.observer.observe()
        self.source.write_bytes(b"growing recording " * 10)
        self.clock += 10
        self.observer = RecordingSessions(self.root, self.request, lambda: self.recordings, lambda: self.clock)
        self.observer.observe()
        item = self.current()
        self.assertEqual(len(item["segments"]), 1)
        self.assertEqual(item["segments"][0]["bytes"], self.source.stat().st_size)
        self.assertFalse(item["events"])

    def test_file_switch_preserves_identity_and_does_not_invent_network_cause(self):
        self.observer.observe()
        second = self.recordings / "second.flv"
        second.write_bytes(b"second")
        self.detail["recorder_status"].update(file_path=str(second), out_time_ms="2000000")
        self.clock += 10
        self.observer.observe()
        item = self.current()
        self.assertEqual([s["path"] for s in item["segments"]], ["first.flv", "second.flv"])
        self.assertEqual(item["segments"][0]["closeReason"], "file_changed_unknown")
        self.assertEqual(item["events"][0]["type"], "file_changed")
        self.assertEqual(item["segments"][1]["mediaDurationMs"], 2000)
        self.assertIsNone(item["endedAt"])

    def test_network_failure_and_missing_history_do_not_close_session(self):
        self.observer.observe()
        self.clock += 40
        self.observer.request = mock.Mock(side_effect=OSError("connection down"))
        with self.assertRaises(OSError):
            self.observer.observe()
        self.assertEqual(self.current()["state"], "unknown")
        self.assertIsNone(self.current()["endedAt"])
        self.observer.request = lambda path: [self.room] if path == "/api/lives" else {"events": []}
        self.observer.observe()
        self.assertEqual(self.current()["state"], "unknown")
        self.assertIsNone(self.current()["endedAt"])

    def test_unobserved_period_is_recorded_without_claiming_stream_loss(self):
        self.observer.observe()
        self.clock += 60
        self.observer.observe()
        events = self.current()["events"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "observation_gap")

    def test_only_authoritative_history_closes_session(self):
        self.observer.observe()
        self.room["recording"] = False
        self.clock += 10
        self.observer.observe()
        self.assertEqual(self.current()["state"], "waiting")
        self.entry.update(end_time="2026-11-09T12:00:10+08:00", end_reason="user_stop")
        self.observer.observe()
        self.assertEqual(self.current()["state"], "ended")
        self.assertEqual(self.current()["endReason"], "user_stop")
        self.assertEqual(self.current()["segments"][0]["closeReason"], "session_ended")

    def test_new_session_and_reused_history_id_are_not_merged(self):
        self.observer.observe()
        self.entry["start_time"] = "2026-11-09T12:00:00+08:00"
        self.room["last_start_time_unix"] = self.clock
        self.observer.observe()
        sessions = self.observer.snapshot()["sessions"]
        self.assertEqual(len(sessions), 2)
        self.assertNotEqual(sessions[0]["id"], sessions[1]["id"])

    def test_subsecond_history_matches_unix_seconds_without_guessing_two_sessions(self):
        self.entry["start_time"] = "2026-11-09T10:00:00.123456+08:00"
        self.observer.observe()
        self.assertEqual(len(self.current()["segments"]), 1)
        self.room["last_start_time_unix"] = float("inf")
        self.observer.observe()
        self.assertTrue(self.observer.error)

    def test_ambiguous_or_changed_identity_does_not_attribute_file(self):
        self.room["last_start_time_unix"] += 1
        self.observer.observe()
        self.assertFalse(self.current()["segments"])
        self.assertTrue(self.observer.error)
        self.room["last_start_time_unix"] -= 1
        self.detail["live_id"] = "other"
        self.observer.observe()
        self.assertFalse(self.current()["segments"])

    def test_external_and_symlink_paths_are_never_published(self):
        outside = self.root / "outside.flv"
        outside.write_bytes(b"unrelated")
        link = self.recordings / "link.flv"
        link.symlink_to(outside)
        for path in (outside, link):
            self.detail["recorder_status"]["file_path"] = str(path)
            self.observer.observe()
            self.assertFalse(self.current()["segments"])
            self.assertTrue(self.observer.error)

    def test_deleted_file_or_changed_root_removes_finder_action_only(self):
        self.observer.observe()
        self.source.unlink()
        item = self.current()
        self.assertEqual(item["segments"][0]["mediaDurationMs"], 7200123)
        self.assertIsNone(item["segments"][0]["recordingPath"])
        self.source.write_bytes(b"replacement")
        self.observer.recording_root = lambda: self.root / "other-recordings"
        self.assertIsNone(self.current()["segments"][0]["recordingPath"])

    def test_corrupt_journal_is_preserved_and_errors_are_visible(self):
        self.observer.file.parent.mkdir()
        self.observer.file.write_text('{"version":1,"sessions":[{}]}')
        before = self.observer.file.read_bytes()
        with self.assertRaises(ValueError):
            self.observer.observe()
        self.assertEqual(self.observer.file.read_bytes(), before)
        self.assertTrue(self.observer.snapshot()["error"])

    def test_oversized_room_list_is_not_treated_as_complete(self):
        self.observer.request = lambda path: [self.room] * 101
        with self.assertRaisesRegex(ValueError, "100"):
            self.observer.observe()
        self.assertFalse(self.observer.file.exists())


class RecordingSessionHTTPTests(unittest.TestCase):
    def test_local_only_read_endpoint_and_static_ui(self):
        http_server = server.LocalHTTPServer(("127.0.0.1", 0), server.Handler)
        port = http_server.server_address[1]
        thread = threading.Thread(target=http_server.serve_forever, daemon=True)
        thread.start()
        try:
            with mock.patch.object(server, "PORT", port), mock.patch.object(server, "RECORDING_SESSIONS") as observer:
                observer.snapshot.return_value = {"sessions": [], "error": None}
                for headers, expected in [({}, 200), ({"Host": "attacker.example"}, 403),
                                          ({"Origin": "https://attacker.example"}, 403)]:
                    client = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                    client.request("GET", "/api/recording-sessions", headers=headers)
                    response = client.getresponse()
                    self.assertEqual(response.status, expected)
                    response.read()
                    client.close()
                self.assertEqual(observer.snapshot.call_count, 1)
                client = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                client.request("GET", "/recording-sessions-ui.js")
                response = client.getresponse()
                self.assertEqual(response.status, 200)
                self.assertIn(b"/api/recording-sessions", response.read())
                client.close()
        finally:
            http_server.shutdown()
            http_server.server_close()
            thread.join()

    def test_archive_endpoint_is_local_only_and_passes_session_id(self):
        http_server = server.LocalHTTPServer(("127.0.0.1", 0), server.Handler)
        port = http_server.server_address[1]
        thread = threading.Thread(target=http_server.serve_forever, daemon=True)
        thread.start()
        try:
            with mock.patch.object(server, "PORT", port), mock.patch.object(server, "RECORDING_ARCHIVES") as archives:
                archives.snapshot.return_value = {"archives": [], "error": None}
                archives.create.return_value = {"status": "completed", "sessionId": "a" * 32}
                client = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                client.request("GET", "/api/recording-archives")
                response = client.getresponse()
                self.assertEqual(response.status, 200)
                response.read()
                client.close()

                client = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                client.request("POST", "/api/recording-sessions/archive", json.dumps({"sessionId": "a" * 32}),
                               {"Content-Type": "application/json"})
                response = client.getresponse()
                self.assertEqual(response.status, 200)
                response.read()
                client.close()
                archives.create.assert_called_once_with("a" * 32)

                client = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                client.request("POST", "/api/recording-sessions/archive", json.dumps({"sessionId": "a" * 32}),
                               {"Content-Type": "application/json", "Host": "attacker.example"})
                self.assertEqual(client.getresponse().status, 403)
                client.close()
        finally:
            http_server.shutdown()
            http_server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
