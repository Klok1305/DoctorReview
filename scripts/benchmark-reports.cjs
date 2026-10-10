"use strict";
// Synthetic reports only. Absolute timings are observations, not CI thresholds.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { Worker } = require("node:worker_threads"), { performance } = require("node:perf_hooks"), crypto = require("node:crypto");
const { createStandaloneViewerHtml } = require("../desktop/services/viewer-package-service.cjs");
const { createReportRenderCache } = require("../mobile-server/cloud-report-renderer.cjs");
const root = path.resolve(__dirname, "..");
const metricsSource = ["app-core.js", "app-parsers.js", "app-metrics.js", "report-worker.js"].map(file => fs.readFileSync(path.join(root, "build", file), "utf8")).join("\n");
function context() { const c = vm.createContext({ console, window: {}, localStorage: { getItem() { return null; }, setItem() {} }, Intl }); vm.runInContext(metricsSource, c); return c; }
async function responsiveTiming(action) {
  let last = performance.now(), maxGap = 0, ticks = 0;
  const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++; }, 5);
  await new Promise(resolve => setTimeout(resolve, 15));
  const start = performance.now(); await action(); const ms = performance.now() - start;
  await new Promise(resolve => setTimeout(resolve, 15)); clearInterval(timer);
  return { ms, maxEventGapMs: maxGap, ticks };
}
async function main() {
  fs.mkdirSync(path.join(root, "tmp"), { recursive: true });
  const c = context();
  vm.runInContext(`
    DB.doctors={};DB.months={};
    for(let d=0;d<10;d++) DB.doctors['d'+d]={name:'Синтетический Врач '+d,aliases:[],department:'Косметология',specialization:'Косметология'};
    for(let n=1;n<=12;n++) {const m=DB.months['2026-'+String(n).padStart(2,'0')]=emptyMonth();
      for(const id of Object.keys(DB.doctors)) {m.vyrabotka[id]={items:[{n:'Прием',q:1,sOwn:1000,sRef:100,goods:false}]};
        m.kb[id]=Object.fromEntries([1,12,36].map(win=>[win,{clients:Array.from({length:500},(_,i)=>({name:'Синтетический Пациент '+i,patientId:id+'-'+i,s:1000+i,v:i%6+1,r:i%900}))}]));
      }
    } clearMetricsCache();
  `, c);
  c.job = { tab: "department", filter: "all", month: "2026-12" };
  let expected;
  const direct = await responsiveTiming(() => { expected = vm.runInContext("prepareReportCalculations(job)", c); });
  const snapshot = vm.runInContext("reportWorkerSnapshot(DB,Object.keys(DB.doctors))", c);
  let prepared;
  const background = await responsiveTiming(() => new Promise((resolve, reject) => {
    const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'),vm=require('node:vm');
      const c=vm.createContext({window:{},localStorage:{getItem(){return null},setItem(){}},Intl});vm.runInContext(workerData.source,c);
      parentPort.on('message',m=>{if(m.type==='start'){c.snapshot=m.snapshot;vm.runInContext('DB=snapshot;clearMetricsCache()',c);}else if(m.type==='month'){c.key=m.key;c.month=m.month;vm.runInContext('DB.months[key]=month',c);}else{c.job=m.job;parentPort.postMessage(vm.runInContext('prepareReportCalculations(job)',c));}});`, { eval: true, workerData: { source: metricsSource } });
    worker.once("message", result => { prepared = result; worker.terminate(); resolve(); });
    worker.once("error", reject);
    (async () => {
      worker.postMessage({ type: 'start', snapshot: { ...snapshot, months: {} } });
      for (const [key, month] of Object.entries(snapshot.months)) { worker.postMessage({ type: 'month', key, month }); await new Promise(resolve => setTimeout(resolve, 0)); }
      worker.postMessage({ type: 'calculate', job: c.job });
    })().catch(reject);
  }));
  assert.equal(JSON.stringify(prepared), JSON.stringify(expected));
  const charts = Array.from({ length: 24 }, (_, i) => ({ id: 'chart-' + i, title: 'Синтетический график ' + i, type: 'line', unit: '₽', labels: Array.from({ length: 12 }, (_, n) => 'Месяц ' + (n + 1)),
    series: [{ label: 'Выручка', values: Array.from({ length: 12 }, (_, n) => n === 4 ? null : n * 12345) }, { label: 'С перенаправлениями', values: Array.from({ length: 12 }, (_, n) => n * 23456) }] }));
  const chartApi = require("../mobile-pilot/report-charts.js");
  let chartBefore = null;
  if (process.env.KLINVEKT_BENCHMARK_CHARTS_SOURCE) {
    const before = require(path.resolve(process.env.KLINVEKT_BENCHMARK_CHARTS_SOURCE));
    const start = performance.now(); const html = before.renderCharts(charts); chartBefore = performance.now() - start;
    assert.equal(chartApi.renderCharts(charts), html, "formatter reuse must preserve every value and SVG coordinate");
  }
  const start = performance.now(); const eager = chartApi.renderCharts(charts); const chartAfter = performance.now() - start;
  const report = { assessment: '', summary: '', overall: 42, headlineMetrics: [], vectors: [{ id: 'v1', number: 1, title: 'Экономика', score: 42, sections: [{ title: 'Динамика', charts }] }] };
  const cache = createReportRenderCache(), page = { pageId: 'bench', title: 'Синтетический отчёт', report };
  const coldAt = performance.now(), lazy = cache.render(page), onlineColdMs = performance.now() - coldAt;
  const warmAt = performance.now(); assert.equal(cache.render(page), lazy); const onlineWarmMs = performance.now() - warmAt;

  const doctors = [{ doctorId: 'synthetic', displayName: 'Синтетический Врач', department: 'Косметология', specialization: 'Косметология' }];
  const periods = Array.from({ length: 12 }, (_, i) => '2026-' + String(i + 1).padStart(2, '0'));
  const rows = Array.from({ length: 2000 }, (_, i) => `<tr><td>Синтетическая строка ${i}</td><td>${crypto.randomBytes(24).toString('hex')}</td></tr>`).join('');
  const pages = periods.map(periodKey => ({ doctorId: 'synthetic', periodKey, pageType: 'doctor', scopeId: 'synthetic', title: periodKey, html: `<div class="card"><h1>${periodKey}</h1><p>Комментарий ${periodKey}</p><table>${rows}</table></div>` }));
  const created = await createStandaloneViewerHtml({ appVersion: 'benchmark', periods, doctors, subjects: doctors, pages, credentials: { admin: { pinCode: '654321' }, doctors: [{ doctorId: 'synthetic', active: true, pinCode: '0123' }] } });
  const html = created.buffer.toString('utf8');
  const bundle = JSON.parse(html.match(/<script id="standaloneViewerData" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  const browserContext = vm.createContext({ window: { crypto: crypto.webcrypto }, crypto: crypto.webcrypto, atob, Blob, DecompressionStream, Response, TextDecoder, TextEncoder, Uint8Array,
    document: { getElementById: () => ({ textContent: JSON.stringify(bundle) }) } });
  vm.runInContext(fs.readFileSync(path.join(root, 'viewer/standalone-app.js'), 'utf8').replace(/\ninitialize\(\);\s*$/, '') + '\nglobalThis.access=decryptAdmin;globalThis.openPage=decryptSharedStandalonePage;', browserContext);
  const access = await browserContext.access('654321');
  assert.equal(access.reportLoader.stats().decryptions, 0);
  const eagerStart = performance.now();
  for (const binding of access.bindings) await browserContext.openPage(bundle.sharedPages.find(page => page.pageId === binding.pageId), access.pageKeys[binding.pageId], access.reportRevision);
  const allPagesMs = performance.now() - eagerStart;
  const oneStart = performance.now(); const selected = await access.reportLoader(access.reports.at(-1)); const selectedPageMs = performance.now() - oneStart;
  assert.match(selected.html, /Комментарий/); assert.equal(access.reportLoader.stats().decryptions, 1);
  const repeatStart = performance.now(); await access.reportLoader(access.reports.at(-1)); const repeatPageMs = performance.now() - repeatStart;
  for (const item of access.reports) await access.reportLoader(item);
  assert.ok(access.reportLoader.stats().pages <= 6);

  const result = { dataset: { doctors: 10, months: 12, patientsPerWindow: 500, charts: charts.length, htmlPages: pages.length }, admin: { direct, background },
    charts: { beforeMs: chartBefore, afterMs: chartAfter }, online: { coldMs: onlineColdMs, warmMs: onlineWarmMs, eagerChartBytes: Buffer.byteLength(eager), deferredPageBytes: Buffer.byteLength(lazy) },
    standalone: { allPagesMs, selectedPageMs, repeatPageMs, cache: access.reportLoader.stats() } };
  if (process.argv.includes('--webkit')) {
    const { webkit, devices } = require('@playwright/test');
    const filePath = path.join(root, 'tmp/report-performance-standalone.html'); fs.writeFileSync(filePath, created.buffer);
    const browser = await webkit.launch({ headless: true });
    try {
      for (const viewport of [{ width: 1440, height: 900 }, devices['iPhone 13']]) {
        const ctx = await browser.newContext(viewport.width ? { viewport } : viewport), tab = await ctx.newPage(), errors = [];
        tab.on('pageerror', error => errors.push(error.message));
        await tab.goto(require('node:url').pathToFileURL(filePath).href);
        await tab.locator('#viewerAdminPin').fill('654321'); await tab.locator('#btnAdminLogin').click();
        await tab.locator('#viewerReportBody h1').waitFor();
        assert.equal(await tab.evaluate(() => state.reportLoader.stats().decryptions), 1);
        await tab.evaluate(async () => { state.periodKey='2026-01'; const old=loadReport(); state.periodKey='2026-03'; await loadReport(); await old; });
        assert.equal(await tab.locator('#viewerReportBody h1').textContent(), '2026-03');
        await tab.locator('#viewerPeriod').selectOption('2026-12'); await tab.locator('#viewerReportBody h1', { hasText: '2026-12' }).waitFor();
        assert.equal(await tab.evaluate(() => state.reportLoader.stats().decryptions), 3, "return uses the decoded page cache");
        await tab.screenshot({ path: path.join(root, 'tmp', `report-performance-html-${viewport.width ? 'pc' : 'iphone'}.png`) });
        await tab.evaluate(async () => { state.periodKey='2026-04'; const loading=loadReport(); logoutDoctor(); await loading; });
        assert.equal(await tab.locator('#viewerReportBody').textContent(), '');
        assert.equal(await tab.evaluate(() => state.reportLoader), null);
        assert.deepEqual(errors, []); await ctx.close();
      }
      result.webkit = 'PC/iPhone: selected page, rapid navigation, cache reuse and logout passed';
    } finally { await browser.close(); fs.rmSync(filePath, { force: true }); }
  }
  fs.writeFileSync(path.join(root, 'tmp/report-performance-benchmark.json'), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
