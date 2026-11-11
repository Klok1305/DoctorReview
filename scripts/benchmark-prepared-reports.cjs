"use strict";

// Synthetic data only. Timings are observations, not CI thresholds.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const { DatabaseService } = require("../desktop/services/database.cjs");
const { BackgroundTaskQueue } = require("../desktop/services/background-task-queue.cjs");
const root = path.resolve(__dirname, "..");

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "klinvekt-ready-benchmark-"));
  const databasePath = path.join(directory, "synthetic.sqlite");
  const queue = new BackgroundTaskQueue();
  const database = new DatabaseService(databasePath);
  try {
    const c = vm.createContext({ window: {}, localStorage: { getItem: () => null, setItem() {} }, Intl });
    for (const file of ["app-core.js", "app-parsers.js", "app-metrics.js", "report-worker.js"]) {
      vm.runInContext(fs.readFileSync(path.join(root, "build", file), "utf8"), c);
    }
    const fixture = { doctors: 8, months: 12, clientsPerDoctor: 1200, windows: [1, 6, 12, 36] };
    c.fixture = fixture;
    vm.runInContext(`DB.doctors={};DB.months={};DB.settings.depts.X=defaultProfile();
      DB.settings.departments={A:['X']};DB.settings.departmentUsesSpecializations={A:true};
      for(let index=0;index<fixture.doctors;index++)DB.doctors['d'+index]={name:'Синтетический Врач '+index,aliases:[],department:'A',specialization:'X',structureManual:true};
      for(let index=1;index<=fixture.months;index++){
        const month=DB.months['2026-'+String(index).padStart(2,'0')]=emptyMonth();
        for(const id of Object.keys(DB.doctors)){
          month.vyrabotka[id]={items:[{n:'Прием',q:5,sOwn:100000+index*1000,sRef:10000,goods:false}]};
          month.kb[id]=Object.fromEntries(fixture.windows.map(window=>[window,{clients:Array.from({length:fixture.clientsPerDoctor},(_,i)=>
            ({name:'Синтетический Пациент '+i,patientId:'synthetic-'+i,v:i%6+1,r:i%900,s:1000+i}))}]));
        }
      }`, c);
    database.saveSnapshot(JSON.parse(vm.runInContext("JSON.stringify(DB)", c)));
    let ticks = 0, previous = performance.now(), maxEventGapMs = 0;
    const timer = setInterval(() => { const now = performance.now(); maxEventGapMs = Math.max(maxEventGapMs, now - previous); previous = now; ticks++; }, 10);
    let cold, coldMs, warm, warmMs;
    try {
      const start = performance.now();
      cold = await queue.run("report-year", { databasePath, year: "2026" });
      coldMs = performance.now() - start;
      const reopened = performance.now();
      warm = await queue.run("report-year", { databasePath, year: "2026" });
      warmMs = performance.now() - reopened;
    } finally { clearInterval(timer); }
    assert.equal(cold.fromCache, false);
    assert.equal(warm.fromCache, true);
    c.prepared = warm.prepared;
    vm.runInContext("hydratePreparedReportYear(prepared);specializationCalculations=prepared;preparedMetricsForRender=prepared.metrics", c);
    const start = performance.now();
    const totals = vm.runInContext(`Object.keys(DB.doctors).map(id=>computeMetrics(id,'2026-12').econ.sales);
      aggregateDeptMonth('2026-12',departmentSpecializations('A')).econ.sales`, c);
    const lookupMs = performance.now() - start;
    assert.equal(totals, fixture.doctors * 112000);
    const result = { fixture, coldPreparationMs: coldMs, persistedLoadMs: warmMs, preparedLookupMs: lookupMs,
      reuseFactor: coldMs / warmMs, compressedBytes: database.db.prepare("SELECT length(payload) AS bytes FROM report_calculations").get().bytes,
      mainThreadTicks: ticks, maxEventGapMs };
    fs.mkdirSync(path.join(root, "tmp"), { recursive: true });
    fs.writeFileSync(path.join(root, "tmp", "prepared-report-benchmark.json"), JSON.stringify(result, null, 2));
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } finally {
    await queue.idle(); queue.close(); database.close();
    const resolved = path.resolve(directory), tempRoot = path.resolve(os.tmpdir()) + path.sep;
    if (resolved.startsWith(tempRoot) && path.basename(resolved).startsWith("klinvekt-ready-benchmark-")) fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch(error => { process.stderr.write(String(error.stack || error) + "\n"); process.exitCode = 1; });
