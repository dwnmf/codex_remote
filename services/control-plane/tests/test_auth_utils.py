from __future__ import annotations

import importlib
import sys
from pathlib import Path

from fastapi import Request

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


def _load_auth_module(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "auth_utils.db"))
    _reload_app_modules()
    return importlib.import_module("app.auth")


def _make_request(*, authorization: str | None = None, query: str = "") -> Request:
    headers: list[tuple[bytes, bytes]] = []
    if authorization is not None:
        headers.append((b"authorization", authorization.encode("latin-1")))
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/",
        "headers": headers,
        "query_string": query.encode("ascii"),
    }
    return Request(scope)


def test_extract_token_from_request_strips_query_token_whitespace(tmp_path: Path, monkeypatch) -> None:
    auth = _load_auth_module(tmp_path, monkeypatch)
    request = _make_request(query="token=%20%20query-token%20%20")
    assert auth.extract_token_from_request(request) == "query-token"


def test_extract_token_from_request_rejects_blank_query_token(tmp_path: Path, monkeypatch) -> None:
    auth = _load_auth_module(tmp_path, monkeypatch)
    request = _make_request(query="token=%20%20%20")
    assert auth.extract_token_from_request(request) is None


def test_extract_token_from_request_prefers_bearer_header_over_query(tmp_path: Path, monkeypatch) -> None:
    auth = _load_auth_module(tmp_path, monkeypatch)
    request = _make_request(authorization="Bearer header-token", query="token=query-token")
    assert auth.extract_token_from_request(request) == "header-token"
