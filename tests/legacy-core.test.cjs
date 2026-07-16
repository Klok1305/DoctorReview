"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const build = path.resolve(__dirname, "..", "build");

function createContext({ desktop = false } = {}) {
  const savedSnapshots = [];
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
    document: { getElementById: () => null, createElement: () => ({ style: {} }), body: { appendChild: () => {} } },
    localStorage: { getItem: () => null, setItem: () => {} },
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

test("patient-base statuses depend on recency while loyalty stays separate", () => {
  const context = createContext();
  const result = vm.runInContext(`(() => {
    DB.doctors = { d1: { name: 'Тестов Врач', aliases: [], dept: 'По умолчанию' } };
    DB.months = { '2026-01': emptyMonth() };
    DB.months['2026-01'].kb.d1 = { '12': { clients: [
      { name: 'Активный Разовый', s: 100, v: 1, r: 30 },
      { name: 'Риск Лояльный', s: 200, v: 5, r: 200 },
      { name: 'Спящий Разовый', s: 300, v: 1, r: 300 },
      { name: 'Потерянный Лояльный', s: 400, v: 5, r: 400 },
      { name: 'Без Давности', s: 500, v: 2, r: null }
    ] } };
    clearMetricsCache();
    const kb = kbSummary('d1', '2026-01', 12);
    return { seg: kb.seg, activeBase: kb.activeBase, loyalCount: kb.loyalCount, revenueAtRisk: kb.revenueAtRisk, rows: kb.clientRows };
  })()`, context);
  const plain = JSON.parse(JSON.stringify(result));
  assert.deepEqual(
    { active: plain.seg.active, risk: plain.seg.risk, sleep: plain.seg.sleep, lost: plain.seg.lost, unknown: plain.seg.unknown },
    { active: 1, risk: 1, sleep: 1, lost: 1, unknown: 1 },
  );
  assert.equal(plain.activeBase, 1);
  assert.equal(plain.loyalCount, 2);
  assert.equal(plain.revenueAtRisk, 900);
  assert.equal(plain.rows[0].name, "Активный Разовый");
  assert.equal(plain.rows[0].loyal, false);
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

test("course treatment uses only an exact window and schedule shows actual load", () => {
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
  assert.equal(result.version, 3);
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
