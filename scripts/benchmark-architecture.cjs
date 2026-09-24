"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { performance } = require("node:perf_hooks");

const root = path.resolve(__dirname, "..");
const build = path.join(root, "build");
const context = vm.createContext({
  console,
  window: {},
  document: { getElementById: () => null, createElement: () => ({ style: {} }), body: { appendChild: () => {} } },
  localStorage: { getItem: () => null, setItem: () => {} },
  indexedDB: {},
  navigator: {},
  confirm: () => true,
  setTimeout,
  clearTimeout,
  Blob,
  File: require("node:buffer").File,
  crypto: require("node:crypto").webcrypto,
  FileReader: class {},
  Intl,
  performance,
});

for (const fileName of ["app-core.js", "app-parsers.js", "app-metrics.js"]) {
  const sourcePath = fileName === "app-metrics.js" && process.env.KLINVEKT_BENCHMARK_METRICS_SOURCE
    ? path.resolve(process.env.KLINVEKT_BENCHMARK_METRICS_SOURCE)
    : path.join(build, fileName);
  vm.runInContext(fs.readFileSync(sourcePath, "utf8"), context, { filename: fileName });
}

const heapBefore = process.memoryUsage().heapUsed;
const startedAt = performance.now();
const result = vm.runInContext(`(() => {
  const doctorCount = 10, monthCount = 12, clientsPerWindow = 250;
  DB.doctors = {};
  DB.months = {};
  for (let doctorIndex = 0; doctorIndex < doctorCount; doctorIndex++) {
    const doctorId = 'bench-' + doctorIndex;
    DB.doctors[doctorId] = { name: 'Синтетический Врач ' + doctorIndex, aliases: [], department: 'Косметология', specialization: 'Косметология' };
  }
  for (let monthIndex = 1; monthIndex <= monthCount; monthIndex++) {
    const monthKey = '2026-' + String(monthIndex).padStart(2, '0');
    const month = emptyMonth();
    DB.months[monthKey] = month;
    for (let doctorIndex = 0; doctorIndex < doctorCount; doctorIndex++) {
      const doctorId = 'bench-' + doctorIndex;
      month.vyrabotka[doctorId] = { items: Array.from({ length: 50 }, (_, itemIndex) => ({
        form: '', cat: 'Прием', n: 'Синтетическая услуга ' + itemIndex, q: 1,
        sOwn: 1000 + itemIndex, sRef: itemIndex % 3 ? 0 : 100, goods: false,
      })) };
      month.kb[doctorId] = {};
      for (const windowMonths of [1, 12, 36]) {
        month.kb[doctorId][String(windowMonths)] = { clients: Array.from({ length: clientsPerWindow }, (_, clientIndex) => ({
          patientId: doctorId + '-' + windowMonths + '-' + clientIndex,
          name: 'Синтетический Пациент ' + clientIndex,
          s: 1000 + clientIndex,
          v: 1 + (clientIndex % 6),
          r: clientIndex % Math.max(1, windowMonths * 30),
        })) };
      }
    }
  }
  const pairs = Object.keys(DB.months).flatMap(monthKey => Object.keys(DB.doctors).map(doctorId => [doctorId, monthKey]));
  const serializedAt = performance.now();
  const serializedBytes = JSON.stringify(DB).length;
  const serializeMs = performance.now() - serializedAt;
  clearMetricsCache();
  const coldAt = performance.now();
  const coldResults = pairs.map(([doctorId, monthKey]) => computeMetrics(doctorId, monthKey));
  const coldMs = performance.now() - coldAt;
  const scalarStats = typeof metricsCacheStats === 'function' ? metricsCacheStats() : null;
  const warmAt = performance.now();
  for (const [doctorId, monthKey] of pairs) computeMetrics(doctorId, monthKey);
  const warmMs = performance.now() - warmAt;
  const beforeDetails = typeof metricsCacheStats === 'function' ? metricsCacheStats().sizes.kbDetails : null;
  const detailRows = coldResults[0].akb.wins[36].clientRows.length;
  const afterDetails = typeof metricsCacheStats === 'function' ? metricsCacheStats().sizes.kbDetails : null;
  const departmentAt = performance.now();
  for (const monthKey of Object.keys(DB.months)) aggregateDeptMonth(monthKey, 'all');
  const departmentColdMs = performance.now() - departmentAt;
  const departmentWarmAt = performance.now();
  for (const monthKey of Object.keys(DB.months)) aggregateDeptMonth(monthKey, 'all');
  const departmentWarmMs = performance.now() - departmentWarmAt;
  const january = coldResults[0];
  if (typeof invalidateMetricsCache === 'function') invalidateMetricsCache({ dynamicNotes: true });
  const noteKeptScalarCache = computeMetrics('bench-0', '2026-01') === january;
  if (typeof invalidateMetricsCache === 'function') invalidateMetricsCache({ months: ['2026-01'] });
  const monthWasInvalidated = computeMetrics('bench-0', '2026-01') !== january;
  return {
    dataset: { doctorCount, monthCount, clientsPerWindow, pairs: pairs.length, serializedBytes },
    timingMs: { serialize: serializeMs, coldMetrics: coldMs, warmMetrics: warmMs, departmentCold: departmentColdMs, departmentWarm: departmentWarmMs },
    cache: { scalarStats, beforeDetails, afterDetails, detailRows, noteKeptScalarCache, monthWasInvalidated,
      final: typeof metricsCacheStats === 'function' ? metricsCacheStats() : null },
  };
})()`, context);
const elapsedMs = performance.now() - startedAt;
const heapAfter = process.memoryUsage().heapUsed;
const output = JSON.parse(JSON.stringify(result));
output.environment = { node: process.version, platform: process.platform, arch: process.arch };
output.timingMs.total = elapsedMs;
output.memory = { heapBefore, heapAfter, heapGrowthBytes: Math.max(0, heapAfter - heapBefore) };

if (!process.env.KLINVEKT_BENCHMARK_METRICS_SOURCE) {
  assert.equal(output.cache.beforeDetails, 0, "patient details must stay lazy during scalar calculations");
  assert.equal(output.cache.afterDetails, 1, "one requested patient detail window must occupy one cache entry");
  assert.equal(output.cache.detailRows, 250);
  assert.equal(output.cache.noteKeptScalarCache, true);
  assert.equal(output.cache.monthWasInvalidated, true);
  for (const [name, size] of Object.entries(output.cache.final.sizes)) {
    assert.ok(size <= output.cache.final.limits[name], `${name} cache exceeds its LRU limit`);
  }
  assert.ok(output.timingMs.coldMetrics < 15000, "cold metrics benchmark exceeded 15 seconds");
  assert.ok(output.timingMs.warmMetrics < 1000, "warm metrics benchmark exceeded 1 second");
  assert.ok(output.memory.heapGrowthBytes < 768 * 1024 * 1024, "benchmark heap growth exceeded 768 MB");
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
