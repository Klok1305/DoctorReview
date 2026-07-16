param(
  [switch]$SkipInstall,
  [switch]$SmokeTest
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$pnpm = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source
if (-not $pnpm) {
  $pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue).Source
}
if (-not $pnpm) {
  throw "pnpm was not found. Install Node.js 22+ and pnpm 11+."
}

function Invoke-Pnpm([string[]]$CommandArgs) {
  & $pnpm @CommandArgs
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm failed with exit code ${LASTEXITCODE}: $($CommandArgs -join ' ')"
  }
}

if (-not $SkipInstall) {
  Invoke-Pnpm @("install", "--frozen-lockfile")
}
Invoke-Pnpm @("run", "assemble")
Invoke-Pnpm @("test")
if ($SmokeTest) {
  Invoke-Pnpm @("run", "test:smoke")
  Invoke-Pnpm @("run", "test:pdf")
}
Invoke-Pnpm @("run", "dist:all")

Write-Host "Done. Installer and portable packages are in $root\dist"
