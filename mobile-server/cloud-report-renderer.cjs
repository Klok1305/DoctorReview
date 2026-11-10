"use strict";
const fs = require("node:fs"), path = require("node:path");
const chartsPath = fs.existsSync(path.join(__dirname, "public", "report-charts.js"))
  ? "./public/report-charts.js" : "../mobile-pilot/report-charts.js";
const { renderCharts, chartTable } = require(chartsPath);
const presentation = require(chartsPath.replace("report-charts.js", "report-presentation.js"));
const { tableHeaderHtml } = presentation;
const esc = value => String(value == null ? "" : value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const lines = value => esc(value).replace(/\r?\n/g, "<br>");
const score = value => Number.isFinite(value) ? esc(value) : "—";
function renderMetrics(metrics = []) {
  return `<div class="cloud-kpis">${metrics.map(metric => `<div class="kpi ${esc(metric.state || "neutral")}"><span>${esc(metric.label)}</span><b class="val">${esc(metric.value)}</b>
    ${metric.note ? `<small>${esc(metric.note)}</small>` : ""}${metric.target ? `<em>${esc(metric.target)}</em>` : ""}
    ${(metric.history || []).map(row => `<small>${esc(row.label)}: ${esc(row.delta)} · ${esc(row.value)}</small>`).join("")}</div>`).join("")}</div>`;
}
function renderTable(columns = [], rows = [], renderCell = esc) {
  if (!rows.length) return "";
  return `<div class="cloud-table-scroll"><table><thead><tr>${columns.map(value => `<th>${tableHeaderHtml(value)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((row, rowIndex) => `<tr>${row.map((value, index) => `<td>${renderCell(value, index, rowIndex)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function renderClientBaseComparison(section, options) {
  const groupStart = 4;
  const groups = section.columns.slice(groupStart);
  const counts = section.rows.map(row => row.slice(groupStart).map(value => value.split(" · ")[0]));
  const shares = section.rows.map((row, index) => row.slice(groupStart).map((value, group) =>
    presentation.publishedClientBaseShare(row[2], counts[index][group], value.split(" · ")[1])));
  const averages = presentation.clientBaseAveragesHtml(groups, shares);
  return `<section class="cloud-section"><div class="client-base-heading"><h3>${esc(section.title)}</h3>${averages}</div>${renderSectionNote(section.note, options)}
    ${renderTable(section.columns, section.rows, (value, index, row) => {
      if (index < groupStart) return esc(value);
      const count = counts[row][index - groupStart];
      return presentation.clientBaseShareCellHtml(shares[row][index - groupStart], count === "—" ? "" : count);
    })}</section>`;
}
function renderTree(nodes = [], columns = []) {
  return nodes.map(node => {
    const row = `<span>${esc(node.label)}</span><span class="cloud-tree-values">${node.values.map((value, i) => `<span><small>${esc(columns[i + 1])}</small><b>${esc(value)}</b></span>`).join("")}</span>`;
    return node.children?.length ? `<details class="cloud-tree"><summary>${row}</summary><div>${renderTree(node.children, columns)}</div></details>`
      : `<div class="cloud-tree-leaf">${row}</div>`;
  }).join("");
}
function renderSections(sections = [], options = {}) {
  const deviceDetails = new Map();
  if (options.kind === "specialization") for (const section of sections) {
    if (section.title !== "Аппаратные методики по врачам" || section.columns?.[1] !== "Аппарат") continue;
    for (const [name, device, q, s] of section.rows || []) {
      if (!deviceDetails.has(device)) deviceDetails.set(device, []);
      deviceDetails.get(device).push({ name, q: presentation.publishedDeviceMeasure(q), s: presentation.publishedDeviceMeasure(s) });
    }
  }
  sections = sections.map(section => {
    const index = section.columns?.findIndex(label => ["Отзывы", "Всего отзывов"].includes(label));
    if (!(index > 0) || !["Врач", "Сотрудник"].includes(section.columns[0])) return section;
    const count = row => /^\d[\d\s\u00a0]*(?:\s*шт\.)?$/.test(String(row[index]).trim()) ? Number(String(row[index]).replace(/шт\.|\s/g, "")) : -1;
    return { ...section, rows: [...section.rows].sort((a,b) => count(b) - count(a) || a[0].localeCompare(b[0], "ru")) };
  });
  return sections.map(section => {
    if (options.kind === "specialization" && section.title === "Аппаратные методики по врачам") return "";
    if (options.kind === "specialization" && section.title === "Аппараты за месяц" && section.columns?.[0] === "Аппарат") {
      const cards = (section.rows || []).map(([name, q, s]) => ({ name, q: presentation.publishedDeviceMeasure(q), s: presentation.publishedDeviceMeasure(s), doctors: deviceDetails.get(name) }));
      return `<section class="cloud-section" data-specialization-device-month><h3>${esc(section.title)}</h3>${presentation.deviceMonthCardsHtml(cards)}
        ${cards.length && !deviceDetails.size ? '<p class="small muted">Разбивка по специалистам доступна после новой публикации.</p>' : ""}</section>`;
    }
    if (options.kind === "specialization" && section.title === "Загрузка аппаратов") {
      const content = renderSectionContent({ ...section, charts: presentation.splitDeviceHistoryCharts(section.charts) },
        { ...options, renderValues: chart => presentation.deviceHistoryDetailsHtml([chart]) });
      return `<details class="collapsible-list cloud-section" data-specialization-device-history><summary class="collapsible-list-summary"><span>${esc(section.title)}</span><span class="collapse-hint"></span></summary><div class="collapsible-list-body">${presentation.deviceHistoryDetailsHtml(section.charts, true)}${content}</div></details>`;
    }
    if (options.kind === "specialization" && section.title === "Первичные пациенты" && section.columns?.[1] === "Первичных за месяц") {
      const sources = section.charts?.find(chart => chart.id === "specialization-primary-sources");
      const counts = sources?.series[0]?.values;
      const coverage = section.metrics?.find(metric => metric.label === "Врачи с данными");
      return `<section class="cloud-section" data-specialization-primary><h3>${esc(section.title)}</h3>${renderSectionNote(section.note, options)}
        ${coverage && !counts?.every(Number.isFinite) ? `<p class="small muted">Данные есть у ${esc(coverage.value)} врачей.</p>` : ""}
        ${presentation.specializationPrimarySummaryHtml(section.rows || [], counts)}
        ${renderCharts(section.charts?.filter(chart => chart !== sources), {
          ...options, renderValues: chart => chart.id === "specialization-primary" ? "" : chartTable(chart),
        })}</section>`;
    }
    const content = renderSectionContent(section, options);
    return `<section class="cloud-section"><h3>${esc(section.title)}</h3>${renderSectionNote(section.note, options)}
      ${renderMetrics(section.metrics)}${content}</section>`;
  }).join("");
}
function renderSectionContent(section, options) {
  const charts = section.charts?.some(chart => chart.id.startsWith("primary-sources-"))
    ? `<div class="primary-source-charts" data-primary-sources>${section.charts.map(chart => `<div data-primary-source-period="${esc(chart.id.replace("primary-sources-", ""))}">${presentation.clientBaseCompositionHtml(chart.series[0].values, "", { groups: presentation.primarySourceGroups, title: chart.title })}</div>`).join("")}</div>`
    : renderCharts(section.charts, options);
  return (section.tree?.length ? renderTree(section.tree, section.columns) : renderTable(section.columns, section.rows)) + charts;
}
function renderSectionNote(note, options) {
  if (!note) return "";
  if (!options.help) return `<p>${lines(note)}</p>`;
  options.help.push(`<p>${lines(note)}</p>`);
  const missing = note.match(/Неполные данные:[^.]+\.?/i);
  return missing ? `<p class="cloud-completeness">${esc(missing[0])}</p>`
    : /учтены предварительно/i.test(note) ? '<p class="cloud-completeness">Часть пациентов учтена предварительно. Подробности — в справке.</p>' : "";
}
function renderClientBase(vector, report, options) {
  const sections = vector.windows?.[0]?.sections || vector.sections || [], current = sections[0] || {};
  const charts = current.charts || [], composition = charts.find(chart => chart.id === "partition"), history = charts.find(chart => chart.id === "partition-shares");
  if (current.columns?.includes("Условие")) options.help.push(`<ul>${(current.rows || []).map(row => `<li><b>${esc(row[0])}:</b> ${esc(row[row.length - 1])}</li>`).join("")}</ul>`);
  options.help.push('<p>Зелёным в таблице показаны лучшие значения за период, красным — худшие. Для активных лояльных лучше большая доля, для остальных групп — меньшая.</p>');
  return '<p class="cloud-completeness">Этот отчёт сохранён с прежними четырьмя группами. Для пяти групп и сравнения по единой методике сформируйте новую публикацию в обновлённом Админ.</p>' + renderSectionNote(current.note, options) + renderMetrics(current.metrics)
    + presentation.clientBaseCompositionHtml(composition?.series[0]?.values || [null, null, null, null], report.label)
    + (history ? presentation.clientBaseShareTableHtml(history.labels, history.series.map((series, index) => ({ ...presentation.clientBaseGroups[index], label: series.label, values: series.values }))) : "")
    + renderCharts(charts.filter(chart => !["partition", "partition-shares"].includes(chart.id)), options)
    + renderSections(sections.slice(1), options);
}
function v3Tile(key, title, notes, metric, caption, body = "") {
  const content = `<span class="v3-tile-copy"><b>${esc(title)}</b>${notes.filter(Boolean).map(note => `<small>${esc(note)}</small>`).join("")}</span>
    ${metric ? `<span class="v3-tile-value"><strong class="appointment-conversion-summary-value goal-${esc(metric.state)}">${esc(metric.value)}</strong>${caption ? `<small>${esc(caption)}</small>` : ""}</span>` : ""}`;
  return body ? `<details class="collapsible-list" data-v3-section="${key}"><summary class="collapsible-list-summary v3-tile">${content}</summary><div class="collapsible-list-body">${body}</div></details>`
    : `<div class="v3-tile v3-empty" data-v3-section="${key}">${content}</div>`;
}
function renderDoctorV3(vector, report, options) {
  const windows = vector.windows?.length ? vector.windows : [{ sections: vector.sections || [] }];
  const metric = (section, label) => section?.metrics?.find(item => item.label === label);
  const windowNote = window => window.label ? `Окно назначений · ${window.label}` : "";
  const findSection = (window, title) => window.sections.find(section => section.title.startsWith(title));
  const showWindows = (render) => windows.map((window, index) =>
    `<div class="v3-window-panel" data-v3-window-panel="${esc(window.id || "")}"${index ? " hidden" : ""}>${render(window)}</div>`).join("");
  const picker = windows.length > 1 ? `<label class="v3-window-picker">Окно назначений <select data-v3-window>${windows.map(window =>
    `<option value="${esc(window.id)}">${esc(window.label)}</option>`).join("")}</select></label>` : "";
  const revenue = findSection(windows[0], "Выполненные направления");
  const earned = metric(revenue, "Выполнено по выработке");
  const credited = metric(revenue, "Учтено в перенаправлениях");
  const total = metric(revenue, "Выручка с перенаправлениями");
  const share = metric(revenue, "Доля выручки");
  return picker + showWindows(window => {
    const focus = findSection(window, "Фокусы междисциплинарного подхода");
    return v3Tile("focus", "Фокусы междисциплинарного подхода",
      focus ? [windowNote(window)] : ["Нет выгрузки «Назначения»."], metric(focus, "Позиций выполнено"), "позиций выполнено",
      focus ? renderSectionContent(focus, options) : "");
  }) + v3Tile("revenue", "Выполненные направления за месяц", [
    earned && credited ? `${report.label} · учтено ${credited.value} из ${earned.value} выполненных` : report.label,
    total && `Выручка с перенаправлениями ${total.value} · источник: отчёт «Выработка»`,
  ], share, ["доля в общей выработке", share?.target].filter(Boolean).join(" · "), revenue ? renderSectionContent(revenue, options) : "")
    + showWindows(window => {
      const summary = findSection(window, "Конверсия назначений");
      const conversion = metric(summary, "Конверсия");
      const assigned = metric(summary, "Назначено");
      const result = metric(summary, "Результат");
      const detail = findSection(window, "Детали назначений");
      const counts = assigned && result ? `${result.value} из ${assigned.value} назначений` : "";
      const body = detail ? `<p class="v3-method">Услуги: выполнено + продано, товары: продано.</p>
        <details class="collapsible-list"><summary class="collapsible-list-summary"><span>Детализация по услугам и группам 1С</span><span class="collapse-hint"></span></summary>
        <div class="collapsible-list-body">${detail.note ? `<p>${lines(detail.note)}</p>` : ""}${renderSectionContent(detail, options)}</div></details>` : "";
      return v3Tile("conversion", "Конверсия назначений",
        [conversion ? [windowNote(window), counts].filter(Boolean).join(" · ") : "Нет выгрузки «Назначения»."],
        conversion, conversion?.target || "цель не установлена", body);
    });
}
function renderSpecializationBaseHistory(vector, report, options) {
  if (options.kind !== "specialization") return "";
  const section = vector.sections?.find(item => item.title === "Динамика клиентской базы");
  if (section) return renderSections([section], options);
  const archived = vector.windows?.find(window => window.id === "36")?.sections
    .flatMap(item => item.charts || []).find(chart => chart.id === "specialization-base-history");
  if (!archived) return "";
  const endMonth = Number(String(report.id).slice(5));
  const months = endMonth >= 1 && endMonth <= 12 ? endMonth : 12;
  const chart = { ...archived, title: "Динамика с начала года · база за 36 месяцев", labels: archived.labels.slice(-months),
    series: archived.series.map(series => ({ ...series, values: series.values.slice(-months), pointNotes: series.pointNotes?.slice(-months) })) };
  return renderSections([{ title: "Динамика клиентской базы", charts: [chart] }], options);
}

function renderDoctorBasePartitionHistory(vector, options) {
  const history = vector.sections?.find(section => section.title === "Динамика клиентской базы по месяцам");
  if (!history) return "";
  return `<section class="cloud-section kb-partition-history" data-client-base-partition-history>
    ${history.charts?.length ? "" : `<h3>${esc(history.title)}</h3>`}
    <p class="small muted">${lines(history.note)}</p>
    ${renderCharts(history.charts, options)}
    <details><summary>Правила четырёх групп за 36 месяцев</summary>
      <ul>${(history.rows || []).map(([label, rule]) => `<li><b>${esc(label)}</b> — ${esc(rule)}.</li>`).join("")}</ul>
    </details></section>`;
}

function renderVector(vector, report, options) {
  const help = [vector.detail, vector.methodologyLabel].filter(Boolean).map(text => `<p>${lines(text)}</p>`);
  const sectionOptions = { ...options, help };
  const partitioned = vector.id === "v4" && vector.methodologyId === "partition-v1-36m";
  const overlapping = vector.id === "v4" && vector.methodologyId === "report-overlap-v1";
  const doctorV3 = vector.id === "v3" && (options.kind === "doctor" || (!options.kind && vector.windowPickerLabel === "Окно назначений"));
  const body = doctorV3 ? renderDoctorV3(vector, report, options)
    : overlapping ? `<label class="client-base-window-picker">Период базы <select data-client-base-window>${vector.windows.map(window => `<option value="${esc(window.id)}">${esc(window.label)}</option>`).join("")}</select></label>`
    + vector.windows.map((window, index) => `<div data-client-base-window-panel="${esc(window.id)}"${index ? " hidden" : ""}>${window.sections.map(section => {
      if (section.title === "Клиентская база · сравнение врачей" && section.columns?.[3] === "Изменение базы") {
        return renderClientBaseComparison(section, sectionOptions);
      }
      const history = section.charts?.find(chart => chart.id === "overlap-shares");
      const charts = section.charts?.filter(chart => chart !== history && chart.id !== "specialization-base-history");
      if (section.title === "Динамика клиентской базы" && section.charts?.length && !charts.length) return "";
      return renderSections([{ ...section, charts }], sectionOptions)
        + (history ? presentation.clientBaseShareTableHtml(history.labels, history.series.map(series => ({ ...presentation.overlappingClientBaseGroups.find(group => group.label === series.label), label: series.label, values: series.values }))) : "");
    }).join("")}</div>`).join("") + renderSpecializationBaseHistory(vector, report, sectionOptions) + renderDoctorBasePartitionHistory(vector, sectionOptions)
    + presentation.clientBaseDefinitionsHtml(vector.sections?.find(section => section.title === "Что означают группы?"))
    : partitioned ? renderClientBase(vector, report, sectionOptions)
    : vector.windows?.length ? vector.windows.map((window, index) => `<details class="cloud-window" ${index === 0 ? "open" : ""}><summary>${esc(vector.windowPickerLabel || "Период")}: ${esc(window.label)}</summary><p>${esc(window.period)}</p>${renderSections(window.sections, sectionOptions)}</details>`).join("")
      : renderSections(vector.sections, sectionOptions);
  return `<details class="cloud-vector" data-vector-key="${esc(vector.id)}" open><summary><span>В${vector.number} · ${esc(vector.title)}</span><b>${score(vector.score)}${vector.preliminary ? " · предв." : ""}</b></summary>${body}${presentation.reportHelpHtml(help.join(""))}</details>`;
}
function renderCloudReport(report, title, options = {}) {
  const completeness = [report.preliminary ? "Предварительная оценка" : "", report.coverage != null ? `Полнота: ${report.coverage}%` : "", ...(report.missing || [])].filter(Boolean);
  const dynamicsCharts = options.kind === "specialization"
    ? report.dynamics?.charts?.filter(chart => chart.id !== "scores") : report.dynamics?.charts;
  return `<main class="cloud-data-report"><header class="cloud-heading"><div><h1>${esc(title)}</h1><p>${esc(report.assessment)}</p></div><div class="cloud-score">${score(report.overall)}<small>общий балл</small></div></header>
    <p>${esc(report.summary)}</p>${completeness.length ? `<p class="cloud-completeness">${completeness.map(esc).join(" · ")}</p>` : ""}
    ${renderMetrics(report.headlineMetrics)}
    ${report.goals?.length ? `<details class="cloud-vector"><summary>Цели</summary>${report.goals.map(goal => `<p><b>${esc(goal.title)}</b> · ${esc(goal.description)}</p>`).join("")}</details>` : ""}
    ${report.vectors.map(vector => renderVector(vector, report, options)).join("")}
    ${report.dynamics ? `<details class="cloud-vector" open><summary>Динамика показателей по месяцам</summary>${renderCharts(dynamicsCharts, options)}
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
      const html = renderCloudReport(page.report, page.title, { deferred: true, kind: page.kind }); renders++;
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
