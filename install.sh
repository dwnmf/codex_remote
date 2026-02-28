#!/usr/bin/env bash
set -euo pipefail

# ── Codex Remote Installer ──────────────────────────────
# Usage: curl -fsSL https://raw.githubusercontent.com/dwnmf/codex_remote/main/install.sh | bash

CODEX_REMOTE_HOME="${CODEX_REMOTE_HOME:-$HOME/.codex-remote}"
CODEX_REMOTE_REPO="${CODEX_REMOTE_REPO:-https://github.com/dwnmf/codex_remote.git}"
CODEX_REMOTE_BRANCH="${CODEX_REMOTE_BRANCH:-}"
CODEX_REMOTE_RUN_SELF_HOST="${CODEX_REMOTE_RUN_SELF_HOST:-0}"

# ── Colors ──────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

pass()  { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
fail()  { printf "  ${RED}✗${RESET} %s\n" "$1"; }
warn()  { printf "  ${YELLOW}⚠${RESET} %s\n" "$1"; }
step()  { printf "\n${BOLD}%s${RESET}\n" "$1"; }

abort() {
  printf "\n${RED}Error: %s${RESET}\n" "$1"
  exit 1
}

retry() {
  local attempts="$1" delay="$2" desc="$3"
  shift 3
  local i
  for ((i = 1; i <= attempts; i++)); do
    if "$@"; then
      return 0
    fi
    if ((i < attempts)); then
      warn "$desc failed (attempt $i/$attempts) — retrying in ${delay}s..."
      sleep "$delay"
    fi
  done
  return 1
}

resolve_origin_branch() {
  local repo="$1"
  local remote_head
  remote_head=$(git -C "$repo" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
  if [[ -n "$remote_head" ]]; then
    printf "%s" "${remote_head#origin/}"
    return
  fi
  printf "main"
}

ensure_env_file() {
  if [[ -f "$CODEX_REMOTE_HOME/.env" ]]; then
    return 0
  fi
  if [[ -f "$CODEX_REMOTE_HOME/.env.example" ]]; then
    cp "$CODEX_REMOTE_HOME/.env.example" "$CODEX_REMOTE_HOME/.env"
    pass "Created .env from .env.example"
    return 0
  fi

  cat > "$CODEX_REMOTE_HOME/.env" <<ENVEOF
# Codex Remote Anchor Configuration (self-host)
# Run 'codex-remote self-host' to complete setup.
ANCHOR_PORT=8788
ANCHOR_ORBIT_URL=
AUTH_URL=
ANCHOR_JWT_TTL_SEC=300
ANCHOR_APP_CWD=
ENVEOF
  warn ".env.example not found; created a minimal .env file."
}

# ── Cleanup on failure ──────────────────────────
cleanup() {
  if [[ $? -ne 0 ]]; then
    echo ""
    warn "Installation failed. Partial files may exist at $CODEX_REMOTE_HOME"
  fi
}
trap cleanup EXIT

# ── Banner ──────────────────────────────────────
echo ""
printf "${BOLD}Codex Remote Installer${RESET}\n"
echo ""

# ── Check OS ────────────────────────────────────
case "$(uname -s)" in
  Darwin)
    platform_label="macOS"
    ;;
  Linux)
    platform_label="Linux"
    ;;
  *)
    abort "Unsupported OS: $(uname -s). Supported: macOS, Linux. Use install.ps1 on Windows."
    ;;
esac
pass "$platform_label detected"

# ── Check git ───────────────────────────────────
step "Checking prerequisites..."

if command -v git &>/dev/null; then
  pass "git installed"
else
  if [[ "$platform_label" == "macOS" ]]; then
    warn "git not found. Installing Xcode Command Line Tools..."
    xcode-select --install 2>/dev/null || true
    echo "   Please complete the Xcode CLT installation and re-run this script."
  else
    echo "   Please install git with your package manager and re-run this script."
    echo "   Example: sudo apt-get update && sudo apt-get install -y git"
  fi
  exit 1
fi

# ── Check/install Bun ───────────────────────────
if command -v bun &>/dev/null; then
  pass "bun $(bun --version)"
else
  warn "bun not found. Installing automatically..."
  if ! command -v curl &>/dev/null; then
    abort "curl is required to install bun automatically. Install curl and rerun."
  fi
  retry 3 3 "bun install" bash -c 'curl -fsSL https://bun.sh/install | bash' \
    || abort "Failed to install bun automatically. Install manually: https://bun.sh"
  # Source bun into current shell
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if command -v bun &>/dev/null; then
    pass "bun installed ($(bun --version))"
  else
    abort "Failed to add bun to PATH. Restart terminal and rerun installer."
  fi
fi

# ── Check/install codex CLI ─────────────────────
if command -v codex &>/dev/null; then
  pass "codex CLI installed"
else
  warn "codex CLI not found"
  echo ""
  echo "  The codex CLI is required to run Codex Remote."
  echo ""
  if command -v brew &>/dev/null; then
    info "  Installing codex via Homebrew..."
    retry 3 3 "codex install" brew install codex \
      || abort "Failed to install codex via Homebrew."
    if command -v codex &>/dev/null; then
      pass "codex installed"
    else
      abort "Failed to install codex."
    fi
  else
    echo "  Install codex manually and re-run this script."
    echo "  See: https://github.com/openai/codex"
    exit 1
  fi
fi

# ── Check codex authentication ──────────────────
echo ""
echo "  Checking codex authentication..."
if codex login status &>/dev/null; then
  pass "codex authenticated"
else
  warn "codex is not authenticated. Launching 'codex login'..."
  codex login
  if codex login status &>/dev/null; then
    pass "codex authenticated"
  else
    abort "codex authentication failed. Complete 'codex login' and rerun installer."
  fi
fi

# ── Clone/update repo ──────────────────────────
step "Installing Codex Remote to $CODEX_REMOTE_HOME..."

if [[ -d "$CODEX_REMOTE_HOME/.git" ]]; then
  echo "  Existing installation found. Updating..."
  if [[ -n "$(git -C "$CODEX_REMOTE_HOME" status --porcelain)" ]]; then
    warn "Local changes detected and will be overwritten."
  fi
  warn "Resetting local checkout to the remote branch state."

  retry 3 3 "git fetch" git -C "$CODEX_REMOTE_HOME" fetch --prune origin \
    || abort "Failed to fetch updates from origin."

  target_branch="$CODEX_REMOTE_BRANCH"
  if [[ -z "$target_branch" ]]; then
    target_branch=$(resolve_origin_branch "$CODEX_REMOTE_HOME")
  fi

  if ! git -C "$CODEX_REMOTE_HOME" show-ref --verify --quiet "refs/remotes/origin/$target_branch"; then
    abort "Remote branch origin/$target_branch not found."
  fi

  before=$(git -C "$CODEX_REMOTE_HOME" rev-parse --short HEAD 2>/dev/null || echo "unknown")
  git -C "$CODEX_REMOTE_HOME" reset --hard --quiet "origin/$target_branch"
  git -C "$CODEX_REMOTE_HOME" clean -fd --quiet
  after=$(git -C "$CODEX_REMOTE_HOME" rev-parse --short HEAD 2>/dev/null || echo "unknown")
  pass "Updated $before -> $after (origin/$target_branch)"
else
  if [[ -d "$CODEX_REMOTE_HOME" ]]; then
    warn "$CODEX_REMOTE_HOME exists but is not a git repo. Backing up..."
    mv "$CODEX_REMOTE_HOME" "$CODEX_REMOTE_HOME.bak.$(date +%s)"
  fi
  if [[ -n "$CODEX_REMOTE_BRANCH" ]]; then
    retry 3 3 "git clone" git clone --depth 1 --branch "$CODEX_REMOTE_BRANCH" "$CODEX_REMOTE_REPO" "$CODEX_REMOTE_HOME" \
      || abort "Failed to clone $CODEX_REMOTE_REPO ($CODEX_REMOTE_BRANCH)."
  else
    retry 3 3 "git clone" git clone --depth 1 "$CODEX_REMOTE_REPO" "$CODEX_REMOTE_HOME" \
      || abort "Failed to clone $CODEX_REMOTE_REPO."
  fi
  pass "Cloned repository"
fi

# ── Install anchor dependencies ─────────────────
echo "  Installing anchor dependencies..."
retry 3 3 "Anchor dependency install" bash -c 'cd "$1/services/anchor" && bun install --silent' _ "$CODEX_REMOTE_HOME" \
  || abort "Failed to install Anchor dependencies."
pass "Anchor dependencies installed"

# ── Install CLI ─────────────────────────────────
step "Installing CLI..."

mkdir -p "$CODEX_REMOTE_HOME/bin"

cli_src="$CODEX_REMOTE_HOME/bin/codex-remote"
if [[ ! -f "$cli_src" ]]; then
  abort "CLI script not found at $cli_src"
fi

chmod +x "$cli_src"
pass "CLI installed at $CODEX_REMOTE_HOME/bin/codex-remote"

# Add to PATH
path_line="export PATH=\"$CODEX_REMOTE_HOME/bin:\$PATH\""
added_to=""

for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
  if [[ -f "$rc" ]]; then
    if ! grep -q 'codex-remote/bin' "$rc"; then
      echo "" >> "$rc"
      echo "# Codex Remote" >> "$rc"
      echo "$path_line" >> "$rc"
      added_to="${added_to} $(basename "$rc")"
    fi
  fi
done

# If neither rc file existed, create .profile (portable default)
if [[ -z "$added_to" ]]; then
  echo "" >> "$HOME/.profile"
  echo "# Codex Remote" >> "$HOME/.profile"
  echo "$path_line" >> "$HOME/.profile"
  added_to=" .profile"
fi

# Make it available in the current shell
export PATH="$CODEX_REMOTE_HOME/bin:$PATH"

pass "Added to PATH in$added_to"

# ── Self-host setup ────────────────────────────
step "Self-host setup"
provider="${CODEX_REMOTE_SELF_HOST_PROVIDER:-cloudflare}"
case "$provider" in
  cloudflare) local_wizard="$CODEX_REMOTE_HOME/bin/self-host.sh" ;;
  deno) local_wizard="$CODEX_REMOTE_HOME/bin/self-host-deno.sh" ;;
  *)
    warn "Unsupported CODEX_REMOTE_SELF_HOST_PROVIDER='$provider'. Falling back to cloudflare."
    provider="cloudflare"
    local_wizard="$CODEX_REMOTE_HOME/bin/self-host.sh"
    ;;
esac
if [[ ! -f "$local_wizard" ]]; then
  warn "Self-host wizard not found at $local_wizard"
  ensure_env_file
  warn "Run 'codex-remote self-host' after installation."
elif [[ "$CODEX_REMOTE_RUN_SELF_HOST" == "1" ]]; then
  printf "  ${DIM}Deploying with provider '%s'...${RESET}\n" "$provider"
  export CODEX_REMOTE_SELF_HOST_PROVIDER="$provider"
  # shellcheck source=/dev/null
  source "$local_wizard"
else
  ensure_env_file
  echo "  Skipped cloud deployment. Set CODEX_REMOTE_RUN_SELF_HOST=1 to run it during install."
fi

# ── Done ────────────────────────────────────────
echo ""
printf "${GREEN}${BOLD}Codex Remote installed successfully!${RESET}\n"
echo ""
echo "  Get started:"
printf "    ${BOLD}codex-remote start${RESET}    Start the anchor service\n"
printf "    ${BOLD}codex-remote doctor${RESET}   Check your setup\n"
printf "    ${BOLD}codex-remote config${RESET}   Edit configuration\n"
printf "    ${BOLD}codex-remote help${RESET}     See all commands\n"
echo ""
echo "  You may need to restart your terminal or run:"
if [[ "$platform_label" == "macOS" ]]; then
  echo "    source ~/.zshrc"
else
  echo "    source ~/.profile"
fi
echo ""
