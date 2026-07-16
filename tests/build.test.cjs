"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const build = path.join(root, "build");

const replacements = {
  "/*__CSS__*/": "app.css",
  "/*__XLSX__*/": "xlsx.full.min.js",
  "/*__JSZIP__*/": "jszip.min.js",
  "/*__CHART__*/": "chart.umd.min.js",
  "/*__DATALABELS__*/": "chartjs-plugin-datalabels.min.js",
  "/*__HTML2CANVAS__*/": "html2canvas.min.js",
  "/*__JSPDF__*/": "jspdf.umd.min.js",
  "/*__CORE__*/": "app-core.js",
  "/*__PARSERS__*/": "app-parsers.js",
  "/*__METRICS__*/": "app-metrics.js",
  "/*__UI__*/": "app-ui.js",
};

function assemble() {
  let html = fs.readFileSync(path.join(build, "index.template.html"), "utf8");
  for (const [marker, fileName] of Object.entries(replacements)) {
    assert.ok(html.includes(marker), `template marker missing: ${marker}`);
    const content = fs.readFileSync(path.join(build, fileName), "utf8");
    html = html.replace(marker, () => content);
  }
  return html;
}

test("assembled HTML is reproducible and complete", () => {
  const expected = assemble().replace(/\r\n/g, "\n");
  const actual = fs.readFileSync(path.join(root, "index.html"), "utf8").replace(/\r\n/g, "\n");
  assert.equal(actual, expected);
  assert.doesNotMatch(actual, /\/\*__[A-Z0-9_]+__\*\//);
  for (const id of ["lib-xlsx", "lib-jszip", "lib-html2canvas", "lib-jspdf"]) {
    assert.match(actual, new RegExp(`<script type="text/plain" id="${id}">`));
  }
  for (const required of ["btnExportAllPdf", "desktopWorkspaceCard", "btnScanInput", "Content-Security-Policy", "departmentBody", "departmentFilter", "departmentMonth"]) {
    assert.match(actual, new RegExp(required));
  }
  assert.match(actual, /data-tab="department">🏥 Отделение/);
  assert.match(actual, /data-tab="dept">🩺 Профили врачей/);
  assert.match(actual, /Нужны специализации/);
  assert.match(actual, /setDoctorDepartment/);
  assert.match(actual, /Персональные цели и нормативы врача/);
  assert.match(actual, /doctorMetricSettingsCard/);
  for (const profileMetric of ["Пациентов за месяц", "Количество визитов за месяц", "Объём активной клиентской базы"]) {
    assert.match(actual, new RegExp(profileMetric));
  }
  assert.match(actual, /<title>Пульс клиники<\/title>/);
  assert.match(actual, /class="logo-work">Пульс<\/span>/);
  assert.match(actual, /class="logo-doctors">клиники<\/span>/);
  assert.match(actual, /Записей врача на 100 визитов/);
  assert.match(actual, /Фактическая загрузка пациентами/);
  assert.match(actual, /ПАЦИЕНТЫ ПО СЕГМЕНТУ/);
  assert.match(actual, /\.logo-work\s*\{\s*color:\s*#65a30d;/);
  assert.match(actual, /\.logo-doctors\s*\{\s*color:\s*#7c3aed;/);
  assert.doesNotMatch(actual, /Трафик: визиты за месяц/);
});

test("first-run folder prompt is attached to a visible application window", () => {
  const source = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(packageJson.build.productName, "Пульс клиники");
  assert.match(source, /const APP_NAME = "Пульс клиники"/);
  assert.match(source, /legacyUserData[\s\S]*Оценка врачей/);
  const visibleWindow = source.indexOf("mainWindow.show();");
  const firstRunPrompt = source.indexOf("promptForWorkspaceOnFirstRun().catch");
  assert.ok(visibleWindow >= 0, "the main window must be shown during startup");
  assert.ok(firstRunPrompt > visibleWindow, "the workspace prompt must open after the main window is shown");
  assert.match(source, /dialog\.showOpenDialog\(mainWindow,/);
  assert.match(source, /result\.canceled[\s\S]*configStore\.markConfigured\(\)/);
  assert.match(source, /requestedRoot[\s\S]*configStore\.markConfigured\(\)/);
});

test("empty states and imports expose safe, accessible controls", () => {
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const parsers = fs.readFileSync(path.join(build, "app-parsers.js"), "utf8");
  const core = fs.readFileSync(path.join(build, "app-core.js"), "utf8");
  const css = fs.readFileSync(path.join(build, "app.css"), "utf8");

  assert.match(ui, /setControlsDisabled\(\["btnXlsx"[\s\S]*!months\.length\)/);
  assert.match(ui, /setControlsDisabled\(\["repMonth"[\s\S]*!months\.length\)/);
  assert.match(parsers, /fileImportInProgress/);
  assert.match(parsers, /aria-busy/);
  assert.match(core, /aria-live/);
  assert.match(css, /\.btn:disabled/);
});
