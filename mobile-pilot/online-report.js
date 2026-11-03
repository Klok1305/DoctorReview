"use strict";
for (const board of document.querySelectorAll(".reputation-honor-board")) board.remove();
// Older HTML snapshots receive the same presentation without changing their data.
const presentation = window.klinvektReportPresentation;
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
  for (const heading of section.querySelectorAll("h3")) if (/^ДИНАМИКА КЛИЕНТСКОЙ БАЗЫ ПО МЕСЯЦАМ/i.test(heading.textContent.trim())) {
    const container = heading.parentElement;
    if (container === section) continue;
    for (const child of [...container.children]) {
      if (child === heading || child.classList.contains("chart-box")) child.remove();
      else if (child.matches("p.small")) help.appendChild(child);
    }
  }
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
const chartCards = [...document.querySelectorAll(".cloud-data-report .report-chart")];
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
  for (const details of document.querySelectorAll(".cloud-data-report details:not(.report-help)")) details.open = true;
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
