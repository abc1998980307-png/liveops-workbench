import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hot_insights import HotInsights, HotInsightsError, MAX_SNAPSHOTS


class HotInsightsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.now = datetime(2026, 11, 12, 10, tzinfo=timezone.utc)
        self.insights = HotInsights(self.temporary.name, now=lambda: self.now)

    def fixture(self, title="合成话题", hot=120, updated="2026-11-12T10:00:00Z"):
        return {"code": 200, "name": "douyin", "updateTime": updated,
                "data": [{"title": title, "hot": hot, "timestamp": updated}]}

    def test_watch_refresh_trend_and_first_observation_survive_restart(self):
        self.insights.watch("合成")
        first = self.insights.refresh(lambda limit: self.fixture())
        self.assertEqual(first["terms"][0]["currentHot"], 120)
        self.assertEqual(first["terms"][0]["firstSeenAt"], "2026-11-12T10:00:00+00:00")
        self.now += timedelta(hours=1)
        second = self.insights.refresh(lambda limit: self.fixture("别的话题", 80, "2026-11-12T11:00:00Z"))
        self.assertIsNone(second["terms"][0]["currentHot"])
        self.assertEqual([row["hot"] for row in second["terms"][0]["trend"]], [120, None])
        self.assertEqual(second["terms"][0]["lastSeenAt"], first["terms"][0]["lastSeenAt"])
        reopened = HotInsights(self.temporary.name).snapshot()
        self.assertEqual(reopened["sampleCount"], 2)
        self.assertEqual(reopened["latest"]["items"][0]["title"], "别的话题")

    def test_same_upstream_update_replaces_sample_and_bounds_history(self):
        self.insights.watch("合成")
        for index in range(MAX_SNAPSHOTS + 4):
            self.now += timedelta(minutes=1)
            self.insights.refresh(lambda limit, index=index: self.fixture(hot=index, updated=f"2026-11-12T10:{index:02d}:00Z"))
        self.assertEqual(self.insights.snapshot()["sampleCount"], MAX_SNAPSHOTS)
        self.insights.refresh(lambda limit: self.fixture(hot=999, updated=f"2026-11-12T10:{MAX_SNAPSHOTS + 3:02d}:00Z"))
        self.assertEqual(self.insights.snapshot()["sampleCount"], MAX_SNAPSHOTS)
        self.assertEqual(self.insights.snapshot()["terms"][0]["currentHot"], 999)

    def test_correlation_requires_observation_within_session(self):
        self.insights.watch("合成")
        self.insights.refresh(lambda limit: self.fixture())
        rows = [
            {"title": "合成选题专场", "startedAt": "2026-11-12T09:00:00Z", "endedAt": "2026-11-12T11:00:00Z"},
            {"title": "其他场次", "reviewActions": "跟进合成话题", "startedAt": "2026-11-12T12:00:00Z", "endedAt": "2026-11-12T13:00:00Z"},
            {"title": "没有关联", "startedAt": "2026-11-12T12:00:00Z", "endedAt": "2026-11-12T13:00:00Z"},
        ]
        linked = self.insights.snapshot(rows)["sessions"]
        self.assertEqual(len(linked), 2)
        self.assertEqual(linked[0]["matches"][0]["matchedIn"], ["title"])
        self.assertEqual(linked[0]["matches"][0]["hotDuringSession"][0]["hot"], 120)
        self.assertEqual(linked[1]["matches"][0]["matchedIn"], ["review"])
        self.assertEqual(linked[1]["matches"][0]["hotDuringSession"], [])

    def test_invalid_upstream_does_not_overwrite_and_corrupt_file_is_preserved(self):
        self.insights.watch("合成")
        original = self.insights.file.read_bytes()
        with self.assertRaises(HotInsightsError):
            self.insights.refresh(lambda limit: self.fixture(hot=float("nan")))
        self.assertEqual(self.insights.file.read_bytes(), original)
        self.insights.file.write_text('{"version": 9}', encoding="utf-8")
        with self.assertRaises(HotInsightsError):
            self.insights.watch("新词")
        self.assertEqual(json.loads(self.insights.file.read_text())["version"], 9)

    def test_watch_deduplicates_and_unwatch_removes(self):
        self.insights.watch(" 合成 ")
        self.insights.watch("合成")
        self.assertEqual(len(self.insights.snapshot()["terms"]), 1)
        self.assertEqual(self.insights.unwatch("合成")["terms"], [])
        for invalid in ("", "a" * 41, "bad\nword", 1):
            with self.assertRaises(HotInsightsError):
                self.insights.watch(invalid)


if __name__ == "__main__":
    unittest.main()
