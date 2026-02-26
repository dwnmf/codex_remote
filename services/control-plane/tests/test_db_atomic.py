from __future__ import annotations

import importlib
import sys
import threading
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))


def _reload_app_modules() -> None:
    for name in list(sys.modules.keys()):
        if name == "app" or name.startswith("app."):
            del sys.modules[name]


def _load_database_class(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "atomic_bootstrap.db"))
    _reload_app_modules()
    db_module = importlib.import_module("app.db")
    return db_module.Database


def test_consume_device_code_is_atomic_under_race(tmp_path, monkeypatch) -> None:
    Database = _load_database_class(tmp_path, monkeypatch)
    db_path = tmp_path / "atomic_device.db"

    seed = Database(str(db_path))
    user = seed.create_user("atomic-device-user")
    seed.create_device_code("device-code-race", "ABCD-EFGH", 120)
    assert seed.authorise_device_code("ABCD-EFGH", user.id) is True

    db_a = Database(str(db_path))
    db_b = Database(str(db_path))
    barrier = threading.Barrier(2)
    errors: list[Exception] = []
    results = [None, None]

    def _worker(index: int, db_instance) -> None:
        try:
            barrier.wait(timeout=5)
            results[index] = db_instance.consume_device_code("device-code-race")
        except Exception as exc:
            errors.append(exc)

    threads = [
        threading.Thread(target=_worker, args=(0, db_a)),
        threading.Thread(target=_worker, args=(1, db_b)),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)

    assert not errors
    authorised_records = [result for result in results if result and result.status == "authorised"]
    assert len(authorised_records) == 1
    assert sum(1 for result in results if result is None) == 1
    db_a._conn.close()
    db_b._conn.close()
    assert seed.consume_device_code("device-code-race") is None
    seed._conn.close()


def test_consume_challenge_is_atomic_under_race(tmp_path, monkeypatch) -> None:
    Database = _load_database_class(tmp_path, monkeypatch)
    db_path = tmp_path / "atomic_challenge.db"

    seed = Database(str(db_path))
    seed.create_challenge(
        challenge="challenge-race",
        kind="authentication",
        user_id=None,
        pending_name=None,
        pending_display_name=None,
        ttl_sec=120,
    )

    db_a = Database(str(db_path))
    db_b = Database(str(db_path))
    barrier = threading.Barrier(2)
    errors: list[Exception] = []
    results = [None, None]

    def _worker(index: int, db_instance) -> None:
        try:
            barrier.wait(timeout=5)
            results[index] = db_instance.consume_challenge("challenge-race", "authentication")
        except Exception as exc:
            errors.append(exc)

    threads = [
        threading.Thread(target=_worker, args=(0, db_a)),
        threading.Thread(target=_worker, args=(1, db_b)),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)

    assert not errors
    assert sum(1 for result in results if result is not None) == 1
    assert sum(1 for result in results if result is None) == 1
    assert seed.consume_challenge("challenge-race", "authentication") is None
    seed._conn.close()
    db_a._conn.close()
    db_b._conn.close()
