import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from comment_monitor import (CommentBatch, CommentEvent, CommentMonitor, CommentStore,
                             SourceAuthRequired, SourceDisconnected, SourceRateLimited)


START = "2026-01-01T10:00:00+08:00"
END = "2026-01-01T11:00:00+08:00"
SESSION = "a" * 32


class Sessions:
    def __init__(self):
        self.items = [{"id": SESSION, "startedAt": START, "endedAt": END}]

    def _read(self):
        return {"sessions": self.items}


class Links:
    def list(self):
        return {"links": [{"recordingSessionId": SESSION, "accountUid": "synthetic-account",
                           "roomId": "synthetic-room", "roomStartedAt": "2026-01-01T10:05:00+08:00"}]}


class Adapter:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.cursors = []

    def read(self, cursor):
        self.cursors.append(cursor)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def event(key, at="2026-01-01T10:15:00+08:00", account="synthetic-account", room="synthetic-room"):
    return CommentEvent(key, at, account, room)


class CommentMonitorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = CommentStore(self.temp.name)
        self.sessions = Sessions()
        self.clock = [1000.0]

    def monitor(self, adapter):
        return CommentMonitor("synthetic", adapter, self.store, self.sessions, Links(), now=lambda: self.clock[0])

    def test_dedup_cursor_and_time_window_survive_reopen(self):
        adapter = Adapter(CommentBatch((event("one"), event("two", "2026-01-01T10:45:00+08:00")), "page-a"),
                          CommentBatch((event("one"), event("three", "2026-01-01T10:50:00+08:00")), "page-b"))
        monitor = self.monitor(adapter)
        self.assertEqual(monitor.poll_once(), {"status": "ready", "added": 2})
        self.assertEqual(monitor.poll_once(), {"status": "ready", "added": 1})
        self.assertEqual(adapter.cursors, ["", "page-a"])
        reopened = CommentStore(self.temp.name)
        self.assertEqual(reopened.cursor("synthetic"), "page-b")
        self.assertEqual(reopened.summary("synthetic", SESSION), 3)
        self.assertEqual(reopened.summary("synthetic", SESSION, START, "2026-01-01T10:30:00+08:00"), 1)
        with sqlite3.connect(reopened.path) as db:
            rows = db.execute("SELECT event_hash, occurred_at FROM events").fetchall()
        self.assertTrue(all(len(row[0]) == 64 and row[0] not in ("one", "two", "three") for row in rows))

    def test_mismatched_unlinked_ambiguous_and_outside_events_do_not_advance_cursor(self):
        bad = [event("wrong-room", room="other-synthetic-room"),
               event("outside", at=END), event("before-business", at=START),
               event("wrong-account", account="other-synthetic-account")]
        for item in bad:
            with self.subTest(item=item.event_id):
                monitor = self.monitor(Adapter(CommentBatch((item,), "unsafe")))
                self.assertEqual(monitor.poll_once()["status"], "error")
                self.assertEqual(self.store.cursor("synthetic"), "")
        self.sessions.items.append({"id": "b" * 32, "startedAt": START, "endedAt": END})
        class AmbiguousLinks(Links):
            def list(self):
                links = super().list()["links"]
                return {"links": links + [{**links[0], "recordingSessionId": "b" * 32}]}
        monitor = CommentMonitor("synthetic", Adapter(CommentBatch((event("ambiguous"),), "unsafe")),
                                 self.store, self.sessions, AmbiguousLinks(), now=lambda: self.clock[0])
        self.assertEqual(monitor.poll_once()["status"], "error")
        self.assertEqual(self.store.summary("synthetic", SESSION), 0)

    def test_whole_batch_rolls_back_and_replays_after_repair(self):
        bad = CommentBatch((event("valid"), event("invalid", at="not-a-time")), "bad-cursor")
        good = CommentBatch((event("valid"),), "good-cursor")
        adapter = Adapter(bad, good)
        monitor = self.monitor(adapter)
        self.assertEqual(monitor.poll_once()["status"], "error")
        self.assertEqual(self.store.summary("synthetic", SESSION), 0)
        self.assertEqual(self.store.cursor("synthetic"), "")
        self.clock[0] += 2
        self.assertEqual(monitor.poll_once(), {"status": "ready", "added": 1})
        self.assertEqual(adapter.cursors, ["", ""])

    def test_disconnect_rate_limit_and_auth_have_distinct_retry_states(self):
        adapter = Adapter(SourceDisconnected(), SourceRateLimited(),
                          CommentBatch((event("replayed"),), "resume"), SourceAuthRequired())
        monitor = self.monitor(adapter)
        self.assertEqual(monitor.poll_once()["status"], "interrupted")
        self.assertEqual(monitor.state()["retryAt"], 1002.0)
        self.assertEqual(monitor.poll_once()["status"], "interrupted")
        self.assertEqual(len(adapter.cursors), 1)
        self.clock[0] += 2
        self.assertEqual(monitor.poll_once()["status"], "rate_limited")
        self.assertEqual(monitor.state()["retryAt"], 1006.0)
        self.clock[0] += 4
        self.assertEqual(monitor.poll_once(), {"status": "ready", "added": 1})
        self.assertEqual(adapter.cursors, ["", "", ""])
        self.assertEqual(monitor.poll_once()["status"], "auth_required")
        self.assertEqual(monitor.poll_once()["status"], "auth_required")
        self.assertEqual(adapter.cursors[-1], "resume")
        self.assertEqual(len(adapter.cursors), 4)
        self.assertTrue(monitor.state()["collected"])

    def test_untyped_adapter_failure_is_redacted_and_retried(self):
        adapter = Adapter(RuntimeError("synthetic sensitive response"), CommentBatch((event("ok"),), "next"))
        monitor = self.monitor(adapter)
        self.assertEqual(monitor.poll_once(), {"status": "error", "added": 0})
        self.assertEqual(monitor.state()["errorCode"], "invalid_batch_or_store")
        self.assertNotIn("synthetic sensitive response", str(monitor.state()))
        self.clock[0] += 2
        self.assertEqual(monitor.poll_once()["status"], "ready")


if __name__ == "__main__":
    unittest.main()
