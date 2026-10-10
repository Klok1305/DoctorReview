"use strict";
for (const board of document.querySelectorAll(".reputation-honor-board")) board.remove();
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
  for (const details of document.querySelectorAll(".cloud-data-report details")) details.open = true;
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
