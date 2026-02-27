#!/usr/bin/env pwsh

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:RepoRoot = Split-Path -Parent $script:ScriptDir
$defaultHome = Join-Path $HOME ".codex-remote"
$script:CodexRemoteHome = if ($env:CODEX_REMOTE_HOME) {
  $env:CODEX_REMOTE_HOME
}
elseif (Test-Path (Join-Path $defaultHome "services/anchor")) {
  $defaultHome
}
elseif (Test-Path (Join-Path $script:RepoRoot "services/anchor")) {
  $script:RepoRoot
}
else {
  $defaultHome
}
$script:AnchorDir = Join-Path $script:CodexRemoteHome "services/anchor"
$script:AnchorBinary = Join-Path $script:AnchorDir "bin/codex-remote-anchor.exe"
$script:EnvFile = Join-Path $script:CodexRemoteHome ".env"
$script:CredentialsFile = Join-Path $script:CodexRemoteHome "credentials.json"

function Write-Pass([string]$Message) {
  Write-Host "  [OK] $Message" -ForegroundColor Green
}

function Write-Fail([string]$Message) {
  Write-Host "  [ERR] $Message" -ForegroundColor Red
}

function Write-WarnLine([string]$Message) {
  Write-Host "  [WARN] $Message" -ForegroundColor Yellow
}

function Write-InfoLine([string]$Message) {
  Write-Host "  $Message"
}

function Get-DefaultEnvContent() {
  return @(
    "# Codex Remote Anchor Configuration (self-host)"
    "# Run 'codex-remote self-host' to complete setup."
    "ANCHOR_PORT=8788"
    "ANCHOR_ORBIT_URL="
    "AUTH_URL="
    "AUTH_MODE=passkey"
    "VAPID_PUBLIC_KEY="
    "ANCHOR_JWT_TTL_SEC=300"
    "ANCHOR_APP_CWD="
    "D1_DATABASE_ID="
  ) -join "`n"
}

function Ensure-EnvFile([switch]$Silent) {
  if (Test-Path $script:EnvFile) {
    return
  }

  $envDir = Split-Path -Parent $script:EnvFile
  if (-not (Test-Path $envDir)) {
    New-Item -ItemType Directory -Force -Path $envDir | Out-Null
  }

  $candidates = @(
    (Join-Path $script:CodexRemoteHome ".env.example"),
    (Join-Path $script:RepoRoot ".env.example"),
    (Join-Path $script:ScriptDir ".env.example")
  )

  foreach ($example in $candidates) {
    if (Test-Path $example) {
      Copy-Item $example $script:EnvFile -Force
      if (-not $Silent) {
        Write-InfoLine "Created .env from $example"
      }
      return
    }
  }

  Set-Content -Path $script:EnvFile -Value (Get-DefaultEnvContent)
  if (-not $Silent) {
    Write-WarnLine ".env.example not found; created a minimal .env at $script:EnvFile"
  }
}

function Test-Tool([string]$Name) {
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Read-EnvFileMap([string]$Path) {
  $map = @{}
  if (-not (Test-Path $Path)) {
    return $map
  }

  foreach ($line in Get-Content $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) {
      continue
    }
    $idx = $trimmed.IndexOf("=")
    if ($idx -lt 1) {
      continue
    }
    $key = $trimmed.Substring(0, $idx).Trim()
    if (-not $key) {
      continue
    }
    $value = $trimmed.Substring($idx + 1)
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      if ($value.Length -ge 2) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }
    $map[$key] = $value
  }

  return $map
}

function Assert-AnchorRuntime() {
  $hasBinary = Test-Path $script:AnchorBinary
  $hasSource = Test-Path (Join-Path $script:AnchorDir "src/index.ts")

  if (-not $hasBinary -and -not $hasSource) {
    throw "Anchor runtime not found. Expected binary at $script:AnchorBinary or source at $script:AnchorDir"
  }
  if (-not $hasBinary -and -not (Test-Tool "bun")) {
    throw "bun is not installed and no compiled anchor binary was found."
  }
}

function Get-EnvValue([string]$Name, [string]$DefaultValue = "") {
  if (-not (Test-Path $script:EnvFile)) {
    return $DefaultValue
  }

  $line = Get-Content $script:EnvFile | Where-Object { $_ -match "^\s*$Name=(.*)$" } | Select-Object -Last 1
  if (-not $line) {
    return $DefaultValue
  }

  return ($line -replace "^\s*$Name=", "").Trim()
}

function Update-DatabaseIdToml([string]$TomlPath, [string]$DatabaseId) {
  if (-not (Test-Path $TomlPath)) {
    return
  }

  $content = Get-Content $TomlPath -Raw
  $pattern = 'database_id\s*=\s*"[^"]*"'
  if (-not [regex]::IsMatch($content, $pattern)) {
    throw "Failed to update database_id in $TomlPath"
  }
  $updated = [regex]::Replace($content, $pattern, "database_id = `"$DatabaseId`"", 1)
  if ($updated -ne $content) {
    Set-Content -Path $TomlPath -Value $updated -NoNewline
  }
}

function Invoke-Retry([int]$Attempts, [int]$DelaySeconds, [string]$Description, [scriptblock]$Action) {
  for ($i = 1; $i -le $Attempts; $i++) {
    $script:LASTEXITCODE = 0
    $result = & $Action
    if ($LASTEXITCODE -eq 0) {
      return $result
    }

    if ($i -lt $Attempts) {
      Write-WarnLine "$Description failed (attempt $i/$Attempts); retrying in ${DelaySeconds}s..."
      Start-Sleep -Seconds $DelaySeconds
    }
  }

  throw "$Description failed after $Attempts attempts."
}

function Invoke-WithEnv([hashtable]$Vars, [scriptblock]$Action) {
  $previous = @{}
  foreach ($key in $Vars.Keys) {
    $previous[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
    [Environment]::SetEnvironmentVariable($key, $Vars[$key], "Process")
  }

  try {
    & $Action
  }
  finally {
    foreach ($key in $Vars.Keys) {
      [Environment]::SetEnvironmentVariable($key, $previous[$key], "Process")
    }
  }
}

function Assert-PrereqsForRun() {
  Ensure-EnvFile -Silent
  Assert-AnchorRuntime
}

function Invoke-Anchor([bool]$ForceLogin) {
  Assert-PrereqsForRun

  $envVars = Read-EnvFileMap $script:EnvFile
  $previous = @{}
  foreach ($key in $envVars.Keys) {
    $previous[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
    [Environment]::SetEnvironmentVariable($key, [string]$envVars[$key], "Process")
  }

  $previous["CODEX_REMOTE_CREDENTIALS_FILE"] = [Environment]::GetEnvironmentVariable("CODEX_REMOTE_CREDENTIALS_FILE", "Process")
  $previous["CODEX_REMOTE_FORCE_LOGIN"] = [Environment]::GetEnvironmentVariable("CODEX_REMOTE_FORCE_LOGIN", "Process")
  [Environment]::SetEnvironmentVariable("CODEX_REMOTE_CREDENTIALS_FILE", $script:CredentialsFile, "Process")
  [Environment]::SetEnvironmentVariable("CODEX_REMOTE_FORCE_LOGIN", (if ($ForceLogin) { "1" } else { "" }), "Process")

  $exitCode = 0
  try {
    if (Test-Path $script:AnchorBinary) {
      & $script:AnchorBinary
    }
    else {
      & bun "--env-file" $script:EnvFile (Join-Path $script:AnchorDir "src/index.ts")
    }
    $exitCode = $LASTEXITCODE
  }
  finally {
    foreach ($key in $envVars.Keys) {
      [Environment]::SetEnvironmentVariable($key, $previous[$key], "Process")
    }
    [Environment]::SetEnvironmentVariable("CODEX_REMOTE_CREDENTIALS_FILE", $previous["CODEX_REMOTE_CREDENTIALS_FILE"], "Process")
    [Environment]::SetEnvironmentVariable("CODEX_REMOTE_FORCE_LOGIN", $previous["CODEX_REMOTE_FORCE_LOGIN"], "Process")
  }

  exit $exitCode
}

function Cmd-Start() {
  Invoke-Anchor $false
}

function Cmd-Login() {
  Invoke-Anchor $true
}

function Cmd-Doctor() {
  Write-Host ""
  Write-Host "Codex Remote Doctor" -ForegroundColor Cyan
  Write-Host ""

  $hasError = $false

  if (Test-Path $script:CodexRemoteHome) {
    Write-Pass "CODEX_REMOTE_HOME exists ($script:CodexRemoteHome)"
  }
  else {
    Write-Fail "CODEX_REMOTE_HOME not found ($script:CodexRemoteHome)"
    $hasError = $true
  }

  if (Test-Path $script:EnvFile) {
    Write-Pass ".env file exists"
  }
  else {
    Write-Fail ".env file missing at $script:EnvFile"
    $hasError = $true
  }

  if (Test-Tool "bun") {
    $bunVersion = & bun --version
    Write-Pass "bun $bunVersion"
  }
  else {
    if (Test-Path $script:AnchorBinary) {
      Write-InfoLine "bun not installed (using compiled anchor binary)"
    }
    else {
      Write-Fail "bun not installed"
      $hasError = $true
    }
  }

  if (Test-Tool "codex") {
    Write-Pass "codex CLI installed"
  }
  else {
    Write-Fail "codex CLI not installed"
    $hasError = $true
  }

  if (Test-Path $script:AnchorBinary) {
    Write-Pass "Anchor binary found ($script:AnchorBinary)"
  }
  elseif (Test-Path (Join-Path $script:AnchorDir "src/index.ts")) {
    Write-Pass "Anchor source found"
  }
  else {
    Write-Fail "Anchor runtime not found at $script:AnchorDir"
    $hasError = $true
  }

  if (Test-Path $script:AnchorBinary) {
    Write-InfoLine "Anchor dependencies are bundled in binary mode"
  }
  elseif (Test-Path (Join-Path $script:AnchorDir "node_modules")) {
    Write-Pass "Anchor dependencies installed"
  }
  else {
    Write-WarnLine "Anchor dependencies not installed (run: cd $script:AnchorDir; bun install)"
  }

  $orbitUrl = Get-EnvValue "ANCHOR_ORBIT_URL"
  if ($orbitUrl) {
    Write-Pass "ANCHOR_ORBIT_URL configured"
    if (Test-Path $script:CredentialsFile) {
      Write-Pass "Credentials file exists ($script:CredentialsFile)"
    }
    else {
      Write-WarnLine "Not logged in. Run 'codex-remote login' or 'codex-remote start'."
    }
  }
  else {
    Write-InfoLine "ANCHOR_ORBIT_URL not set (local-only mode)"
  }

  $port = Get-EnvValue "ANCHOR_PORT" "8788"
  try {
    $health = Invoke-RestMethod -Uri "http://localhost:$port/health" -Method Get -TimeoutSec 2
    Write-Pass "Anchor is running on port $port"
    Write-InfoLine "  app-server: $($health.appServer)"
    Write-InfoLine "  orbit: $($health.orbit)"
  }
  catch {
    Write-InfoLine "Anchor is not running on port $port"
  }

  Write-Host ""
  if ($hasError) {
    Write-Host "Some checks failed. Fix issues and try again." -ForegroundColor Red
    exit 1
  }
  else {
    Write-Host "All checks passed." -ForegroundColor Green
  }
  Write-Host ""
}

function Cmd-Config() {
  Ensure-EnvFile

  $editor = if ($env:EDITOR) { $env:EDITOR } else { "notepad" }
  & $editor $script:EnvFile
}

function Cmd-Update() {
  Write-Host "Updating Codex Remote..."

  if (-not (Test-Path (Join-Path $script:CodexRemoteHome ".git"))) {
    throw "$script:CodexRemoteHome is not a git repository. Re-run install.ps1 to update release installs."
  }

  $before = (& git -C $script:CodexRemoteHome rev-parse --short HEAD 2>$null).Trim()
  if (-not $before) { $before = "unknown" }

  $status = (& git -C $script:CodexRemoteHome status --porcelain).Trim()
  if ($status) {
    Write-WarnLine "Local changes detected and will be overwritten."
  }

  Invoke-Retry 3 3 "git fetch" { & git -C $script:CodexRemoteHome fetch --prune origin }

  $remoteHead = (& git -C $script:CodexRemoteHome symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>$null).Trim()
  $targetBranch = if ($remoteHead) { $remoteHead -replace "^origin/", "" } else { "main" }

  & git -C $script:CodexRemoteHome show-ref --verify --quiet "refs/remotes/origin/$targetBranch"
  if ($LASTEXITCODE -ne 0) {
    throw "Remote branch origin/$targetBranch not found."
  }

  & git -C $script:CodexRemoteHome reset --hard --quiet "origin/$targetBranch"
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to reset repository."
  }
  & git -C $script:CodexRemoteHome clean -fd --quiet
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to clean repository."
  }

  $after = (& git -C $script:CodexRemoteHome rev-parse --short HEAD 2>$null).Trim()
  if (-not $after) { $after = "unknown" }

  if ($before -eq $after) {
    Write-Host "Already up to date ($after on origin/$targetBranch)."
  }
  else {
    Write-Host "Updated $before -> $after (origin/$targetBranch)"
  }

  if (Test-Path $script:EnvFile) {
    $dbId = Get-EnvValue "D1_DATABASE_ID"
    if ($dbId) {
      Update-DatabaseIdToml (Join-Path $script:CodexRemoteHome "wrangler.toml") $dbId
      Update-DatabaseIdToml (Join-Path $script:CodexRemoteHome "services/orbit/wrangler.toml") $dbId
    }
  }

  Write-Host "Installing dependencies..."
  Invoke-Retry 3 3 "Anchor dependency install" {
    Push-Location $script:AnchorDir
    try {
      & bun install --silent
    }
    finally {
      Pop-Location
    }
  }

  if (Test-Path $script:EnvFile) {
    $authUrl = Get-EnvValue "AUTH_URL"
    $vapidPublic = Get-EnvValue "VAPID_PUBLIC_KEY"
    if ($authUrl) {
      if (-not (Test-Tool "wrangler")) {
        throw "wrangler not found. Install with: bun add -g wrangler"
      }
      if (-not $vapidPublic) {
        throw "VAPID_PUBLIC_KEY is missing in $script:EnvFile. Run 'codex-remote self-host'."
      }

      Write-Host "Rebuilding web..."
      Invoke-Retry 3 3 "Web dependency install" {
        Push-Location $script:CodexRemoteHome
        try {
          & bun install --silent
        }
        finally {
          Pop-Location
        }
      }

      Invoke-WithEnv @{ AUTH_URL = $authUrl; VAPID_PUBLIC_KEY = $vapidPublic } {
        Push-Location $script:CodexRemoteHome
        try {
          & bun run build
        }
        finally {
          Pop-Location
        }
      }
      if ($LASTEXITCODE -ne 0) {
        throw "Web build failed."
      }

      Write-Host "Deploying web..."
      Invoke-WithEnv @{ CI = "true" } {
        Push-Location $script:CodexRemoteHome
        try {
          & wrangler pages deploy dist --project-name codex-remote --commit-dirty=true
        }
        finally {
          Pop-Location
        }
      }
      if ($LASTEXITCODE -ne 0) {
        throw "Pages deploy failed."
      }

      Write-Host "Deploying orbit..."
      Invoke-Retry 3 3 "Orbit dependency install" {
        Push-Location (Join-Path $script:CodexRemoteHome "services/orbit")
        try {
          & bun install --silent
        }
        finally {
          Pop-Location
        }
      }

      Push-Location (Join-Path $script:CodexRemoteHome "services/orbit")
      try {
        & wrangler deploy
      }
      finally {
        Pop-Location
      }
      if ($LASTEXITCODE -ne 0) {
        throw "Orbit deploy failed."
      }
    }
  }

  Write-Host "Done."
}

function Cmd-SelfHost() {
  $scriptPath = Join-Path $script:CodexRemoteHome "bin/self-host.ps1"
  if (-not (Test-Path $scriptPath)) {
    throw "self-host wizard not found at $scriptPath"
  }
  # Ensure self-host script uses the same resolved home as this CLI invocation.
  $env:CODEX_REMOTE_HOME = $script:CodexRemoteHome
  & $scriptPath
  exit $LASTEXITCODE
}

function Cmd-Uninstall() {
  Write-Host ""
  Write-Host "Uninstall Codex Remote" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "This will remove:"
  Write-Host "  $script:CodexRemoteHome"
  Write-Host "  PATH entries for codex-remote"
  Write-Host ""

  $confirm = Read-Host "Are you sure? [y/N]"
  if ($confirm -notin @("y", "Y")) {
    Write-Host "Cancelled."
    return
  }

  if (Test-Path $script:CodexRemoteHome) {
    Remove-Item $script:CodexRemoteHome -Recurse -Force
    Write-Host "Removed $script:CodexRemoteHome"
  }

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($userPath) {
    $target = (Join-Path $script:CodexRemoteHome "bin").ToLowerInvariant()
    $parts = $userPath.Split(";") | Where-Object { $_ -and ($_.Trim().ToLowerInvariant() -ne $target) }
    [Environment]::SetEnvironmentVariable("Path", ($parts -join ";"), "User")
  }

  Write-Host ""
  Write-Host "Codex Remote has been uninstalled."
}

function Cmd-Version() {
  if (Test-Path (Join-Path $script:CodexRemoteHome ".git")) {
    $tag = (& git -C $script:CodexRemoteHome describe --tags --always 2>$null).Trim()
    if (-not $tag) { $tag = "dev" }
    Write-Host "codex-remote $tag"
  }
  elseif (Test-Path (Join-Path $script:CodexRemoteHome "VERSION")) {
    $version = (Get-Content (Join-Path $script:CodexRemoteHome "VERSION") -Raw).Trim()
    if (-not $version) { $version = "release" }
    Write-Host "codex-remote $version"
  }
  else {
    Write-Host "codex-remote dev"
  }
}

function Cmd-Help() {
  Write-Host ""
  Write-Host "Codex Remote - local AI assistant bridge" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "Usage: codex-remote <command>"
  Write-Host ""
  Write-Host "Commands:"
  Write-Host "  start       Start the anchor service"
  Write-Host "  login       Re-authenticate with the web app"
  Write-Host "  doctor      Check prerequisites and configuration"
  Write-Host "  config      Open .env in your editor"
  Write-Host "  update      Pull latest code and reinstall dependencies"
  Write-Host "  self-host   Run the self-host setup wizard"
  Write-Host "  uninstall   Remove Codex Remote from your system"
  Write-Host "  version     Print version"
  Write-Host "  help        Show this help"
  Write-Host ""
}

try {
  $command = if ($args.Length -gt 0) { $args[0].ToLowerInvariant() } else { "help" }

  switch ($command) {
    "start" { Cmd-Start; break }
    "login" { Cmd-Login; break }
    "doctor" { Cmd-Doctor; break }
    "config" { Cmd-Config; break }
    "update" { Cmd-Update; break }
    "self-host" { Cmd-SelfHost; break }
    "uninstall" { Cmd-Uninstall; break }
    "version" { Cmd-Version; break }
    "help" { Cmd-Help; break }
    "--help" { Cmd-Help; break }
    "-h" { Cmd-Help; break }
    default {
      throw "Unknown command: $command"
    }
  }
}
catch {
  Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
