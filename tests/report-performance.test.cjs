"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), { Worker } = require("node:worker_threads");
const { createReportRenderCache, renderCloudReport } = require("../mobile-server/cloud-report-renderer.cjs");
const root = path.resolve(__dirname, "..");
const files = ["app-core.js", "app-parsers.js", "app-metrics.js", "report-worker.js"];
const source = files.map(file => fs.readFileSync(path.join(root, "build", file), "utf8")).join("\n");
function context() {
  const c = vm.createContext({ console, window: {}, localStorage: { getItem() { return null; }, setItem() {} }, Intl });
  vm.runInContext(source, c);
  return c;
}
function fixture(c, { clients = 120, doctors = 3 } = {}) {
  c.fixtureOptions = { clients, doctors };
  vm.runInContext(`
    DB.doctors = {}; DB.months = {}; DB.settings.depts.X = defaultProfile();
    DB.settings.departments = { A: ['X'] }; DB.settings.departmentUsesSpecializations = { A: true };
    for (let d = 0; d < fixtureOptions.doctors; d++) DB.doctors['d' + d] = { name: 'Синтетический Врач ' + d, aliases: [], department: 'A', specialization: 'X', structureManual: true };
    for (const key of ['2025-12', '2026-01', '2026-03']) {
      const m = DB.months[key] = emptyMonth();
      for (const id of Object.keys(DB.doctors)) {
        m.vyrabotka[id] = { items: [{ n: 'Прием', q: 2, sOwn: 1000, sRef: 100, goods: false }] };
        m.kb[id] = Object.fromEntries([1, 12, 36].map(win => [win, { clients: Array.from({ length: fixtureOptions.clients }, (_, i) => ({ name: 'Пациент ' + i, patientId: 'id-' + i, s: 1000 + i, v: i % 6 + 1, r: i % 900 })) }]));
      }
    }
    DB.months['2026-03'].zapis.d1 = { total: 20, zapis: 10, okaz: 5, created: 4 };
    delete DB.months['2026-01'].kb.d2;
    DB.settings.depts.X.scoring.benchmarks.avgCheck = null;
    clearMetricsCache();
  `, c);
}
function prepare(snapshot, job) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'),vm=require('node:vm');
      const c=vm.createContext({window:{},localStorage:{getItem(){return null},setItem(){}},Intl});
      vm.runInContext(workerData.source,c);
      parentPort.once('message',message=>{c.job=message.job;c.snapshot=message.snapshot;try {const result=vm.runInContext('DB=snapshot;clearMetricsCache();prepareReportCalculations(job)',c);parentPort.postMessage(result);}catch(error){throw error;}});`, { eval: true, workerData: { source } });
    worker.once("message", result => { worker.terminate(); resolve(result); });
    worker.once("error", error => { worker.terminate(); reject(error); });
    worker.postMessage({ snapshot, job });
  });
}
const plain = value => JSON.parse(JSON.stringify(value));

test("report Worker matches direct metrics, calendar gaps, partial coverage and changed targets; selected snapshot excludes other patients", async () => {
  const c = context(); fixture(c);
  const expected = plain(vm.runInContext("['2026-01','2026-03'].map(key => ({metric:computeMetrics('d0',key), rows:adminClientBaseSummary('d0',key).clientRows}))", c));
  const snapshot = vm.runInContext("reportWorkerSnapshot(DB,['d0'])", c);
  assert.deepEqual(Object.keys(snapshot.months['2026-03'].kb), ['d0']);
  assert.equal(snapshot.months['2026-03'].importedReports.zapis, true, "old inferred coverage includes another doctor's import");
  const prepared = await prepare(snapshot, { tab: "doctor", doctorId: "d0", month: "2026-03" });
  c.prepared = prepared;
  vm.runInContext("clearMetricsCache();adoptReportCalculations(prepared)", c);
  assert.deepEqual(plain(vm.runInContext("['2026-01','2026-03'].map(key => ({metric:computeMetrics('d0',key), rows:adminClientBaseSummary('d0',key).clientRows}))", c)), expected);
  assert.equal(vm.runInContext("computeMetrics('d0','2026-02')", c), null);
  assert.equal(vm.runInContext("computeMetrics('d0','2026-03').akb.wins[36].clientRows.length", c), 120, "lazy rows survive structured clone");
  for (const filter of ["all", ["X"]]) {
    c.filter = filter;
    const expectedGroup = plain(vm.runInContext("aggregateDeptMonth('2026-01',filter)", c));
    const groupPrepared = await prepare(vm.runInContext("reportWorkerSnapshot(DB,Object.keys(DB.doctors))", c), { tab: "department", filter, month: "2026-03" });
    c.prepared = groupPrepared; vm.runInContext("clearMetricsCache();adoptReportCalculations(prepared)", c);
    assert.deepEqual(plain(vm.runInContext("aggregateDeptMonth('2026-01',filter)", c)), expectedGroup);
    assert.equal(expectedGroup.econ.avgClient, null, "partial base stays unavailable");
  }
  vm.runInContext("DB.settings.depts.X.scoring.benchmarks.revenue=2000;DB.settings.depts.X.minVisits=4;invalidateMetricsCache({settings:true})", c);
  const changed = plain(vm.runInContext("computeMetrics('d0','2026-03')", c));
  const changedPrepared = await prepare(vm.runInContext("reportWorkerSnapshot(DB,['d0'])", c), { tab: "doctor", doctorId: "d0", month: "2026-03" });
  c.prepared = changedPrepared; vm.runInContext("clearMetricsCache();adoptReportCalculations(prepared)", c);
  assert.deepEqual(plain(vm.runInContext("computeMetrics('d0','2026-03')", c)), changed);
});

test("report Worker keeps the caller event loop responsive on a large cohort", async () => {
  const c = context(); fixture(c, { clients: 4000, doctors: 10 });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    const prepared = await prepare(vm.runInContext("reportWorkerSnapshot(DB,Object.keys(DB.doctors))", c), { tab: "department", filter: "all", month: "2026-03" });
    assert.ok(ticks >= 5, "calculations must allow caller timers to execute");
    assert.ok(prepared.department.length >= 3);
  } finally { clearInterval(timer); }
});

test("changing the report or calculation revision discards old Worker replies", async () => {
  const c = context(); fixture(c);
  const workers = [], drawn = [];
  class MockWorker {
    constructor() { workers.push(this); }
    postMessage(value) { this.request = value; }
    terminate() { this.terminated = true; }
    reply() { this.onmessage({ data: { prepared: { metrics: [], kbSummary: [], adminBase: [], department: [] } } }); }
  }
  const controls = new Map();
  Object.assign(c, { UI: { charts: {} }, Worker: MockWorker, Blob, performance, setTimeout, sortDoctorIdsAlphabetically: ids => ids,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    requestAnimationFrame: callback => callback(), document: { getElementById: id => {
      if (!controls.has(id)) controls.set(id, { innerHTML: '', textContent: 'source' }); return controls.get(id);
    } }, drawn });
  vm.runInContext(fs.readFileSync(path.join(root, 'build/report-performance.js'), 'utf8'), c);
  const first = vm.runInContext("UI.docId='d0';UI.docMonth='2026-03';renderPreparedReport('doctor',()=>drawn.push(UI.docId))", c);
  const second = vm.runInContext("UI.docId='d1';renderPreparedReport('doctor',()=>drawn.push(UI.docId))", c);
  assert.equal(await first, false); assert.equal(workers[0].terminated, true);
  workers[0].reply(); assert.deepEqual(drawn, []);
  vm.runInContext("invalidateMetricsCache({settings:true})", c);
  workers[1].reply(); assert.equal(await second, false); assert.equal(workers.length, 3);
  workers[2].reply(); assert.deepEqual(drawn, ['d1']);
  const revision = vm.runInContext("metricsCalculationRevision", c);
  vm.runInContext("invalidateMetricsCache({dynamicNotes:true})", c);
  assert.equal(vm.runInContext("metricsCalculationRevision", c), revision, "editing comments does not restart calculations");
});

function report() { return { assessment: "", summary: "", overall: 42, vectors: [{ id: 'v1', number: 1, title: 'Экономика', score: 42, sections: [{ title: 'График', charts: [{ id: 'test', type: 'line', title: 'Выручка', labels: ['Январь', 'Февраль', 'Март'], series: [{ label: 'Продажи', values: [100, null, 300] }] }] }] }] }; }
test("online rendering cache is bounded, distinguishes revisions, and retains all exact chart data before lazy drawing", () => {
  const cache = createReportRenderCache({ maxEntries: 2, maxBytes: 20000 });
  const page = { pageId: 'one', title: 'Доктор', report: report() };
  const lazy = cache.render(page);
  assert.match(lazy, /data-chart-deferred="true"/); assert.doesNotMatch(lazy, /<svg/);
  assert.match(lazy, /100/); assert.match(lazy, /null/); assert.match(lazy, /300/);
  assert.equal(cache.render(page), lazy); assert.equal(cache.stats().renders, 1);
  page.report = { ...report(), summary: "Обновлено" }; assert.match(cache.render(page), /Обновлено/); assert.equal(cache.stats().renders, 2);
  for (let i = 0; i < 6; i++) cache.render({ ...page, pageId: String(i) });
  assert.ok(cache.stats().entries <= 2); assert.ok(cache.stats().bytes <= 20000);
  cache.clear(); assert.equal(cache.stats().bytes, 0);
  assert.match(renderCloudReport(report(), 'Доктор'), /<svg/, "complete eager rendering remains available");
});
