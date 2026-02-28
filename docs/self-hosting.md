# Self-Hosting

Codex Remote can be fully self-hosted on your own Cloudflare account. The `codex-remote self-host` wizard automates the entire process, but this page explains what it does and what you need beforehand.

## Prerequisites

- **macOS/Linux/Windows** with [Bun](https://bun.sh) and [Codex CLI](https://github.com/openai/codex) installed
- **A Cloudflare account** (the [free tier](https://www.cloudflare.com/plans/) is sufficient)
- **Codex Remote installed** via the [install script](installation.md)

The wizard uses [Wrangler](https://developers.cloudflare.com/workers/wrangler/) automatically: either your installed `wrangler` binary or managed mode via Bun (`bunx`).

## What gets deployed

The wizard deploys two services to your Cloudflare account:

| Service | Platform | Purpose |
|---------|----------|---------|
| **Orbit** | Cloudflare Worker + Durable Object | Passkey auth, JWT issuance, WebSocket relay between devices and Anchor |
| **Web** | Cloudflare Pages | Static Svelte frontend |

It also creates a shared **D1 database** (SQLite) for auth sessions and passkey credentials.

Orbit uses two generated JWT secrets (`CODEX_REMOTE_WEB_JWT_SECRET` and `CODEX_REMOTE_ANCHOR_JWT_SECRET`) that are set as Cloudflare secrets automatically.

## Running the wizard

```bash
codex-remote self-host
# or force post-setup login:
codex-remote self-host --login
```

You can run this either:

1. During `install.sh` or `install.ps1` when prompted, or
2. Later from your terminal with `codex-remote self-host`.

The wizard walks through 10 steps:

1. Validates local project files and required tools
2. Checks Bun + optional local tools (git/python), resolves Wrangler mode, and verifies Cloudflare login
3. Creates (or reuses) the D1 database
4. Updates `wrangler.toml` files with the database ID
5. Generates JWT and VAPID secrets
6. Runs database migrations
7. Deploys the Orbit worker and sets secrets
8. Builds and deploys the web frontend to Pages
9. Sets `PASSKEY_ORIGIN` and VAPID secrets
10. Writes the Anchor `.env` with Orbit URLs and database ID

At the end, it prints your deployment URLs and next steps.
By default, `codex-remote self-host` then asks whether to run `codex-remote login`; use `--login` or `--no-login` to force behavior.

## Failure behavior

`codex-remote self-host` now fails fast for critical deployment steps (migrations, worker deploy, Pages deploy, secret updates, final redeploy) and exits non-zero on failure.

If it fails, fix the reported issue and rerun `codex-remote self-host`. The flow is designed to be safely rerunnable.

## After deployment

1. Open your Pages URL (printed by the wizard) and create your account
2. Run `codex-remote start` to connect your local Anchor to your self-hosted Orbit

## Updating a self-hosted deployment

`codex-remote update` now redeploys web + orbit automatically when self-host settings are present in `.env`.

If `codex-remote update` fails on deploy, rerun the same command after fixing prerequisites (for example Wrangler auth), or redeploy manually:

```bash
# Redeploy orbit worker
(cd ~/.codex-remote/services/orbit && wrangler deploy)

# Rebuild and redeploy web frontend
(cd ~/.codex-remote && bun run build && wrangler pages deploy dist --project-name codex-remote)
```

## Architecture

See [architecture.md](architecture.md) for details on how the components communicate.
