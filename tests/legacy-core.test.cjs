"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { validateMobilePublication, createMobilePublicationBundle, openMobileReportSession } = require("../desktop/services/mobile-publication-service.cjs");

const build = path.resolve(__dirname, "..", "build");

function createContext({ desktop = false } = {}) {
  const savedSnapshots = [];
  const localSnapshots = [];
  const window = desktop ? {
    desktopAPI: {
      saveDatabase: async json => {
        savedSnapshots.push(json);
        return { months: 1, doctors: 1, imports: 0, schemaVersion: 1 };
      },
    },
  } : {};
  const context = vm.createContext({
    console,
    window,
    savedSnapshots,
    localSnapshots,
    document: { getElementById: () => null, createElement: () => ({ style: {} }), body: { appendChild: () => {} } },
    localStorage: { getItem: () => null, setItem: (_key, value) => localSnapshots.push(value) },
    indexedDB: {},
    navigator: {},
    confirm: () => true,
    setTimeout,
    clearTimeout,
    Blob,
    FileReader: class {},
    Intl,
  });
  for (const fileName of ["app-core.js", "app-parsers.js", "app-metrics.js"]) {
    vm.runInContext(fs.readFileSync(path.join(build, fileName), "utf8"), context, { filename: fileName });
  }
  return context;
}

test("Admin doctor supplemental percentages use assigned quantities and the same client base", () => {
  const context = createContext();
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  vm.runInContext(ui.slice(ui.indexOf("function adminYearMonths"), ui.indexOf("function dynamicsHtml")), context);
  const values = vm.runInContext(`(() => {
    const r = { cross: { naz: { 1: { focus: { assigned: 8, resultQ: 3 } } } },
      akb: { primary: { total: 40, seg: { active: 10 }, groupAvailable: { active: true } } } };
    const values = [adminDoctorMetricPercent('nazFocusResult', r, {}), adminDoctorMetricPercent('akb', r, {})];
    r.cross.naz[1].focus.assigned = 0;
    r.akb.primary.groupAvailable.active = false;
    values.push(adminDoctorMetricPercent('nazFocusResult', r, {}), adminDoctorMetricPercent('akb', r, {}), adminDoctorMetricPercent('akb', null, {}));
    r.cross.naz[1].focus.assigned = 2;
    values.push(adminDoctorMetricPercent('nazFocusResult', r, {}));
    return values;
  })()`, context);
  assert.deepEqual(Array.from(values), [37.5, 25, null, null, null, 150]);
});

test("Admin September feedback preserves referral totals, item conversion, year gaps and unique profiles", () => {
  const context = createContext();
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  vm.runInContext(ui.slice(ui.indexOf("function adminYearMonths"), ui.indexOf("function dynamicsHtml")), context);
  const result = vm.runInContext(`(() => {
    DB.doctors = { d1: { name: 'Тестовый Косметолог', aliases: [], department: 'Косметология', specialization: 'Косметология', structureManual: true } };
    DB.settings.departmentUsesSpecializations['Косметология'] = true;
    DB.settings.departments['Косметология'] = ['Косметология', 'Эстетисты'];
    const p = DB.settings.depts['Косметология'];
    p.inheritReferralRevenuePolicy = false;
    p.referralRevenuePolicy = defaultReferralRevenuePolicy();
    p.overrides = {};
    DB.months = { '2026-01': emptyMonth(), '2026-12': emptyMonth() };
    for (const month of Object.values(DB.months)) {
      month.vyrabotka.d1 = { items: [
        { n: 'Процедура А', cat: '', sourceForm: 'Сотрудник', q: 1, sOwn: 1000, sRef: 0 },
        { n: 'Процедура А', cat: '', sourceForm: 'Направление', q: 2, sOwn: 200, sRef: 0 },
        { n: 'Процедура Б', cat: '', sourceForm: 'Направление', q: 1, sOwn: 300, sRef: 0 }
      ] };
      month.naznach.d1 = { '1': { items: [
        { n: 'Процедура А', a: 4, d: 1, sq: 1, ss: 200 },
        { n: 'Процедура Б', a: 2, d: 1, sq: 0, ss: 0 }
      ] } };
      month.kb.d1 = { '12': { clients: [{ patientId: 'synthetic-1', name: 'Тестовый Пациент', v: 4, r: 20, s: 1000 }] } };
    }
    const baseline = computeMetrics('d1', '2026-01');
    p.overrides['процедура а'] = { referralIncluded: false };
    normalizeProfiles();
    clearMetricsCache();
    const excluded = computeMetrics('d1', '2026-01');
    const persisted = DB.settings.depts['Косметология'].overrides['процедура а'].referralIncluded;
    const catalog = collectDeptItems('Косметология', DB.settings.depts['Косметология']);
    const year = adminDoctorDynamics('d1', '2026-12');
    const base = adminClientBaseSeries('d1', '2026-12', 12);
    const buckets = adminReferralBuckets({
      'Профильные услуги': { s: 200, q: 2, includedS: 0, items: { A: { s: 200, q: 2 } } },
      'Другие услуги клиники': { s: 300, q: 1, includedS: 300, items: { B: { s: 300, q: 1 } } }
    });
    const policy = { referralRevenuePolicy: externalReferralRevenuePolicy(['Косметология']), overrides: { a: { referralIncluded: true } } };
    const forcedInclude = referralRevenueDecision(policy, 'Профильные услуги', 'Косметология', 'A').included;
    delete policy.overrides.a.referralIncluded;
    const resetInclude = referralRevenueDecision(policy, 'Профильные услуги', 'Косметология', 'A').included;
    return { baseline, excluded, persisted, catalogValue: catalog.find(x => x.n === 'Процедура А').override.referralIncluded,
      months: year.months, values: year.rows.find(row => row.key === 'sales').values,
      base: base.datasets.map(x => ({ label: x.label, data: x.data })), missingWindow: adminClientBaseSeries('d1', '2026-12', 24).datasets[0].data,
      buckets, forcedInclude, resetInclude, specs: departmentSpecializations('Косметология'),
      conversion: appointmentItemConversion({ assigned: 4, done: 1, soldQ: 1, resultQ: 2 }),
      noDenominator: appointmentItemConversion({ assigned: 0, done: 1, soldQ: 0, resultQ: 1 }) };
  })()`, context);
  const x = JSON.parse(JSON.stringify(result));
  assert.equal(x.baseline.econ.refRevenue - x.excluded.econ.refRevenue, 200);
  assert.equal(x.baseline.econ.sales, x.excluded.econ.sales);
  assert.deepEqual(x.baseline.cross.naz[1].totals, x.excluded.cross.naz[1].totals);
  assert.equal(x.excluded.cross.refSumAll, 500);
  assert.equal(x.excluded.cross.refExcludedSum, 200);
  assert.equal(x.persisted, false);
  assert.equal(x.catalogValue, false);
  assert.equal(x.months.length, 12);
  assert.equal(x.months[0], '2026-01');
  assert.equal(x.months[11], '2026-12');
  assert.equal(x.values[1], null);
  assert.equal(x.base[0].data[0], 1);
  assert.equal(x.base[0].data[1], null);
  assert.ok(x.missingWindow.every(value => value === null));
  assert.deepEqual(Object.keys(x.buckets), ['Услуги']);
  assert.equal(x.buckets['Услуги'].s, 500);
  assert.equal(x.buckets['Услуги'].includedS, 300);
  assert.equal(x.forcedInclude, true);
  assert.equal(x.resetInclude, false);
  assert.deepEqual(x.specs, ['Косметология', 'Эстетисты']);
  assert.equal(x.conversion, '50%');
  assert.equal(x.noDenominator, '—');
});

test("stacked Admin client base assigns overlaps once and preserves missing months", () => {
  const context = createContext();
  const ui = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  vm.runInContext(ui.slice(ui.indexOf("function adminYearMonths"), ui.indexOf("function dynamicsHtml")), context);
  const result = vm.runInContext(`(() => {
    kbSummary = (_id, month) => month === '2026-02' ? null : ({ total: 5, clientRows: [
      { groups: ['loyal', 'active'] }, { groups: ['loyal', 'loyalSleep'] },
      { groups: ['lost', 'newRisk'] }, { groups: ['loyal'] }, { groups: [] }
    ] });
    return adminClientBaseSeries('d1', '2026-12', 36);
  })()`, context);
  const x = JSON.parse(JSON.stringify(result));
  assert.deepEqual(x.datasets.map(row => row.data[0]), [1, 1, 0, 1, 1, 1]);
  assert.equal(x.datasets.reduce((sum, row) => sum + row.data[0], 0), x.totals[0]);
  assert.ok(x.datasets.every(row => row.data[1] === null));
  assert.equal(x.totals[1], null);
  assert.equal(x.months.length, 12);
});

test("core date and doctor-name helpers preserve legacy behavior", () => {
  const context = createContext();
  assert.equal(vm.runInContext("normFio('Иванова Ёлка Петровна..')", context), "иванова елка петровна");
  assert.equal(vm.runInContext("prevMonthKey('2026-01')", context), "2025-12");
  assert.equal(vm.runInContext("periodMonths(extractPeriod('01.01.2026 - 31.03.2026'))", context), 3);
  assert.equal(vm.runInContext("isFullMonthPeriod(extractPeriod('01.01.2026 - 31.03.2026'))", context), true);
  assert.equal(vm.runInContext("isFullMonthPeriod(extractPeriod('02.01.2026 - 31.03.2026'))", context), false);
});

function loadMobilePublicationRenderer(context) {
  const uiSource = fs.readFileSync(path.join(build, "app-ui.js"), "utf8");
  const goalSource = uiSource.slice(
    uiSource.indexOf("function doctorGoalsSource"),
    uiSource.indexOf("function metricHighlight"),
  );
  const scoringSource = uiSource.slice(
    uiSource.indexOf("function scoringBenchmarkDefs"),
    uiSource.indexOf("function viewerAccessSettingsHtml"),
  );
  const colorSource = uiSource.slice(uiSource.indexOf("const DEVICE_COLORS"), uiSource.indexOf("/* Зеркальная выручка"))
    + uiSource.match(/const VEC_LINE_COLORS = [^;]+;/)[0];
  const clientBaseSource = uiSource.slice(uiSource.indexOf("function clientBaseGroupLabel"), uiSource.indexOf("function clientBaseProfileDescription"));
  const historySource = uiSource.slice(uiSource.indexOf("function doctorMetricDynamics"), uiSource.indexOf("function metricTrendMarkup"));
  const publicationSource = colorSource + clientBaseSource + goalSource + scoringSource + historySource + uiSource.slice(
    uiSource.indexOf("function mobilePublicationText"),
    uiSource.indexOf("function doctorMetricsHeaderHtml"),
  );
  vm.runInContext("const UI = { nazSlice: 1 };", context);
  vm.runInContext(publicationSource, context, { filename: "app-ui-mobile-publication.js" });
}

test("Admin builds a valid mobile publication from calculated metrics without patient rows", () => {
  const context = createContext();
  loadMobilePublicationRenderer(context);

  const publication = vm.runInContext(`(() => {
    DB.doctors = { d1: { name: 'Тестов Врач', aliases: [], dept: 'По умолчанию' } };
    DB.months = { '2026-01': emptyMonth() };
    DB.months['2026-01'].vyrabotka.d1 = { items: [] };
    DB.months['2026-01'].manual6.d1 = {
      prodoctorov: 4.9,
      napopravku: 4.8,
      doctu: 4.7,
      sberhealth: 4.9,
      nps: 82,
      reviews: 14
    };
    clearMetricsCache();
    return buildMobilePublication('d1', { '2026-01': [{
      scopeType: 'doctor', scopeId: 'd1', periodKey: '2026-01', blockKey: 'doctor.dynamics',
      status: 'published', bodyText: 'Сохранённый комментарий Viewer', authorName: 'Администратор',
      updatedAt: '2026-02-01T10:00:00.000Z'
    }] });
  })()`, context);
  const plain = JSON.parse(JSON.stringify(publication));
  const validated = validateMobilePublication(plain);
  const serialized = JSON.stringify(validated);

  assert.equal(validated.doctor.name, "Тестов Врач");
  assert.equal(validated.periods.length, 1);
  assert.equal(validated.periods[0].headlineMetrics.length, 5);
  assert.equal(validated.periods[0].vectors.length, 6);
  assert.equal(validated.periods[0].goals.length, 15);
  assert.deepEqual(validated.periods[0].dynamics.columns, ["Январь 2026"]);
  assert.equal(validated.periods[0].comments[0].text, "Сохранённый комментарий Viewer");
  assert.doesNotMatch(serialized, /"(?:patientId|patientName|clientRows|clients)"/);
});

test("bulk mobile export follows Viewer report eligibility and keeps head-only access without empty reports", async () => {
  const context = createContext({ desktop: true });
  loadMobilePublicationRenderer(context);
  let exported;
  context.window.desktopAPI.exportMobilePublicationBundle = async payload => { exported = JSON.parse(JSON.stringify(payload)); return { canceled: false, doctors: 3 }; };
  context.window.desktopAPI.listComments = async ({ periodKey }) => [
    { scopeType: "doctor", scopeId: "real", periodKey, blockKey: "doctor.overview", status: "published", bodyText: "Комментарий к настоящему отчёту" },
    { scopeType: "doctor", scopeId: "manual", periodKey, blockKey: "doctor.overview", status: "published", bodyText: "Не создаёт выработку" },
    { scopeType: "doctor", scopeId: "real", periodKey, blockKey: "doctor.overview", status: "archived", bodyText: "Архивный" },
  ];
  const eligible = vm.runInContext(`(() => {
    DB.doctors = Object.fromEntries(['real', 'zero', 'technical', 'manual', 'head', 'inactive'].map(id => [id,
      { name: id, dept: 'По умолчанию', aliases: [] }]));
    DB.months = Object.fromEntries(['2026-01', '2026-02', '2026-03'].map(key => [key, emptyMonth()]));
    for (const key of Object.keys(DB.months)) DB.months[key].zapis.real = { created: 2, total: 2 };
    for (const key of ['2026-01', '2026-03']) DB.months[key].vyrabotka.real = { items: [{ n: 'Прием', cat: 'Приемы', q: 2, sOwn: 100, sRef: 0 }] };
    DB.months['2026-03'].vyrabotka.zero = { items: [] };
    DB.months['2026-03'].vyrabotka.inactive = { items: [] };
    DB.months['2026-03'].manual6.manual = { nps: 90, reviews: 5 };
    clearMetricsCache();
    return { technicalHasMetrics: Boolean(computeMetrics('technical', '2026-03')),
      viewer: Object.keys(DB.doctors).filter(id => doctorHasDashboardData(id, '2026-03')),
      mobile: Object.keys(DB.doctors).filter(id => mobilePublicationMonthKeys(id).length) };
  })()`, context);
  assert.equal(eligible.technicalHasMetrics, true, "common records import reproduces empty metrics for a technical account");
  assert.deepEqual(Array.from(eligible.mobile), Array.from(eligible.viewer));
  vm.runInContext(`const VIEWER_ACCESS = { doctors: Object.keys(DB.doctors).map(doctorId => ({ doctorId, active: doctorId !== 'inactive' })) };
    async function refreshViewerPublicationAccess() {}
    function toast(message, error) { if (error) throw new Error(message); }`, context);
  await vm.runInContext("exportAllMobilePublications()", context);
  assert.deepEqual(exported.publications.map(item => item.doctorId), ["real", "zero"]);
  assert.deepEqual(exported.publications[0].publication.periods.map(period => period.id), ["2026-03", "2026-01"]);
  assert.deepEqual(exported.publications[0].publication.periods[0].comments.map(item => item.text), ["Комментарий к настоящему отчёту"]);
  const bundle = createMobilePublicationBundle({ ...exported, credentials: { doctors: exported.recipients.map(item => ({
    doctorId: item.doctorId, pinCode: "2468", pinVersion: 1,
    headDepartments: item.doctorId === "head" ? [exported.publications[0].department] : [],
  })) } });
  assert.deepEqual(bundle.doctors.map(item => item.doctorId).sort(), ["head", "real", "zero"]);
  const head = openMobileReportSession(bundle, "head", "2468");
  assert.equal(head.owner.periods, 0);
  assert.deepEqual(head.reports.map(item => item.doctorId).sort(), ["real", "zero"]);
  assert.throws(() => head.readReport("technical"), /Нет доступа/);
  assert.equal(head.readReport("real").periods[0].comments[0].text, "Комментарий к настоящему отчёту");
});

test("mobile KPI history matches desktop calendar baselines, units and year-to-date averages", () => {
  const context = createContext();
  loadMobilePublicationRenderer(context);
  const result = vm.runInContext(`(() => {
    DB.doctors = { d1: { name: 'Тестовый врач', dept: 'По умолчанию', aliases: [] } };
    DB.months = Object.fromEntries(['2026-01', '2026-02', '2026-03', '2026-04'].map(key => [key, emptyMonth()]));
    for (const [key, count] of [['2026-01', 2], ['2026-03', 4], ['2026-04', 6]]) {
      DB.months[key].vyrabotka.d1 = { items: [{ n: 'Прием', cat: 'Приемы', q: count, sOwn: count * 100, sRef: 0 }] };
      DB.months[key].kb.d1 = { '1': { clients: Array.from({ length: count }, (_, i) => ({ id: 'private-' + i, name: 'PRIVATE PATIENT', v: 2, s: 100, r: 1 })) } };
      DB.months[key].manual6.d1 = { nps: count * 10, reviews: count };
    }
    DB.months['2026-02'].zapis.d1 = { created: 10, total: 10 };
    clearMetricsCache();
    return { publication: buildMobilePublication('d1'),
      canonical: doctorMetricDynamics('d1', '2026-04', rr => rr.traffic.patients) };
  })()`, context);
  const { publication, canonical } = JSON.parse(JSON.stringify(result));
  validateMobilePublication(publication);
  const [april, march] = publication.periods;
  assert.equal(canonical.prev, 4);
  assert.equal(canonical.avg, 4);
  assert.equal(canonical.count, 3);
  assert.equal(april.headlineMetrics[0].history[0].delta, "+50%");
  assert.equal(april.headlineMetrics[0].history[1].delta, "+50%");
  assert.match(april.headlineMetrics[0].history[1].value, /за 3 мес.: 4/);
  assert.equal(march.headlineMetrics[0].delta, "—");
  assert.match(march.headlineMetrics[0].history[0].value, /нет данных за Февраль/);
  assert.equal(march.overallDelta, null);
  assert.ok(march.vectors.every(vector => vector.delta === null));
  assert.equal(april.vectors[5].sections[0].metrics[1].history[0].delta, "+20 п.п.");
  assert.equal(april.vectors[5].sections[0].metrics[2].history[0].delta, "+2 шт.");
  assert.equal(april.headlineMetrics[2].history[0].delta, "без изменений");
  assert.doesNotMatch(JSON.stringify(publication), /private-|PRIVATE PATIENT/);

  const oldest = vm.runInContext(`(() => {
    for (const key of ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09']) {
      DB.months[key] = emptyMonth(); DB.months[key].vyrabotka.d1 = { items: [] };
    }
    clearMetricsCache();
    return buildMobilePublication('d1').periods.at(-1);
  })()`, context);
  assert.equal(oldest.id, "2026-04");
  assert.notEqual(oldest.overallDelta, null, "baseline outside the six exported periods is retained");
  assert.equal(oldest.headlineMetrics[0].delta, "+50%");
});

test("mobile appointment tree aggregates full paths without double counting and preserves nomenclature", () => {
  const context = createContext();
  loadMobilePublicationRenderer(context);
  const result = vm.runInContext(`(() => {
    const counts = (assigned, done, soldQ) => ({ assigned, done, soldQ, resultQ: done + soldQ });
    const sourceGroups = [
      { path: ['Анализы', 'Лаборатория', 'Кровь'], ...counts(4, 2, 1), items: { 'Анализ А': counts(4, 2, 1) } },
      { path: ['Анализы', 'Лаборатория', 'Моча'], ...counts(2, 1, 0), items: { 'Анализ Б': counts(2, 1, 0) } },
      { path: ['Анализы', 'Лаборатория'], ...counts(1, 0, 2), items: { 'Прямая позиция': counts(1, 0, 2) } },
      { path: ['Другая клиника', 'Лаборатория'], ...counts(3, 0, 0), items: { 'Анализ А': counts(3, 0, 0) } },
      { path: ['Товары'], ...counts(0, 0, 4), items: { 'Товар': counts(0, 0, 4) } },
    ];
    const totals = counts(10, 3, 7);
    return { tree: mobilePublicationAppointmentTree({ sourceGroups, totals }),
      fallback: mobilePublicationAppointmentTree({ byType: { 'Товары': sourceGroups[4] }, totals }) };
  })()`, context);
  const { tree, fallback } = JSON.parse(JSON.stringify(result));
  assert.equal(tree[0].label, "Анализы");
  assert.deepEqual(tree[0].values.slice(0, 3), ["7", "3", "3"]);
  assert.equal(tree[0].children[0].children.length, 3);
  assert.equal(tree[0].children[0].children[0].children[0].label, "Анализ А");
  assert.equal(tree[0].children[0].children[2].values[3], "200%");
  assert.equal(tree[1].children[0].values[0], "3");
  assert.equal(tree[2].values[3], "—");
  assert.deepEqual(tree.at(-1).values, ["10", "3", "7", "100%"]);
  assert.equal(fallback[0].children[0].label, "Товар");
});

test("mobile charts use canonical numeric metrics, preserve missing months and omit patient data", () => {
  const context = createContext();
  loadMobilePublicationRenderer(context);
  const result = vm.runInContext(`(() => {
    DB.doctors = { d1: { name: 'Тестов Врач', aliases: [], dept: 'По умолчанию' } };
    DB.months = Object.fromEntries(['2026-01', '2026-02', '2026-03', '2026-04'].map(key => [key, emptyMonth()]));
    for (const key of ['2026-01', '2026-03', '2026-04']) {
      DB.months[key].vyrabotka.d1 = { items: [
        { form: '', cat: 'Приемы', n: 'Прием врача', q: 2, sOwn: 12345.67, sRef: 0 },
        { form: '', cat: 'Анализы', n: 'Анализ крови', q: 3, sOwn: 0, sRef: 4321.98 },
      ] };
      DB.months[key].kb.d1 = { '1': { clients: [{ id: 'private-id', name: 'PRIVATE PATIENT', v: 2, s: 12345.67, r: 1 }] },
        '12': { clients: [{ id: 'private-id', name: 'PRIVATE PATIENT', v: 2, s: 12345.67, r: 1 }] } };
      DB.months[key].naznach.d1 = { '1': { items: [
        { n: 'Анализ крови', group: 'Анализы', groupPath: ['Анализы', 'Кровь'], a: 3, d: 2, sq: 0, ss: 0 }
      ] } };
    }
    clearMetricsCache();
    const publication = buildMobilePublication('d1');
    const dynamics = computeDoctorDynamics('d1', '2026-03');
    const charts = mobilePublicationHistoryCharts('d1', '2026-03', dynamics);
    return { publication, charts, expected: dynamics.rows.find(row => row.key === 'sales').values,
      own: vyrabotkaSummary('d1', '2026-03').ownSum, ref: vyrabotkaSummary('d1', '2026-03').refIncludedSum };
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  validateMobilePublication(plain.publication);
  const money = plain.charts.find(chart => chart.id === "money");
  assert.deepEqual(money.series[0].values, plain.expected);
  assert.equal(money.series[0].values[1], null);
  assert.equal(money.labels.length, 3);
  assert.equal(money.series[0].values[2], 12345.67);
  const mirror = plain.charts.find(chart => chart.type === "mirror");
  assert.equal(mirror.series.filter(series => series.side === "own").reduce((sum, series) => sum + series.values[2], 0), plain.own);
  assert.equal(mirror.series.find(series => series.side === "ref").values[2], plain.ref);
  assert.equal(mirror.labels.length, 3);
  assert.ok(plain.publication.periods[0].vectors[1].sections[1].tree.length);
  assert.doesNotMatch(JSON.stringify(plain.publication), /private-id|PRIVATE PATIENT|"(?:patientId|patientName|clientRows|clients)"/);
});

test("client-base groups use B-F thresholds and may overlap", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = { d1: { name: 'Тестов Врач', aliases: [], dept: 'По умолчанию' } };
    DB.months = { '2026-01': emptyMonth() };
    DB.months['2026-01'].kb.d1 = { '12': { clients: [
      { name: 'Лояльный Активный', s: 100, v: 5, r: 30 },
      { name: 'Новый Риск', s: 200, v: 2, r: 200 },
      { name: 'Лояльный Спящий', s: 300, v: 5, r: 300 },
      { name: 'Потерянный', s: 400, v: 1, r: 400 },
      { name: 'Без Давности', s: 500, v: 2, r: null }
    ] } };
    clearMetricsCache();
    const kb = kbSummary('d1', '2026-01', 12);
    return { seg: kb.seg, activeBase: kb.activeBase, loyalCount: kb.loyalCount, revenueAtRisk: kb.revenueAtRisk, rows: kb.clientRows, lostPct: kb.lostPct, sourceWindowComplete: kb.sourceWindowComplete, groupAvailable: kb.groupAvailable };
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  assert.deepEqual(
    { loyal: plain.seg.loyal, active: plain.seg.active, newRisk: plain.seg.newRisk, loyalSleep: plain.seg.loyalSleep, lost: plain.seg.lost, unknown: plain.seg.unknown },
    { loyal: 2, active: 1, newRisk: 2, loyalSleep: 1, lost: 1, unknown: 1 },
  );
  assert.equal(plain.activeBase, 1);
  assert.equal(plain.loyalCount, 2);
  assert.equal(plain.revenueAtRisk, 900);
  assert.equal(plain.sourceWindowComplete, true);
  assert.equal(plain.lostPct, 20);
  assert.deepEqual(plain.rows[0].groups, ["loyal", "active"]);
  assert.deepEqual(plain.rows[3].groups, ["newRisk", "lost"]);
});

test("every client-base group uses its own visit and duration thresholds", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = { d1: { name: 'Тестов Врач', aliases: [], dept: 'По умолчанию' } };
    const p = DB.settings.depts['По умолчанию'];
    Object.assign(p, {
      loyalVisits: 6, loyalM: 12,
      activeVisits: 4, activeM: 2,
      newRiskVisits: 2, newRiskM: 6,
      sleepVisits: 4, sleepM: 6,
      lostVisits: 1, lostM: 12
    });
    DB.months = { '2026-01': emptyMonth() };
    DB.months['2026-01'].kb.d1 = { '12': { clients: [
      { name: 'Активный', s: 100, v: 5, r: 30 },
      { name: 'Спящий', s: 200, v: 5, r: 300 },
      { name: 'Риск', s: 300, v: 2, r: 400 },
      { name: 'Потерянный', s: 400, v: 1, r: 400 }
    ] } };
    const kb = kbSummary('d1', '2026-01', 12);
    return { seg: kb.seg, rows: kb.clientRows.map(row => ({ name: row.name, groups: row.groups })) };
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  assert.deepEqual(
    { loyal: plain.seg.loyal, active: plain.seg.active, newRisk: plain.seg.newRisk, loyalSleep: plain.seg.loyalSleep, lost: plain.seg.lost },
    { loyal: 0, active: 1, newRisk: 2, loyalSleep: 1, lost: 1 },
  );
  assert.deepEqual(plain.rows[1].groups, ["loyalSleep"]);
  assert.deepEqual(plain.rows[2].groups, ["newRisk"]);
  assert.deepEqual(plain.rows[3].groups, ["newRisk", "lost"]);
});

test("doctor visit coefficients use visits per unique patient for one and twelve months", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = { d1: { name: 'Тестов Врач', aliases: [], dept: 'По умолчанию' } };
    DB.months = { '2026-01': emptyMonth() };
    DB.months['2026-01'].kb.d1 = {
      '1': { clients: [
        { name: 'Пациент Один', s: 100, v: 2, r: 10 },
        { name: 'Пациент Два', s: 200, v: 1, r: 20 }
      ] },
      '12': { clients: [
        { name: 'Пациент Один', s: 600, v: 6, r: 10 },
        { name: 'Пациент Два', s: 200, v: 2, r: 20 }
      ] }
    };
    clearMetricsCache();
    const metrics = computeMetrics('d1', '2026-01');
    return {
      monthly: metrics.traffic.freq,
      annual: metrics.loyalty.freq12,
      monthlyVisits: metrics.traffic.visits,
      monthlyPatients: metrics.traffic.patients
    };
  })()`, context);
  assert.equal(result.monthlyVisits, 3);
  assert.equal(result.monthlyPatients, 2);
  assert.equal(result.monthly, 1.5);
  assert.equal(result.annual, 4);
});

test("client-base period stays manual and exposes availability per group", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    const profile = { loyalVisits: 3, loyalM: 18, activeVisits: 3, activeM: 6, newRiskVisits: 2, newRiskM: 18, sleepVisits: 3, sleepM: 18, lostVisits: 2, lostM: 30 };
    return {
      required: clientBaseRequiredWindow(profile),
      twelveIsEnough: clientBaseWindowSufficient(12, profile),
      thirtySixIsEnough: clientBaseWindowSufficient(36, profile),
      twelveGroups: clientBaseGroupAvailability(12, profile),
      twentyFourGroups: clientBaseGroupAvailability(24, profile),
      selectedByDefault: recommendedClientBaseWindow([12, 24, 36], profile),
      selectedManually: recommendedClientBaseWindow([12, 24, 36], profile, 24),
    };
  })()`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    required: 30,
    twelveIsEnough: false,
    thirtySixIsEnough: true,
    twelveGroups: { loyal: false, active: true, newRisk: false, loyalSleep: false, lost: false },
    twentyFourGroups: { loyal: true, active: true, newRisk: true, loyalSleep: true, lost: false },
    selectedByDefault: 12,
    selectedManually: 24,
  });
});

test("long-threshold groups are absent at 12 months and available at 36 months", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = { d1: { name: 'Тестов Врач', aliases: [], dept: 'По умолчанию' } };
    const profile = DB.settings.depts['По умолчанию'];
    profile.newRiskM = 18;
    profile.sleepM = 18;
    profile.lostM = 18;
    profile.riskM = 18;
    DB.months = { '2026-01': emptyMonth() };
    DB.months['2026-01'].vyrabotka.d1 = { items: [] };
    const patient = { name: 'Потерянный Пациент', patientId: 'P-1', s: 1000, v: 2, r: 600 };
    DB.months['2026-01'].kb.d1 = { '12': { clients: [patient] } };
    clearMetricsCache();
    const shortDoctor = computeMetrics('d1', '2026-01');
    const shortAggregate = aggregateDeptMonth('2026-01', 'all');

    DB.months['2026-01'].kb.d1['36'] = { clients: [patient] };
    clearMetricsCache();
    const bothDoctor = computeMetrics('d1', '2026-01');
    return {
      short: {
        doctorWindow: shortDoctor.akb.primaryWin,
        lostAvailable: shortDoctor.akb.primary.groupAvailable.lost,
        lostCount: shortDoctor.akb.primary.seg.lost,
        aggregateLostAvailable: shortAggregate.akb.primary.groupAvailable.lost,
      },
      both: {
        primaryWindow: bothDoctor.akb.primaryWin,
        shortLostAvailable: bothDoctor.akb.wins[12].groupAvailable.lost,
        longLostAvailable: bothDoctor.akb.wins[36].groupAvailable.lost,
        shortLost: bothDoctor.akb.wins[12].seg.lost,
        longLost: bothDoctor.akb.wins[36].seg.lost,
      },
    };
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  assert.deepEqual(plain.short, {
    doctorWindow: 12,
    lostAvailable: false,
    lostCount: null,
    aggregateLostAvailable: false,
  });
  assert.deepEqual(plain.both, {
    primaryWindow: 12,
    shortLostAvailable: false,
    longLostAvailable: true,
    shortLost: null,
    longLost: 1,
  });
});

test("schedule durations preserve minutes after grouped thousands and Excel time values", () => {
  const context = createContext();
  const result = vm.runInContext(`[parseHoursMin('2 345:17'), parseHoursMin('2\\u00a0345:17'),
    parseHoursMin('2\\u202f345:17'), parseHoursMin('123:45:00'), parseHoursMin(0.5),
    parseHoursMin('1,5'), parseHoursMin(null)]`, context);
  assert.deepEqual(Array.from(result), [140717, 140717, 140717, 7425, 720, 90, null]);
});

test("schedule parser reads actual patient time under the grouped header in both layouts", () => {
  const context = createContext();
  for (const graphColumn of [4, 5]) {
    const rows = [
      ['Параметры:', null, 'Период: 01.08.2025 - 31.08.2025'],
      ['Сотрудник', null, null, 'Специализация', null, null, 'Время работы с пациентом', null, null,
        'Загруженность по данным выработки', null, 'Загруженность по журналу записи'],
      [null, null, null, null, null, null, 'Норма', 'Факт', 'Факт. время услуг к норме, %',
        'Нормативная загруженность по выработке, %', 'Фактическая загруженность по выработке, %',
        'Занято заявками', 'Занятость расписания, %', 'Занято заявками, вкл. не выполненные',
        'Занятость расписания, вкл. не выполненные, %'],
      ['Тестов Врач', null, null, 'Терапия', null, null, '75:30', '4:15', null, null, null, '60:00', 60, '65:00', 65],
      ['Примеров Врач', null, null, '', null, null, '2 345:17', null, null, null, null, '50:00', 50, '55:00', 55],
      ['Итого', null, null, '', null, null, '2 420:47', '4:15'],
    ];
    rows[1][graphColumn] = 'Продолжительность по графику';
    rows[3][graphColumn] = '100:00';
    rows[4][graphColumn] = '100:00';
    context.scheduleRows = rows;
    const result = vm.runInContext(`(() => {
      const parsed = parseProstoy(scheduleRows);
      DB.doctors = { d1: { name: 'Тестов Врач', aliases: [], dept: 'По умолчанию' } };
      DB.months = { '2025-08': emptyMonth() };
      DB.months['2025-08'].prostoy.d1 = parsed.perDoc[0];
      clearMetricsCache();
      return { type: detectReportType(scheduleRows), month: periodMonthKey(extractHeaderInfo(scheduleRows).period),
        records: parsed.perDoc, schedule: computeMetrics('d1', '2025-08').loyalty.sched };
    })()`, context);
    assert.equal(result.type, 'prostoy');
    assert.equal(result.month, '2025-08');
    assert.equal(result.records.length, 2);
    assert.equal(result.records[0].normaMin, 6000);
    assert.equal(result.records[0].factMin, 255);
    assert.equal(result.records[1].factMin, null, 'blank actual time must not become normative time');
    assert.equal(result.schedule.pct, 60);
    assert.equal(result.schedule.factPct, 4.25);
    assert.equal(result.schedule.gapMin, 3345);
    assert.equal(result.records[0].zayavkiNvMin, 3900);
    assert.equal(result.records[0].schedNvPct, 65);
    rows[2][6] = 'Факт';
    rows[2][7] = 'Норма';
    assert.equal(vm.runInContext('parseProstoy(scheduleRows).perDoc[1].factMin', context), 140717,
      'actual time follows the subheading, including grouped hours');
  }
});

test("schedule parser keeps legacy patient-time columns without norm/actual subheadings", () => {
  const context = createContext();
  const result = vm.runInContext(`parseProstoy([
    ['Сотрудник', null, null, 'Специализация', null, 'Продолжительность по графику', 'Время работы с пациентом'],
    [],
    ['Тестов Врач', null, null, 'Терапия', null, '100:00', '25:00']
  ])`, context);
  assert.equal(result.perDoc[0].normaMin, 6000);
  assert.equal(result.perDoc[0].factMin, 1500);
});

test("client-base parser preserves patient identity for operational lists", () => {
  const context = createContext();
  const result = vm.runInContext(`parseKB([
    ['№ п/п', 'Клиент', 'ID', null, 'Сумма', 'Количество посещений', null, null, 'Давность'],
    [1, 'Иванова Анна', 'P-42', null, 1500, 3, null, null, 45]
  ], { otborName: 'Тестов Врач' })`, context);
  const plain = JSON.parse(JSON.stringify(result));
  assert.equal(plain.clients[0].name, "Иванова Анна");
  assert.equal(plain.clients[0].patientId, "P-42");
});

test("doctor work parser adds 'По направлению' to own work and keeps 'Направление' as colleague work", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    const info = { otborName: 'Пан Константин Александрович' };
    const aprilRows = [
      ['Форма участия', null, null, null, null, 'Количество', 'Сумма'],
      ['Сотрудник'],
      ['Специализация', null, null, 'Номенклатура'],
      [null, null, null, null, null, 87, 472318],
      ['Пан Константин Александрович', null, null, null, null, 38, 263953],
      ['Услуги', null, null, null, null, 38, 263953],
      ['Приемы', null, null, 'Прием кардиолога', null, 23, 153200],
      ['Функциональная диагностика', null, null, 'ЭхоКГ', null, 10, 69840],
      ['Функциональная диагностика', null, null, 'Велоэргометрия', null, 2, 22000],
      ['Товар', null, null, null, null, 3, 18913],
      ['Аптека', null, null, 'Кардиологический БАД', null, 3, 18913],
      ['Направление', null, null, null, null, 38, 168365],
      ['Пан Константин Александрович', null, null, null, null, 38, 168365],
      ['Услуги', null, null, null, null, 38, 168365],
      ['Товары', null, null, 'Направление на товар', null, 5, 20000],
      ['Приемы', null, null, 'Прием гинеколога', null, 1, 0],
      ['Приемы', null, null, 'Повторный прием кардиолога', null, 9, 0],
      ['Анализы', null, null, 'Назначения сотрудника коллегам', null, 23, 148365],
      ['По направлению', null, null, null, null, 11, 40000],
      ['Пан Константин Александрович', null, null, null, null, 11, 40000],
      ['Услуги', null, null, null, null, 11, 40000],
      ['Приемы', null, null, 'Прием кардиолога по направлению', null, 11, 40000],
      ['Итого', null, null, null, null, 87, 472318]
    ];
    const april = parseVyrabotka(aprilRows, info, {});

    const juneRows = [
      ['Форма участия'],
      ['Сотрудник'],
      ['Специализация'],
      ['Номенклатура', null, null, null, null, 'Количество', 'Сумма услуги', 'Сумма товары', 'Сумма услуги прочее участие', 'Сумма товары прочее участие'],
      ['Пан Константин Александрович', null, null, null, null, 87, 453405, 18913, 0, 0],
      ['ООО Клиника', null, null, null, null, 87, 453405, 18913, 0, 0],
      [null, null, null, null, null, 38, 245040, 18913, 0, 0],
      ['Приемы', null, null, null, null, 23, 153200, 0, 0, 0],
      ['Прием кардиолога (001)', null, null, null, null, 23, 153200, 0, 0, 0],
      ['Функциональная диагностика', null, null, null, null, 12, 91840, 0, 0, 0],
      ['ЭхоКГ (002)', null, null, null, null, 10, 69840, 0, 0, 0],
      ['Велоэргометрия (003)', null, null, null, null, 2, 22000, 0, 0, 0],
      ['Аптека', null, null, null, null, 3, 0, 18913, 0, 0],
      ['Кардиологический БАД (004)', null, null, null, null, 3, 0, 18913, 0, 0],
      ['Направление', null, null, null, null, 38, 168365, 0, 0, 0],
      ['Приемы', null, null, null, null, 38, 168365, 0, 0, 0],
      ['Направление на товар (005)', null, null, null, null, 5, 20000, 0, 0, 0],
      ['Прием гинеколога (006)', null, null, null, null, 1, 0, 0, 0, 0],
      ['Повторный прием кардиолога (007)', null, null, null, null, 9, 0, 0, 0, 0],
      ['Назначения сотрудника коллегам (008)', null, null, null, null, 23, 148365, 0, 0, 0],
      ['По направлению', null, null, null, null, 11, 40000, 0, 0, 0],
      ['Приемы', null, null, null, null, 11, 40000, 0, 0, 0],
      ['Прием кардиолога по направлению (009)', null, null, null, null, 11, 40000, 0, 0, 0],
      ['Итого', null, null, null, null, 87, 453405, 18913, 0, 0]
    ];
    const juneWs = { '!rows': [
      {}, {}, {}, {}, { level: 0 }, { level: 1 }, { level: 2 }, { level: 3 }, { level: 4 },
      { level: 3 }, { level: 4 }, { level: 4 }, { level: 3 }, { level: 4 },
      { level: 2 }, { level: 3 }, { level: 4 }, { level: 4 }, { level: 4 }, { level: 4 },
      { level: 2 }, { level: 3 }, { level: 4 }, { level: 0 }
    ] };
    const june = parseVyrabotka(juneRows, info, juneWs);

    DB.doctors = { d1: { name: 'Пан Константин Александрович', aliases: [], dept: 'По умолчанию' } };
    DB.months = { '2026-06': emptyMonth() };
    DB.months['2026-06'].vyrabotka.d1 = { items: april.items };
    clearMetricsCache();
    const summary = vyrabotkaSummary('d1', '2026-06');
    DB.months['2026-06'].vyrabotka.d1 = {
      items: april.items.map(({ sourceForm, ...item }) => item)
    };
    clearMetricsCache();
    const legacySummary = vyrabotkaSummary('d1', '2026-06');
    return { april, june, summary, legacySummary };
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  for (const parsed of [plain.april, plain.june]) {
    assert.equal(parsed.checked, true);
    assert.deepEqual(parsed.items.map(item => item.form), ["", "", "", "", "", "", "", "", ""]);
    assert.deepEqual(parsed.items.map(item => item.sourceForm), [
      "Сотрудник", "Сотрудник", "Сотрудник", "Сотрудник",
      "Направление", "Направление", "Направление", "Направление", "По направлению",
    ]);
    assert.deepEqual(parsed.items.map(item => item.q), [23, 10, 2, 3, 5, 1, 9, 23, 11]);
    assert.deepEqual(parsed.items.map(item => item.sOwn), [153200, 69840, 22000, 18913, 0, 0, 0, 0, 40000]);
    assert.deepEqual(parsed.items.map(item => item.sRef), [0, 0, 0, 0, 20000, 0, 0, 148365, 0]);
  }
  for (const summary of [plain.summary, plain.legacySummary]) {
    assert.deepEqual(
      { ownSum: summary.ownSum, ownQty: summary.ownQty, refSum: summary.refSum, refQty: summary.refQty, assistSum: summary.assistSum },
      { ownSum: 303953, ownQty: 49, refSum: 168365, refQty: 38, assistSum: 0 },
    );
    assert.equal(summary.byGroup["Гинекологические процедуры"], undefined);
    assert.equal(summary.byGroup["Приемы"].q, 34);
  }
});

test("legacy doctor work recalculates 'По направлению' as own revenue", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = { d1: { name: 'Тестов Врач', aliases: [], dept: 'По умолчанию' } };
    DB.months = { '2026-06': emptyMonth() };
    DB.months['2026-06'].vyrabotka.d1 = { items: [
      { form: '', cat: 'Диагностика', n: 'Собственная услуга', q: 1, sOwn: 100, sRef: 0 },
      { form: '', cat: 'Диагностика', n: 'Направленная услуга 1', q: 1, sOwn: 0, sRef: 70 },
      { form: '', cat: 'Диагностика', n: 'Направленная услуга 2', q: 1, sOwn: 0, sRef: 30 },
      { form: 'По направлению', cat: 'Кардиология приемы', n: 'Консультация', q: 4, sOwn: 0, sRef: 0 },
      { form: 'По направлению', cat: 'Приемы', n: 'Выполненная услуга 1', q: 3, sOwn: 0, sRef: 400 },
      { form: 'По направлению', cat: 'Приемы', n: 'Выполненная услуга 2', q: 2, sOwn: 0, sRef: 200 }
    ] };
    DB.months['2026-06'].kb.d1 = { '1': { clients: [
      { name: 'Пациент 1', s: 1, v: 1, r: 1 },
      { name: 'Пациент 2', s: 1, v: 1, r: 1 },
      { name: 'Пациент 3', s: 1, v: 1, r: 1 },
      { name: 'Пациент 4', s: 1, v: 1, r: 1 },
      { name: 'Пациент 5', s: 1, v: 1, r: 1 },
      { name: 'Пациент 6', s: 1, v: 1, r: 1 },
      { name: 'Пациент 7', s: 1, v: 1, r: 1 },
      { name: 'Пациент 8', s: 1, v: 1, r: 1 },
      { name: 'Пациент 9', s: 1, v: 1, r: 1 },
      { name: 'Пациент 10', s: 1, v: 1, r: 1 }
    ] } };
    clearMetricsCache();
    const metrics = computeMetrics('d1', '2026-06');
    return {
      ownSum: metrics.econ.sales,
      ownQty: metrics.extras.vy.ownQty,
      refSum: metrics.econ.refRevenue,
      refQty: metrics.extras.vy.refQty,
      avgClient: metrics.econ.avgClient,
      assistSum: metrics.econ.assistSum
    };
  })()`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ownSum: 700,
    ownQty: 10,
    refSum: 100,
    refQty: 2,
    avgClient: 70,
    assistSum: 0,
  });
});

test("appointments parser supports flat and deeply grouped 1C reports", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    const header = [
      ['Направивший врач', null, null, null, null, null, null, null, 'Количество назначено', 'Количество выполнено', 'Продажи', null],
      ['Номенклатура/Специализация', null, null, null, null, null, null, null, null, null, 'Количество', 'Сумма'],
      ['Документ', null, null, 'Клиент', null, 'Направивший врач', 'Врач - исполнитель', 'Номенклатура']
    ];
    const info = { otborName: 'Пан Константин Александрович' };
    const flatRows = header.concat([
      ['Пан Константин Александрович', null, null, null, null, null, null, null, 3, 1, 2, 1500],
      ['Анализ крови', null, null, null, null, null, null, null, 2, 1, 1, 1000],
      ['Прием 1', null, null, 'Пациент 1', null, 'Пан Константин Александрович', null, 'Анализ крови', 2, 1, 1, 1000],
      ['УЗИ сердца', null, null, null, null, null, null, null, 1, 0, 1, 500],
      ['Прием 2', null, null, 'Пациент 2', null, 'Пан Константин Александрович', null, 'УЗИ сердца', 1, 0, 1, 500],
      ['Итого', null, null, null, null, null, null, null, 3, 1, 2, 1500]
    ]);
    const flatWs = { '!rows': [null, null, null, {}, { level: 1 }, { level: 2 }, { level: 1 }, { level: 2 }] };

    const groupedRows = header.concat([
      ['Пан Константин Александрович', null, null, null, null, null, null, null, 3, 1, 2, 1500],
      ['Клиника', null, null, null, null, null, null, null, 3, 1, 2, 1500],
      ['Диагностика', null, null, null, null, null, null, null, 3, 1, 2, 1500],
      ['Лаборатория', null, null, null, null, null, null, null, 2, 1, 1, 1000],
      ['Анализ крови', null, null, null, null, null, null, null, 2, 1, 1, 1000],
      ['Прием 1', null, null, 'Пациент 1', null, 'Пан Константин Александрович', null, 'Анализ крови', 2, 1, 1, 1000],
      ['Инструментальная диагностика', null, null, null, null, null, null, null, 1, 0, 1, 500],
      ['Прием 2', null, null, 'Пациент 2', null, 'Пан Константин Александрович', null, 'УЗИ сердца', 1, 0, 1, 500],
      ['Итого', null, null, null, null, null, null, null, 3, 1, 2, 1500]
    ]);
    const groupedWs = { '!rows': [null, null, null, {}, { level: 1 }, { level: 2 }, { level: 3 }, { level: 4 }, { level: 5 }, { level: 3 }, { level: 4 }] };

    const flat = parseNaznacheniya(flatRows, info, flatWs);
    const grouped = parseNaznacheniya(groupedRows, info, groupedWs);
    DB.doctors = { d1: { name: 'Пан Константин Александрович', aliases: [], dept: 'По умолчанию' } };
    DB.months = { '2026-01': emptyMonth() };
    DB.months['2026-01'].naznach.d1 = { '1': { items: grouped.items.concat([
      { n: 'Номенклатура без группы', a: 1, d: 0, sq: 0, ss: 0, goods: false, groupPath: [] }
    ]) } };
    const summary = naznachSummary('d1', '2026-01', 1);
    return { flat, grouped, sourceGroups: summary.sourceGroups };
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  const withoutGroupPath = items => items.map(({ groupPath, ...item }) => item);
  assert.deepEqual(withoutGroupPath(plain.flat.items), withoutGroupPath(plain.grouped.items));
  assert.deepEqual(plain.grouped.items.map(item => item.n), ["Анализ крови", "УЗИ сердца"]);
  assert.deepEqual(plain.flat.items.map(item => item.groupPath), [[], []]);
  assert.deepEqual(plain.grouped.items.map(item => item.groupPath), [
    ["Клиника", "Диагностика", "Лаборатория"],
    ["Клиника", "Диагностика", "Инструментальная диагностика"],
  ]);
  assert.deepEqual(plain.sourceGroups.map(group => group.path), [
    ...plain.grouped.items.map(item => item.groupPath),
    ["Без вида услуги / специализации в исходном отчёте"],
  ]);
  assert.deepEqual(plain.sourceGroups.map(group => Object.keys(group.items)), [
    ["Анализ крови"], ["УЗИ сердца"], ["Номенклатура без группы"],
  ]);
  assert.equal(plain.sourceGroups.reduce((sum, group) => sum + group.assigned, 0), 4);
  assert.equal(plain.flat.checked, true);
  assert.equal(plain.grouped.checked, true);
});

test("appointments parser marks nomenclature inside the 1C goods group", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    const rows = [
      ['Направивший врач', null, null, null, null, null, null, null, 'Количество назначено', 'Количество выполнено', 'Продажи', null],
      ['Номенклатура/Специализация', null, null, null, null, null, null, null, null, null, 'Количество', 'Сумма'],
      ['Документ', null, null, 'Клиент', null, 'Направивший врач', 'Врач - исполнитель', 'Номенклатура'],
      ['Пан Константин Александрович', null, null, null, null, null, null, null, 3, 2, 1, 500],
      ['Товары (00000000334)', null, null, null, null, null, null, null, 3, 2, 1, 500],
      ['Аптека МДЛП', null, null, null, null, null, null, null, 3, 2, 1, 500],
      ['Кардиологический БАД', null, null, null, null, null, null, null, 3, 2, 1, 500],
      ['Оказание услуг 1', null, null, 'Пациент', null, 'Пан Константин Александрович', null, 'Кардиологический БАД', 3, 2, 1, 500],
      ['Итого', null, null, null, null, null, null, null, 3, 2, 1, 500]
    ];
    const ws = { '!rows': [null, null, null, {}, { level: 1 }, { level: 2 }, { level: 3 }, { level: 4 }] };
    return parseNaznacheniya(rows, { otborName: 'Пан Константин Александрович' }, ws);
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  assert.equal(plain.checked, true);
  assert.equal(plain.items.length, 1);
  assert.equal(plain.items[0].goods, true);
  assert.equal(plain.items[0].d, 2);
});

test("flat 1C appointments group product nomenclature by code and keep completed services", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    const rows = [
      ['Направивший врач', null, null, null, null, null, null, null, 'Количество назначено', 'Количество выполнено', 'Продажи', null],
      ['Номенклатура/Специализация', null, null, null, null, null, null, null, null, null, 'Количество', 'Сумма'],
      ['Документ', null, null, 'Клиент', null, 'Направивший врач', 'Врач - исполнитель', 'Номенклатура'],
      ['Бузина Екатерина Олеговна', null, null, null, null, null, null, null, 12, 1, 4, 400],
      ['Омега БАД (СЛ000000001)', null, null, null, null, null, null, null, 3, 0, 2, 200],
      ['Оказание услуг 1', null, null, 'Пациент 1', null, 'Бузина Екатерина Олеговна', null, 'Омега БАД (СЛ000000001)', 3, 0, 2, 200],
      ['УЗИ услуга (СЛ000000002)', null, null, null, null, null, null, null, 2, 1, 1, 100],
      ['Оказание услуг 2', null, null, 'Пациент 2', null, 'Бузина Екатерина Олеговна', null, 'УЗИ услуга (СЛ000000002)', 2, 1, 1, 100],
      ['Препарат старой серии (О04)', null, null, null, null, null, null, null, 3, 0, 1, 100],
      ['Оказание услуг 3', null, null, 'Пациент 3', null, 'Бузина Екатерина Олеговна', null, 'Препарат старой серии (О04)', 3, 0, 1, 100],
      ['Онлайн консультация врача (СЛ000000003)', null, null, null, null, null, null, null, 2, 0, 0, 0],
      ['Оказание услуг 4', null, null, 'Пациент 4', null, 'Бузина Екатерина Олеговна', null, 'Онлайн консультация врача (СЛ000000003)', 2, 0, 0, 0],
      ['Раствор для приема внутрь (СЛ000000004)', null, null, null, null, null, null, null, 1, 0, 0, 0],
      ['Оказание услуг 5', null, null, 'Пациент 5', null, 'Бузина Екатерина Олеговна', null, 'Раствор для приема внутрь (СЛ000000004)', 1, 0, 0, 0],
      ['Смузи Teo Green (СЛ000000005)', null, null, null, null, null, null, null, 1, 0, 0, 0],
      ['Оказание услуг 6', null, null, 'Пациент 6', null, 'Бузина Екатерина Олеговна', null, 'Смузи Teo Green (СЛ000000005)', 1, 0, 0, 0],
      ['Итого', null, null, null, null, null, null, null, 12, 1, 4, 400]
    ];
    const ws = { '!rows': [null, null, null, {}, { level: 1 }, { level: 2 }, { level: 1 }, { level: 2 }, { level: 1 }, { level: 2 }, { level: 1 }, { level: 2 }, { level: 1 }, { level: 2 }, { level: 1 }, { level: 2 }] };
    const parsed = parseNaznacheniya(rows, { otborName: 'Бузина Екатерина Олеговна' }, ws);
    DB.doctors = { d1: { name: 'Бузина Екатерина Олеговна', aliases: [], dept: 'По умолчанию' } };
    DB.months = { '2026-01': emptyMonth() };
    DB.months['2026-01'].naznach.d1 = { '1': { items: parsed.items.map(item => ({ ...item, goods: false })) } };
    const summary = naznachSummary('d1', '2026-01', 1);
    return {
      parsed,
      summary,
      directChecks: {
        massageService: isNaznachGoodsNomenclature('Массаж антицеллюлитный 60 минут (СЛ000005234)', 0),
        ultrasoundService: isNaznachGoodsNomenclature('Ультразвуковое исследование органов малого таза (СЛ000010614)', 0),
        smoothieProduct: isNaznachGoodsNomenclature('Смузи Teo Green (СЛ000000005)', 0)
      }
    };
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  assert.equal(plain.parsed.checked, true);
  assert.deepEqual(plain.parsed.items.map(item => item.goods), [true, false, true, false, true, true]);
  assert.deepEqual(plain.directChecks, { massageService: false, ultrasoundService: false, smoothieProduct: true });
  assert.deepEqual(
    { assigned: plain.summary.totals.assigned, done: plain.summary.totals.done, soldQ: plain.summary.totals.soldQ, resultQ: plain.summary.totals.resultQ },
    { assigned: 12, done: 1, soldQ: 4, resultQ: 5 },
  );
  assert.deepEqual(
    { assigned: plain.summary.byType["Товары"].assigned, done: plain.summary.byType["Товары"].done, soldQ: plain.summary.byType["Товары"].soldQ, resultQ: plain.summary.byType["Товары"].resultQ },
    { assigned: 8, done: 0, soldQ: 3, resultQ: 3 },
  );
});

test("score coverage requires exact windows and blocks incomplete ranking", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = { d1: { name: 'Бузина Врач', aliases: [] } };
    const specialization = DB.settings.depts['Эндокринология'];
    for (const key of Object.keys(specialization.scoring.enabled)) specialization.scoring.enabled[key] = key === 'v4';
    specialization.scoring.weights.v4 = 100;
    const own = doctorMetricSettingsFromProfile(profileForDoctor('d1'));
    for (const key of Object.keys(own.scoring.benchmarks)) own.scoring.benchmarks[key] = '';
    own.scoring.benchmarks.akbShare = 10;
    own.scoring.benchmarks.riskShare = 50;
    own.scoring.benchmarks.churn = 50;
    DB.doctors.d1.metricSettings = own;
    DB.months = { '2026-01': emptyMonth() };
    const clients = [{ name: 'Пациент', s: 100, v: 3, r: 20 }];
    DB.months['2026-01'].kb.d1 = { '12': { clients } };
    clearMetricsCache();
    const incomplete = computeMetrics('d1', '2026-01');
    DB.months['2026-01'].kb.d1['36'] = { clients };
    clearMetricsCache();
    const complete = computeMetrics('d1', '2026-01');
    return {
      incomplete: { coverage: incomplete.scores.coveragePct, eligible: incomplete.scores.rankEligible, churn: incomplete.akb.churn36 },
      complete: { coverage: complete.scores.coveragePct, eligible: complete.scores.rankEligible, churn: complete.akb.churn36 }
    };
  })()`, context);
  assert.equal(result.incomplete.coverage, 66.7);
  assert.equal(result.incomplete.eligible, false);
  assert.equal(result.incomplete.churn, null);
  assert.equal(result.complete.coverage, 100);
  assert.equal(result.complete.eligible, true);
  assert.equal(result.complete.churn, 0);
});

test("course treatment uses an exact window and own 1C records are a visit percentage", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = { d1: { name: 'Тестов Врач', aliases: [], dept: 'По умолчанию' } };
    DB.months = { '2026-01': emptyMonth() };
    DB.months['2026-01'].kb.d1 = { '1': { clients: [{ name: 'Пациент', s: 100, v: 10, r: 1 }] }, '12': { clients: [{ name: 'Пациент', s: 100, v: 10, r: 1 }] } };
    DB.months['2026-01'].prostoy.d1 = { normaMin: 600, zayavkiMin: 480, factMin: 420 };
    DB.months['2026-01'].zapis.d1 = { zapis: 2 };
    clearMetricsCache();
    const withoutExact = computeMetrics('d1', '2026-01');
    DB.months['2026-01'].kb.d1['6'] = { clients: [{ name: 'Пациент', s: 100, v: 10, r: 1 }] };
    clearMetricsCache();
    const withExact = computeMetrics('d1', '2026-01');
    return {
      withoutCourse: withoutExact.loyalty.courseIdx,
      withCourse: withExact.loyalty.courseIdx,
      scheduled: withExact.loyalty.sched.pct,
      actual: withExact.loyalty.sched.factPct,
      ownPer100: withExact.loyalty.ownRec.pct
    };
  })()`, context);
  assert.equal(result.withoutCourse, null);
  assert.equal(result.withCourse, 100);
  assert.equal(result.scheduled, 80);
  assert.equal(result.actual, 70);
  assert.equal(result.ownPer100, 20);
});

test("doctor missing from an imported 1C records report is counted as zero", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = { d1: { name: 'Нет в отчёте', aliases: [], dept: 'По умолчанию' } };
    DB.months = { '2026-01': emptyMonth() };
    const month = DB.months['2026-01'];
    month.kb.d1 = { '1': { clients: [{ name: 'Пациент', s: 100, v: 10, r: 1 }] } };
    setMonthReportImported(month, 'zapis', true);
    clearMetricsCache();
    const imported = computeMetrics('d1', '2026-01');
    setMonthReportImported(month, 'zapis', false);
    month.zapis.d2 = { zapis: 4 };
    clearMetricsCache();
    const legacyImported = computeMetrics('d1', '2026-01');
    delete month.zapis.d2;
    clearMetricsCache();
    const notImported = computeMetrics('d1', '2026-01');
    return {
      importedCount: imported.loyalty.ownRec.count,
      importedPct: imported.loyalty.ownRec.pct,
      importedMissing: imported.missing.includes('запись в 1С'),
      legacyImportedCount: legacyImported.loyalty.ownRec.count,
      notImportedOwnRec: notImported.loyalty.ownRec,
      notImportedMissing: notImported.missing.includes('запись в 1С')
    };
  })()`, context);
  assert.equal(result.importedCount, 0);
  assert.equal(result.importedPct, 0);
  assert.equal(result.importedMissing, false);
  assert.equal(result.legacyImportedCount, 0);
  assert.equal(result.notImportedOwnRec, null);
  assert.equal(result.notImportedMissing, true);
});

test("reputation rating uses SberHealth and ignores legacy Yandex Maps values", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = { d1: { name: 'Test Doctor', aliases: [] } };
    DB.months = { '2026-01': emptyMonth() };
    DB.months['2026-01'].manual6.d1 = { prodoctorov: 4, sberhealth: 5, yandex: 1 };
    clearMetricsCache();
    const withSberHealth = computeMetrics('d1', '2026-01').rep.avgRating;
    DB.months['2026-01'].manual6.d1 = { yandex: 1 };
    clearMetricsCache();
    const legacyYandexOnly = computeMetrics('d1', '2026-01').rep.avgRating;
    return { withSberHealth, legacyYandexOnly };
  })()`, context);
  assert.equal(result.withSberHealth, 4.5);
  assert.equal(result.legacyYandexOnly, null);
});

test("interdisciplinary focuses expose assigned and completed counts without changing vector 3 scoring", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = { d1: { name: 'Focus Doctor', aliases: [], dept: 'По умолчанию' } };
    const profile = DB.settings.depts['По умолчанию'];
    profile.crossFocus = {
      title: 'Focus referrals',
      items: [
        { name: 'Focus A', syn: ['focus a'], core: true },
        { name: 'Focus B', syn: ['focus b'], core: true }
      ],
      rules: []
    };
    profile.scoring.benchmarks.crossShare = 10;
    profile.scoring.benchmarks.nazConv = 50;
    DB.months = { '2026-01': emptyMonth() };
    DB.months['2026-01'].vyrabotka.d1 = { items: [
      { form: '', cat: 'Приемы', n: 'Own and referral revenue', q: 1, sOwn: 100, sRef: 100, goods: false }
    ] };
    DB.months['2026-01'].naznach.d1 = { '1': { items: [
      { n: 'Focus A service', a: 2, d: 1, sq: 1, ss: 100 },
      { n: 'Other service', a: 2, d: 0, sq: 1, ss: 100 }
    ] } };
    clearMetricsCache();
    const withFocus = computeMetrics('d1', '2026-01');
    profile.crossFocus.items = [];
    clearMetricsCache();
    const withoutFocus = computeMetrics('d1', '2026-01');
    return {
      focus: withFocus.cross.naz[1].focus,
      scoreWithFocus: withFocus.scores.vec.v3,
      scoreWithoutFocus: withoutFocus.scores.vec.v3
    };
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  assert.equal(plain.focus.park, 2);
  assert.equal(plain.focus.used, 1);
  assert.equal(plain.focus.assigned, 2);
  assert.equal(plain.focus.soldQ, 1);
  assert.equal(plain.focus.resultQ, 2);
  assert.deepEqual(
    { assigned: plain.focus.items["Focus A"].assigned, resultQ: plain.focus.items["Focus A"].resultQ },
    { assigned: 2, resultQ: 2 },
  );
  assert.equal(plain.scoreWithFocus, 100);
  assert.equal(plain.scoreWithoutFocus, 100);
});

test("interdisciplinary home departments split own and foreign services in assignments and referrals", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    const base = normalizeProfileRecord(defaultProfile(), defaultProfile());
    DB.settings.departments = { 'Косметология': [], 'Хирургия': [] };
    DB.settings.departmentProfiles = {
      'Косметология': normalizeProfileRecord(JSON.parse(JSON.stringify(base)), base),
      'Хирургия': normalizeProfileRecord(JSON.parse(JSON.stringify(base)), base)
    };
    DB.settings.departmentUsesSpecializations = { 'Косметология': false, 'Хирургия': false };
    DB.settings.interdisciplinaryHomeDepartments = {
      'домашняя процедура': 'Косметология',
      'домашний приём': 'Косметология',
      'чужая процедура': 'Хирургия'
    };
    DB.doctors = { d1: { name: 'Тестовый Косметолог', aliases: [], department: 'Косметология', structureManual: true } };
    const profile = DB.settings.departmentProfiles['Косметология'];
    profile.crossFocus = {
      title: 'Междисциплинарный подход',
      items: [
        { name: 'Домашняя процедура', syn: ['домашняя услуга'], core: true },
        { name: 'Домашний приём', syn: ['прием косметолога'], core: true },
        { name: 'Чужая процедура', syn: ['хирургическая услуга'], core: true }
      ],
      rules: []
    };
    profile.overrides = {
      'домашняя услуга': { group: 'Другие услуги', sub: 'Прочие' },
      'прием косметолога': { group: 'Приемы', sub: 'Консультации' },
      'хирургическая услуга': { group: 'Процедуры', sub: 'Прочее' }
    };
    DB.months = { '2026-01': emptyMonth() };
    DB.months['2026-01'].naznach.d1 = { '1': { items: [
      { n: 'Домашняя услуга', a: 2, d: 1, sq: 0, ss: 0 },
      { n: 'Прием косметолога', a: 3, d: 1, sq: 1, ss: 100 },
      { n: 'Хирургическая услуга', a: 4, d: 0, sq: 1, ss: 200 }
    ] } };
    DB.months['2026-01'].vyrabotka.d1 = { items: [
      { sourceForm: 'Направление', cat: '', n: 'Домашняя услуга', q: 1, sOwn: 100, sRef: 0, goods: false },
      { sourceForm: 'Направление', cat: '', n: 'Прием косметолога', q: 1, sOwn: 200, sRef: 0, goods: false },
      { sourceForm: 'Направление', cat: '', n: 'Хирургическая услуга', q: 1, sOwn: 300, sRef: 0, goods: false }
    ] };
    clearMetricsCache();
    return {
      assignments: naznachSummary('d1', '2026-01', 1).byType,
      referrals: vyrabotkaSummary('d1', '2026-01').refByType
    };
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  assert.equal(plain.assignments['Профильные услуги'].assigned, 2);
  assert.equal(plain.assignments['Приемы'].assigned, 3);
  assert.equal(plain.assignments['Другие услуги клиники'].assigned, 4);
  assert.equal(plain.referrals['Профильные услуги'].s, 100);
  assert.equal(plain.referrals['Приемы'].s, 200);
  assert.equal(plain.referrals['Другие услуги клиники'].s, 300);
});

test("completed referrals inherit the 1C group hierarchy from assignments by code and name", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = { d1: { name: 'Тестовый Врач', aliases: [], dept: 'По умолчанию' } };
    DB.months = { '2026-01': emptyMonth() };
    DB.months['2026-01'].naznach.d1 = { '1': { items: [
      { n: 'Лазерная процедура старое название (СЛ000001)', a: 2, d: 0, sq: 0, ss: 0, groupPath: ['Услуги', 'Косметология', 'Лазерные процедуры'] },
      { n: 'Массаж лица', a: 1, d: 0, sq: 0, ss: 0, groupPath: ['Услуги', 'Косметология', 'Массажи'] }
    ] } };
    DB.months['2026-01'].vyrabotka.d1 = { items: [
      { sourceForm: 'Направление', cat: 'Процедуры', n: 'Лазерная процедура новое название (СЛ000001)', q: 2, sOwn: 200, sRef: 0, goods: false },
      { sourceForm: 'Направление', cat: 'Процедуры', n: 'Массаж лица', q: 1, sOwn: 150, sRef: 0, goods: false },
      { sourceForm: 'Направление', cat: 'Процедуры', n: 'Услуга без назначения (СЛ999999)', q: 1, sOwn: 250, sRef: 0, goods: false }
    ] };
    clearMetricsCache();
    const metrics = computeMetrics('d1', '2026-01');
    return {
      grouping: metrics.cross.refGroupsByNaz[1],
      referralTotal: Object.values(metrics.cross.refByType).reduce((sum, item) => sum + item.s, 0)
    };
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  assert.equal(plain.grouping.matchedItems, 2);
  assert.equal(plain.grouping.unmatchedItems, 1);
  const byItem = name => plain.grouping.groups.find(group => Object.prototype.hasOwnProperty.call(group.items, name));
  assert.deepEqual(byItem('Лазерная процедура новое название (СЛ000001)').path,
    ['Услуги', 'Косметология', 'Лазерные процедуры']);
  assert.deepEqual(byItem('Массаж лица').path, ['Услуги', 'Косметология', 'Массажи']);
  assert.deepEqual(byItem('Услуга без назначения (СЛ999999)').path, ['Не сопоставлено с группами 1С']);
  assert.equal(plain.grouping.groups.reduce((sum, group) => sum + group.s, 0), plain.referralTotal);
});

test("exact nomenclature departments split performed referrals without adding services to focuses", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    const base = normalizeProfileRecord(defaultProfile(), defaultProfile());
    DB.settings.departments = { 'Косметология': [], 'Хирургия': [] };
    DB.settings.departmentProfiles = {
      'Косметология': normalizeProfileRecord(JSON.parse(JSON.stringify(base)), base),
      'Хирургия': normalizeProfileRecord(JSON.parse(JSON.stringify(base)), base)
    };
    DB.settings.departmentUsesSpecializations = { 'Косметология': false, 'Хирургия': false };
    DB.settings.interdisciplinaryHomeDepartments = {
      'своя процедура (с/0001)': 'Косметология',
      'чужая процедура (с/0002)': 'Хирургия'
    };
    DB.doctors = { d1: { name: 'Тестовый Косметолог', aliases: [], department: 'Косметология', structureManual: true } };
    const profile = DB.settings.departmentProfiles['Косметология'];
    profile.crossFocus = { title: 'Междисциплинарный подход', items: [], rules: [] };
    profile.overrides = {
      'своя процедура (с/0001)': { group: 'Другие услуги', sub: 'Прочие' },
      'чужая процедура (с/0002)': { group: 'Процедуры', sub: 'Прочее' }
    };
    DB.months = { '2026-01': emptyMonth() };
    DB.months['2026-01'].naznach.d1 = { '1': { items: [
      { n: 'Своя процедура (С/0001)', a: 2, d: 1, sq: 0, ss: 0 },
      { n: 'Чужая процедура (С/0002)', a: 3, d: 1, sq: 0, ss: 0 }
    ] } };
    DB.months['2026-01'].vyrabotka.d1 = { items: [
      { sourceForm: 'Направление', cat: '', n: 'Своя процедура (С/0001)', q: 1, sOwn: 100, sRef: 0, goods: false },
      { sourceForm: 'Направление', cat: '', n: 'Чужая процедура (С/0002)', q: 1, sOwn: 300, sRef: 0, goods: false }
    ] };
    clearMetricsCache();
    return {
      assignments: naznachSummary('d1', '2026-01', 1).byType,
      referrals: vyrabotkaSummary('d1', '2026-01').refByType
    };
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  assert.equal(plain.assignments['Профильные услуги'].assigned, 2);
  assert.equal(plain.assignments['Другие услуги клиники'].assigned, 3);
  assert.equal(plain.referrals['Профильные услуги'].s, 100);
  assert.equal(plain.referrals['Другие услуги клиники'].s, 300);
});

test("home departments split ordinary services but keep goods appointments and analyses in fixed categories", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    const base = normalizeProfileRecord(defaultProfile(), defaultProfile());
    DB.settings.departments = { 'Косметология': [], 'Хирургия': [] };
    DB.settings.departmentProfiles = {
      'Косметология': normalizeProfileRecord(JSON.parse(JSON.stringify(base)), base),
      'Хирургия': normalizeProfileRecord(JSON.parse(JSON.stringify(base)), base)
    };
    DB.settings.departmentUsesSpecializations = { 'Косметология': false, 'Хирургия': false };
    DB.settings.interdisciplinaryHomeDepartments = {
      'чужая услуга': 'Хирургия',
      'чужой товар': 'Хирургия',
      'чужой прием': 'Хирургия',
      'чужой анализ': 'Хирургия'
    };
    DB.doctors = { d1: { name: 'Тестовый Косметолог', aliases: [], department: 'Косметология', structureManual: true } };
    const profile = DB.settings.departmentProfiles['Косметология'];
    profile.crossFocus = { title: 'Междисциплинарный подход', items: [], rules: [] };
    profile.overrides = {
      'чужая услуга': { type: 'услуга', group: 'Процедуры', sub: 'Прочее' },
      'чужой товар': { type: 'товар', group: 'Товары', sub: 'Аптека и процедурка' },
      'чужой прием': { type: 'услуга', group: 'Приемы', sub: '' },
      'чужой анализ': { type: 'услуга', group: 'Анализы', sub: '' }
    };
    DB.months = { '2026-01': emptyMonth() };
    DB.months['2026-01'].naznach.d1 = { '1': { items: [
      { n: 'Чужая услуга', a: 1, d: 1, sq: 0, ss: 0 },
      { n: 'Чужой товар', a: 2, d: 0, sq: 2, ss: 200, goods: true },
      { n: 'Чужой прием', a: 3, d: 1, sq: 0, ss: 0 },
      { n: 'Чужой анализ', a: 4, d: 1, sq: 0, ss: 0 }
    ] } };
    DB.months['2026-01'].vyrabotka.d1 = { items: [
      { sourceForm: 'Направление', cat: '', n: 'Чужая услуга', q: 1, sOwn: 100, sRef: 0, goods: false },
      { sourceForm: 'Направление', cat: '', n: 'Чужой товар', q: 2, sOwn: 200, sRef: 0, goods: true },
      { sourceForm: 'Направление', cat: '', n: 'Чужой прием', q: 3, sOwn: 300, sRef: 0, goods: false },
      { sourceForm: 'Направление', cat: '', n: 'Чужой анализ', q: 4, sOwn: 400, sRef: 0, goods: false }
    ] };
    clearMetricsCache();
    return {
      assignments: naznachSummary('d1', '2026-01', 1).byType,
      referrals: vyrabotkaSummary('d1', '2026-01').refByType
    };
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  assert.equal(plain.assignments['Другие услуги клиники'].assigned, 1);
  assert.equal(plain.assignments['Товары'].assigned, 2);
  assert.equal(plain.assignments['Приемы'].assigned, 3);
  assert.equal(plain.assignments['Анализы'].assigned, 4);
  assert.equal(plain.referrals['Другие услуги клиники'].s, 100);
  assert.equal(plain.referrals['Товары'].s, 200);
  assert.equal(plain.referrals['Приемы'].s, 300);
  assert.equal(plain.referrals['Анализы'].s, 400);
});

test("configurable referral revenue policy counts fixed categories and only services outside selected departments", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = { d1: {
      name: 'Тестовый Эстетист', aliases: [], department: 'Косметология', specialization: 'Эстетисты', structureManual: true
    } };
    DB.settings.interdisciplinaryGroupDepartments = {
      [interdisciplinaryGroupKey(['Услуги', 'Косметология'])]: 'Косметология',
      [interdisciplinaryGroupKey(['Услуги', 'Физиотерапия'])]: 'Физиотерапия',
      [interdisciplinaryGroupKey(['Услуги', 'Терапия'])]: 'Терапия'
    };
    const esthetistPolicy = specializationProfile('Косметология', 'Эстетисты').referralRevenuePolicy;
    const physiotherapyPolicy = departmentProfile('Физиотерапия').referralRevenuePolicy;
    DB.months = { '2026-01': emptyMonth() };
    DB.months['2026-01'].naznach.d1 = { '1': { items: [
      { n: 'Прием врача', a: 1, d: 0, sq: 0, ss: 0, groupPath: ['Приемы'] },
      { n: 'Анализ крови', a: 1, d: 0, sq: 0, ss: 0, groupPath: ['Анализы'] },
      { n: 'Крем товар', a: 1, d: 0, sq: 0, ss: 0, goods: true, groupPath: ['Товары'] },
      { n: 'Косметологическая процедура', a: 1, d: 0, sq: 0, ss: 0, groupPath: ['Услуги', 'Косметология'] },
      { n: 'Физиотерапевтическая процедура', a: 1, d: 0, sq: 0, ss: 0, groupPath: ['Услуги', 'Физиотерапия'] },
      { n: 'Терапевтическая процедура', a: 1, d: 0, sq: 0, ss: 0, groupPath: ['Услуги', 'Терапия'] }
    ] } };
    DB.months['2026-01'].vyrabotka.d1 = { items: [
      { sourceForm: 'Направление', cat: '', n: 'Прием врача', q: 1, sOwn: 100, sRef: 0, goods: false },
      { sourceForm: 'Направление', cat: '', n: 'Анализ крови', q: 1, sOwn: 100, sRef: 0, goods: false },
      { sourceForm: 'Направление', cat: '', n: 'Крем товар', q: 1, sOwn: 100, sRef: 0, goods: true },
      { sourceForm: 'Направление', cat: '', n: 'Косметологическая процедура', q: 1, sOwn: 100, sRef: 0, goods: false },
      { sourceForm: 'Направление', cat: '', n: 'Физиотерапевтическая процедура', q: 1, sOwn: 100, sRef: 0, goods: false },
      { sourceForm: 'Направление', cat: '', n: 'Терапевтическая процедура', q: 1, sOwn: 100, sRef: 0, goods: false },
      { sourceForm: 'Направление', cat: '', n: 'Услуга без подразделения', q: 1, sOwn: 100, sRef: 0, goods: false }
    ] };
    clearMetricsCache();
    const summary = vyrabotkaSummary('d1', '2026-01');
    const metrics = computeMetrics('d1', '2026-01');
    return {
      esthetistPolicy,
      physiotherapyPolicy,
      raw: summary.refSum,
      included: summary.refIncludedSum,
      excluded: summary.refExcludedSum,
      econIncluded: metrics.econ.refRevenue,
      crossRaw: metrics.cross.refSumAll,
      crossExcluded: metrics.cross.refExcludedSum,
      therapyItem: summary.refByType['Другие услуги клиники'].items['Терапевтическая процедура'],
      ownItem: summary.refByType['Профильные услуги'].items['Косметологическая процедура']
    };
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  assert.equal(plain.esthetistPolicy.mode, 'external');
  assert.deepEqual(plain.esthetistPolicy.excludedServiceDepartments, ['Физиотерапия', 'Косметология']);
  assert.equal(plain.physiotherapyPolicy.mode, 'external');
  assert.equal(plain.raw, 700);
  assert.equal(plain.included, 400);
  assert.equal(plain.excluded, 300);
  assert.equal(plain.econIncluded, 400);
  assert.equal(plain.crossRaw, 700);
  assert.equal(plain.crossExcluded, 300);
  assert.equal(plain.therapyItem.homeDepartment, 'Терапия');
  assert.equal(plain.therapyItem.includedS, 100);
  assert.equal(plain.ownItem.homeDepartment, 'Косметология');
  assert.equal(plain.ownItem.excludedS, 100);
});

test("referral revenue policy migration seeds clinic presets once and keeps later changes", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.settings.referralRevenuePolicyV = 0;
    DB.settings.departmentProfiles['Физиотерапия'].referralRevenuePolicy = defaultReferralRevenuePolicy();
    DB.settings.depts['Эстетисты'].referralRevenuePolicy = defaultReferralRevenuePolicy();
    delete DB.settings.depts['Эстетисты'].inheritReferralRevenuePolicy;
    normalizeProfiles();
    const migrated = {
      physio: departmentProfile('Физиотерапия').referralRevenuePolicy,
      esthetists: specializationProfile('Косметология', 'Эстетисты').referralRevenuePolicy,
      version: DB.settings.referralRevenuePolicyV
    };
    DB.settings.depts['Эстетисты'].referralRevenuePolicy = Object.assign(defaultReferralRevenuePolicy(), { mode: 'custom' });
    normalizeProfiles();
    return { migrated, afterSecondNormalize: DB.settings.depts['Эстетисты'].referralRevenuePolicy.mode };
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  assert.equal(plain.migrated.version, 1);
  assert.equal(plain.migrated.physio.mode, 'external');
  assert.equal(plain.migrated.esthetists.mode, 'external');
  assert.equal(plain.afterSecondNormalize, 'custom');
});

test("appointment conversion ignores completed count for goods but keeps it for services", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = { d1: { name: 'Goods Doctor', aliases: [], dept: 'По умолчанию' } };
    const profile = DB.settings.depts['По умолчанию'];
    profile.crossFocus = {
      title: 'Focus referrals',
      items: [
        { name: 'Goods focus', syn: ['goods focus'], core: true },
        { name: 'Service focus', syn: ['service focus'], core: true }
      ],
      rules: []
    };
    DB.months = { '2026-01': emptyMonth() };
    DB.months['2026-01'].naznach.d1 = { '1': { items: [
      { n: 'Goods focus product', a: 4, d: 3, sq: 2, ss: 100, goods: true },
      { n: 'Прием Service focus', a: 4, d: 1, sq: 1, ss: 200, goods: false }
    ] } };
    return naznachSummary('d1', '2026-01', 1);
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  assert.deepEqual(
    { assigned: plain.totals.assigned, done: plain.totals.done, soldQ: plain.totals.soldQ, resultQ: plain.totals.resultQ, conv: plain.totals.conv },
    { assigned: 8, done: 1, soldQ: 3, resultQ: 4, conv: 50 },
  );
  assert.deepEqual(
    { done: plain.byType["Товары"].done, soldQ: plain.byType["Товары"].soldQ, resultQ: plain.byType["Товары"].resultQ, conv: plain.byType["Товары"].conv },
    { done: 0, soldQ: 2, resultQ: 2, conv: 50 },
  );
  assert.equal(plain.focus.resultQ, 4);
  assert.equal(plain.focus.assigned, 8);
  assert.equal(plain.focus.used, 2);
});

test("appointment conversion above 100 percent remains valid and earns the full interdisciplinary score", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = { d1: { name: 'Conversion Doctor', aliases: [], dept: 'По умолчанию' } };
    const profile = DB.settings.depts['По умолчанию'];
    profile.scoring.benchmarks.nazConv = 100;
    DB.months = { '2026-01': emptyMonth() };
    DB.months['2026-01'].naznach.d1 = { '1': { items: [
      { n: 'Service', a: 2, d: 2, sq: 1, ss: 100, goods: false, groupPath: ['Services'] }
    ] } };
    clearMetricsCache();
    const metrics = computeMetrics('d1', '2026-01');
    return {
      totals: metrics.cross.naz[1].totals,
      sourceGroup: metrics.cross.naz[1].sourceGroups[0],
      score: metrics.scores.v3ByNaz[1]
    };
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));

  assert.equal(plain.totals.valid, true);
  assert.equal(plain.totals.conv, 150);
  assert.equal(plain.sourceGroup.valid, true);
  assert.equal(plain.sourceGroup.conv, 150);
  assert.equal(plain.score, 100);
});

test("department ratios are weighted and patients are deduplicated by stable identity", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = {
      d1: { name: 'Первый Врач', aliases: [], dept: 'По умолчанию' },
      d2: { name: 'Второй Врач', aliases: [], dept: 'По умолчанию' }
    };
    DB.months = { '2026-01': emptyMonth() };
    DB.months['2026-01'].vyrabotka.d1 = { items: [] };
    DB.months['2026-01'].vyrabotka.d2 = { items: [] };
    DB.months['2026-01'].kb.d1 = { '1': { clients: [{ name: 'Общий Пациент', patientId: '42', s: 100, v: 2, r: 1 }] } };
    DB.months['2026-01'].kb.d2 = { '1': { clients: [{ name: 'Общий Пациент', patientId: '42', s: 200, v: 3, r: 1 }] } };
    DB.months['2026-01'].zapis.d1 = { zapis: 1 };
    DB.months['2026-01'].zapis.d2 = { zapis: 1 };
    clearMetricsCache();
    const agg = aggregateDeptMonth('2026-01', 'all');
    return { patients: agg.traffic.patients, visits: agg.traffic.visits, own: agg.loyalty.ownRec.pct };
  })()`, context);
  assert.equal(result.patients, 1);
  assert.equal(result.visits, 5);
  assert.equal(result.own, 40);
});

test("legacy v1 database migrates to the current schema", () => {
  const context = createContext();
  const result = vm.runInContext(`migrateDB({
    version: 1,
    doctors: { d1: { name: 'Тестов Врач', aliases: [] } },
    months: { '2026-01': { vyrabotka: {}, kb: {}, pervichka: {}, prostoy: {}, zapis: {}, manual6: {} } },
    fileLog: []
  })`, context);
  assert.equal(result.version, 4);
  assert.ok(result.months["2026-01"].naznach);
  assert.deepEqual(Object.keys(result.doctors), ["d1"]);
});

test("default settings expose the clinic departments and hide the system fallback profile", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    const before = Object.keys(DB.settings.depts);
    delete DB.settings.departments;
    normalizeProfiles();
    return { before, after: Object.keys(DB.settings.depts), groups: departmentGroups() };
  })()`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(result.before)), JSON.parse(JSON.stringify(result.after)));
  const groups = JSON.parse(JSON.stringify(result.groups));
  assert.deepEqual(Object.keys(groups), ["Хирургия", "Терапия", "Косметология", "Физиотерапия", "Гинекология", "Кардиология и Функциональная диагностика"]);
  assert.deepEqual(groups["Хирургия"], ["Маммология", "Флебология"]);
  assert.deepEqual(groups["Терапия"], ["Эндокринология", "Неврология", "Психотерапия"]);
  assert.deepEqual(groups["Косметология"], ["Косметология", "Эстетисты"]);
  assert.deepEqual(groups["Физиотерапия"], ["Специалисты по телу", "Остеопатия"]);
  assert.deepEqual(groups["Гинекология"], ["Гинекология", "Урология"]);
  assert.deepEqual(groups["Кардиология и Функциональная диагностика"], ["Кардиология", "Функциональная диагностика"]);
  assert.ok(!Object.values(groups).flat().includes("По умолчанию"));
});

test("the clinic roster is available before the first import", () => {
  const context = createContext();
  const names = vm.runInContext("Object.values(DB.doctors).map(d => d.name)", context);
  assert.deepEqual(JSON.parse(JSON.stringify(names)), [
    "Пудовкина", "Чернигова", "Гайнутдинова", "Лушникова", "Кожикина", "Римашевская",
    "Кузьменко", "Лятифова", "Бережная", "Королева", "Дубровская", "Самсонова", "Никифорова", "Перцхелия",
    "Бузина", "Гоголева", "Мановицкая", "Жуйков", "Пан Константин Александрович", "Провоторова", "Ахильгова", "Федроов", "Кузьменков",
  ]);
  const structures = vm.runInContext("Object.fromEntries(Object.entries(DB.doctors).map(([id, d]) => [d.name, doctorStructureLabel(id)]))", context);
  assert.deepEqual(JSON.parse(JSON.stringify(structures)), {
    "Пудовкина": "Косметология · Косметология", "Чернигова": "Косметология · Косметология",
    "Гайнутдинова": "Косметология · Косметология", "Лушникова": "Косметология · Косметология",
    "Кожикина": "Косметология · Эстетисты", "Римашевская": "Косметология · Эстетисты",
    "Кузьменко": "Гинекология · Гинекология", "Лятифова": "Гинекология · Гинекология", "Бережная": "Гинекология · Гинекология",
    "Королева": "Гинекология · Урология", "Дубровская": "Хирургия · Флебология",
    "Самсонова": "Хирургия · Маммология", "Никифорова": "Хирургия · Маммология", "Перцхелия": "Кардиология и Функциональная диагностика · Функциональная диагностика",
    "Бузина": "Терапия · Эндокринология", "Гоголева": "Терапия · Эндокринология",
    "Мановицкая": "Терапия · Эндокринология", "Жуйков": "Терапия · Эндокринология",
    "Пан Константин Александрович": "Кардиология и Функциональная диагностика · Кардиология",
    "Провоторова": "Кардиология и Функциональная диагностика · Кардиология",
    "Ахильгова": "Кардиология и Функциональная диагностика · Кардиология",
    "Федроов": "Терапия · Неврология", "Кузьменков": "Терапия · Психотерапия",
  });
  const headDoctorId = vm.runInContext(`DB.settings.departmentHeadDoctorIds["Кардиология и Функциональная диагностика"]`, context);
  assert.equal(vm.runInContext(`doctorName(${JSON.stringify(headDoctorId)})`, context), "Пан Константин Александрович");
});

test("full names from imports enrich roster cards instead of creating duplicates", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    const before = Object.keys(DB.doctors).length;
    const pudovkinaId = resolveDoctor('Пудовкина Юлия Геннадьевна');
    const fedorovId = resolveDoctor('Федоров Иван Сергеевич');
    return {
      before, after: Object.keys(DB.doctors).length,
      pudovkinaId, pudovkinaName: doctorName(pudovkinaId),
      fedorovId, fedorovName: doctorName(fedorovId)
    };
  })()`, context);
  assert.equal(result.before, 23);
  assert.equal(result.after, 23);
  assert.equal(result.pudovkinaName, "Пудовкина Юлия Геннадьевна");
  assert.equal(result.fedorovName, "Федоров Иван Сергеевич");
});

test("legacy flat therapy assignment becomes the therapy department", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = { d1: { name: 'Старый Врач', aliases: [], dept: 'Терапия' } };
    normalizeProfiles();
    return {
      department: DB.doctors.d1.department,
      specialization: DB.doctors.d1.specialization,
      resolvedDepartment: resolvedDepartmentName('d1'),
      resolvedSpecialization: resolvedSpecializationName('d1')
    };
  })()`, context);
  assert.equal(result.department, "Терапия");
  assert.equal(result.specialization, undefined);
  assert.equal(result.resolvedDepartment, "Терапия");
  assert.equal(result.resolvedSpecialization, null);
});

test("listed doctors are assigned to their specialization by surname", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = {
      d1: { name: 'Пудовкина Юлия Геннадьевна', aliases: [] },
      d2: { name: 'Римашевская Анна', aliases: [] },
      d3: { name: 'Королева Мария', aliases: [] },
      d4: { name: 'Дубровская Ольга', aliases: [] },
      d5: { name: 'Перцхелия Нино', aliases: [] },
      d6: { name: 'Провторова Елена', aliases: [] },
      d7: { name: 'Федоров Иван', aliases: [] },
      d8: { name: 'Кузьменков Петр', aliases: [] }
    };
    normalizeProfiles();
    return Object.fromEntries(Object.keys(DB.doctors).map(id => [id, {
      department: resolvedDepartmentName(id), specialization: resolvedSpecializationName(id)
    }]));
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  assert.deepEqual(plain.d1, { department: "Косметология", specialization: "Косметология" });
  assert.deepEqual(plain.d2, { department: "Косметология", specialization: "Эстетисты" });
  assert.deepEqual(plain.d3, { department: "Гинекология", specialization: "Урология" });
  assert.deepEqual(plain.d4, { department: "Хирургия", specialization: "Флебология" });
  assert.deepEqual(plain.d5, { department: "Кардиология и Функциональная диагностика", specialization: "Функциональная диагностика" });
  assert.deepEqual(plain.d6, { department: "Кардиология и Функциональная диагностика", specialization: "Кардиология" });
  assert.deepEqual(plain.d7, { department: "Терапия", specialization: "Неврология" });
  assert.deepEqual(plain.d8, { department: "Терапия", specialization: "Психотерапия" });
});

test("manual doctor structure overrides the surname preset", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = { d1: {
      name: 'Пудовкина Юлия', aliases: [], structureManual: true,
      department: 'Терапия', specialization: 'Эндокринология'
    } };
    return { department: resolvedDepartmentName('d1'), specialization: resolvedSpecializationName('d1') };
  })()`, context);
  assert.equal(result.department, "Терапия");
  assert.equal(result.specialization, "Эндокринология");
});

test("job-title fallback follows the new department hierarchy", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = {
      d1: { name: 'Новый Уролог', aliases: [], spec: 'врач-уролог' },
      d2: { name: 'Новый Остеопат', aliases: [], spec: 'врач-остеопат' },
      d3: { name: 'Новый Маммолог', aliases: [], spec: 'врач-маммолог' },
      d4: { name: 'Новый Кардиолог', aliases: [], spec: 'врач-кардиолог' },
      d5: { name: 'Новый Диагност', aliases: [], spec: 'врач функциональной диагностики' }
    };
    return Object.fromEntries(Object.keys(DB.doctors).map(id => [id, doctorStructureLabel(id)]));
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  assert.equal(plain.d1, "Гинекология · Урология");
  assert.equal(plain.d2, "Физиотерапия · Остеопатия");
  assert.equal(plain.d3, "Хирургия · Маммология");
  assert.equal(plain.d4, "Кардиология и Функциональная диагностика · Кардиология");
  assert.equal(plain.d5, "Кардиология и Функциональная диагностика · Функциональная диагностика");
});

test("same department and specialization names keep separate metric profiles", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.settings.departmentProfiles['Косметология'].minVisits = 8;
    DB.settings.depts['Косметология'].minVisits = 4;
    DB.settings.departmentProfiles['Косметология'].scoring.weights.v1 = 70;
    DB.settings.depts['Косметология'].scoring.weights.v1 = 25;
    DB.settings.departmentProfiles['Косметология'].scoring.benchmarks.revenue = 100;
    DB.settings.depts['Косметология'].scoring.benchmarks.revenue = 250;
    DB.doctors = { d1: { name: 'Пудовкина Юлия', aliases: [] } };
    const inheritedGoal = profileForDoctor('d1').scoring.benchmarks.revenue;
    DB.settings.depts['Косметология'].inheritGoals = false;
    return {
      effective: profileForDoctor('d1').scoring.benchmarks.revenue,
      inheritedGoal,
      effectiveMinVisits: profileForDoctor('d1').minVisits,
      effectiveWeight: profileForDoctor('d1').scoring.weights.v1,
      department: departmentProfile('Косметология').scoring.benchmarks.revenue,
      specialization: deptProfile('Косметология').scoring.benchmarks.revenue
    };
  })()`, context);
  assert.equal(result.inheritedGoal, 100);
  assert.equal(result.department, 100);
  assert.equal(result.specialization, 250);
  assert.equal(result.effective, 250);
  assert.equal(result.effectiveMinVisits, 4);
  assert.equal(result.effectiveWeight, 25);
});

test("v1.0.8 structure migrates once and preserves configured profile values", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    const cosmetology = profileCosmetology();
    cosmetology.activeM = 9;
    DB.settings = {
      showScores: true, weightsV: 4,
      departments: { 'Общее отделение': ['Косметология', 'Гинекология', 'Хирургия', 'Терапия', 'Физиотерапия'] },
      departmentProfiles: { 'Общее отделение': defaultProfile() },
      departmentUsesSpecializations: { 'Общее отделение': true },
      depts: {
        'По умолчанию': defaultProfile(), 'Косметология': cosmetology,
        'Гинекология': profileGynecology(), 'Хирургия': profileSurgery(),
        'Терапия': profileTherapy(), 'Физиотерапия': profilePhysiotherapy()
      }
    };
    DB.doctors = { d1: { name: 'Кожикина Анна', aliases: [], department: 'Общее отделение', specialization: 'Косметология' } };
    normalizeProfiles();
    return {
      version: DB.settings.structureV,
      departments: Object.keys(departmentGroups()),
      inheritedActiveM: DB.settings.depts['Эстетисты'].activeM,
      doctor: { department: resolvedDepartmentName('d1'), specialization: resolvedSpecializationName('d1') }
    };
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  assert.equal(plain.version, 2);
  assert.deepEqual(plain.departments, ["Хирургия", "Терапия", "Косметология", "Физиотерапия", "Гинекология", "Кардиология и Функциональная диагностика"]);
  assert.equal(plain.inheritedActiveM, 9);
  assert.deepEqual(plain.doctor, { department: "Косметология", specialization: "Эстетисты" });
});

test("structure v1 moves cardiology and ultrasound diagnostics into the new department without losing profiles", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    const cardiology = cloneProfile(profileTherapy(), ['кардио']);
    cardiology.activeM = 7;
    const ultrasound = cloneProfile(profileSurgery(), ['узи', 'ультразвуков']);
    ultrasound.activeM = 11;
    DB.settings = defaultSettings();
    DB.settings.structureV = 1;
    DB.settings.departments = {
      'Хирургия': ['Маммология', 'Флебология', 'УЗИ'],
      'Терапия': ['Эндокринология', 'Кардиология', 'Неврология', 'Психотерапия'],
      'Косметология': ['Косметология', 'Эстетисты'],
      'Физиотерапия': ['Специалисты по телу', 'Остеопатия'],
      'Гинекология': ['Гинекология', 'Урология']
    };
    DB.settings.depts['Кардиология'] = cardiology;
    DB.settings.depts['УЗИ'] = ultrasound;
    delete DB.settings.depts['Функциональная диагностика'];
    delete DB.settings.departmentProfiles['Кардиология и Функциональная диагностика'];
    delete DB.settings.departmentUsesSpecializations['Кардиология и Функциональная диагностика'];
    delete DB.settings.departmentHeadDoctorIds;
    DB.doctors = {
      d1: { name: 'Провоторова Елена', aliases: [], structureManual: true, department: 'Терапия', specialization: 'Кардиология' },
      d2: { name: 'Перцхелия Нино', aliases: [], structureManual: true, department: 'Хирургия', specialization: 'УЗИ' },
      d3: { name: 'Пан', aliases: [] }
    };
    normalizeProfiles();
    const headId = DB.settings.departmentHeadDoctorIds['Кардиология и Функциональная диагностика'];
    return {
      version: DB.settings.structureV,
      groups: departmentGroups(),
      cardiologyActiveM: DB.settings.depts['Кардиология'].activeM,
      diagnosticsActiveM: DB.settings.depts['Функциональная диагностика'].activeM,
      hasLegacyUltrasound: Boolean(DB.settings.depts['УЗИ']),
      doctors: {
        d1: doctorStructureLabel('d1'), d2: doctorStructureLabel('d2'), d3: doctorStructureLabel('d3')
      },
      headName: doctorName(headId)
    };
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  assert.equal(plain.version, 2);
  assert.deepEqual(plain.groups['Кардиология и Функциональная диагностика'], ['Кардиология', 'Функциональная диагностика']);
  assert.deepEqual(plain.groups['Хирургия'], ['Маммология', 'Флебология']);
  assert.deepEqual(plain.groups['Терапия'], ['Эндокринология', 'Неврология', 'Психотерапия']);
  assert.equal(plain.cardiologyActiveM, 7);
  assert.equal(plain.diagnosticsActiveM, 11);
  assert.equal(plain.hasLegacyUltrasound, false);
  assert.equal(plain.doctors.d1, 'Кардиология и Функциональная диагностика · Кардиология');
  assert.equal(plain.doctors.d2, 'Кардиология и Функциональная диагностика · Функциональная диагностика');
  assert.equal(plain.doctors.d3, 'Кардиология и Функциональная диагностика · Кардиология');
  assert.equal(plain.headName, 'Пан Константин Александрович');
});

test("department profile is used when specializations are disabled", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    const department = defaultProfile();
    department.scoring.benchmarks.revenue = 111111;
    DB.settings.departments = { 'Диагностика': [] };
    DB.settings.departmentProfiles = { 'Диагностика': department };
    DB.settings.departmentUsesSpecializations = { 'Диагностика': false };
    DB.doctors = { d1: { name: 'Врач отделения', aliases: [], department: 'Диагностика' } };
    normalizeProfiles();
    return {
      profileName: resolvedDeptName('d1'),
      specialization: resolvedSpecializationName('d1'),
      revenue: profileForDoctor('d1').scoring.benchmarks.revenue
    };
  })()`, context);
  assert.equal(result.profileName, "Диагностика");
  assert.equal(result.specialization, null);
  assert.equal(result.revenue, 111111);
});

test("specialization can override settings inside one department", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    const department = defaultProfile();
    department.scoring.benchmarks.revenue = 100000;
    const specialization = defaultProfile();
    specialization.scoring.benchmarks.revenue = 250000;
    DB.settings.departments = { 'Диагностика': ['УЗИ'] };
    DB.settings.departmentProfiles = { 'Диагностика': department };
    DB.settings.departmentUsesSpecializations = { 'Диагностика': true };
    DB.settings.depts = { 'По умолчанию': defaultProfile(), 'УЗИ': specialization };
    DB.doctors = {
      d1: { name: 'Врач УЗИ', aliases: [], department: 'Диагностика', specialization: 'УЗИ' },
      d2: { name: 'Врач без специализации', aliases: [], department: 'Диагностика' }
    };
    normalizeProfiles();
    return {
      specialized: profileForDoctor('d1').scoring.benchmarks.revenue,
      base: profileForDoctor('d2').scoring.benchmarks.revenue,
      label: doctorStructureLabel('d1')
    };
  })()`, context);
  assert.equal(result.specialized, 250000);
  assert.equal(result.base, 100000);
  assert.equal(result.label, "Диагностика · УЗИ");
});

test("doctor settings override only goals and keep specialization norms and weights", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = {
      d1: { name: 'Бузина Врач с целью', aliases: [] },
      d2: { name: 'Гоголева Врач без цели', aliases: [] }
    };
    const inherited = profileForDoctor('d1');
    DB.doctors.d1.metricSettings = {
      minVisits: 9,
      scoring: { weights: { v1: 99 }, enabled: { v1: false }, benchmarks: { revenue: 123456 } }
    };
    const personalized = profileForDoctor('d1');
    const untouched = profileForDoctor('d2');
    return {
      inheritedRevenue: inherited.scoring.benchmarks.revenue,
      inheritedAvgCheck: inherited.scoring.benchmarks.avgCheck,
      personalizedRevenue: personalized.scoring.benchmarks.revenue,
      personalizedAvgCheck: personalized.scoring.benchmarks.avgCheck,
      personalizedMinVisits: personalized.minVisits,
      inheritedMinVisits: inherited.minVisits,
      personalizedWeight: personalized.scoring.weights.v1,
      inheritedWeight: inherited.scoring.weights.v1,
      personalizedEnabled: personalized.scoring.enabled.v1,
      inheritedEnabled: inherited.scoring.enabled.v1,
      untouchedRevenue: untouched.scoring.benchmarks.revenue,
      snapshot: doctorMetricSettingsFromProfile(untouched)
    };
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  assert.equal(plain.personalizedRevenue, 123456);
  assert.equal(plain.personalizedAvgCheck, plain.inheritedAvgCheck);
  assert.equal(plain.personalizedMinVisits, plain.inheritedMinVisits);
  assert.equal(plain.personalizedWeight, plain.inheritedWeight);
  assert.equal(plain.personalizedEnabled, plain.inheritedEnabled);
  assert.equal(plain.untouchedRevenue, plain.inheritedRevenue);
  assert.equal(plain.snapshot.scoring.benchmarks.revenue, plain.untouchedRevenue);
  assert.equal(Object.hasOwn(plain.snapshot, "minVisits"), false);
  assert.equal(Object.hasOwn(plain.snapshot.scoring, "weights"), false);
});

test("replacement protection distinguishes identical and changed slots", () => {
  const context = createContext();
  const identical = vm.runInContext(`(() => { const log = {}; const accepted = acceptSlotReplacement('тест', {a:1}, {a:1}, log); return {accepted, log}; })()`, context);
  assert.equal(identical.accepted, false);
  assert.equal(identical.log.status, "пропущено");
  const changed = vm.runInContext(`(() => { const log = {}; const accepted = acceptSlotReplacement('тест', {a:1}, {a:2}, log); return {accepted, log}; })()`, context);
  assert.equal(changed.accepted, true);
  assert.equal(changed.log.replaced, true);
});

test("metric engine calculates a deterministic synthetic month", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = { d1: { name: 'Тестов Врач', aliases: [], dept: 'По умолчанию' } };
    DB.months = { '2026-01': emptyMonth() };
    DB.months['2026-01'].vyrabotka.d1 = {
      period: extractPeriod('01.01.2026 - 31.01.2026'),
      items: [{ form: '', cat: 'Прием', n: 'Прием врача', q: 5, sOwn: 100000, sRef: 20000, goods: false }]
    };
    clearMetricsCache();
    const metrics = computeMetrics('d1', '2026-01');
    return { sales: metrics.econ.sales, revenueWithRef: metrics.econ.revenueWithRef, visits: metrics.traffic.visits };
  })()`, context);
  assert.equal(result.sales, 100000);
  assert.equal(result.revenueWithRef, 120000);
  assert.equal(result.visits, null);
});

test("doctor dynamics includes average patient check with referrals", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = { d1: { name: 'Тестов Врач', aliases: [], dept: 'По умолчанию' } };
    DB.months = { '2026-01': emptyMonth(), '2026-02': emptyMonth() };
    DB.months['2026-01'].vyrabotka.d1 = { items: [
      { form: '', cat: 'Прием', n: 'Прием врача', q: 2, sOwn: 1000, sRef: 200, goods: false }
    ] };
    DB.months['2026-02'].vyrabotka.d1 = { items: [
      { form: '', cat: 'Прием', n: 'Прием врача', q: 3, sOwn: 2000, sRef: 1000, goods: false }
    ] };
    DB.months['2026-01'].kb.d1 = { '1': { clients: [
      { name: 'Пациент 1', s: 600, v: 1, r: 10 },
      { name: 'Пациент 2', s: 600, v: 1, r: 10 }
    ] } };
    DB.months['2026-02'].kb.d1 = { '1': { clients: [
      { name: 'Пациент 1', s: 1000, v: 1, r: 10 },
      { name: 'Пациент 2', s: 1000, v: 1, r: 10 },
      { name: 'Пациент 3', s: 1000, v: 1, r: 10 }
    ] } };
    clearMetricsCache();
    const dynamics = computeDoctorDynamics('d1', '2026-02');
    const index = dynamics.rows.findIndex(item => item.key === 'avgClientRef');
    const row = dynamics.rows[index];
    return { name: row.name, values: row.values, delta: row.delta, previousKey: dynamics.rows[index - 1].key };
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  assert.equal(plain.name, "Средний чек пациента с перенаправлениями");
  assert.equal(plain.previousKey, "avgClient");
  assert.deepEqual(plain.values, [600, 1000]);
  assert.ok(Math.abs(plain.delta - 66.66666666666666) < 1e-9);
});

test("completed-referral revenue uses only the doctor-work report", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = { d1: { name: 'Тестов Врач', aliases: [], dept: 'По умолчанию' } };
    DB.months = { '2026-01': emptyMonth() };
    DB.months['2026-01'].naznach.d1 = { '1': { items: [
      { n: 'Назначенная услуга', a: 1, d: 1, sq: 1, ss: 500, goods: false }
    ] } };
    clearMetricsCache();
    const withoutWork = computeMetrics('d1', '2026-01');

    DB.months['2026-01'].vyrabotka.d1 = { items: [
      { form: '', sourceForm: 'Сотрудник', cat: 'Прием', n: 'Прием врача', q: 1, sOwn: 100, sRef: 0, goods: false }
    ] };
    clearMetricsCache();
    const withWork = computeMetrics('d1', '2026-01');
    return {
      withoutWork: { refRevenue: withoutWork.econ.refRevenue, share: withoutWork.cross.crossShare },
      withWork: { refRevenue: withWork.econ.refRevenue, revenueWithRef: withWork.econ.revenueWithRef, share: withWork.cross.crossShare },
    };
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  assert.deepEqual(plain.withoutWork, { refRevenue: null, share: null });
  assert.deepEqual(plain.withWork, { refRevenue: 0, revenueWithRef: 100, share: 0 });
});

test("personal doctor goal is used by the score calculation", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = { d1: { name: 'Бузина Врач с личной целью', aliases: [] } };
    const specialization = DB.settings.depts['Эндокринология'];
    for (const key of Object.keys(specialization.scoring.enabled)) specialization.scoring.enabled[key] = false;
    specialization.scoring.enabled.v1 = true;
    specialization.scoring.weights.v1 = 100;
    const own = doctorMetricSettingsFromProfile(profileForDoctor('d1'));
    for (const key of Object.keys(own.scoring.benchmarks)) own.scoring.benchmarks[key] = '';
    own.scoring.benchmarks.revenue = 100;
    DB.doctors.d1.metricSettings = own;
    DB.months = { '2026-01': emptyMonth() };
    DB.months['2026-01'].vyrabotka.d1 = {
      items: [{ form: '', cat: 'Прием', n: 'Прием врача', q: 1, sOwn: 100, sRef: 0, goods: false }]
    };
    clearMetricsCache();
    const metrics = computeMetrics('d1', '2026-01');
    return { total: metrics.scores.total, v1: metrics.scores.vec.v1 };
  })()`, context);
  assert.equal(result.v1, 100);
  assert.equal(result.total, 100);
});

test("department aggregate combines only its selected specializations", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = {
      d1: { name: 'Врач Косметолог', aliases: [], dept: 'Косметология' },
      d2: { name: 'Врач Терапевт', aliases: [], dept: 'Терапия' }
    };
    DB.months = { '2026-01': emptyMonth() };
    DB.months['2026-01'].vyrabotka.d1 = { items: [{ form: '', cat: 'Прием', n: 'Прием врача', q: 1, sOwn: 100, sRef: 20, goods: false }] };
    DB.months['2026-01'].vyrabotka.d2 = { items: [{ form: '', cat: 'Прием', n: 'Прием врача', q: 1, sOwn: 300, sRef: 30, goods: false }] };
    clearMetricsCache();
    const one = aggregateDeptMonth('2026-01', ['Косметология']);
    const both = aggregateDeptMonth('2026-01', ['Косметология', 'Терапия']);
    return { one: one.econ, both: both.econ, doctors: both.doctors };
  })()`, context);
  assert.equal(result.one.sales, 100);
  assert.equal(result.one.revenueWithRef, 120);
  assert.equal(result.both.sales, 400);
  assert.equal(result.both.revenueWithRef, 450);
  assert.equal(result.both.refRevenue, 50);
  assert.equal(result.doctors, 2);
});

test("dashboards exclude doctors without an individual work report", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    const therapy = '\\u0422\\u0435\\u0440\\u0430\\u043f\\u0438\\u044f';
    const endocrine = '\\u042d\\u043d\\u0434\\u043e\\u043a\\u0440\\u0438\\u043d\\u043e\\u043b\\u043e\\u0433\\u0438\\u044f';
    DB.doctors = {
      d1: { name: 'Core Doctor', aliases: [], department: therapy, specialization: endocrine, structureManual: true },
      d2: { name: 'Primary Return Only', aliases: [], department: therapy, specialization: endocrine, structureManual: true },
    };
    DB.months = { '2026-06': emptyMonth() };
    DB.months['2026-06'].vyrabotka.d1 = {
      items: [{ form: '', cat: 'Visit', n: 'Visit', q: 1, sOwn: 100, sRef: 0, goods: false }],
    };
    DB.months['2026-06'].kb.d2 = { window: 1, patients: [{ group: 'new' }] };
    DB.months['2026-06'].naznach.d2 = { slices: { 1: { count: 2, sum: 50 } } };
    DB.months['2026-06'].prostoy.d2 = { busy: 10, total: 20 };
    DB.months['2026-06'].zapis.d2 = { total: 5, booked: 4 };
    DB.months['2026-06'].pervichka['6'] = {
      period: null,
      perDoc: {
        d1: { visits: 0, first: 100, ret: 40, notRet: 60 },
        d2: { visits: 0, first: 50, ret: 10, notRet: 40 },
      },
    };
    clearMetricsCache();
    const selected = aggregateDeptMonth('2026-06', [endocrine]);
    const all = aggregateDeptMonth('2026-06', 'all');
    return {
      d1Eligible: doctorHasDashboardData('d1', '2026-06'),
      d2Eligible: doctorHasDashboardData('d2', '2026-06'),
      scopedDoctors: doctorsForScopeInMonth('2026-06', true),
      selectedDoctors: selected.doctors,
      selectedPrimaryReturn: selected.loyalty.pvSlices[6],
      allDoctors: all.doctors,
      allPrimaryReturn: all.loyalty.pvSlices[6],
    };
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  assert.equal(plain.d1Eligible, true);
  assert.equal(plain.d2Eligible, false);
  assert.deepEqual(plain.scopedDoctors, ["d1"]);
  assert.equal(plain.selectedDoctors, 1);
  assert.equal(plain.selectedPrimaryReturn.first, 100);
  assert.equal(plain.selectedPrimaryReturn.ret, 40);
  assert.equal(plain.selectedPrimaryReturn.pct, 40);
  assert.equal(plain.allDoctors, 1);
  assert.equal(plain.allPrimaryReturn.pct, 40);
});

test("desktop autosave works immediately without an authentication session", async () => {
  const context = createContext({ desktop: true });
  const saved = await vm.runInContext(`(async () => {
    DB.doctors = { d1: { name: 'Тестов Врач', aliases: [] } };
    DB.months = { '2026-01': emptyMonth() };
    return saveLocal();
  })()`, context);
  assert.equal(saved, true);
  assert.equal(context.savedSnapshots.length, 1);
  const snapshot = JSON.parse(context.savedSnapshots[0]);
  assert.equal(snapshot.doctors.d1.name, "Тестов Врач");
  assert.ok(snapshot.months["2026-01"]);
});

test("browser save confirms and stores the complete current session snapshot", async () => {
  const context = createContext();
  const saved = await vm.runInContext(`(async () => {
    DB.doctors = { d1: { name: 'Сессионный Врач', aliases: [], department: 'Терапия' } };
    DB.dynamicNotes = { 'doctor|2026-01|d1': 'Комментарий текущей сессии' };
    return saveLocal();
  })()`, context);
  assert.equal(saved, true);
  assert.equal(context.localSnapshots.length, 1);
  const snapshot = JSON.parse(context.localSnapshots[0]);
  assert.equal(snapshot.doctors.d1.name, "Сессионный Врач");
  assert.equal(snapshot.dynamicNotes["doctor|2026-01|d1"], "Комментарий текущей сессии");
});
