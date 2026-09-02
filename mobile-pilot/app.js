(() => {
  "use strict";

  const bundledDemo = window.KLINVEKT_MOBILE_DEMO;
  if (!bundledDemo || bundledDemo.demo !== true || !Array.isArray(bundledDemo.periods)) {
    document.body.textContent = "Не удалось загрузить безопасные тестовые данные.";
    return;
  }
  let reportData = bundledDemo;

  const elements = {
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
  };

  const escapeHtml = (value) => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  const signed = (value) => Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value}` : "—";
  const currentPeriod = () => reportData.periods[state.periodIndex];

  function formatCommentDate(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("ru-RU");
  }

  function reportInitials(name) {
    return String(name || "КВ").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "КВ";
  }

  function findForbiddenPublicationKey(value) {
    const forbidden = new Set(["clients", "clientrows", "patientregistry", "patientid", "patientname", "patientsforwork", "reactivationrows", "riskrows", "sourcefiles", "rawexports"]);
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findForbiddenPublicationKey(item);
        if (found) return found;
      }
      return null;
    }
    if (!value || typeof value !== "object") return null;
    for (const [key, nested] of Object.entries(value)) {
      if (forbidden.has(String(key).toLowerCase())) return key;
      const found = findForbiddenPublicationKey(nested);
      if (found) return found;
    }
    return null;
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
      }
      if (!Array.isArray(period.goals) || period.goals.length > 20) throw new Error("Некорректный набор целей");
      if (period.comments != null && (!Array.isArray(period.comments) || period.comments.length > 50)) throw new Error("Некорректный набор комментариев");
      if (period.dynamics != null) {
        if (!period.dynamics || !Array.isArray(period.dynamics.columns) || !Array.isArray(period.dynamics.rows)) {
          throw new Error("Некорректная динамика отчёта");
        }
        if (period.dynamics.columns.length > 6 || period.dynamics.rows.length > 30) throw new Error("Слишком большой блок динамики");
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
    if (!state.serverMode && reportData.demo) sessionStorage.setItem("klinvekt-mobile-pilot-open", "1");
    else sessionStorage.removeItem("klinvekt-mobile-pilot-open");
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showLogin() {
    elements.loginView.classList.remove("hidden");
    elements.reportView.classList.add("hidden");
    elements.bottomNav.classList.add("hidden");
    elements.logoutButton.classList.add("hidden");
    sessionStorage.removeItem("klinvekt-mobile-pilot-open");
    if (state.serverMode) {
      elements.serverPin.value = "";
      elements.serverLoginStatus.textContent = "";
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
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
    const rows = Array.isArray(section.rows) && section.rows.length
      ? `<div class="aggregate-table" role="table" aria-label="${escapeHtml(section.title)}">
          <div class="aggregate-head" role="row">${section.columns.map((column) => `<span role="columnheader">${escapeHtml(column)}</span>`).join("")}</div>
          ${section.rows.map((row) => `<div class="aggregate-row" role="row">${row.map((value, index) => `
            <span role="cell"><small>${escapeHtml(section.columns[index])}</small><b>${escapeHtml(value)}</b></span>`).join("")}</div>`).join("")}
        </div>`
      : "";
    return `<section class="metric-section">
      <h4>${escapeHtml(section.title)}</h4>
      ${section.note ? `<p>${escapeHtml(section.note)}</p>` : ""}
      ${metrics}${rows}
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
      <header><div><span class="eyebrow">Вектор ${vector.number}</span><h3>${escapeHtml(vector.title)}</h3></div><span class="vector-score">${shownScore}</span></header>
      <p class="vector-summary">${escapeHtml(vector.detail)}</p>
      ${windowPicker}
      <div class="metric-sections">${sections.map(renderSection).join("")}</div>`;

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
      <button class="vector-card${vector.id === state.vectorId ? " active" : ""}" type="button" data-vector="${escapeHtml(vector.id)}" aria-pressed="${vector.id === state.vectorId}">
        <span class="vector-card-head"><span class="vector-number">Вектор ${vector.number}</span><span class="vector-score">${shownScore}</span></span>
        <h3>${escapeHtml(vector.title)}</h3>
        <span class="progress-track" aria-hidden="true"><span style="width:${Math.max(0, Math.min(100, score))}%"></span></span>
        <span class="vector-foot"><span>из 100</span><span class="delta ${vector.delta < 0 ? "negative" : "positive"}">${signed(vector.delta)}</span></span>
      </button>`;
    }).join("");

    elements.vectorGrid.querySelectorAll("[data-vector]").forEach((button) => {
      button.addEventListener("click", () => {
        state.vectorId = button.dataset.vector;
        renderVectors(currentPeriod());
        elements.vectorDetail.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });

    const vector = period.vectors.find((item) => item.id === state.vectorId) || period.vectors[0];
    renderVectorDetail(vector);
  }

  function renderTrend() {
    const chronological = [...reportData.periods].reverse().filter((period) => Number.isFinite(period.overall));
    if (!chronological.length) {
      elements.trendChart.innerHTML = "";
      elements.trendLabels.innerHTML = "";
      elements.trendValue.textContent = "—";
      elements.trendCaption.textContent = "баллы пока не рассчитаны";
      return;
    }
    const values = chronological.map((period) => period.overall);
    const width = 600;
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
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
        <defs><linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2563eb" stop-opacity=".24"/><stop offset="1" stop-color="#2563eb" stop-opacity="0"/></linearGradient></defs>
        ${gridLines}<polygon class="chart-area" points="${area}"/><polyline class="chart-line" points="${line}"/>
        ${points.map((p) => `<circle class="chart-dot" cx="${p.x}" cy="${p.y}" r="5"/>`).join("")}
      </svg>`;
    elements.trendLabels.innerHTML = chronological.map((period) => `<span>${escapeHtml(period.shortLabel)} · ${period.overall}</span>`).join("");
    elements.trendLabels.style.gridTemplateColumns = `repeat(${chronological.length}, minmax(0, 1fr))`;
    const change = values.at(-1) - values[0];
    elements.trendValue.textContent = signed(change);
    elements.trendCaption.textContent = `пунктов за ${chronological.length} период${chronological.length === 1 ? "" : chronological.length < 5 ? "а" : "ов"}`;

    const period = currentPeriod();
    const dynamics = period.dynamics;
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
    if (typeof elements.installDialog.showModal === "function") elements.installDialog.showModal();
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
        usePublication(result.publication);
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
          usePublication(result.publication);
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
      usePublication(result.publication);
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
  document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.tab)));
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
