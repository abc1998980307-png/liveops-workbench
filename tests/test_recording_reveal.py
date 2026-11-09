import http.client
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class RecordingRevealTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = server.LocalHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.http.server_address[1]
        cls.old_port = server.PORT
        server.PORT = cls.port
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()
        server.PORT = cls.old_port

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "录屏目录"
        self.root.mkdir()
        self.video = self.root / "主播 名称" / "2026-11-09 直播.mp4"
        self.video.parent.mkdir()
        self.video.write_bytes(b"video")
        self.recording_root = mock.patch.object(server, "recording_directory", return_value=self.root)
        self.recording_root.start()
        self.addCleanup(self.recording_root.stop)
        self.open_file = mock.patch.object(server.subprocess, "run")
        self.open_file.start()
        self.addCleanup(self.open_file.stop)

    def request(self, method, route, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(method, route, body=body, headers=headers or {})
        response = connection.getresponse()
        data = response.read()
        connection.close()
        return response.status, data

    def post(self, path, headers=None):
        return self.request(
            "POST",
            "/api/recordings/reveal",
            json.dumps({"path": path}, ensure_ascii=False).encode("utf-8"),
            {"Content-Type": "application/json", **(headers or {})},
        )

    def test_recording_list_hides_unpublished_archive_directory(self):
        directory = self.root / ".liveops-archives" / ".pending.tmp"
        directory.mkdir(parents=True)
        (directory / "video.mp4").write_bytes(b"unpublished")
        published = self.root / ".liveops-archives" / "completed"
        published.mkdir()
        (published / "video.mp4").write_bytes(b"published")
        paths = [item["path"] for item in server.recording_files()]
        self.assertNotIn(".liveops-archives/.pending.tmp/video.mp4", paths)
        self.assertIn(".liveops-archives/completed/video.mp4", paths)

    def test_reveals_existing_unicode_file_inside_recording_directory(self):
        server.reveal_recording("主播 名称/2026-11-09 直播.mp4")

        server.subprocess.run.assert_called_once_with(
            ["/usr/bin/open", "-R", str(self.video.resolve())], check=True, timeout=10,
        )

    def test_rejects_paths_outside_recording_directory(self):
        outside = Path(self.directory.name) / "outside.mp4"
        outside.write_bytes(b"outside")
        link = self.root / "outside-link.mp4"
        link.symlink_to(outside)

        for relative in ("../outside.mp4", str(outside), "outside-link.mp4"):
            with self.subTest(path=relative), self.assertRaises((ValueError, PermissionError)):
                server.reveal_recording(relative)
        server.subprocess.run.assert_not_called()

    def test_rejects_missing_files_and_directories(self):
        with self.assertRaises(FileNotFoundError):
            server.reveal_recording("missing.mp4")
        with self.assertRaises((ValueError, IsADirectoryError)):
            server.reveal_recording("主播 名称")
        server.subprocess.run.assert_not_called()

    def test_http_route_reveals_file_and_returns_success(self):
        status, data = self.post("主播 名称/2026-11-09 直播.mp4")

        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data), {"ok": True})
        server.subprocess.run.assert_called_once()

    def test_http_route_rejects_traversal_and_missing_file(self):
        status, _ = self.post("../outside.mp4")
        self.assertIn(status, (400, 403))
        status, _ = self.post("missing.mp4")
        self.assertEqual(status, 404)
        server.subprocess.run.assert_not_called()

    def test_http_route_is_local_only_and_requires_json_object(self):
        for headers in (
            {"Origin": "https://attacker.example"},
            {"Host": "attacker.example"},
        ):
            with self.subTest(headers=headers):
                self.assertEqual(self.post("主播 名称/2026-11-09 直播.mp4", headers)[0], 403)

        status, _ = self.request(
            "POST", "/api/recordings/reveal", b"[]", {"Content-Type": "application/json"},
        )
        self.assertEqual(status, 400)
        status, _ = self.request(
            "POST", "/api/recordings/reveal", b"{}", {"Content-Type": "text/plain"},
        )
        self.assertEqual(status, 415)
        server.subprocess.run.assert_not_called()

    def test_system_open_failure_is_reported_as_server_error(self):
        server.subprocess.run.side_effect = OSError("Finder unavailable")

        status, _ = self.post("主播 名称/2026-11-09 直播.mp4")

        self.assertEqual(status, 500)
        server.subprocess.run.assert_called_once()

    def test_opens_current_recording_directory_in_finder(self):
        server.open_recording_directory()

        server.subprocess.run.assert_called_once_with(
            ["/usr/bin/open", str(self.root.resolve())], check=True, timeout=10,
        )

    def test_directory_route_opens_configured_recording_directory(self):
        status, data = self.request(
            "POST",
            "/api/recordings/open-directory",
            b"{}",
            {"Content-Type": "application/json"},
        )

        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data), {"ok": True})
        server.subprocess.run.assert_called_once_with(
            ["/usr/bin/open", str(self.root.resolve())], check=True, timeout=10,
        )


if __name__ == "__main__":
    unittest.main()
