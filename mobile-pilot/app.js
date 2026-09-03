(() => {
  "use strict";

  const bundledDemo = window.KLINVEKT_MOBILE_DEMO;
  if (!bundledDemo || bundledDemo.demo !== true || !Array.isArray(bundledDemo.periods)) {
    document.body.textContent = "Не удалось загрузить безопасные тестовые данные.";
    return;
  }
  let reportData = bundledDemo;

  const elements = {
    reportScroller: document.getElementById("reportScroller"),
    loginView: document.getElementById("loginView"),
    reportView: document.getElementById("reportView"),
    bottomNav: document.getElementById("bottomNav"),
    logoutButton: document.getElementById("logoutButton"),
    openDemoButton: document.getElementById("openDemoButton"),
    openReportLabel: document.getElementById("openReportLabel"),
    loadPublicationButton: document.getElementById("loadPublicationButton"),
    publicationInput: document.getElementById("publicationInput"),
    publicationStatus: document.getElementById("publicationStatus"),
    serverPublicationShortcut: document.getElementById("serverPublicationShortcut"),
    loadBundleButton: document.getElementById("loadBundleButton"),
    bundleInput: document.getElementById("bundleInput"),
    serverPublicationStatus: document.getElementById("serverPublicationStatus"),
    staticProfile: document.getElementById("staticProfile"),
    serverLoginForm: document.getElementById("serverLoginForm"),
    serverDoctorSelect: document.getElementById("serverDoctorSelect"),
    serverPin: document.getElementById("serverPin"),
    serverLoginButton: document.getElementById("serverLoginButton"),
    serverLoginStatus: document.getElementById("serverLoginStatus"),
    bitrixAccount: document.getElementById("bitrixAccount"),
    loginDoctorName: document.getElementById("loginDoctorName"),
    loginDoctorDepartment: document.getElementById("loginDoctorDepartment"),
    profileBadge: document.getElementById("profileBadge"),
    loginAvatar: document.querySelector(".demo-profile .avatar"),
    doctorName: document.getElementById("doctorName"),
    doctorDepartment: document.getElementById("doctorDepartment"),
    reportOwnerLabel: document.getElementById("reportOwnerLabel"),
    teamReports: document.getElementById("teamReports"),
    teamReportsContext: document.getElementById("teamReportsContext"),
    teamDoctorSelect: document.getElementById("teamDoctorSelect"),
    teamReportStatus: document.getElementById("teamReportStatus"),
    ownReportButton: document.getElementById("ownReportButton"),
    periodSelect: document.getElementById("periodSelect"),
    previousPeriod: document.getElementById("previousPeriod"),
    nextPeriod: document.getElementById("nextPeriod"),
    overallScore: document.getElementById("overallScore"),
    scoreRing: document.getElementById("scoreRing"),
    scoreAssessment: document.getElementById("scoreAssessment"),
    scoreSummary: document.getElementById("scoreSummary"),
    scoreDelta: document.getElementById("scoreDelta"),
    headlineMetrics: document.getElementById("headlineMetrics"),
    vectorGrid: document.getElementById("vectorGrid"),
    vectorDetail: document.getElementById("vectorDetail"),
    trendValue: document.getElementById("trendValue"),
    trendCaption: document.getElementById("trendCaption"),
    trendChart: document.getElementById("trendChart"),
    trendLabels: document.getElementById("trendLabels"),
    comparisonList: document.getElementById("comparisonList"),
    dynamicsInsights: document.getElementById("dynamicsInsights"),
    desktopCharts: document.getElementById("desktopCharts"),
    goalsSource: document.getElementById("goalsSource"),
    goalsList: document.getElementById("goalsList"),
    commentsList: document.getElementById("commentsList"),
    connectionStatus: document.getElementById("connectionStatus"),
    installButton: document.getElementById("installButton"),
    installCard: document.getElementById("installCard"),
    installDialog: document.getElementById("installDialog"),
  };

  const state = {
    periodIndex: 0,
    vectorId: "v1",
    windowSelections: {},
    tab: "overview",
    installPrompt: null,
    serverMode: false,
    serverContext: null,
    reportAccess: null,
    reportRequestId: 0,
  };

  const escapeHtml = (value) => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  const signed = (value) => Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value}` : "—";
  const currentPeriod = () => reportData.periods[state.periodIndex];

  function scrollReportTo(target = null) {
    const scroller = elements.reportScroller;
    const top = target ? scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12 : 0;
    scroller.scrollTo({ top: Math.max(0, top), behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }

  function formatCommentDate(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("ru-RU");
  }

  function reportInitials(name) {
    return String(name || "КВ").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "КВ";
  }

  function findForbiddenPublicationKey(value, depth = 0) {
    if (depth > 80) throw new Error("Слишком глубокая вложенность файла");
    const forbidden = new Set(["clients", "clientrows", "patientregistry", "patientid", "patientname", "patientsforwork", "reactivationrows", "riskrows", "sourcefiles", "rawexports"]);
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findForbiddenPublicationKey(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (!value || typeof value !== "object") return null;
    for (const [key, nested] of Object.entries(value)) {
      if (forbidden.has(String(key).toLowerCase())) return key;
      const found = findForbiddenPublicationKey(nested, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function validateVisualData(sections, charts = []) {
    let nodeCount = 0;
    const visit = (nodes, columns, depth = 0) => {
      if (!Array.isArray(nodes) || depth > 32) throw new Error("Некорректная иерархия групп");
      for (const node of nodes) {
        if (++nodeCount > 10000 || !node || typeof node.label !== "string" || !Array.isArray(node.values)
          || node.values.length !== columns.length - 1 || node.values.some(value => typeof value !== "string")) throw new Error("Некорректные значения группы");
        if (node.children != null) visit(node.children, columns, depth + 1);
      }
    };
    for (const section of sections) {
      nodeCount = 0;
      if (section.tree != null) {
        if (!Array.isArray(section.columns) || section.columns.length < 2 || section.columns.length > 6) throw new Error("Некорректные столбцы групп");
        visit(section.tree, section.columns);
      }
    }
    for (const collection of [charts, ...sections.map(section => section.charts || [])]) {
      if (!Array.isArray(collection) || collection.length > 12) throw new Error("Некорректные графики");
      for (const chart of collection) {
        if (!chart || !["donut", "bar", "line", "mirror"].includes(chart.type) || !Array.isArray(chart.labels)
          || !chart.labels.length || chart.labels.length > 500 || !Array.isArray(chart.series) || !chart.series.length || chart.series.length > 30) throw new Error("Некорректный график");
        if (["donut", "bar"].includes(chart.type) && chart.series.length !== 1) throw new Error("Некорректное число рядов");
        for (const series of chart.series) {
          if (!Array.isArray(series.values) || series.values.length !== chart.labels.length
            || series.values.some(value => value !== null && (!Number.isFinite(value) || Math.abs(value) > 1e15))) throw new Error("Некорректные числа графика");
          if (chart.type === "donut" && series.values.some(value => value < 0)) throw new Error("Отрицательный сектор диаграммы");
          if (chart.type === "mirror" && !["own", "ref"].includes(series.side)) throw new Error("Некорректная сторона выручки");
        }
      }
    }
  }

  function validatePublication(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Файл не является мобильной публикацией КлинВект");
    if (value.format !== "klinvekt-mobile-publication" || value.version !== 1) throw new Error("Версия мобильного файла не поддерживается");
    if (!value.security || value.security.patientRegistryIncluded !== false || value.security.rawExportsIncluded !== false) {
      throw new Error("Файл не подтверждает отсутствие списка пациентов и исходных выгрузок");
    }
    const forbiddenKey = findForbiddenPublicationKey(value);
    if (forbiddenKey) throw new Error(`В файле найдено запрещённое поле: ${forbiddenKey}`);
    if (!value.doctor || typeof value.doctor.name !== "string" || typeof value.doctor.department !== "string") throw new Error("В файле нет профиля врача");
    if (!Array.isArray(value.periods) || !value.periods.length || value.periods.length > 24) throw new Error("В файле нет периодов отчёта");
    for (const period of value.periods) {
      if (!period || !Array.isArray(period.headlineMetrics) || period.headlineMetrics.length !== 5) throw new Error("Неполный набор ключевых показателей");
      if (!Array.isArray(period.vectors) || period.vectors.map((vector) => vector && vector.id).join(",") !== "v1,v2,v3,v4,v5,v6") {
        throw new Error("Неполный набор векторов В1–В6");
      }
      for (const vector of period.vectors) {
        const collections = Array.isArray(vector.windows) ? vector.windows.map((item) => item.sections) : [vector.sections];
        if (collections.some((sections) => !Array.isArray(sections) || !sections.length)) throw new Error(`Нет расшифровки ${vector.id}`);
        collections.forEach(sections => validateVisualData(sections));
      }
      if (!Array.isArray(period.goals) || period.goals.length > 20) throw new Error("Некорректный набор целей");
      if (period.comments != null && (!Array.isArray(period.comments) || period.comments.length > 50)) throw new Error("Некорректный набор комментариев");
      if (period.dynamics != null) {
        if (!period.dynamics || !Array.isArray(period.dynamics.columns) || !Array.isArray(period.dynamics.rows)) {
          throw new Error("Некорректная динамика отчёта");
        }
        if (period.dynamics.columns.length > 6 || period.dynamics.rows.length > 30) throw new Error("Слишком большой блок динамики");
        validateVisualData([], period.dynamics.charts || []);
      }
    }
    return value;
  }

  function resetReportState() {
    state.periodIndex = 0;
    state.vectorId = "v1";
    state.windowSelections = {};
    state.tab = "overview";
  }

  function usePublication(publication) {
    reportData = validatePublication(publication);
    resetReportState();
  }

  function useServerReport(result) {
    usePublication(result.publication);
    state.reportAccess = result.access || null;
  }

  function renderReportAccess() {
    const access = state.reportAccess;
    const isHead = Boolean(state.serverMode && access?.managedDepartments?.length);
    elements.teamReports.classList.toggle("hidden", !isHead);
    elements.reportOwnerLabel.textContent = access && access.selectedDoctorId !== access.owner.doctorId ? "Отчёт врача" : "Мой отчёт";
    if (!isHead) return;
    elements.teamReportsContext.textContent = `Вход: ${access.owner.displayName}. Доступны только отчёты ваших отделений.`;
    const own = access.reports.find(report => report.doctorId === access.owner.doctorId);
    const option = report => `<option value="${escapeHtml(report.doctorId)}">${escapeHtml(report.displayName)}</option>`;
    const groups = new Map();
    access.reports.filter(report => report.doctorId !== access.owner.doctorId).forEach(report => {
      if (!groups.has(report.department)) groups.set(report.department, []);
      groups.get(report.department).push(report);
    });
    elements.teamDoctorSelect.innerHTML = (own ? `<optgroup label="Мой отчёт">${option(own)}</optgroup>` : "")
      + [...groups].map(([department, reports]) => `<optgroup label="${escapeHtml(department)}">${reports.map(option).join("")}</optgroup>`).join("");
    elements.teamDoctorSelect.value = access.selectedDoctorId;
    elements.ownReportButton.classList.toggle("hidden", !own);
    elements.ownReportButton.disabled = !own || access.selectedDoctorId === access.owner.doctorId;
  }

  async function selectTeamReport(doctorId) {
    const access = state.reportAccess;
    if (!access || !access.reports.some(report => report.doctorId === doctorId)) return;
    const requestId = ++state.reportRequestId;
    const periodId = currentPeriod()?.id;
    elements.teamDoctorSelect.disabled = true;
    elements.ownReportButton.disabled = true;
    elements.teamReportStatus.classList.remove("error");
    elements.teamReportStatus.textContent = "Открываем отчёт…";
    try {
      const result = await apiRequest(`/api/report?doctorId=${encodeURIComponent(doctorId)}`);
      if (requestId !== state.reportRequestId) return;
      useServerReport(result);
      const index = reportData.periods.findIndex(period => period.id === periodId);
      if (index >= 0) state.periodIndex = index;
      elements.teamReportStatus.textContent = "";
      showReport();
    } catch (error) {
      if (requestId !== state.reportRequestId) return;
      if (error.status === 401) {
        showLogin();
        elements.serverLoginStatus.textContent = "Сессия завершена. Войдите по PIN заново";
      } else {
        elements.teamReportStatus.textContent = error.message || "Не удалось открыть отчёт";
        elements.teamReportStatus.classList.add("error");
        renderReportAccess();
      }
    } finally {
      if (requestId === state.reportRequestId) {
        elements.teamDoctorSelect.disabled = false;
        renderReportAccess();
      }
    }
  }

  function applyReportIdentity() {
    elements.loginDoctorName.textContent = reportData.doctor.name;
    elements.loginDoctorDepartment.textContent = reportData.doctor.department;
    elements.loginAvatar.textContent = reportInitials(reportData.doctor.name);
    elements.profileBadge.textContent = reportData.demo ? "Демо" : "Из Admin";
    elements.openReportLabel.textContent = "Открыть отчёт";
  }

  async function loadPublicationFile(file) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) throw new Error("Мобильный файл превышает 10 МБ");
    const parsed = JSON.parse(await file.text());
    usePublication(parsed);
    sessionStorage.removeItem("klinvekt-mobile-pilot-open");
    applyReportIdentity();
    elements.publicationStatus.textContent = `Загружено: ${reportData.doctor.name} · ${reportData.periods.length} периодов`;
    elements.publicationStatus.classList.remove("error");
    showReport();
  }

  function showReport() {
    elements.loginView.classList.add("hidden");
    elements.reportView.classList.remove("hidden");
    elements.bottomNav.classList.remove("hidden");
    elements.logoutButton.classList.remove("hidden");
    elements.doctorName.textContent = reportData.doctor.name;
    elements.doctorDepartment.textContent = reportData.doctor.department;
    renderReportAccess();
    if (!state.serverMode && reportData.demo) sessionStorage.setItem("klinvekt-mobile-pilot-open", "1");
    else sessionStorage.removeItem("klinvekt-mobile-pilot-open");
    render();
    scrollReportTo();
  }

  function showLogin() {
    state.reportRequestId += 1;
    state.reportAccess = null;
    elements.teamReports.classList.add("hidden");
    elements.teamDoctorSelect.innerHTML = "";
    elements.teamDoctorSelect.disabled = false;
    elements.teamReportStatus.textContent = "";
    // Clear a server report from hidden DOM as well as memory; keep local imports reusable.
    if (state.serverMode) {
      reportData = bundledDemo;
      resetReportState();
      elements.doctorName.textContent = reportData.doctor.name;
      elements.doctorDepartment.textContent = reportData.doctor.department;
      elements.reportOwnerLabel.textContent = "Мой отчёт";
      render();
    }
    elements.loginView.classList.remove("hidden");
    elements.reportView.classList.add("hidden");
    elements.bottomNav.classList.add("hidden");
    elements.logoutButton.classList.add("hidden");
    sessionStorage.removeItem("klinvekt-mobile-pilot-open");
    if (state.serverMode) {
      elements.serverPin.value = "";
      elements.serverLoginStatus.textContent = "";
    }
    scrollReportTo();
  }

  function renderPeriodOptions() {
    elements.periodSelect.innerHTML = reportData.periods
      .map((period, index) => `<option value="${index}"${index === state.periodIndex ? " selected" : ""}>${escapeHtml(period.label)}</option>`)
      .join("");
    elements.previousPeriod.disabled = state.periodIndex >= reportData.periods.length - 1;
    elements.nextPeriod.disabled = state.periodIndex <= 0;
  }

  function renderSummary(period) {
    const score = Number.isFinite(period.overall) ? period.overall : 0;
    elements.overallScore.textContent = Number.isFinite(period.overall) ? String(period.overall) : "—";
    elements.scoreRing.style.setProperty("--score", `${score}%`);
    elements.scoreAssessment.textContent = period.assessment;
    elements.scoreSummary.textContent = period.summary;
    elements.scoreDelta.textContent = Number.isFinite(period.overallDelta) ? `${signed(period.overallDelta)} к прошлому периоду` : "Нет предыдущего периода";
    elements.scoreDelta.classList.toggle("negative", period.overallDelta < 0);
  }

  function renderHeadlineMetrics(period) {
    elements.headlineMetrics.innerHTML = period.headlineMetrics.map((metric) => `
      <article class="headline-card">
        <span>${escapeHtml(metric.label)}</span>
        <b>${escapeHtml(metric.value)}</b>
        <small>${escapeHtml(metric.note)}</small>
        <em class="${String(metric.delta).startsWith("-") ? "negative" : String(metric.delta) === "—" ? "neutral" : "positive"}">${escapeHtml(metric.delta)}</em>
      </article>`).join("");
  }

  function legacyRevenueTree(section) {
    // Старый формат хранил подкатегории рядом с итогами. Восстанавливаем только известные маркеры, не пересчитывая суммы.
    if (section.title !== "Распределение выручки" || !section.rows?.some(row => String(row[0]).endsWith(" · итого"))) return [];
    const roots = [];
    for (const row of section.rows) {
      const label = String(row[0]);
      if (label.startsWith("↳") && roots.length) roots.at(-1).children.push({ label: label.slice(1).trim(), values: row.slice(1) });
      else roots.push({ label: label.replace(/ · итого$/, ""), values: row.slice(1), children: [] });
    }
    return roots;
  }

  function renderTree(nodes, columns) {
    const visit = (items, depth = 0) => items.map(node => {
      const expandable = Boolean(node.children?.length);
      const row = `<span class="tree-label"><span class="tree-arrow" aria-hidden="true">${expandable ? "›" : "·"}</span>${escapeHtml(node.label)}</span>
        <span class="tree-values">${node.values.map((value, i) => `<span><small>${escapeHtml(columns[i + 1])}</small><b>${escapeHtml(value)}</b></span>`).join("")}</span>`;
      return expandable ? `<details class="tree-node"><summary class="tree-row">${row}</summary><div class="tree-children">${visit(node.children, depth + 1)}</div></details>`
        : `<div class="tree-row tree-leaf">${row}</div>`;
    }).join("");
    return `<div class="report-tree" data-values="${columns.length - 1}">
      <div class="tree-tools"><span>Нажмите на группу, чтобы раскрыть</span><button type="button" data-tree-action="open">Раскрыть всё</button><button type="button" data-tree-action="close">Свернуть всё</button></div>
      ${visit(nodes)}</div>`;
  }

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
    return charts.map(chart => `<article class="report-chart"><header><h5>${escapeHtml(chart.title)}</h5>${chart.type === "line" && chart.series.length > 1 ? `<label class="chart-picker">Показать<select data-chart-series><option value="all">Все показатели</option>${chart.series.map((series, i) => `<option value="${i}"${chart.id === "scores" && i === 0 ? " selected" : ""}>${escapeHtml(series.label)}</option>`).join("")}</select></label>` : ""}</header><div class="chart-plot">${chartPlot(chart, chart.id === "scores" ? "0" : "all")}</div>${chartTable(chart)}</article>`).join("");
  }

  function bindCharts(root, charts) {
    root.querySelectorAll(".report-chart").forEach((card, i) => {
      card.querySelector("[data-chart-series]")?.addEventListener("change", event => {
        card.querySelector(".chart-plot").innerHTML = chartPlot(charts[i], event.target.value);
      });
    });
  }

  function renderSection(section) {
    const metrics = Array.isArray(section.metrics) && section.metrics.length
      ? `<div class="metric-grid">${section.metrics.map((metric) => `
          <div class="metric-item ${escapeHtml(metric.state || "neutral")}">
            <span>${escapeHtml(metric.label)}</span>
            <b>${escapeHtml(metric.value)}</b>
            ${metric.note ? `<small>${escapeHtml(metric.note)}</small>` : ""}
            ${metric.target ? `<em>${escapeHtml(metric.target)}</em>` : ""}
          </div>`).join("")}</div>`
      : "";
    const tree = section.tree?.length ? section.tree : legacyRevenueTree(section);
    const rows = tree.length ? renderTree(tree, section.columns) : Array.isArray(section.rows) && section.rows.length
      ? `<div class="aggregate-table" role="table" aria-label="${escapeHtml(section.title)}">
          <div class="aggregate-head" role="row">${section.columns.map((column) => `<span role="columnheader">${escapeHtml(column)}</span>`).join("")}</div>
          ${section.rows.map((row) => `<div class="aggregate-row" role="row">${row.map((value, index) => `
            <span role="cell"><small>${escapeHtml(section.columns[index])}</small><b>${escapeHtml(value)}</b></span>`).join("")}</div>`).join("")}
        </div>`
      : "";
    return `<section class="metric-section">
      <h4>${escapeHtml(section.title)}</h4>
      ${section.note ? `<p>${escapeHtml(section.note)}</p>` : ""}
      ${metrics}${rows}${renderCharts(section.charts)}
    </section>`;
  }

  function renderVectorDetail(vector) {
    const windows = Array.isArray(vector.windows) ? vector.windows : [];
    let selectedWindowId = state.windowSelections[vector.id];
    if (windows.length && !windows.some((item) => item.id === selectedWindowId)) {
      selectedWindowId = windows[0].id;
      state.windowSelections[vector.id] = selectedWindowId;
    }
    const selectedWindow = windows.find((item) => item.id === selectedWindowId);
    const sections = selectedWindow ? selectedWindow.sections : vector.sections;
    const windowPicker = windows.length ? `
      <div class="window-picker" aria-label="${escapeHtml(vector.windowPickerLabel || "Окно анализа")}">
        ${windows.map((item) => `<button type="button" data-vector-window="${escapeHtml(item.id)}" class="${item.id === selectedWindowId ? "active" : ""}">${escapeHtml(item.label)}</button>`).join("")}
      </div>
      <p class="window-period">${escapeHtml(selectedWindow.period || "")}</p>` : "";
    const shownScore = Number.isFinite(vector.score) ? vector.score : "—";

    elements.vectorDetail.innerHTML = `
      <button class="vector-back" type="button" data-vector-back>↑ К векторам</button>
      <header><div><span class="eyebrow">Вектор ${vector.number}</span><h3>${escapeHtml(vector.title)}</h3></div><span class="vector-score">${shownScore}</span></header>
      <p class="vector-summary">${escapeHtml(vector.detail)}</p>
      ${windowPicker}
      <div class="metric-sections">${sections.map(renderSection).join("")}</div>`;

    elements.vectorDetail.querySelector("[data-vector-back]").addEventListener("click", () => {
      const card = elements.vectorGrid.querySelector('[aria-pressed="true"]');
      card?.focus({ preventScroll: true });
      scrollReportTo(elements.vectorGrid);
    });

    elements.vectorDetail.querySelectorAll("[data-tree-action]").forEach(button => {
      button.addEventListener("click", () => button.closest(".report-tree").querySelectorAll("details.tree-node").forEach(node => { node.open = button.dataset.treeAction === "open"; }));
    });
    bindCharts(elements.vectorDetail, sections.flatMap(section => section.charts || []));

    elements.vectorDetail.querySelectorAll("[data-vector-window]").forEach((button) => {
      button.addEventListener("click", () => {
        state.windowSelections[vector.id] = button.dataset.vectorWindow;
        renderVectorDetail(vector);
      });
    });
  }

  function renderVectors(period) {
    if (!period.vectors.some((vector) => vector.id === state.vectorId)) state.vectorId = period.vectors[0].id;
    elements.vectorGrid.innerHTML = period.vectors.map((vector) => {
      const score = Number.isFinite(vector.score) ? vector.score : 0;
      const shownScore = Number.isFinite(vector.score) ? vector.score : "—";
      return `
      <button class="vector-card${vector.id === state.vectorId ? " active" : ""}" type="button" data-vector="${escapeHtml(vector.id)}" aria-controls="vectorDetail" aria-pressed="${vector.id === state.vectorId}">
        <span class="vector-card-head"><span class="vector-number">Вектор ${vector.number}</span><span class="vector-score">${shownScore}</span></span>
        <h3>${escapeHtml(vector.title)}</h3>
        <span class="progress-track" aria-hidden="true"><span style="width:${Math.max(0, Math.min(100, score))}%"></span></span>
        <span class="vector-foot"><span>из 100</span><span class="delta ${vector.delta < 0 ? "negative" : "positive"}">${signed(vector.delta)}</span></span>
        <span class="vector-action"><span>${vector.id === state.vectorId ? "Показатели открыты" : "Открыть показатели"}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>
      </button>`;
    }).join("");

    elements.vectorGrid.querySelectorAll("[data-vector]").forEach((button) => {
      button.addEventListener("click", () => {
        state.vectorId = button.dataset.vector;
        renderVectors(currentPeriod());
        elements.vectorDetail.focus({ preventScroll: true });
        scrollReportTo(elements.vectorDetail);
      });
    });

    const vector = period.vectors.find((item) => item.id === state.vectorId) || period.vectors[0];
    renderVectorDetail(vector);
  }

  function renderTrend() {
    const chronological = reportData.periods.filter(period => period.id <= currentPeriod().id).sort((a, b) => a.id.localeCompare(b.id)).filter((period) => Number.isFinite(period.overall));
    if (!chronological.length) {
      elements.trendChart.innerHTML = "";
      elements.trendLabels.innerHTML = "";
      elements.trendValue.textContent = "—";
      elements.trendCaption.textContent = "баллы пока не рассчитаны";
    } else {
    const values = chronological.map((period) => period.overall);
    const width = 320;
    const height = 170;
    const padX = 24;
    const padY = 20;
    const min = Math.min(...values) - 4;
    const max = Math.max(...values) + 4;
    const point = (value, index) => {
      const x = padX + (index * (width - padX * 2)) / Math.max(1, values.length - 1);
      const y = height - padY - ((value - min) / Math.max(1, max - min)) * (height - padY * 2);
      return { x, y };
    };
    const points = values.map(point);
    const line = points.map((p) => `${p.x},${p.y}`).join(" ");
    const area = `${padX},${height - padY} ${line} ${width - padX},${height - padY}`;
    const gridLines = [0.25, 0.5, 0.75].map((ratio) => {
      const y = padY + ratio * (height - padY * 2);
      return `<line class="chart-grid" x1="${padX}" y1="${y}" x2="${width - padX}" y2="${y}"/>`;
    }).join("");
    elements.trendChart.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <defs><linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2563eb" stop-opacity=".24"/><stop offset="1" stop-color="#2563eb" stop-opacity="0"/></linearGradient></defs>
        ${gridLines}<polygon class="chart-area" points="${area}"/><polyline class="chart-line" points="${line}"/>
        ${points.map((p) => `<circle class="chart-dot" cx="${p.x}" cy="${p.y}" r="5"/>`).join("")}
      </svg>`;
    elements.trendLabels.innerHTML = chronological.map((period) => `<span>${escapeHtml(period.shortLabel)} · ${period.overall}</span>`).join("");
    elements.trendLabels.style.gridTemplateColumns = `repeat(${chronological.length}, minmax(0, 1fr))`;
    const change = values.at(-1) - values[0];
    elements.trendValue.textContent = signed(change);
    elements.trendCaption.textContent = `пунктов за ${chronological.length} период${chronological.length === 1 ? "" : chronological.length < 5 ? "а" : "ов"}`;
    }

    const period = currentPeriod();
    const dynamics = period.dynamics;
    const charts = dynamics?.charts || [];
    elements.desktopCharts.innerHTML = renderCharts(charts);
    bindCharts(elements.desktopCharts, charts);
    if (dynamics && Array.isArray(dynamics.rows) && dynamics.rows.length) {
      elements.comparisonList.innerHTML = `<h3>Детализация по месяцам</h3>
        <div class="viewer-dynamics-table"><table>
          <thead><tr><th>Метрика</th>${dynamics.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}<th>Δ к прошлому</th><th>Δ к среднему</th></tr></thead>
          <tbody>${dynamics.rows.map((row) => `<tr><td><b>${escapeHtml(row.label)}</b>${row.target ? `<small>Цель ${escapeHtml(row.target)}</small>` : ""}</td>${row.values.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}<td><span class="delta ${row.state === "bad" ? "negative" : row.state === "good" ? "positive" : "neutral"}">${escapeHtml(row.delta)}</span></td><td>${escapeHtml(row.averageDelta || "—")}</td></tr>`).join("")}</tbody>
        </table></div>`;
      const insightColumn = (title, items, className) => `<section class="insight-card ${className}"><h3>${title}</h3>${items.length ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "<p>Выраженных изменений нет.</p>"}</section>`;
      elements.dynamicsInsights.innerHTML = `<div class="insight-grid">${insightColumn("Точки роста", dynamics.growth || [], "good")}${insightColumn("Точки риска", dynamics.risk || [], "warn")}</div>
        ${dynamics.conclusion ? `<article class="conclusion-card"><span class="eyebrow">Выводы и комментарии${dynamics.conclusionManual ? " · сохранено вручную" : ""}</span><p>${escapeHtml(dynamics.conclusion)}</p></article>` : ""}`;
    } else {
      const headlineRows = period.headlineMetrics.map((metric) => `
        <div class="comparison-row"><div><b>${escapeHtml(metric.label)}</b><span>${escapeHtml(metric.value)} · ${escapeHtml(metric.note)}</span></div><span class="delta ${String(metric.delta).startsWith("-") ? "negative" : "positive"}">${escapeHtml(metric.delta)}</span></div>`).join("");
      const vectorRows = period.vectors.map((vector) => `
        <div class="comparison-row"><div><b>${escapeHtml(vector.title)}</b><span>Вектор ${vector.number} · ${Number.isFinite(vector.score) ? vector.score : "—"} из 100</span></div><span class="delta ${vector.delta < 0 ? "negative" : "positive"}">${signed(vector.delta)}</span></div>`).join("");
      elements.comparisonList.innerHTML = `<h3>Ключевые показатели</h3>${headlineRows}<h3>Баллы векторов</h3>${vectorRows}`;
      elements.dynamicsInsights.innerHTML = "";
    }
  }

  function renderGoals(period) {
    elements.goalsSource.textContent = period.goalsSource || "Цели из Viewer";
    elements.goalsList.innerHTML = period.goals.length ? period.goals.map((goal) => `
      <article class="goal-card ${escapeHtml(goal.state || "neutral")}">
        <div class="goal-heading"><h3>${goal.vector ? `<small>В${escapeHtml(String(goal.vector).replace("v", ""))}</small>` : ""}${escapeHtml(goal.title)}</h3><span>${escapeHtml(goal.fact || `${goal.progress}%`)}</span></div>
        <p>${goal.target ? `Цель: <b>${escapeHtml(goal.target)}</b>` : escapeHtml(goal.description)}</p>
        <div class="progress-track" aria-label="Выполнение ${goal.progress}%"><span style="width:${Math.max(0, Math.min(100, goal.progress))}%"></span></div>
      </article>`).join("") : '<article class="goal-card"><p>Цели появятся после расчёта баллов.</p></article>';
    const comments = Array.isArray(period.comments) && period.comments.length
      ? period.comments
      : period.comment ? [{ title: "Комментарий", text: period.comment, author: "Администратор", updatedAt: period.updatedAt }] : [];
    elements.commentsList.innerHTML = comments.length ? comments.map((comment) => `
      <article class="comment-card">
        <div class="comment-heading"><span class="avatar small" aria-hidden="true">К</span><span><b>${escapeHtml(comment.title || "Комментарий")}</b><small>${escapeHtml([comment.author, comment.updatedAt ? `обновлено ${formatCommentDate(comment.updatedAt)}` : ""].filter(Boolean).join(" · "))}</small></span></div>
        <blockquote>${escapeHtml(comment.text)}</blockquote>
      </article>`).join("") : '<article class="comment-card empty-comment"><p>Комментариев к этому периоду нет.</p></article>';
  }

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll("[data-panel]").forEach((panel) => panel.classList.toggle("hidden", panel.dataset.panel !== tab));
    document.querySelectorAll(".tab-button[data-tab]").forEach((button) => {
      const active = button.dataset.tab === tab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    elements.bottomNav.querySelectorAll("[data-tab]").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  }

  function render() {
    const period = currentPeriod();
    renderPeriodOptions();
    renderSummary(period);
    renderHeadlineMetrics(period);
    renderVectors(period);
    renderTrend();
    renderGoals(period);
    setTab(state.tab);
  }

  function updateConnectionStatus() {
    const online = navigator.onLine;
    elements.connectionStatus.classList.toggle("offline", !online);
    elements.connectionStatus.lastChild.textContent = online ? "В сети" : "Офлайн";
  }

  function showInstallHelp() {
    if (elements.installDialog.open) return;
    if (typeof elements.installDialog.showModal === "function") elements.installDialog.showModal();
  }

  function closeInstallHelp() {
    if (elements.installDialog.open) elements.installDialog.close();
    elements.installButton.focus({ preventScroll: true });
  }

  async function apiRequest(path, options = {}) {
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...options });
    const contentType = String(response.headers.get("content-type") || "");
    const payload = contentType.includes("application/json") ? await response.json() : null;
    if (!response.ok) {
      const error = new Error(payload && payload.error || "Сервер временно недоступен");
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function renderServerContext(context) {
    state.serverContext = context;
    state.serverMode = true;
    sessionStorage.setItem("klinvekt-mobile-server-mode", "1");
    elements.loadPublicationButton.closest(".publication-shortcut").classList.add("hidden");
    elements.staticProfile.classList.add("hidden");
    elements.openDemoButton.classList.add("hidden");
    elements.serverLoginForm.classList.remove("hidden");
    elements.serverLoginForm.classList.remove("server-locked");
    elements.serverPublicationShortcut.classList.toggle("hidden", !context.canUpload);
    elements.bitrixAccount.textContent = context.user && context.user.name ? `Битрикс24: ${context.user.name}` : "Вход выполнен через Битрикс24";
    elements.serverDoctorSelect.innerHTML = context.doctors.length
      ? context.doctors.map(doctor => `<option value="${escapeHtml(doctor.doctorId)}">${escapeHtml(doctor.displayName)}${doctor.department ? ` — ${escapeHtml(doctor.department)}` : ""}</option>`).join("")
      : '<option value="">Отчёты ещё не загружены</option>';
    elements.serverDoctorSelect.disabled = !context.doctors.length;
    elements.serverPin.disabled = !context.doctors.length;
    elements.serverLoginButton.disabled = !context.doctors.length;
    elements.serverLoginStatus.textContent = context.doctors.length ? "" : "Администратор должен загрузить общий файл из Admin";
  }

  async function refreshServerContext({ restoreSession = false } = {}) {
    const context = await apiRequest("/api/context");
    renderServerContext(context);
    if (restoreSession && context.sessionActive) {
      try {
        const result = await apiRequest("/api/report");
        useServerReport(result);
        showReport();
      } catch (_) {
        showLogin();
      }
    }
    return context;
  }

  async function detectServerMode() {
    try {
      const response = await fetch("/api/context", { credentials: "same-origin", cache: "no-store" });
      const contentType = String(response.headers.get("content-type") || "");
      if (response.status === 404 || !contentType.includes("application/json")) return false;
      const payload = await response.json();
      if (!response.ok) {
        state.serverMode = true;
        sessionStorage.setItem("klinvekt-mobile-server-mode", "1");
        elements.loadPublicationButton.closest(".publication-shortcut").classList.add("hidden");
        elements.staticProfile.classList.add("hidden");
        elements.openDemoButton.classList.add("hidden");
        elements.serverLoginForm.classList.remove("hidden");
        elements.serverLoginForm.classList.add("server-locked");
        elements.bitrixAccount.textContent = payload.error || "Откройте приложение через Битрикс24";
        return true;
      }
      renderServerContext(payload);
      if (payload.sessionActive) {
        try {
          const result = await apiRequest("/api/report");
          useServerReport(result);
          showReport();
        } catch (_) {
          showLogin();
        }
      }
      return true;
    } catch (_) {
      if (sessionStorage.getItem("klinvekt-mobile-server-mode") === "1") {
        state.serverMode = true;
        elements.loadPublicationButton.closest(".publication-shortcut").classList.add("hidden");
        elements.staticProfile.classList.add("hidden");
        elements.openDemoButton.classList.add("hidden");
        elements.serverLoginForm.classList.remove("hidden");
        elements.serverLoginForm.classList.add("server-locked");
        elements.bitrixAccount.textContent = "Нет соединения с сервером КлинВект";
        return true;
      }
      return false;
    }
  }

  async function loginToServer(event) {
    event.preventDefault();
    elements.serverLoginButton.disabled = true;
    elements.serverLoginStatus.textContent = "Проверяем PIN…";
    elements.serverLoginStatus.classList.remove("error");
    try {
      const result = await apiRequest("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doctorId: elements.serverDoctorSelect.value, pin: elements.serverPin.value }),
      });
      useServerReport(result);
      elements.serverPin.value = "";
      showReport();
    } catch (error) {
      elements.serverLoginStatus.textContent = error.message || "Не удалось войти";
      elements.serverLoginStatus.classList.add("error");
      elements.serverPin.select();
    } finally {
      elements.serverLoginButton.disabled = !elements.serverDoctorSelect.value;
    }
  }

  async function uploadBundle(file) {
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) throw new Error("Общий файл превышает 100 МБ");
    if (!window.crypto || !window.crypto.subtle) throw new Error("Браузер не поддерживает безопасную проверку файла");
    elements.serverPublicationStatus.textContent = "Проверяем файл…";
    const digest = await window.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const upload = await apiRequest("/api/admin/publications/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bytes: file.size, sha256 }),
    });
    let completed = false;
    try {
      for (let index = 0; index < upload.chunks; index += 1) {
        elements.serverPublicationStatus.textContent = `Загружаем: ${index + 1} из ${upload.chunks}`;
        const start = index * upload.chunkBytes;
        await apiRequest(`/api/admin/publications/uploads/${upload.uploadId}/chunks/${index}`, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: file.slice(start, Math.min(file.size, start + upload.chunkBytes)),
        });
      }
      elements.serverPublicationStatus.textContent = "Проверяем и применяем…";
      const result = await apiRequest(`/api/admin/publications/uploads/${upload.uploadId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      completed = true;
      elements.serverPublicationStatus.textContent = `Обновлено: ${result.doctors} врачей`;
      elements.serverPublicationStatus.classList.remove("error");
    } finally {
      if (!completed) {
        try {
          await apiRequest(`/api/admin/publications/uploads/${upload.uploadId}`, { method: "DELETE" });
        } catch (_) { /* временная загрузка сама удалится по таймауту */ }
      }
    }
    await refreshServerContext();
  }

  elements.openDemoButton.addEventListener("click", showReport);
  elements.loadPublicationButton.addEventListener("click", () => elements.publicationInput.click());
  elements.publicationInput.addEventListener("change", async () => {
    const file = elements.publicationInput.files && elements.publicationInput.files[0];
    elements.publicationInput.value = "";
    try {
      elements.publicationStatus.textContent = "Проверяем файл…";
      elements.publicationStatus.classList.remove("error");
      await loadPublicationFile(file);
    } catch (error) {
      elements.publicationStatus.textContent = error instanceof SyntaxError ? "Файл повреждён или не является JSON" : (error.message || "Не удалось загрузить мобильный файл");
      elements.publicationStatus.classList.add("error");
    }
  });
  elements.serverLoginForm.addEventListener("submit", loginToServer);
  elements.teamDoctorSelect.addEventListener("change", () => selectTeamReport(elements.teamDoctorSelect.value));
  elements.ownReportButton.addEventListener("click", () => selectTeamReport(state.reportAccess?.owner.doctorId));
  elements.loadBundleButton.addEventListener("click", () => elements.bundleInput.click());
  elements.bundleInput.addEventListener("change", async () => {
    const file = elements.bundleInput.files && elements.bundleInput.files[0];
    elements.bundleInput.value = "";
    try {
      elements.serverPublicationStatus.textContent = "Загружаем…";
      elements.serverPublicationStatus.classList.remove("error");
      await uploadBundle(file);
    } catch (error) {
      elements.serverPublicationStatus.textContent = error.message || "Не удалось обновить отчёты";
      elements.serverPublicationStatus.classList.add("error");
    }
  });
  elements.logoutButton.addEventListener("click", async () => {
    state.reportRequestId += 1;
    if (state.serverMode) {
      try {
        await apiRequest("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      } catch (_) { /* локальный выход всё равно должен сработать */ }
    }
    showLogin();
  });
  elements.periodSelect.addEventListener("change", () => { state.periodIndex = Number(elements.periodSelect.value); state.vectorId = "v1"; state.windowSelections = {}; render(); });
  elements.previousPeriod.addEventListener("click", () => { if (state.periodIndex < reportData.periods.length - 1) { state.periodIndex += 1; state.vectorId = "v1"; state.windowSelections = {}; render(); } });
  elements.nextPeriod.addEventListener("click", () => { if (state.periodIndex > 0) { state.periodIndex -= 1; state.vectorId = "v1"; state.windowSelections = {}; render(); } });
  document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => {
    setTab(button.dataset.tab);
    scrollReportTo(document.querySelector(".tab-list"));
  }));
  elements.installDialog.querySelectorAll("[data-close-install]").forEach(button => button.addEventListener("click", closeInstallHelp));
  elements.installDialog.addEventListener("cancel", event => { event.preventDefault(); closeInstallHelp(); });
  elements.installDialog.addEventListener("click", event => {
    if (event.target !== elements.installDialog) return;
    const box = elements.installDialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeInstallHelp();
  });
  window.addEventListener("online", updateConnectionStatus);
  window.addEventListener("offline", updateConnectionStatus);
  window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); state.installPrompt = event; });
  window.addEventListener("appinstalled", () => { elements.installCard.classList.add("hidden"); state.installPrompt = null; });
  elements.installButton.addEventListener("click", async () => {
    if (!state.installPrompt) { showInstallHelp(); return; }
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null;
  });

  if (window.matchMedia("(display-mode: standalone)").matches) elements.installCard.classList.add("hidden");
  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js").catch(() => {}));
  updateConnectionStatus();
  applyReportIdentity();
  render();
  detectServerMode().then((serverMode) => {
    if (!serverMode && sessionStorage.getItem("klinvekt-mobile-pilot-open") === "1") showReport();
  });
})();
