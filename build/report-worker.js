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
    copy.primaryPatients = month.primaryPatients?.perDoc ? { ...month.primaryPatients, perDoc: pick(month.primaryPatients.perDoc) } : {};
    months[key] = copy;
  }
  return { settings: source.settings, doctors: source.doctors, months };
}

function prepareSpecializationCalculations(year, onProgress = () => {}) {
  const months = monthKeysSorted();
  const yearMonths = months.filter(month => month.startsWith(year + "-"));
  const previousDecember = `${Number(year) - 1}-12`;
  const calculationMonths = months.includes(previousDecember) ? [previousDecember, ...yearMonths] : yearMonths;
  const filters = new Set(yearMonths.flatMap(month => deptListForMonth(month, doctorsInMonth(month))));
  const scopes = [["all", "all"]];
  for (const filter of filters) {
    scopes.push([filter, "all"]);
    for (const subdivision of deptProfile(filter).subdivisions || []) scopes.push([filter, subdivision]);
  }
  const windows = [6, 12, 24, 36];
  const prepared = { metrics: new Map(), department: new Map(), reportBase: new Map(), basePoints: new Map(), activity: new Map(),
    kbSummary: new Map(), adminBase: new Map(), primaryPatients: new Map() };
  const departmentScopes = [...new Map(["all", ...Object.keys(departmentGroups())]
    .flatMap(name => { const filters = departmentSpecializations(name); return [filters, ...filters.map(filter => [filter])]; })
    .map(filter => [JSON.stringify([...filter].sort()), filter])).values()];
  const deviceNames = new Map([...filters].map(filter => [filter, specializationDeviceNames(deptProfile(filter))]));
  if (!yearMonths.length) return prepared;
  specializationCalculations = prepared;
  preparedMetricsForRender = prepared.metrics;
  try {
    onProgress(0, calculationMonths.length);
    for (const [index, month] of calculationMonths.entries()) {
      const previous = prevMonthKey(month);
      for (const id of doctorsInMonth(month)) {
        computeMetrics(id, month);
        adminClientBaseSummary(id, month);
        doctorPrimaryPatients(id, month);
        for (const window of windows) {
          reportClientBaseSummary(id, month, window);
          reportClientBaseSummary(id, previous, window);
        }
      }
      for (const [filter, subFilter] of scopes) {
        const totals = aggregateDeptMonth(month, filter, subFilter);
        specializationActivityMonth(month, filter, subFilter, null, deviceNames.get(filter) || []);
        specializationClientBasePoint(month, filter, subFilter, null);
        // Рендер специализации использует только сводные показатели.
        for (const base of [totals?.akb?.primary, ...Object.values(totals?.akb?.wins || {})]) {
          if (base) delete base.clientRows;
        }
      }
      for (const filter of departmentScopes) {
        const totals = aggregateDeptMonth(month, filter);
        specializationActivityMonth(month, "all", "all", scopeDoctorsInMonth(month, filter), []);
        for (const base of [totals?.akb?.primary, ...Object.values(totals?.akb?.wins || {})]) {
          if (base) delete base.clientRows;
        }
      }
      onProgress(index + 1, calculationMonths.length);
    }
    return prepared;
  } finally {
    specializationCalculations = null;
    preparedMetricsForRender = null;
  }
}

function compactPreparedReportYear(prepared) {
  const strip = base => { if (base) delete base.clientRows; };
  for (const map of [prepared.kbSummary, prepared.adminBase, prepared.reportBase]) for (const base of map.values()) strip(base);
  for (const result of prepared.metrics.values()) {
    strip(result?.akb?.primary);
    for (const base of Object.values(result?.akb?.wins || {})) strip(base);
  }
  for (const result of prepared.department.values()) {
    strip(result?.akb?.primary);
    for (const base of Object.values(result?.akb?.wins || {})) strip(base);
  }
  return prepared;
}

function hydratePreparedReportYear(prepared) {
  const bind = (base, rows) => {
    if (!base || Object.hasOwn(base, "clientRows")) return;
    Object.defineProperty(base, "clientRows", { configurable: true, enumerable: false, get() {
      const value = rows();
      Object.defineProperty(base, "clientRows", { configurable: true, enumerable: false, value });
      return value;
    } });
  };
  const attach = (base, id, month, window) => bind(base, () => base.partition
    ? partitionClientBase(kbSummary(id, month, window), deptParams(id))?.clientRows || []
    : kbClientRows(id, month, window, base));
  for (const name of ["kbSummary", "adminBase", "reportBase"]) for (const [key, base] of prepared[name] || []) {
    const [id, month, window] = JSON.parse(key);
    attach(base, id, month, name === "adminBase" ? 36 : window);
  }
  for (const [key, result] of prepared.metrics) {
    const [id, month] = JSON.parse(key);
    attach(result?.akb?.primary, id, month, result?.akb?.primary?.window);
    for (const [window, base] of Object.entries(result?.akb?.wins || {})) attach(base, id, month, Number(window));
  }
  for (const [key, result] of prepared.department) {
    const [month, filter, subFilter, ids] = JSON.parse(key);
    let details;
    const groupRows = window => {
      details ||= aggregateDeptMonthRaw(month, filter, subFilter, ids);
      return (window === "primary" ? details?.akb?.primary : details?.akb?.wins[window])?.clientRows || [];
    };
    bind(result?.akb?.primary, () => groupRows("primary"));
    for (const [window, base] of Object.entries(result?.akb?.wins || {})) bind(base, () => groupRows(window));
  }
  return prepared;
}

function prepareReportCalculations(job) {
  preparedMetricsForRender = new Map();
  const months = Object.keys(DB.months).sort();
  const yearMonths = months.filter(key => key.startsWith(job.month.slice(0, 4)) && key <= job.month);
  const keys = [...new Set([...yearMonths, job.month, prevMonthKey(job.month)])];
  if (job.tab === "doctor") {
    for (const key of keys) {
      computeMetrics(job.doctorId, key);
      for (const window of [6, 12, 24, 36]) reportClientBaseSummary(job.doctorId, key, window);
    }
  } else {
    // Summaries need their entire cohort; never substitute a partially computed sum.
    for (const key of keys) {
      for (const id of doctorsInMonth(key)) {
        computeMetrics(id, key);
        for (const window of [6, 12, 24, 36]) reportClientBaseSummary(id, key, window);
      }
      aggregateDeptMonth(key, job.filter, job.subFilter || "all");
    }
  }
  const metrics = [...preparedMetricsForRender];
  preparedMetricsForRender = null;
  if (job.tab === "dept") specializationClientBaseHistory(job.month, job.filter, job.subFilter);
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
  return { metrics, kbSummary: [..._kbSummaryCache], adminBase: [..._adminBaseCache], department: [..._deptCache],
    specializationBase: [..._specializationBaseCache] };
}

function adoptReportCalculations(prepared) {
  for (const [key, point] of prepared.specializationBase || []) {
    metricsCacheSet(_specializationBaseCache, key, point, METRICS_CACHE_LIMITS.specializationBase);
  }
  const attachRows = (value, id, month, window) => {
    if (value) Object.defineProperty(value, "clientRows", { configurable: true, enumerable: false,
      get() { return value.partition ? partitionClientBase(kbSummary(id, month, window), deptParams(id))?.clientRows || []
        : kbClientRows(id, month, window, value); } });
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
