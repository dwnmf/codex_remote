# FastAPI Control Plane

This guide describes the lightweight alternative to Cloudflare Orbit:

- static frontend on Vercel (or any static host)
- FastAPI backend for auth + websocket relay
- Anchor on macOS/Linux/Windows

## 1) Run the backend

```bash
cd services/control-plane
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\\Scripts\\activate
pip install -r requirements.txt
export AUTH_MODE=basic
export ZANE_WEB_JWT_SECRET=change-me
export CORS_ORIGINS=https://your-frontend.vercel.app,http://localhost:5173
export DEVICE_VERIFICATION_URL=https://your-frontend.vercel.app/device
# passkey mode only:
# export AUTH_MODE=passkey
# export PASSKEY_ORIGIN=https://your-frontend.vercel.app
# export PASSKEY_RP_ID=your-frontend.vercel.app
uvicorn app.main:app --host 0.0.0.0 --port 8080
```

## 2) Build/deploy frontend

Set frontend build env:

- `AUTH_URL=https://<your-fastapi-domain>`
- `AUTH_MODE=passkey` (recommended) or `AUTH_MODE=basic` (quick dev)

Then build and deploy as static site.

## 3) Run Anchor

Set Anchor env:

- `ANCHOR_ORBIT_URL=wss://<your-fastapi-domain>/ws/anchor`
- `AUTH_URL=https://<your-fastapi-domain>`

Run:

```bash
zane start
```

Anchor will use device code login and connect to FastAPI relay.

## Notes

- In `AUTH_MODE=passkey`, frontend passkey login/register works via `/auth/*/options|verify`.
- In `AUTH_MODE=basic`, frontend uses username-only flow for fast local testing.
- Anchor device auth uses opaque access/refresh tokens (`/auth/device/token` + `/auth/device/refresh`), not shared signing secrets.
- For production, use strong secrets and HTTPS/WSS only.
- Full endpoint reference for this service is in [`services/control-plane/README.md`](../services/control-plane/README.md).
