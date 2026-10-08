"use strict";

const { validateMobilePublication } = require("./mobile-publication-service.cjs");

// The cloud contract contains display data and numeric chart series only. Keep a
// strict allowlist at every object boundary, including nested service trees.
function fields(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error("Некорректный JSON отчёта: неизвестное поле или объект");
  }
}
const each = (values, visit) => { if (values != null) { if (!Array.isArray(values)) throw new Error("Некорректный список отчёта"); values.forEach(visit); } };
function charts(values) {
  each(values, chart => {
    fields(chart, ["id", "title", "type", "labels", "series", "unit"]);
    each(chart.series, series => fields(series, ["label", "values", "color", "colors", "side"]));
  });
}
function metrics(values) {
  each(values, metric => {
    fields(metric, ["label", "value", "note", "target", "state", "history", "delta"]);
    each(metric.history, row => fields(row, ["label", "value", "delta", "state"]));
  });
}
function tree(values, depth = 0) {
  if (depth > 32) throw new Error("Слишком глубокая структура услуг");
  each(values, node => { fields(node, ["label", "values", "children"]); tree(node.children, depth + 1); });
}
function sections(values) {
  each(values, section => {
    fields(section, ["title", "note", "metrics", "columns", "rows", "tree", "charts"]);
    metrics(section.metrics); tree(section.tree); charts(section.charts);
  });
}
function validateCloudReport(report, page) {
  fields(report, ["id", "label", "shortLabel", "overall", "coverage", "preliminary", "missing", "overallDelta",
    "assessment", "summary", "updatedAt", "comment", "numbers", "headlineMetrics", "vectors", "goalsSource", "goals", "dynamics", "comments"]);
  if (report.id !== page.periodKey) throw new Error("Период JSON отчёта не совпадает с каталогом");
  metrics(report.headlineMetrics);
  each(report.vectors, vector => {
    fields(vector, ["id", "number", "title", "score", "delta", "detail", "coverage", "preliminary", "sections", "windows",
      "windowPickerLabel", "methodologyId", "scoreMethodologyId", "methodologyLabel"]);
    sections(vector.sections);
    each(vector.windows, window => { fields(window, ["id", "label", "period", "methodologyId", "sections"]); sections(window.sections); });
  });
  each(report.goals, goal => fields(goal, ["key", "vector", "title", "target", "fact", "hasTarget", "description", "progress", "state"]));
  if (report.numbers != null) {
    fields(report.numbers, ["version", "metrics"]);
    each(report.numbers.metrics, metric => fields(metric, ["id", "value", "unit", "methodologyId"]));
  }
  if (report.dynamics != null) {
    fields(report.dynamics, ["columns", "rows", "growth", "risk", "conclusion", "conclusionManual", "charts"]);
    each(report.dynamics.rows, row => fields(row, ["key", "label", "values", "delta", "averageDelta", "target", "state"]));
    charts(report.dynamics.charts);
  }
  each(report.comments, comment => fields(comment, ["blockKey", "title", "text", "author", "updatedAt"]));
  validateMobilePublication({ format: "klinvekt-mobile-publication", version: 1,
    security: { patientRegistryIncluded: false, rawExportsIncluded: false },
    doctor: { id: page.doctorId || page.kind, name: page.title, department: page.department || page.specialization || "Вся клиника" },
    periods: [report] });
  return report;
}

module.exports = { validateCloudReport };
