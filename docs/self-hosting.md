# Self-Hosting

Codex Remote can be fully self-hosted with either `cloudflare` or `deno` provider. The `codex-remote self-host` wizard automates deployment for both.

## Prerequisites

- **macOS/Linux/Windows** with [Bun](https://bun.sh) and [Codex CLI](https://github.com/openai/codex) installed
- One provider account:
  - **Cloudflare** (free tier is enough)
  - **Deno Deploy** (free tier is enough)
- **Codex Remote installed** via the [install script](installation.md)

Provider runtimes used by the wizard:
- `cloudflare`: [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (installed or managed via Bun)
- `deno`: `deployctl` (installed globally or run via `deno run -A jsr:@deno/deployctl`)
  - authentication via `DENO_DEPLOY_TOKEN` (the wizard validates token access and can prompt for it)
  - note: `deployctl` currently targets Deno Deploy Classic orgs

## What gets deployed

The wizard deploys:

| Service | Platform | Purpose |
|---------|----------|---------|
| **Orbit** | Cloudflare Worker + Durable Object or Deno Deploy runtime | Passkey auth, JWT issuance, WebSocket relay between devices and Anchor |
| **Web** | Cloudflare Pages or Deno Deploy static assets | Static Svelte frontend |

For `cloudflare`, the wizard also creates/uses shared **D1**.
For `deno`, auth/session state is stored in **Deno KV**.

Orbit uses generated JWT secrets for web/anchor flows. They are wired into provider deployment env automatically.

## Running the wizard

```bash
codex-remote self-host --provider cloudflare
# or:
codex-remote self-host --provider deno
# force post-setup login:
codex-remote self-host --provider deno --login
```

You can run this either:

1. During `install.sh` or `install.ps1` when prompted, or
2. Later from your terminal with `codex-remote self-host --provider ...`.

The provider wizard flow:

1. Validates local project files and required tools
2. Checks Bun and provider tools (`wrangler` or `deployctl`)
3. For `deno`, validates `DENO_DEPLOY_TOKEN` (from environment / `.env` / interactive prompt)
4. Generates JWT and VAPID secrets
5. Deploys Orbit backend
6. Builds frontend with provider `AUTH_URL`
7. Deploys static web
8. Writes Anchor `.env` with provider-specific values

At the end, it prints your deployment URLs and next steps.
By default, `codex-remote self-host` then asks whether to run `codex-remote login`; use `--login` or `--no-login` to force behavior.

## Failure behavior

`codex-remote self-host` fails fast for critical deploy steps and exits non-zero on failure.

If it fails, fix the reported issue and rerun `codex-remote self-host`. The flow is designed to be safely rerunnable.

## After deployment

1. Open your app URL (printed by the wizard) and create your account
2. Run `codex-remote start` to connect your local Anchor to your self-hosted Orbit

## Updating a self-hosted deployment

`codex-remote update` redeploys web + orbit automatically for the selected provider (`SELF_HOST_PROVIDER` in `.env`).

If `codex-remote update` fails, rerun after fixing prerequisites (for example provider auth), or redeploy manually:

```bash
# Cloudflare manual redeploy example
# Redeploy orbit worker
(cd ~/.codex-remote/services/orbit && wrangler deploy)

# Rebuild and redeploy web frontend
(cd ~/.codex-remote && bun run build && wrangler pages deploy dist --project-name codex-remote)
```

## Architecture

See [architecture.md](architecture.md) for details on how the components communicate.
