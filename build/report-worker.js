"use strict";
// This source follows the unchanged core/parsers/metrics inside a dedicated Worker.
function reportWorkerSnapshot(source, ids) {
  const pick = entries => Object.fromEntries(ids.filter(id => Object.hasOwn(entries || {}, id)).map(id => [id, entries[id]]));
  const months = {};
  for (const [key, month] of Object.entries(source.months)) {
    const copy = emptyMonth();
    for (const field of ["vyrabotka", "kb", "naznach", "prostoy", "zapis", "manual6"]) {
      copy[field] = pick(month[field]);
      // Preserve implicit import coverage from old databases, including other doctors.
      copy.importedReports[field] = monthReportImported(month, field);
    }
    copy.pervichka = Object.fromEntries(Object.entries(month.pervichka || {}).map(([window, value]) =>
      [window, { ...value, perDoc: pick(value.perDoc) }]));
    months[key] = copy;
  }
  return { settings: source.settings, doctors: source.doctors, months };
}

function prepareReportCalculations(job) {
  preparedMetricsForRender = new Map();
  const months = Object.keys(DB.months).sort();
  const yearMonths = months.filter(key => key.startsWith(job.month.slice(0, 4)) && key <= job.month);
  const keys = [...new Set([...yearMonths, job.month, prevMonthKey(job.month)])];
  if (job.tab === "doctor") {
    for (const key of keys) { computeMetrics(job.doctorId, key); adminClientBaseSummary(job.doctorId, key); }
  } else {
    // Summaries need their entire cohort; never substitute a partially computed sum.
    for (const key of keys) {
      for (const id of doctorsInMonth(key)) computeMetrics(id, key);
      aggregateDeptMonth(key, job.filter, job.subFilter || "all");
    }
  }
  const metrics = [...preparedMetricsForRender];
  preparedMetricsForRender = null;
  // Large patient registries are not needed to paint a summary or historical chart.
  // Keep them in the worker; restore their lazy getters only when a list/export asks.
  for (const [, result] of _deptCache) {
    for (const base of [result?.akb?.primary, ...Object.values(result?.akb?.wins || {})]) {
      if (base?.clientRows) Object.defineProperty(base, "clientRows", { enumerable: false });
    }
  }
  for (const [key, base] of _adminBaseCache) {
    if (base && JSON.parse(key)[1] !== job.month) Object.defineProperty(base, "clientRows", { enumerable: false });
  }
  return { metrics, kbSummary: [..._kbSummaryCache], adminBase: [..._adminBaseCache], department: [..._deptCache] };
}

function adoptReportCalculations(prepared) {
  const attachRows = (value, id, month, window) => {
    if (value) Object.defineProperty(value, "clientRows", { configurable: true, enumerable: false,
      get() { return kbClientRows(id, month, window, value); } });
  };
  for (const [key, value] of prepared.kbSummary) {
    const [id, month, window] = JSON.parse(key);
    attachRows(value, id, month, window);
    metricsCacheSet(_kbSummaryCache, key, value, METRICS_CACHE_LIMITS.kbSummary);
  }
  for (const [key, value] of prepared.metrics) {
    const [id, month] = JSON.parse(key);
    for (const [window, base] of Object.entries(value?.akb?.wins || {})) attachRows(base, id, month, Number(window));
    if (value?.akb?.primary) attachRows(value.akb.primary, id, month, value.akb.primary.window);
    metricsCacheSet(_mcCache, key, value, METRICS_CACHE_LIMITS.metrics);
  }
  for (const [name, cache] of [["adminBase", _adminBaseCache], ["department", _deptCache]]) {
    for (const [key, value] of prepared[name]) {
      if (value && name === "adminBase" && !Object.hasOwn(value, "clientRows")) {
        const [id, month] = JSON.parse(key);
        Object.defineProperty(value, "clientRows", { enumerable: true, configurable: true,
          get() { const rows = partitionClientBase(kbSummary(id, month, 36), deptParams(id))?.clientRows || [];
            Object.defineProperty(value, "clientRows", { value: rows, enumerable: true, configurable: true }); return rows; } });
      }
      if (value && name === "department") {
        let details = null;
        const [month, filter, subFilter, ids] = JSON.parse(key);
        const bind = (base, window) => {
          if (base && !Object.hasOwn(base, "clientRows")) Object.defineProperty(base, "clientRows", { enumerable: true, configurable: true,
            get() { details ||= aggregateDeptMonthRaw(month, filter, subFilter, ids);
              return (window === "primary" ? details?.akb?.primary : details?.akb?.wins[window])?.clientRows || []; } });
        };
        bind(value.akb?.primary, "primary");
        for (const [window, base] of Object.entries(value.akb?.wins || {})) bind(base, window);
      }
      metricsCacheSet(cache, key, value, METRICS_CACHE_LIMITS[name]);
    }
  }
}
