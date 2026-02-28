#!/usr/bin/env pwsh

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:RepoRoot = Split-Path -Parent $script:ScriptDir
$defaultHome = Join-Path $HOME ".codex-remote"
$script:CodexRemoteHome = if ($env:CODEX_REMOTE_HOME) {
  $env:CODEX_REMOTE_HOME
}
elseif (Test-Path (Join-Path $script:RepoRoot "services/orbit-deno")) {
  $script:RepoRoot
}
elseif (Test-Path (Join-Path $defaultHome "services/orbit-deno")) {
  $defaultHome
}
else {
  $defaultHome
}
$script:EnvFile = Join-Path $script:CodexRemoteHome ".env"

function Write-Step([string]$Message) { Write-Host ""; Write-Host $Message -ForegroundColor Cyan }
function Write-Pass([string]$Message) { Write-Host "  [OK] $Message" -ForegroundColor Green }
function Write-WarnLine([string]$Message) { Write-Host "  [WARN] $Message" -ForegroundColor Yellow }
function Abort([string]$Message) { throw $Message }

function Test-Tool([string]$Name) { return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue) }

function Confirm-Yes([string]$Prompt) {
  $answer = Read-Host "$Prompt [Y/n]"
  if (-not $answer) { return $true }
  return $answer -match "^[Yy]"
}

function Ensure-Bun() {
  if (Test-Tool "bun") { Write-Pass "bun $(& bun --version)"; return }
  Write-WarnLine "bun not found"
  if (-not (Confirm-Yes "Install bun automatically now?")) { Abort "bun is required." }
  & powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1|iex"
  if ($LASTEXITCODE -ne 0) { Abort "Failed to install bun." }
  if (-not (Test-Tool "bun")) { Abort "bun installation completed but bun is unavailable." }
  Write-Pass "bun $(& bun --version)"
}

function Ensure-Deno() {
  if (Test-Tool "deno") { Write-Pass "deno installed"; return }
  Write-WarnLine "deno not found"
  if (-not (Confirm-Yes "Install deno automatically now?")) { Abort "deno is required." }
  & powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://deno.land/install.ps1 | iex"
  if ($LASTEXITCODE -ne 0) { Abort "Failed to install deno." }
  if (-not (Test-Tool "deno")) { Abort "deno installation completed but deno is unavailable." }
  Write-Pass "deno installed"
}

function Invoke-Deployctl([string[]]$DeployArgs) {
  if (Test-Tool "deployctl") {
    & deployctl @DeployArgs
    return
  }
  if (Test-Tool "deno") {
    & deno run -A jsr:@deno/deployctl @DeployArgs
    return
  }
  Abort "deployctl is unavailable (install deployctl or deno)."
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

function Read-Secret([string]$Prompt) {
  $secure = Read-Host -Prompt $Prompt -AsSecureString
  if (-not $secure) { return "" }

  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

function Test-DenoDeployToken([string]$Token) {
  if (-not $Token) {
    return [pscustomobject]@{
      Ok = $false
      Output = "Empty token"
    }
  }

  $previous = [Environment]::GetEnvironmentVariable("DENO_DEPLOY_TOKEN", "Process")
  try {
    [Environment]::SetEnvironmentVariable("DENO_DEPLOY_TOKEN", $Token, "Process")
    $output = (Invoke-Deployctl -DeployArgs @("projects", "list") 2>&1 | Out-String).Trim()
    return [pscustomobject]@{
      Ok = ($LASTEXITCODE -eq 0)
      Output = $output
    }
  }
  finally {
    [Environment]::SetEnvironmentVariable("DENO_DEPLOY_TOKEN", $previous, "Process")
  }
}

function Ensure-DeployAuth() {
  $processToken = [Environment]::GetEnvironmentVariable("DENO_DEPLOY_TOKEN", "Process")
  $processCheck = Test-DenoDeployToken $processToken
  if ($processCheck.Ok) {
    Write-Pass "Deno Deploy authenticated"
    return
  }

  $envFileToken = Get-EnvValue "DENO_DEPLOY_TOKEN"
  $envFileCheck = Test-DenoDeployToken $envFileToken
  if ($envFileCheck.Ok) {
    [Environment]::SetEnvironmentVariable("DENO_DEPLOY_TOKEN", $envFileToken, "Process")
    Write-Pass "Deno Deploy authenticated (token from .env)"
    return
  }

  Write-WarnLine "DENO_DEPLOY_TOKEN is not configured"
  Write-Host "  Create a token: https://dash.deno.com/account#access-tokens"
  $token = (Read-Secret "DENO_DEPLOY_TOKEN").Trim()
  if (-not $token) { Abort "DENO_DEPLOY_TOKEN is required." }
  $tokenCheck = Test-DenoDeployToken $token
  if (-not $tokenCheck.Ok) {
    $details = if ($tokenCheck.Output) { $tokenCheck.Output } else { "No additional details from deployctl." }
    Abort @"
DENO_DEPLOY_TOKEN is invalid or has insufficient permissions.

deployctl output:
$details

Hint: deployctl works with Deno Deploy Classic organizations.
If your account/org exists only in the new Deno Deploy platform, deployctl auth will fail.
"@
  }
  [Environment]::SetEnvironmentVariable("DENO_DEPLOY_TOKEN", $token, "Process")
  Write-Pass "Deno Deploy authenticated"
}

function Generate-JwtSecret() {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return [Convert]::ToBase64String($bytes)
}

function Generate-VapidPublicKey() {
  $script = @'
const kp = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
const toBase64Url = (bytes) =>
  Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
console.log(toBase64Url(raw));
'@
  $output = & bun --silent -e $script
  if ($LASTEXITCODE -ne 0 -or -not $output) { Abort "Failed to generate VAPID key." }
  return ($output | Select-Object -Last 1).Trim()
}

function Deploy-Deno([string]$Project, [string]$AuthUrl, [string]$WebSecret, [string]$AnchorSecret, [string]$PasskeyOrigin, [bool]$IncludeDist) {
  $args = @(
    "deploy",
    "--project=$Project",
    "--entrypoint=./services/orbit-deno/main.ts",
    "--include=./services/orbit-deno/**",
    "--include=./services/orbit/src/**",
    "--prod",
    "--env=AUTH_MODE=passkey",
    "--env=CODEX_REMOTE_WEB_JWT_SECRET=$WebSecret",
    "--env=CODEX_REMOTE_ANCHOR_JWT_SECRET=$AnchorSecret",
    "--env=PASSKEY_ORIGIN=$PasskeyOrigin",
    "--env=DEVICE_VERIFICATION_URL=$AuthUrl/device",
    "--env=CORS_ORIGINS=$AuthUrl"
  )

  if ($IncludeDist) { $args += "--include=./dist/**" }

  Push-Location $script:CodexRemoteHome
  try {
    $out = (Invoke-Deployctl -DeployArgs $args 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { Abort "Deno deploy failed.`n$out" }
    return $out
  }
  finally {
    Pop-Location
  }
}

function Extract-Url([string]$Text) {
  $match = [regex]::Match($Text, "https://[^\s]+\.(deno\.dev|deno\.net)")
  if ($match.Success) { return $match.Value }
  return ""
}

Write-Step "0. Validating local setup"
if (-not (Test-Path (Join-Path $script:CodexRemoteHome "services/orbit-deno/main.ts"))) { Abort "Missing services/orbit-deno/main.ts" }
Write-Pass "Local files verified"
Write-Pass "CODEX_REMOTE_HOME: $script:CodexRemoteHome"

Write-Step "1. Checking prerequisites"
Ensure-Bun
Ensure-Deno
Ensure-DeployAuth

Write-Step "2. Preparing project"
$projectName = "codex-remote"
$projectInput = (Read-Host "Deno Deploy project name [$projectName]").Trim()
if ($projectInput) { $projectName = $projectInput }
Write-Pass "Project: $projectName"

Write-Step "3. Generating secrets"
$webSecret = Generate-JwtSecret
$anchorSecret = Generate-JwtSecret
$vapidPublic = Generate-VapidPublicKey
Write-Pass "JWT and VAPID secrets generated"

Write-Step "4. Deploying backend (bootstrap)"
$bootstrapOutput = Deploy-Deno -Project $projectName -AuthUrl "https://example.com" -WebSecret $webSecret -AnchorSecret $anchorSecret -PasskeyOrigin "https://example.com" -IncludeDist:$false
Write-Host $bootstrapOutput
$orbitUrl = Extract-Url $bootstrapOutput
if (-not $orbitUrl) { $orbitUrl = (Read-Host "Enter deployment URL (https://...)").Trim() }
if (-not $orbitUrl.StartsWith("https://")) { Abort "Invalid deployment URL." }
Write-Pass "Backend URL: $orbitUrl"

Write-Step "5. Building web"
Push-Location $script:CodexRemoteHome
try {
  & bun install --silent
  if ($LASTEXITCODE -ne 0) { Abort "Failed to install web dependencies." }
  $env:AUTH_URL = $orbitUrl
  $env:AUTH_MODE = "passkey"
  $env:VAPID_PUBLIC_KEY = $vapidPublic
  & bun run build
  if ($LASTEXITCODE -ne 0) { Abort "Web build failed." }
}
finally {
  Pop-Location
}
Write-Pass "Web build complete"

Write-Step "6. Deploying backend + static web"
$finalOutput = Deploy-Deno -Project $projectName -AuthUrl $orbitUrl -WebSecret $webSecret -AnchorSecret $anchorSecret -PasskeyOrigin $orbitUrl -IncludeDist:$true
Write-Host $finalOutput
$finalUrl = Extract-Url $finalOutput
if ($finalUrl) { $orbitUrl = $finalUrl }

Write-Step "7. Configuring anchor"
$orbitWsUrl = ($orbitUrl -replace "^https://", "wss://") + "/ws/anchor"
$envContent = @(
  "# Codex Remote Anchor Configuration (self-host)",
  "SELF_HOST_PROVIDER=deno",
  "DENO_DEPLOY_PROJECT=$projectName",
  "DENO_DEPLOY_TOKEN=$([Environment]::GetEnvironmentVariable('DENO_DEPLOY_TOKEN','Process'))",
  "DENO_WEB_JWT_SECRET=$webSecret",
  "DENO_ANCHOR_JWT_SECRET=$anchorSecret",
  "ANCHOR_PORT=8788",
  "ANCHOR_ORBIT_URL=$orbitWsUrl",
  "AUTH_URL=$orbitUrl",
  "AUTH_MODE=passkey",
  "VAPID_PUBLIC_KEY=$vapidPublic",
  "ANCHOR_JWT_TTL_SEC=300",
  "ANCHOR_APP_CWD=",
  "D1_DATABASE_ID="
) -join "`n"
Set-Content -Path $script:EnvFile -Value $envContent
Write-Pass "Anchor configuration saved to $script:EnvFile"

Write-Host ""
Write-Host "Deno self-host deployment complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  App: $orbitUrl"
Write-Host "  WS:  $orbitWsUrl"
Write-Host ""
Write-Host "  Next steps:"
Write-Host "    1. Open $orbitUrl and create your account"
Write-Host "    2. Run codex-remote start"
