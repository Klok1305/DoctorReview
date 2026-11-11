"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const { DatabaseService } = require("../desktop/services/database.cjs");
const { BackgroundTaskQueue } = require("../desktop/services/background-task-queue.cjs");
const { ReportCalculationStore, preparePersistedReportYear, calculationSource } = require("../desktop/services/report-calculation-service.cjs");
const root = path.resolve(__dirname, "..");
const source = ["app-core.js", "app-parsers.js", "app-metrics.js", "report-worker.js"]
  .map(file => fs.readFileSync(path.join(root, "build", file), "utf8")).join("\n");
const plain = value => JSON.parse(JSON.stringify(value));

function context(snapshot, api) {
  const c = vm.createContext({ console, window: api ? { desktopAPI: api } : {},
    localStorage: { getItem: () => null, setItem() {} }, Intl, snapshot });
  vm.runInContext(source, c);
  if (snapshot) vm.runInContext("DB=snapshot;clearMetricsCache()", c);
  return c;
}

function fixture() {
  const c = context();
  vm.runInContext(`
    DB.doctors={d0:{name:'Синтетический Врач Первый',aliases:[],department:'A',specialization:'X',structureManual:true},
      d1:{name:'Синтетический Врач Второй',aliases:[],department:'A',specialization:'X',subdept:'Группа',structureManual:true}};
    DB.settings.depts.X=defaultProfile(); DB.settings.depts.X.subdivisions=['Группа'];
    DB.settings.departments={A:['X']};DB.settings.departmentUsesSpecializations={A:true};DB.months={};
    for(const key of ['2025-01','2025-12','2026-01','2026-03']) {
      const m=DB.months[key]=emptyMonth();
      for(const [index,id] of Object.keys(DB.doctors).entries()) {
        m.vyrabotka[id]={items:[{n:'Прием',q:2,sOwn:1000*(index+1),sRef:100,goods:false}]};
        m.kb[id]=Object.fromEntries([1,6,12,36].map(win=>[win,{clients:Array.from({length:100},(_,i)=>
          ({name:'Синтетический Пациент '+i,patientId:'synthetic-'+i,v:i%6+1,r:i%900,s:100+i}))}]));
      }
      m.primaryPatients={perDoc:{d0:{patients:[{name:'Синтетический Первичный',primary:1,visits:1,revenue:500,source:'Сайт'}]},d1:{patients:[]}}};
    }
    delete DB.months['2026-01'].kb.d1[36];clearMetricsCache();
  `, c);
  return plain(vm.runInContext("DB", c));
}

function databaseFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "klinvekt-report-ready-"));
  const databasePath = path.join(directory, "test.sqlite");
  const database = new DatabaseService(databasePath), snapshot = fixture();
  database.saveSnapshot(snapshot);
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { database, databasePath, snapshot };
}

test("one background preparation persists all report types and reopens them without recalculation", async t => {
  const { database, databasePath, snapshot } = databaseFixture(t);
  const queue = new BackgroundTaskQueue(); t.after(() => queue.close());
  const progress = [], start = performance.now();
  const first = await queue.run("report-year", { databasePath, year: "2026" }, { onProgress: value => progress.push(value) });
  const coldMs = performance.now() - start;
  assert.equal(first.fromCache, false);
  assert.ok(progress.some(value => value.stage === "calculate" && value.completed === value.total));
  assert.ok(progress.some(value => value.stage === "save"));
  assert.equal(progress.at(-1).stage, "ready");
  assert.ok(database.db.prepare("SELECT length(payload) AS bytes FROM report_calculations WHERE year='2026'").get().bytes > 0);
  const warmProgress = [], warmAt = performance.now();
  const reopened = await queue.run("report-year", { databasePath, year: "2026" }, { onProgress: value => warmProgress.push(value) });
  const warmMs = performance.now() - warmAt;
  assert.equal(reopened.fromCache, true);
  assert.ok(warmProgress.every(value => value.stage !== "calculate" && value.stage !== "save"));
  t.diagnostic(`isolated fixture: prepare ${coldMs.toFixed(1)} ms, reopen ${warmMs.toFixed(1)} ms`);

  const original = context(snapshot);
  vm.runInContext(`function readReports(){return {
    doctor:computeMetrics('d0','2026-03').econ,
    previousDecember:computeMetrics('d0','2025-12').econ,
    department:aggregateDeptMonth('2026-03',departmentSpecializations('A')).econ,
    missing:aggregateDeptMonth('2026-01',departmentSpecializations('A')).akb.primary.seg,
    specialization:aggregateDeptMonth('2026-03','X','Группа').econ,
    base:reportClientBaseSummary('d0','2026-03',12).seg,
    primary:doctorPrimaryPatients('d0','2026-03'),
    history:specializationClientBaseHistory('2026-03','X').series};}`, original);
  const expected = plain(vm.runInContext("readReports()", original));
  const c = context(snapshot); c.prepared = reopened.prepared;
  vm.runInContext(`hydratePreparedReportYear(prepared);specializationCalculations=prepared;preparedMetricsForRender=prepared.metrics;
    ${vm.runInContext("readReports.toString()", original)}
    computeMetricsRaw=computeKbSummary=aggregateDeptMonthRaw=computeDoctorPrimaryPatients=()=>{throw Error('Unexpected recomputation');};`, c);
  assert.deepEqual(plain(vm.runInContext("readReports()", c)), expected);
  assert.equal(vm.runInContext("reportClientBaseSummary('d0','2026-03',12).clientRows.length", c), 100);
  assert.equal(vm.runInContext("computeMetrics('d0','2026-03').extras.kb1.clientRows.length", c), 100);
  assert.equal(vm.runInContext("adminClientBaseSummary('d0','2026-03').clientRows.length", c), 100);
});

test("persisted reports track source data, historical comparisons and settings, while notes and future months reuse the cache", t => {
  const { database, databasePath, snapshot } = databaseFixture(t);
  const prepare = () => preparePersistedReportYear({ databasePath, year: "2026" });
  assert.equal(prepare().fromCache, false);
  snapshot.dynamicNotes = { note: "Синтетический комментарий" }; database.saveSnapshot(snapshot);
  assert.equal(prepare().fromCache, true);
  snapshot.months["2027-01"] = structuredClone(snapshot.months["2026-03"]); database.saveSnapshot(snapshot);
  assert.equal(prepare().fromCache, true, "later data does not change an earlier report year");
  snapshot.months["2026-03"].vyrabotka.d0.items[0].sOwn = 5000; database.saveSnapshot(snapshot);
  const changed = prepare();
  assert.equal(changed.fromCache, false);
  assert.equal(changed.prepared.metrics.get('["d0","2026-03"]').econ.sales, 5000);
  const previousAverage = changed.prepared.metrics.get('["d0","2026-03"]').econ.prevY;
  snapshot.months["2025-01"].vyrabotka.d0.items[0].sOwn = 20000; database.saveSnapshot(snapshot);
  const historical = prepare();
  assert.equal(historical.fromCache, false);
  assert.notEqual(historical.prepared.metrics.get('["d0","2026-03"]').econ.prevY, previousAverage);
  snapshot.settings.depts.X.scoring.benchmarks.revenue = 15000; database.saveSnapshot(snapshot);
  assert.equal(prepare().fromCache, false);
  database.db.prepare("UPDATE report_calculations SET payload=? WHERE year='2026'").run(Buffer.from("corrupt cache"));
  assert.equal(prepare().fromCache, false, "a damaged cache is rebuilt from original documents");
  const store = new ReportCalculationStore(database, calculationSource().version);
  const sourceKey = store.sourceKey("2026"), old = store.read("2026");
  snapshot.months["2026-03"].vyrabotka.d0.items[0].sOwn++; database.saveSnapshot(snapshot);
  assert.throws(() => store.write("2026", sourceKey, old), { name: "ReportDataChangedError" });
  assert.equal(store.read("2026"), null, "an old result is never presented as current");
  assert.equal(new ReportCalculationStore(database, "another-calculation-version").read("2026"), null);
});

test("desktop report switches share one prepared year and discard replies from an old revision", async t => {
  const { database, databasePath, snapshot } = databaseFixture(t);
  const ready = preparePersistedReportYear({ databasePath, year: "2026" });
  const readyByYear = { "2026": ready, "2025": preparePersistedReportYear({ databasePath, year: "2025" }) };
  const controls = new Map(), requests = [], cancellations = [];
  let reply, delay = false;
  const api = {
    prepareReportYear: async request => { requests.push(request); return delay ? new Promise(resolve => { reply = resolve; }) : structuredClone(readyByYear[request.year]); },
    cancelBackgroundOperation: async operationId => { cancellations.push(operationId); },
  };
  const c = context(snapshot, api);
  Object.assign(c, { UI: { deptMonth: "2026-03", deptFilter: "X", subFilter: "all", docMonth: "2026-03", docId: "d0", departmentMonth: "2026-03", departmentFilter: "A" },
    crypto: require("node:crypto").webcrypto, performance, setTimeout, clearTimeout, Worker: function () { throw Error("Renderer worker should not copy the database"); },
    sortDoctorIdsAlphabetically: ids => ids,
    document: { getElementById: id => {
      if (!controls.has(id)) controls.set(id, { innerHTML: "", classList: { add() {}, remove() {} }, removeAttribute() {} });
      return controls.get(id);
    } },
  });
  vm.runInContext(`desktopDataRevision=${database.summary().dataRevision}`, c);
  vm.runInContext(fs.readFileSync(path.join(root, "build/report-performance.js"), "utf8"), c);
  assert.equal(await vm.runInContext("prepareAllReports()", c), true);
  // Two fixture years are independently persisted; switching report types must share the latest one.
  const before = requests.length;
  vm.runInContext(`computeMetricsRaw=aggregateDeptMonthRaw=computeKbSummary=()=>{throw Error('Unexpected calculation on report switch');};`, c);
  for (const tab of ["doctor", "department", "dept", "doctor"]) {
    c.tab = tab;
    const result = await vm.runInContext("renderPreparedReport(tab,()=>computeMetrics('d0','2026-03').econ.sales)", c);
    assert.equal(result, 1000);
  }
  assert.equal(requests.length, before);
  assert.ok(requests.every(request => Object.keys(request).sort().join(",") === "operationId,year"));
  delay = true;
  vm.runInContext("invalidateMetricsCache({settings:true})", c);
  const pending = vm.runInContext("prepareSpecializationYear('2026-03')", c);
  await new Promise(resolve => setTimeout(resolve, 5));
  vm.runInContext("invalidateMetricsCache({months:['2026-01']})", c);
  reply(structuredClone(ready));
  assert.equal(await pending, null);
  assert.equal(vm.runInContext("readySpecializationYear('2026')", c), null);
});
