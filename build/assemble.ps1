# Build the standalone HTML from local source modules.
$ErrorActionPreference = "Stop"
$dir = $PSScriptRoot
$read = { param($f) [System.IO.File]::ReadAllText((Join-Path $dir $f), [System.Text.Encoding]::UTF8) }

$html = & $read "index.template.html"
$html = $html.Replace("/*__CSS__*/",     (& $read "app.css"))
$html = $html.Replace("/*__XLSX__*/",    (& $read "xlsx.full.min.js"))
$html = $html.Replace("/*__JSZIP__*/",   (& $read "jszip.min.js"))
$html = $html.Replace("/*__CHART__*/",   (& $read "chart.umd.min.js"))
$html = $html.Replace("/*__DATALABELS__*/", (& $read "chartjs-plugin-datalabels.min.js"))
$html = $html.Replace("/*__HTML2CANVAS__*/", (& $read "html2canvas.min.js"))
$html = $html.Replace("/*__JSPDF__*/",   (& $read "jspdf.umd.min.js"))
$html = $html.Replace("/*__CORE__*/",    (& $read "app-core.js"))
$html = $html.Replace("/*__PARSERS__*/", (& $read "app-parsers.js"))
$html = $html.Replace("/*__METRICS__*/", (& $read "app-metrics.js"))
$html = $html.Replace("/*__UI__*/",      (& $read "app-ui.js"))

if ($html -match "/\*__[A-Z0-9_]+__\*/") {
  throw "The assembled HTML still contains unresolved placeholders."
}

$projectDir = Split-Path $dir -Parent
$utf8 = New-Object System.Text.UTF8Encoding($false)
$rootOut = Join-Path $projectDir "index.html"
[System.IO.File]::WriteAllText($rootOut, $html, $utf8)

Write-Host "OK -> $rootOut"
