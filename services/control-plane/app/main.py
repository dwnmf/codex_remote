from __future__ import annotations

import json
import secrets
from typing import Any

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse

from .auth import (
    create_anchor_session,
    create_user_session,
    current_session_id,
    extract_token_from_request,
    generate_device_code,
    generate_user_code,
    get_authenticated_user,
    parse_bearer_token,
    refresh_anchor_session,
    refresh_user_session,
    require_authenticated_user,
    verify_anchor_any_token,
    verify_web_token,
)
from .config import settings
from .db import db
from .passkey import (
    extract_client_data_challenge,
    is_allowed_origin,
    make_authentication_options,
    make_registration_options,
    verify_authentication,
    verify_registration,
)
from .relay import RelayHub

app = FastAPI(title="Zane FastAPI Control Plane", version="0.2.0")
hub = RelayHub()

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _is_passkey_mode() -> bool:
    return settings.auth_mode == "passkey"


def _is_basic_mode() -> bool:
    return settings.auth_mode == "basic"


def _as_string_list(value: Any) -> list[str] | None:
    if not isinstance(value, list):
        return None
    result = [item for item in value if isinstance(item, str)]
    return result or None


def _parse_credential_transports_json(value: str | None) -> list[str] | None:
    if not value:
        return None
    try:
        parsed = json.loads(value)
        return _as_string_list(parsed)
    except Exception:
        return None


def _extract_transports_payload(credential_payload: dict[str, Any]) -> list[str] | None:
    response = credential_payload.get("response")
    if not isinstance(response, dict):
        return None
    return _as_string_list(response.get("transports"))


def _require_passkey_origin(request: Request) -> str:
    origin = (request.headers.get("origin") or "").strip()
    if not is_allowed_origin(origin):
        raise HTTPException(status_code=403, detail="Origin not allowed.")
    return origin


def _verify_web_session_token(token: str) -> dict[str, Any] | None:
    payload = verify_web_token(token)
    if not payload:
        return None
    jti = payload.get("jti")
    sub = payload.get("sub")
    if not isinstance(jti, str) or not isinstance(sub, str):
        return None
    session = db.get_active_session(jti)
    if not session or session.user_id != sub:
        return None
    return payload


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "authMode": settings.auth_mode,
        "clients": len(hub.client_sockets),
        "anchors": len(hub.anchor_sockets),
    }


@app.get("/auth/session")
async def auth_session(request: Request) -> dict[str, Any]:
    user = get_authenticated_user(request)
    has_users = db.has_any_users()
    has_passkey = False
    if user:
        has_passkey = len(db.list_passkey_credentials(user.id)) > 0

    return {
        "authenticated": user is not None,
        "user": {"id": user.id, "name": user.name} if user else None,
        "hasPasskey": has_passkey,
        "systemHasUsers": has_users,
    }


@app.post("/auth/register/basic")
async def auth_register_basic(payload: dict[str, Any]) -> JSONResponse:
    if not _is_basic_mode():
        return JSONResponse({"error": "Basic auth mode is disabled."}, status_code=400)

    name = str(payload.get("name", "")).strip()
    display_name = str(payload.get("displayName", "")).strip() or name
    if not name:
        return JSONResponse({"error": "Name is required."}, status_code=400)

    if db.get_user_by_name(name):
        return JSONResponse({"error": "User already exists."}, status_code=400)

    user = db.create_user(name=name, display_name=display_name)
    return JSONResponse(create_user_session(user), status_code=200)


@app.post("/auth/login/basic")
async def auth_login_basic(payload: dict[str, Any]) -> JSONResponse:
    if not _is_basic_mode():
        return JSONResponse({"error": "Basic auth mode is disabled."}, status_code=400)

    username = str(payload.get("username", "")).strip()
    if not username:
        return JSONResponse({"error": "Username is required."}, status_code=400)

    user = db.get_user_by_name(username)
    if not user:
        return JSONResponse({"error": "Invalid credentials."}, status_code=400)

    return JSONResponse(create_user_session(user), status_code=200)


@app.post("/auth/register/options")
async def auth_register_options(request: Request, payload: dict[str, Any]) -> JSONResponse:
    if not _is_passkey_mode():
        return JSONResponse({"error": "Passkey flow is disabled. Use AUTH_MODE=basic."}, status_code=400)

    origin = _require_passkey_origin(request)
    db.cleanup_expired_challenges()

    user = get_authenticated_user(request)
    if user:
        existing_creds = db.list_passkey_credentials(user.id)
        options = make_registration_options(
            user_id=user.id,
            user_name=user.name,
            user_display_name=user.display_name,
            exclude_credentials=[
                (cred.id, _parse_credential_transports_json(cred.transports_json)) for cred in existing_creds
            ],
            origin=origin,
        )
        challenge = str(options.get("challenge", "")).strip()
        if not challenge:
            return JSONResponse({"error": "Failed to create registration challenge."}, status_code=500)
        db.create_challenge(
            challenge=challenge,
            kind="registration",
            user_id=user.id,
            pending_name=None,
            pending_display_name=None,
            ttl_sec=settings.challenge_ttl_sec,
        )
        return JSONResponse(options, status_code=200)

    name = str(payload.get("name", "")).strip()
    display_name = str(payload.get("displayName", "")).strip() or name
    if not name:
        return JSONResponse({"error": "Name is required."}, status_code=400)
    if db.get_user_by_name(name):
        return JSONResponse({"error": "Registration failed."}, status_code=400)

    pseudo_user_id = f"pending-{secrets.token_hex(8)}"
    options = make_registration_options(
        user_id=pseudo_user_id,
        user_name=name,
        user_display_name=display_name,
        exclude_credentials=[],
        origin=origin,
    )
    challenge = str(options.get("challenge", "")).strip()
    if not challenge:
        return JSONResponse({"error": "Failed to create registration challenge."}, status_code=500)
    db.create_challenge(
        challenge=challenge,
        kind="registration",
        user_id=None,
        pending_name=name,
        pending_display_name=display_name,
        ttl_sec=settings.challenge_ttl_sec,
    )
    return JSONResponse(options, status_code=200)


@app.post("/auth/register/verify")
async def auth_register_verify(request: Request, payload: dict[str, Any]) -> JSONResponse:
    if not _is_passkey_mode():
        return JSONResponse({"error": "Passkey flow is disabled. Use AUTH_MODE=basic."}, status_code=400)

    origin = _require_passkey_origin(request)

    credential = payload.get("credential")
    if not isinstance(credential, dict):
        return JSONResponse({"error": "Invalid payload."}, status_code=400)

    challenge = extract_client_data_challenge(credential)
    if not challenge:
        return JSONResponse({"error": "Missing challenge."}, status_code=400)

    challenge_record = db.consume_challenge(challenge, "registration")
    if not challenge_record:
        return JSONResponse({"error": "Registration challenge expired."}, status_code=400)

    try:
        reg = verify_registration(credential, challenge_record.challenge, origin)
    except Exception:
        return JSONResponse({"error": "Registration verification failed."}, status_code=400)

    if challenge_record.user_id:
        user = db.get_user_by_id(challenge_record.user_id)
        if not user:
            return JSONResponse({"error": "User not found."}, status_code=404)
    else:
        pending_name = (challenge_record.pending_name or "").strip()
        pending_display = (challenge_record.pending_display_name or pending_name).strip() or pending_name
        if not pending_name:
            return JSONResponse({"error": "Invalid challenge record."}, status_code=400)
        if db.get_user_by_name(pending_name):
            return JSONResponse({"error": "Registration failed."}, status_code=400)
        user = db.create_user(name=pending_name, display_name=pending_display)

    transports = _extract_transports_payload(credential)
    db.upsert_passkey_credential(
        credential_id=reg["credential_id"],
        user_id=user.id,
        public_key_b64=reg["credential_public_key"],
        sign_count=reg["sign_count"],
        transports_json=json.dumps(transports) if transports else None,
        device_type=reg.get("credential_device_type"),
        backed_up=bool(reg.get("credential_backed_up")),
    )

    return JSONResponse(create_user_session(user), status_code=200)


@app.post("/auth/login/options")
async def auth_login_options(request: Request, payload: dict[str, Any]) -> JSONResponse:
    if not _is_passkey_mode():
        return JSONResponse({"error": "Passkey flow is disabled. Use AUTH_MODE=basic."}, status_code=400)

    origin = _require_passkey_origin(request)
    username = str(payload.get("username", "")).strip()
    if not username:
        return JSONResponse({"error": "Username is required."}, status_code=400)

    user = db.get_user_by_name(username)
    if not user:
        return JSONResponse({"error": "Invalid credentials."}, status_code=400)

    creds = db.list_passkey_credentials(user.id)
    if not creds:
        return JSONResponse({"error": "Invalid credentials."}, status_code=400)

    options = make_authentication_options(
        allow_credentials=[(cred.id, _parse_credential_transports_json(cred.transports_json)) for cred in creds],
        origin=origin,
    )
    challenge = str(options.get("challenge", "")).strip()
    if not challenge:
        return JSONResponse({"error": "Failed to create authentication challenge."}, status_code=500)

    db.cleanup_expired_challenges()
    db.create_challenge(
        challenge=challenge,
        kind="authentication",
        user_id=user.id,
        pending_name=None,
        pending_display_name=None,
        ttl_sec=settings.challenge_ttl_sec,
    )

    return JSONResponse(options, status_code=200)


@app.post("/auth/login/verify")
async def auth_login_verify(request: Request, payload: dict[str, Any]) -> JSONResponse:
    if not _is_passkey_mode():
        return JSONResponse({"error": "Passkey flow is disabled. Use AUTH_MODE=basic."}, status_code=400)

    origin = _require_passkey_origin(request)

    credential = payload.get("credential")
    if not isinstance(credential, dict):
        return JSONResponse({"error": "Invalid payload."}, status_code=400)

    challenge = extract_client_data_challenge(credential)
    if not challenge:
        return JSONResponse({"error": "Missing challenge."}, status_code=400)

    challenge_record = db.consume_challenge(challenge, "authentication")
    if not challenge_record:
        return JSONResponse({"error": "Authentication challenge expired."}, status_code=400)

    credential_id = credential.get("id")
    if not isinstance(credential_id, str) or not credential_id.strip():
        return JSONResponse({"error": "Unknown credential."}, status_code=400)

    stored = db.get_passkey_credential(credential_id)
    if not stored:
        return JSONResponse({"error": "Unknown credential."}, status_code=400)

    if challenge_record.user_id and stored.user_id != challenge_record.user_id:
        return JSONResponse({"error": "Invalid credentials."}, status_code=400)

    try:
        verified = verify_authentication(
            credential_payload=credential,
            expected_challenge=challenge_record.challenge,
            origin=origin,
            credential_id=stored.id,
            credential_public_key_b64=stored.public_key_b64,
            credential_sign_count=stored.sign_count,
        )
    except Exception:
        return JSONResponse({"error": "Authentication verification failed."}, status_code=400)

    db.update_passkey_counter(stored.id, verified["new_sign_count"])

    user = db.get_user_by_id(stored.user_id)
    if not user:
        return JSONResponse({"error": "User not found."}, status_code=404)

    return JSONResponse(create_user_session(user), status_code=200)


@app.post("/auth/refresh")
async def auth_refresh(payload: dict[str, Any]) -> JSONResponse:
    refresh_token = str(payload.get("refreshToken", "")).strip()
    if not refresh_token:
        return JSONResponse({"error": "refreshToken is required."}, status_code=400)

    refreshed = refresh_user_session(refresh_token)
    if not refreshed:
        return JSONResponse({"error": "Invalid or expired refresh token."}, status_code=401)

    return JSONResponse(refreshed, status_code=200)


@app.post("/auth/logout")
async def auth_logout(request: Request) -> PlainTextResponse:
    session_id = current_session_id(request)
    if session_id:
        db.revoke_session(session_id)
    return PlainTextResponse("", status_code=204)


@app.post("/auth/device/code")
async def auth_device_code() -> dict[str, Any]:
    db.cleanup_expired_device_codes()

    for _ in range(8):
        user_code = generate_user_code()
        device_code = generate_device_code()
        try:
            db.create_device_code(device_code, user_code, settings.device_code_ttl_sec)
            return {
                "deviceCode": device_code,
                "userCode": user_code,
                "verificationUrl": settings.device_verification_url,
                "expiresIn": settings.device_code_ttl_sec,
                "interval": settings.device_poll_interval_sec,
            }
        except Exception:
            continue

    raise HTTPException(status_code=500, detail="Failed to create device code.")


@app.post("/auth/device/authorise")
async def auth_device_authorise(request: Request, payload: dict[str, Any]) -> JSONResponse:
    user = require_authenticated_user(request)

    user_code = str(payload.get("userCode", "")).strip().upper()
    if not user_code:
        return JSONResponse({"error": "userCode is required."}, status_code=400)

    ok = db.authorise_device_code(user_code, user.id)
    if not ok:
        return JSONResponse({"error": "Code expired or not found."}, status_code=400)

    return JSONResponse({"ok": True}, status_code=200)


@app.post("/auth/device/token")
async def auth_device_token(payload: dict[str, Any]) -> JSONResponse:
    device_code = str(payload.get("deviceCode", "")).strip()
    if not device_code:
        return JSONResponse({"error": "deviceCode is required."}, status_code=400)

    record = db.consume_device_code(device_code)
    if not record:
        return JSONResponse({"status": "expired"}, status_code=200)

    if record.status != "authorised" or not record.user_id:
        return JSONResponse({"status": "pending"}, status_code=200)

    tokens = create_anchor_session(record.user_id)
    return JSONResponse(
        {
            "status": "authorised",
            "userId": record.user_id,
            **tokens,
        },
        status_code=200,
    )


@app.post("/auth/device/refresh")
async def auth_device_refresh(payload: dict[str, Any]) -> JSONResponse:
    refresh_token = str(payload.get("refreshToken", "")).strip()
    if not refresh_token:
        return JSONResponse({"error": "refreshToken is required."}, status_code=400)

    rotated = refresh_anchor_session(refresh_token)
    if not rotated:
        return JSONResponse({"error": "Invalid or expired refresh token."}, status_code=401)

    return JSONResponse(rotated, status_code=200)


def _extract_anchor_token(request: Request) -> str | None:
    token = parse_bearer_token(request.headers.get("authorization"))
    if token:
        return token
    return request.query_params.get("token")


def _authorize_request(request: Request, role: str) -> bool:
    if role == "client":
        token = extract_token_from_request(request)
        return bool(token and _verify_web_session_token(token))

    token = _extract_anchor_token(request)
    return bool(token and verify_anchor_any_token(token))


@app.get("/ws/client")
async def ws_client_preflight(request: Request):
    if not _authorize_request(request, "client"):
        return PlainTextResponse("Unauthorised", status_code=401)
    return PlainTextResponse("Upgrade required", status_code=426)


@app.get("/ws/anchor")
async def ws_anchor_preflight(request: Request):
    if not _authorize_request(request, "anchor"):
        return PlainTextResponse("Unauthorised", status_code=401)
    return PlainTextResponse("Upgrade required", status_code=426)


@app.websocket("/ws/client")
async def ws_client(websocket: WebSocket):
    token = websocket.query_params.get("token")
    if not token or not _verify_web_session_token(token):
        await websocket.close(code=1008, reason="Unauthorised")
        return

    client_id = websocket.query_params.get("clientId")

    await websocket.accept()
    await hub.register(websocket, "client", client_id=client_id)

    try:
        while True:
            message = await websocket.receive()
            if "text" in message and message["text"] is not None:
                await hub.handle_message(websocket, "client", message["text"])
            elif "bytes" in message and message["bytes"] is not None:
                await hub.handle_message(websocket, "client", message["bytes"].decode("utf-8", errors="ignore"))
    except WebSocketDisconnect:
        pass
    finally:
        await hub.unregister(websocket, "client")


@app.websocket("/ws/anchor")
async def ws_anchor(websocket: WebSocket):
    token = websocket.query_params.get("token")
    if not token or not verify_anchor_any_token(token):
        await websocket.close(code=1008, reason="Unauthorised")
        return

    await websocket.accept()
    await hub.register(websocket, "anchor", client_id=None)

    try:
        while True:
            message = await websocket.receive()
            if "text" in message and message["text"] is not None:
                await hub.handle_message(websocket, "anchor", message["text"])
            elif "bytes" in message and message["bytes"] is not None:
                await hub.handle_message(websocket, "anchor", message["bytes"].decode("utf-8", errors="ignore"))
    except WebSocketDisconnect:
        pass
    finally:
        await hub.unregister(websocket, "anchor")
