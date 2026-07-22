"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

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

test("core date and doctor-name helpers preserve legacy behavior", () => {
  const context = createContext();
  assert.equal(vm.runInContext("normFio('Иванова Ёлка Петровна..')", context), "иванова елка петровна");
  assert.equal(vm.runInContext("prevMonthKey('2026-01')", context), "2025-12");
  assert.equal(vm.runInContext("periodMonths(extractPeriod('01.01.2026 - 31.03.2026'))", context), 3);
  assert.equal(vm.runInContext("isFullMonthPeriod(extractPeriod('01.01.2026 - 31.03.2026'))", context), true);
  assert.equal(vm.runInContext("isFullMonthPeriod(extractPeriod('02.01.2026 - 31.03.2026'))", context), false);
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

test("department ratios are weighted and patients are deduplicated by stable identity", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = {
      d1: { name: 'Первый Врач', aliases: [], dept: 'По умолчанию' },
      d2: { name: 'Второй Врач', aliases: [], dept: 'По умолчанию' }
    };
    DB.months = { '2026-01': emptyMonth() };
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
  assert.deepEqual(Object.keys(groups), ["Хирургия", "Терапия", "Косметология", "Физиотерапия", "Гинекология"]);
  assert.deepEqual(groups["Хирургия"], ["Маммология", "Флебология", "УЗИ"]);
  assert.deepEqual(groups["Терапия"], ["Эндокринология", "Кардиология", "Неврология", "Психотерапия"]);
  assert.deepEqual(groups["Косметология"], ["Косметология", "Эстетисты"]);
  assert.deepEqual(groups["Физиотерапия"], ["Специалисты по телу", "Остеопатия"]);
  assert.deepEqual(groups["Гинекология"], ["Гинекология", "Урология"]);
  assert.ok(!Object.values(groups).flat().includes("По умолчанию"));
});

test("the clinic roster is available before the first import", () => {
  const context = createContext();
  const names = vm.runInContext("Object.values(DB.doctors).map(d => d.name)", context);
  assert.deepEqual(JSON.parse(JSON.stringify(names)), [
    "Пудовкина", "Чернигова", "Гайнутдинова", "Лушникова", "Кожикина", "Римашевская",
    "Кузьменко", "Лятифова", "Бережная", "Королева", "Дубровская", "Самсонова", "Никифорова", "Перцхелия",
    "Бузина", "Гоголева", "Мановицкая", "Жуйков", "Пан", "Провоторова", "Ахильгова", "Федроов", "Кузьменков",
  ]);
  const structures = vm.runInContext("Object.fromEntries(Object.entries(DB.doctors).map(([id, d]) => [d.name, doctorStructureLabel(id)]))", context);
  assert.deepEqual(JSON.parse(JSON.stringify(structures)), {
    "Пудовкина": "Косметология · Косметология", "Чернигова": "Косметология · Косметология",
    "Гайнутдинова": "Косметология · Косметология", "Лушникова": "Косметология · Косметология",
    "Кожикина": "Косметология · Эстетисты", "Римашевская": "Косметология · Эстетисты",
    "Кузьменко": "Гинекология · Гинекология", "Лятифова": "Гинекология · Гинекология", "Бережная": "Гинекология · Гинекология",
    "Королева": "Гинекология · Урология", "Дубровская": "Хирургия · Флебология",
    "Самсонова": "Хирургия · Маммология", "Никифорова": "Хирургия · Маммология", "Перцхелия": "Хирургия · УЗИ",
    "Бузина": "Терапия · Эндокринология", "Гоголева": "Терапия · Эндокринология",
    "Мановицкая": "Терапия · Эндокринология", "Жуйков": "Терапия · Эндокринология",
    "Пан": "Терапия · Кардиология", "Провоторова": "Терапия · Кардиология", "Ахильгова": "Терапия · Кардиология",
    "Федроов": "Терапия · Неврология", "Кузьменков": "Терапия · Психотерапия",
  });
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
      d6: { name: 'Провоторова Елена', aliases: [] },
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
  assert.deepEqual(plain.d5, { department: "Хирургия", specialization: "УЗИ" });
  assert.deepEqual(plain.d6, { department: "Терапия", specialization: "Кардиология" });
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
      d3: { name: 'Новый Маммолог', aliases: [], spec: 'врач-маммолог' }
    };
    return Object.fromEntries(Object.keys(DB.doctors).map(id => [id, doctorStructureLabel(id)]));
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  assert.equal(plain.d1, "Гинекология · Урология");
  assert.equal(plain.d2, "Физиотерапия · Остеопатия");
  assert.equal(plain.d3, "Хирургия · Маммология");
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
  assert.equal(plain.version, 1);
  assert.deepEqual(plain.departments, ["Хирургия", "Терапия", "Косметология", "Физиотерапия", "Гинекология"]);
  assert.equal(plain.inheritedActiveM, 9);
  assert.deepEqual(plain.doctor, { department: "Косметология", specialization: "Эстетисты" });
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

test("desktop autosave serializes the current database before writing SQLite", async () => {
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
