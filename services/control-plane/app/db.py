from __future__ import annotations

import hashlib
import secrets
import sqlite3
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from .config import settings


@dataclass
class User:
    id: str
    name: str
    display_name: str


@dataclass
class SessionRecord:
    id: str
    user_id: str
    expires_at: int
    refresh_token_hash: str
    refresh_expires_at: int
    revoked_at: int | None


@dataclass
class DeviceCodeRecord:
    device_code: str
    user_code: str
    status: str
    user_id: str | None
    expires_at: int


@dataclass
class ChallengeRecord:
    challenge: str
    kind: str
    user_id: str | None
    pending_name: str | None
    pending_display_name: str | None
    expires_at: int


@dataclass
class PasskeyCredential:
    id: str
    user_id: str
    public_key_b64: str
    sign_count: int
    transports_json: str | None
    device_type: str | None
    backed_up: bool


@dataclass
class AnchorSessionRecord:
    id: str
    user_id: str
    access_token_hash: str
    access_expires_at: int
    refresh_token_hash: str
    refresh_expires_at: int
    revoked_at: int | None


class UserNameAlreadyExistsError(Exception):
    pass


def _now_sec() -> int:
    return int(time.time())


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class Database:
    def __init__(self, db_path: str) -> None:
        self.path = Path(db_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

    def close(self) -> None:
        if not hasattr(self, "_conn"):
            return
        try:
            self._conn.close()
        except Exception:
            pass

    def __del__(self) -> None:
        self.close()

    def _init_schema(self) -> None:
        cur = self._conn.cursor()
        cur.executescript(
            """
            PRAGMA journal_mode=WAL;
            PRAGMA foreign_keys=ON;

            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS auth_sessions (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                revoked_at INTEGER,
                refresh_token_hash TEXT NOT NULL,
                refresh_expires_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id)
            );
            CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
            CREATE INDEX IF NOT EXISTS idx_auth_sessions_refresh_hash ON auth_sessions(refresh_token_hash);

            CREATE TABLE IF NOT EXISTS device_codes (
                device_code TEXT PRIMARY KEY,
                user_code TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL,
                user_id TEXT,
                expires_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id)
            );
            CREATE INDEX IF NOT EXISTS idx_device_codes_user_code ON device_codes(user_code);
            CREATE INDEX IF NOT EXISTS idx_device_codes_expires_at ON device_codes(expires_at);

            CREATE TABLE IF NOT EXISTS auth_challenges (
                challenge TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                user_id TEXT,
                pending_name TEXT,
                pending_display_name TEXT,
                expires_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id)
            );
            CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires ON auth_challenges(expires_at);

            CREATE TABLE IF NOT EXISTS passkey_credentials (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                public_key_b64 TEXT NOT NULL,
                sign_count INTEGER NOT NULL,
                transports_json TEXT,
                device_type TEXT,
                backed_up INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id)
            );
            CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user_id ON passkey_credentials(user_id);

            CREATE TABLE IF NOT EXISTS anchor_sessions (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                access_token_hash TEXT NOT NULL UNIQUE,
                access_expires_at INTEGER NOT NULL,
                refresh_token_hash TEXT NOT NULL UNIQUE,
                refresh_expires_at INTEGER NOT NULL,
                revoked_at INTEGER,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id)
            );
            CREATE INDEX IF NOT EXISTS idx_anchor_sessions_access ON anchor_sessions(access_token_hash);
            CREATE INDEX IF NOT EXISTS idx_anchor_sessions_refresh ON anchor_sessions(refresh_token_hash);
            """
        )
        self._conn.commit()

    def has_any_users(self) -> bool:
        return self._conn.execute("SELECT 1 FROM users LIMIT 1").fetchone() is not None

    def get_user_by_id(self, user_id: str) -> User | None:
        row = self._conn.execute(
            "SELECT id, name, display_name FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        if not row:
            return None
        return User(id=row["id"], name=row["name"], display_name=row["display_name"])

    def get_user_by_name(self, name: str) -> User | None:
        row = self._conn.execute(
            "SELECT id, name, display_name FROM users WHERE name = ?",
            (name,),
        ).fetchone()
        if not row:
            return None
        return User(id=row["id"], name=row["name"], display_name=row["display_name"])

    def create_user(self, name: str, display_name: str | None = None) -> User:
        user_id = uuid.uuid4().hex
        now = _now_sec()
        clean_display = (display_name or name).strip() or name
        try:
            self._conn.execute(
                "INSERT INTO users (id, name, display_name, created_at) VALUES (?, ?, ?, ?)",
                (user_id, name, clean_display, now),
            )
        except sqlite3.IntegrityError as exc:
            self._conn.rollback()
            if "users.name" in str(exc).lower():
                raise UserNameAlreadyExistsError(name) from exc
            raise
        self._conn.commit()
        return User(id=user_id, name=name, display_name=clean_display)

    def create_session(self, user_id: str) -> tuple[SessionRecord, str]:
        now = _now_sec()
        session_id = uuid.uuid4().hex
        refresh_token = secrets.token_urlsafe(48)
        refresh_hash = _hash_token(refresh_token)
        expires_at = now + settings.access_ttl_sec
        refresh_expires_at = now + settings.refresh_ttl_sec

        self._conn.execute(
            """
            INSERT INTO auth_sessions (id, user_id, created_at, expires_at, revoked_at, refresh_token_hash, refresh_expires_at)
            VALUES (?, ?, ?, ?, NULL, ?, ?)
            """,
            (session_id, user_id, now, expires_at, refresh_hash, refresh_expires_at),
        )
        self._conn.commit()

        return (
            SessionRecord(
                id=session_id,
                user_id=user_id,
                expires_at=expires_at,
                refresh_token_hash=refresh_hash,
                refresh_expires_at=refresh_expires_at,
                revoked_at=None,
            ),
            refresh_token,
        )

    def get_active_session(self, session_id: str) -> SessionRecord | None:
        now = _now_sec()
        row = self._conn.execute(
            """
            SELECT id, user_id, expires_at, refresh_token_hash, refresh_expires_at, revoked_at
            FROM auth_sessions
            WHERE id = ? AND revoked_at IS NULL AND expires_at > ?
            """,
            (session_id, now),
        ).fetchone()
        if not row:
            return None
        return SessionRecord(
            id=row["id"],
            user_id=row["user_id"],
            expires_at=row["expires_at"],
            refresh_token_hash=row["refresh_token_hash"],
            refresh_expires_at=row["refresh_expires_at"],
            revoked_at=row["revoked_at"],
        )

    def revoke_session(self, session_id: str) -> None:
        now = _now_sec()
        self._conn.execute(
            "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?",
            (now, session_id),
        )
        self._conn.commit()

    def rotate_refresh(self, refresh_token: str) -> tuple[SessionRecord, str] | None:
        now = _now_sec()
        refresh_hash = _hash_token(refresh_token)

        row = self._conn.execute(
            """
            SELECT id, user_id
            FROM auth_sessions
            WHERE refresh_token_hash = ? AND revoked_at IS NULL AND refresh_expires_at > ?
            LIMIT 1
            """,
            (refresh_hash, now),
        ).fetchone()
        if not row:
            return None

        cur = self._conn.execute(
            "UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
            (now, row["id"]),
        )
        if cur.rowcount != 1:
            self._conn.commit()
            return None

        self._conn.commit()
        return self.create_session(row["user_id"])

    def cleanup_expired_device_codes(self) -> None:
        now = _now_sec()
        self._conn.execute("DELETE FROM device_codes WHERE expires_at <= ?", (now,))
        self._conn.commit()

    def create_device_code(self, device_code: str, user_code: str, ttl_sec: int) -> DeviceCodeRecord:
        now = _now_sec()
        expires_at = now + ttl_sec
        self._conn.execute(
            """
            INSERT INTO device_codes (device_code, user_code, status, user_id, expires_at, created_at)
            VALUES (?, ?, 'pending', NULL, ?, ?)
            """,
            (device_code, user_code, expires_at, now),
        )
        self._conn.commit()
        return DeviceCodeRecord(
            device_code=device_code,
            user_code=user_code,
            status="pending",
            user_id=None,
            expires_at=expires_at,
        )

    def authorise_device_code(self, user_code: str, user_id: str) -> bool:
        now = _now_sec()
        cur = self._conn.execute(
            """
            UPDATE device_codes
            SET status = 'authorised', user_id = ?
            WHERE user_code = ? AND status = 'pending' AND expires_at > ?
            """,
            (user_id, user_code, now),
        )
        self._conn.commit()
        return cur.rowcount == 1

    def consume_device_code(self, device_code: str) -> DeviceCodeRecord | None:
        for _ in range(3):
            now = _now_sec()
            row = self._conn.execute(
                """
                DELETE FROM device_codes
                WHERE device_code = ? AND status = 'authorised' AND expires_at > ?
                RETURNING device_code, user_code, status, user_id, expires_at
                """,
                (device_code, now),
            ).fetchone()
            if row:
                self._conn.commit()
                return DeviceCodeRecord(
                    device_code=row["device_code"],
                    user_code=row["user_code"],
                    status=row["status"],
                    user_id=row["user_id"],
                    expires_at=row["expires_at"],
                )

            expired = self._conn.execute(
                "DELETE FROM device_codes WHERE device_code = ? AND expires_at <= ?",
                (device_code, now),
            )
            if expired.rowcount > 0:
                self._conn.commit()
                return None

            row = self._conn.execute(
                """
                SELECT device_code, user_code, status, user_id, expires_at
                FROM device_codes
                WHERE device_code = ?
                """,
                (device_code,),
            ).fetchone()
            if not row:
                return None
            if row["status"] != "authorised" or row["expires_at"] <= now:
                return DeviceCodeRecord(
                    device_code=row["device_code"],
                    user_code=row["user_code"],
                    status=row["status"],
                    user_id=row["user_id"],
                    expires_at=row["expires_at"],
                )

        return None

    def cleanup_expired_challenges(self) -> None:
        now = _now_sec()
        self._conn.execute("DELETE FROM auth_challenges WHERE expires_at <= ?", (now,))
        self._conn.commit()

    def create_challenge(
        self,
        challenge: str,
        kind: str,
        user_id: str | None,
        pending_name: str | None,
        pending_display_name: str | None,
        ttl_sec: int,
    ) -> None:
        now = _now_sec()
        expires_at = now + ttl_sec
        self._conn.execute(
            """
            INSERT INTO auth_challenges (challenge, kind, user_id, pending_name, pending_display_name, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (challenge, kind, user_id, pending_name, pending_display_name, expires_at, now),
        )
        self._conn.commit()

    def consume_challenge(self, challenge: str, expected_kind: str) -> ChallengeRecord | None:
        now = _now_sec()
        row = self._conn.execute(
            """
            DELETE FROM auth_challenges
            WHERE challenge = ? AND kind = ? AND expires_at > ?
            RETURNING challenge, kind, user_id, pending_name, pending_display_name, expires_at
            """,
            (challenge, expected_kind, now),
        ).fetchone()
        if row:
            self._conn.commit()
            return ChallengeRecord(
                challenge=row["challenge"],
                kind=row["kind"],
                user_id=row["user_id"],
                pending_name=row["pending_name"],
                pending_display_name=row["pending_display_name"],
                expires_at=row["expires_at"],
            )

        self._conn.execute("DELETE FROM auth_challenges WHERE challenge = ?", (challenge,))
        self._conn.commit()
        return None

    def list_passkey_credentials(self, user_id: str) -> list[PasskeyCredential]:
        rows = self._conn.execute(
            """
            SELECT id, user_id, public_key_b64, sign_count, transports_json, device_type, backed_up
            FROM passkey_credentials
            WHERE user_id = ?
            """,
            (user_id,),
        ).fetchall()
        return [
            PasskeyCredential(
                id=row["id"],
                user_id=row["user_id"],
                public_key_b64=row["public_key_b64"],
                sign_count=row["sign_count"],
                transports_json=row["transports_json"],
                device_type=row["device_type"],
                backed_up=bool(row["backed_up"]),
            )
            for row in rows
        ]

    def get_passkey_credential(self, credential_id: str) -> PasskeyCredential | None:
        row = self._conn.execute(
            """
            SELECT id, user_id, public_key_b64, sign_count, transports_json, device_type, backed_up
            FROM passkey_credentials
            WHERE id = ?
            """,
            (credential_id,),
        ).fetchone()
        if not row:
            return None
        return PasskeyCredential(
            id=row["id"],
            user_id=row["user_id"],
            public_key_b64=row["public_key_b64"],
            sign_count=row["sign_count"],
            transports_json=row["transports_json"],
            device_type=row["device_type"],
            backed_up=bool(row["backed_up"]),
        )

    def upsert_passkey_credential(
        self,
        credential_id: str,
        user_id: str,
        public_key_b64: str,
        sign_count: int,
        transports_json: str | None,
        device_type: str | None,
        backed_up: bool,
    ) -> None:
        now = _now_sec()
        self._conn.execute(
            """
            INSERT INTO passkey_credentials (id, user_id, public_key_b64, sign_count, transports_json, device_type, backed_up, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                user_id = excluded.user_id,
                public_key_b64 = excluded.public_key_b64,
                sign_count = excluded.sign_count,
                transports_json = excluded.transports_json,
                device_type = excluded.device_type,
                backed_up = excluded.backed_up
            """,
            (
                credential_id,
                user_id,
                public_key_b64,
                sign_count,
                transports_json,
                device_type,
                1 if backed_up else 0,
                now,
            ),
        )
        self._conn.commit()

    def update_passkey_counter(self, credential_id: str, sign_count: int) -> None:
        self._conn.execute(
            "UPDATE passkey_credentials SET sign_count = ? WHERE id = ?",
            (sign_count, credential_id),
        )
        self._conn.commit()

    def create_anchor_session(self, user_id: str) -> tuple[AnchorSessionRecord, str, str]:
        now = _now_sec()
        session_id = uuid.uuid4().hex
        access_token = secrets.token_urlsafe(48)
        refresh_token = secrets.token_urlsafe(64)

        access_hash = _hash_token(access_token)
        refresh_hash = _hash_token(refresh_token)

        access_expires_at = now + settings.anchor_access_ttl_sec
        refresh_expires_at = now + settings.anchor_refresh_ttl_sec

        self._conn.execute(
            """
            INSERT INTO anchor_sessions (id, user_id, access_token_hash, access_expires_at, refresh_token_hash, refresh_expires_at, revoked_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
            """,
            (session_id, user_id, access_hash, access_expires_at, refresh_hash, refresh_expires_at, now),
        )
        self._conn.commit()

        record = AnchorSessionRecord(
            id=session_id,
            user_id=user_id,
            access_token_hash=access_hash,
            access_expires_at=access_expires_at,
            refresh_token_hash=refresh_hash,
            refresh_expires_at=refresh_expires_at,
            revoked_at=None,
        )
        return record, access_token, refresh_token

    def get_active_anchor_session_by_access_token(self, access_token: str) -> AnchorSessionRecord | None:
        now = _now_sec()
        access_hash = _hash_token(access_token)
        row = self._conn.execute(
            """
            SELECT id, user_id, access_token_hash, access_expires_at, refresh_token_hash, refresh_expires_at, revoked_at
            FROM anchor_sessions
            WHERE access_token_hash = ? AND revoked_at IS NULL AND access_expires_at > ?
            LIMIT 1
            """,
            (access_hash, now),
        ).fetchone()
        if not row:
            return None
        return AnchorSessionRecord(
            id=row["id"],
            user_id=row["user_id"],
            access_token_hash=row["access_token_hash"],
            access_expires_at=row["access_expires_at"],
            refresh_token_hash=row["refresh_token_hash"],
            refresh_expires_at=row["refresh_expires_at"],
            revoked_at=row["revoked_at"],
        )

    def rotate_anchor_refresh(self, refresh_token: str) -> tuple[AnchorSessionRecord, str, str] | None:
        now = _now_sec()
        refresh_hash = _hash_token(refresh_token)

        row = self._conn.execute(
            """
            SELECT id, user_id
            FROM anchor_sessions
            WHERE refresh_token_hash = ? AND revoked_at IS NULL AND refresh_expires_at > ?
            LIMIT 1
            """,
            (refresh_hash, now),
        ).fetchone()
        if not row:
            return None

        cur = self._conn.execute(
            "UPDATE anchor_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
            (now, row["id"]),
        )
        if cur.rowcount != 1:
            self._conn.commit()
            return None

        self._conn.commit()
        return self.create_anchor_session(row["user_id"])


db = Database(settings.database_path)
