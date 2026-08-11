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
  for (const required of ["btnExportAllPdf", "btnSaveSession", "desktopWorkspaceCard", "btnScanInput", "Content-Security-Policy", "departmentBody", "departmentFilter", "departmentMonth", "settingsAppVersion", "headerAppVersion"]) {
    assert.match(actual, new RegExp(required));
  }
  assert.doesNotMatch(actual, /data-tab="report"|id="page-report"/);
  assert.match(actual, /Экспорт и публикация/);
  assert.match(actual, /PDF и Viewer формируются из тех же дашбордов/);
  assert.match(actual, /function pdfReportTargets/);
  assert.match(actual, /function cloneDashboardForPdf/);
  assert.match(actual, /function cloneDashboardForViewer/);
  assert.match(actual, /function composeViewerDashboardHtml/);
  assert.match(actual, /function splitDynamicPdfSection/);
  assert.match(actual, /function splitOversizedPdfSection/);
  assert.match(actual, /function readableCanvasSliceEnd/);
  assert.match(actual, /function printablePdfDocument/);
  assert.match(actual, /DESKTOP_API\.renderPdf\(\{ html: printHtml \}\)/);
  assert.doesNotMatch(actual, /fitScale = maxImgH \/ scaledHeight/);
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
  assert.match(actual, /<title>КлинВект Щербатова — Администратор<\/title>/);
  assert.match(actual, /rel="icon"[^>]+resources\/app-icon\.png/);
  assert.match(actual, /class="brand-symbol"[^>]+resources\/app-icon\.png/);
  assert.match(actual, /class="logo-work">КлинВект<\/span>/);
  assert.match(actual, /class="logo-doctors">Щербатова<\/span>/);
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
  assert.match(actual, /setInterdisciplinaryHomeDepartment/);
  assert.match(actual, /Резервная привязка фокусов к подразделению/);
  assert.match(actual, /data-service-name/);
  assert.match(actual, /Точная привязка номенклатуры имеет приоритет/);
  assert.match(actual, /Товары, приёмы и анализы всегда остаются самостоятельными категориями/);
  assert.match(actual, /fixedReferralType/);
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
  assert.doesNotMatch(actual, /onPrepareClose|confirmCloseSaved|app:prepare-close/);
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
  assert.match(actual, /\.dyn-narrative-editor[^}]*font-family:\s*"Segoe UI"/);
  assert.doesNotMatch(actual, /Описание по цифрам|автоописание|Автоматическое описание|Вернуть автоописание/);
  assert.match(actual, /\.logo-work\s*\{\s*color:\s*#1d4ed8;/);
  assert.match(actual, /\.logo-doctors\s*\{\s*color:\s*#0f766e;/);
  assert.doesNotMatch(actual, /Трафик: визиты за месяц/);
});

test("desktop PDF export prints prepared HTML through Chromium and keeps a readable browser fallback", () => {
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const preload = fs.readFileSync(path.join(root, "desktop", "preload.cjs"), "utf8");
  const main = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf8");

  assert.match(preload, /renderPdf: payload => invoke\("export:render-pdf", payload\)/);
  assert.match(main, /async function renderHtmlToPdf\(html\)/);
  assert.match(main, /printWindow\.webContents\.printToPDF\(/);
  assert.match(main, /ipcMain\.handle\("export:render-pdf"/);
  assert.match(ui, /const useChromiumPdf = Boolean\(useDesktopExport && typeof DESKTOP_API\.renderPdf === "function"\)/);
  assert.match(ui, /printablePdfDocument\(stage, target, mk\)/);
  assert.match(ui, /function readableCanvasSliceEnd\(canvas, startY, idealEnd\)/);
  assert.doesNotMatch(ui, /fitScale = maxImgH \/ scaledHeight/);
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
  assert.match(template, /PDF и Viewer формируются из тех же дашбордов/);
  assert.match(template, /<section id="page-settings"[\s\S]*id="btnExportAllPdf"/);
  assert.doesNotMatch(template, /data-tab="report"|id="page-report"/);
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
  for (const dynamics of [
    /const patientsDyn = doctorMetricDynamics\(docId, mk, rr => rr\.traffic\.patients\)/,
    /const scheduleDyn = doctorMetricDynamics\(docId, mk, rr => rr\.loyalty\.sched \? rr\.loyalty\.sched\.pct : null\)/,
    /const monthlyVisitRateDyn = doctorMetricDynamics\(docId, mk, rr => rr\.traffic\.freq\)/,
    /const annualVisitRateDyn = doctorMetricDynamics\(docId, mk, rr => rr\.loyalty\.freq12\)/,
  ]) assert.match(header[0], dynamics);
  assert.equal((header[0].match(/\$\{metricHistoryMarkup\(/g) || []).length, 5, "every doctor header KPI must show history");
  assert.match(header[0], /metricHistoryMarkup\(r\.traffic\.patients, patientsDyn, "relative"/);
  assert.match(header[0], /metricHistoryMarkup\(schedule \? schedule\.pct : null, scheduleDyn, "pp"/);
  assert.match(header[0], /metricHistoryMarkup\(monthlyVisitRate, monthlyVisitRateDyn, "absolute"/);
  assert.match(header[0], /metricHistoryMarkup\(annualVisitRate, annualVisitRateDyn, "absolute"/);
  assert.match(header[0], /\["v1", "v2", "v3", "v4", "v5", "v6"\]/);
  assert.match(doctor[0], /doctorMetricsHeaderHtml\(UI\.docId, mk, r,/);
  assert.match(report[0], /doctorMetricsHeaderHtml\(docId, mk, r,/);
  assert.match(report[0], /blockId: "reportDoctorMetrics", slide: true/);
});

test("department and specialization reports show every doctor in a score leaderboard", () => {
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const css = fs.readFileSync(path.join(build, "app.css"), "utf8");
  const leaderboard = ui.match(/function doctorScoreLeaderboardHtml\(rows, mk, scopeLabel = ""\) \{[\s\S]*?\n\}/);
  const department = ui.match(/function renderDepartment\(\) \{[\s\S]*?\n\}\n\n\/\* ================= СТРАНИЦА: СПЕЦИАЛИЗАЦИЯ/);
  const specialization = ui.match(/function renderDept\(\) \{[\s\S]*?\n\}\n\nfunction renderCompare/);
  const report = ui.match(/function buildDeptReport\(mk, deptFilter = UI\.deptFilter, subFilter = UI\.subFilter\) \{[\s\S]*?\n\}\n\nfunction buildDoctorReport/);

  assert.ok(leaderboard, "shared doctor score leaderboard must be present");
  assert.ok(department, "department renderer must be present");
  assert.ok(specialization, "specialization renderer must be present");
  assert.ok(report, "specialization report renderer must be present");
  assert.match(leaderboard[0], /const ranked = \[\.\.\.rows\]\.sort/);
  assert.doesNotMatch(leaderboard[0], /\.slice\(/, "the leaderboard must not truncate the doctor list");
  assert.match(leaderboard[0], /value >= 70 \? "good" : value >= 40 \? "warn" : "bad"/);
  assert.match(leaderboard[0], /data-score-state="\$\{state\}"/);
  assert.match(ui, /function doctorAverageScoreToMonth\(docId, mk\)/);
  assert.match(ui, /eligibleMonths\.length \? eligibleMonths : scoredMonths/);
  assert.match(leaderboard[0], /data-average-score="\$\{average\.value\.toFixed\(1\)\}"/);
  assert.match(leaderboard[0], /doctor-score-leader-average/);
  assert.match(leaderboard[0], /ср\. \$\{fmtNum\(average\.value, 0\)\}/);
  assert.match(leaderboard[0], /Лидерборд врачей/);
  assert.match(leaderboard[0], /все \$\{ranked\.length\}/);
  assert.match(department[0], /departmentDoctorRows\(mk, UI\.departmentFilter\)/);
  assert.match(department[0], /doctorScoreLeaderboardHtml\(scoreRows, mk, scope\)/);
  assert.match(specialization[0], /doctorScoreLeaderboardHtml\(rows, mk, scoreScope\)/);
  assert.match(report[0], /doctorScoreLeaderboardHtml\(rows, mk,/);
  assert.match(css, /\.doctor-score-leaderboard-grid\s*\{[^}]*repeat\(auto-fill,\s*minmax\(126px,\s*150px\)\)/s);
  assert.match(css, /\.doctor-score-leader-ring\s*\{[^}]*width:\s*88px/s);
  assert.match(css, /\.doctor-score-leader-average\s*\{[^}]*position:\s*absolute[^}]*right:\s*7px[^}]*bottom:\s*6px/s);
});

test("specialization and department comparisons include aggregate totals with stable columns", () => {
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const metrics = fs.readFileSync(path.join(build, "app-metrics.js"), "utf8");
  const css = fs.readFileSync(path.join(build, "app.css"), "utf8");
  const compare = ui.match(/function renderCompare\(mk, rows\) \{[\s\S]*?\n\}\n\nasync function exportDeptXlsx/);
  const department = ui.match(/function renderDepartment\(\) \{[\s\S]*?\n\}\n\n\/\* ================= СТРАНИЦА: СПЕЦИАЛИЗАЦИЯ/);

  assert.ok(compare, "specialization comparison renderer must be present");
  assert.ok(department, "department renderer must be present");
  assert.match(compare[0], /const aggregateResult = aggregateDeptMonth\(mk, UI\.deptFilter, UI\.subFilter\)/);
  assert.match(compare[0], /Итог специализации/);
  assert.match(compare[0], /compare-total-cell/);
  assert.match(compare[0], /<col class="compare-metric-col">/);
  assert.match(compare[0], /<col class="compare-summary-col">/);
  assert.match(compare[0], /<col class="compare-doctor-col">/);
  assert.match(department[0], /department-total-row/);
  assert.match(department[0], /Итого по \$\{UI\.departmentFilter === "all" \? "всем отделениям" : "отделению"\}/);
  assert.match(metrics, /avgVisit:\s*\(sales != null && visits\) \? sales \/ visits : null/);
  assert.match(metrics, /naz:\s*\{\s*1:\s*naz1,\s*3:\s*naz3\s*\}/);
  assert.match(metrics, /churn36:\s*unique36 \? unique36\.lostPct : null/);
  assert.match(css, /\.compare-table\s*\{[^}]*table-layout:\s*fixed/s);
  assert.match(css, /\.compare-table \.compare-metric-col\s*\{[^}]*width:\s*250px/s);
  assert.match(css, /\.compare-table \.compare-summary-col\s*\{[^}]*width:\s*158px/s);
  assert.match(css, /\.compare-table \.compare-doctor-col\s*\{[^}]*width:\s*132px/s);
  assert.match(css, /\.department-profiles-table\s*\{[^}]*table-layout:\s*fixed/s);
});

test("first-run folder prompt is attached to a visible application window", () => {
  const source = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(packageJson.version, "2.5.8");
  assert.equal(packageJson.build.productName, "КлинВект Щербатова — Администратор");
  assert.equal(packageJson.build.artifactName, "KlinVekt-Shcherbatova-Admin-Setup-${version}-${arch}.${ext}");
  assert.equal(packageJson.scripts["dist:portable"], undefined);
  assert.equal(packageJson.scripts["dist:all"], "pnpm run dist && pnpm run dist:viewer");
  assert.match(source, /const APP_NAME = "КлинВект Щербатова — Администратор"/);
  assert.match(source, /previousUserData[\s\S]*Пульс клиники — Администратор[\s\S]*Пульс клиники[\s\S]*Оценка врачей/);
  const viewerSource = fs.readFileSync(path.join(root, "viewer", "main.cjs"), "utf8");
  assert.match(viewerSource, /const APP_NAME = "КлинВект Щербатова — Viewer"/);
  assert.match(viewerSource, /previousUserData[\s\S]*Пульс клиники — Viewer[\s\S]*viewer-config\.json[\s\S]*app\.setPath\("userData"/);
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
  assert.match(ui, /renderSourceNodes\(node\.children, depth \+ 1, \[\.\.\.ancestorKeys, gKey\]\)/);
  assert.match(ui, /class="source-group-path"/);
  assert.match(ui, /class="small muted source-nomenclature"/);
  assert.match(css, /\.source-group-path\s*\{/);
  assert.match(css, /table\.data \.source-group-depth-0 td\s*\{/);
  assert.match(css, /table\.data td\.source-nomenclature\s*\{/);
  assert.match(ui, /desktopDescriptorsToFiles\(descriptors, true\)/);
  assert.match(parsers, /!file\.__forceReimport/);
});

test("old appointment imports can be safely reprocessed into grouped 1C data", () => {
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const parsers = fs.readFileSync(path.join(build, "app-parsers.js"), "utf8");
  const template = fs.readFileSync(path.join(build, "index.template.html"), "utf8");
  const preload = fs.readFileSync(path.join(root, "desktop", "preload.cjs"), "utf8");
  const main = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf8");
  const database = fs.readFileSync(path.join(root, "desktop", "services", "database.cjs"), "utf8");
  const files = fs.readFileSync(path.join(root, "desktop", "services", "file-service.cjs"), "utf8");

  assert.match(template, /id="btnReprocessAppointments"/);
  assert.match(ui, /async function desktopReprocessAppointments/);
  assert.match(ui, /listImportedSources\("naznach"\)/);
  assert.match(ui, /onlyType: "naznach"[\s\S]*?replaceExisting: true[\s\S]*?forceReimport: true/);
  assert.match(ui, /Нет группировки из 1С/);
  assert.match(parsers, /options\.onlyType && type !== options\.onlyType/);
  assert.match(parsers, /options\.replaceExisting/);
  assert.match(parsers, /!options\.forceReimport && !file\.__forceReimport/);
  assert.match(preload, /listImportedSources: reportType => invoke\("files:list-imported", reportType\)/);
  assert.match(main, /ipcMain\.handle\("files:list-imported"/);
  assert.match(database, /listImportedSourcePaths\(reportType\)/);
  assert.match(files, /listImportedSources\(reportType\)/);
});

test("specialization page shows doctor focus matrix, highlighted summary and no 1C drilldown", () => {
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const css = fs.readFileSync(path.join(build, "app.css"), "utf8");

  assert.match(ui, /function specializationInterdisciplinaryHtml/);
  assert.match(ui, /Фокусы специализации/);
  assert.match(ui, /id="tblSpecializationFocus"/);
  assert.match(ui, /class="data heatmap-table specialization-doctor-focus-table"/);
  assert.match(ui, /В ячейках: <b>назначено \/ сделано<\/b>/);
  assert.match(ui, /row\.nz\.focus\.items\[name\]/);
  assert.match(ui, /fmtNum\(values\.assigned\).*fmtNum\(values\.resultQ\)/);
  assert.match(ui, /Итого по специализации/);
  assert.match(ui, /class="data specialization-doctor-summary-table"/);
  assert.match(ui, /specialization-doctor-summary-chip assigned/);
  assert.match(ui, /<th class="num">Выполнено \+ продано<\/th>/);
  assert.match(ui, /specialization-doctor-summary-chip completed[^\n]*row\.nz\.totals\.resultQ/);
  assert.doesNotMatch(ui, /specialization-doctor-summary-chip sold/);
  assert.match(ui, /specialization-doctor-summary-focus/);
  assert.doesNotMatch(ui, /Группировка из файла 1С/);
  assert.doesNotMatch(ui, /class="specialization-1c-doctor"/);
  assert.match(ui, /specializationInterdisciplinaryHtml\(rows, mk, deptFilter, \{ slide: true/);
  assert.match(css, /\.specialization-focuses\s*\{/);
  assert.match(css, /\.specialization-doctor-focus-table \.specialization-doctor-focus-total-col\s*\{/);
  assert.match(css, /\.specialization-doctor-focus-metric\s*\{/);
  assert.match(css, /\.specialization-doctor-summary-chip\.assigned\s*\{/);
  assert.match(css, /\.specialization-doctor-summary-focus\s*\{/);
  assert.doesNotMatch(css, /\.specialization-1c-doctor\s*\{/);
});

test("appointment conversion block starts compact and parent groups hide their whole subtree", () => {
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const css = fs.readFileSync(path.join(build, "app.css"), "utf8");
  const vector = ui.match(/\/\* ---- В3 Междисциплинарный ---- \*\/[\s\S]*?\/\* ---- В4 Клиентская база ---- \*\//);
  const toggle = ui.match(/function toggleGroup\(g\) \{[\s\S]*?\n\}/);

  assert.ok(vector);
  assert.ok(toggle);
  assert.match(vector[0], /collapsibleListAttrs\("appointmentConversionBlock", false\)/);
  assert.match(vector[0], /appointment-conversion-summary/);
  assert.match(vector[0], /appointment-conversion-summary-value/);
  assert.match(vector[0], /КОНВЕРСИЯ НАЗНАЧЕНИЙ[\s\S]*назначено \$\{fmtNum\(nz\.totals\.assigned\)\}[\s\S]*результат \$\{fmtNum\(nz\.totals\.resultQ\)\}/);
  assert.match(vector[0], /collapsibleListAttrs\("appointmentDetails", false\)/);
  assert.match(vector[0], /collapsibleListAttrs\("interdisciplinaryFocusPositions", false\)/);
  assert.match(vector[0], /collapsibleListAttrs\("completedReferralDetails", false\)/);
  assert.match(vector[0], /ДЕТАЛИ НАЗНАЧЕНИЙ[\s\S]*назначено \$\{fmtNum\(nz\.totals\.assigned\)\}[\s\S]*конверсия/);
  assert.match(vector[0], /const renderSourceNodes = \(nodes, depth = 0, ancestorKeys = \[\]\)/);
  assert.match(vector[0], /data-group-ancestors="\$\{ancestorKeys\.join\(" "\)\}"/);
  assert.match(vector[0], /renderSourceNodes\(node\.children, depth \+ 1, \[\.\.\.ancestorKeys, gKey\]\)/);
  assert.match(toggle[0], /querySelectorAll\(`\[data-group-ancestors~="\$\{g\}"\]`\)/);
  assert.match(toggle[0], /ancestors\.every\(key => Boolean\(UI\.openGroups\[key\]\)\)/);
  assert.match(css, /\.appointment-conversion-body\s*\{/);
});

test("client-base vector keeps 12/24/36 manual and hides unavailable overlapping groups", () => {
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const css = fs.readFileSync(path.join(build, "app.css"), "utf8");
  const vector = ui.match(/\/\* ---- В4 Клиентская база ---- \*\/[\s\S]*?\/\* ---- В5 Лояльность ---- \*\//);

  assert.ok(vector);
  assert.doesNotMatch(vector[0], /disabled:/);
  assert.match(vector[0], /const groupOrder = \["loyal", "active", "newRisk", "loyalSleep", "lost"\]/);
  assert.match(vector[0], /filter\(group => kb\.groupAvailable\[group\]\)/);
  assert.match(vector[0], /kb-summary-share/);
  assert.match(vector[0], /К предыдущему месяцу/);
  assert.match(vector[0], /К среднему за \$\{kbDyn\.year\}/);
  assert.match(vector[0], /kbDyn\.avgGroupPct\[group\]/);
  assert.match(vector[0], /group === "active" \|\| group === "lost"/);
  assert.match(vector[0], /group === "newRisk" \|\| group === "loyalSleep" \|\| group === "lost"/);
  assert.match(vector[0], /рост доли активных пациентов и снижение доли потерянных/);
  for (const label of ["Общая база", "Что сделать сейчас", "Группы могут пересекаться", "не показываются"]) {
    assert.match(vector[0], new RegExp(label));
  }
  for (const label of ["Лояльные", "Активные", "Новые, риск", "Лояльные, спящие", "Потерянные"]) assert.match(ui, new RegExp(label));
  assert.match(vector[0], /openClientSegment\('newRisk'\)/);
  assert.match(vector[0], /openClientSegment\('loyalSleep'\)/);
  assert.match(ui, /chart\("chSegments", \{\s*type: "bar"/);
  assert.match(css, /\.kb-summary-card\.key-indicator/);
  assert.match(css, /\.kb-summary-trends > div/);
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

test("doctor multi-month dynamics follows vectors and charts", () => {
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const renderDoctor = ui.match(/function renderDoctor\(\) \{[\s\S]*?\n\}\n\nfunction saveManual6/);

  assert.ok(renderDoctor);
  const source = renderDoctor[0];
  const vector6 = source.indexOf('id="blkV6"');
  const lastVectorChart = source.indexOf('id="blkStack"');
  const dynamics = source.indexOf('dynamicsHtml(docDyn, "blkDyn", "Динамика показателей по месяцам"');
  const render = source.indexOf("body.innerHTML = html");

  assert.ok(vector6 >= 0 && lastVectorChart > vector6);
  assert.ok(dynamics > lastVectorChart);
  assert.ok(render > dynamics);
  assert.doesNotMatch(source, /dynamicsHtml\(docDyn, "blkDyn", "Динамика текущего месяца: точки роста и риска"/);
  assert.match(ui, /<h2>Динамика текущего месяца: точки роста и риска · \$\{esc\(doctorName\(docId\)\)\}<\/h2>/);
});

test("doctor profile is split into four collapsible semantic sections", () => {
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const css = fs.readFileSync(path.join(build, "app.css"), "utf8");
  const renderDoctor = ui.match(/function renderDoctor\(\) \{[\s\S]*?\n\}\n\nfunction saveManual6/);

  assert.ok(renderDoctor);
  const source = renderDoctor[0];
  const section1 = source.indexOf('doctorSemanticSectionOpen(1, "Итоговый рейтинговый балл"');
  const header = source.indexOf("doctorMetricsHeaderHtml(");
  const section2 = source.indexOf('doctorSemanticSectionOpen(2, "Расшифровка векторов"');
  const goals = source.indexOf("doctorGoalsSummaryHtml(");
  const vector1 = source.indexOf('id="blkV1"');
  const vector6 = source.indexOf('id="blkV6"');
  const section3 = source.indexOf('doctorSemanticSectionOpen(3, "Годовая динамика показателей"');
  const stack = source.indexOf('id="blkStack"');
  const dynamics = source.indexOf('dynamicsHtml(docDyn, "blkDyn"');
  const section4 = source.indexOf('doctorSemanticSectionOpen(4, "Выводы и фокусы развития"');
  const outcome = source.indexOf('id="blkDynOutcome"');
  const render = source.indexOf("body.innerHTML = html");

  assert.ok(section1 >= 0 && header > section1);
  assert.ok(section2 > header && goals > section2 && vector1 > goals && vector6 > vector1);
  assert.ok(section3 > vector6 && stack > section3 && dynamics > stack);
  assert.ok(section4 > dynamics && outcome > section4 && render > outcome);
  assert.match(source, /dynamicsHtml\(docDyn,[\s\S]*?doctorScoresHtml,\s*false\)/);
  assert.match(ui, /function rememberDoctorSectionToggle\(/);
  assert.match(ui, /function setDoctorSemanticSections\(/);
  assert.match(ui, />Развернуть все<\/button>/);
  assert.match(ui, />Свернуть все<\/button>/);
  assert.match(css, /\.doctor-semantic-section\s*\{/);
  assert.match(css, /\.doctor-semantic-summary\s*\{/);
  assert.match(css, /\.doctor-semantic-section\s*>\s*\.doctor-semantic-body\s*\{\s*display:\s*block\s*!important;/);
});

test("dynamics conclusion is last, visually prominent, and supports rich saved comments", () => {
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const css = fs.readFileSync(path.join(build, "app.css"), "utf8");
  const dynamics = ui.match(/function dynamicsHtml\([\s\S]*?\n\}\n\n\/\* Адаптивная шкала/);

  assert.ok(dynamics);
  const source = dynamics[0];
  const detailsTable = source.indexOf('const tblId = blkId + "_tbl"');
  const optionalScoreDetail = source.indexOf("html += detailTailHtml");
  const finalOutcome = source.indexOf("html += dynamicsOutcomeHtml");
  assert.ok(detailsTable >= 0);
  assert.ok(optionalScoreDetail > detailsTable);
  assert.ok(finalOutcome > optionalScoreDetail);
  assert.match(ui, /Ключевой итог отчёта/);
  assert.match(ui, /class="dyn-narrative-editor\$\{narrative\.manual/);
  assert.match(ui, /contenteditable="true"/);
  assert.match(ui, /formatDynamicNarrative\('\$\{blkId\}','bold'\)/);
  assert.match(ui, /formatDynamicNarrativeColor\('\$\{blkId\}','\$\{item\.color\}'\)/);
  assert.match(ui, /format:\s*"rich-v1"/);
  assert.match(ui, /sanitizeDynamicNarrativeHtml/);
  assert.match(ui, /const repNarrative = dynamicNarrativeValue\(`doctor\|\$\{mk\}\|\$\{docId\}`/);
  assert.match(ui, /<div class="dyn-narrative-display">\$\{repNarrative\.html\}<\/div>/);
  assert.match(css, /\.dynamics-final-card\s*\{/);
  assert.match(css, /\.dynamic-report-outcome\s*\{/);
  assert.match(css, /\.dyn-narrative-editor\s*\{[^}]*overflow:\s*visible;/);
  assert.match(css, /\.dyn-color-swatch\s*\{/);
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
  assert.match(ui, /header: `Возвращаемость<br>первички \(\$\{UI\.pvSlice\} мес\.\)`/);
  assert.match(ui, /header: "Доля выручки<br>от перенаправлений"/);
  assert.match(ui, /<th class="num">Загрузка<br>расписания<\/th>/);
  assert.match(ui, /<th class="num">Возвращаемость<br>первички \(\$\{UI\.pvSlice\} мес\.\)<\/th>/);
  assert.match(ui, /<th class="num">Доля выручки<br>от перенаправлений<\/th>/);
});

test("specialization heatmap gives every focus an equal-width column", () => {
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const css = fs.readFileSync(path.join(build, "app.css"), "utf8");
  const heatmap = ui.match(/\/\/ тепловая карта экспертных позиций[\s\S]*?\/\/ Клиентская база:/);

  assert.ok(heatmap);
  assert.match(heatmap[0], /class="heatmap-scroll"/);
  assert.match(heatmap[0], /class="data heatmap-table"/);
  assert.match(heatmap[0], /--heat-table-min:\$\{300 \+ devs\.length \* 150\}px/);
  assert.match(heatmap[0], /devs\.map\(\(\) => '<col class="heatmap-focus-col">'\)/);
  assert.match(heatmap[0], /class="num heatmap-focus-cell"/);
  assert.match(css, /\.heatmap-table \{[\s\S]*?table-layout: fixed;/);
  assert.match(css, /\.heatmap-table \.heatmap-focus-col \{ width: 150px; \}/);
  assert.match(css, /\.heat-cell \{[\s\S]*?width: 100%;/);
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
  assert.match(table[0], /clientBaseProfileDescriptionMarkup\(item\.profile, visibleGroups\)/);
  assert.match(table[0], /kb\.groupAvailable\[group\]/);
  assert.match(table[0], /fmtPct\(clientBaseGroupPct\(kb, group\)\)/);
  assert.doesNotMatch(table[0], /от A|база A/);
  assert.match(table[0], /Все проценты рассчитаны от общей клиентской базы/);
  assert.match(table[0], /Группы могут пересекаться/);
  assert.match(table[0], /ноль не подставляется/);
  assert.match(table[0], /compactBaseTrend\(kb\.total,/);
  assert.ok(trendMatch);
  const compactBaseTrend = new Function("kbTrendMarkup", `${trendMatch[0]}; return compactBaseTrend;`)((current, previous, lower, mode) => `${current}|${previous}|${lower}|${mode}`);
  assert.equal(compactBaseTrend(120, 100, true), '<div class="table-kpi-trend" title="К прошлому месяцу">120|100|true|relative</div>');
  assert.equal(compactBaseTrend(120, null), "");
  assert.match(css, /\.table-kpi-trend/);
  assert.match(css, /\.client-base-description-list li \+ li/);
  assert.doesNotMatch(ui, /Клиентская база по настройкам специализаций|Порог \/ окно/);
});

test("administrator opens locally without login while right-side comments keep a technical author", () => {
  const template = fs.readFileSync(path.join(build, "index.template.html"), "utf8");
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const css = fs.readFileSync(path.join(build, "app.css"), "utf8");
  const preload = fs.readFileSync(path.join(root, "desktop", "preload.cjs"), "utf8");
  const main = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf8");
  const database = fs.readFileSync(path.join(root, "desktop", "services", "database.cjs"), "utf8");

  for (const id of ["authScreen", "adminLoginForm", "changePasswordDialog", "btnLogout", "btnAdminChangePassword"]) {
    assert.doesNotMatch(template, new RegExp(`id="${id}"`));
  }
  for (const id of ["doctorLoginSearch", "doctorViewer", "btnDoctorPreviousPeriod", "btnDoctorNextPeriod", "btnPublishReports", "settingsNavigation", "userManagement"]) {
    assert.doesNotMatch(template, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(ui, /function searchDoctorLoginCandidates/);
  assert.doesNotMatch(ui, /function publishReportsAndComments/);
  assert.doesNotMatch(ui, /function composePublishedHtml/);
  assert.match(ui, /function wrapAnalyticCards/);
  assert.doesNotMatch(ui, /function exportDoctorCredentials/);
  assert.doesNotMatch(ui, /function createAllDoctorAccounts/);
  assert.match(ui, /function saveVisibleCommentDrafts/);
  assert.match(ui, /data-analytics-block-key="overview"/);
  assert.doesNotMatch(css, /\.doctor-viewer|\.doctor-login|\.user-access-readiness/);
  assert.match(css, /\.commented-analytic-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+340px/);
  assert.match(css, /@media \(max-width:\s*1100px\)[\s\S]*?\.commented-analytic-row\s*\{\s*grid-template-columns:\s*1fr/);
  assert.doesNotMatch(template + ui + preload + main, /auth:login|auth:setup-admin|auth:change-password|loginAdministrator|setupAdministrator|changePasswordDialog/);
  assert.equal(fs.existsSync(path.join(root, "desktop", "services", "auth-service.cjs")), false);
  assert.doesNotMatch(preload, /viewer:|doctor-candidates|doctor-user|issue-credentials|export-credentials|set-user-active|rebind-doctor/);
  assert.doesNotMatch(main, /ipcMain\.handle\("(?:viewer:|publication:|auth:doctor|admin:(?:users|create-doctor|reset-password|issue-credentials|export-credentials|set-user-active|rebind-doctor))/);
  assert.match(main, /function localAdminActor\(\)/);
  assert.match(main, /database\.ensureLocalAdministrator\(\)/);
  assert.doesNotMatch(main, /mainWindow\.on\("close"|event\.preventDefault\(\)[\s\S]*?app:prepare-close/);
  assert.doesNotMatch(preload, /app:prepare-close|app:close-ready/);
  assert.match(database, /CREATE TABLE users/);
  assert.match(database, /CREATE TABLE comments/);
  assert.match(database, /CREATE TABLE publications/);
  assert.match(database, /CREATE TABLE published_pages/);
  assert.match(database, /CREATE TABLE audit_log/);
});

test("Viewer access is name plus PIN with encrypted pages and no Windows or NTFS fields", () => {
  const adminTemplate = fs.readFileSync(path.join(build, "index.template.html"), "utf8");
  const adminUi = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const viewerIndex = fs.readFileSync(path.join(root, "viewer", "index.html"), "utf8");
  const viewerApp = fs.readFileSync(path.join(root, "viewer", "app.js"), "utf8");
  const viewerMain = fs.readFileSync(path.join(root, "viewer", "main.cjs"), "utf8");
  const viewerPreload = fs.readFileSync(path.join(root, "viewer", "preload.cjs"), "utf8");
  const adminPreload = fs.readFileSync(path.join(root, "desktop", "preload.cjs"), "utf8");
  const storage = fs.readFileSync(path.join(root, "viewer", "storage-service.cjs"), "utf8");
  const packages = fs.readFileSync(path.join(root, "desktop", "services", "viewer-package-service.cjs"), "utf8");
  const standaloneIndex = fs.readFileSync(path.join(root, "viewer", "standalone.html"), "utf8");
  const standaloneApp = fs.readFileSync(path.join(root, "viewer", "standalone-app.js"), "utf8");

  assert.doesNotMatch(adminTemplate + adminUi + viewerIndex + viewerApp + viewerMain + viewerPreload,
    /windowsAccount|windows_account|openAcl|windowsIdentity|accountMatches|Windows-учётка|NTFS/);
  assert.match(adminUi, /четырёхзначный PIN/);
  assert.match(viewerIndex, /<span>Врач<\/span><select id="viewerDoctorSelect"/);
  assert.match(viewerIndex, /Постоянный PIN/);
  assert.match(storage, /DOCTOR_LOCK_MS = 15 \* 60 \* 1000/);
  assert.match(storage, /decryptViewerPage/);
  assert.match(packages, /aes-256-gcm/);
  assert.match(packages, /FORMAT_VERSION = 3/);
  assert.match(adminTemplate, /Один автономный HTML/);
  assert.match(adminTemplate, /ZIP для установленного Viewer/);
  assert.match(adminUi, /exportViewerPackage\("html"\)/);
  assert.match(adminUi, /exportViewerPackage\("zip"\)/);
  assert.match(standaloneIndex, /standaloneViewerData/);
  assert.match(fs.readFileSync(path.join(root, "viewer", "viewer.css"), "utf8"),
    /\.viewer-center-card \.fld select \{[^}]*width: 100%;[^}]*min-width: 0;[^}]*max-width: 100%;/);
  assert.match(standaloneApp, /crypto\.subtle\.deriveKey/);
  assert.match(standaloneApp, /DecompressionStream\("gzip"\)/);
  assert.match(adminUi, /saveViewerDepartmentHead/);
  assert.match(adminUi, /function exportViewerPinsTable\(\)/);
  assert.match(adminUi, /Выгрузить все PIN в Excel/);
  assert.match(adminUi, /\[\["Врач", "PIN"\]/);
  assert.match(adminUi, /padStart\(4, "0"\)/);
  assert.match(adminPreload, /exportViewerPins: payload => invoke\("viewer-publication:export-pins", payload\)/);
  const adminMain = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf8");
  assert.match(adminMain, /ipcMain\.handle\("viewer-publication:export-pins"/);
  assert.match(adminMain, /viewer-pins\.exported/);
  assert.match(adminUi, /subjects/);
  assert.match(standaloneApp, /viewerSubject/);
});

test("Viewer export dialog uses the shared sorted month helper", () => {
  const adminUi = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const start = adminUi.indexOf("async function openViewerExportDialog()");
  const end = adminUi.indexOf("async function exportViewerPackage", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const handler = adminUi.slice(start, end);
  assert.match(handler, /const months = monthKeysSorted\(\);/);
  assert.match(adminUi, /doctorHasDashboardData\(item\.doctorId, monthKey\)/);
  assert.doesNotMatch(handler, /sortedMonths\(\)/);
});

test("completed referrals reuse 1C assignment groups and Viewer export dialog fills the window", () => {
  const core = fs.readFileSync(path.join(build, "app-core.js"), "utf8");
  const metrics = fs.readFileSync(path.join(build, "app-metrics.js"), "utf8");
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const template = fs.readFileSync(path.join(build, "index.template.html"), "utf8");
  const css = fs.readFileSync(path.join(build, "app.css"), "utf8");

  assert.match(core, /function nomenclatureCodeKey\(name\)/);
  assert.match(core, /function nomenclatureMatchKeys\(name\)/);
  assert.match(metrics, /function completedReferralSourceGrouping\(refByType, nazSummary\)/);
  assert.match(metrics, /refGroupsByNaz:/);
  assert.match(ui, /Тип \/ группа 1С \/ номенклатура/);
  assert.match(ui, /Не сопоставлено с группами 1С/);
  assert.match(ui, /renderCompletedReferralNodes/);

  assert.match(template, /<dialog class="pdf-export-dialog viewer-export-dialog no-print" id="viewerExportDialog"/);
  assert.match(template, /class="viewer-export-dialog-body"/);
  assert.match(css, /\.viewer-export-dialog\s*\{[^}]*width:\s*min\(1200px,\s*calc\(100vw - 24px\)\)/s);
  assert.match(css, /\.viewer-export-dialog\s*\{[^}]*height:\s*min\(900px,\s*calc\(100vh - 24px\)\)/s);
  assert.match(css, /\.viewer-export-dialog-body\s*\{[^}]*flex:\s*1 1 auto[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.viewer-export-dialog \.viewer-doctor-list\s*\{[^}]*flex:\s*1 1 320px[^}]*max-height:\s*none/s);
});

test("referral revenue inclusion is configurable by profile and 1C group ownership", () => {
  const core = fs.readFileSync(path.join(build, "app-core.js"), "utf8");
  const metrics = fs.readFileSync(path.join(build, "app-metrics.js"), "utf8");
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const css = fs.readFileSync(path.join(build, "app.css"), "utf8");

  assert.match(core, /function defaultReferralRevenuePolicy\(\)/);
  assert.match(core, /function externalReferralRevenuePolicy\(excludedServiceDepartments = \[\]\)/);
  assert.match(core, /interdisciplinaryGroupDepartments:\s*\{\}/);
  assert.match(core, /function interdisciplinaryGroupDepartment\(path\)/);
  assert.match(core, /referralRevenuePolicyV:\s*1/);
  assert.match(metrics, /function referralRevenueDecision\(profile, referralType, homeDepartment\)/);
  assert.match(metrics, /refIncludedSum:\s*0/);
  assert.match(metrics, /refSumAll:\s*refRevenueAll/);
  assert.match(metrics, /function collectInterdisciplinaryGroupPaths\(departmentName, specializationName = ""\)/);
  assert.match(ui, /Правила учёта выручки от перенаправлений/);
  assert.match(ui, /Привязка групп 1С к подразделениям/);
  assert.match(ui, /Всего выполнено/);
  assert.match(ui, /Учтено в выручке от перенаправлений/);
  assert.match(ui, /function saveReferralRevenuePolicy\(\)/);
  assert.match(ui, /function setInterdisciplinaryGroupDepartment\(select\)/);
  assert.match(css, /\.referral-policy-controls\s*\{/);
});

test("doctor dropdowns are sorted alphabetically in Admin and both Viewer modes", () => {
  const adminUi = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const viewerApp = fs.readFileSync(path.join(root, "viewer", "app.js"), "utf8");
  const standaloneApp = fs.readFileSync(path.join(root, "viewer", "standalone-app.js"), "utf8");

  assert.match(adminUi, /function sortDoctorIdsAlphabetically\(doctorIds\)/);
  assert.match(adminUi, /const list = sortDoctorIdsAlphabetically\(core\.length \? core : ids\)/);
  assert.match(adminUi, /const core = sortDoctorIdsAlphabetically\(coreDoctorsInMonth/);
  assert.match(adminUi, /const allDoctorIds = sortDoctorIdsAlphabetically\(Object\.keys\(DB\.doctors\)\)/);
  assert.match(adminUi, /const doctorIds = sortDoctorIdsAlphabetically\(Object\.keys\(DB\.doctors\)/);

  for (const source of [viewerApp, standaloneApp]) {
    assert.match(source, /function sortDoctorsAlphabetically\(doctors\)/);
    assert.match(source, /localeCompare\([^\n]+"ru", \{ sensitivity: "base" \}\)/);
  }
  assert.match(viewerApp, /sortDoctorsAlphabetically\(state\.status\.catalog\.doctors\)/);
  assert.match(viewerApp, /state\.subjects = sortDoctorsAlphabetically/);
  assert.match(standaloneApp, /sortDoctorsAlphabetically\(BUNDLE\.doctors\)/);
  assert.match(standaloneApp, /state\.subjects = sortDoctorsAlphabetically/);
});

test("dashboard participation requires an individual work report", () => {
  const metrics = fs.readFileSync(path.join(build, "app-metrics.js"), "utf8");
  const adminUi = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  assert.match(metrics, /function doctorHasDashboardData\(docId, monthKey\)/);
  assert.match(metrics, /Object\.prototype\.hasOwnProperty\.call\(m\.vyrabotka, id\)/);
  assert.match(metrics, /function doctorsInMonth\(monthKey\)[\s\S]*Object\.keys\(m\.vyrabotka \|\| \{\}\)/);
  assert.match(adminUi, /const eligibleDoctorIds = doctorIds\.filter\(doctorId =>[\s\S]*doctorHasDashboardData\(doctorId, periodKey\)/);
  assert.match(adminUi, /const periodSubjectIds = \[\.\.\.subjectIds\]\.filter\(doctorId => doctorHasDashboardData\(doctorId, periodKey\)\)/);
  assert.match(adminUi, /periods: publicationPeriodKeys/);
});

test("Viewer publication snapshots the canonical dashboards instead of separate report builders", () => {
  const adminUi = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const start = adminUi.indexOf("async function exportViewerPackage");
  const end = adminUi.indexOf("function reportHeader", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const handler = adminUi.slice(start, end);

  assert.match(handler, /composeViewerDashboardHtml\(target, periodKey, context, comments\)/);
  assert.match(handler, /tab: "department"/);
  assert.match(handler, /tab: "dept"/);
  assert.match(handler, /tab: "doctor"/);
  assert.doesNotMatch(handler, /buildDepartmentReport|buildDeptReport|buildDoctorReport/);
  assert.match(adminUi, /cloneDashboardSnapshot\(source, \{ chartMimeType: "image\/webp", chartQuality: 0\.9 \}\)/);
});
