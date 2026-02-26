#!/usr/bin/env pwsh

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ZaneHome = if ($env:ZANE_HOME) { $env:ZANE_HOME } else { Join-Path $HOME ".zane" }
$ZaneRepo = if ($env:ZANE_REPO) { $env:ZANE_REPO } else { "https://github.com/cospec-ai/zane.git" }
$ZaneBranch = if ($env:ZANE_BRANCH) { $env:ZANE_BRANCH } else { "" }

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host $Message -ForegroundColor Cyan
}

function Write-Pass([string]$Message) {
  Write-Host "  [OK] $Message" -ForegroundColor Green
}

function Write-WarnLine([string]$Message) {
  Write-Host "  [WARN] $Message" -ForegroundColor Yellow
}

function Abort([string]$Message) {
  throw $Message
}

function Confirm-Yes([string]$Prompt) {
  $answer = Read-Host "$Prompt [Y/n]"
  if (-not $answer) { return $true }
  return $answer -match "^[Yy]"
}

function Test-Tool([string]$Name) {
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-Retry([int]$Attempts, [int]$DelaySeconds, [string]$Description, [scriptblock]$Action) {
  for ($i = 1; $i -le $Attempts; $i++) {
    try {
      $script:LASTEXITCODE = 0
      $result = & $Action
      if ($LASTEXITCODE -ne 0) {
        throw "Exit code $LASTEXITCODE"
      }
      return $result
    }
    catch {
      if ($i -ge $Attempts) {
        throw "$Description failed after $Attempts attempts. $($_.Exception.Message)"
      }
      Write-WarnLine "$Description failed (attempt $i/$Attempts); retrying in ${DelaySeconds}s..."
      Start-Sleep -Seconds $DelaySeconds
    }
  }
}

function Ensure-EnvFile([string]$HomePath) {
  $envFile = Join-Path $HomePath ".env"
  if (Test-Path $envFile) {
    return
  }

  $example = Join-Path $HomePath ".env.example"
  if (Test-Path $example) {
    Copy-Item $example $envFile
    Write-Pass "Created .env from .env.example"
    return
  }

  @(
    "# Zane Anchor Configuration (self-host)"
    "# Run 'zane self-host' to complete setup."
    "ANCHOR_PORT=8788"
    "ANCHOR_ORBIT_URL="
    "AUTH_URL="
    "ANCHOR_JWT_TTL_SEC=300"
    "ANCHOR_APP_CWD="
  ) | Set-Content $envFile
  Write-WarnLine ".env.example not found; created a minimal .env file."
}

function Ensure-Path([string]$TargetDir) {
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @()
  if ($userPath) {
    $parts = $userPath.Split(";")
  }

  $normalizedTarget = $TargetDir.Trim().ToLowerInvariant()
  $exists = $parts | Where-Object { $_.Trim().ToLowerInvariant() -eq $normalizedTarget }
  if (-not $exists) {
    $newPath = if ($userPath) { "$userPath;$TargetDir" } else { $TargetDir }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Pass "Added $TargetDir to user PATH"
  }
  else {
    Write-Pass "PATH already contains $TargetDir"
  }

  if ($env:Path -notlike "*$TargetDir*") {
    $env:Path = "$env:Path;$TargetDir"
  }
}

Write-Host ""
Write-Host "Zane Installer (Windows)" -ForegroundColor Cyan
Write-Host ""

if (-not $IsWindows) {
  Abort "install.ps1 is for Windows. Use install.sh on Linux/macOS."
}
Write-Pass "Windows detected"

Write-Step "Checking prerequisites..."

if (Test-Tool "git") {
  Write-Pass "git installed"
}
else {
  Write-WarnLine "git not found."
  if ((Test-Tool "winget") -and (Confirm-Yes "Install Git with winget?")) {
    & winget install --id Git.Git -e --source winget
    if ($LASTEXITCODE -ne 0 -or -not (Test-Tool "git")) {
      Abort "Failed to install git."
    }
    Write-Pass "git installed"
  }
  else {
    Abort "git is required. Install it and rerun this script."
  }
}

if (Test-Tool "bun") {
  $bunVersion = & bun --version
  Write-Pass "bun $bunVersion"
}
else {
  Write-WarnLine "bun not found."
  if ((Test-Tool "winget") -and (Confirm-Yes "Install bun with winget?")) {
    & winget install --id Oven-sh.Bun -e --source winget
    if ($LASTEXITCODE -ne 0 -or -not (Test-Tool "bun")) {
      Abort "Failed to install bun."
    }
    Write-Pass "bun installed"
  }
  else {
    Abort "bun is required. Install it from https://bun.sh and rerun."
  }
}

if (Test-Tool "codex") {
  Write-Pass "codex CLI installed"
}
else {
  Write-WarnLine "codex CLI not found."
  if ((Test-Tool "winget") -and (Confirm-Yes "Try install codex with winget?")) {
    & winget install --id OpenAI.Codex -e --source winget
    if ($LASTEXITCODE -eq 0 -and (Test-Tool "codex")) {
      Write-Pass "codex installed"
    }
    else {
      Abort "codex is required. Install manually: https://github.com/openai/codex"
    }
  }
  else {
    Abort "codex is required. Install manually: https://github.com/openai/codex"
  }
}

Write-Host ""
Write-Host "  Checking codex authentication..."
& codex login status > $null 2>&1
if ($LASTEXITCODE -eq 0) {
  Write-Pass "codex authenticated"
}
else {
  Write-WarnLine "codex is not authenticated"
  if (Confirm-Yes "Run 'codex login' now?") {
    & codex login
    & codex login status > $null 2>&1
    if ($LASTEXITCODE -eq 0) {
      Write-Pass "codex authenticated"
    }
    else {
      Write-WarnLine "codex authentication may have failed. Continue anyway."
    }
  }
}

Write-Step "Installing Zane to $ZaneHome..."

if (Test-Path (Join-Path $ZaneHome ".git")) {
  Write-Host "  Existing installation found. Updating..."

  $localStatus = (& git -C $ZaneHome status --porcelain).Trim()
  if ($localStatus) {
    Write-WarnLine "Local changes detected and will be overwritten."
  }

  Invoke-Retry 3 3 "git fetch" { & git -C $ZaneHome fetch --prune origin }

  $targetBranch = $ZaneBranch
  if (-not $targetBranch) {
    $remoteHead = (& git -C $ZaneHome symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>$null).Trim()
    $targetBranch = if ($remoteHead) { $remoteHead -replace "^origin/", "" } else { "main" }
  }

  & git -C $ZaneHome show-ref --verify --quiet "refs/remotes/origin/$targetBranch"
  if ($LASTEXITCODE -ne 0) {
    Abort "Remote branch origin/$targetBranch not found."
  }

  $before = (& git -C $ZaneHome rev-parse --short HEAD 2>$null).Trim()
  if (-not $before) { $before = "unknown" }

  & git -C $ZaneHome reset --hard --quiet "origin/$targetBranch"
  if ($LASTEXITCODE -ne 0) {
    Abort "Failed to reset repository."
  }
  & git -C $ZaneHome clean -fd --quiet
  if ($LASTEXITCODE -ne 0) {
    Abort "Failed to clean repository."
  }

  $after = (& git -C $ZaneHome rev-parse --short HEAD 2>$null).Trim()
  if (-not $after) { $after = "unknown" }
  Write-Pass "Updated $before -> $after (origin/$targetBranch)"
}
else {
  if (Test-Path $ZaneHome) {
    $backup = "$ZaneHome.bak.$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
    Write-WarnLine "$ZaneHome exists but is not a git repo. Backing up to $backup"
    Move-Item $ZaneHome $backup
  }

  if ($ZaneBranch) {
    Invoke-Retry 3 3 "git clone" { & git clone --depth 1 --branch $ZaneBranch $ZaneRepo $ZaneHome }
  }
  else {
    Invoke-Retry 3 3 "git clone" { & git clone --depth 1 $ZaneRepo $ZaneHome }
  }
  Write-Pass "Cloned repository"
}

Write-Host "  Installing anchor dependencies..."
Invoke-Retry 3 3 "Anchor dependency install" {
  Push-Location (Join-Path $ZaneHome "services/anchor")
  try {
    & bun install --silent
  }
  finally {
    Pop-Location
  }
}
Write-Pass "Anchor dependencies installed"

Write-Step "Installing CLI..."

$binDir = Join-Path $ZaneHome "bin"
if (-not (Test-Path (Join-Path $binDir "zane.ps1"))) {
  Abort "CLI script not found: $(Join-Path $binDir 'zane.ps1')"
}
if (-not (Test-Path (Join-Path $binDir "zane.cmd"))) {
  Abort "CLI wrapper not found: $(Join-Path $binDir 'zane.cmd')"
}

Ensure-Path $binDir

Ensure-EnvFile $ZaneHome

Write-Step "Self-host setup"
$selfHostScript = Join-Path $binDir "self-host.ps1"
if (-not (Test-Path $selfHostScript)) {
  Write-WarnLine "Self-host wizard not found at $selfHostScript"
  Write-WarnLine "Run 'zane self-host' after installation."
}
elseif (Confirm-Yes "Run self-host deployment now?") {
  & $selfHostScript
}
else {
  Write-Host "  Skipped cloud deployment. Run 'zane self-host' when ready."
}

Write-Host ""
Write-Host "Zane installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "  Get started:"
Write-Host "    zane start     Start the anchor service"
Write-Host "    zane doctor    Check your setup"
Write-Host "    zane config    Edit configuration"
Write-Host "    zane help      See all commands"
Write-Host ""
Write-Host "  If this is a new terminal session, reopen PowerShell to refresh PATH."
Write-Host ""
