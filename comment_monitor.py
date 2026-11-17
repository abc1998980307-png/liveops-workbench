"""Source-neutral comment intake. No platform adapter is bundled or enabled here.

An adapter must supply stable event IDs, server event times, account/room identity,
and a resumable cursor from a separately verified source. This module never logs or
stores comment text or commenter identity. Polling is caller-driven; it never logs in.
"""

import hashlib
import hmac
import json
import secrets
import sqlite3
import threading
import time
from contextlib import closing, contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from recording_sessions import timestamp


class CommentSourceError(RuntimeError):
    status = "error"


class SourceDisconnected(CommentSourceError):
    status = "interrupted"


class SourceAuthRequired(CommentSourceError):
    status = "auth_required"


class SourceRateLimited(CommentSourceError):
    status = "rate_limited"


@dataclass(frozen=True)
class CommentEvent:
    event_id: str
    occurred_at: str
    account_uid: str
    room_id: str


@dataclass(frozen=True)
class CommentBatch:
    events: tuple[CommentEvent, ...]
    next_cursor: str


class CommentStore:
    """Durable counts and cursor; raw comments and source event IDs are not persisted."""

    def __init__(self, data_root):
        self.path = Path(data_root) / "plugin-settings" / "comments.sqlite3"
        self.lock = threading.RLock()

    def _connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=5)
        db.execute("PRAGMA foreign_keys = ON")
        db.execute("CREATE TABLE IF NOT EXISTS sources (source TEXT PRIMARY KEY, secret BLOB NOT NULL, cursor TEXT NOT NULL DEFAULT '')")
        db.execute("CREATE TABLE IF NOT EXISTS events (source TEXT NOT NULL, event_hash TEXT NOT NULL, session TEXT NOT NULL, occurred_at TEXT NOT NULL, PRIMARY KEY(source, event_hash), FOREIGN KEY(source) REFERENCES sources(source))")
        db.execute("CREATE INDEX IF NOT EXISTS comments_session_time ON events(session, occurred_at)")
        return db

    @contextmanager
    def _db(self):
        with closing(self._connect()) as db:
            with db:
                yield db

    def cursor(self, source):
        with self.lock, self._db() as db:
            row = db.execute("SELECT cursor FROM sources WHERE source = ?", (source,)).fetchone()
            return row[0] if row else ""

    def save_batch(self, source, events, next_cursor):
        with self.lock, self._db() as db:
            db.execute("INSERT OR IGNORE INTO sources(source, secret) VALUES (?, ?)", (source, secrets.token_bytes(32)))
            secret = db.execute("SELECT secret FROM sources WHERE source = ?", (source,)).fetchone()[0]
            added = 0
            for event, session in events:
                identity = json.dumps([event.account_uid, event.room_id, event.event_id],
                                      ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                digest = hmac.new(secret, identity, hashlib.sha256).hexdigest()
                added += db.execute("INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?)",
                                    (source, digest, session, event.occurred_at)).rowcount
            db.execute("UPDATE sources SET cursor = ? WHERE source = ?", (next_cursor, source))
            return added

    def summary(self, source, session, start_at=None, end_at=None):
        if start_at is not None and timestamp(start_at) is None:
            raise ValueError("评论查询起点无效")
        if end_at is not None and timestamp(end_at) is None:
            raise ValueError("评论查询终点无效")
        query = "SELECT COUNT(*) FROM events WHERE source = ? AND session = ?"
        params = [source, session]
        if start_at is not None:
            query += " AND occurred_at >= ?"
            params.append(_utc(start_at))
        if end_at is not None:
            query += " AND occurred_at < ?"
            params.append(_utc(end_at))
        with self.lock, self._db() as db:
            return db.execute(query, params).fetchone()[0]


def _utc(value):
    point = timestamp(value)
    if point is None:
        raise ValueError("评论事件时间无效")
    return datetime.fromtimestamp(point, timezone.utc).isoformat()


class CommentMonitor:
    """One verified-source adapter, polled explicitly by its eventual integration.

    Adapter.read(cursor) returns CommentBatch. Raising a typed source error retains
    the durable cursor and schedules a bounded reconnect. Authentication errors stop
    automatic retry. No instance is created by the production server today.
    """

    def __init__(self, source, adapter, store, sessions, links, now=time.time):
        if not isinstance(source, str) or not source or len(source) > 64 or not source.isascii() \
                or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for c in source):
            raise ValueError("评论来源标识无效")
        self.source, self.adapter, self.store = source, adapter, store
        self.sessions, self.links, self.now = sessions, links, now
        self.status = "not_connected"
        self.retry_at = None
        self.failures = 0
        self.last_success_at = None
        self.error_code = None

    def _associate(self, event, sessions, links):
        when = timestamp(event.occurred_at)
        if when is None or not isinstance(event.event_id, str) or not 0 < len(event.event_id) <= 256 \
                or not isinstance(event.account_uid, str) or not event.account_uid \
                or not isinstance(event.room_id, str) or not event.room_id:
            raise ValueError("评论事件缺少可核验的身份、时间或去重键")
        matches = []
        for session in sessions:
            start, end = timestamp(session.get("startedAt")), timestamp(session.get("endedAt"))
            if start is None or when < start or end is not None and when >= end:
                continue
            link = links.get(session.get("id"))
            if not link or link["accountUid"] != event.account_uid or link["roomId"] != event.room_id:
                continue
            business_start = link.get("roomStartedAt")
            business_start_at = timestamp(business_start) if business_start else None
            if business_start and (business_start_at is None or when < business_start_at):
                continue
            matches.append(session["id"])
        if len(matches) != 1:
            raise ValueError("评论事件无法唯一关联已确认场次")
        return matches[0]

    def poll_once(self):
        if self.status == "auth_required":
            return {"status": self.status, "added": 0}
        if self.retry_at is not None and self.now() < self.retry_at:
            return {"status": self.status, "added": 0}
        try:
            batch = self.adapter.read(self.store.cursor(self.source))
            if not isinstance(batch, CommentBatch) or not isinstance(batch.events, tuple) \
                    or len(batch.events) > 1000 or not isinstance(batch.next_cursor, str) \
                    or len(batch.next_cursor) > 1024:
                raise ValueError("评论来源批次格式异常")
            sessions = self.sessions._read()["sessions"]
            links = {link["recordingSessionId"]: link for link in self.links.list()["links"]}
            rows = []
            for event in batch.events:
                if not isinstance(event, CommentEvent):
                    raise ValueError("评论来源事件格式异常")
                rows.append((CommentEvent(event.event_id, _utc(event.occurred_at), event.account_uid, event.room_id),
                             self._associate(event, sessions, links)))
            added = self.store.save_batch(self.source, rows, batch.next_cursor)
        except SourceAuthRequired:
            self.status, self.error_code, self.retry_at = "auth_required", "auth_required", None
            return {"status": self.status, "added": 0}
        except Exception as error:
            self.failures += 1
            self.status = error.status if isinstance(error, CommentSourceError) else "error"
            self.error_code = self.status if isinstance(error, CommentSourceError) else "invalid_batch_or_store"
            self.retry_at = self.now() + min(300, 2 ** min(self.failures, 8))
            return {"status": self.status, "added": 0}
        self.failures = 0
        self.retry_at = None
        self.error_code = None
        self.status = "ready"
        self.last_success_at = datetime.fromtimestamp(self.now(), timezone.utc).isoformat()
        return {"status": self.status, "added": added}

    def state(self):
        return {"status": self.status, "collected": self.last_success_at is not None,
                "lastSuccessAt": self.last_success_at, "retryAt": self.retry_at,
                "errorCode": self.error_code}
