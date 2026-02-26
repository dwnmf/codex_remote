from __future__ import annotations

import importlib
import sys
import uuid
from pathlib import Path

from fastapi.testclient import TestClient

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


def _make_client(
    tmp_path: Path,
    monkeypatch,
    *,
    auth_mode: str = "basic",
    passkey_origin: str = "",
) -> TestClient:
    db_path = tmp_path / "control_plane_test.db"
    monkeypatch.setenv("DATABASE_PATH", str(db_path))
    monkeypatch.setenv("AUTH_MODE", auth_mode)
    monkeypatch.setenv("ZANE_WEB_JWT_SECRET", "test-web-secret")
    monkeypatch.setenv("ZANE_ANCHOR_JWT_SECRET", "test-anchor-secret")
    monkeypatch.setenv("CORS_ORIGINS", "http://localhost:5173")
    monkeypatch.setenv("DEVICE_VERIFICATION_URL", "http://localhost:5173/device")
    monkeypatch.setenv("PASSKEY_ORIGIN", passkey_origin)
    monkeypatch.setenv("PASSKEY_RP_ID", "")
    monkeypatch.setenv("ACCESS_TTL_SEC", "3600")
    monkeypatch.setenv("REFRESH_TTL_SEC", "604800")
    monkeypatch.setenv("DEVICE_CODE_TTL_SEC", "600")
    monkeypatch.setenv("DEVICE_CODE_POLL_INTERVAL_SEC", "5")
    monkeypatch.setenv("ANCHOR_ACCESS_TTL_SEC", "600")
    monkeypatch.setenv("ANCHOR_REFRESH_TTL_SEC", "3600")
    monkeypatch.setenv("CHALLENGE_TTL_SEC", "300")

    _reload_app_modules()
    app_main = importlib.import_module("app.main")
    return TestClient(app_main.app)


def _register_basic(client: TestClient, name: str) -> dict:
    response = client.post("/auth/register/basic", json={"name": name})
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload.get("token")
    assert payload.get("refreshToken")
    return payload


def _issue_anchor_tokens(client: TestClient, web_token: str) -> dict:
    code = client.post("/auth/device/code").json()
    assert code.get("deviceCode")
    assert code.get("userCode")

    pending = client.post("/auth/device/token", json={"deviceCode": code["deviceCode"]})
    assert pending.status_code == 200
    assert pending.json().get("status") == "pending"

    authorise = client.post(
        "/auth/device/authorise",
        json={"userCode": code["userCode"]},
        headers={"authorization": f"Bearer {web_token}"},
    )
    assert authorise.status_code == 200, authorise.text

    issued = client.post("/auth/device/token", json={"deviceCode": code["deviceCode"]})
    assert issued.status_code == 200
    payload = issued.json()
    assert payload.get("status") == "authorised"
    assert payload.get("anchorAccessToken")
    assert payload.get("anchorRefreshToken")
    return payload


def _recv_until(ws, predicate, max_messages: int = 20):
    seen = []
    for _ in range(max_messages):
        message = ws.receive_json()
        seen.append(message)
        if predicate(message):
            return message
    raise AssertionError(f"Expected message not received. Seen={seen}")


def _rpc_error_code(message: dict) -> str | None:
    error = message.get("error")
    if not isinstance(error, dict):
        return None
    data = error.get("data")
    if not isinstance(data, dict):
        return None
    code = data.get("code")
    return code if isinstance(code, str) else None


def test_basic_auth_session_refresh_logout(tmp_path: Path, monkeypatch) -> None:
    client = _make_client(tmp_path, monkeypatch, auth_mode="basic")
    with client:
        initial = client.get("/auth/session")
        assert initial.status_code == 200
        assert initial.json()["authenticated"] is False
        assert initial.json()["systemHasUsers"] is False

        username = f"user-{uuid.uuid4().hex[:8]}"
        registered = _register_basic(client, username)
        token = registered["token"]
        refresh_token = registered["refreshToken"]

        session = client.get("/auth/session", headers={"authorization": f"Bearer {token}"})
        assert session.status_code == 200
        assert session.json()["authenticated"] is True
        assert session.json()["user"]["name"] == username
        assert session.json()["systemHasUsers"] is True

        refreshed = client.post("/auth/refresh", json={"refreshToken": refresh_token})
        assert refreshed.status_code == 200
        refreshed_payload = refreshed.json()
        assert refreshed_payload["token"] != token
        assert refreshed_payload["refreshToken"] != refresh_token

        logout = client.post("/auth/logout", headers={"authorization": f"Bearer {refreshed_payload['token']}"})
        assert logout.status_code == 204

        after_logout = client.get("/auth/session", headers={"authorization": f"Bearer {refreshed_payload['token']}"})
        assert after_logout.status_code == 200
        assert after_logout.json()["authenticated"] is False


def test_device_flow_anchor_token_refresh_and_ws_preflight(tmp_path: Path, monkeypatch) -> None:
    client = _make_client(tmp_path, monkeypatch, auth_mode="basic")
    with client:
        username = f"user-{uuid.uuid4().hex[:8]}"
        registered = _register_basic(client, username)
        issued = _issue_anchor_tokens(client, registered["token"])

        preflight = client.get("/ws/anchor", params={"token": issued["anchorAccessToken"]})
        assert preflight.status_code == 426

        rotated = client.post("/auth/device/refresh", json={"refreshToken": issued["anchorRefreshToken"]})
        assert rotated.status_code == 200
        rotated_payload = rotated.json()
        assert rotated_payload["anchorAccessToken"] != issued["anchorAccessToken"]
        assert rotated_payload["anchorRefreshToken"] != issued["anchorRefreshToken"]

        old_preflight = client.get("/ws/anchor", params={"token": issued["anchorAccessToken"]})
        assert old_preflight.status_code == 401

        new_preflight = client.get("/ws/anchor", params={"token": rotated_payload["anchorAccessToken"]})
        assert new_preflight.status_code == 426


def test_websocket_relay_isolated_per_user(tmp_path: Path, monkeypatch) -> None:
    client = _make_client(tmp_path, monkeypatch, auth_mode="basic")
    with client:
        user_a = _register_basic(client, f"user-a-{uuid.uuid4().hex[:8]}")
        user_b = _register_basic(client, f"user-b-{uuid.uuid4().hex[:8]}")
        anchor_a_tokens = _issue_anchor_tokens(client, user_a["token"])
        anchor_b_tokens = _issue_anchor_tokens(client, user_b["token"])

        with client.websocket_connect(f"/ws/anchor?token={anchor_a_tokens['anchorAccessToken']}") as anchor_a_ws:
            assert anchor_a_ws.receive_json()["type"] == "orbit.hello"
            anchor_a_ws.send_json({"type": "anchor.hello", "hostname": "anchor-a", "platform": "linux", "anchorId": "anchor-a"})

            with client.websocket_connect(f"/ws/anchor?token={anchor_b_tokens['anchorAccessToken']}") as anchor_b_ws:
                assert anchor_b_ws.receive_json()["type"] == "orbit.hello"
                anchor_b_ws.send_json(
                    {"type": "anchor.hello", "hostname": "anchor-b", "platform": "linux", "anchorId": "anchor-b"}
                )

                with client.websocket_connect(f"/ws/client?token={user_a['token']}&clientId=user-a-client") as client_a_ws:
                    assert _recv_until(client_a_ws, lambda msg: msg.get("type") == "orbit.hello")["role"] == "client"

                    client_a_ws.send_json({"type": "orbit.list-anchors"})
                    anchors_msg = _recv_until(client_a_ws, lambda msg: msg.get("type") == "orbit.anchors")
                    anchors = anchors_msg.get("anchors") or []
                    assert [item.get("id") for item in anchors] == ["anchor-a"]

                    client_a_ws.send_json({"id": 710, "method": "thread/start", "params": {"cwd": ".", "anchorId": "anchor-b"}})
                    cross_user = _recv_until(client_a_ws, lambda msg: msg.get("id") == 710 and msg.get("error"))
                    assert _rpc_error_code(cross_user) == "anchor_not_found"

                    client_a_ws.send_json({"id": 711, "method": "thread/start", "params": {"cwd": "."}})
                    routed = _recv_until(anchor_a_ws, lambda msg: msg.get("id") == 711 and msg.get("method") == "thread/start")
                    assert routed.get("id") == 711
                    anchor_a_ws.send_json({"id": 711, "result": {"thread": {"id": "isolated-thread"}}})
                    finished = _recv_until(client_a_ws, lambda msg: msg.get("id") == 711 and isinstance(msg.get("result"), dict))
                    assert finished.get("result", {}).get("thread", {}).get("id") == "isolated-thread"


def test_websocket_relay_subscription_and_protocol_messages(tmp_path: Path, monkeypatch) -> None:
    client = _make_client(tmp_path, monkeypatch, auth_mode="basic")
    with client:
        username = f"user-{uuid.uuid4().hex[:8]}"
        registered = _register_basic(client, username)
        web_token = registered["token"]
        anchor_tokens = _issue_anchor_tokens(client, web_token)
        anchor_access = anchor_tokens["anchorAccessToken"]

        with client.websocket_connect(f"/ws/anchor?token={anchor_access}") as anchor_ws:
            anchor_hello = anchor_ws.receive_json()
            assert anchor_hello["type"] == "orbit.hello"
            assert anchor_hello["role"] == "anchor"
            anchor_ws.send_json({"type": "anchor.hello", "hostname": "integration-anchor", "platform": "linux", "anchorId": "anchor-one"})
            anchor_ws.send_json({"type": "orbit.subscribe", "threadId": "thread-1"})
            anchor_subscribed = _recv_until(
                anchor_ws,
                lambda msg: msg.get("type") == "orbit.subscribed" and msg.get("threadId") == "thread-1",
            )
            assert anchor_subscribed["threadId"] == "thread-1"

            with client.websocket_connect(f"/ws/client?token={web_token}&clientId=integration-client") as client_ws:
                client_hello = _recv_until(client_ws, lambda msg: msg.get("type") == "orbit.hello")
                assert client_hello["role"] == "client"

                client_ws.send_json({"type": "orbit.list-anchors"})
                anchors_msg = _recv_until(client_ws, lambda msg: msg.get("type") == "orbit.anchors")
                assert isinstance(anchors_msg.get("anchors"), list)
                assert len(anchors_msg["anchors"]) >= 1

                client_ws.send_json({"type": "orbit.subscribe", "threadId": "thread-1"})
                subscribed = _recv_until(
                    client_ws,
                    lambda msg: msg.get("type") == "orbit.subscribed" and msg.get("threadId") == "thread-1",
                )
                assert subscribed["threadId"] == "thread-1"

                anchor_notice = _recv_until(
                    anchor_ws,
                    lambda msg: msg.get("type") == "orbit.client-subscribed" and msg.get("threadId") == "thread-1",
                )
                assert anchor_notice["threadId"] == "thread-1"

                anchor_ws.send_json(
                    {
                        "method": "item/agentMessage/delta",
                        "params": {"threadId": "thread-1", "delta": "hello"},
                    }
                )
                relayed_to_client = _recv_until(
                    client_ws,
                    lambda msg: msg.get("method") == "item/agentMessage/delta"
                    and msg.get("params", {}).get("threadId") == "thread-1",
                )
                assert relayed_to_client["params"]["delta"] == "hello"

                client_ws.send_json({"method": "turn/start", "params": {"threadId": "thread-1", "input": []}})
                relayed_to_anchor = _recv_until(
                    anchor_ws,
                    lambda msg: msg.get("method") == "turn/start" and msg.get("params", {}).get("threadId") == "thread-1",
                )
                assert relayed_to_anchor["params"]["threadId"] == "thread-1"

                anchor_ws.send_json({"type": "ping"})
                pong = _recv_until(anchor_ws, lambda msg: msg.get("type") == "pong")
                assert pong["type"] == "pong"


def test_websocket_targeted_routing_with_anchor_selection_and_errors(tmp_path: Path, monkeypatch) -> None:
    client = _make_client(tmp_path, monkeypatch, auth_mode="basic")
    with client:
        username = f"user-{uuid.uuid4().hex[:8]}"
        registered = _register_basic(client, username)
        web_token = registered["token"]
        anchor_tokens = _issue_anchor_tokens(client, web_token)
        anchor_access = anchor_tokens["anchorAccessToken"]

        with client.websocket_connect(f"/ws/anchor?token={anchor_access}") as anchor_a_ws:
            assert anchor_a_ws.receive_json()["type"] == "orbit.hello"
            anchor_a_ws.send_json({"type": "anchor.hello", "hostname": "anchor-a", "platform": "linux", "anchorId": "anchor-a"})

            with client.websocket_connect(f"/ws/anchor?token={anchor_access}") as anchor_b_ws:
                assert anchor_b_ws.receive_json()["type"] == "orbit.hello"
                anchor_b_ws.send_json({"type": "anchor.hello", "hostname": "anchor-b", "platform": "linux", "anchorId": "anchor-b"})

                with client.websocket_connect(f"/ws/client?token={web_token}&clientId=targeting-client") as client_ws:
                    assert _recv_until(client_ws, lambda msg: msg.get("type") == "orbit.hello")["role"] == "client"

                    client_ws.send_json({"type": "orbit.list-anchors"})
                    anchors_msg = _recv_until(client_ws, lambda msg: msg.get("type") == "orbit.anchors")
                    anchors = anchors_msg.get("anchors") or []
                    assert len(anchors) == 2

                    client_ws.send_json({"id": 900, "method": "thread/start", "params": {"cwd": ".", "anchorId": "anchor-a"}})
                    relayed_start = _recv_until(
                        anchor_a_ws,
                        lambda msg: msg.get("id") == 900 and msg.get("method") == "thread/start",
                    )
                    assert relayed_start.get("params", {}).get("anchorId") == "anchor-a"

                    anchor_a_ws.send_json({"id": 900, "result": {"thread": {"id": "thread-target"}}})
                    started = _recv_until(client_ws, lambda msg: msg.get("id") == 900 and isinstance(msg.get("result"), dict))
                    assert started.get("result", {}).get("thread", {}).get("id") == "thread-target"

                    client_ws.send_json({"id": 901, "method": "turn/start", "params": {"threadId": "thread-target", "input": []}})
                    relayed_turn = _recv_until(
                        anchor_a_ws,
                        lambda msg: msg.get("id") == 901 and msg.get("method") == "turn/start",
                    )
                    assert relayed_turn.get("params", {}).get("threadId") == "thread-target"

                    client_ws.send_json(
                        {
                            "id": 902,
                            "method": "turn/start",
                            "params": {"threadId": "thread-target", "input": [], "anchorId": "anchor-b"},
                        }
                    )
                    mismatch = _recv_until(client_ws, lambda msg: msg.get("id") == 902 and msg.get("error"))
                    assert _rpc_error_code(mismatch) == "thread_anchor_mismatch"

                    client_ws.send_json({"id": 903, "method": "thread/start", "params": {"cwd": ".", "anchorId": "missing-anchor"}})
                    missing = _recv_until(client_ws, lambda msg: msg.get("id") == 903 and msg.get("error"))
                    assert _rpc_error_code(missing) == "anchor_not_found"

                    anchor_b_ws.send_json({"type": "orbit.subscribe", "threadId": "thread-target"})
                    anchor_b_subscribed = _recv_until(
                        anchor_b_ws,
                        lambda msg: msg.get("type") == "orbit.subscribed" and msg.get("threadId") == "thread-target",
                    )
                    assert anchor_b_subscribed["threadId"] == "thread-target"

                    anchor_a_ws.close()
                    _recv_until(client_ws, lambda msg: msg.get("type") == "orbit.anchor-disconnected" and msg.get("anchorId") == "anchor-a")

                    client_ws.send_json({"id": 904, "method": "turn/start", "params": {"threadId": "thread-target", "input": []}})
                    rerouted = _recv_until(
                        anchor_b_ws,
                        lambda msg: msg.get("id") == 904 and msg.get("method") == "turn/start",
                    )
                    assert rerouted.get("params", {}).get("threadId") == "thread-target"


def test_register_basic_handles_create_user_uniqueness_race(tmp_path: Path, monkeypatch) -> None:
    client = _make_client(tmp_path, monkeypatch, auth_mode="basic")
    with client:
        username = f"user-{uuid.uuid4().hex[:8]}"
        _register_basic(client, username)

        app_main = importlib.import_module("app.main")
        monkeypatch.setattr(app_main.db, "get_user_by_name", lambda _name: None)

        response = client.post("/auth/register/basic", json={"name": username})
        assert response.status_code == 400
        assert response.json().get("error") == "User already exists."


def test_anchor_reconnect_after_disconnect(tmp_path: Path, monkeypatch) -> None:
    client = _make_client(tmp_path, monkeypatch, auth_mode="basic")
    with client:
        username = f"user-{uuid.uuid4().hex[:8]}"
        registered = _register_basic(client, username)
        anchor_tokens = _issue_anchor_tokens(client, registered["token"])
        access_token = anchor_tokens["anchorAccessToken"]

        with client.websocket_connect(f"/ws/anchor?token={access_token}") as first:
            hello = first.receive_json()
            assert hello["type"] == "orbit.hello"
            assert hello["role"] == "anchor"

        with client.websocket_connect(f"/ws/anchor?token={access_token}") as second:
            hello = second.receive_json()
            assert hello["type"] == "orbit.hello"
            assert hello["role"] == "anchor"


def test_passkey_mode_register_options_origin_checks(tmp_path: Path, monkeypatch) -> None:
    client = _make_client(
        tmp_path,
        monkeypatch,
        auth_mode="passkey",
        passkey_origin="https://example.com",
    )
    with client:
        basic_blocked = client.post("/auth/register/basic", json={"name": "alice"})
        assert basic_blocked.status_code == 400

        denied = client.post("/auth/register/options", json={"name": "alice"})
        assert denied.status_code == 403

        allowed = client.post(
            "/auth/register/options",
            json={"name": f"user-{uuid.uuid4().hex[:8]}"},
            headers={"origin": "https://example.com"},
        )
        assert allowed.status_code == 200
        payload = allowed.json()
        assert payload.get("challenge")
        assert payload.get("rp", {}).get("id") == "example.com"
