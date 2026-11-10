"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), crypto = require("node:crypto"), os = require("node:os");
const { createCloudPublication, validateCloudPublication, cloudAccountsFromViewer, PIN_PARAMS } = require("../desktop/services/cloud-publication-service.cjs");
const { assertCloudPatientPrivacy, cloudPrivacyPatterns } = require("../desktop/services/cloud-privacy.cjs");
const { createMobileServer } = require("../mobile-server/server.cjs");
const { createReportRenderCache, renderCloudReport } = require("../mobile-server/cloud-report-renderer.cjs");
const { BackgroundTaskQueue } = require("../desktop/services/background-task-queue.cjs");
const root = path.resolve(__dirname, "..");
function fixtureContext() {
  const context = vm.createContext({ console, window: { desktopAPI: { listComments: async ({ periodKey }) => [
    { scopeType: "doctor", scopeId: "d1", periodKey, blockKey: "doctor.overview", bodyText: "Комментарий <script>текст</script>", authorName: "Администратор" },
    { scopeType: "department", scopeId: "A", periodKey, blockKey: "department.overview", bodyText: "Комментарий отделения", authorName: "Администратор" },
  ], saveDatabase: async () => ({ dataRevision: 1 }) }, addEventListener() {} },
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {}, createElement() { throw new Error("JSON attempted dashboard rendering"); } },
    localStorage: { getItem: () => null, setItem() {} }, navigator: {}, crypto: crypto.webcrypto, TextEncoder, DOMException, Blob, Intl, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(root, "mobile-pilot/report-presentation.js"), "utf8"), context);
  for (const file of ["app-core.js", "app-parsers.js", "app-metrics.js", "cloud-report-data.js", "app-ui.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, "build", file), "utf8"), context, { filename: file });
  }
  vm.runInContext(`
    DB.doctors = { d1: { name: 'Доктор Первый', department: 'A', specialization: 'X', structureManual: true, aliases: [] },
      d2: { name: 'Доктор Второй', department: 'A', specialization: 'Y', structureManual: true, aliases: [] } };
    DB.settings.depts.X = defaultProfile(); DB.settings.depts.Y = defaultProfile();
    DB.settings.departments = { A: ['X', 'Y'] }; DB.settings.departmentUsesSpecializations.A = true;
    normalizeProfiles(); DB.months = { '2026-01': emptyMonth(), '2026-03': emptyMonth() };
    for (const [key, month] of Object.entries(DB.months)) {
      for (const [id, n] of [['d1', 1], ['d2', 2]]) {
        month.vyrabotka[id] = { items: [{ n: 'Процедура', cat: '', sourceForm: 'Сотрудник', q: n, sOwn: n * 1000, sRef: 0 }] };
        month.kb[id] = Object.fromEntries([1, 12, 36].map(win => [win, { clients: [
          { name: 'Пациент Общий Секретный', patientId: 'shared-private-id', v: 1, r: 20, s: 1000 },
          { name: 'Пациент Личный Секретный ' + n, patientId: 'private-id-' + n, v: n + 1, r: 50, s: 2000 },
        ] }]));
      }
    }
    DB.dynamicNotes = { 'doctor|2026-03|d1': { format: 'rich-v1', html: '<b>Ручной вывод</b><br>Ноль &amp; пропуск &#1040;' } };
    saveLocal = async () => true;
  `, context);
  return context;
}
const verifier = pin => { const salt = crypto.randomBytes(24); return { pinSalt: salt.toString("base64"), pinHash: crypto.scryptSync(pin, salt, 64, { ...PIN_PARAMS, maxmem: 64 * 1024 * 1024 }).toString("base64"), pinParams: PIN_PARAMS }; };
function bundle(payload) {
  return createCloudPublication({ ...payload, version: 3, appVersion: "test", accounts: cloudAccountsFromViewer(payload.doctors, {}, {
    admin: verifier("654321"), doctors: payload.doctors.map(doctor => ({ doctorId: doctor.doctorId, headDepartments: [], ...verifier("0123") })),
  }) });
}

test("cloud JSON exports all periods without DOM/charts, retains numeric Admin results, gaps, report groups and comments", async () => {
  const context = fixtureContext(), progress = [];
  context.progress = text => progress.push(text);
  const payload = await vm.runInContext("buildCloudPublicationPayload(progress)", context), publication = bundle(payload);
  assert.equal(publication.pages.length, 12);
  assert.deepEqual([...new Set(publication.pages.map(page => page.periodKey))], ["2026-01", "2026-03"]);
  const personal = publication.pages.find(page => page.doctorId === "d1" && page.periodKey === "2026-03");
  const number = (page, id) => page.report.numbers.metrics.find(metric => metric.id === id).value;
  assert.equal(number(personal, "traffic.patients"), vm.runInContext("computeMetrics('d1','2026-03').traffic.patients", context));
  assert.equal(number(personal, "economy.sales"), 1000);
  assert.equal(personal.report.overallDelta, null, "February gap must not compare March to January");
  assert.equal(personal.report.vectors[3].methodologyId, "report-overlap-v1");
  assert.equal(personal.report.dynamics.conclusion, "Ручной вывод\nНоль & пропуск А");
  const money = personal.report.dynamics.charts.find(chart => chart.id === "money");
  assert.equal(money.labels.length, 3); assert.equal(money.series[0].values[1], null);
  const department = publication.pages.find(page => page.kind === "department" && page.periodKey === "2026-03");
  assert.equal(number(department, "traffic.patients"), 3, "shared patient must be deduplicated across doctors");
  assert.equal(number(department, "economy.sales"), 3000);
  assert.equal(number(department, "loyalty.scheduleLoad"), null, "missing data must not become zero");
  assert.ok(department.report.comments.some(comment => comment.text === "Комментарий отделения"));
  assert.ok(personal.report.comments.some(comment => comment.text.includes("<script>")));
  const snapshot = vm.runInContext("DB", context);
  assert.doesNotThrow(() => assertCloudPatientPrivacy(publication.pages, cloudPrivacyPatterns(snapshot)));
  assert.doesNotMatch(JSON.stringify(publication), /"html":|data:image|Секретный|private-id|clientRows|pinCode/);
  assert.match(progress.at(-1), /12 из 12/);
  const html = renderCloudReport(personal.report, personal.title);
  assert.match(html, /<svg/); assert.match(html, /Ручной вывод/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
});

test("online doctor and group graphs keep the entire calendar year even when January has no data", async () => {
  const context = fixtureContext();
  vm.runInContext(`
    DB.months['2026-09'] = DB.months['2026-03'];
    delete DB.months['2026-01'];
    clearMetricsCache();
  `, context);
  const payload = JSON.parse(JSON.stringify(await vm.runInContext("buildCloudPublicationPayload()", context)));
  for (const page of payload.pages.filter(page => page.periodKey === '2026-09')) {
    const chart = page.report.dynamics.charts.find(chart => chart.id === 'money');
    assert.equal(chart.labels.length, 9, page.kind);
    assert.match(chart.labels[0], /Январь 2026/);
    const sales = page.kind === 'department' || page.kind === 'clinic' ? 3000 : page.doctorId === 'd2' || page.specialization === 'Y' ? 2000 : 1000;
    assert.deepEqual(chart.series[0].values, [null, null, sales, null, null, null, null, null, sales], page.title);
    assert.equal(page.report.dynamics.rows.find(row => row.key === 'sales').values[0], '·');
  }
  assert.equal(payload.pages.filter(page => page.periodKey === '2026-09').length, 6);
});

test("doctor V4 keeps overlapping shares and shows a separate four-group stack from exact 36-month data", async () => {
  const context = fixtureContext();
  vm.runInContext(`
    DB.settings.depts.X.clientBasePartition = { loyalVisits: 3, activeM: 6, lostM: 12, lostAnyVisits: false };
    DB.months['2026-01'].kb.d1[36].clients = [
      { name: 'Пациент А', v: 3, r: 183 },
      { name: 'Пациент Б', v: 4, r: 366 },
      { name: 'Пациент В', v: 1, r: 365 },
      { name: 'Пациент Г', v: 2, r: 366 },
    ];
    delete DB.months['2026-03'].kb.d1[36];
  `, context);
  const publication = bundle(await vm.runInContext("buildCloudPublicationPayload()", context));
  const personal = publication.pages.find(page => page.doctorId === "d1" && page.periodKey === "2026-03");
  const vector = personal.report.vectors[3];
  const history = vector.sections.find(section => section.title === "Динамика клиентской базы по месяцам");
  const chart = JSON.parse(JSON.stringify(history.charts[0]));
  assert.equal(chart.type, "stacked");
  assert.deepEqual(chart.labels, ["Январь 2026", "Февраль 2026", "Март 2026"]);
  assert.deepEqual(chart.series.map(series => series.label), ["Активные лояльные", "Лояльные спящие", "Новые в риске", "Потерянные"]);
  assert.deepEqual(chart.series.map(series => series.values), Array.from({ length: 4 }, () => [1, null, null]));
  assert.match(history.note, /Февраль 2026, Март 2026/);
  assert.ok(vector.windows.find(window => window.id === "12").sections[0].charts.some(chart => chart.id === "overlap-shares"));
  const html = renderCloudReport(personal.report, personal.title);
  assert.match(html, /data-client-base-share-table/);
  assert.deepEqual([...html.matchAll(/data-stack-total>(\d+)</g)].map(match => Number(match[1])), [4]);
  vector.sections = vector.sections.filter(section => section !== history);
  assert.doesNotMatch(renderCloudReport(personal.report, personal.title), /data-client-base-partition-history/);
});

test("online specialization shows monthly visit frequency and averages individual client-base shares", async () => {
  const context = fixtureContext();
  vm.runInContext(`
    DB.doctors.d2.specialization = "X";
    const bases = DB.months["2026-03"].kb;
    bases.d1[36].clients[1].r = 500;
    bases.d2[36].clients.push({ patientId: "3", v: 3, r: 20 }, { patientId: "4", v: 4, r: 20 });
    bases.d1[6] = { clients: [{ patientId: "shared-private-id", v: 1, r: 20 }] };
  `, context);
  const payload = await vm.runInContext("buildCloudPublicationPayload()", context);
  const page = payload.pages.find(page => page.kind === "specialization" && page.specialization === "X" && page.periodKey === "2026-03");
  const traffic = page.report.vectors[0].sections.find(section => section.columns?.includes("Визитов на пациента"));
  assert.deepEqual(JSON.parse(JSON.stringify(traffic.rows)), [
    ["Итог специализации", "7", "3", "2,33"],
    ["Доктор Второй", "4", "2", "2"],
    ["Доктор Первый", "3", "2", "1,5"],
  ]);
  const html = renderCloudReport(page.report, page.title);
  const longWindow = html.split('data-client-base-window-panel="36"')[1];
  assert.match(longWindow, /Потерянные<\/span> <strong>25%<\/strong>/);
  assert.match(longWindow, /Активные<\/span> <strong>0%<\/strong> <small>1 из 2 врачей/);
  assert.match(longWindow, /<strong class="client-base-cell-share">50%<\/strong><small class="client-base-cell-count">1 чел\./);
  const shortWindow = html.split('data-client-base-window-panel="6"')[1].split('data-client-base-window-panel="12"')[0];
  assert.doesNotMatch(shortWindow, /Потерянные/);
  assert.equal(page.report.dynamics.charts.some(chart => chart.id === "scores"), false);
  const archived = JSON.parse(JSON.stringify(page));
  archived.report.dynamics.rows.push({ label: "Общий балл", values: ["78", "—", "80"], delta: "—" });
  archived.report.dynamics.charts.push({ id: "scores", title: "Баллы по векторам", type: "line", unit: "баллов",
    labels: archived.report.dynamics.columns, series: [{ label: "Общий балл", values: [78, null, 80] }] });
  const archivedHtml = createReportRenderCache().render(archived);
  assert.doesNotMatch(archivedHtml, /Баллы по векторам/);
  assert.match(archivedHtml, /<td>Общий балл<\/td><td>78<\/td><td>—<\/td><td>80<\/td>/);
  assert.match(archivedHtml, /Выручка по месяцам/);
});

test("specialization charts January through the selected month using the 36-month base and shared doctor thresholds", async () => {
  const context = fixtureContext();
  vm.runInContext(`
    DB.doctors.d2.specialization = 'X';
    DB.settings.depts.X.clientBaseReport = { activeM: 12, activeVisits: 5, lostM: 15 };
    DB.months['2023-04'] = structuredMonth('2026-01');
    DB.months['2023-03'] = structuredMonth('2026-01');
    function structuredMonth(key) { return JSON.parse(JSON.stringify(DB.months[key])); }
    for (const month of Object.values(DB.months)) {
      for (const id of ['d1', 'd2']) {
        const base = month.kb[id];
        base[36].clients[0].v = 5;
        base[36].clients[1].r = 500;
        base[36].clients[1].v = 2;
        base[12].clients[0].v = 5;
        base[12].clients[1].v = 1;
      }
    }
    delete DB.months['2026-01'].kb.d2[36];
    clearMetricsCache();`, context);
  const payload = await vm.runInContext("buildCloudPublicationPayload()", context);
  const report = payload.pages.find(page => page.kind === "specialization" && page.specialization === "X" && page.periodKey === "2026-03").report;
  const windows = report.vectors[3].windows;
  assert.equal(windows[0].id, "36");
  const historySection = report.vectors[3].sections.find(section => section.title === "Динамика клиентской базы");
  const annual = historySection.charts[0];
  assert.deepEqual(Array.from(annual.labels), ["Январь 2026", "Февраль 2026", "Март 2026"]);
  assert.equal(annual.title, "Динамика с начала года · база за 36 месяцев");
  assert.deepEqual(Array.from(annual.series, item => Array.from(item.values)), [[null, null, 1], [null, null, 2]]);
  assert.ok(windows.every(window => window.sections.length === 1));
  assert.equal(report.dynamics.columns.length, 3);
  const doctor = payload.pages.find(page => page.doctorId === "d1" && page.periodKey === "2026-03").report;
  const personal = doctor.vectors[3].windows.find(window => window.id === "36").sections[0];
  assert.deepEqual(Array.from(personal.rows.find(row => row[0] === "Активные").slice(1)), ["1", "50%", "не менее 5 визитов за последние 12 мес."]);
  assert.match(renderCloudReport(report, "Специализация X", { kind: "specialization" }), /не менее 5 визитов за последние 12 мес/);

  const canvas = new Map();
  context.chart = (id, config) => canvas.set(id, config);
  vm.runInContext(`renderDynCharts(computeDeptDynamics('2026-03','X'), 'blkDeptDyn', specializationClientBaseHistory('2026-03', 'X'))`, context);
  assert.deepEqual(Array.from(canvas.get("blkDeptDyn_base").data.datasets, item => item.data[2]), [1, 2]);
  assert.equal(canvas.get("blkDeptDyn_base").data.labels.length, 3);
  assert.equal(canvas.get("blkDeptDyn_money").data.labels.length, 3);
  assert.equal(canvas.get("blkDeptDyn_base").options.plugins.title.text, annual.title);
});

test("specialization publishes device revenue and unique monthly primary patients with four or more visits", async () => {
  const context = fixtureContext();
  vm.runInContext(`
    DB.doctors.d2.specialization = 'X';
    DB.settings.depts.X.expertise = { mode: 'devices', title: 'Аппараты', group: '', items: [
      { name: 'Аппарат А', syn: ['процедура'], core: true }, { name: 'Аппарат Б', syn: ['аппарат б'], core: true },
    ], rules: [], hints: [] };
    for (const month of Object.values(DB.months)) {
      month.vyrabotka.d2.items.push({ n: 'Другая услуга', sourceForm: 'Сотрудник', q: 3, sOwn: 3000 });
      month.vyrabotka.d1.items.push({ n: 'Процедура', sourceForm: 'Направление', q: 1, sRef: 900 });
    }
    const shared = { name: 'Синтетический Общий Пациент', primary: 1, visits: 3, source: 'Рекомендация' };
    const other = { name: 'Синтетический Другой Пациент', primary: 1, visits: 3, source: 'Сайт' };
    const newPatients = ['Яндекс-Карты', 'Яндекс Дзен', 'ПроДокторов', ''].map((source, i) =>
      ({ name: 'Синтетический Новый Пациент ' + i, primary: 1, visits: 1, source }));
    DB.months['2026-01'].primaryPatients = { perDoc: { d1: { patients: [shared, other, ...newPatients] },
      d2: { patients: [{ ...shared, name: 'СИНТЕТИЧЕСКИЙ ОБЩИЙ ПАЦИЕНТ', visits: 1, source: 'Сарафанное радио' },
        { ...other, visits: 1, source: 'ВК' }, { ...newPatients[0], primary: 0, source: 'ВК' }] } } };
    DB.months['2026-03'].primaryPatients = { perDoc: { d1: { patients: [other] } } };
    clearMetricsCache();
  `, context);
  const payload = await vm.runInContext("buildCloudPublicationPayload()", context);
  const publication = bundle(payload);
  const report = structuredClone(publication.pages.find(page => page.kind === "specialization" && page.specialization === "X" && page.periodKey === "2026-03").report);
  const deviceSections = report.vectors[1].sections;
  const devices = deviceSections.find(section => section.title === "Аппараты за месяц");
  assert.deepEqual(devices.rows.map(([name, count, sum]) => [name, count, Number(sum.replace(/[^\d]/g, ""))]), [
    ["Аппарат А", "3", 3000], ["Аппарат Б", "0", 0],
  ]);
  assert.equal(devices.metrics, undefined);
  const perDoctor = deviceSections.find(section => section.title === "Аппаратные методики по врачам");
  assert.deepEqual(Object.fromEntries(perDoctor.rows.filter(row => row[1] === "Аппарат А").map(([doctor, , count, sum]) => [doctor, [count, Number(sum.replace(/[^\d]/g, ""))]])), {
    "Доктор Первый": ["1", 1000], "Доктор Второй": ["2", 2000],
  });
  const deviceChart = deviceSections.find(section => section.title === "Загрузка аппаратов").charts[0];
  assert.deepEqual(deviceChart.series[0].values, [3000, null, 3000]);
  assert.deepEqual(deviceChart.series[0].pointNotes, ["3 шт.", "", "3 шт."]);
  const primary = report.vectors[4].sections.find(section => section.title === "Первичные пациенты");
  assert.deepEqual(Object.fromEntries(primary.rows), { "Доктор Первый": "1", "Доктор Второй": "—", "Итого по специализации": "—" });
  assert.deepEqual(primary.charts[0].series[0].values, [6, null, null]);
  assert.deepEqual(primary.charts[0].series[1].values, [2, null, null]);
  assert.deepEqual(primary.charts[0].series[1].pointNotes, ["33,3% от первичных", "", ""]);
  assert.deepEqual(primary.charts[1].series[0].values, [null, null, null, null, null]);
  const january = publication.pages.find(page => page.kind === "specialization" && page.specialization === "X" && page.periodKey === "2026-01").report;
  const januaryPrimary = january.vectors[4].sections.find(section => section.title === "Первичные пациенты");
  assert.deepEqual(Array.from(januaryPrimary.charts.find(chart => chart.id === "specialization-primary-sources").series[0].values), [1, 1, 1, 1, 2]);
  const januaryHtml = renderCloudReport(january, "Специализация X", { kind: "specialization" });
  assert.match(januaryHtml, /<tfoot>[\s\S]*?Итого по специализации<\/th><td class="num">6<\/td>[\s\S]*?<\/table>[\s\S]*?data-specialization-primary-sources[\s\S]*?<svg/);
  assert.match(januaryHtml, /Рекомендации[\s\S]*?Социальные сети[\s\S]*?Агрегаторы[\s\S]*?Прочие<\/span><b>2 чел\.<\/b><strong>33,3%<\/strong>/);
  assert.doesNotMatch(januaryHtml, /specialization-source-bar|Всего <strong>6 чел/);
  assert.doesNotMatch(JSON.stringify(january), /Синтетический .+ Пациент|Сарафанное радио/i);
  const legacy = structuredClone(january);
  const legacyPrimary = legacy.vectors[4].sections.find(section => section.title === "Первичные пациенты");
  legacyPrimary.charts = legacyPrimary.charts.filter(chart => chart.id !== "specialization-primary-sources");
  const legacyHtml = renderCloudReport(legacy, "Специализация X", { kind: "specialization" });
  assert.doesNotMatch(legacyHtml, /data-specialization-primary-sources/);
  assert.match(legacyHtml, /Итого по специализации<\/th><td class="num">6/);
  assert.doesNotMatch(JSON.stringify(report), /Синтетический (Общий|Другой) Пациент/i);
  const html = renderCloudReport(report, "Специализация X", { kind: "specialization" });
  const monthly = html.match(/data-specialization-device-month[\s\S]+?<\/section>/)[0];
  assert.equal((monthly.match(/data-device-month-card>/g) || []).length, 2);
  assert.match(monthly, /Доктор Первый<\/td>[\s\S]+?1\s000 ₽/);
  assert.match(monthly, /Доктор Второй<\/td>[\s\S]+?2\s000 ₽/);
  assert.doesNotMatch(monthly, /Доля от выручки|Выручка по всем аппаратам|Итого/);
  const legacyDeviceReport = structuredClone(report);
  const oldDetails = legacyDeviceReport.vectors[1].sections.find(section => section.title === "Аппаратные методики по врачам");
  oldDetails.columns = ["Врач", "Выручка по аппаратам", "Доля от выручки врача"];
  oldDetails.rows = [["Доктор Первый", "1 000 ₽", "100%"]];
  const oldDevices = renderCloudReport(legacyDeviceReport, "Специализация X", { kind: "specialization" });
  assert.match(oldDevices, /Разбивка по специалистам доступна после новой публикации/);
  assert.doesNotMatch(oldDevices, /Доля от выручки врача/);
  assert.match(html, /<details[^>]+data-specialization-device-history/);
  assert.match(html, /<h5>Аппарат А<\/h5>/);
  assert.match(html, /<h5>Аппарат Б<\/h5>/);
  assert.match(html, /class="device-point-label"[^>]+>3[\s\u00a0]000 ₽<tspan[^>]+>3 шт\./);
  const summary = html.match(/data-device-history-summary[\s\S]+?<\/details>/)[0];
  assert.equal((summary.match(/class="num period-best"/g) || []).length, 2, "both tied positive months are best and zero revenue stays neutral");
  assert.match(summary, /<tfoot>[\s\S]*6\s000 ₽<br><small class="muted">6 шт\.[\s\S]*0 ₽<br><small class="muted">0 шт\./);
  assert.match(html, /<title>Аппарат А · Январь 2026: [^<]+ · 3 шт\.<\/title>/);
  assert.match(html, /33,3% от первичных/);
  assert.match(html, /Для общей разбивки нужны данные по всем врачам выборки/);
  let adminChart;
  context.chart = (_id, config) => { adminChart = config; };
  vm.runInContext("renderSpecializationTrend(specializationActivityView('2026-03', null, 'X').primaryChart)", context);
  adminChart.data.datasets[1].data[2] = 0;
  adminChart.data.datasets[1].pointNotes[2] = "0% от первичных";
  const drawn = [];
  const ctx = { save() {}, restore() {}, strokeText() {}, measureText: value => ({ width: value.length * 6 }),
    fillText: (text, x, y) => drawn.push({ text, x, y }) };
  adminChart.plugins[0].afterDatasetsDraw({ ctx, width: 300, chartArea: { top: 20, bottom: 200 }, data: adminChart.data,
    getSortedVisibleDatasetMetas: () => [0, 1].map(index => ({ index, data: [60, 110, 160].map(x => ({ x, y: 198 })) })) });
  assert.deepEqual(drawn.map(label => label.text), ["6", "2 · 33,3%", "0 · 0%"]);
  assert.ok(Math.abs(drawn[0].y - drawn[1].y) >= 12, "labels of coinciding points remain separate");
});

test("dismissed doctors are excluded from cloud credentials, pages and totals while Admin keeps their history", async () => {
  const context = fixtureContext();
  vm.runInContext(`DB.doctors = { d1: DB.doctors.d1, d2: DB.doctors.d2 };
    DB.doctors.d2.dismissed = true;
    globalThis.adminBefore = aggregateDeptMonth("2026-03", "all").econ.sales;
    pdfTargetSource = () => aggregateDeptMonth("2026-03", "all").econ.sales;
    globalThis.viewerSales = viewerDashboardSource({tab:"department"}, "2026-03");
    globalThis.adminAfter = aggregateDeptMonth("2026-03", "all").econ.sales;`, context);
  assert.equal(context.adminBefore, 3000);
  assert.equal(context.viewerSales, 1000);
  assert.equal(context.adminAfter, 3000);
  const publication = bundle(await vm.runInContext("buildCloudPublicationPayload()", context));
  assert.deepEqual(Array.from(publication.doctors, doctor => doctor.doctorId), ["d1"]);
  assert.deepEqual(Array.from(publication.accounts, account => account.accountId), ["admin", "doctor:d1"]);
  assert.doesNotMatch(JSON.stringify(publication), /Доктор Второй/);
  const clinic = publication.pages.find(page => page.kind === "clinic" && page.periodKey === "2026-03");
  assert.match(clinic.report.summary, /^1 врач/);
  assert.equal(clinic.report.numbers.metrics.find(metric => metric.id === "economy.sales").value, 1000);
  vm.runInContext("DB.doctors.d1.dismissed = true", context);
  const empty = await vm.runInContext("buildCloudPublicationPayload()", context);
  assert.equal(empty.doctors.length + empty.pages.length, 0);
});

test("cloud privacy permits a labelled doctor who is also a patient but still rejects that name in free text", () => {
  const page = { title: "Доктор Первый · март", report: { sections: [{ columns: ["Врач", "Балл"], rows: [["Доктор Первый", "80"]] }] } };
  const options = { doctorNames: ["Доктор Первый"] };
  assert.doesNotThrow(() => assertCloudPatientPrivacy([page], ["Доктор Первый"], options));
  page.report.comments = [{ text: "Пациент: Доктор Первый" }];
  assert.throws(() => assertCloudPatientPrivacy([page], ["Доктор Первый"], options), /пациента/);
  assert.throws(() => assertCloudPatientPrivacy([{ report: { note: "xxbabcc" } }], ["abc", "bab", "bcc", "babcc"]), /пациента/);
});

test("structured cloud reports reject nested patient/HTML fields, forged numbers and changed checksums", async () => {
  const original = bundle(await vm.runInContext("buildCloudPublicationPayload()", fixtureContext()));
  for (const mutate of [
    page => { page.report.vectors[0].sections[0].clients = [{ name: "Patient" }]; },
    page => { page.html = "<p>Snapshot</p>"; },
    page => { page.report.numbers.metrics[0].value = "100"; },
    page => { page.report.overall = 100; },
  ]) {
    const changed = structuredClone(original); mutate(changed.pages[0]);
    assert.throws(() => validateCloudPublication(changed));
  }
});

test("numeric cloud worker validates and serializes without including its local patient patterns", async () => {
  const payload = bundle(await vm.runInContext("buildCloudPublicationPayload()", fixtureContext()));
  const queue = new BackgroundTaskQueue();
  try {
    const result = await queue.run("cloud-publication", { ...payload, privacyPatterns: ["Hidden Patient Secret"] });
    assert.equal(result.pages, 12); assert.doesNotMatch(result.serialized, /privacyPatterns|Hidden Patient|data:image|"html":/);
  } finally { queue.close(); }
});

test("v3 JSON manual upload, PIN access, report rendering, catalog privacy and denied pages work over HTTP", async t => {
  const publication = bundle(await vm.runInContext("buildCloudPublicationPayload()", fixtureContext()));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "klinvekt-data-http-"));
  const server = createMobileServer({ dataDir: dir, cloudPortalId: "portal" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const hash = data => crypto.createHash("sha256").update(data).digest("hex");
  const headers = { "X-Vibe-User-Id": "1", "X-Vibe-Portal-Id": "portal", "X-Vibe-User-Role": "ADMIN", "X-Klinvekt-Cloud-Upload": "1" };
  async function publish(value) {
    const bytes = Buffer.from(JSON.stringify(value));
    const upload = await (await fetch(base + "/api/cloud/manual/uploads", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ bytes: bytes.length, sha256: hash(bytes) }) })).json();
    for (let index = 0, offset = 0; offset < bytes.length; index++, offset += upload.chunkBytes) {
      const chunk = bytes.subarray(offset, offset + upload.chunkBytes);
      assert.equal((await fetch(`${base}/api/cloud/manual/uploads/${upload.uploadId}/chunks/${index}`, { method: "PUT", headers: { ...headers, "Content-Type": "application/octet-stream", "X-Chunk-Sha256": hash(chunk) }, body: chunk })).status, 200);
    }
    assert.equal((await fetch(`${base}/api/cloud/manual/uploads/${upload.uploadId}/complete`, { method: "POST", headers })).status, 200);
  }
  const signIn = (accountId, pin) => fetch(base + "/api/cloud/login", { method: "POST", headers: { ...headers, "Content-Type": "application/json", "X-Klinvekt-Cloud-Auth": "1" }, body: JSON.stringify({ accountId, pin }) });
  await publish(publication);
  const login = await signIn("doctor:d1", "0123");
  assert.equal(login.status, 200); const session = await login.json(); headers["X-Klinvekt-Cloud-Session"] = session.sessionToken;
  const catalog = await (await fetch(base + "/api/cloud/context", { headers })).json();
  assert.equal(catalog.pages.length, 2); assert.doesNotMatch(JSON.stringify(catalog), /report|numbers|pinHash|Kommentar/);
  const response = await fetch(base + "/api/cloud/pages/" + catalog.pages[1].pageId, { headers });
  assert.equal(response.status, 200); assert.match(await response.text(), /cloud-data-report.*Доктор Первый/s);
  const forbidden = publication.pages.find(page => page.kind === "clinic");
  assert.equal((await fetch(base + "/api/cloud/pages/" + forbidden.pageId, { headers })).status, 403);
  await publish(bundle({ doctors: [], pages: [] }));
  assert.equal((await fetch(base + "/api/cloud/pages/" + catalog.pages[1].pageId, { headers })).status, 401);
  const loginOptions = await (await fetch(base + "/api/cloud/admin", { headers })).json();
  assert.deepEqual(loginOptions.accounts.map(account => account.accountId), ["admin"]);
  assert.equal((await signIn("doctor:d1", "0123")).status, 401);
  const adminLogin = await signIn("admin", "654321");
  assert.equal(adminLogin.status, 200);
  headers["X-Klinvekt-Cloud-Session"] = (await adminLogin.json()).sessionToken;
  assert.deepEqual((await (await fetch(base + "/api/cloud/context", { headers })).json()).pages, []);
});

test("desktop JSON chooses a destination first, validates its owner and writes the complete v3 file atomically", async t => {
  const payload = await vm.runInContext("buildCloudPublicationPayload()", fixtureContext());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "klinvekt-data-save-")), filePath = path.join(dir, "anonymous.json");
  const source = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf8");
  const handlers = new Map(), queue = new BackgroundTaskQueue();
  t.after(() => { queue.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let chosen = false, canceled = false;
  const pinIds = Object.fromEntries(payload.doctors.map(doctor => [doctor.doctorId, crypto.randomUUID()]));
  const pinSync = { setId: crypto.randomUUID(), revision: 1, digest: "a".repeat(64) };
  const context = vm.createContext({ require, fs, path, Date, mainWindow: {}, cloudExportFiles: new Map(),
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, localAdminActor: () => ({ userId: "admin" }),
    dialog: { showSaveDialog: async () => { chosen = true; return { canceled, filePath }; } },
    configStore: { publicConfig: () => ({ outputDir: dir }) }, ensureObject: value => value, app: { getVersion: () => "test" },
    database: { loadSnapshot: () => ({ doctors: Object.fromEntries(payload.doctors.map(doctor => [doctor.doctorId, {}])), months: {}, settings: {} }),
      viewerPinTransferPayload: () => ({ sync: pinSync }), viewerPinSyncState: () => ({ ...pinSync, ids: pinIds }),
      viewerAccessSnapshot() {}, viewerExportCredentials: () => ({ admin: verifier("654321"), doctors: payload.doctors.map(doctor => ({ doctorId: doctor.doctorId, headDepartments: [], ...verifier("0123") })) }) },
    cloudAccountsFromViewer, cloudPrivacyPatterns,
    runPublicationTask: (_event, _id, task, value) => { assert.equal(chosen, true); return queue.run(task, value); },
  });
  vm.runInContext(source.slice(source.indexOf('  ipcMain.handle("cloud-publication:choose-file"'), source.indexOf('  ipcMain.handle("mobile-publication:export-bundle"')), context);
  const event = { sender: { id: 1 } }, exportFile = handlers.get("cloud-publication:export");
  await assert.rejects(exportFile(event, { ...payload, action: "json", operationId: "test" }), /Сначала выберите файл/);
  assert.equal(fs.existsSync(filePath), false);
  const selection = await handlers.get("cloud-publication:choose-file")(event);
  assert.equal(fs.existsSync(filePath), false, "selection must not start rendering or create a partial file");
  await assert.rejects(exportFile({ sender: { id: 2 } }, { ...payload, action: "json", operationId: "test", fileToken: selection.token }), /Сначала выберите файл/);
  const result = await exportFile(event, { ...payload, action: "json", operationId: "test", fileToken: selection.token });
  assert.equal(result.path, filePath);
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).version, 3);
  assert.deepEqual(fs.readdirSync(dir), ["anonymous.json"]);
  await assert.rejects(exportFile(event, { ...payload, action: "json", fileToken: selection.token }), /Сначала выберите файл/);
  canceled = true;
  assert.equal((await handlers.get("cloud-publication:choose-file")(event)).canceled, true);
});
