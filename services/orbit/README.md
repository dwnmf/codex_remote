# Orbit

Cloudflare Worker + Durable Object service for auth + relay between Anchor and the web client.

## Run (local)

```bash
cd services/orbit
bun install
bun run dev
```

## Endpoints

- `GET /health`
- `GET /auth/session`
- `POST /auth/*` (passkey + device code flows)
- `GET /ws/client`
- `GET /ws/anchor`

## Auth

Orbit expects a passkey session JWT from its auth endpoints:

- `Authorization: Bearer <jwt>` header, or
- `?token=<jwt>` query param (for browsers)

For Anchor service-to-service auth, set `CODEX_REMOTE_ANCHOR_JWT_SECRET` and use a JWT with:

- `iss: "codex-remote-anchor"`
- `aud: "codex-remote-orbit-anchor"`

## D1 setup

Setup:

1. Create a D1 database (example name `codex-remote-orbit`).
2. Update `wrangler.toml` with the real `database_id`.
3. Apply migrations:

```bash
bunx wrangler d1 migrations apply codex-remote-orbit --remote
```
