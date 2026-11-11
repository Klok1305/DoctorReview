"use strict";
for (const board of document.querySelectorAll(".reputation-honor-board")) board.remove();
// Older HTML snapshots receive the same presentation without changing their data.
const presentation = window.klinvektReportPresentation;
const legacyDeviceHistoryTables = new Map();
for (const values of document.querySelectorAll('.viewer-dashboard-snapshot [data-specialization-device-history] [data-list-key^="values-specialization-devices-"]')) {
  if (values.closest("[data-device-history-chart]")) continue;
  const plot = values.previousElementSibling;
  const heading = plot?.previousElementSibling;
  if (!plot?.classList.contains("chart-box") || !heading?.matches("h3")) continue;
  const [header, ...rows] = values.querySelector("table")?.rows || [];
  if (!header || !rows.length || rows.some(row => row.cells.length !== header.cells.length)) continue;
  const labels = rows.map(row => row.cells[0].textContent.trim());
  const series = [...header.cells].slice(1).map((cell, index) => ({
    label: cell.textContent.trim(),
    values: rows.map(row => presentation.publishedDeviceMeasure(row.cells[index + 1].firstChild?.textContent)),
    pointNotes: rows.map(row => row.cells[index + 1].querySelector("small")?.textContent.trim() || ""),
  }));
  if (!series.length || !series.some(item => item.values.some(Number.isFinite))) continue;
  const source = {
    id: values.dataset.listKey.slice("values-".length), type: "line", labels, unit: "₽", series,
  };
  const container = values.parentElement;
  if (!legacyDeviceHistoryTables.has(container)) legacyDeviceHistoryTables.set(container, []);
  legacyDeviceHistoryTables.get(container).push(source);
  const charts = presentation.splitDeviceHistoryCharts([source]);
  heading.insertAdjacentHTML("beforebegin", window.klinvektReportCharts.renderCharts(charts,
    { deferred: true, renderValues: chart => presentation.deviceHistoryDetailsHtml([chart]) }));
  heading.remove(); plot.remove(); values.remove();
}
for (const [container, charts] of legacyDeviceHistoryTables) {
  container.insertAdjacentHTML("afterbegin", presentation.deviceHistoryDetailsHtml(charts, true));
}
for (const label of document.querySelectorAll(".viewer-dashboard-snapshot [data-primary-source-composition] .client-base-pie-legend li > span, .viewer-dashboard-snapshot [data-primary-source-composition] svg title, .viewer-dashboard-snapshot [data-primary-sources] p")) {
  const text = label.firstChild;
  if (text?.nodeType === Node.TEXT_NODE && /^Не распределено(?=:|$)/.test(text.nodeValue)) {
    text.nodeValue = text.nodeValue.replace(/^Не распределено/, "Прочее");
  }
}
for (const block of document.querySelectorAll(".viewer-dashboard-snapshot [data-specialization-primary]")) {
  block.querySelector('details[data-list-key="values-specialization-primary"]')?.remove();
  const table = block.querySelector("#tblSpecPrimary");
  if (!table || block.querySelector("[data-specialization-primary-summary]")) continue;
  const savedRows = [...table.rows].slice(1);
  if (!savedRows.length || savedRows.some(row => row.cells.length !== 2)) continue;
  const rows = savedRows.map(row => [...row.cells].map(cell => cell.textContent.trim()));
  const oldSources = block.querySelector("[data-specialization-primary-sources]");
  const values = [...(oldSources?.querySelectorAll(".specialization-source-values > strong") || [])];
  if (oldSources && values.length !== presentation.specializationSourceOrder.length) continue;
  const counts = oldSources ? [] : null;
  if (counts) presentation.specializationSourceOrder.forEach((index, position) => {
    counts[index] = presentation.publishedReportCount(values[position].textContent.trim().replace(/\s*чел\.$/, ""));
  });
  (oldSources || table).insertAdjacentHTML("beforebegin", presentation.specializationPrimarySummaryHtml(rows, counts));
  oldSources?.remove();
  table.remove();
}
for (const table of document.querySelectorAll(".viewer-dashboard-snapshot .heatmap-table")) {
  if (!table.querySelector(".heatmap-money, .device-heat-s")) continue;
  const [header, ...rows] = table.rows;
  const totalRow = /^Итого(?:\s|$)/i.test(rows.at(-1)?.cells[0]?.textContent.trim()) ? rows.pop() : null;
  const measure = cell => {
    const money = cell?.querySelector(".heatmap-money");
    return {
      q: presentation.publishedDeviceMeasure(money ? money.parentElement.textContent.slice(0, -money.textContent.length) : cell?.querySelector(".device-heat-q > span")?.textContent),
      s: presentation.publishedDeviceMeasure(money?.textContent || cell?.querySelector(".device-heat-s > span")?.textContent),
    };
  };
  const cards = [...header.cells].slice(1).flatMap((heading, i) => {
    const name = heading.textContent.trim();
    if (/^(Итого|Доля от выручки)$/i.test(name)) return [];
    const doctors = rows.map(row => ({ name: row.cells[0].textContent.trim(), ...measure(row.cells[i + 1]) }));
    return [{ name, ...measure(totalRow?.cells[i + 1]), doctors }];
  });
  if (!cards.length) continue;
  const anchor = table.closest(".heatmap-scroll") || table;
  const card = anchor.closest(".card");
  const block = card?.querySelector(":scope > h2")?.textContent.includes("Тепловая карта") ? card : anchor;
  block.outerHTML = `<div class="card" data-specialization-device-month><h2>Аппараты за месяц</h2>${presentation.deviceMonthCardsHtml(cards)}</div>`;
}
for (const heading of document.querySelectorAll('body[data-report-kind="specialization"] .viewer-dashboard-snapshot h3')) {
  const block = heading.parentElement;
  if (heading.textContent.trim().startsWith("СРЕДНИЕ БАЛЛЫ ПО ВЕКТОРАМ ПО МЕСЯЦАМ") && block.querySelector(":scope > .score-chart")) block.remove();
}
for (const picker of document.querySelectorAll("[data-client-base-window]")) {
  const section = picker.closest('[data-vector-key="v4"]');
  picker.addEventListener("change", () => {
    for (const panel of section.querySelectorAll("[data-client-base-window-panel]")) panel.hidden = panel.dataset.clientBaseWindowPanel !== picker.value;
  });
}
for (const picker of document.querySelectorAll("[data-v3-window]")) {
  const vector = picker.closest('[data-vector-key="v3"]');
  picker.addEventListener("change", () => {
    for (const panel of vector.querySelectorAll("[data-v3-window-panel]")) panel.hidden = panel.dataset.v3WindowPanel !== picker.value;
  });
}
for (const vector of document.querySelectorAll('body[data-report-kind="doctor"] .viewer-dashboard-snapshot [data-vector-key="v3"]')) {
  const conversion = vector.querySelector(':scope > [data-list-key="appointmentConversionBlock"]');
  const summary = conversion?.querySelector(":scope > summary");
  if (!summary || conversion.dataset.v3Section) continue;
  const focusTitle = conversion.querySelector(".appointment-focus-title");
  const focusGrid = focusTitle?.nextElementSibling;
  const revenue = vector.querySelector(":scope > .completed-referrals-section");
  const revenueMetric = revenue?.querySelector(":scope > .tracked-metric");
  const breakdown = conversion.querySelector('[data-list-key="appointmentDetails"]');
  const conversionMetric = conversion.querySelector(".appointment-conversion-body > .tracked-metric");
  const count = [...vector.querySelectorAll(".vhead .vscore")].find(item => /\d\s+из\s+\d+\s+фокусов/.test(item.textContent));
  const tile = (title, notes, value, caption) => {
    const summary = document.createElement("summary");
    summary.className = "collapsible-list-summary v3-tile";
    const text = document.createElement("span");
    text.className = "v3-tile-copy";
    const heading = document.createElement("b");
    heading.textContent = title;
    text.append(heading);
    const addNote = (parent, note) => {
      if (!note) return;
      const small = document.createElement("small");
      small.textContent = note;
      parent.append(small);
    };
    for (const note of notes) addNote(text, note);
    summary.append(text);
    if (value) {
      const side = document.createElement("span");
      side.className = "v3-tile-value";
      side.append(value);
      addNote(side, caption);
      summary.append(side);
    }
    return summary;
  };
  const addBlock = (key, summary, body) => {
    const block = document.createElement(body ? "details" : "div");
    block.dataset.v3Section = key;
    if (body) {
      block.className = "collapsible-list";
      block.append(summary, body);
    } else {
      block.className = "v3-tile v3-empty";
      block.append(...summary.childNodes);
    }
    conversion.before(block);
  };
  const period = summary.querySelector(".section-detail")?.textContent.replace(/^\s*·\s*/, "").trim();
  const focusValue = count && document.createElement("strong");
  if (focusValue) focusValue.textContent = count.textContent.trim().replace(/\s+фокусов$/, "");
  count?.remove();
  focusTitle?.remove();
  if (focusGrid) {
    focusGrid.classList.add("collapsible-list-body");
    const list = focusGrid.querySelector('[data-list-key="interdisciplinaryFocusPositions"]');
    if (list) list.open = false;
  }
  addBlock("focus", tile("Фокусы междисциплинарного подхода", [period], focusValue, "позиций выполнено"), focusGrid);
  const revenueBody = revenueMetric?.nextElementSibling;
  const revenueValue = revenueMetric?.querySelector(".tracked-value");
  const revenueGoal = revenueMetric?.querySelector(".tracked-goal")?.textContent;
  if (revenueValue) revenueValue.className = `appointment-conversion-summary-value ${revenueMetric.className}`.replace("tracked-metric", "").trim();
  if (revenueBody) {
    revenueBody.classList.add("collapsible-list-body");
    const list = revenueBody.querySelector('[data-list-key="completedReferralDetails"]');
    if (list) list.open = true;
  }
  const revenueNotes = revenueMetric ? [
    revenue.querySelector("p")?.textContent.split(" · ")[0],
    revenueMetric.querySelector(".tracked-note")?.textContent,
  ] : ["Нет выполненных направлений в «Выработке»."];
  addBlock("revenue", tile("Выполненные направления за месяц", revenueNotes, revenueValue, ["доля в общей выработке", revenueGoal].filter(Boolean).join(" · ")), revenueBody);
  revenue?.remove();
  const note = conversionMetric?.querySelector(".tracked-note")?.textContent;
  const goal = conversionMetric?.querySelector(".tracked-goal")?.textContent;
  const convertedSummary = tile("Конверсия назначений", [[period, note?.split(" · ").at(-1)].filter(Boolean).join(" · ")],
    summary.querySelector(".appointment-conversion-summary-value"), goal);
  summary.replaceWith(convertedSummary);
  conversion.dataset.v3Section = "conversion";
  conversion.open = false;
  if (breakdown) breakdown.open = false;
  if (note && conversionMetric) {
    const method = document.createElement("p");
    method.className = "small muted v3-method";
    method.textContent = note.split(" · ")[0];
    conversionMetric.replaceWith(method);
  }
}
// Previous HTML already contains review totals: reorder it without altering values.
for (const table of document.querySelectorAll(".reputation-report table")) {
  const header = [...table.rows].find(row => [...row.cells].some(cell => cell.textContent.trim() === "Всего отзывов"));
  const countIndex = header ? [...header.cells].findIndex(cell => cell.textContent.trim() === "Всего отзывов") : -1;
  if (countIndex < 0) continue;
  const rows = [...table.rows].filter(row => row !== header && row.cells.length === header.cells.length);
  const count = row => /^\s*[\d\s\u00a0]+\s*шт\./.test(row.cells[countIndex].textContent) ? Number(row.cells[countIndex].textContent.match(/[\d\s\u00a0]+/)[0].replace(/\s/g,"")) : -1;
  rows.sort((a,b) => count(b) - count(a) || a.cells[0].textContent.localeCompare(b.cells[0].textContent, "ru"));
  for (const row of rows) row.parentElement.appendChild(row);
}
const displayNumber = value => {
  const match = String(value || "").match(/-?\d[\d\s\u00a0]*(?:[.,]\d+)?/);
  return match ? Number(match[0].replace(/[\s\u00a0]/g, "").replace(",", ".")) : null;
};
function reportHelpBody(section) {
  let help = section.querySelector(":scope > [data-report-help]");
  if (!help) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = presentation.reportHelpHtml("<span></span>");
    help = wrapper.firstElementChild;
    help.querySelector(".report-help-body").replaceChildren();
    section.appendChild(help);
  }
  help.open = false;
  return help.querySelector(".report-help-body");
}
for (const section of document.querySelectorAll('.viewer-dashboard-snapshot [data-vector-key="v4"][data-client-base-methodology="partition-v1-36m"]')) {
  if (section.querySelector('.kb-summary-card[data-client-base-group="loyal"]')) continue;
  const help = reportHelpBody(section);
  for (const note of section.querySelectorAll('[data-client-base-methodology-note], .kb-source, .kb-vector-key-note, .kb-group-rules, .kb-action')) {
    if (!note.closest("[data-report-help]")) help.appendChild(note);
  }
  for (const meta of section.querySelectorAll('.kb-summary-card:not([data-client-base-group="total"]) .kb-summary-meta')) meta.remove();
  const history = section.querySelector(".kb-share-history");
  const oldTable = history?.querySelector("table");
  if (oldTable) {
    const rows = [...oldTable.querySelectorAll("tbody tr")];
    const wrapper = document.createElement("div");
    wrapper.innerHTML = presentation.clientBaseShareTableHtml([...oldTable.querySelectorAll("thead th")].slice(1).map(cell => cell.textContent.trim()),
      rows.map((row, index) => ({ ...presentation.clientBaseGroups[index], label: row.cells[0].textContent.trim(),
        values: [...row.cells].slice(1).map(cell => displayNumber(cell.textContent)) })));
    history.replaceWith(wrapper.firstElementChild);
  }
  if (!section.querySelector("[data-client-base-composition]")) {
    const values = presentation.clientBaseGroups.map(group => displayNumber(section.querySelector(`.kb-summary-card[data-client-base-group="${group.key}"] .kb-summary-value`)?.textContent));
    const period = section.querySelector('.kb-share-comparison span:last-child')?.textContent.match(/[А-Яа-яЁё]+ \d{4}/)?.[0]
      || [...section.querySelectorAll("[data-client-base-share-table] thead th")].at(-1)?.textContent.replace(/\s+/g, " ").trim() || "";
    const wrapper = document.createElement("div");
    wrapper.innerHTML = presentation.clientBaseCompositionHtml(values, period);
    section.querySelector(".kb-summary-grid")?.insertAdjacentElement("afterend", wrapper.firstElementChild);
  }
}
for (const card of document.querySelectorAll('.viewer-dashboard-snapshot [data-vector-key="v4"] .kb-summary-card:not([data-client-base-group="total"])')) {
  const value = card.querySelector(".kb-summary-value");
  if (!value?.textContent.trim().endsWith("чел.")) continue;
  const share = card.querySelector(".kb-summary-value-line .kb-summary-share");
  const percentage = share?.textContent.trim()
    || card.querySelector(".kb-share-comparison span:last-child")?.textContent.match(/\d+(?:[,.]\d+)?%\s*$/)?.[0].trim();
  if (!percentage) continue;
  const count = document.createElement("div");
  count.className = "kb-summary-meta";
  count.textContent = value.textContent;
  value.textContent = percentage;
  if (share) share.replaceWith(count);
  else value.after(count);
}
for (const table of document.querySelectorAll(".viewer-dashboard-snapshot #tblRisk")) {
  const [header, ...rows] = [...table.rows];
  const groups = [...(header?.cells || [])].slice(3).map(cell => cell.textContent.trim());
  if (!groups.length || table.closest(".card")?.querySelector("[data-client-base-averages]")) continue;
  const shares = rows.map(row => {
    const total = row.cells[2]?.querySelector("b")?.textContent.trim();
    return [...row.cells].slice(3).map(cell => {
      const count = cell.querySelector("b")?.textContent.trim();
      const share = presentation.publishedClientBaseShare(total, count, cell.querySelector(".small.muted")?.textContent.trim());
      cell.innerHTML = presentation.clientBaseShareCellHtml(share, count);
      return share;
    });
  });
  // Some older snapshots could substitute a different window per doctor.
  if (rows.length && rows.every(row => row.cells[1]?.textContent === rows[0].cells[1]?.textContent)) {
    table.insertAdjacentHTML("beforebegin", presentation.clientBaseAveragesHtml(groups, shares));
  }
}
for (const table of document.querySelectorAll(".viewer-dashboard-snapshot #tblCompare")) {
  const rows = [...table.rows];
  const find = label => rows.find(row => row.cells[0]?.textContent.trim() === label);
  const visits = find("Визиты за месяц"), patients = find("Пациенты за месяц");
  if (!visits || !patients || find("Визитов на пациента")) continue;
  const rate = patients.cloneNode(true);
  rate.cells[0].textContent = "Визитов на пациента";
  [...rate.cells].slice(1).forEach((cell, index) => {
    const numerator = presentation.publishedReportCount(visits.cells[index + 1]?.textContent.trim());
    const denominator = presentation.publishedReportCount(cell.textContent.trim());
    cell.textContent = numerator != null && denominator > 0
      ? (numerator / denominator).toLocaleString("ru-RU", { maximumFractionDigits: 2 }) : "—";
  });
  patients.after(rate);
}
for (const section of document.querySelectorAll(".viewer-dashboard-snapshot [data-primary-patients-summary]")) {
  for (const note of [...section.querySelectorAll("p")]) {
    if (!note.closest("[data-report-help]") && /^(Первичный —|Наблюдение —|Направления:)/.test(note.textContent.trim())) reportHelpBody(section).appendChild(note);
  }
}
for (const table of document.querySelectorAll("#tblDepartmentYear")) {
  table.classList.add("department-year-table");
  if (!table.parentElement.classList.contains("department-year-scroll")) {
    const wrapper = document.createElement("div");
    wrapper.className = "department-year-scroll";
    table.parentElement.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  }
  for (const cell of table.querySelectorAll("th")) {
    cell.innerHTML = window.klinvektReportPresentation.tableHeaderHtml(cell.textContent);
  }
}
const chartCards = [...document.querySelectorAll(".cloud-data-report .report-chart, .viewer-dashboard-snapshot .device-history-report")];
const preparedCharts = new WeakMap();
const drawChart = card => {
  let chart = preparedCharts.get(card);
  if (!chart) { chart = JSON.parse(card.dataset.chart); preparedCharts.set(card, chart); }
  const plot = card.querySelector(".chart-plot");
  plot.innerHTML = window.klinvektReportCharts.chartPlot(chart, card.querySelector("[data-chart-series]")?.value || (chart.id === "scores" ? "0" : "all"));
  plot.style.minHeight = ""; delete card.dataset.chartDeferred;
};
for (const card of chartCards) card.querySelector("[data-chart-series]")?.addEventListener("change", () => drawChart(card));
if (typeof IntersectionObserver === "function") {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      if (entry.target.dataset.chartDeferred) drawChart(entry.target);
      observer.unobserve(entry.target);
    }
  }, { rootMargin: "150px" });
  chartCards.filter(card => card.dataset.chartDeferred).forEach(card => observer.observe(card));
} else chartCards.filter(card => card.dataset.chartDeferred).forEach(drawChart);
window.addEventListener("beforeprint", () => {
  for (const details of document.querySelectorAll(".cloud-data-report details:not(.report-help), .viewer-dashboard-snapshot [data-specialization-device-history], .viewer-dashboard-snapshot [data-device-month-card] details")) details.open = true;
  chartCards.filter(card => card.dataset.chartDeferred).forEach(drawChart);
  for (const image of document.images) image.loading = "eager";
});
for (const image of document.images) { image.loading = "lazy"; image.decoding = "async"; }
for (const table of document.querySelectorAll(".viewer-dashboard-snapshot table.data")) {
  const heads = [...table.querySelectorAll("tr.grp-head[data-g]")];
  if (!heads.length) continue;
  const open = new Map(heads.map(row => [row.dataset.g, row.querySelector("td span")?.textContent.trim() === "▾"]));
  const refresh = () => {
    for (const row of table.querySelectorAll("tr[data-group-ancestors]")) {
      row.style.display = String(row.dataset.groupAncestors || "").split(/\s+/).filter(Boolean).every(key => open.get(key)) ? "" : "none";
    }
    for (const row of table.querySelectorAll("tr.grp-sub:not([data-group-ancestors])")) {
      const group = [...row.classList].find(name => open.has(name));
      if (group) row.style.display = open.get(group) ? "" : "none";
    }
    for (const row of heads) {
      const marker = row.querySelector("td span");
      if (marker) marker.textContent = open.get(row.dataset.g) ? "▾" : "▸";
      row.setAttribute("aria-expanded", String(open.get(row.dataset.g)));
    }
  };
  for (const row of heads) {
    row.tabIndex = 0; row.setAttribute("role", "button");
    const toggle = () => { open.set(row.dataset.g, !open.get(row.dataset.g)); refresh(); };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); toggle(); } });
  }
  refresh();
}
