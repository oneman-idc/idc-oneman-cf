param(
  [string]$EnvironmentFile = ".env.deploy.local",
  [switch]$SkipInstall,
  [switch]$SkipBootstrap
)

$ErrorActionPreference = "Stop"
$CloudflareRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvironmentPath = Join-Path $CloudflareRoot $EnvironmentFile

function Assert-NativeCommand {
  param([string]$Step)
  if ($LASTEXITCODE -ne 0) { throw "$Step failed with exit code $LASTEXITCODE" }
}

if (-not (Test-Path -LiteralPath $EnvironmentPath)) {
  throw "Missing $EnvironmentPath. Copy .env.deploy.local.example and fill it locally."
}

foreach ($Line in Get-Content -LiteralPath $EnvironmentPath -Encoding utf8) {
  if ($Line -match '^\s*#' -or $Line -notmatch '=') { continue }
  $Key, $Value = $Line -split '=', 2
  [Environment]::SetEnvironmentVariable($Key.Trim(), $Value.Trim(), "Process")
}

$Required = @("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CF_D1_DATABASE_ID", "CF_SECRET_KEY", "CF_MASTER_KEY", "CF_ADMIN_BOOTSTRAP_TOKEN")
foreach ($Name in $Required) {
  if (-not [Environment]::GetEnvironmentVariable($Name, "Process")) { throw "Missing required value: $Name" }
}

Push-Location $CloudflareRoot
try {
  if (-not $SkipInstall) {
    & npm.cmd install --no-audit --no-fund
    Assert-NativeCommand "npm install"
  }
  & node scripts/generate-config.mjs
  Assert-NativeCommand "Wrangler config generation"
  & node scripts/build-pages.mjs
  Assert-NativeCommand "Pages build"
  & npx.cmd wrangler d1 migrations apply vps-one-cf-beta --remote --config worker/wrangler.generated.toml
  Assert-NativeCommand "D1 migration"

  $Secrets = @{
    SECRET_KEY = $env:CF_SECRET_KEY
    MASTER_KEY = $env:CF_MASTER_KEY
    ADMIN_BOOTSTRAP_TOKEN = $env:CF_ADMIN_BOOTSTRAP_TOKEN
  }
  if ($env:RESEND_API_TOKEN) { $Secrets.RESEND_API_TOKEN = $env:RESEND_API_TOKEN }
  if ($env:EMAIL_FROM) { $Secrets.EMAIL_FROM = $env:EMAIL_FROM }
  foreach ($Entry in $Secrets.GetEnumerator()) {
    $Entry.Value | & npx.cmd wrangler secret put $Entry.Key --config worker/wrangler.generated.toml
    Assert-NativeCommand "Worker secret $($Entry.Key)"
  }

  & npx.cmd wrangler deploy --config worker/wrangler.generated.toml
  Assert-NativeCommand "Worker deployment"
  & npx.cmd wrangler pages deploy pages/dist --project-name vps-one-cf-beta --config pages/wrangler.generated.toml
  Assert-NativeCommand "Pages deployment"

  if ($env:CF_WORKER_URL) {
    $Health = Invoke-RestMethod -Uri ($env:CF_WORKER_URL.TrimEnd('/') + "/healthz") -TimeoutSec 20
    if ($Health.status -ne "ok") { throw "Worker health check failed" }
  }
  if ($env:CF_PAGES_URL) {
    $Page = Invoke-WebRequest -UseBasicParsing -Uri $env:CF_PAGES_URL -TimeoutSec 20
    if ($Page.StatusCode -ne 200 -or $Page.Content -notmatch "VPS-ONE CF BETA") { throw "Pages health check failed" }
  }

  if (-not $SkipBootstrap -and $env:CF_PAGES_URL -and $env:CF_ADMIN_EMAIL -and $env:CF_ADMIN_PASSWORD) {
    $Headers = @{ Authorization = "Bearer $($env:CF_ADMIN_BOOTSTRAP_TOKEN)" }
    $Body = @{ email = $env:CF_ADMIN_EMAIL; password = $env:CF_ADMIN_PASSWORD } | ConvertTo-Json
    try {
      Invoke-RestMethod -Method Post -Uri ($env:CF_PAGES_URL.TrimEnd('/') + "/api/bootstrap") -Headers $Headers -ContentType "application/json" -Body $Body -TimeoutSec 30 | Out-Null
    } catch {
      if ($_.Exception.Response.StatusCode.value__ -ne 409) { throw }
    }
  }
  Write-Output "Cloudflare Worker and Pages deployment completed."
} finally {
  Pop-Location
}
