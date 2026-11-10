"use strict";
(function(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.klinvektReportCharts = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
  const escapeHtml = value => String(value == null ? "" : value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const chartPalette = ["#2563eb", "#7c3aed", "#16a34a", "#d97706", "#db2777", "#0891b2", "#64748b"];
  const chartColor = (value, index = 0) => /^#[0-9a-f]{6}$/i.test(value || "") ? value : chartPalette[index % chartPalette.length];
  const numberFormats = [new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }),
    new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1, notation: "compact" })];
  const chartNumber = (value, compact = false) => Number.isFinite(value) ? numberFormats[compact ? 1 : 0].format(value) : "—";
  const pointNote = (series, index) => series.pointNotes?.[index] || "";
  const deviceHistory = chart => chart.type === "line" && chart.id?.startsWith("specialization-devices-") && chart.series.length === 1;
  const pointValue = (series, index, unit) => Number.isFinite(series.values[index]) ? `${chartNumber(series.values[index])} ${unit}` : "—";
  const lineValue = (value, unit, note) => {
    const share = note.match(/^\d+(?:[,.]\d+)?%/)?.[0];
    const number = chartNumber(value, unit === "₽" && Math.abs(value) >= 10000);
    return number + (unit === "%" ? "%" : "") + (share ? ` · ${share}` : "");
  };

  function chartTable(chart) {
    return `<details class="chart-data"><summary>Точные значения${chart.unit ? ` · ${escapeHtml(chart.unit)}` : ""}</summary><div class="chart-data-scroll"><table>
      <thead><tr><th scope="col">${["line", "mirror", "stacked"].includes(chart.type) ? "Период" : "Категория"}</th>${chart.series.map(series => `<th scope="col">${escapeHtml(series.label)}</th>`).join("")}</tr></thead>
      <tbody>${chart.labels.map((label, i) => `<tr><th scope="row">${escapeHtml(label)}</th>${chart.series.map(series => `<td>${chartNumber(series.values[i])}${pointNote(series, i) ? `<br><small>${escapeHtml(pointNote(series, i))}</small>` : ""}</td>`).join("")}</tr>`).join("")}</tbody></table></div></details>`;
  }

  function chartLegend(chart, series = chart.series) {
    const items = chart.type === "donut" || chart.type === "bar"
      ? chart.labels.map((label, i) => ({ label, color: chartColor(series[0].colors?.[i], i), value: series[0].values[i] }))
      : series.map((item, i) => ({ label: item.label, color: chartColor(item.color, i) }));
    const total = chart.type === "donut" ? series[0].values.reduce((sum, value) => sum + (value || 0), 0) : 0;
    return `<ul class="chart-legend">${items.map(item => `<li><svg viewBox="0 0 9 9" aria-hidden="true"><rect width="9" height="9" rx="3" fill="${item.color}"/></svg><span>${escapeHtml(item.label)}</span>${item.value !== undefined ? `<b>${chartNumber(item.value)}${chart.unit ? ` ${escapeHtml(chart.unit)}` : ""}${total > 0 ? `<small>${chartNumber(item.value / total * 100)}%</small>` : ""}</b>` : ""}</li>`).join("")}</ul>`;
  }

  function stackedPlot(chart) {
    const totals = chart.labels.map((_, index) => chart.series[0].values[index] == null ? null
      : chart.series.reduce((sum, series) => sum + series.values[index], 0));
    const xStart = 115, plotWidth = 515, width = 705;
    const max = Math.max(1, ...totals);
    const roughStep = max / 5;
    const magnitude = 10 ** Math.floor(Math.log10(roughStep));
    const step = Math.max(1, [1, 2, 5, 10].find(value => value * magnitude >= roughStep) * magnitude);
    const limit = Math.ceil(max / step) * step;
    const x = value => xStart + value / limit * plotWidth;
    const axisY = chart.labels.length * 34 + 10;
    const axis = Array.from({ length: Math.round(limit / step) + 1 }, (_, index) => {
      const tick = index * step, tickX = x(tick);
      return `<line x1="${tickX}" x2="${tickX}" y1="9" y2="${axisY}" stroke="#e2e8f0"/><text x="${tickX}" y="${axisY + 17}" text-anchor="middle">${chartNumber(tick)}</text>`;
    }).join("");
    const rows = chart.labels.map((label, index) => {
      const y = index * 34 + 15;
      const month = `<text x="${xStart - 10}" y="${y + 16}" text-anchor="end">${escapeHtml(label)}</text>`;
      if (totals[index] == null) return month;
      let start = 0;
      const segments = chart.series.map((series, j) => {
        const value = series.values[index], left = x(start);
        start += value;
        const w = x(start) - left;
        if (!value) return "";
        const fill = chartColor(series.color, j);
        const color = fill === "#afe7e9" || fill === "#fbbf24" ? "#17212b" : "#fff";
        const count = chartNumber(value);
        return `<rect x="${left}" y="${y}" width="${w}" height="24" fill="${fill}"><title>${escapeHtml(series.label)} — ${count}</title></rect>`
          + (w >= count.length * 8 + 8 ? `<text x="${left + w / 2}" y="${y + 16}" text-anchor="middle" style="fill:${color};font-weight:600;pointer-events:none">${count}</text>` : "");
      }).join("");
      return `${month}${segments}<text x="${x(totals[index]) + 8}" y="${y + 16}" style="font-weight:700" data-stack-total>${chartNumber(totals[index])}</text>`;
    }).join("");
    return `<div class="stacked-plot"><svg viewBox="0 0 ${width} ${axisY + 42}" role="img" aria-label="${escapeHtml(chart.title)}">${axis}${rows}<text x="${xStart + plotWidth / 2}" y="${axisY + 34}" text-anchor="middle">Пациентов</text></svg></div>${chartLegend(chart)}`;
  }

  function chartPlot(chart, selection = "all") {
    const series = selection === "all" ? chart.series : [chart.series[Number(selection)]];
    if (chart.type === "stacked") return stackedPlot(chart);
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
    const device = deviceHistory(chart);
    const valuesByMonth = device ? [] : chart.labels.map((_, index) => series.flatMap((item, seriesIndex) => {
      const value = item.values[index];
      return Number.isFinite(value) ? [{ value, seriesIndex, text: lineValue(value, chart.unit, pointNote(item, index)) }] : [];
    }));
    const labelWidth = Math.max(25, ...valuesByMonth.flatMap(values => values.map(point => point.text.length * 6 + 6)));
    const rowHeight = 14;
    const extraHeight = Math.max(0, ...valuesByMonth.map(values => values.length - 11)) * rowHeight;
    const lineSvg = compact => {
    const start = compact ? 52 : 62;
    const right = device ? (compact ? 25 : 48) : Math.max(27, labelWidth / 2);
    const requiredWidth = device ? 0 : start + right + (chart.labels.length - 1) * labelWidth;
    const width = Math.max(compact ? 360 : 610, requiredWidth, device && !compact ? 195 + chart.labels.length * 83 : 0);
    const end = width - right;
    const pointInset = device && !compact ? 45 : 0;
    const x = index => chart.labels.length === 1 ? (start + end) / 2
      : start + pointInset + index * (end - start - 2 * pointInset) / Math.max(1, chart.labels.length - 1);
    const bottom = 194 + extraHeight;
    const y = value => bottom - (value - min) / (max - min) * ((device && !compact ? 142 : 160) + extraHeight);
    const grid = Array.from({ length: 5 }, (_, i) => {
      const value = min + (max - min) * i / 4;
      return `<line x1="${start}" x2="${end}" y1="${y(value)}" y2="${y(value)}" stroke="#e8edf4"/><text x="${start - 8}" y="${y(value) + 4}" text-anchor="end">${chartNumber(value, true)}</text>`;
    }).join("");
    const pointLabels = valuesByMonth.map((values, i) => {
      const positions = values.map(point => ({ ...point, y: y(point.value) + (point.seriesIndex % 2 ? 13 : -9) })).sort((a, b) => a.y - b.y);
      let top = 24 - rowHeight;
      for (const point of positions) {
        point.y = Math.max(top + rowHeight, point.y);
        top = point.y;
      }
      let lower = bottom + rowHeight * 2;
      for (let index = positions.length - 1; index >= 0; index--) {
        const point = positions[index];
        point.y = Math.min(lower - rowHeight, point.y);
        lower = point.y;
      }
      return positions.map(point => `<text class="line-point-value" x="${x(i)}" y="${point.y}" text-anchor="middle" style="fill:${chartColor(series[point.seriesIndex].color, point.seriesIndex)}">${escapeHtml(point.text)}</text>`).join("");
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
      const markers = item.values.map((value, i) => {
        if (!Number.isFinite(value)) return "";
        const note = escapeHtml(pointNote(item, i));
        const label = device && !compact ? `<text class="device-point-label" x="${x(i)}" y="${y(value) - (note ? 21 : 8)}" text-anchor="middle">${escapeHtml(pointValue(item, i, chart.unit))}${note ? `<tspan x="${x(i)}" dy="1.1em">${note}</tspan>` : ""}</text>` : "";
        return `<circle cx="${x(i)}" cy="${y(value)}" r="3.5" fill="${color}"><title>${escapeHtml(item.label)} · ${escapeHtml(chart.labels[i])}: ${chartNumber(value)}${note ? ` · ${note}` : ""}</title></circle>${label}`;
      }).join("");
      return `<path d="${path}" fill="none" stroke="${color}" stroke-width="2.5"/>${markers}`;
    }).join("");
    const sparse = chart.labels.length > 12;
    const labelText = label => compact || chart.labels.length > 6 || device ? String(label).split(/\s+/).map((part, i) => i === 0 ? part.slice(0, 3) : /^\d{4}$/.test(part) ? part.slice(-2) : part).join(" ") : label;
    const tickCount = compact ? 6 : 9;
    const ticks = sparse
      ? Array.from({ length: tickCount }, (_, i) => Math.round(i * (chart.labels.length - 1) / (tickCount - 1)))
      : chart.labels.map((_, i) => i);
    return `<svg class="${compact ? "line-narrow" : "line-wide"}"${requiredWidth ? ` style="min-width:${requiredWidth}px"` : ""} viewBox="0 0 ${width} ${235 + extraHeight}" role="img" aria-label="${escapeHtml(chart.title)}"><text x="${start}" y="16">${escapeHtml(chart.unit || "")}</text>${grid}${lines}${pointLabels}${ticks.map(i => `<text x="${x(i)}" y="${219 + extraHeight}" text-anchor="middle">${escapeHtml(labelText(chart.labels[i]))}</text>`).join("")}</svg>`;
    };
    const observed = chart.labels.filter((_, i) => series.some(item => Number.isFinite(item.values[i]))).length;
    const coverage = chart.id === "specialization-base-history" && observed < chart.labels.length
      ? `<p class="chart-note">С данными: ${observed} из ${chart.labels.length} месяцев. Пропуски соответствуют отсутствующим или неполным выгрузкам.</p>` : "";
    const labels = device ? `<ul class="device-chart-months">${chart.labels.map((label, i) =>
      `<li><small>${escapeHtml(label)}</small><span>${escapeHtml(pointValue(series[0], i, chart.unit))}${pointNote(series[0], i) ? ` · ${escapeHtml(pointNote(series[0], i))}` : ""}</span></li>`).join("")}</ul>` : chartLegend(chart, series);
    return `<div class="line-plot${chart.labels.length > 12 ? " line-plot-history" : ""}">${lineSvg(false)}${lineSvg(true)}</div>${labels}${coverage}`;
  }

  function renderCharts(charts = [], { deferred = false, renderValues = chartTable } = {}) {
    return charts.map(chart => `<article class="report-chart${deviceHistory(chart) ? " device-history-report" : ""}" data-chart="${escapeHtml(JSON.stringify(chart))}"${deferred ? ' data-chart-deferred="true"' : ""}><header><h5>${escapeHtml(chart.title)}</h5>${chart.type === "line" && chart.series.length > 1 ? `<label class="chart-picker">Показать<select data-chart-series><option value="all">Все показатели</option>${chart.series.map((series, i) => `<option value="${i}"${chart.id === "scores" && i === 0 ? " selected" : ""}>${escapeHtml(series.label)}</option>`).join("")}</select></label>` : ""}</header><div class="chart-plot"${deferred ? ' style="min-height:235px"' : ""}>${deferred ? '<p class="chart-note">График появится при открытии раздела.</p>' : chartPlot(chart, chart.id === "scores" ? "0" : "all")}</div>${renderValues(chart)}</article>`).join("");
  }

  return Object.freeze({ renderCharts, chartPlot, chartNumber, chartTable });
});
