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
    goalsList: document.getElementById("goalsList"),
    managerComment: document.getElementById("managerComment"),
    commentDate: document.getElementById("commentDate"),
    connectionStatus: document.getElementById("connectionStatus"),
    installButton: document.getElementById("installButton"),
    installCard: document.getElementById("installCard"),
    installDialog: document.getElementById("installDialog"),
  };

  const state = { periodIndex: 0, vectorId: "v1", windowSelections: {}, tab: "overview", installPrompt: null };

  const escapeHtml = (value) => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  const signed = (value) => Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value}` : "—";
  const currentPeriod = () => reportData.periods[state.periodIndex];

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
    }
    return value;
  }

  function applyReportIdentity() {
    elements.loginDoctorName.textContent = reportData.doctor.name;
    elements.loginDoctorDepartment.textContent = reportData.doctor.department;
    elements.loginAvatar.textContent = reportInitials(reportData.doctor.name);
    elements.profileBadge.textContent = reportData.demo ? "Демо" : "Из Admin";
    elements.openReportLabel.textContent = reportData.demo ? "Открыть тестовый отчёт" : "Открыть загруженный отчёт";
  }

  async function loadPublicationFile(file) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) throw new Error("Мобильный файл превышает 10 МБ");
    const parsed = JSON.parse(await file.text());
    reportData = validatePublication(parsed);
    state.periodIndex = 0;
    state.vectorId = "v1";
    state.windowSelections = {};
    state.tab = "overview";
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
    if (reportData.demo) sessionStorage.setItem("klinvekt-mobile-pilot-open", "1");
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
    const headlineRows = period.headlineMetrics.map((metric) => `
      <div class="comparison-row"><div><b>${escapeHtml(metric.label)}</b><span>${escapeHtml(metric.value)} · ${escapeHtml(metric.note)}</span></div><span class="delta ${String(metric.delta).startsWith("-") ? "negative" : "positive"}">${escapeHtml(metric.delta)}</span></div>`).join("");
    const vectorRows = period.vectors.map((vector) => `
      <div class="comparison-row"><div><b>${escapeHtml(vector.title)}</b><span>Вектор ${vector.number} · ${Number.isFinite(vector.score) ? vector.score : "—"} из 100</span></div><span class="delta ${vector.delta < 0 ? "negative" : "positive"}">${signed(vector.delta)}</span></div>`).join("");
    elements.comparisonList.innerHTML = `<h3>Ключевые показатели</h3>${headlineRows}<h3>Баллы векторов</h3>${vectorRows}`;
  }

  function renderGoals(period) {
    elements.goalsList.innerHTML = period.goals.length ? period.goals.map((goal) => `
      <article class="goal-card">
        <div class="goal-heading"><h3>${escapeHtml(goal.title)}</h3><span>${goal.progress}%</span></div>
        <p>${escapeHtml(goal.description)}</p>
        <div class="progress-track" aria-label="Выполнение ${goal.progress}%"><span style="width:${Math.max(0, Math.min(100, goal.progress))}%"></span></div>
      </article>`).join("") : '<article class="goal-card"><p>Цели появятся после расчёта баллов.</p></article>';
    elements.managerComment.textContent = period.comment;
    elements.commentDate.textContent = `Обновлено ${period.updatedAt}`;
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
  elements.logoutButton.addEventListener("click", showLogin);
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
  if (sessionStorage.getItem("klinvekt-mobile-pilot-open") === "1") showReport();
})();
