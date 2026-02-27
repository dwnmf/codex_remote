from __future__ import annotations

import importlib
import sys
import uuid
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))


def _reload_app_modules() -> None:
    db_module = sys.modules.get("app.db")
    if db_module is not None:
        db_obj = getattr(db_module, "db", None)
        close_fn = getattr(db_obj, "close", None)
        if callable(close_fn):
            close_fn()

    for name in list(sys.modules.keys()):
        if name == "app" or name.startswith("app."):
            del sys.modules[name]


def _load_database_class(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "relay_artifacts_bootstrap.db"))
    _reload_app_modules()
    db_module = importlib.import_module("app.db")
    return db_module.Database


def test_relay_thread_state_and_message_retention(tmp_path: Path, monkeypatch) -> None:
    Database = _load_database_class(tmp_path, monkeypatch)
    db = Database(str(tmp_path / "relay_state.db"))
    user = db.create_user(f"user-{uuid.uuid4().hex[:8]}")

    db.set_relay_thread_anchor(user.id, "thread-1", "anchor-1")
    db.set_relay_thread_turn(user.id, "thread-1", "turn-1", "InProgress")

    db.append_relay_thread_message(user.id, "thread-1", '{"method":"m1"}', max_messages=2)
    db.append_relay_thread_message(user.id, "thread-1", '{"method":"m2"}', max_messages=2)
    db.append_relay_thread_message(user.id, "thread-1", '{"method":"m3"}', max_messages=2)

    state = db.get_relay_thread_state(user.id, "thread-1")
    assert state is not None
    assert state.bound_anchor_id == "anchor-1"
    assert state.turn_id == "turn-1"
    assert state.turn_status == "InProgress"

    replay = db.list_relay_thread_messages(user.id, "thread-1", limit=10)
    assert [entry.raw_data for entry in replay] == ['{"method":"m2"}', '{"method":"m3"}']
    db.close()


def test_relay_artifact_upsert_retention_and_pagination(tmp_path: Path, monkeypatch) -> None:
    Database = _load_database_class(tmp_path, monkeypatch)
    db = Database(str(tmp_path / "relay_artifacts.db"))
    user = db.create_user(f"user-{uuid.uuid4().hex[:8]}")

    db.upsert_relay_artifact(
        user_id=user.id,
        thread_id="thread-a",
        turn_id="turn-1",
        anchor_id="anchor-a",
        item_id="item-1",
        artifact_type="command",
        item_type="commandExecution",
        summary="first",
        payload_json='{"id":"item-1"}',
        max_artifacts_per_thread=2,
    )
    db.upsert_relay_artifact(
        user_id=user.id,
        thread_id="thread-a",
        turn_id="turn-1",
        anchor_id="anchor-a",
        item_id="item-1",
        artifact_type="command",
        item_type="commandExecution",
        summary="updated",
        payload_json='{"id":"item-1","updated":true}',
        max_artifacts_per_thread=2,
    )
    db.upsert_relay_artifact(
        user_id=user.id,
        thread_id="thread-a",
        turn_id="turn-1",
        anchor_id="anchor-a",
        item_id="item-2",
        artifact_type="file",
        item_type="fileChange",
        summary="second",
        payload_json='{"id":"item-2"}',
        max_artifacts_per_thread=2,
    )
    db.upsert_relay_artifact(
        user_id=user.id,
        thread_id="thread-a",
        turn_id="turn-2",
        anchor_id="anchor-a",
        item_id="item-3",
        artifact_type="tool",
        item_type="mcpToolCall",
        summary="third",
        payload_json='{"id":"item-3"}',
        max_artifacts_per_thread=2,
    )

    records = db.list_relay_artifacts(user.id, thread_id="thread-a", limit=10)
    assert [record.item_id for record in records] == ["item-3", "item-2"]

    page_2 = db.list_relay_artifacts(user.id, thread_id="thread-a", limit=10, before_id=records[-1].id)
    assert page_2 == []
    db.close()
