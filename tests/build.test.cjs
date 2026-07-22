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
  assert.match(actual, /function splitOversizedPdfSection/);
  assert.match(actual, /el\.querySelector\("\.pdf-chart-image"\)/);
  assert.match(actual, /fitScale = maxImgH \/ scaledHeight/);
  assert.match(actual, /image\.style\.aspectRatio/);
  assert.match(actual, /async function saveSessionState/);
  assert.match(actual, /Все изменения текущей сессии сохранены/);
  assert.match(actual, /Экспорт данных в JSON/);
  assert.match(actual, /Полная копия для переноса/);
  assert.match(actual, /pdf-chart-image/);
  assert.match(actual, /pdf-continuation-title/);
  assert.match(actual, /relativePath:\s*target\.relativePath/);
  assert.match(actual, /\["Отделения",\s*departmentName\]/);
  assert.match(actual, /"Специализации"/);
  assert.match(actual, /"Врачи"/);
  assert.match(actual, /id="pdfExportDialog"/);
  assert.match(actual, /Что выгружать в PDF/);
  assert.match(actual, /function openPdfExportDialog/);
  assert.match(actual, /function selectedPdfExportTargets/);
  assert.match(actual, /function startPdfExportFromDialog/);
  assert.match(actual, /exportAllReportsToFolder\(targets\)/);
  assert.doesNotMatch(actual, /pdfExportDepartments|pdfExportSpecializations|pdfExportDoctors|function setPdfExportOption/);
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
  assert.match(actual, /В1 Экономическая результативность/);
  assert.match(actual, /В6 Репутация и NPS/);
  assert.match(actual, /scoreChartSources/);
  assert.match(actual, /mode !== "all" \|\| ctx\.dataset\.label === "Общий балл"/);
  assert.match(actual, /\.score-chart-choice\.active[^}]*var\(--accent\)/);
  assert.match(actual, /function doctorGoalsSummaryHtml/);
  assert.match(actual, /🎯 Цели врача/);
  assert.match(actual, /doctor-goals-grid/);
  assert.match(actual, /doctor-goals-vector-column/);
  assert.match(actual, /VECTOR_META\[vector\]\.name/);
  assert.match(actual, /grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\)/);
  assert.doesNotMatch(actual, /VECTOR_META\[vk\]\.name\.split\(" "\)\[0\]/);
  assert.match(actual, /hasTarget \? `\$\{lower \? "≤" : "≥"\}/);
  assert.doesNotMatch(actual, /\}\)\)\.filter\(column => column\.goals\.length\)/);
  assert.match(actual, /индивидуальные цели/);
  assert.match(actual, /doctorGoalsSummaryHtml\(docId, reportProfile, false, r\)/);
  assert.match(actual, /const DOCTOR_GOAL_VECTORS/);
  assert.match(actual, /function doctorGoalFact/);
  assert.match(actual, /data-goal-vector/);
  assert.match(actual, /Факт:/);
  assert.match(actual, /doctor-goal-item \$\{state\}/);
  assert.match(actual, /saveCrossFocusSettings/);
  assert.match(actual, /Фокусы междисциплинарного подхода \(Вектор 3\)/);
  assert.match(actual, /chNazFocusAssigned/);
  assert.match(actual, /chNazFocusResult/);
  assert.match(actual, /nz\.focus\.items\[name\]\.resultQ/);
  assert.match(actual, /Услуги: выполнено \+ продано; товары: продано/);
  assert.match(actual, /Наименование услуги/);
  assert.match(actual, /Назначено, шт/);
  assert.match(actual, /Выполнено \+ продано, шт/);
  assert.doesNotMatch(actual, /chNazFocusMoney|Доля выручки фокусов|nazFocusShare/);
  assert.match(actual, /id="completedReferralShare"/);
  assert.match(actual, /Доля выручки от выполненных направлений/);
  assert.match(actual, /источник: отчёт «Выработка»/);
  const focusBlockPosition = actual.indexOf("focusTitle = esc");
  const completedReferralSharePosition = actual.indexOf('id="completedReferralShare"');
  const completedReferralDetailsPosition = actual.indexOf('completedReferralDetails');
  assert.ok(focusBlockPosition < completedReferralSharePosition, "revenue share card must be below the focus block");
  assert.ok(completedReferralSharePosition < completedReferralDetailsPosition, "revenue share card must precede completed-referral details");
  assert.match(actual, /const lower = lowerGoals\.has\(goal\.key\)/);
  assert.match(actual, /ПАЦИЕНТЫ ДЛЯ РАБОТЫ/);
  assert.match(actual, /collapsible-list-summary/);
  assert.match(actual, /rememberListToggle/);
  assert.match(actual, /clientSegmentPatients/);
  assert.match(actual, /clientSegmentRows/);
  assert.match(actual, /clientRowsForSegment/);
  assert.match(actual, /data-segment-value/);
  assert.match(actual, /aria-pressed/);
  assert.match(actual, /Что сделать сейчас/);
  assert.match(actual, /openClientSegment/);
  assert.match(actual, /Окна 12 \/ 24 \/ 36 месяцев переключаются вручную/);
  for (const field of ["np_loyalVisits", "np_loyalM", "np_activeVisits", "np_activeM", "np_newRiskVisits", "np_newRiskM", "np_sleepVisits", "np_sleepM", "np_lostVisits", "np_lostM"]) assert.match(actual, new RegExp(field));
  assert.match(actual, /У каждой группы есть два собственных параметра/);
  assert.match(actual, /clientBaseRequiredWindow/);
  assert.match(actual, /kbWinByDoctor/);
  assert.match(actual, /E · Лояльные, спящие/);
  assert.match(actual, /F · Потерянные/);
  assert.match(actual, /function reportOverallIndex/);
  assert.match(actual, /Общий индекс/);
  assert.match(actual, /onPrepareClose/);
  assert.match(actual, /confirmCloseSaved/);
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

test("all rendered controls resolve their inline handlers and listener targets", () => {
  const template = fs.readFileSync(path.join(build, "index.template.html"), "utf8");
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const source = `${template}\n${ui}`;
  const handlers = [...source.matchAll(/(?:onclick|onchange|oninput|ondragstart|ondragend|ondragover|ondragleave|ondrop|ontoggle)="([A-Za-z_$][\w$]*)\s*\(/g)]
    .map(match => match[1]);
  const uniqueHandlers = [...new Set(handlers)];
  assert.ok(uniqueHandlers.length >= 45);
  for (const handler of uniqueHandlers) {
    assert.match(source, new RegExp(`function\\s+${handler}\\s*\\(`), `missing inline handler: ${handler}`);
  }

  const listenerTargets = [...ui.matchAll(/document\.getElementById\("([^"]+)"\)\.addEventListener/g)]
    .map(match => match[1]);
  const uniqueTargets = [...new Set(listenerTargets)];
  assert.ok(uniqueTargets.length >= 25);
  for (const id of uniqueTargets) {
    assert.ok(source.includes(`id="${id}"`) || source.includes(`id='${id}'`), `missing listener target: ${id}`);
  }
});

test("PDF export waits for a modal selection of exact reports", () => {
  const template = fs.readFileSync(path.join(build, "index.template.html"), "utf8");
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");

  assert.match(template, /<dialog[^>]+id="pdfExportDialog"/);
  assert.match(template, /id="pdfExportSelectAll"/);
  assert.match(template, /id="pdfExportClearAll"/);
  assert.match(template, /id="pdfExportDialogCancel"/);
  assert.match(template, /id="pdfExportDialogStart"/);
  assert.match(template, /Экспорт начнётся только после подтверждения выбора/);
  assert.match(ui, /btnExportAllPdf"\)\.addEventListener\("click", openPdfExportDialog\)/);
  assert.doesNotMatch(ui, /btnExportAllPdf"\)\.addEventListener\("click", exportAllReportsToFolder\)/);
  assert.match(ui, /data-pdf-target-index/);
  assert.match(ui, /pdf-choice-department/);
  assert.match(ui, /pdf-choice-specialization/);
  assert.match(ui, /pdf-choice-doctor/);
  assert.match(ui, /start\.disabled = selected\.length === 0/);
  assert.match(ui, /return exportAllReportsToFolder\(targets\)/);
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
  assert.equal(doctorGoalState(80, ""), "goal-na");
});

test("doctor coefficients stay grouped under all six vectors with full block names", () => {
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const css = fs.readFileSync(path.join(build, "app.css"), "utf8");
  const summary = ui.match(/function doctorGoalsSummaryHtml\(docId, profile, standalone = true, result = null\) \{[\s\S]*?\n\}/);

  assert.ok(summary, "doctorGoalsSummaryHtml source must be present");
  for (const label of [
    "В1 Экономическая результативность",
    "В2 Экспертность и продукт",
    "В3 Междисциплинарный подход",
    "В4 Работа с клиентской базой",
    "В5 Лояльность и удержание",
    "В6 Репутация и NPS",
  ]) assert.match(ui, new RegExp(label));
  for (const vector of ["v1", "v2", "v3", "v4", "v5", "v6"]) {
    assert.match(summary[0], new RegExp(`"${vector}"`));
  }
  assert.doesNotMatch(summary[0], /filter\(column => column\.goals\.length\)/);
  assert.match(summary[0], /Цель: <b>\$\{hasTarget \?/);
  assert.match(css, /\.vec-scores\s*\{[^}]*grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.doctor-goals-grid\s*\{[^}]*grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\)/s);
});

test("doctor and report pages use the same doctor metrics header component", () => {
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const header = ui.match(/function doctorMetricsHeaderHtml\(docId, mk, r,[\s\S]*?\n\}\n\nfunction renderDoctor/);
  const doctor = ui.match(/function renderDoctor\(\) \{[\s\S]*?\n\}\n\nfunction saveManual6/);
  const report = ui.match(/function buildDoctorReport\(docId, mk\) \{[\s\S]*?\n\}\n\n\/\* ================= СТРАНИЦА: НАСТРОЙКИ/);

  assert.ok(header, "shared doctor metrics header must be present");
  assert.ok(doctor, "doctor page renderer must be present");
  assert.ok(report, "doctor report renderer must be present");
  for (const label of [
    "Пациентов за месяц",
    "Загрузка расписания",
    "Коэффициент визитов на пациента за месяц",
    "Коэффициент визитов на пациента за 12 мес.",
    "Объём активной клиентской базы",
  ]) assert.match(header[0], new RegExp(label));
  assert.match(header[0], /\["v1", "v2", "v3", "v4", "v5", "v6"\]/);
  assert.match(doctor[0], /doctorMetricsHeaderHtml\(UI\.docId, mk, r,/);
  assert.match(report[0], /doctorMetricsHeaderHtml\(docId, mk, r,/);
  assert.match(report[0], /blockId: "reportDoctorMetrics", slide: true/);
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

test("unused product positions remain visually emphasized", () => {
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const css = fs.readFileSync(path.join(build, "app.css"), "utf8");

  assert.equal((ui.match(/class="unused-items"/g) || []).length, 1);
  assert.match(css, /table\.data td\.unused-items\s*\{[^}]*background:\s*var\(--bad-soft\);[^}]*color:\s*var\(--bad\);[^}]*font-weight:\s*700;/s);
});

test("appointment details hide report revenue and render source comparison as plain text", () => {
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const css = fs.readFileSync(path.join(build, "app.css"), "utf8");
  const appointmentTable = ui.match(/id="tblNaz"[\s\S]*?if \(nz\.focus\)/);
  const reportTable = ui.match(/\/\/ назначения[\s\S]*?if \(nz\.focus\)/);
  const sourceCompareCss = css.match(/\.source-compare\s*\{([^}]*)\}/);

  assert.ok(appointmentTable);
  assert.doesNotMatch(appointmentTable[0], /Выручка|fmtMoney\(b\.soldSum\)|fmtMoney\(nz\.totals\.soldSum\)/);
  assert.ok(reportTable);
  assert.doesNotMatch(reportTable[0], /<th class="num">Выручка<\/th>|fmtMoney\(b\.soldSum\)|fmtMoney\(nz\.totals\.soldSum\)/);
  assert.match(ui, /<p class="source-compare">Сверка двух источников:/);
  assert.ok(sourceCompareCss);
  assert.match(sourceCompareCss[1], /color:\s*var\(--muted\)/);
  assert.doesNotMatch(sourceCompareCss[1], /background|border|padding/);
});

test("appointment details preserve grouped 1C service hierarchy with a flat-report fallback", () => {
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const parsers = fs.readFileSync(path.join(build, "app-parsers.js"), "utf8");
  const css = fs.readFileSync(path.join(build, "app.css"), "utf8");

  assert.match(ui, /nz\.sourceGroups && nz\.sourceGroups\.length/);
  assert.match(ui, /Вид услуги \/ специализация \/ номенклатура/);
  assert.match(ui, /: "Тип направления"/);
  assert.match(ui, /const sourceTree = new Map\(\)/);
  assert.match(ui, /renderSourceNodes\(node\.children, depth \+ 1\)/);
  assert.match(ui, /class="source-group-path"/);
  assert.match(ui, /class="small muted source-nomenclature"/);
  assert.match(css, /\.source-group-path\s*\{/);
  assert.match(css, /table\.data \.source-group-depth-0 td\s*\{/);
  assert.match(css, /table\.data td\.source-nomenclature\s*\{/);
  assert.match(ui, /desktopDescriptorsToFiles\(descriptors, true\)/);
  assert.match(parsers, /!file\.__forceReimport/);
});

test("client-base vector keeps 12/24/36 manual and hides unavailable overlapping groups", () => {
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const css = fs.readFileSync(path.join(build, "app.css"), "utf8");
  const vector = ui.match(/\/\* ---- В4 Клиентская база ---- \*\/[\s\S]*?\/\* ---- В5 Лояльность ---- \*\//);

  assert.ok(vector);
  assert.doesNotMatch(vector[0], /disabled:/);
  assert.match(vector[0], /const groupOrder = \["loyal", "active", "newRisk", "loyalSleep", "lost"\]/);
  assert.match(vector[0], /filter\(group => kb\.groupAvailable\[group\]\)/);
  for (const label of ["Общая база", "Что сделать сейчас", "Группы могут пересекаться", "не показываются"]) {
    assert.match(vector[0], new RegExp(label));
  }
  for (const label of ["Лояльные", "Активные", "Новые, риск", "Лояльные, спящие", "Потерянные"]) assert.match(ui, new RegExp(label));
  assert.match(vector[0], /openClientSegment\('newRisk'\)/);
  assert.match(vector[0], /openClientSegment\('loyalSleep'\)/);
  assert.match(ui, /chart\("chSegments", \{\s*type: "bar"/);
  assert.doesNotMatch(vector[0], /Потерянная \(минимум\)|"≥" \+ fmtNum\(kb\.seg\.lost\)/);
  assert.doesNotMatch(vector[0], /Динамика клиентской базы|Динамика снижения потерь|Выручка под риском возврата|Ядро базы/);
  assert.match(css, /\.kb-summary-grid/);
  assert.match(css, /\.kb-group-rules/);
  assert.match(css, /\.kb-action/);
});

test("dynamics table shows explicit goals and uses compact comparison headings", () => {
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const css = fs.readFileSync(path.join(build, "app.css"), "utf8");
  const match = ui.match(/function dynamicsTargetBadges\(row\) \{[\s\S]*?\n\}/);

  assert.ok(match);
  const dynamicsTargetBadges = new Function(`${match[0]}; return dynamicsTargetBadges;`)();
  const direct = dynamicsTargetBadges({ belowTarget: true, lower: false, target: 100, fmt: value => `${value} ₽` });
  const lower = dynamicsTargetBadges({ belowTarget: true, lower: true, target: 30, fmt: value => `${value}%` });
  assert.match(direct, />ниже цели<[^]*>цель ≥ 100 ₽</);
  assert.match(lower, />выше цели<[^]*>цель ≤ 30%</);
  assert.match(ui, />Δ к прошлому<\/th><th class="num"[^>]*>Δ к среднему<\/th>/);
  assert.doesNotMatch(ui, /Δ к прошл\. мес\.|Δ к среднему прошлых мес\./);
  assert.match(css, /\.dyn-target-badges/);
  assert.match(ui, />ВЫРУЧКА \$\{copyBtn\("copyChart", blkId \+ "_money", "PNG"\)\}/);
  assert.match(ui, />ПАЦИЕНТЫ \/ ВИЗИТЫ \$\{copyBtn\("copyChart", blkId \+ "_traffic", "PNG"\)\}/);
  assert.match(ui, />ЛОЯЛЬНОСТЬ И ПЕРЕНАПРАВЛЕНИЯ, % \$\{copyBtn\("copyChart", blkId \+ "_pct", "PNG"\)\}/);
  assert.match(ui, />КЛИЕНТСКАЯ БАЗА \$\{copyBtn\("copyChart", blkId \+ "_base", "PNG"\)\}/);
  assert.doesNotMatch(ui, />ДЕНЬГИ \$\{copyBtn|>ТРАФИК \$\{copyBtn|>УДЕРЖАНИЕ И КОМАНДА/);
});

test("doctor current-month dynamics is the final block after vectors and charts", () => {
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const renderDoctor = ui.match(/function renderDoctor\(\) \{[\s\S]*?\n\}\n\nfunction saveManual6/);

  assert.ok(renderDoctor);
  const source = renderDoctor[0];
  const vector6 = source.indexOf('id="blkV6"');
  const lastVectorChart = source.indexOf('id="blkStack"');
  const dynamics = source.indexOf('dynamicsHtml(docDyn, "blkDyn", "Динамика текущего месяца: точки роста и риска"');
  const render = source.indexOf("body.innerHTML = html");

  assert.ok(vector6 >= 0 && lastVectorChart > vector6);
  assert.ok(dynamics > lastVectorChart);
  assert.ok(render > dynamics);
  assert.doesNotMatch(source, /dynamicsHtml\(docDyn, "blkDyn", "Динамика: точки роста и риска"/);
  assert.match(ui, /<h2>Динамика текущего месяца: точки роста и риска · \$\{esc\(doctorName\(docId\)\)\}<\/h2>/);
});

test("specialization revenue cards show yearly dynamics without window wording", () => {
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const metrics = fs.readFileSync(path.join(build, "app-metrics.js"), "utf8");

  assert.match(ui, /const avgSalesYtd = meanKnown\(ytdDept\.map\(r => r\.econ\.sales\)\)/);
  assert.match(ui, /const avgRefYtd = meanKnown\(ytdDept\.map\(r => r\.econ\.refRevenue\)\)/);
  assert.match(ui, /deptKpiTrend\(totalSales, avgSalesYtd, "pct"\)/);
  assert.match(ui, /deptKpiTrend\(totalRef, avgRefYtd, "pct"\)/);
  assert.match(ui, /среднее за \$\{year\}: \$\{fmtMoney\(avgSalesYtd\)\}/);
  assert.match(ui, /среднее за \$\{year\}: \$\{fmtMoney\(avgRefYtd\)\}/);
  assert.doesNotMatch(ui + metrics, /окно по настройкам/);
});

test("specialist summary removes the color legend and wraps long headers", () => {
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const summary = ui.match(/Сводная по специалистам[\s\S]*?rows\.forEach/);

  assert.ok(summary);
  assert.doesNotMatch(summary[0], /зелёным — лучший, красным — худший/);
  assert.match(ui, /header: "Загрузка<br>расписания"/);
  assert.match(ui, /header: `Возвращаемость первички<br>\(\$\{UI\.pvSlice\} мес\.\)`/);
  assert.match(ui, /header: "Доля выручки<br>от перенаправлений"/);
  assert.match(ui, /<th class="num">Загрузка<br>расписания<\/th>/);
  assert.match(ui, /<th class="num">Возвращаемость первички<br>\(\$\{UI\.pvSlice\} мес\.\)<\/th>/);
  assert.match(ui, /<th class="num">Доля выручки<br>от перенаправлений<\/th>/);
});

test("client-base table shows overlapping groups and omits unavailable values", () => {
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const css = fs.readFileSync(path.join(build, "app.css"), "utf8");
  const table = ui.match(/\/\/ Клиентская база: период выбирается вручную[\s\S]*?\/\/ профайлы специалистов/);
  const trendMatch = ui.match(/function compactBaseTrend\(current, previous, lowerBetter = false\) \{[\s\S]*?\n\}/);

  assert.ok(table);
  assert.match(table[0], /<h2>Клиентская база /);
  assert.doesNotMatch(table[0], /Мониторинг базы|<th>Настройки базы<\/th>/);
  assert.match(table[0], /visibleGroups/);
  assert.match(table[0], /clientBaseProfileDescription\(p, visibleGroups\)/);
  assert.match(table[0], /kb\.groupAvailable\[group\]/);
  assert.match(table[0], /fmtPct\(clientBaseGroupPct\(kb, group\)\)/);
  assert.match(table[0], /Группы могут пересекаться/);
  assert.match(table[0], /ноль не подставляется/);
  assert.match(table[0], /compactBaseTrend\(kb\.total,/);
  assert.ok(trendMatch);
  const compactBaseTrend = new Function("kbTrendMarkup", `${trendMatch[0]}; return compactBaseTrend;`)((current, previous, lower, mode) => `${current}|${previous}|${lower}|${mode}`);
  assert.equal(compactBaseTrend(120, 100, true), '<div class="table-kpi-trend" title="К прошлому месяцу">120|100|true|relative</div>');
  assert.equal(compactBaseTrend(120, null), "");
  assert.match(css, /\.table-kpi-trend/);
  assert.doesNotMatch(ui, /Клиентская база по настройкам специализаций|Порог \/ окно/);
});
