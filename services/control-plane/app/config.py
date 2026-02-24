from __future__ import annotations

import os
from dataclasses import dataclass


def _parse_origins(value: str) -> list[str]:
    cleaned = [part.strip() for part in value.split(",") if part.strip()]
    return cleaned or ["*"]


@dataclass(frozen=True)
class Settings:
    auth_mode: str
    web_jwt_secret: str
    anchor_jwt_secret: str
    access_ttl_sec: int
    refresh_ttl_sec: int
    cors_origins: list[str]
    database_path: str
    device_code_ttl_sec: int
    device_poll_interval_sec: int
    device_verification_url: str
    challenge_ttl_sec: int
    passkey_origin: str
    passkey_rp_id: str
    anchor_access_ttl_sec: int
    anchor_refresh_ttl_sec: int


settings = Settings(
    auth_mode=os.getenv("AUTH_MODE", "basic").strip().lower() or "basic",
    web_jwt_secret=os.getenv("ZANE_WEB_JWT_SECRET", "dev-web-secret-change-me").strip() or "dev-web-secret-change-me",
    anchor_jwt_secret=os.getenv("ZANE_ANCHOR_JWT_SECRET", "dev-anchor-secret-change-me").strip()
    or "dev-anchor-secret-change-me",
    access_ttl_sec=max(int(os.getenv("ACCESS_TTL_SEC", "3600")), 60),
    refresh_ttl_sec=max(int(os.getenv("REFRESH_TTL_SEC", "604800")), 300),
    cors_origins=_parse_origins(os.getenv("CORS_ORIGINS", "*")),
    database_path=os.getenv("DATABASE_PATH", "./data/control_plane.db").strip() or "./data/control_plane.db",
    device_code_ttl_sec=max(int(os.getenv("DEVICE_CODE_TTL_SEC", "600")), 60),
    device_poll_interval_sec=max(int(os.getenv("DEVICE_CODE_POLL_INTERVAL_SEC", "5")), 1),
    device_verification_url=os.getenv("DEVICE_VERIFICATION_URL", "http://localhost:5173/device").strip()
    or "http://localhost:5173/device",
    challenge_ttl_sec=max(int(os.getenv("CHALLENGE_TTL_SEC", "300")), 60),
    passkey_origin=os.getenv("PASSKEY_ORIGIN", "").strip(),
    passkey_rp_id=os.getenv("PASSKEY_RP_ID", "").strip(),
    anchor_access_ttl_sec=max(int(os.getenv("ANCHOR_ACCESS_TTL_SEC", "86400")), 300),
    anchor_refresh_ttl_sec=max(int(os.getenv("ANCHOR_REFRESH_TTL_SEC", "2592000")), 3600),
)
