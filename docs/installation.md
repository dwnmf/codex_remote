# Installing Codex Remote

Codex Remote runs a local Anchor service on your machine that connects to Orbit (the hosted control plane) so you can supervise Codex sessions remotely.

## Requirements

- macOS or Linux for the `install.sh` flow
- Windows for the `install.ps1` flow
- Internet access for dependency bootstrap

`install.ps1` supports two modes:
- `source` mode: clone repo + Bun runtime (requires `git` + `bun`)
- `release` mode: download prebuilt Windows release package (does not require `git` or `bun` on the client)

Default mode is `auto`:
- if both `git` and `bun` are already present, installer uses `source`
- otherwise installer uses `release`

The installer always ensures [Codex CLI](https://github.com/openai/codex) is available and runs `codex login`.

For a lighter backend alternative, see: [FastAPI Control Plane](fastapi-control-plane.md).

## Install

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/dwnmf/codex_remote/main/install.sh | bash
```

Windows (PowerShell):

```powershell
iwr -useb https://raw.githubusercontent.com/dwnmf/codex_remote/main/install.ps1 | iex
```

To force a specific mode:

```powershell
$env:CODEX_REMOTE_INSTALL_MODE="release"   # or "source"
iwr -useb https://raw.githubusercontent.com/dwnmf/codex_remote/main/install.ps1 | iex
```

In release mode, installer downloads `codex-remote-windows-x64.zip` from GitHub Releases to `~/.codex-remote`, installs CLI wrappers, and uses the bundled `anchor.exe`.

To run self-host setup during install:

```bash
CODEX_REMOTE_RUN_SELF_HOST=1 curl -fsSL https://raw.githubusercontent.com/dwnmf/codex_remote/main/install.sh | bash
```

### Build from source

```bash
git clone https://github.com/dwnmf/codex_remote.git ~/.codex-remote
cd ~/.codex-remote/services/anchor && bun install
```

Add `~/.codex-remote/bin` to your PATH.

## Setup

1. If you skipped deployment during install, run `codex-remote self-host --provider cloudflare --login` (or `--provider deno`)
2. Run `codex-remote start` (or `codex-remote login` to re-authenticate)
3. A device code is displayed in your terminal
4. A browser window opens to enter the code
5. Once authorised, credentials are saved to `~/.codex-remote/credentials.json`

## Running

Start Anchor:
```bash
codex-remote start
```

Anchor connects to Orbit and waits for commands from the web client. Open the Codex Remote web app in your browser to start supervising sessions.

## CLI Commands

| Command | Description |
|---------|-------------|
| `codex-remote start` | Start the anchor service |
| `codex-remote login` | Re-authenticate with the web app |
| `codex-remote doctor` | Check prerequisites and configuration |
| `codex-remote config` | Open `.env` in your editor |
| `codex-remote update` | Pull latest code and reinstall dependencies |
| `codex-remote self-host [--provider cloudflare\|deno] [--login\|--no-login]` | Run the self-host setup wizard, choose provider, and control post-setup login |
| `codex-remote uninstall` | Remove Codex Remote from your system |
| `codex-remote version` | Print version |
| `codex-remote help` | Show help |

## Verify

Check that everything is configured correctly:
```bash
codex-remote doctor
```

This checks for Bun, Codex CLI, Anchor source, dependencies, `.env` configuration, credentials, and whether Anchor is running.

## Updating

```bash
codex-remote update
```

This resets local repo changes, pulls the latest code, reinstalls Anchor dependencies, and redeploys self-host services (Cloudflare or Deno) when self-host settings are present.

## Self-hosting

To deploy the entire stack to your own provider:

```bash
codex-remote self-host --provider cloudflare
# or:
codex-remote self-host --provider deno
```

See the [self-hosting guide](self-hosting.md) for prerequisites and a full walkthrough.

## Troubleshooting

### "codex-remote: command not found"
Make sure `~/.codex-remote/bin` is in your PATH:
```bash
echo 'export PATH="$HOME/.codex-remote/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### Connection issues
Re-authenticate:
```bash
codex-remote login
```

### Check configuration
```bash
codex-remote doctor
```
