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
$html = $html.Replace("/*__VIEWER_HTML_SANITIZER__*/", (& $read "viewer-html-sanitizer.js"))
$html = $html.Replace("/*__CORE__*/",    (& $read "app-core.js"))
$html = $html.Replace("/*__PARSERS__*/", (& $read "app-parsers.js"))
$html = $html.Replace("/*__METRICS__*/", (& $read "app-metrics.js"))
$html = $html.Replace("/*__REPORT_WORKER__*/", (& $read "report-worker.js"))
$html = $html.Replace("/*__REPORT_PERFORMANCE__*/", (& $read "report-performance.js"))
$html = $html.Replace("/*__REPORT_PRESENTATION__*/", [System.IO.File]::ReadAllText((Join-Path (Split-Path $dir -Parent) "mobile-pilot/report-presentation.js"), [System.Text.Encoding]::UTF8))
$html = $html.Replace("/*__CLOUD_REPORT_DATA__*/", (& $read "cloud-report-data.js"))
$html = $html.Replace("/*__PIN_TRANSFER_UI__*/", (& $read "pin-transfer-ui.js"))
$ui = & $read "app-ui.js"
$ui = [System.Text.RegularExpressions.Regex]::Replace(
  $ui,
  "(?s)/\*__REMOVED_DOCTOR_ACCESS_START__\*/.*?/\*__REMOVED_DOCTOR_ACCESS_END__\*/",
  ""
)
$html = $html.Replace("/*__UI__*/",      $ui)

if ($html -match "/\*__[A-Z0-9_]+__\*/") {
  throw "The assembled HTML still contains unresolved placeholders."
}

$projectDir = Split-Path $dir -Parent
$utf8 = New-Object System.Text.UTF8Encoding($false)
$rootOut = Join-Path $projectDir "index.html"
[System.IO.File]::WriteAllText($rootOut, $html, $utf8)

Write-Host "OK -> $rootOut"
