param()

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Test-MatchesAny([string]$Value, [string[]]$Patterns) {
  foreach ($pattern in $Patterns) {
    if ($Value -match $pattern) { return $true }
  }
  return $false
}

$allowedPatterns = @(
  '^\.gitattributes$',
  '^\.gitignore$',
  '^\.github/workflows/(ci|release)\.yml$',
  '^README\.md$',
  '^index\.html$',
  '^package\.json$',
  '^pnpm-lock\.yaml$',
  '^pnpm-workspace\.yaml$',
  '^build/[^/]+\.(js|css|html|ps1)$',
  '^desktop/[^/]+\.cjs$',
  '^desktop/services/[^/]+\.cjs$',
  '^docs/[^/]+\.md$',
  '^resources/(app-icon\.(ico|png)|update-config\.json)$',
  '^scripts/[^/]+\.(ps1|py)$',
  '^tests/[^/]+\.test\.cjs$'
)

$blockedPatterns = @(
  '(^|/)(node_modules|dist|out|tmp|output)(/|$)',
  '\.(sqlite|sqlite-shm|sqlite-wal|db|db-shm|db-wal|ovbackup|xls|xlsx|xlsm|csv|tsv|pdf|zip|7z|rar|log|exe|msi|blockmap)$',
  '(^|/)latest\.yml$',
  '(^|/)config\.json$',
  '(^|/)\.env(?:\..+)?$',
  '\.(pem|pfx|p12|key)$'
)

$files = @(& git -c core.quotepath=false ls-files --cached --others --exclude-standard) |
  ForEach-Object { $_ -replace '\\', '/' } |
  Sort-Object -Unique
if ($LASTEXITCODE -ne 0) { throw "Could not read the Git file list." }

$problems = [System.Collections.Generic.List[string]]::new()
$secretPattern = '(?i)(github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)'
$textExtensions = @('.cjs', '.css', '.html', '.js', '.json', '.md', '.ps1', '.py', '.yaml', '.yml')

foreach ($file in $files) {
  if (-not (Test-MatchesAny $file $allowedPatterns)) {
    $problems.Add("not on the source allowlist: $file")
    continue
  }
  if (Test-MatchesAny $file $blockedPatterns) {
    $problems.Add("looks like user data, a build artifact, or a secret: $file")
    continue
  }
  if ($file.EndsWith('.json') -and $file -notin @('package.json', 'resources/update-config.json')) {
    $problems.Add("JSON is not explicitly allowed and may contain user data: $file")
    continue
  }

  $item = Get-Item -LiteralPath $file
  if ($item.Length -gt 5MB) {
    $problems.Add("file exceeds 5 MB and requires manual review: $file")
  }

  $isGeneratedOrVendored = $file -eq 'index.html' -or $file.EndsWith('.min.js')
  if (($textExtensions -contains $item.Extension.ToLowerInvariant()) -and -not $isGeneratedOrVendored) {
    $content = [System.IO.File]::ReadAllText($item.FullName)
    if ($content -match $secretPattern) {
      $problems.Add("content looks like a secret: $file")
    }
  }
}

if ($problems.Count -gt 0) {
  Write-Error ("Repository safety audit failed:`n - " + ($problems -join "`n - "))
}

Write-Host "Repository safety audit passed: $($files.Count) files, no user data or secrets detected."
