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
