"use strict";
let reportTask = null, reportTaskNumber = 0;
const preparedReportKeys = new Map();

function cancelReportPreparation() {
  reportTaskNumber++;
  if (reportTask) { reportTask.worker.terminate(); reportTask.resolve(false); reportTask = null; }
}

function reportCalculationJob(tab) {
  const months = monthKeysSorted();
  if (!months.length) return null;
  const monthField = tab === "doctor" ? "docMonth" : tab === "department" ? "departmentMonth" : "deptMonth";
  if (!DB.months[UI[monthField]]) UI[monthField] = months.at(-1);
  const month = UI[monthField];
  const select = document.getElementById(monthField);
  select.innerHTML = months.map(key => `<option value="${key}" ${key === month ? "selected" : ""}>${monthLabel(key)}</option>`).join("");
  select.disabled = false;
  if (tab === "doctor") {
    const core = coreDoctorsInMonth(month), ids = sortDoctorIdsAlphabetically(core.length ? core : doctorsInMonth(month));
    if (!ids.includes(UI.docId)) UI.docId = ids[0];
    const doctors = document.getElementById("docSelect");
    doctors.innerHTML = ids.map(id => `<option value="${esc(id)}" ${id === UI.docId ? "selected" : ""}>${esc(doctorName(id))}</option>`).join("");
    doctors.disabled = !ids.length;
    return UI.docId ? { tab, month, doctorId: UI.docId } : null;
  }
  if (tab === "department") {
    const groups = departmentGroups();
    if (UI.departmentFilter !== "all" && !groups[UI.departmentFilter]) UI.departmentFilter = "all";
    const select = document.getElementById("departmentFilter");
    select.innerHTML = '<option value="all">все отделения</option>' + Object.keys(groups).map(name => `<option value="${esc(name)}" ${name === UI.departmentFilter ? "selected" : ""}>${esc(name)}</option>`).join("");
    select.disabled = false;
    return { tab, month, filter: departmentSpecializations(UI.departmentFilter), department: UI.departmentFilter };
  }
  const names = deptListForMonth(month, doctorsForScopeInMonth(month, UI.deptFilter !== "all"));
  if (!names.includes(UI.deptFilter)) UI.deptFilter = "all";
  const selectFilter = document.getElementById("deptFilter");
  selectFilter.innerHTML = '<option value="all">все специализации</option>' + names.map(name => `<option value="${esc(name)}" ${name === UI.deptFilter ? "selected" : ""}>${esc(name)}</option>`).join("");
  selectFilter.disabled = false;
  const subs = UI.deptFilter === "all" ? [] : deptProfile(UI.deptFilter).subdivisions || [];
  if (UI.subFilter !== "all" && !subs.includes(UI.subFilter)) UI.subFilter = "all";
  return { tab, month, filter: UI.deptFilter, subFilter: UI.subFilter };
}

function renderPreparedReport(tab, draw) {
  cancelReportPreparation();
  if (!UI.reportEager) document.getElementById(tab === "doctor" ? "doctorBody" : tab === "department" ? "departmentBody" : "deptBody")?.removeAttribute?.("data-report-export");
  if (UI.reportEager || typeof Worker !== "function") return draw();
  const job = reportCalculationJob(tab);
  if (!job) return draw();
  const key = JSON.stringify([metricsCalculationRevision, job]);
  const cached = preparedReportKeys.get(key);
  if (cached && cached.every(([name, keys]) => keys.every(key => ({ metrics: _mcCache, kbSummary: _kbSummaryCache, adminBase: _adminBaseCache, department: _deptCache })[name].has(key)))) return draw();
  const body = document.getElementById(tab === "doctor" ? "doctorBody" : tab === "department" ? "departmentBody" : "deptBody");
  body.innerHTML = '<div class="card" role="status">Подготавливается отчёт…</div>';
  const number = reportTaskNumber, revision = metricsCalculationRevision;
  const ids = tab === "doctor" ? [job.doctorId] : Object.keys(DB.doctors);
  const snapshot = reportWorkerSnapshot(DB, ids);
  const sources = ["report-core-source", "report-parsers-source", "report-metrics-source", "report-worker-source"].map(id => document.getElementById(id)?.textContent);
  if (sources.some(source => !source)) return draw();
  const bootstrap = 'const window = {}; const localStorage = {getItem(){return null},setItem(){}};\n';
  const handler = '\nonmessage = event => { try { const m=event.data; if(m.type==="start") { DB=m.snapshot;clearMetricsCache(); } else if(m.type==="month") DB.months[m.key]=m.month; else if(m.type==="calculate") postMessage({prepared:prepareReportCalculations(m.job)}); } catch(error) { postMessage({error:error.message}); } };';
  const url = URL.createObjectURL(new Blob([bootstrap, ...sources.map(source => source + "\n"), handler], { type: "text/javascript" }));
  let worker;
  try { worker = new Worker(url); } catch (error) { URL.revokeObjectURL(url); return draw(); }
  URL.revokeObjectURL(url);
  return new Promise((resolve, reject) => {
    const started = performance.now();
    reportTask = { worker, resolve };
    const finish = message => {
      worker.terminate();
      if (number !== reportTaskNumber) return resolve(false);
      reportTask = null;
      if (revision !== metricsCalculationRevision) { resolve(false); renderPreparedReport(tab, draw); return; }
      if (message.prepared) {
        adoptReportCalculations(message.prepared);
        preparedReportKeys.set(key, Object.entries(message.prepared).map(([name, entries]) => [name, entries.map(([key]) => key)]));
        while (preparedReportKeys.size > 6) preparedReportKeys.delete(preparedReportKeys.keys().next().value);
      } else console.warn("Report worker fallback:", message.error);
      const drawAt = performance.now();
      preparedMetricsForRender = message.prepared ? new Map(message.prepared.metrics) : null;
      try { draw(); } catch (error) { reject(error); return; } finally { preparedMetricsForRender = null; }
      UI.reportTiming = { tab, backgroundMs: drawAt - started, renderMs: performance.now() - drawAt, worker: Boolean(message.prepared) };
      resolve(true);
    };
    worker.onmessage = event => finish(event.data);
    worker.onerror = event => { event.preventDefault(); finish({ error: event.message }); };
    // Let the loading state paint before copying the selected doctor's data.
    requestAnimationFrame(async () => {
      if (number !== reportTaskNumber) return;
      try {
        worker.postMessage({ type: "start", snapshot: { ...snapshot, months: {} } });
        // A single large structured clone can itself stall the caller. Copy months
        // separately and return control between messages; the worker processes them in order.
        for (const [key, month] of Object.entries(snapshot.months)) {
          if (number !== reportTaskNumber) return;
          worker.postMessage({ type: "month", key, month });
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        if (number === reportTaskNumber) worker.postMessage({ type: "calculate", job });
      } catch (error) { if (number === reportTaskNumber) finish({ error: error.message }); }
    });
  });
}

const pendingReportCharts = new Map();
let reportChartObserver = null;
function createPendingReportChart(id) {
  const pending = pendingReportCharts.get(id);
  if (!pending) return;
  pendingReportCharts.delete(id);
  reportChartObserver?.unobserve(pending.element);
  if (!pending.element.isConnected) { delete UI.charts[id]; return; }
  const metadata = UI.charts[id];
  const instance = new Chart(pending.element.getContext("2d"), pending.config);
  for (const key of Object.keys(metadata || {})) if (key.startsWith("$")) instance[key] = metadata[key];
  UI.charts[id] = instance;
}
function flushReportCharts() { for (const id of [...pendingReportCharts.keys()]) createPendingReportChart(id); }
function queueReportChart(id, element, config) {
  if (UI.reportEager || typeof IntersectionObserver !== "function") { UI.charts[id] = new Chart(element.getContext("2d"), config); return; }
  if (!reportChartObserver) reportChartObserver = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) createPendingReportChart(entry.target.id);
  }, { rootMargin: "150px" });
  pendingReportCharts.set(id, { element, config });
  UI.charts[id] = { config, data: config.data, options: config.options, stop() {},
    destroy() { pendingReportCharts.delete(id); reportChartObserver.unobserve(element); }, update() {}, resize() {} };
  reportChartObserver.observe(element);
}
