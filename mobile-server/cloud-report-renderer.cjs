"use strict";
const fs = require("node:fs"), path = require("node:path");
const chartsPath = fs.existsSync(path.join(__dirname, "public", "report-charts.js"))
  ? "./public/report-charts.js" : "../mobile-pilot/report-charts.js";
const { renderCharts } = require(chartsPath);
const { tableHeaderHtml } = require(chartsPath.replace("report-charts.js", "report-presentation.js"));
const esc = value => String(value == null ? "" : value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const lines = value => esc(value).replace(/\r?\n/g, "<br>");
const score = value => Number.isFinite(value) ? esc(value) : "—";
function renderMetrics(metrics = []) {
  return `<div class="cloud-kpis">${metrics.map(metric => `<div class="kpi ${esc(metric.state || "neutral")}"><span>${esc(metric.label)}</span><b class="val">${esc(metric.value)}</b>
    ${metric.note ? `<small>${esc(metric.note)}</small>` : ""}${metric.target ? `<em>${esc(metric.target)}</em>` : ""}
    ${(metric.history || []).map(row => `<small>${esc(row.label)}: ${esc(row.delta)} · ${esc(row.value)}</small>`).join("")}</div>`).join("")}</div>`;
}
function renderTable(columns = [], rows = []) {
  if (!rows.length) return "";
  return `<div class="cloud-table-scroll"><table><thead><tr>${columns.map(value => `<th>${tableHeaderHtml(value)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(row => `<tr>${row.map(value => `<td>${esc(value)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function renderTree(nodes = [], columns = []) {
  return nodes.map(node => {
    const row = `<span>${esc(node.label)}</span><span class="cloud-tree-values">${node.values.map((value, i) => `<span><small>${esc(columns[i + 1])}</small><b>${esc(value)}</b></span>`).join("")}</span>`;
    return node.children?.length ? `<details class="cloud-tree"><summary>${row}</summary><div>${renderTree(node.children, columns)}</div></details>`
      : `<div class="cloud-tree-leaf">${row}</div>`;
  }).join("");
}
function renderSections(sections = [], options = {}) {
  return sections.map(section => `<section class="cloud-section"><h3>${esc(section.title)}</h3>${section.note ? `<p>${lines(section.note)}</p>` : ""}
    ${renderMetrics(section.metrics)}${section.tree?.length ? renderTree(section.tree, section.columns) : renderTable(section.columns, section.rows)}${renderCharts(section.charts, options)}</section>`).join("");
}
function renderCloudReport(report, title, options = {}) {
  const completeness = [report.preliminary ? "Предварительная оценка" : "", report.coverage != null ? `Полнота: ${report.coverage}%` : "", ...(report.missing || [])].filter(Boolean);
  return `<main class="cloud-data-report"><header class="cloud-heading"><div><h1>${esc(title)}</h1><p>${esc(report.assessment)}</p></div><div class="cloud-score">${score(report.overall)}<small>общий балл</small></div></header>
    <p>${esc(report.summary)}</p>${completeness.length ? `<p class="cloud-completeness">${completeness.map(esc).join(" · ")}</p>` : ""}
    ${renderMetrics(report.headlineMetrics)}
    ${report.goals?.length ? `<details class="cloud-vector"><summary>Цели</summary>${report.goals.map(goal => `<p><b>${esc(goal.title)}</b> · ${esc(goal.description)}</p>`).join("")}</details>` : ""}
    ${report.vectors.map(vector => `<details class="cloud-vector" data-vector-key="${esc(vector.id)}" open><summary><span>В${vector.number} · ${esc(vector.title)}</span><b>${score(vector.score)}${vector.preliminary ? " · предв." : ""}</b></summary>
      <p>${esc(vector.detail)}</p>${vector.methodologyLabel ? `<p class="cloud-methodology">${esc(vector.methodologyLabel)}</p>` : ""}
      ${vector.windows?.length ? vector.windows.map((window, index) => `<details class="cloud-window" ${index === 0 ? "open" : ""}><summary>${esc(vector.windowPickerLabel || "Окно анализа")}: ${esc(window.label)}</summary><p>${esc(window.period)}</p>${renderSections(window.sections, options)}</details>`).join("") : renderSections(vector.sections, options)}</details>`).join("")}
    ${report.dynamics ? `<details class="cloud-vector" open><summary>Динамика показателей по месяцам</summary>${renderCharts(report.dynamics.charts, options)}
      ${renderTable(["Показатель", ...report.dynamics.columns, "К прошлому месяцу", "К среднему"], report.dynamics.rows.map(row => [row.label, ...row.values, row.delta, row.averageDelta || "—"]))}
      ${report.dynamics.growth.length ? `<h3>Точки роста</h3>${report.dynamics.growth.map(value => `<p>${esc(value)}</p>`).join("")}` : ""}
      ${report.dynamics.risk.length ? `<h3>Точки риска</h3>${report.dynamics.risk.map(value => `<p>${esc(value)}</p>`).join("")}` : ""}
      ${report.dynamics.conclusion ? `<h3>Выводы</h3><p>${lines(report.dynamics.conclusion)}</p>` : ""}</details>` : ""}
    ${report.comments?.length ? `<section class="cloud-comments"><h2>Комментарии администратора</h2>${report.comments.map(comment => `<article><h3>${esc(comment.title)}</h3><p>${lines(comment.text)}</p><small>${esc(comment.author)}</small></article>`).join("")}</section>` : ""}</main>`;
}
function createReportRenderCache({ maxEntries = 8, maxBytes = 16 * 1024 * 1024 } = {}) {
  const entries = new Map();
  let bytes = 0, renders = 0;
  return {
    render(page) {
      const existing = entries.get(page.pageId);
      if (existing && existing.report === page.report && existing.title === page.title) {
        entries.delete(page.pageId); entries.set(page.pageId, existing); return existing.html;
      }
      if (existing) { entries.delete(page.pageId); bytes -= existing.bytes; }
      const html = renderCloudReport(page.report, page.title, { deferred: true }); renders++;
      const size = Buffer.byteLength(html);
      if (size <= maxBytes) { entries.set(page.pageId, { report: page.report, title: page.title, html, bytes: size }); bytes += size; }
      while (entries.size > maxEntries || bytes > maxBytes) { const id = entries.keys().next().value; bytes -= entries.get(id).bytes; entries.delete(id); }
      return html;
    },
    clear() { entries.clear(); bytes = 0; },
    stats() { return { entries: entries.size, bytes, renders }; },
  };
}
module.exports = { renderCloudReport, createReportRenderCache };
