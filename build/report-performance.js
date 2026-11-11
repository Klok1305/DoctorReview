"use strict";
let reportTask = null, reportTaskNumber = 0;
const preparedReportKeys = new Map();
const preparedSpecializationYears = new Map();
let specializationYearTask = null;
const desktopReportYearTasks = new Map();
let reportPreparationTimer = null;
let reportPreparationStatusOwner = null;

function reportPreparationMessage(progress, year) {
  if (progress.stage === "load") return `Загружаем готовые отчёты за ${year} год…`;
  if (progress.stage === "save") return `Сохраняем готовые отчёты за ${year} год…`;
  if (progress.stage === "ready") return `Отчёты за ${year} год готовы`;
  return `Готовим отчёты врачей, отделений и специализаций за ${year} год · ${progress.completed} из ${progress.total} месяцев`;
}

function setReportPreparationStatus(task, progress) {
  const box = document.getElementById("reportPreparationStatus");
  if (!box) return;
  if (!progress) {
    if (reportPreparationStatusOwner === task) { box.classList.add("hidden"); reportPreparationStatusOwner = null; }
    return;
  }
  reportPreparationStatusOwner = task;
  box.classList.remove("hidden");
  const label = document.getElementById("reportPreparationLabel");
  const bar = document.getElementById("reportPreparationBar");
  if (label) label.textContent = reportPreparationMessage(progress, task.year);
  if (bar) {
    bar.max = Math.max(1, progress.total || 1);
    bar.value = progress.completed || 0;
  }
}

function prepareDesktopReportYear(month, onProgress) {
  const year = month.slice(0, 4), revision = metricsCalculationRevision;
  const ready = readySpecializationYear(year);
  if (ready) return Promise.resolve(ready);
  const existing = desktopReportYearTasks.get(year);
  if (existing?.revision === revision) {
    if (onProgress) { existing.listeners.add(onProgress); if (existing.progress) onProgress(existing.progress); }
    return existing.promise;
  }
  existing?.finish({});
  const task = { year, revision, operationId: crypto.randomUUID(), listeners: new Set(onProgress ? [onProgress] : []) };
  desktopReportYearTasks.set(year, task);
  task.promise = new Promise(resolve => {
    let settled = false, unsubscribe;
    task.finish = ({ prepared, error, fromCache }) => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      if (desktopReportYearTasks.get(year) === task) desktopReportYearTasks.delete(year);
      setReportPreparationStatus(task, null);
      if (!prepared) DESKTOP_API.cancelBackgroundOperation?.(task.operationId)?.catch(() => {});
      if (error && error.name !== "AbortError" && error.name !== "ReportDataChangedError") console.warn("Report preparation:", error);
      if (!prepared || revision !== metricsCalculationRevision) return resolve(null);
      hydratePreparedReportYear(prepared);
      preparedSpecializationYears.set(year, { revision, prepared, fromCache });
      const selectedMonth = UI.tab === "doctor" ? UI.docMonth : UI.tab === "department" ? UI.departmentMonth
        : UI.tab === "dept" ? UI.deptMonth : monthKeysSorted().at(-1);
      const selectedYear = selectedMonth?.slice(0, 4);
      while (preparedSpecializationYears.size > 2) {
        const discard = [...preparedSpecializationYears.keys()].find(key => key !== year && key !== selectedYear)
          || preparedSpecializationYears.keys().next().value;
        preparedSpecializationYears.delete(discard);
      }
      resolve(prepared);
    };
    const progress = value => {
      if (settled || revision !== metricsCalculationRevision) return;
      task.progress = value;
      setReportPreparationStatus(task, value);
      for (const listener of task.listeners) listener(value);
    };
    progress({ stage: "load", completed: 0, total: 1, year });
    unsubscribe = DESKTOP_API.onBackgroundProgress?.(value => {
      if (value.operationId === task.operationId) progress(value);
    });
    (async () => {
      // Allow normalization/settings saves to enter the serial database writer first.
      await new Promise(resolve => setTimeout(resolve, 0));
      if (typeof desktopWriterPromise !== "undefined" && desktopWriterPromise) await desktopWriterPromise;
      if (settled || revision !== metricsCalculationRevision) return task.finish({});
      const result = await DESKTOP_API.prepareReportYear({ year, operationId: task.operationId });
      if (result.dataRevision !== desktopDataRevision) return task.finish({});
      task.finish(result);
    })().catch(error => task.finish({ error }));
  });
  return task.promise;
}

async function prepareAllReports(onProgress) {
  const revision = metricsCalculationRevision;
  const latestMonths = [...new Map(monthKeysSorted().map(month => [month.slice(0, 4), month])).values()].reverse();
  for (const [index, month] of latestMonths.entries()) {
    if (revision !== metricsCalculationRevision || fileImportCancelRequested) return false;
    const prepared = await prepareSpecializationYear(month, progress => onProgress?.({ ...progress, year: month.slice(0, 4),
      completedYears: index, totalYears: latestMonths.length }));
    if (!prepared && (DESKTOP_API?.prepareReportYear || typeof Worker === "function")) return false;
  }
  return revision === metricsCalculationRevision;
}

function scheduleReportPreparation() {
  cancelSpecializationPreparation();
  if (reportPreparationTimer) clearTimeout(reportPreparationTimer);
  if (!DESKTOP_API?.prepareReportYear || typeof fileImportInProgress !== "undefined" && fileImportInProgress || UI.reportEager) return;
  reportPreparationTimer = setTimeout(() => {
    reportPreparationTimer = null;
    prepareAllReports().catch(error => console.warn("Report preparation:", error));
  }, 600);
}

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

function createReportWorker() {
  const sources = ["report-core-source", "report-parsers-source", "report-metrics-source", "report-worker-source"].map(id => document.getElementById(id)?.textContent);
  if (sources.some(source => !source) || typeof Worker !== "function") return null;
  const bootstrap = 'const window = {}; const localStorage = {getItem(){return null},setItem(){}};\n';
  const handler = `
onmessage = event => {
  try {
    const m = event.data;
    if (m.type === "start") { DB = m.snapshot; clearMetricsCache(); }
    else if (m.type === "month") DB.months[m.key] = m.month;
    else if (m.type === "specializations") {
      const prepared = prepareSpecializationCalculations(m.year, (completed, total) => postMessage({ progress: { completed, total } }));
      postMessage({ prepared });
    } else if (m.type === "calculate") postMessage({ prepared: prepareReportCalculations(m.job) });
  } catch (error) { postMessage({ error: error.message }); }
};`;
  const url = URL.createObjectURL(new Blob([bootstrap, ...sources.map(source => source + "\n"), handler], { type: "text/javascript" }));
  try { return new Worker(url); }
  catch (_) { return null; }
  finally { URL.revokeObjectURL(url); }
}

async function sendReportWorkerData(worker, ids, command, isCurrent) {
  await new Promise(resolve => requestAnimationFrame(resolve));
  if (!isCurrent()) return;
  const snapshot = reportWorkerSnapshot(DB, ids);
  worker.postMessage({ type: "start", snapshot: { ...snapshot, months: {} } });
  // Copy months separately so structured cloning can yield between large messages.
  for (const [key, month] of Object.entries(snapshot.months)) {
    if (!isCurrent()) return;
    worker.postMessage({ type: "month", key, month });
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  if (isCurrent()) worker.postMessage(command);
}

function readySpecializationYear(year) {
  const entry = preparedSpecializationYears.get(year);
  if (entry?.revision !== metricsCalculationRevision) return null;
  preparedSpecializationYears.delete(year);
  preparedSpecializationYears.set(year, entry);
  return entry.prepared;
}

function cancelSpecializationPreparation() {
  specializationYearTask?.finish({});
  for (const task of [...desktopReportYearTasks.values()]) task.finish({});
}

function prepareSpecializationYear(month, onProgress) {
  if (!month) return Promise.resolve(null);
  if (typeof DESKTOP_API !== "undefined" && DESKTOP_API?.prepareReportYear) return prepareDesktopReportYear(month, onProgress);
  const year = month.slice(0, 4), revision = metricsCalculationRevision;
  const ready = readySpecializationYear(year);
  if (ready) return Promise.resolve(ready);
  if (specializationYearTask?.year === year && specializationYearTask.revision === revision) {
    if (onProgress) {
      specializationYearTask.onProgress = onProgress;
      if (specializationYearTask.progress) onProgress(specializationYearTask.progress);
    }
    return specializationYearTask.promise;
  }
  cancelSpecializationPreparation();
  const worker = createReportWorker();
  if (!worker) return Promise.resolve(null);
  const task = { year, revision, onProgress, progress: null };
  specializationYearTask = task;
  task.promise = new Promise(resolve => {
    const isCurrent = () => specializationYearTask === task && revision === metricsCalculationRevision;
    task.finish = ({ prepared, error }) => {
      if (specializationYearTask !== task) return;
      worker.terminate();
      specializationYearTask = null;
      if (error) console.warn("Specialization preparation:", error);
      if (!prepared || revision !== metricsCalculationRevision) return resolve(null);
      preparedSpecializationYears.set(year, { revision, prepared });
      while (preparedSpecializationYears.size > 2) preparedSpecializationYears.delete(preparedSpecializationYears.keys().next().value);
      resolve(prepared);
    };
    worker.onmessage = ({ data }) => {
      if (!data.progress || !isCurrent()) return task.finish(data);
      task.progress = data.progress;
      task.onProgress?.(data.progress);
    };
    worker.onerror = event => { event.preventDefault(); task.finish({ error: event.message }); };
    sendReportWorkerData(worker, Object.keys(DB.doctors), { type: "specializations", year }, isCurrent)
      .then(() => { if (!isCurrent()) task.finish({}); }, error => task.finish({ error: error.message }));
  });
  return task.promise;
}

function drawPreparedSpecialization(draw, prepared) {
  if (!prepared) return draw();
  const previousCalculations = specializationCalculations, previousMetrics = preparedMetricsForRender;
  specializationCalculations = prepared;
  preparedMetricsForRender = prepared.metrics;
  try { return draw(); }
  finally { specializationCalculations = previousCalculations; preparedMetricsForRender = previousMetrics; }
}

function renderPreparedSpecialization(draw, tab = "dept") {
  if (viewerReportDoctorScope) return draw();
  const body = document.getElementById(tab === "doctor" ? "doctorBody" : tab === "department" ? "departmentBody" : "deptBody");
  if (typeof fileImportInProgress !== "undefined" && fileImportInProgress && !UI.reportEager) {
    body.innerHTML = '<div class="card" role="status">Обрабатываются загруженные файлы. Отчёт откроется после завершения подготовки.</div>';
    return false;
  }
  const eager = UI.reportEager || typeof Worker !== "function";
  const monthField = tab === "doctor" ? "docMonth" : tab === "department" ? "departmentMonth" : "deptMonth";
  const month = eager
    ? (DB.months[UI[monthField]] ? UI[monthField] : monthKeysSorted().at(-1))
    : reportCalculationJob(tab)?.month;
  if (!month) return draw();
  const ready = readySpecializationYear(month.slice(0, 4));
  if (ready || eager) {
    const started = performance.now();
    const result = drawPreparedSpecialization(draw, ready);
    UI.reportTiming = { tab, backgroundMs: 0, renderMs: performance.now() - started, worker: Boolean(ready),
      persisted: preparedSpecializationYears.get(month.slice(0, 4))?.fromCache === true };
    return result;
  }
  body.innerHTML = '<div class="card" role="status">Подготавливаются готовые отчёты…</div>';
  const number = reportTaskNumber, revision = metricsCalculationRevision, started = performance.now();
  return prepareSpecializationYear(month).then(prepared => {
    if (number !== reportTaskNumber) return false;
    if (revision !== metricsCalculationRevision) return renderPreparedReport(tab, draw);
    const drawAt = performance.now();
    drawPreparedSpecialization(draw, prepared);
    UI.reportTiming = { tab, backgroundMs: drawAt - started, renderMs: performance.now() - drawAt, worker: Boolean(prepared),
      persisted: preparedSpecializationYears.get(month.slice(0, 4))?.fromCache === true };
    return true;
  });
}

function renderPreparedReport(tab, draw) {
  cancelReportPreparation();
  if (!UI.reportEager) document.getElementById(tab === "doctor" ? "doctorBody" : tab === "department" ? "departmentBody" : "deptBody")?.removeAttribute?.("data-report-export");
  if (tab === "dept" || typeof DESKTOP_API !== "undefined" && DESKTOP_API?.prepareReportYear) return renderPreparedSpecialization(draw, tab);
  if (UI.reportEager || typeof Worker !== "function") return draw();
  const job = reportCalculationJob(tab);
  if (!job) return draw();
  const key = JSON.stringify([metricsCalculationRevision, job]);
  const cached = preparedReportKeys.get(key);
  const caches = { metrics: _mcCache, kbSummary: _kbSummaryCache, adminBase: _adminBaseCache, department: _deptCache,
    specializationBase: _specializationBaseCache };
  if (cached && cached.every(([name, keys]) => keys.every(key => caches[name].has(key)))) return draw();
  const body = document.getElementById(tab === "doctor" ? "doctorBody" : tab === "department" ? "departmentBody" : "deptBody");
  body.innerHTML = '<div class="card" role="status">Подготавливается отчёт…</div>';
  const number = reportTaskNumber, revision = metricsCalculationRevision;
  const ids = tab === "doctor" ? [job.doctorId] : Object.keys(DB.doctors);
  const worker = createReportWorker();
  if (!worker) return draw();
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
    sendReportWorkerData(worker, ids, { type: "calculate", job }, () => number === reportTaskNumber)
      .catch(error => { if (number === reportTaskNumber) finish({ error: error.message }); });
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
