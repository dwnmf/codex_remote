# FastAPI Control Plane

Lightweight replacement for Orbit when you want a simpler self-hosted stack.

## What is implemented

- `GET /health`
- `GET /auth/session`
- `POST /auth/register/basic`
- `POST /auth/login/basic`
- `POST /auth/register/options` (passkey mode)
- `POST /auth/register/verify` (passkey mode)
- `POST /auth/login/options` (passkey mode)
- `POST /auth/login/verify` (passkey mode)
- `POST /auth/refresh`
- `POST /auth/logout`
- `POST /auth/device/code`
- `POST /auth/device/authorise`
- `POST /auth/device/token`
- `POST /auth/device/refresh`
- `GET /ws/client` and `GET /ws/anchor` preflight (`426` on valid auth)
- `WS /ws/client`
- `WS /ws/anchor`

Realtime behavior mirrors Orbit basics:

- `orbit.subscribe` / `orbit.unsubscribe`
- `orbit.list-anchors`
- `anchor.hello`, `orbit.anchor-connected`, `orbit.anchor-disconnected`
- thread-scoped routing from anchor to clients

## Run locally

```bash
cd services/control-plane
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\\Scripts\\activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8080
```

## Env vars

- `AUTH_MODE=passkey` or `AUTH_MODE=basic`
- `CODEX_REMOTE_WEB_JWT_SECRET=change-me`
- `DATABASE_PATH=./data/control_plane.db`
- `CORS_ORIGINS=https://your-frontend.vercel.app,http://localhost:5173`
- `DEVICE_VERIFICATION_URL=https://your-frontend.vercel.app/device`
- `ACCESS_TTL_SEC=3600`
- `REFRESH_TTL_SEC=604800`
- `DEVICE_CODE_TTL_SEC=600`
- `DEVICE_CODE_POLL_INTERVAL_SEC=5`
- `ANCHOR_ACCESS_TTL_SEC=86400`
- `ANCHOR_REFRESH_TTL_SEC=2592000`

Passkey mode vars:

- `PASSKEY_ORIGIN=https://your-frontend.vercel.app`
- `PASSKEY_RP_ID=your-frontend.vercel.app` (optional; derived from origin if omitted)
- `CHALLENGE_TTL_SEC=300`

## Frontend setup

Build frontend with:

- `AUTH_URL=https://<your-fastapi-domain>`
- `AUTH_MODE=passkey` (or `basic` for quick local setup)

## Anchor setup

Point anchor to FastAPI endpoints:

- `ANCHOR_ORBIT_URL=wss://<your-fastapi-domain>/ws/anchor`
- `AUTH_URL=https://<your-fastapi-domain>`

Anchor obtains opaque device access tokens from `/auth/device/token` and refreshes via `/auth/device/refresh` (no shared JWT signing secret on the device). Legacy `anchorJwtSecret` flow is accepted for backward compatibility.
