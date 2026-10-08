"use strict";
(function(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.klinvektReportCharts = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
  const escapeHtml = value => String(value == null ? "" : value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const chartPalette = ["#2563eb", "#7c3aed", "#16a34a", "#d97706", "#db2777", "#0891b2", "#64748b"];
  const chartColor = (value, index = 0) => /^#[0-9a-f]{6}$/i.test(value || "") ? value : chartPalette[index % chartPalette.length];
  const chartNumber = (value, compact = false) => Number.isFinite(value)
    ? new Intl.NumberFormat("ru-RU", { maximumFractionDigits: compact ? 1 : 2, ...(compact ? { notation: "compact" } : {}) }).format(value) : "—";

  function chartTable(chart) {
    return `<details class="chart-data"><summary>Точные значения${chart.unit ? ` · ${escapeHtml(chart.unit)}` : ""}</summary><div class="chart-data-scroll"><table>
      <thead><tr><th scope="col">${chart.type === "line" || chart.type === "mirror" ? "Период" : "Категория"}</th>${chart.series.map(series => `<th scope="col">${escapeHtml(series.label)}</th>`).join("")}</tr></thead>
      <tbody>${chart.labels.map((label, i) => `<tr><th scope="row">${escapeHtml(label)}</th>${chart.series.map(series => `<td>${chartNumber(series.values[i])}</td>`).join("")}</tr>`).join("")}</tbody></table></div></details>`;
  }

  function chartLegend(chart, series = chart.series) {
    const items = chart.type === "donut" || chart.type === "bar"
      ? chart.labels.map((label, i) => ({ label, color: chartColor(series[0].colors?.[i], i), value: series[0].values[i] }))
      : series.map((item, i) => ({ label: item.label, color: chartColor(item.color, i) }));
    const total = chart.type === "donut" ? series[0].values.reduce((sum, value) => sum + (value || 0), 0) : 0;
    return `<ul class="chart-legend">${items.map(item => `<li><svg viewBox="0 0 9 9" aria-hidden="true"><rect width="9" height="9" rx="3" fill="${item.color}"/></svg><span>${escapeHtml(item.label)}</span>${item.value !== undefined ? `<b>${chartNumber(item.value)}${chart.unit ? ` ${escapeHtml(chart.unit)}` : ""}${total > 0 ? `<small>${chartNumber(item.value / total * 100)}%</small>` : ""}</b>` : ""}</li>`).join("")}</ul>`;
  }

  function chartPlot(chart, selection = "all") {
    const series = selection === "all" ? chart.series : [chart.series[Number(selection)]];
    if (chart.type === "donut") {
      const total = series[0].values.reduce((sum, value) => sum + (value || 0), 0);
      let offset = 0;
      const circles = total > 0 ? series[0].values.map((value, i) => {
        const amount = (value || 0) / total * 100;
        const circle = `<circle cx="100" cy="100" r="72" pathLength="100" fill="none" stroke="${chartColor(series[0].colors?.[i], i)}" stroke-width="25" stroke-dasharray="${amount} ${100 - amount}" stroke-dashoffset="${-offset}" transform="rotate(-90 100 100)"><title>${escapeHtml(chart.labels[i])}: ${chartNumber(value)}</title></circle>`;
        offset += amount;
        return value > 0 ? circle : "";
      }).join("") : "";
      return `<div class="donut-layout"><svg class="donut-plot" viewBox="0 0 200 200" role="img" aria-label="${escapeHtml(chart.title)}"><circle cx="100" cy="100" r="72" fill="none" stroke="#edf1f7" stroke-width="25"/>${circles}<text x="100" y="98" text-anchor="middle" class="donut-total">${chartNumber(total, true)}</text><text x="100" y="120" text-anchor="middle">${escapeHtml(chart.unit || "всего")}</text></svg>${chartLegend(chart)}</div>`;
    }
    if (chart.type === "bar") {
      const values = series[0].values;
      const max = Math.max(1, ...values.filter(Number.isFinite).map(Math.abs));
      return `<div class="bar-plot">${chart.labels.map((label, i) => `<div class="bar-item"><div><span>${escapeHtml(label)}</span><b>${chartNumber(values[i])} ${escapeHtml(chart.unit || "")}</b></div><svg class="bar-track" width="100%" height="9" aria-hidden="true"><rect width="100%" height="9" fill="#eef2f7" rx="4"/><rect width="${Number.isFinite(values[i]) ? Math.abs(values[i]) / max * 100 : 0}%" height="9" rx="4" fill="${chartColor(series[0].colors?.[i], i)}"/></svg></div>`).join("")}</div>`;
    }
    if (chart.type === "mirror") {
      // Отрицательные корректировки нельзя изображать как положительную выручку.
      if (series.some(item => item.values.some(value => value < 0))) return `<p class="chart-note">Есть отрицательные корректировки. Суммы со знаком приведены в таблице «Точные значения».</p>${chartLegend(chart)}`;
      const sums = chart.labels.map((_, i) => ["own", "ref"].map(side => series.filter(item => item.side === side).reduce((sum, item) => sum + (item.values[i] || 0), 0)));
      const max = Math.max(1, ...sums.flat());
      const height = 50 + chart.labels.length * 42;
      const bars = chart.labels.map((label, i) => {
        const y = 36 + i * 42;
        let left = 332, right = 348;
        return `<text x="10" y="${y + 15}">${escapeHtml(label)}</text>${series.map((item, j) => {
          const w = (item.values[i] || 0) / max * 205;
          const x = item.side === "own" ? left - w : right;
          if (item.side === "own") left -= w; else right += w;
          return `<rect x="${x}" y="${y}" width="${w}" height="22" rx="2" fill="${chartColor(item.color, j)}"><title>${escapeHtml(item.label)}: ${chartNumber(item.values[i])}</title></rect>`;
        }).join("")}<text x="332" y="${y + 34}" text-anchor="end">${series.filter(item => item.side === "own").some(item => item.values[i] != null) ? chartNumber(sums[i][0], true) : "—"}</text><text x="348" y="${y + 34}">${series.filter(item => item.side === "ref").some(item => item.values[i] != null) ? chartNumber(sums[i][1], true) : "—"}</text>`;
      }).join("");
      return `<p class="chart-note">Слева — собственная выручка по категориям, справа — от перенаправлений. ${escapeHtml(chart.unit || "")}</p><div class="plot-scroll"><svg viewBox="0 0 580 ${height}" role="img" aria-label="${escapeHtml(chart.title)}"><text x="332" y="16" text-anchor="end">Собственная</text><text x="348" y="16">Перенаправления</text><line x1="340" x2="340" y1="28" y2="${height}" stroke="#dce5f0"/>${bars}</svg></div>${chartLegend(chart)}`;
    }
    const numbers = series.flatMap(item => item.values).filter(Number.isFinite);
    if (!numbers.length) return '<p class="chart-note">Нет данных для этого ряда.</p>';
    const min = Math.min(0, ...numbers), max = Math.max(1, ...numbers);
    const lineSvg = compact => {
    const width = compact ? 360 : 610;
    const start = compact ? 52 : 62, end = width - (compact ? 25 : 48);
    const x = index => start + index * (end - start) / Math.max(1, chart.labels.length - 1);
    const y = value => 194 - (value - min) / (max - min) * 160;
    const grid = Array.from({ length: 5 }, (_, i) => {
      const value = min + (max - min) * i / 4;
      return `<line x1="${start}" x2="${end}" y1="${y(value)}" y2="${y(value)}" stroke="#e8edf4"/><text x="${start - 8}" y="${y(value) + 4}" text-anchor="end">${chartNumber(value, true)}</text>`;
    }).join("");
    const lines = series.map((item, s) => {
      let previous = false;
      const color = chartColor(item.color, s);
      const path = item.values.map((value, i) => {
        if (!Number.isFinite(value)) { previous = false; return ""; }
        const part = `${previous ? "L" : "M"}${x(i)},${y(value)}`;
        previous = true;
        return part;
      }).join(" ");
      return `<path d="${path}" fill="none" stroke="${color}" stroke-width="2.5"/>${item.values.map((value, i) => Number.isFinite(value) ? `<circle cx="${x(i)}" cy="${y(value)}" r="3.5" fill="${color}"><title>${escapeHtml(item.label)} · ${escapeHtml(chart.labels[i])}: ${chartNumber(value)}</title></circle>` : "").join("")}`;
    }).join("");
    const labelText = label => compact ? String(label).split(/\s+/).map((part, i) => i === 0 ? part.slice(0, 3) : /^\d{4}$/.test(part) ? part.slice(-2) : part).join(" ") : label;
    return `<svg class="${compact ? "line-narrow" : "line-wide"}" viewBox="0 0 ${width} 235" role="img" aria-label="${escapeHtml(chart.title)}"><text x="${start}" y="16">${escapeHtml(chart.unit || "")}</text>${grid}${lines}${chart.labels.map((label, i) => `<text x="${x(i)}" y="219" text-anchor="middle">${escapeHtml(labelText(label))}</text>`).join("")}</svg>`;
    };
    return `<div class="line-plot">${lineSvg(false)}${lineSvg(true)}</div>${chartLegend(chart, series)}`;
  }

  function renderCharts(charts = []) {
    return charts.map(chart => `<article class="report-chart" data-chart="${escapeHtml(JSON.stringify(chart))}"><header><h5>${escapeHtml(chart.title)}</h5>${chart.type === "line" && chart.series.length > 1 ? `<label class="chart-picker">Показать<select data-chart-series><option value="all">Все показатели</option>${chart.series.map((series, i) => `<option value="${i}"${chart.id === "scores" && i === 0 ? " selected" : ""}>${escapeHtml(series.label)}</option>`).join("")}</select></label>` : ""}</header><div class="chart-plot">${chartPlot(chart, chart.id === "scores" ? "0" : "all")}</div>${chartTable(chart)}</article>`).join("");
  }

  return Object.freeze({ renderCharts, chartPlot, chartNumber, chartTable });
});
