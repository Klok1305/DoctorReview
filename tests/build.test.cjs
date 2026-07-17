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
  for (const required of ["btnExportAllPdf", "btnSaveSession", "desktopWorkspaceCard", "btnScanInput", "Content-Security-Policy", "departmentBody", "departmentFilter", "departmentMonth"]) {
    assert.match(actual, new RegExp(required));
  }
  assert.match(actual, /function pdfReportTargets/);
  assert.match(actual, /function cloneDashboardForPdf/);
  assert.match(actual, /function splitDynamicPdfSection/);
  assert.match(actual, /async function saveSessionState/);
  assert.match(actual, /Все изменения текущей сессии сохранены/);
  assert.match(actual, /Сохранить копию базы/);
  assert.match(actual, /pdf-chart-image/);
  assert.match(actual, /pdf-continuation-title/);
  assert.match(actual, /relativePath:\s*target\.relativePath/);
  assert.match(actual, /\["Отделения",\s*departmentName\]/);
  assert.match(actual, /"Специализации"/);
  assert.match(actual, /"Врачи"/);
  assert.match(actual, /полные PDF дашбордов отделений, специализаций и врачей со всеми графиками/);
  assert.match(actual, /data-tab="department">🏥 Отделение/);
  assert.match(actual, /data-tab="dept">🩺 Специализации/);
  assert.match(actual, /Нужны специализации/);
  assert.match(actual, /setDoctorDepartment/);
  assert.match(actual, /Индивидуальные цели врача/);
  assert.match(actual, /doctorMetricSettingsCard/);
  assert.match(actual, /clinic-tree/);
  assert.match(actual, /selectSettingsStructure/);
  assert.match(actual, /openDoctorGoalSettings/);
  assert.match(actual, /draggable="true"/);
  assert.match(actual, /startDoctorStructureDrag/);
  assert.match(actual, /dropDoctorOnStructure/);
  assert.match(actual, /Перетащите карточку врача/);
  assert.match(actual, /clinic-tree-direct/);
  assert.match(actual, /Нормативы настраиваются только на уровне специализации/);
  assert.match(actual, /Векторы и веса специализации/);
  assert.match(actual, /Цели отделения/);
  assert.match(actual, /\+ Добавить врача/);
  assert.match(actual, /addDoctorV4/);
  for (const profileMetric of ["Пациентов за месяц", "Загрузка расписания", "Коэффициент визитов на пациента за месяц", "Коэффициент визитов на пациента за 12 мес.", "Объём активной клиентской базы"]) {
    assert.match(actual, new RegExp(profileMetric));
  }
  assert.doesNotMatch(actual, /📅 Количество визитов за месяц/);
  assert.match(actual, /<title>Пульс клиники<\/title>/);
  assert.match(actual, /class="logo-work">Пульс<\/span>/);
  assert.match(actual, /class="logo-doctors">клиники<\/span>/);
  assert.match(actual, /Загрузка расписания/);
  assert.match(actual, /Пациенты за месяц/);
  assert.match(actual, /Загрузка отделения/);
  assert.match(actual, /currentLoadPct/);
  assert.match(actual, /sberhealth/);
  assert.doesNotMatch(actual, /yandex/);
  assert.match(actual, /Собственная запись в 1С/);
  assert.match(actual, /собственных записей \/.*всех визитов за месяц × 100%/);
  assert.match(actual, /За выбранный месяц текущего значения нет/);
  assert.doesNotMatch(actual, /Фактическая загрузка пациентами/);
  assert.doesNotMatch(actual, /Записей врача на 100 визитов/);
  assert.doesNotMatch(actual, /Пациентов в «зоне риска»|дедупликация по ID, иначе по ФИО/);
  assert.doesNotMatch(fs.readFileSync(path.join(build, "app-ui.js"), "utf8"), /Продажи/);
  assert.doesNotMatch(fs.readFileSync(path.join(build, "app-metrics.js"), "utf8"), /Продажи/);
  assert.match(actual, /Цель специализации/);
  assert.match(actual, /Зелёный — цель специализации выполнена, красный — не выполнена/);
  assert.match(actual, /compare-goal-cell/);
  assert.match(actual, /function departmentGoalInfo/);
  assert.match(actual, /goalKey:\s*"revenue"/);
  assert.match(actual, /goalKey:\s*"crossShare"/);
  assert.match(actual, /goalLabel:\s*"доля активной базы"/);
  assert.match(actual, /goalLabel:\s*"потерянные за 3 года"/);
  assert.match(actual, /Итоговое значение зелёное, если цель отделения выполнена, красное — если не выполнена/);
  assert.match(actual, /\.kpi\.department-goal-good[^}]*var\(--good-soft\)/);
  assert.match(actual, /\.kpi\.department-goal-bad[^}]*var\(--bad-soft\)/);
  assert.match(actual, /targetKey:\s*"revenue"/);
  assert.match(actual, /targetKey:\s*"riskShare"[\s\S]*lower:\s*true/);
  assert.match(actual, /\.data td\.compare-goal-cell\.goal-good[^}]*var\(--good-soft\)/);
  assert.match(actual, /\.data td\.compare-goal-cell\.goal-bad[^}]*var\(--bad-soft\)/);
  assert.match(actual, /function scoreChartPicker/);
  assert.match(actual, /function setScoreChartMode/);
  assert.match(actual, /Показать график:/);
  assert.match(actual, /В1 Экономика/);
  assert.match(actual, /В6 Репутация/);
  assert.match(actual, /scoreChartSources/);
  assert.match(actual, /mode !== "all" \|\| ctx\.dataset\.label === "Общий балл"/);
  assert.match(actual, /\.score-chart-choice\.active[^}]*var\(--accent\)/);
  assert.match(actual, /function doctorGoalsSummaryHtml/);
  assert.match(actual, /🎯 Цели врача/);
  assert.match(actual, /doctor-goals-grid/);
  assert.match(actual, /индивидуальные цели/);
  assert.match(actual, /doctorGoalsSummaryHtml\(docId, reportProfile, false, r\)/);
  assert.match(actual, /const DOCTOR_GOAL_VECTORS/);
  assert.match(actual, /function doctorGoalFact/);
  assert.match(actual, /data-goal-vector/);
  assert.match(actual, /Факт:/);
  assert.match(actual, /doctor-goal-item \$\{state\}/);
  assert.match(actual, /saveCrossFocusSettings/);
  assert.match(actual, /Фокусы междисциплинарного подхода \(Вектор 3\)/);
  assert.match(actual, /chNazFocusQty/);
  assert.match(actual, /chNazFocusMoney/);
  assert.match(actual, /nazFocusShare/);
  assert.match(actual, /const lower = lowerGoals\.has\(goal\.key\)/);
  assert.match(actual, /ПАЦИЕНТЫ ПО СЕГМЕНТУ/);
  assert.match(actual, /collapsible-list-summary/);
  assert.match(actual, /rememberListToggle/);
  assert.match(actual, /clientSegmentPatients/);
  assert.match(actual, /clientSegmentRows/);
  assert.match(actual, /clientRowsForSegment/);
  assert.match(actual, /data-segment-value/);
  assert.match(actual, /aria-pressed/);
  assert.match(actual, /Применены индивидуальные настройки/);
  assert.match(actual, /Выгрузка базы подстраивается под эту специализацию/);
  assert.match(actual, /clientBaseRequiredWindow/);
  assert.match(actual, /kbWinByDoctor/);
  assert.match(actual, /appointmentDetails/);
  assert.doesNotMatch(actual, /primaryReturnDetails/);
  assert.doesNotMatch(actual, /ДЕТАЛИ ВОЗВРАЩАЕМОСТИ ПЕРВИЧКИ/);
  assert.match(actual, /const mirrorRevenuePlugin/);
  assert.match(actual, /mirrorGap\s*=\s*mirrorMax\s*\*\s*0\.08/);
  assert.match(actual, /ownRanges\[g\]\.push\(\[cursor, cursor \+ amount\]\)/);
  assert.match(actual, /refRevenueByMonth\.map\(amount => \[mirrorGap, mirrorGap \+ amount\]\)/);
  assert.match(actual, /plugins:\s*\[mirrorRevenuePlugin\]/);
  assert.match(actual, /refRevenueColor\s*=\s*"#334155"/);
  assert.match(actual, /Собственная выручка ←/);
  assert.match(actual, /→ Выручка от перенаправлений/);
  assert.doesNotMatch(actual, /xAxisID:\s*"xRef"|borderDash:\s*\[7,\s*4\]/);
  assert.match(actual, /Выводы и комментарии/);
  assert.match(actual, /Хорошая работа:/);
  assert.match(actual, /Обратите внимание:/);
  assert.match(actual, /Вероятная связь показателей:/);
  assert.match(actual, /Обновить выводы по показателям/);
  assert.match(actual, /\.dyn-narrative textarea[^}]*font-family:\s*"Segoe UI"/);
  assert.doesNotMatch(actual, /Описание по цифрам|автоописание|Автоматическое описание|Вернуть автоописание/);
  assert.match(actual, /\.logo-work\s*\{\s*color:\s*#65a30d;/);
  assert.match(actual, /\.logo-doctors\s*\{\s*color:\s*#7c3aed;/);
  assert.doesNotMatch(actual, /Трафик: визиты за месяц/);
});

test("segment toggles safely quote string values in inline handlers", () => {
  const source = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const match = source.match(/function segToggle\(id, options, current, handler\) \{[\s\S]*?\n\}/);
  assert.ok(match, "segToggle source must be present");
  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
  const segToggle = new Function("esc", `${match[0]}; return segToggle;`)(escapeHtml);
  const html = segToggle("clientSegmentSeg", [{ v: "active", label: "Активная" }], "risk", "setClientSegment");
  assert.match(html, /onclick="setClientSegment\(&quot;active&quot;\)"/);
  assert.doesNotMatch(html, /onclick="setClientSegment\("active"\)"/);
});

test("department KPI goals distinguish achieved, missed and unavailable values", () => {
  const source = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const match = source.match(/function departmentGoalInfo\(def, result, profile\) \{[\s\S]*?\n\}/);
  assert.ok(match, "departmentGoalInfo source must be present");
  const departmentGoalInfo = new Function(`${match[0]}; return departmentGoalInfo;`)();
  const profile = { pervichkaM: 3, scoring: { benchmarks: { revenue: 100, churn: 30 } } };
  const moneyDef = { goalKey: "revenue", get: result => result.value, goalFmt: value => `${value} ₽` };
  const lowerDef = { goalKey: "churn", get: result => result.value, goalFmt: value => `${value}%`, goalLower: true };
  const unavailableDef = { ...moneyDef, goalGet: () => null, goalLabel: "тест" };

  assert.equal(departmentGoalInfo(moneyDef, { value: 120 }, profile).state, "department-goal-good");
  assert.equal(departmentGoalInfo(moneyDef, { value: 80 }, profile).state, "department-goal-bad");
  assert.equal(departmentGoalInfo(lowerDef, { value: 20 }, profile).state, "department-goal-good");
  assert.equal(departmentGoalInfo(lowerDef, { value: 40 }, profile).state, "department-goal-bad");
  assert.equal(departmentGoalInfo(unavailableDef, { value: 120 }, profile).state, "department-goal-plain");
  assert.match(departmentGoalInfo(unavailableDef, { value: 120 }, profile).text, /факт н\/д/);
});

test("doctor goal cards color facts for direct and lower-is-better targets", () => {
  const source = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const match = source.match(/function doctorGoalState\(fact, target, lower = false\) \{[\s\S]*?\n\}/);
  assert.ok(match, "doctorGoalState source must be present");
  const doctorGoalState = new Function(`${match[0]}; return doctorGoalState;`)();

  assert.equal(doctorGoalState(100, 100), "goal-good");
  assert.equal(doctorGoalState(85, 100), "goal-warn");
  assert.equal(doctorGoalState(70, 100), "goal-bad");
  assert.equal(doctorGoalState(30, 30, true), "goal-good");
  assert.equal(doctorGoalState(34, 30, true), "goal-warn");
  assert.equal(doctorGoalState(40, 30, true), "goal-bad");
  assert.equal(doctorGoalState(null, 100), "goal-na");
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
