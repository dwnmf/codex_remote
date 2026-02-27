# Auth Overview

This app uses passkeys and TOTP for user authentication, plus JWTs for service-to-service auth.

## Components

- Web client (Svelte)
- Orbit (Cloudflare Worker + Durable Object) for passkey auth and WS relay
- Anchor (local Bun service) bridging Orbit to `codex app-server`

## JWTs and secrets

Two separate secrets are used:

- `CODEX_REMOTE_WEB_JWT_SECRET` signs **user session** JWTs (issuer `codex-remote-auth`, audience `codex-remote-web`)
- `CODEX_REMOTE_ANCHOR_JWT_SECRET` signs **Anchor** service JWTs (issuer `codex-remote-anchor`, audience `codex-remote-orbit-anchor`)

Orbit accepts either token depending on audience/issuer.

User JWTs are also stored server-side in `auth_sessions` for revocation and expiry checks.

## Request flows

### Passkey login

1) Web client calls Orbit auth endpoints to register or sign in:
   - `POST /auth/register/options` + `POST /auth/register/verify`
   - `POST /auth/login/options` + `POST /auth/login/verify`
2) Orbit returns a JWT and a refresh token, both signed with `CODEX_REMOTE_WEB_JWT_SECRET`.
3) Client stores both tokens in `localStorage`.
4) Orbit stores the session id (`jti`) in D1.
5) When the JWT expires, the client calls `POST /auth/refresh` with the refresh token to get a new JWT and rotated refresh token.

### TOTP login and registration

1) Web client can register with TOTP:
   - `POST /auth/register/totp/start`
   - `POST /auth/register/totp/verify`
2) Web client can sign in with TOTP:
   - `POST /auth/login/totp`
3) Optional setup for already signed-in users:
   - `POST /auth/totp/setup/options`
   - `POST /auth/totp/setup/verify`
4) TOTP factors are stored in D1 (`totp_factors`) with replay protection (`last_used_step`).

### Device code login (Anchor CLI)

1) Anchor requests a device code via `POST /auth/device/code`.
2) A user code is displayed in the terminal and a browser opens.
3) User enters the code on the web client, which calls `POST /auth/device/authorise`.
4) Anchor polls `POST /auth/device/token` until authorised, then receives a JWT.
5) Credentials are saved to `CODEX_REMOTE_CREDENTIALS_FILE` (default: `~/.codex-remote/credentials.json`).

### Web client to Orbit

1) Client connects to Orbit WS using:
   - `wss://.../ws/client?token=<jwt>`
2) Orbit verifies the JWT (issuer `codex-remote-auth`, audience `codex-remote-web`).

### Anchor to Orbit

1) Anchor mints a short-lived JWT using `CODEX_REMOTE_ANCHOR_JWT_SECRET`.
2) Anchor connects to:
   - `wss://.../ws/anchor?token=<jwt>`
3) Orbit verifies the JWT (issuer `codex-remote-anchor`, audience `codex-remote-orbit-anchor`).

### Anchor to app-server

1) Anchor spawns `codex app-server`.
2) Anchor sends an `initialize` JSON-RPC request with:
   - `cwd` (from `ANCHOR_APP_CWD`)
   - `clientInfo`

## Required configuration

Orbit auth:
- `PASSKEY_ORIGIN`
- `CODEX_REMOTE_WEB_JWT_SECRET`

Orbit:
- `CODEX_REMOTE_WEB_JWT_SECRET`
- `CODEX_REMOTE_ANCHOR_JWT_SECRET` (required if Anchor connects remotely)

Anchor:
- `CODEX_REMOTE_ANCHOR_JWT_SECRET`
- `ANCHOR_ORBIT_URL`
- `ANCHOR_APP_CWD` (optional, defaults to `process.cwd()`)

Client:
- `AUTH_URL` (typically the same host as Orbit in self-host mode)

## Common issues

- `Orbit unavailable` in the client: `PASSKEY_ORIGIN` does not match your web origin, or `AUTH_URL` is incorrect.
- `401` from Orbit WS: mismatched or missing JWT secret.
- `Not initialized` JSON-RPC errors: app-server did not receive `initialize` or rejected params.
- Wrong project files: `ANCHOR_APP_CWD` set to the wrong path.

## Security notes

- JWTs are sent in WS query params for browser compatibility; they may appear in logs.
- User JWTs live in `localStorage` and last 7 days; server-side revocation requires calling `/auth/logout`.
- Multiple users can register. The first user sees a streamlined setup screen; subsequent users see the normal login/register page.
