import os
import http.client
import json
import sys
import tempfile
import threading
import urllib.parse
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class SessionSearchTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory())).resolve()
        self.transcripts = self.root / "transcripts"
        self.recordings = self.root / "recordings"
        self.transcripts.mkdir()
        self.recordings.mkdir()
        self.stack.enter_context(mock.patch.object(server, "TRANSCRIPTS", self.transcripts))
        self.stack.enter_context(mock.patch.object(server, "recording_directory", return_value=self.recordings))

    @staticmethod
    def cue(text="目标词", start="00:00:01,250", end="00:00:02,500"):
        return f"1\n{start} --> {end}\n{text}\n\n"

    def subtitle(self, relative="主播/场次.srt", content=None, modified=None):
        path = self.transcripts / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.cue() if content is None else content, encoding="utf-8")
        if modified is not None:
            os.utime(path, (modified, modified))
        return path

    def video(self, relative):
        path = self.recordings / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"synthetic video; search only needs file identity")
        return path

    def test_searches_caption_text_case_insensitively_and_normalizes_line_endings(self):
        content = "\ufeff" + self.cue("Learn ENGLISH\n学习方法").replace("\n", "\r\n")
        self.subtitle(content=content)
        result = server.search_subtitles(" english ")
        self.assertEqual(result["query"], "english")
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["results"][0]["text"], "Learn ENGLISH 学习方法")
        self.assertEqual(result["results"][0]["account"], "主播")
        self.assertEqual(result["filesScanned"], 1)
        self.assertFalse(result["truncated"])
        self.assertEqual(server.search_subtitles("学习方法")["count"], 1)
        self.assertEqual(server.search_subtitles("场次")["count"], 0)

    def test_hour_long_offsets_and_both_fraction_separators(self):
        self.subtitle(content=self.cue(start="01:02:03,456", end="01:02:04,000")
                      + self.cue(start="123:45:06.7", end="123:45:07.001"))
        results = server.search_subtitles("目标词")["results"]
        self.assertEqual([row["seconds"] for row in results], [3723.456, 445506.7])
        self.assertEqual(results[1]["timestamp"], "123:45:06,7")

    def test_invalid_start_minute_or_second_is_skipped(self):
        self.subtitle(content=self.cue(start="00:60:00,000")
                      + self.cue(start="00:00:60,000") + self.cue())
        result = server.search_subtitles("目标词")
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["results"][0]["seconds"], 1.25)

    def test_invalid_or_reversed_end_timestamp_is_skipped(self):
        self.subtitle(content=self.cue(end="00:60:00,000")
                      + self.cue(end="00:00:60,000")
                      + self.cue(start="00:00:03,000", end="00:00:02,000")
                      + self.cue())
        self.assertEqual(server.search_subtitles("目标词")["count"], 1)

    def test_malformed_blocks_and_empty_captions_are_skipped(self):
        content = ("目标词\n\n1\nnot a timestamp\n目标词\n\n"
                   "2\n00:00:01,000 --> nope\n目标词\n\n"
                   "3\n00:00:01,000 --> 00:00:02,000\n\n")
        self.subtitle(content=content + self.cue())
        self.assertEqual(server.search_subtitles("目标词")["count"], 1)

    def test_compressed_video_takes_precedence_over_original(self):
        self.subtitle()
        self.video("抖音/主播/场次.mp4")
        relative = "抖音/主播/场次.flv.compressed.mp4"
        self.video(relative)
        result = server.search_subtitles("目标词")["results"][0]
        self.assertEqual(result["recordingPath"], relative)
        self.assertNotIn("videoUrl", result)

    def test_uuid_suffixed_compressed_video_is_associated(self):
        self.subtitle()
        relative = "抖音/主播/场次.flv." + "a1" * 16 + ".compressed.mp4"
        self.video(relative)
        self.assertEqual(server.search_subtitles("目标词")["results"][0]["recordingPath"], relative)

    def test_identically_named_sessions_do_not_cross_accounts(self):
        for account in ("账号甲", "账号乙"):
            self.subtitle(f"{account}/同名场次.srt")
            self.video(f"抖音/{account}/同名场次.flv.compressed.mp4")
        result = server.search_subtitles("目标词")
        self.assertEqual(result["count"], 2)
        for row in result["results"]:
            self.assertEqual(row["recordingPath"], f"抖音/{row['account']}/同名场次.flv.compressed.mp4")

    def test_transcript_without_video_still_returns_match(self):
        self.subtitle()
        self.assertIsNone(server.search_subtitles("目标词")["results"][0]["recordingPath"])

    def test_result_limit_truncates_and_reports_incomplete_results(self):
        self.subtitle(content=self.cue() * 4)
        for requested, expected in ((2, 2), (0, 1), (-3, 1)):
            with self.subTest(limit=requested):
                result = server.search_subtitles("目标词", limit=requested)
                self.assertEqual(result["count"], expected)
                self.assertEqual(len(result["results"]), expected)
                self.assertTrue(result["truncated"])
        with mock.patch.object(server, "SESSION_SEARCH_MAX_RESULTS", 2):
            self.assertEqual(server.search_subtitles("目标词", limit=999)["count"], 2)
        self.assertFalse(server.search_subtitles("目标词", limit=4)["truncated"])

    def test_file_scan_limit_is_not_exceeded(self):
        for i in range(3):
            self.subtitle(f"主播/{i}.srt", modified=100 + i)
        with mock.patch.object(server, "SESSION_SEARCH_MAX_FILES", 1):
            result = server.search_subtitles("目标词")
        self.assertLessEqual(result["filesScanned"], 1)
        self.assertLessEqual(result["count"], 1)
        self.assertTrue(result["truncated"])

    def test_oversized_files_are_skipped_and_byte_budget_is_enforced(self):
        small = self.subtitle("主播/小.srt", modified=100)
        self.subtitle("主播/大.srt", content=self.cue() * 10, modified=200)
        with mock.patch.object(server, "SESSION_SEARCH_MAX_FILE_BYTES", small.stat().st_size):
            result = server.search_subtitles("目标词")
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["filesScanned"], 1)
        self.assertTrue(result["truncated"])
        self.subtitle("主播/更新.srt", modified=300)
        with mock.patch.object(server, "SESSION_SEARCH_MAX_BYTES", small.stat().st_size):
            result = server.search_subtitles("目标词")
        self.assertEqual(result["filesScanned"], 1)
        self.assertEqual(result["results"][0]["file"], "更新")
        self.assertLessEqual(result["bytesScanned"], small.stat().st_size)
        self.assertTrue(result["truncated"])

    def test_external_and_symlinked_subtitles_are_not_read(self):
        outside = self.root / "outside.srt"
        outside.write_text(self.cue(), encoding="utf-8")
        (self.transcripts / "link.srt").symlink_to(outside)
        inside = self.subtitle(content=self.cue("其他内容"))
        (self.transcripts / "internal-link.srt").symlink_to(inside)
        self.assertEqual(server.search_subtitles("目标词")["count"], 0)
        # A discovered path can race with directory replacement; containment is
        # checked after resolving it, even if discovery yields an outside file.
        with mock.patch.object(Path, "rglob", return_value=iter([outside])):
            with mock.patch.object(server, "recording_files", return_value=[]):
                self.assertEqual(server.search_subtitles("目标词")["filesScanned"], 0)

    def test_external_and_symlinked_recordings_cannot_be_associated(self):
        self.subtitle()
        outside = self.root / "主播" / "场次.mp4"
        outside.parent.mkdir()
        outside.write_bytes(b"outside")
        link = self.recordings / "主播" / "场次.mp4"
        link.parent.mkdir()
        link.symlink_to(outside)
        self.assertIsNone(server.search_subtitles("目标词")["results"][0]["recordingPath"])
        for relative in (str(outside), "../主播/场次.mp4"):
            with self.subTest(path=relative), mock.patch.object(
                    server, "recording_files", return_value=[{"path": relative}]):
                self.assertIsNone(server.search_subtitles("目标词")["results"][0]["recordingPath"])

    def test_query_validation_and_no_match(self):
        for query in (None, 123, "", " \n\t", "字" * 101):
            with self.subTest(query=query), self.assertRaises(ValueError):
                server.search_subtitles(query)
        result = server.search_subtitles("字" * 100)
        self.assertEqual(result["results"], [])
        self.assertEqual(result["count"], 0)
        self.assertEqual(result["filesScanned"], 0)
        self.assertFalse(result["truncated"])
        with self.assertRaises(ValueError):
            server.search_subtitles("有效词", limit="invalid")

    def test_original_flv_and_legacy_compressed_names_remain_locatable(self):
        self.subtitle("主播/场次.标题.srt")
        self.video("抖音/主播/场次.标题.flv")
        row = server.search_subtitles("目标词")["results"][0]
        self.assertEqual(row["recordingPath"], "抖音/主播/场次.标题.flv")
        self.video("抖音/主播/场次.标题.compressed.mp4")
        row = server.search_subtitles("目标词")["results"][0]
        self.assertEqual(row["recordingPath"], "抖音/主播/场次.标题.compressed.mp4")

    def test_ambiguous_cross_platform_names_do_not_select_wrong_recording(self):
        self.subtitle()
        self.video("抖音/主播/场次.flv")
        self.video("其他平台/主播/场次.flv")
        self.assertIsNone(server.search_subtitles("目标词")["results"][0]["recordingPath"])

    def test_long_caption_excerpt_includes_match_and_unicode_folding(self):
        self.subtitle(content=self.cue("前文" * 200 + "Straße 目标词" + "后文" * 200))
        row = server.search_subtitles("目标词")["results"][0]
        self.assertIn("目标词", row["text"])
        self.assertLessEqual(len(row["text"]), 242)
        self.assertIn("Straße", server.search_subtitles("STRASSE")["results"][0]["text"])

    def test_file_growing_after_stat_cannot_exceed_read_budget(self):
        path = self.subtitle()
        original_open = Path.open
        def grow_on_read(candidate, *args, **kwargs):
            if candidate == path and args and args[0] == "rb":
                with original_open(path, "ab") as handle:
                    handle.write(b"growth" * 100)
            return original_open(candidate, *args, **kwargs)
        with mock.patch.object(server, "SESSION_SEARCH_MAX_FILE_BYTES", path.stat().st_size):
            with mock.patch.object(Path, "open", grow_on_read):
                result = server.search_subtitles("目标词")
        self.assertEqual(result["count"], 0)
        self.assertEqual(result["filesScanned"], 0)
        self.assertTrue(result["truncated"])

    def test_http_search_and_subtitle_source_validate_requests(self):
        self.subtitle()
        http_server = server.LocalHTTPServer(("127.0.0.1", 0), server.Handler)
        worker = threading.Thread(target=http_server.serve_forever, daemon=True)
        worker.start()
        def request(route, headers=None):
            conn = http.client.HTTPConnection("127.0.0.1", http_server.server_port, timeout=5)
            try:
                conn.request("GET", route, headers=headers or {})
                response = conn.getresponse()
                return response.status, response.read()
            finally:
                conn.close()
        try:
            with mock.patch.object(server, "PORT", http_server.server_port):
                route = "/api/session-search?q=" + urllib.parse.quote("目标词")
                status, raw = request(route)
                self.assertEqual(status, 200)
                data = json.loads(raw)
                self.assertEqual(data["count"], 1)
                status, subtitle = request(data["results"][0]["subtitleUrl"])
                self.assertEqual(status, 200)
                self.assertIn("目标词", subtitle.decode())
                self.assertEqual(request("/api/session-search?q=")[0], 400)
                self.assertEqual(request(route + "&limit=abc")[0], 400)
                self.assertEqual(request(route, {"Host": "attacker.example"})[0], 403)
                self.assertEqual(request(route, {"Origin": "https://attacker.example"})[0], 403)
        finally:
            http_server.shutdown()
            http_server.server_close()
            worker.join()


if __name__ == "__main__":
    unittest.main()
