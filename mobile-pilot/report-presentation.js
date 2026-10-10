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
  const api = { tableHeaderLines, tableHeaderHtml };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.klinvektReportPresentation = api;
})(typeof globalThis === "object" ? globalThis : this);
