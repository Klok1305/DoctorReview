(function (root) {
  "use strict";
  const headings = {
    "Выручка с перенаправлениями": ["Выручка", "с перенаправлениями"],
    "Доля перенаправлений от выручки": ["Доля перенаправлений", "от выручки"],
    "Возвращаемость первички за 3 месяца": ["Возвращаемость первички", "за 3 месяца"],
    "Возвращаемость первички за 6 месяцев": ["Возвращаемость первички", "за 6 месяцев"],
    "Активные пациенты": ["Активные", "пациенты"],
    "Потерянные пациенты": ["Потерянные", "пациенты"],
    "Загрузка отделения за месяц": ["Загрузка отделения", "за месяц"],
    "К прошлому месяцу": ["К прошлому", "месяцу"],
  };
  function tableHeaderLines(value) {
    const label = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    if (Object.prototype.hasOwnProperty.call(headings, label)) return headings[label];
    const month = /^(Январь|Февраль|Март|Апрель|Май|Июнь|Июль|Август|Сентябрь|Октябрь|Ноябрь|Декабрь) (\d{4})$/.exec(label);
    return month ? [month[1], month[2]] : [label];
  }
  const escape = value => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  function tableHeaderHtml(value) {
    const lines = tableHeaderLines(value);
    return lines.length === 1 ? escape(lines[0])
      : lines.map(line => `<span class="report-table-heading-line">${escape(line)}</span>`).join("\n");
  }
  const clientBaseGroups = [
    { key: "active", label: "Активные лояльные", color: "#16a34a", lowerBetter: false },
    { key: "loyalSleep", label: "Лояльные спящие", color: "#94a3b8", lowerBetter: true },
    { key: "newRisk", label: "Новые в риске", color: "#d97706", lowerBetter: true },
    { key: "lost", label: "Потерянные", color: "#dc2626", lowerBetter: true },
  ];
  const overlappingClientBaseGroups = [
    { key: "loyal", label: "Лояльные", color: "#2563eb", lowerBetter: false },
    { key: "active", label: "Активные", color: "#16a34a", lowerBetter: false },
    { key: "newRisk", label: "Новые, риск", color: "#d97706", lowerBetter: true },
    { key: "loyalSleep", label: "Лояльные, спящие", color: "#94a3b8", lowerBetter: true },
    { key: "lost", label: "Потерянные", color: "#dc2626", lowerBetter: true },
  ];
  function clientBaseDefinitionsHtml() {
    return `<section class="client-base-table-note small muted" data-client-base-definitions><h3>Что означают группы?</h3><ul>
      <li><b>Лояльные:</b> не менее 4 визитов, последний визит не более 12 месяцев назад.</li>
      <li><b>Активные:</b> не менее 4 визитов за последние 6 месяцев.</li>
      <li><b>Новые, риск:</b> от 1 до 2 визитов, последний визит более 6 месяцев назад.</li>
      <li><b>Лояльные, спящие:</b> не менее 4 визитов, последний визит более 6 месяцев назад.</li>
      <li><b>Потерянные:</b> от 1 до 2 визитов, последний визит более 12 месяцев назад.</li></ul>
      <p>Проценты считаются от общей клиентской базы. Группы могут пересекаться. Если порог превышает выбранный период, группа не отображается; ноль не подставляется. Для активных используется число визитов из точной выгрузки за 6 месяцев.</p></section>`;
  }
  const primarySourceGroups = ["Все рекомендации", "Интернет", "Агрегаторы", "Социальные сети", "Не распределено"]
    .map((label, i) => ({ label, color: ["#16a34a", "#2563eb", "#7c3aed", "#d97706", "#94a3b8"][i] }));
  const number = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
  const pct = value => Number.isFinite(value) ? number.format(value) + "%" : "—";
  function clientBaseShareCellHtml(share, count) {
    return `<strong class="client-base-cell-share">${pct(share)}</strong>${count ? `<small class="client-base-cell-count">${escape(count)} чел.</small>` : ""}`;
  }
  function clientBaseAveragesHtml(labels, sharesByDoctor) {
    if (!labels.length) return "";
    const items = labels.map((label, index) => {
      const values = sharesByDoctor.map(shares => shares[index]).filter(Number.isFinite);
      const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      return `<span class="client-base-average"><span>${escape(label)}</span> <strong>${pct(average)}</strong>${values.length < sharesByDoctor.length ? ` <small>${values.length} из ${sharesByDoctor.length} врачей</small>` : ""}</span>`;
    }).join("");
    return `<div class="client-base-averages" data-client-base-averages><span class="client-base-averages-label">Среднее по врачам</span>${items}</div>`;
  }
  const publishedReportCount = value => /^\d[\d\s]*$/.test(value) ? Number(value.replace(/\s/g, "")) : null;
  function publishedClientBaseShare(total, count, share) {
    if (!/^\d+(?:[,.]\d+)?%$/.test(share)) return null;
    const saved = Number(share.slice(0, -1).replace(",", "."));
    // Published percentages are rounded. Recover full precision when the saved counts agree.
    const base = publishedReportCount(total), patients = publishedReportCount(count);
    const exact = base > 0 && patients != null ? patients / base * 100 : null;
    return exact != null && pct(exact) === pct(saved) ? exact : saved;
  }
  function periodValueStates(values, lowerBetter = false) {
    // Compare displayed precision, so equal-looking percentages have equal colours.
    const rounded = values.map(value => Number.isFinite(value) ? Math.round(value * 10) / 10 : null);
    const known = rounded.filter(Number.isFinite), min = Math.min(...known), max = Math.max(...known);
    return rounded.map(value => value == null || min === max ? "" : value === (lowerBetter ? min : max) ? "period-best" : value === (lowerBetter ? max : min) ? "period-worst" : "");
  }
  function clientBaseShareTableHtml(labels, series) {
    return `<div class="client-base-share-history" data-client-base-share-history><div class="client-base-table-heading"><h3>Доли по месяцам</h3><span class="period-colour-key"><span class="period-best">Лучшее</span><span class="period-worst">Худшее</span></span></div>
      <div class="primary-patients-scroll"><table class="data client-base-share-table" data-client-base-share-table><thead><tr><th>Группа пациентов</th>${labels.map(label => `<th class="num">${tableHeaderHtml(label)}</th>`).join("")}</tr></thead><tbody>${series.map((row, index) => {
        const values = row.values, states = periodValueStates(values, row.lowerBetter ?? clientBaseGroups[index]?.lowerBetter);
        return `<tr data-client-base-group="${escape(row.key || clientBaseGroups[index]?.key || "")}" data-period-values="${escape(JSON.stringify(values))}"><th scope="row">${escape(String(row.label))}</th>${values.map((value, i) => `<td class="num ${states[i]}"${states[i] ? ` aria-label="${states[i] === "period-best" ? "Лучшее" : "Худшее"} за период: ${pct(value)}"` : ""}>${pct(value)}</td>`).join("")}</tr>`;
      }).join("")}</tbody></table></div></div>`;
  }
  function clientBaseCompositionHtml(values, period = "", options = {}) {
    const groups = options.groups || clientBaseGroups, title = options.title || "Состав клиентской базы";
    const valid = values.length === groups.length && values.every(value => Number.isFinite(value) && value >= 0);
    const total = valid ? values.reduce((sum, value) => sum + value, 0) : null;
    let angle = -Math.PI / 2;
    const position = (a, radius) => [130 + Math.cos(a) * radius, 130 + Math.sin(a) * radius].map(value => value.toFixed(3)).join(",");
    const sectors = total > 0 ? values.map((value, index) => {
      if (!value) return "";
      const start = angle, sweep = value / total * Math.PI * 2;
      angle += sweep;
      const label = `${groups[index].label}: ${number.format(value)} чел. · ${pct(value / total * 100)}`;
      const shape = value === total ? `<circle cx="130" cy="130" r="112" fill="${groups[index].color}"><title>${escape(label)}</title></circle>`
        : `<path d="M130,130 L${position(start, 112)} A112,112 0 ${sweep > Math.PI ? 1 : 0},1 ${position(angle, 112)} Z" fill="${groups[index].color}" stroke="#fff" stroke-width="2"><title>${escape(label)}</title></path>`;
      return shape + (value / total >= .05 ? `<text x="${position(start + sweep / 2, 74).split(",")[0]}" y="${position(start + sweep / 2, 74).split(",")[1]}" text-anchor="middle" dominant-baseline="middle" class="client-base-sector-label">${pct(value / total * 100)}</text>` : "");
    }).join("") : "";
    return `<section class="client-base-composition" ${options.groups ? 'data-primary-source-composition' : 'data-client-base-composition'} data-client-base-values="${escape(JSON.stringify(values))}"><h3>${escape(title)}${period ? ` · ${escape(String(period))}` : ""}</h3>${total > 0 ? `<div class="client-base-pie-layout"><svg viewBox="0 0 260 260" role="img" aria-label="${escape(title)}"><title>${options.groups ? "Первичные пациенты" : "Клиентская база"}: ${number.format(total)} чел.</title>${sectors}</svg><ul class="client-base-pie-legend">${groups.map((group, index) => `<li><span class="client-base-pie-key" style="background:${group.color}"></span><span>${escape(group.label)}</span><b>${number.format(values[index])} чел.</b><strong>${pct(values[index] / total * 100)}</strong></li>`).join("")}</ul></div>` : `<p class="muted">${total === 0 ? (options.groups ? "В этом периоде первичных пациентов нет." : "В этом месяце пациентов нет.") : "За выбранный период нет данных."}</p>`}</section>`;
  }
  function primarySourcesHtml(sources, month, year) {
    return `<section data-primary-sources><h3>Источники первичных пациентов</h3><div class="primary-source-charts">${[["year", `С начала ${year} года — ${month}`], ["month", `За последний месяц · ${month}`]].map(([key, period]) => {
      const data = sources[key];
      return `<div data-primary-source-period="${key}">${clientBaseCompositionHtml(data.counts, "", { groups: primarySourceGroups, title: period })}
        ${!data.complete ? '<p class="notice blue">Неполные данные первичности: показаны только пациенты загруженных отчётов с подтверждённой первичностью.</p>' : ""}
        ${data.unresolved.length ? `<p class="small muted">Не распределено: ${data.unresolved.map(item => `${escape(item.label)} — ${number.format(item.count)}`).join("; ")}. Эти пациенты входят в общее количество и знаменатель процентов.</p>` : ""}</div>`;
    }).join("")}</div></section>`;
  }
  function reportHelpHtml(body, title = "Справка о расчётах") {
    return body ? `<details class="report-help" data-report-help><summary>${escape(title)}</summary><div class="report-help-body">${body}</div></details>` : "";
  }
  const api = { tableHeaderLines, tableHeaderHtml, clientBaseGroups, overlappingClientBaseGroups, clientBaseDefinitionsHtml, primarySourceGroups, primarySourcesHtml, periodValueStates,
    clientBaseShareTableHtml, clientBaseCompositionHtml, clientBaseShareCellHtml, clientBaseAveragesHtml, publishedReportCount, publishedClientBaseShare, reportHelpHtml };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.klinvektReportPresentation = api;
})(typeof globalThis === "object" ? globalThis : this);
