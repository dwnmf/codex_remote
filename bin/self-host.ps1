#!/usr/bin/env pwsh

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:RepoRoot = Split-Path -Parent $script:ScriptDir
$script:CodexRemoteHome = if ($env:CODEX_REMOTE_HOME) {
  $env:CODEX_REMOTE_HOME
}
elseif (Test-Path (Join-Path $script:RepoRoot "services/orbit")) {
  $script:RepoRoot
}
else {
  Join-Path $HOME ".codex-remote"
}
$script:EnvFile = Join-Path $script:CodexRemoteHome ".env"
$script:OrbitDir = Join-Path $script:CodexRemoteHome "services/orbit"
$script:RootWranglerToml = Join-Path $script:CodexRemoteHome "wrangler.toml"
$script:OrbitWranglerToml = Join-Path $script:OrbitDir "wrangler.toml"
$script:MigrationsDir = Join-Path $script:CodexRemoteHome "migrations"

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

function Confirm-Yes([string]$Prompt) {
  $answer = Read-Host "$Prompt [Y/n]"
  if (-not $answer) { return $true }
  return $answer -match "^[Yy]"
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

function Ensure-CloudflareAuth() {
  & wrangler whoami | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-Pass "Cloudflare authenticated"
    return
  }

  Write-WarnLine "Not logged in to Cloudflare"
  Write-Host "  Running 'wrangler login'..."
  & wrangler login
  if ($LASTEXITCODE -ne 0) {
    Abort "Cloudflare login failed."
  }

  & wrangler whoami | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Abort "Cloudflare authentication failed after login."
  }

  Write-Pass "Cloudflare authenticated"
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

function Is-HttpsUrl([string]$Value) {
  if (-not $Value) { return $false }
  return $Value -match "^https://\S+$"
}

function Prompt-RequiredHttps([string]$Prompt) {
  while ($true) {
    $value = (Read-Host $Prompt).Trim()
    if (Is-HttpsUrl $value) {
      return $value
    }
    Write-WarnLine "Please enter a valid https:// URL."
  }
}

function Extract-Url([string]$Text, [string]$Pattern) {
  $match = [regex]::Match($Text, $Pattern)
  if ($match.Success) {
    return $match.Value
  }
  return ""
}

function Has-WranglerErrorOutput([string]$Output) {
  if (-not $Output) { return $false }
  return [regex]::IsMatch($Output, "(?m)^\s*X\s+\[?ERROR\]?")
}

function Normalize-PagesUrl([string]$Url) {
  if (-not $Url) { return $Url }
  try {
    $uri = [Uri]$Url
    $host = $uri.Host
    if ($host -match "^[^.]+\.[^.]+\.pages\.dev$") {
      $parts = $host.Split(".")
      return "https://$($parts[1]).$($parts[2]).$($parts[3])"
    }
    return "https://$host"
  }
  catch {
    return $Url
  }
}

function Update-DatabaseIdToml([string]$TomlPath, [string]$DatabaseId) {
  $content = Get-Content $TomlPath -Raw
  $pattern = 'database_id\s*=\s*"[^"]*"'
  if (-not [regex]::IsMatch($content, $pattern)) {
    Abort "Failed to update database_id in $TomlPath"
  }
  $updated = [regex]::Replace($content, $pattern, "database_id = `"$DatabaseId`"", 1)
  if ($updated -ne $content) {
    Set-Content -Path $TomlPath -Value $updated -NoNewline
  }
}

function Generate-VapidKeys() {
  $output = & bun --silent -e @'
const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
const toBase64Url = (bytes) => Buffer.from(bytes)
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/g, "");
console.log(`VAPID_PUBLIC_KEY=${toBase64Url(rawPublic)}`);
console.log(`VAPID_PRIVATE_KEY=${privateJwk.d ?? ""}`);
'@
  if ($LASTEXITCODE -ne 0) {
    Abort "Failed to generate VAPID keys."
  }

  $public = (($output | Where-Object { $_ -like "VAPID_PUBLIC_KEY=*" }) -replace "^VAPID_PUBLIC_KEY=", "").Trim()
  $private = (($output | Where-Object { $_ -like "VAPID_PRIVATE_KEY=*" }) -replace "^VAPID_PRIVATE_KEY=", "").Trim()
  if (-not $public -or -not $private) {
    Abort "Failed to parse generated VAPID keys."
  }

  return @{
    Public = $public
    Private = $private
  }
}

function Get-OrCreateDatabaseId() {
  $dbListJson = & wrangler d1 list --json 2>$null
  if ($LASTEXITCODE -ne 0) {
    Abort "Failed to list D1 databases."
  }

  $dbId = ""
  try {
    $dbList = $dbListJson | ConvertFrom-Json
    if ($dbList) {
      $existing = $dbList | Where-Object { $_.name -eq "codex-remote" } | Select-Object -First 1
      if ($existing) {
        $dbId = $existing.uuid
      }
    }
  }
  catch {
    # fallback below
  }

  if ($dbId) {
    return $dbId
  }

  $createOutput = (& wrangler d1 create codex-remote 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) {
    Abort "Could not create D1 database 'codex-remote'. Output:`n$createOutput"
  }

  $uuidMatch = [regex]::Match($createOutput, "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
  if ($uuidMatch.Success) {
    return $uuidMatch.Value
  }

  $retryListJson = & wrangler d1 list --json 2>$null
  if ($LASTEXITCODE -eq 0) {
    try {
      $retryList = $retryListJson | ConvertFrom-Json
      $created = $retryList | Where-Object { $_.name -eq "codex-remote" } | Select-Object -First 1
      if ($created) {
        return $created.uuid
      }
    }
    catch {
      # fallback to manual prompt
    }
  }

  while ($true) {
    $manual = (Read-Host "Enter your D1 database ID (UUID)").Trim()
    if ($manual -match "^[0-9a-fA-F-]{36}$") {
      return $manual
    }
    Write-WarnLine "Invalid UUID format."
  }
}

function Set-OrbitSecret([string]$Name, [string]$Value) {
  Push-Location $script:OrbitDir
  try {
    $ok = $false
    $lastOut = ""
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      try {
        $lastOut = ($Value | wrangler versions secret put $Name 2>&1 | Out-String)
        if ($LASTEXITCODE -eq 0 -and -not (Has-WranglerErrorOutput $lastOut)) {
          $ok = $true
          break
        }
      }
      catch {
        $lastOut = $_.Exception.Message
      }
      if ($attempt -lt 3) {
        Write-WarnLine "Setting secret $Name failed (attempt $attempt/3); retrying in 2s..."
        Start-Sleep -Seconds 2
      }
    }
    if (-not $ok) {
      Abort "Failed to set orbit secret: $Name`n$lastOut"
    }
  }
  finally {
    Pop-Location
  }

  Write-Pass "$Name set"
}

function Deploy-Orbit() {
  Push-Location $script:OrbitDir
  try {
    $output = (& wrangler deploy 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0 -or (Has-WranglerErrorOutput $output)) {
      Abort "Orbit deploy failed.`n$output"
    }
    return $output
  }
  finally {
    Pop-Location
  }
}

Write-Step "0. Validating local setup"
if (-not (Test-Path $script:CodexRemoteHome)) { Abort "CODEX_REMOTE_HOME not found: $script:CodexRemoteHome" }
if (-not (Test-Path $script:OrbitDir)) { Abort "Orbit service not found at $script:OrbitDir" }
if (-not (Test-Path $script:RootWranglerToml)) { Abort "Missing $script:RootWranglerToml" }
if (-not (Test-Path $script:OrbitWranglerToml)) { Abort "Missing $script:OrbitWranglerToml" }
if (-not (Test-Path $script:MigrationsDir)) { Abort "Missing migrations directory at $script:MigrationsDir" }
if (-not (Test-Tool "bun")) { Abort "bun is required. Install bun and rerun this wizard." }
if (-not (Test-Tool "openssl")) { Abort "openssl is required to generate secrets." }
Write-Pass "Local files verified"

Write-Step "1. Checking prerequisites"
if (-not (Test-Tool "wrangler")) {
  Write-WarnLine "wrangler not found"
  if (Confirm-Yes "Install wrangler globally via bun?") {
    Invoke-Retry 3 3 "wrangler install" { & bun add -g wrangler }
  }
  else {
    Abort "wrangler is required. Run: bun add -g wrangler"
  }
}
Write-Pass "wrangler installed"

Ensure-CloudflareAuth

Write-Step "2. Creating D1 database"
$databaseId = Invoke-Retry 1 0 "D1 setup" { Get-OrCreateDatabaseId }
if (-not $databaseId) {
  Abort "Failed to obtain D1 database ID."
}
Write-Pass "Database ID: $databaseId"

Write-Step "3. Updating wrangler.toml configurations"
Update-DatabaseIdToml $script:RootWranglerToml $databaseId
Write-Pass "Updated root wrangler.toml"
Update-DatabaseIdToml $script:OrbitWranglerToml $databaseId
Write-Pass "Updated orbit wrangler.toml"

Write-Step "4. Generating secrets"
$webJwtSecret = (& openssl rand -base64 32).Trim()
$anchorJwtSecret = (& openssl rand -base64 32).Trim()
$vapid = Generate-VapidKeys
$vapidSubject = "mailto:admin@codex-remote.invalid"
Write-Pass "CODEX_REMOTE_WEB_JWT_SECRET generated"
Write-Pass "CODEX_REMOTE_ANCHOR_JWT_SECRET generated"
Write-Pass "VAPID keypair generated"

Write-Step "5. Running database migrations"
Push-Location $script:CodexRemoteHome
try {
  & wrangler d1 migrations apply codex-remote --remote
}
finally {
  Pop-Location
}
if ($LASTEXITCODE -ne 0) {
  Abort "Database migrations failed."
}
Write-Pass "Migrations applied"

Write-Step "6. Deploying orbit worker"
Push-Location $script:OrbitDir
try {
  Invoke-Retry 3 3 "Orbit dependency install" { & bun install --silent }
}
finally {
  Pop-Location
}

$orbitOutput = Deploy-Orbit
Write-Host $orbitOutput

Set-OrbitSecret "CODEX_REMOTE_WEB_JWT_SECRET" $webJwtSecret
Set-OrbitSecret "CODEX_REMOTE_ANCHOR_JWT_SECRET" $anchorJwtSecret

$orbitUrl = Extract-Url $orbitOutput "https://[^\s]+\.workers\.dev"
if (-not (Is-HttpsUrl $orbitUrl)) {
  Write-WarnLine "Could not detect orbit URL from deploy output."
  $orbitUrl = Prompt-RequiredHttps "Enter your orbit worker URL (https://...workers.dev)"
}
Write-Pass "Orbit worker deployed: $orbitUrl"
$orbitWsUrl = ($orbitUrl -replace "^https://", "wss://") + "/ws/anchor"

Write-Step "7. Building and deploying web frontend"
Push-Location $script:CodexRemoteHome
try {
  Invoke-Retry 3 3 "Web dependency install" { & bun install --silent }
}
finally {
  Pop-Location
}

Invoke-WithEnv @{ AUTH_URL = $orbitUrl; VAPID_PUBLIC_KEY = $vapid.Public; AUTH_MODE = "passkey" } {
  Push-Location $script:CodexRemoteHome
  try {
    & bun run build
  }
  finally {
    Pop-Location
  }
}
if ($LASTEXITCODE -ne 0) {
  Abort "Failed to build web frontend."
}

Invoke-WithEnv @{ CI = "true" } {
  Push-Location $script:CodexRemoteHome
  try {
    & wrangler pages project create codex-remote --production-branch main | Out-Null
  }
  finally {
    Pop-Location
  }
}
if ($LASTEXITCODE -eq 0) {
  Write-Pass "Pages project ready"
}

$pagesOutput = ""
Invoke-WithEnv @{ CI = "true" } {
  Push-Location $script:CodexRemoteHome
  try {
    $script:pagesOutput = (& wrangler pages deploy dist --project-name codex-remote --commit-dirty=true 2>&1 | Out-String)
  }
  finally {
    Pop-Location
  }
}
if ($LASTEXITCODE -ne 0) {
  Abort "Failed to deploy web frontend to Pages.`n$pagesOutput"
}
Write-Host $pagesOutput

$pagesUrl = Extract-Url $pagesOutput "https://[^\s]+\.pages\.dev"
if ($pagesUrl) {
  $pagesUrl = Normalize-PagesUrl $pagesUrl
}
if (-not (Is-HttpsUrl $pagesUrl)) {
  Write-WarnLine "Could not detect a valid web URL from deploy output."
  $pagesUrl = Prompt-RequiredHttps "Enter your Pages URL (https://...pages.dev)"
}
Write-Pass "Web deployed: $pagesUrl"

Write-Step "8. Setting PASSKEY_ORIGIN and push secrets"
try {
  $pagesHost = ([Uri]$pagesUrl).Host
  if ($pagesHost) {
    $vapidSubject = "mailto:admin@$pagesHost"
  }
}
catch {
  # keep default subject
}

Set-OrbitSecret "PASSKEY_ORIGIN" $pagesUrl
Set-OrbitSecret "VAPID_PUBLIC_KEY" $vapid.Public
Set-OrbitSecret "VAPID_PRIVATE_KEY" $vapid.Private
Set-OrbitSecret "VAPID_SUBJECT" $vapidSubject

$null = Deploy-Orbit
Write-Pass "Orbit redeployed"

Write-Step "9. Configuring anchor"
$envContent = @(
  "# Codex Remote Anchor Configuration (self-host)"
  "ANCHOR_PORT=8788"
  "ANCHOR_ORBIT_URL=$orbitWsUrl"
  "AUTH_URL=$orbitUrl"
  "AUTH_MODE=passkey"
  "VAPID_PUBLIC_KEY=$($vapid.Public)"
  "ANCHOR_JWT_TTL_SEC=300"
  "ANCHOR_APP_CWD="
  "D1_DATABASE_ID=$databaseId"
) -join "`n"

Set-Content -Path $script:EnvFile -Value $envContent
Write-Pass "Anchor configuration saved to $script:EnvFile"

Write-Host ""
Write-Host "Self-host deployment complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Web:   $pagesUrl"
Write-Host "  Orbit: $orbitUrl"
Write-Host ""
Write-Host "  Next steps:"
Write-Host "    1. Open $pagesUrl and create your account"
Write-Host "    2. Run codex-remote start"
