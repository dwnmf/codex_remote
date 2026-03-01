#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
DEFAULT_HOME="${HOME}/.codex-remote"
if [[ -n "${CODEX_REMOTE_HOME:-}" ]]; then
  CODEX_REMOTE_HOME="$CODEX_REMOTE_HOME"
elif [[ -d "$REPO_ROOT/services/orbit-deno" ]]; then
  CODEX_REMOTE_HOME="$REPO_ROOT"
elif [[ -d "$DEFAULT_HOME/services/orbit-deno" ]]; then
  CODEX_REMOTE_HOME="$DEFAULT_HOME"
else
  CODEX_REMOTE_HOME="$DEFAULT_HOME"
fi
ENV_FILE="$CODEX_REMOTE_HOME/.env"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
RESET='\033[0m'

pass()  { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
warn()  { printf "  ${YELLOW}⚠${RESET} %s\n" "$1"; }
step()  { printf "\n${BOLD}%s${RESET}\n" "$1"; }

abort() {
  printf "\n${RED}Error: %s${RESET}\n" "$1"
  exit 1
}

confirm() {
  local prompt="$1"
  [[ -r /dev/tty ]] || abort "Interactive setup requires a TTY."
  printf "%s [Y/n] " "$prompt"
  read -r answer < /dev/tty
  [[ -z "$answer" || "$answer" =~ ^[Yy] ]]
}

retry_capture() {
  local attempts="$1" delay="$2" desc="$3"
  shift 3
  local i out status
  RETRY_LAST_OUTPUT=""
  for ((i = 1; i <= attempts; i++)); do
    out=$("$@" 2>&1) && {
      RETRY_LAST_OUTPUT="$out"
      return 0
    }
    status=$?
    RETRY_LAST_OUTPUT="$out"
    if ((i < attempts)); then
      warn "$desc failed (attempt $i/$attempts) — retrying in ${delay}s..."
      sleep "$delay"
    fi
  done
  return "${status:-1}"
}

can_run_deployctl() {
  command -v deployctl &>/dev/null || command -v deno &>/dev/null
}

run_deployctl() {
  if command -v deployctl &>/dev/null; then
    deployctl "$@"
    return $?
  fi
  if command -v deno &>/dev/null; then
    deno run -A jsr:@deno/deployctl "$@"
    return $?
  fi
  echo "deployctl is unavailable (install deployctl or deno)." >&2
  return 127
}

deployctl_tty() {
  if [[ -r /dev/tty ]]; then
    run_deployctl "$@" < /dev/tty
  else
    run_deployctl "$@"
  fi
}

TOKEN_CHECK_OUTPUT=""

validate_deploy_token() {
  local token="$1"
  TOKEN_CHECK_OUTPUT=""
  [[ -n "$token" ]] || {
    TOKEN_CHECK_OUTPUT="Empty token"
    return 1
  }

  local out=""
  if out=$(DENO_DEPLOY_TOKEN="$token" deployctl_tty projects list 2>&1); then
    TOKEN_CHECK_OUTPUT="$out"
    return 0
  fi
  TOKEN_CHECK_OUTPUT="$out"
  return 1
}

read_env_value() {
  local key="$1"
  local value=""
  if [[ -f "$ENV_FILE" ]]; then
    value=$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)
  fi
  printf "%s" "$value"
}

install_bun() {
  command -v curl &>/dev/null || abort "curl is required to install bun automatically."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  hash -r
}

ensure_bun() {
  if command -v bun &>/dev/null; then
    pass "bun $(bun --version)"
    return
  fi
  warn "bun not found"
  confirm "  Install bun automatically now?" || abort "bun is required."
  install_bun
  command -v bun &>/dev/null || abort "bun install completed but bun is unavailable."
  pass "bun $(bun --version)"
}

install_deno() {
  command -v curl &>/dev/null || abort "curl is required to install deno automatically."
  curl -fsSL https://deno.land/install.sh | sh
  export DENO_INSTALL="${DENO_INSTALL:-$HOME/.deno}"
  export PATH="$DENO_INSTALL/bin:$PATH"
  hash -r
}

ensure_deno() {
  if command -v deno &>/dev/null; then
    pass "deno installed"
    return
  fi
  warn "deno not found"
  confirm "  Install deno automatically now?" || abort "deno is required."
  install_deno
  command -v deno &>/dev/null || abort "deno install completed but deno is unavailable."
  pass "deno installed"
}

generate_jwt_secret() {
  bun --silent -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"))'
}

generate_vapid_keys() {
  bun --silent -e '
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
    const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
    const toBase64Url = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    console.log(`VAPID_PUBLIC_KEY=${toBase64Url(rawPublic)}`);
    console.log(`VAPID_PRIVATE_KEY=${privateJwk.d ?? ""}`);
  '
}

is_https_url() {
  [[ "$1" =~ ^https://[^[:space:]]+$ ]]
}

canonical_deno_url() {
  local project_name="$1"
  printf "https://%s.deno.dev" "${project_name,,}"
}

ensure_deploy_auth() {
  if [[ -n "${DENO_DEPLOY_TOKEN:-}" ]] && validate_deploy_token "$DENO_DEPLOY_TOKEN"; then
    pass "Deno Deploy authenticated"
    return
  fi

  local token_from_env_file=""
  token_from_env_file="$(read_env_value "DENO_DEPLOY_TOKEN")"
  if [[ -n "$token_from_env_file" ]] && validate_deploy_token "$token_from_env_file"; then
    export DENO_DEPLOY_TOKEN="$token_from_env_file"
    pass "Deno Deploy authenticated (token from .env)"
    return
  fi

  warn "DENO_DEPLOY_TOKEN is not configured"
  echo "  Create a token: https://dash.deno.com/account#access-tokens"
  printf "  Enter DENO_DEPLOY_TOKEN: "
  local token=""
  read -rs token < /dev/tty
  echo ""
  [[ -n "$token" ]] || abort "DENO_DEPLOY_TOKEN is required."

  if ! validate_deploy_token "$token"; then
    abort "DENO_DEPLOY_TOKEN is invalid or has insufficient permissions.

deployctl output:
${TOKEN_CHECK_OUTPUT:-No additional details from deployctl.}

Hint: deployctl works with Deno Deploy Classic organizations.
If your account/org exists only in the new Deno Deploy platform, deployctl auth will fail."
  fi
  export DENO_DEPLOY_TOKEN="$token"
  pass "Deno Deploy authenticated"
}

install_web_deps() {
  (cd "$CODEX_REMOTE_HOME" && bun install --silent)
}

build_web() {
  local auth_url="$1"
  local public_key="$2"
  (cd "$CODEX_REMOTE_HOME" && AUTH_URL="$auth_url" AUTH_MODE="passkey" VAPID_PUBLIC_KEY="$public_key" bun run build)
}

deploy_deno() {
  local project="$1"
  local auth_url="$2"
  local web_secret="$3"
  local anchor_secret="$4"
  local passkey_origin="$5"
  local include_dist="$6"

  local args=(
    deploy
    --project="$project"
    --entrypoint=./services/orbit-deno/main.ts
    --include=./services/orbit-deno/**
    --include=./services/orbit/src/**
    --prod
    --env="AUTH_MODE=passkey"
    --env="CODEX_REMOTE_WEB_JWT_SECRET=$web_secret"
    --env="CODEX_REMOTE_ANCHOR_JWT_SECRET=$anchor_secret"
    --env="PASSKEY_ORIGIN=$passkey_origin"
    --env="DEVICE_VERIFICATION_URL=$auth_url/device"
    --env="CORS_ORIGINS=$auth_url"
  )

  if [[ "$include_dist" == "1" ]]; then
    args+=(--include=./dist/**)
  fi

  (cd "$CODEX_REMOTE_HOME" && deployctl_tty "${args[@]}")
}

step "0. Validating local setup"
[[ -r /dev/tty ]] || abort "This wizard requires an interactive terminal."
[[ -d "$CODEX_REMOTE_HOME" ]] || abort "CODEX_REMOTE_HOME not found: $CODEX_REMOTE_HOME"
[[ -f "$CODEX_REMOTE_HOME/services/orbit-deno/main.ts" ]] || abort "Missing services/orbit-deno/main.ts"
pass "Local files verified"
pass "CODEX_REMOTE_HOME: $CODEX_REMOTE_HOME"

step "1. Checking prerequisites"
ensure_bun
ensure_deno
can_run_deployctl || abort "deployctl is unavailable. Install deployctl or deno."
ensure_deploy_auth

step "2. Preparing project"
project_name="codex-remote"
printf "  Deno Deploy project name [%s]: " "$project_name"
read -r input_project < /dev/tty
if [[ -n "${input_project// }" ]]; then
  project_name="${input_project// /}"
fi
project_name="${project_name,,}"
[[ "$project_name" =~ ^[a-z0-9-]+$ ]] || abort "Invalid project name '$project_name'. Use lowercase letters, numbers, and dashes only."
canonical_orbit_url="$(canonical_deno_url "$project_name")"
is_https_url "$canonical_orbit_url" || abort "Failed to derive canonical Deno URL from project '$project_name'."
pass "Project: $project_name"
pass "Canonical URL: $canonical_orbit_url"

step "3. Generating secrets"
web_jwt_secret="$(read_env_value "DENO_WEB_JWT_SECRET")"
if [[ -z "$web_jwt_secret" ]]; then
  web_jwt_secret="$(generate_jwt_secret)"
fi
anchor_jwt_secret="$(read_env_value "DENO_ANCHOR_JWT_SECRET")"
if [[ -z "$anchor_jwt_secret" ]]; then
  anchor_jwt_secret="$(read_env_value "CODEX_REMOTE_ANCHOR_JWT_SECRET")"
fi
if [[ -z "$anchor_jwt_secret" ]]; then
  anchor_jwt_secret="$(generate_jwt_secret)"
fi
vapid_output="$(generate_vapid_keys)"
vapid_public_key=$(echo "$vapid_output" | grep '^VAPID_PUBLIC_KEY=' | cut -d= -f2- || true)
[[ -n "$vapid_public_key" ]] || abort "Failed to generate VAPID public key."
pass "JWT and VAPID secrets generated"

step "4. Deploying backend (bootstrap)"
if ! retry_capture 3 3 "Deno deploy" deploy_deno "$project_name" "$canonical_orbit_url" "$web_jwt_secret" "$anchor_jwt_secret" "$canonical_orbit_url" "0"; then
  echo "$RETRY_LAST_OUTPUT"
  abort "Initial Deno deployment failed."
fi
bootstrap_output="$RETRY_LAST_OUTPUT"
echo "$bootstrap_output"
orbit_url="$canonical_orbit_url"
pass "Backend URL: $orbit_url"

step "5. Building web"
install_web_deps || abort "Failed to install web dependencies."
if ! retry_capture 2 3 "Web build" build_web "$orbit_url" "$vapid_public_key"; then
  echo "$RETRY_LAST_OUTPUT"
  abort "Web build failed."
fi
pass "Web build complete"

step "6. Deploying backend + static web"
if ! retry_capture 3 3 "Deno deploy (final)" deploy_deno "$project_name" "$canonical_orbit_url" "$web_jwt_secret" "$anchor_jwt_secret" "$canonical_orbit_url" "1"; then
  echo "$RETRY_LAST_OUTPUT"
  abort "Final Deno deployment failed."
fi
final_output="$RETRY_LAST_OUTPUT"
echo "$final_output"
orbit_url="$canonical_orbit_url"

step "7. Configuring anchor"
orbit_ws_url=$(echo "$orbit_url" | sed 's|^https://|wss://|')/ws/anchor

tmp_env_file=$(mktemp "$CODEX_REMOTE_HOME/.env.tmp.XXXXXX") || abort "Failed to create temp .env file."
cat > "$tmp_env_file" <<ENVEOF
# Codex Remote Anchor Configuration (self-host)
SELF_HOST_PROVIDER=deno
DENO_DEPLOY_PROJECT=${project_name}
DENO_DEPLOY_TOKEN=${DENO_DEPLOY_TOKEN}
DENO_WEB_JWT_SECRET=${web_jwt_secret}
DENO_ANCHOR_JWT_SECRET=${anchor_jwt_secret}
CODEX_REMOTE_ANCHOR_JWT_SECRET=${anchor_jwt_secret}
ANCHOR_PORT=8788
ANCHOR_ORBIT_URL=${orbit_ws_url}
AUTH_URL=${orbit_url}
AUTH_MODE=passkey
VAPID_PUBLIC_KEY=${vapid_public_key}
ANCHOR_JWT_TTL_SEC=300
ANCHOR_APP_CWD=
D1_DATABASE_ID=
ENVEOF
mv "$tmp_env_file" "$ENV_FILE"
chmod 600 "$ENV_FILE" 2>/dev/null || true
pass "Anchor configuration saved to $ENV_FILE"

echo ""
printf "${GREEN}${BOLD}Deno self-host deployment complete!${RESET}\n"
echo ""
printf "  ${BOLD}App:${RESET}   %s\n" "$orbit_url"
printf "  ${BOLD}WS:${RESET}    %s\n" "$orbit_ws_url"
echo ""
echo "  Next steps:"
printf "    1. Open ${BOLD}%s${RESET} and create your account\n" "$orbit_url"
printf "    2. Run ${BOLD}%s/bin/codex-remote start${RESET}\n" "$CODEX_REMOTE_HOME"
