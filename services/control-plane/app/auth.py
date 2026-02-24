from __future__ import annotations

import secrets
import time
from typing import Any

import jwt
from fastapi import HTTPException, Request, status

from .config import settings
from .db import User, db


def now_sec() -> int:
    return int(time.time())


def generate_user_code() -> str:
    chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    raw = "".join(secrets.choice(chars) for _ in range(8))
    return f"{raw[:4]}-{raw[4:]}"


def generate_device_code() -> str:
    return secrets.token_urlsafe(32)


def build_access_token(user: User, session_id: str) -> str:
    iat = now_sec()
    payload: dict[str, Any] = {
        "iss": "zane-auth",
        "aud": "zane-web",
        "sub": user.id,
        "name": user.name,
        "jti": session_id,
        "iat": iat,
        "exp": iat + settings.access_ttl_sec,
    }
    return jwt.encode(payload, settings.web_jwt_secret, algorithm="HS256")


def verify_web_token(token: str) -> dict[str, Any] | None:
    try:
        return jwt.decode(
            token,
            settings.web_jwt_secret,
            algorithms=["HS256"],
            audience="zane-web",
            issuer="zane-auth",
            options={"require": ["exp", "sub", "jti", "iss", "aud"]},
        )
    except jwt.PyJWTError:
        return None


def verify_anchor_jwt_legacy(token: str) -> dict[str, Any] | None:
    try:
        return jwt.decode(
            token,
            settings.anchor_jwt_secret,
            algorithms=["HS256"],
            audience="zane-orbit-anchor",
            issuer="zane-anchor",
            options={"require": ["exp", "sub", "iss", "aud"]},
        )
    except jwt.PyJWTError:
        return None


def verify_anchor_access_token(token: str) -> dict[str, Any] | None:
    session = db.get_active_anchor_session_by_access_token(token)
    if not session:
        return None
    return {"sub": session.user_id, "exp": session.access_expires_at, "sid": session.id, "kind": "opaque"}


def parse_bearer_token(auth_header: str | None) -> str | None:
    if not auth_header:
        return None
    if not auth_header.lower().startswith("bearer "):
        return None
    token = auth_header[7:].strip()
    return token or None


def extract_token_from_request(request: Request) -> str | None:
    token = parse_bearer_token(request.headers.get("authorization"))
    if token:
        return token
    query_token = request.query_params.get("token")
    return query_token or None


def get_authenticated_user(request: Request) -> User | None:
    token = extract_token_from_request(request)
    if not token:
        return None

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

    return db.get_user_by_id(sub)


def require_authenticated_user(request: Request) -> User:
    user = get_authenticated_user(request)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.")
    return user


def current_session_id(request: Request) -> str | None:
    token = extract_token_from_request(request)
    if not token:
        return None

    payload = verify_web_token(token)
    if not payload:
        return None

    jti = payload.get("jti")
    return jti if isinstance(jti, str) else None


def create_user_session(user: User) -> dict[str, Any]:
    session, refresh_token = db.create_session(user.id)
    token = build_access_token(user, session.id)
    return {
        "verified": True,
        "token": token,
        "refreshToken": refresh_token,
        "user": {"id": user.id, "name": user.name},
    }


def refresh_user_session(refresh_token: str) -> dict[str, Any] | None:
    rotated = db.rotate_refresh(refresh_token)
    if not rotated:
        return None

    session, new_refresh = rotated
    user = db.get_user_by_id(session.user_id)
    if not user:
        return None

    token = build_access_token(user, session.id)
    return {
        "token": token,
        "refreshToken": new_refresh,
        "user": {"id": user.id, "name": user.name},
    }


def create_anchor_session(user_id: str) -> dict[str, Any]:
    record, access_token, refresh_token = db.create_anchor_session(user_id)
    return {
        "anchorAccessToken": access_token,
        "anchorRefreshToken": refresh_token,
        "anchorAccessExpiresIn": max(record.access_expires_at - now_sec(), 0),
    }


def refresh_anchor_session(refresh_token: str) -> dict[str, Any] | None:
    rotated = db.rotate_anchor_refresh(refresh_token)
    if not rotated:
        return None

    record, access_token, new_refresh = rotated
    return {
        "anchorAccessToken": access_token,
        "anchorRefreshToken": new_refresh,
        "anchorAccessExpiresIn": max(record.access_expires_at - now_sec(), 0),
    }


def verify_anchor_any_token(token: str) -> dict[str, Any] | None:
    opaque = verify_anchor_access_token(token)
    if opaque:
        return opaque
    return verify_anchor_jwt_legacy(token)
