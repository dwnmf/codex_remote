#!/usr/bin/env pwsh

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$CodexRemoteHome = if ($env:CODEX_REMOTE_HOME) { $env:CODEX_REMOTE_HOME } else { Join-Path $HOME ".codex-remote" }
$CodexRemoteRepo = if ($env:CODEX_REMOTE_REPO) { $env:CODEX_REMOTE_REPO } else { "https://github.com/dwnmf/codex_remote.git" }
$CodexRemoteBranch = if ($env:CODEX_REMOTE_BRANCH) { $env:CODEX_REMOTE_BRANCH } else { "" }
$InstallModeRaw = if ($env:CODEX_REMOTE_INSTALL_MODE) { $env:CODEX_REMOTE_INSTALL_MODE } else { "auto" }
$InstallMode = $InstallModeRaw.ToLowerInvariant()
$ReleaseAssetName = if ($env:CODEX_REMOTE_RELEASE_ASSET) { $env:CODEX_REMOTE_RELEASE_ASSET } else { "codex-remote-windows-x64.zip" }
$ReleaseTag = if ($env:CODEX_REMOTE_RELEASE_TAG) { $env:CODEX_REMOTE_RELEASE_TAG } else { "" }
$RunSelfHost = $env:CODEX_REMOTE_RUN_SELF_HOST -eq "1"

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

function Test-Tool([string]$Name) {
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Resolve-CodexCommand() {
  foreach ($name in @("codex.cmd", "codex.exe", "codex")) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd -and $cmd.Source) {
      return [string]$cmd.Source
    }
  }
  return ""
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
  if ([string]::IsNullOrWhiteSpace($HomePath)) {
    Abort "Internal error: CODEX_REMOTE_HOME resolved to an empty path."
  }

  $resolvedHome = $HomePath.Trim()
  if (-not (Test-Path $resolvedHome)) {
    New-Item -ItemType Directory -Path $resolvedHome -Force | Out-Null
  }

  $envFile = Join-Path $resolvedHome ".env"
  if (Test-Path $envFile) {
    return
  }

  $example = Join-Path $resolvedHome ".env.example"
  if (Test-Path $example) {
    Copy-Item $example $envFile -Force
    Write-Pass "Created .env from $example"
    return
  }

  @(
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

function Ensure-BunInstalled() {
  if (Test-Tool "bun") {
    $bunVersion = & bun --version
    Write-Pass "bun $bunVersion"
    return
  }

  Write-WarnLine "bun not found. Installing via bun.sh..."
  $bunInstallCommand = 'irm bun.sh/install.ps1|iex'
  & powershell -NoProfile -ExecutionPolicy Bypass -Command $bunInstallCommand
  if ($LASTEXITCODE -ne 0) {
    Abort "Failed to install bun via bun.sh installer."
  }

  foreach ($candidate in @((Join-Path $HOME ".bun\bin"), (Join-Path $env:USERPROFILE ".bun\bin"))) {
    if ($candidate -and (Test-Path $candidate)) {
      Ensure-Path $candidate
    }
  }

  if (-not (Test-Tool "bun")) {
    Abort "bun installation completed but 'bun' is still not available in PATH."
  }

  $bunVersion = & bun --version
  Write-Pass "bun $bunVersion"
}

function Ensure-OpenSslInstalled() {
  $opensslBin = "C:\Program Files\OpenSSL-Win64\bin"
  if (Test-Tool "openssl") {
    Write-Pass "openssl installed"
    if (Test-Path $opensslBin) {
      Ensure-Path $opensslBin
    }
    return
  }

  Write-WarnLine "openssl not found. Installing OpenSSL Light..."
  $url = "https://slproweb.com/download/Win64OpenSSL_Light-3_6_1.exe"
  $tmpExe = Join-Path $env:TEMP "Win64OpenSSL_Light-3_6_1.exe"
  try {
    Invoke-WebRequest -Uri $url -OutFile $tmpExe
    $proc = Start-Process -FilePath $tmpExe -ArgumentList "/verysilent", "/silent", "/sp-", "/norestart" -Wait -PassThru
    if ($proc.ExitCode -ne 0) {
      Abort "OpenSSL installer exited with code $($proc.ExitCode)."
    }
  }
  finally {
    if (Test-Path $tmpExe) {
      Remove-Item $tmpExe -Force -ErrorAction SilentlyContinue
    }
  }

  if (Test-Path $opensslBin) {
    Ensure-Path $opensslBin
  }

  if (-not (Test-Tool "openssl")) {
    Abort "OpenSSL installation completed but 'openssl' is still not available in PATH."
  }

  Write-Pass "openssl installed"
}

function Ensure-CommandViaWinget([string]$CommandName, [string]$WingetId, [string]$ManualHint) {
  if (Test-Tool $CommandName) {
    return
  }

  if (-not (Test-Tool "winget")) {
    Abort "$CommandName is required. $ManualHint"
  }

  Write-WarnLine "$CommandName not found."
  Write-Host "  Installing $CommandName with winget..."
  & winget install --id $WingetId -e --source winget
  if ($LASTEXITCODE -ne 0 -or -not (Test-Tool $CommandName)) {
    Abort "Failed to install $CommandName. $ManualHint"
  }

  Write-Pass "$CommandName installed"
}

function Get-RepoSlug([string]$RepoUrl) {
  $trimmed = $RepoUrl.Trim()
  if ($trimmed -match "github\.com[:/](?<owner>[^/]+)/(?<repo>[^/\.\s]+)(?:\.git)?/?$") {
    return "$($Matches.owner)/$($Matches.repo)"
  }
  Abort "Could not parse GitHub repository from CODEX_REMOTE_REPO: $RepoUrl"
}

function Get-ReleaseAssetDownloadUrl([string]$RepoUrl, [string]$AssetName, [string]$Tag) {
  $slug = Get-RepoSlug $RepoUrl
  $apiUrl = if ($Tag) {
    "https://api.github.com/repos/$slug/releases/tags/$Tag"
  }
  else {
    "https://api.github.com/repos/$slug/releases/latest"
  }

  $headers = @{
    "Accept" = "application/vnd.github+json"
    "User-Agent" = "codex-remote-installer"
  }

  $release = Invoke-RestMethod -Method Get -Uri $apiUrl -Headers $headers
  $asset = @($release.assets) | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1
  if (-not $asset) {
    $available = (@($release.assets) | ForEach-Object { $_.name }) -join ", "
    Abort "Release asset '$AssetName' not found in $slug release '$($release.tag_name)'. Available: $available"
  }

  return [string]$asset.browser_download_url
}

function Install-FromSource([string]$HomePath, [string]$RepoUrl, [string]$Branch) {
  Ensure-CommandViaWinget "git" "Git.Git" "Install it and rerun this script."
  Ensure-CommandViaWinget "bun" "Oven-sh.Bun" "Install bun from https://bun.sh and rerun."

  if (Test-Path (Join-Path $HomePath ".git")) {
    Write-Host "  Existing source installation found. Updating..."

    $localStatus = (& git -C $HomePath status --porcelain).Trim()
    if ($localStatus) {
      Write-WarnLine "Local changes detected and will be overwritten."
    }

    Invoke-Retry 3 3 "git fetch" { & git -C $HomePath fetch --prune origin }

    $targetBranch = $Branch
    if (-not $targetBranch) {
      $remoteHead = (& git -C $HomePath symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>$null).Trim()
      $targetBranch = if ($remoteHead) { $remoteHead -replace "^origin/", "" } else { "main" }
    }

    & git -C $HomePath show-ref --verify --quiet "refs/remotes/origin/$targetBranch"
    if ($LASTEXITCODE -ne 0) {
      Abort "Remote branch origin/$targetBranch not found."
    }

    $before = (& git -C $HomePath rev-parse --short HEAD 2>$null).Trim()
    if (-not $before) { $before = "unknown" }

    & git -C $HomePath reset --hard --quiet "origin/$targetBranch"
    if ($LASTEXITCODE -ne 0) {
      Abort "Failed to reset repository."
    }
    & git -C $HomePath clean -fd --quiet
    if ($LASTEXITCODE -ne 0) {
      Abort "Failed to clean repository."
    }

    $after = (& git -C $HomePath rev-parse --short HEAD 2>$null).Trim()
    if (-not $after) { $after = "unknown" }
    Write-Pass "Updated $before -> $after (origin/$targetBranch)"
  }
  else {
    if (Test-Path $HomePath) {
      $backup = "$HomePath.bak.$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
      Write-WarnLine "$HomePath exists but is not a git repo. Backing up to $backup"
      Move-Item $HomePath $backup
    }

    if ($Branch) {
      Invoke-Retry 3 3 "git clone" { & git clone --depth 1 --branch $Branch $RepoUrl $HomePath }
    }
    else {
      Invoke-Retry 3 3 "git clone" { & git clone --depth 1 $RepoUrl $HomePath }
    }
    Write-Pass "Cloned repository"
  }

  Write-Host "  Installing anchor dependencies..."
  Invoke-Retry 3 3 "Anchor dependency install" {
    Push-Location (Join-Path $HomePath "services/anchor")
    try {
      & bun install --silent
    }
    finally {
      Pop-Location
    }
  }
  Write-Pass "Anchor dependencies installed"
}

function Install-FromRelease([string]$HomePath, [string]$RepoUrl, [string]$AssetName, [string]$Tag) {
  $downloadUrl = Get-ReleaseAssetDownloadUrl -RepoUrl $RepoUrl -AssetName $AssetName -Tag $Tag
  Write-Host "  Downloading release asset: $AssetName"

  if (Test-Path $HomePath) {
    $backup = "$HomePath.bak.$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
    Write-WarnLine "$HomePath exists. Backing up to $backup"
    Move-Item $HomePath $backup
  }
  New-Item -ItemType Directory -Path $HomePath -Force | Out-Null

  $tmpZip = Join-Path $env:TEMP ("codex-remote-release-" + [guid]::NewGuid().ToString("N") + ".zip")
  $tmpExtract = Join-Path $env:TEMP ("codex-remote-release-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $tmpExtract -Force | Out-Null

  try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $tmpZip
    Expand-Archive -Path $tmpZip -DestinationPath $tmpExtract -Force

    $contentRoot = $tmpExtract
    $entries = @(Get-ChildItem -Path $tmpExtract -Force)
    if ($entries.Count -eq 1 -and $entries[0].PSIsContainer) {
      $candidateRoot = $entries[0].FullName
      if (Test-Path (Join-Path $candidateRoot "bin/codex-remote.ps1")) {
        $contentRoot = $candidateRoot
      }
    }

    Get-ChildItem -Path $contentRoot -Force | ForEach-Object {
      Copy-Item -Path $_.FullName -Destination (Join-Path $HomePath $_.Name) -Recurse -Force
    }
  }
  finally {
    if (Test-Path $tmpZip) { Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue }
    if (Test-Path $tmpExtract) { Remove-Item $tmpExtract -Recurse -Force -ErrorAction SilentlyContinue }
  }

  $requiredPaths = @(
    (Join-Path $HomePath "bin/codex-remote.ps1"),
    (Join-Path $HomePath "bin/codex-remote.cmd"),
    (Join-Path $HomePath "services/anchor/bin/codex-remote-anchor.exe")
  )
  foreach ($required in $requiredPaths) {
    if (-not (Test-Path $required)) {
      Abort "Release package is invalid: missing $required"
    }
  }

  Write-Pass "Installed from release asset ($AssetName)"
}

Write-Host ""
Write-Host "Codex Remote Installer (Windows)" -ForegroundColor Cyan
Write-Host ""

$runningOnWindows = $env:OS -eq "Windows_NT"
if (-not $runningOnWindows) {
  Abort "install.ps1 is for Windows. Use install.sh on Linux/macOS."
}
Write-Pass "Windows detected"

if ($InstallMode -notin @("auto", "source", "release")) {
  Abort "Invalid CODEX_REMOTE_INSTALL_MODE='$InstallModeRaw'. Allowed values: auto, source, release."
}

Write-Step "Checking prerequisites..."

if (Test-Tool "winget") {
  Write-Pass "winget installed"
}
else {
  Write-WarnLine "winget not found (installer will not auto-install missing tools)."
}

Ensure-BunInstalled
Ensure-OpenSslInstalled

$hasGit = Test-Tool "git"
$hasBun = Test-Tool "bun"
$selectedMode = switch ($InstallMode) {
  "source" { "source" }
  "release" { "release" }
  default {
    if ($hasGit -and $hasBun) { "source" } else { "release" }
  }
}

if ($selectedMode -eq "source") {
  if ($hasGit) {
    Write-Pass "git installed"
  }
}
else {
  if ($hasGit) {
    Write-Pass "git installed (optional in release mode)"
  }
  else {
    Write-Host "  git not required in release mode"
  }

  Write-Pass "bun installed (optional in release mode)"
}

Ensure-CommandViaWinget "codex" "OpenAI.Codex" "Install manually: https://github.com/openai/codex"
$codexCommand = Resolve-CodexCommand
if (-not $codexCommand) {
  Abort "codex command not found after installation."
}
Write-Pass "Using codex command: $codexCommand"

Write-Host ""
Write-Host "  Checking codex authentication..."
& $codexCommand login status > $null 2>&1
if ($LASTEXITCODE -eq 0) {
  Write-Pass "codex authenticated"
}
else {
  Write-WarnLine "codex is not authenticated. Launching 'codex login'..."
  & $codexCommand login
  & $codexCommand login status > $null 2>&1
  if ($LASTEXITCODE -eq 0) {
    Write-Pass "codex authenticated"
  }
  else {
    Abort "codex authentication failed. Complete login and rerun installer."
  }
}

Write-Step "Installing Codex Remote to $CodexRemoteHome..."
Write-Host "  Install mode: $selectedMode"

if ($selectedMode -eq "source") {
  Install-FromSource -HomePath $CodexRemoteHome -RepoUrl $CodexRemoteRepo -Branch $CodexRemoteBranch
}
else {
  Install-FromRelease -HomePath $CodexRemoteHome -RepoUrl $CodexRemoteRepo -AssetName $ReleaseAssetName -Tag $ReleaseTag
}

Write-Step "Installing CLI..."
$binDir = Join-Path $CodexRemoteHome "bin"
if (-not (Test-Path (Join-Path $binDir "codex-remote.ps1"))) {
  Abort "CLI script not found: $(Join-Path $binDir 'codex-remote.ps1')"
}
if (-not (Test-Path (Join-Path $binDir "codex-remote.cmd"))) {
  Abort "CLI wrapper not found: $(Join-Path $binDir 'codex-remote.cmd')"
}

Ensure-Path $binDir
Ensure-EnvFile $CodexRemoteHome

Write-Step "Self-host setup"
$selfHostScript = Join-Path $binDir "self-host.ps1"
if (-not (Test-Path $selfHostScript)) {
  Write-WarnLine "Self-host wizard not found at $selfHostScript"
  Write-WarnLine "Run 'codex-remote self-host' after installation."
}
elseif ($RunSelfHost) {
  if (-not (Test-Tool "bun")) {
    Write-WarnLine "self-host requires bun for build/deploy steps. Install bun first, then rerun 'codex-remote self-host'."
  }
  else {
    & $selfHostScript
  }
}
else {
  Write-Host "  Skipped cloud deployment. Set CODEX_REMOTE_RUN_SELF_HOST=1 to run it during install."
}

Write-Host ""
Write-Host "Codex Remote installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "  Get started:"
Write-Host "    codex-remote start     Start the anchor service"
Write-Host "    codex-remote doctor    Check your setup"
Write-Host "    codex-remote config    Edit configuration"
Write-Host "    codex-remote help      See all commands"
Write-Host ""
if ($selectedMode -eq "release") {
  Write-Host "  Installed from release asset: $ReleaseAssetName"
  Write-Host "  To force source mode later: set CODEX_REMOTE_INSTALL_MODE=source and rerun installer."
}
Write-Host "  If this is a new terminal session, reopen PowerShell to refresh PATH."
Write-Host ""
