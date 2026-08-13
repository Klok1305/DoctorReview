"use strict";

const API = window.viewerAPI;
const state = {
  status: null,
  adminAuthenticated: false,
  packagePreview: null,
  doctor: null,
  subjects: [],
  subjectDoctorId: null,
  periods: [],
  periodKey: null,
  pageType: "doctor",
  reportKey: "",
};

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function monthLabel(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value || ""));
  if (!match) return value;
  return new Date(Number(match[1]), Number(match[2]) - 1, 1).toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
}

function sortDoctorsAlphabetically(doctors) {
  return [...(doctors || [])].sort((first, second) =>
    String(first && first.displayName || "").localeCompare(String(second && second.displayName || ""), "ru", { sensitivity: "base" })
    || String(first && first.doctorId || "").localeCompare(String(second && second.doctorId || ""), "ru"));
}

function reportScopeKey(pageType, department = "", specialization = "", doctorId = "") {
  return [pageType, department, specialization, doctorId].map(value => encodeURIComponent(String(value || ""))).join("|");
}

function isDepartmentHead() {
  return Boolean(state.doctor && ((Array.isArray(state.doctor.managedDepartments) && state.doctor.managedDepartments.length)
    || state.subjects.length > 1));
}

function managedSubjects() {
  const departments = new Set((state.doctor && Array.isArray(state.doctor.managedDepartments)
    ? state.doctor.managedDepartments : []).map(String).filter(Boolean));
  return departments.size
    ? state.subjects.filter(subject => departments.has(String(subject.department || "")))
    : state.subjects;
}

function subjectPeriod(subject, periodKey) {
  return subject && Array.isArray(subject.periods)
    ? subject.periods.find(item => item.periodKey === String(periodKey)) || null
    : null;
}

function subjectHasPage(subject, periodKey, pageType) {
  const period = subjectPeriod(subject, periodKey);
  return Boolean(period && Array.isArray(period.pageTypes) && period.pageTypes.includes(pageType));
}

function availablePeriods() {
  const selected = state.subjects.find(subject => String(subject.doctorId) === String(state.subjectDoctorId));
  const sources = isDepartmentHead() ? managedSubjects() : (selected ? [selected] : []);
  const periods = new Map();
  for (const subject of sources) {
    for (const period of subject.periods || []) {
      const item = periods.get(period.periodKey) || { periodKey: period.periodKey, pageTypes: [] };
      for (const pageType of period.pageTypes || []) {
        if (!item.pageTypes.includes(pageType)) item.pageTypes.push(pageType);
      }
      periods.set(period.periodKey, item);
    }
  }
  return [...periods.values()].sort((first, second) => second.periodKey.localeCompare(first.periodKey));
}

function refreshAvailablePeriods(preferredPeriodKey = state.periodKey) {
  state.periods = availablePeriods();
  state.periodKey = state.periods.some(item => item.periodKey === preferredPeriodKey)
    ? preferredPeriodKey : (state.periods[0] ? state.periods[0].periodKey : null);
  document.getElementById("viewerPeriod").innerHTML = state.periods.map(item =>
    `<option value="${esc(item.periodKey)}">${esc(monthLabel(item.periodKey))}</option>`).join("");
}

function availableReportScopes(periodKey) {
  const selected = state.subjects.find(subject => String(subject.doctorId) === String(state.subjectDoctorId));
  const options = [];
  if (selected && subjectHasPage(selected, periodKey, "doctor")) {
    options.push({
      key: reportScopeKey("doctor", "", "", selected.doctorId),
      pageType: "doctor",
      subjectDoctorId: selected.doctorId,
      label: String(selected.doctorId) === String(state.doctor && state.doctor.doctorId) ? "Мой отчёт" : "Личный отчёт",
    });
  }
  if (!isDepartmentHead()) {
    if (selected && subjectHasPage(selected, periodKey, "specialization")) {
      options.push({ key: reportScopeKey("specialization", selected.department, selected.specialization), pageType: "specialization",
        subjectDoctorId: selected.doctorId, label: "Специализация" });
    }
    if (selected && subjectHasPage(selected, periodKey, "department")) {
      options.push({ key: reportScopeKey("department", selected.department), pageType: "department",
        subjectDoctorId: selected.doctorId, label: "Отделение" });
    }
    return options;
  }

  const subjects = managedSubjects();
  const departments = [...new Set(subjects.map(subject => String(subject.department || "")).filter(Boolean))]
    .sort((first, second) => first.localeCompare(second, "ru", { sensitivity: "base" }));
  for (const department of departments) {
    const representative = subjects.find(subject => String(subject.department || "") === department
      && subjectHasPage(subject, periodKey, "department"));
    if (representative) options.push({
      key: reportScopeKey("department", department), pageType: "department", subjectDoctorId: representative.doctorId,
      label: departments.length === 1 ? "Всё отделение" : `Отделение: ${department}`,
    });
  }
  const specializations = new Map();
  for (const subject of subjects) {
    const department = String(subject.department || "");
    const specialization = String(subject.specialization || "");
    if (!department || !specialization || !subjectHasPage(subject, periodKey, "specialization")) continue;
    const key = `${department}\u0000${specialization}`;
    if (!specializations.has(key)) specializations.set(key, { department, specialization, subject });
  }
  for (const item of [...specializations.values()].sort((first, second) =>
    first.department.localeCompare(second.department, "ru", { sensitivity: "base" })
    || first.specialization.localeCompare(second.specialization, "ru", { sensitivity: "base" }))) {
    options.push({
      key: reportScopeKey("specialization", item.department, item.specialization),
      pageType: "specialization",
      subjectDoctorId: item.subject.doctorId,
      label: departments.length === 1 ? item.specialization : `${item.department} · ${item.specialization}`,
    });
  }
  return options;
}

function showError(id, message) {
  const box = document.getElementById(id);
  box.textContent = String(message || "");
  box.classList.toggle("hidden", !message);
}

async function refreshStatus() {
  state.status = await API.status();
  document.getElementById("viewerSetup").classList.toggle("hidden", state.status.configured && state.status.online);
  document.getElementById("viewerLogin").classList.toggle("hidden", !state.status.configured || !state.status.online || Boolean(state.doctor));
  document.getElementById("viewerReport").classList.toggle("hidden", !state.doctor);
  if (!state.status.configured) {
    showError("viewerSetupError", "Общая папка ещё не выбрана.");
    return;
  }
  if (!state.status.online) {
    showError("viewerSetupError", "Общая папка недоступна. Проверьте подключение к сети клиники или выберите её снова.");
    return;
  }
  showError("viewerSetupError", "");
  document.getElementById("viewerStorageCaption").textContent = state.status.storageRoot;
  const select = document.getElementById("viewerDoctorSelect");
  const doctors = sortDoctorsAlphabetically(state.status.catalog.doctors);
  select.innerHTML = doctors.length
    ? doctors.map(doctor => `<option value="${esc(doctor.doctorId)}">${esc(doctor.displayName)}${doctor.department ? ` · ${esc(doctor.department)}` : ""}</option>`).join("")
    : '<option value="">Отчёты ещё не импортированы</option>';
  document.getElementById("btnDoctorLogin").disabled = !doctors.length;
}

async function chooseStorage() {
  try {
    const result = await API.chooseStorage();
    if (result.canceled) return;
    state.adminAuthenticated = false;
    state.doctor = null;
    await refreshStatus();
    const dialog = document.getElementById("viewerAdminDialog");
    if (dialog.open) renderAdminMode();
    else if (!state.status.initialized) openAdminDialog();
  } catch (error) {
    showError("viewerSetupError", error.message);
    showError("viewerAdminError", error.message);
  }
}

function renderAdminMode() {
  const initialized = Boolean(state.status && state.status.initialized);
  document.getElementById("viewerAdminStorage").textContent = state.status && state.status.storageRoot
    ? state.status.storageRoot
    : "Общая папка не выбрана";
  const showPanel = !initialized || state.adminAuthenticated;
  document.getElementById("viewerAdminLogin").classList.toggle("hidden", showPanel);
  document.getElementById("viewerAdminPanel").classList.toggle("hidden", !showPanel);
  document.getElementById("viewerBootstrapPinField").classList.toggle("hidden", initialized);
}

function openAdminDialog() {
  showError("viewerAdminError", "");
  renderAdminMode();
  document.getElementById("viewerAdminDialog").showModal();
  const target = state.status && state.status.initialized && !state.adminAuthenticated
    ? document.getElementById("viewerAdminPin")
    : document.getElementById("viewerPackageDrop");
  setTimeout(() => target && target.focus(), 0);
}

async function loginAdmin() {
  try {
    await API.adminLogin(document.getElementById("viewerAdminPin").value);
    document.getElementById("viewerAdminPin").value = "";
    state.adminAuthenticated = true;
    showError("viewerAdminError", "");
    renderAdminMode();
  } catch (error) {
    showError("viewerAdminError", error.message);
  }
}

function renderPackagePreview(preview) {
  state.packagePreview = preview;
  document.getElementById("viewerPackagePreview").classList.remove("hidden");
  document.getElementById("viewerPackageSummary").innerHTML = `<b>${esc(preview.path.split(/[\\/]/).pop())}</b><br>
    Создан: ${esc(new Date(preview.createdAt).toLocaleString("ru-RU"))} · врачей: ${preview.doctors.length} · периодов: ${preview.periods.length}<br>
    <span class="small">SHA-256: <code>${esc(preview.sha256)}</code></span>`;
  document.getElementById("viewerImportPeriods").innerHTML = preview.periods.slice().reverse().map(periodKey =>
    `<label><input type="checkbox" data-import-period value="${esc(periodKey)}" checked> ${esc(monthLabel(periodKey))}</label>`
  ).join("");
  document.getElementById("viewerImportDoctors").innerHTML = sortDoctorsAlphabetically(preview.doctors).map(doctor =>
    `<label><input type="checkbox" data-import-doctor value="${esc(doctor.doctorId)}" checked> <b>${esc(doctor.displayName)}</b>
      <span class="small muted">${esc([doctor.department, doctor.specialization].filter(Boolean).join(" · "))}</span></label>`
  ).join("");
}

async function pickPackage() {
  try {
    const result = await API.pickPackage();
    if (!result.canceled) renderPackagePreview(result.preview);
    showError("viewerAdminError", "");
  } catch (error) {
    showError("viewerAdminError", error.message);
  }
}

async function previewDroppedPackage(file) {
  try {
    const filePath = API.pathForFile(file);
    if (!filePath) throw new Error("Не удалось получить путь к ZIP-файлу");
    renderPackagePreview(await API.previewPackagePath(filePath));
    showError("viewerAdminError", "");
  } catch (error) {
    showError("viewerAdminError", error.message);
  }
}

async function importPackage() {
  if (!state.packagePreview) return;
  const doctorIds = [...document.querySelectorAll("[data-import-doctor]:checked")].map(input => input.value);
  const periods = [...document.querySelectorAll("[data-import-period]:checked")].map(input => input.value);
  if (!doctorIds.length || !periods.length) {
    showError("viewerAdminError", "Выберите хотя бы одного врача и один период.");
    return;
  }
  const button = document.getElementById("btnImportPackage");
  button.disabled = true;
  button.textContent = "Импортирую…";
  try {
    const result = await API.importPackage({
      path: state.packagePreview.path,
      doctorIds,
      periods,
      adminPin: state.status.initialized ? null : document.getElementById("viewerBootstrapPin").value,
    });
    state.status = result.status;
    state.adminAuthenticated = true;
    state.packagePreview = null;
    document.getElementById("viewerPackagePreview").classList.add("hidden");
    document.getElementById("viewerBootstrapPin").value = "";
    showError("viewerAdminError", "");
    await refreshStatus();
    renderAdminMode();
    alert(`Импорт завершён. Врачей: ${result.result.doctors}, периодов: ${result.result.periods}.`);
  } catch (error) {
    showError("viewerAdminError", error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Импортировать выбранное";
  }
}

async function loginDoctor() {
  const doctorId = document.getElementById("viewerDoctorSelect").value;
  const pin = document.getElementById("viewerDoctorPin").value;
  try {
    const result = await API.doctorLogin({ doctorId, pin });
    state.doctor = result.doctor;
    state.subjects = sortDoctorsAlphabetically(Array.isArray(result.subjects) ? result.subjects : []);
    const ownSubject = state.subjects.find(subject => String(subject.doctorId) === String(state.doctor.doctorId)) || state.subjects[0];
    state.subjectDoctorId = ownSubject ? ownSubject.doctorId : null;
    state.reportKey = reportScopeKey("doctor", "", "", state.subjectDoctorId);
    refreshAvailablePeriods(null);
    state.pageType = "doctor";
    document.getElementById("viewerDoctorPin").value = "";
    showError("viewerLoginError", "");
    document.getElementById("viewerDoctorName").textContent = state.doctor.displayName;
    document.getElementById("viewerDoctorStructure").textContent = [state.subjects.length > 1 ? "Заведующий отделением" : "", state.doctor.department, state.doctor.specialization].filter(Boolean).join(" · ");
    const subjectControl = document.getElementById("viewerSubjectControl");
    subjectControl.classList.toggle("hidden", state.subjects.length <= 1);
    document.getElementById("viewerSubject").innerHTML = state.subjects.map(subject =>
      `<option value="${esc(subject.doctorId)}">${esc(subject.displayName)}${subject.specialization ? ` · ${esc(subject.specialization)}` : ""}</option>`
    ).join("");
    document.getElementById("viewerSubject").value = state.subjectDoctorId || "";
    await refreshStatus();
    await loadReport();
  } catch (error) {
    showError("viewerLoginError", error.message);
  }
}

function updatePeriodButtons() {
  const index = state.periods.findIndex(item => item.periodKey === state.periodKey);
  document.getElementById("btnPreviousPeriod").disabled = index < 0 || index >= state.periods.length - 1;
  document.getElementById("btnNextPeriod").disabled = index <= 0;
}

function initializeReportWindowSwitchers(root) {
  const bind = (containerSelector, buttonAttribute, panelAttribute) => {
    for (const container of root.querySelectorAll(containerSelector)) {
      if (container.dataset.viewerSwitcherReady === "true") continue;
      container.dataset.viewerSwitcherReady = "true";
      const buttons = [...container.querySelectorAll(`[${buttonAttribute}]`)];
      const panels = [...container.querySelectorAll(`[${panelAttribute}]`)];
      for (const button of buttons) button.addEventListener("click", () => {
        const value = button.getAttribute(buttonAttribute);
        for (const item of buttons) {
          const active = item.getAttribute(buttonAttribute) === value;
          item.classList.toggle("active", active);
          item.setAttribute("aria-pressed", active ? "true" : "false");
        }
        for (const panel of panels) panel.hidden = panel.getAttribute(panelAttribute) !== value;
      });
    }
  };
  bind("[data-viewer-interdisciplinary]", "data-viewer-naz-window", "data-viewer-naz-panel");
  bind("[data-viewer-client-base]", "data-viewer-kb-window", "data-viewer-kb-panel");
}

function initializePatientRegisters(root) {
  initializeReportWindowSwitchers(root);
  for (const register of root.querySelectorAll("[data-viewer-patient-register]")) {
    if (register.dataset.viewerPatientReady === "true") continue;
    register.dataset.viewerPatientReady = "true";
    const search = register.querySelector("[data-viewer-patient-search]");
    const segment = register.querySelector("[data-viewer-patient-segment]");
    const status = register.querySelector("[data-viewer-patient-status]");
    const rows = [...register.querySelectorAll("[data-viewer-patient-row]")];
    if (!search || !segment || !status || !rows.length) continue;
    const update = () => {
      const needle = String(search.value || "").toLocaleLowerCase("ru-RU").trim();
      const selected = String(segment.value || "all");
      let visible = 0;
      for (const row of rows) {
        const haystack = String(row.dataset.patientSearch || "").toLocaleLowerCase("ru-RU");
        const groups = new Set(String(row.dataset.patientGroups || "").split(/\s+/).filter(Boolean));
        const matchesSegment = selected === "all"
          || (selected === "work" && ["newRisk", "loyalSleep", "lost"].some(group => groups.has(group)))
          || (selected === "ungrouped" && groups.size === 0)
          || groups.has(selected);
        const matches = matchesSegment && (!needle || haystack.includes(needle));
        row.hidden = !matches;
        if (matches) visible++;
      }
      status.textContent = `Показано: ${visible.toLocaleString("ru-RU")} из ${rows.length.toLocaleString("ru-RU")}`;
    };
    search.addEventListener("input", update);
    segment.addEventListener("change", update);
    update();
  }
}

async function loadReport() {
  const period = state.periods.find(item => item.periodKey === state.periodKey);
  if (!period) return;
  const options = availableReportScopes(state.periodKey);
  const preferredDoctorKey = reportScopeKey("doctor", "", "", state.subjectDoctorId);
  const selected = options.find(option => option.key === state.reportKey)
    || options.find(option => option.key === preferredDoctorKey)
    || options[0];
  if (!selected) {
    document.getElementById("viewerTabs").innerHTML = "";
    document.getElementById("viewerReportBody").innerHTML = '<div class="card"><p class="muted">Для этого периода страницы не опубликованы.</p></div>';
    updatePeriodButtons();
    return;
  }
  state.reportKey = selected.key;
  state.pageType = selected.pageType;
  document.getElementById("viewerTabs").innerHTML = options.map(option =>
    `<button class="btn ${option.key === state.reportKey ? "active" : ""}" data-report-key="${esc(option.key)}">${esc(option.label)}</button>`
  ).join("");
  document.querySelectorAll("[data-report-key]").forEach(button => button.addEventListener("click", async () => {
    state.reportKey = button.dataset.reportKey;
    await loadReport();
  }));
  const report = await API.report({ subjectDoctorId: selected.subjectDoctorId, periodKey: state.periodKey, pageType: selected.pageType });
  const reportBody = document.getElementById("viewerReportBody");
  reportBody.innerHTML = report && report.html
    ? report.html
    : '<div class="card"><p class="muted">Для этого периода страница не опубликована.</p></div>';
  initializePatientRegisters(reportBody);
  document.getElementById("viewerPeriod").value = state.periodKey;
  updatePeriodButtons();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function changeSubject(doctorId) {
  const subject = state.subjects.find(item => String(item.doctorId) === String(doctorId));
  if (!subject) return;
  state.subjectDoctorId = subject.doctorId;
  state.reportKey = reportScopeKey("doctor", "", "", subject.doctorId);
  state.pageType = "doctor";
  refreshAvailablePeriods(state.periodKey);
  await loadReport();
}

async function changePeriod(direction) {
  const index = state.periods.findIndex(item => item.periodKey === state.periodKey);
  const next = state.periods[index + direction];
  if (!next) return;
  state.periodKey = next.periodKey;
  await loadReport();
}

async function logoutDoctor() {
  await API.doctorLogout();
  state.doctor = null;
  state.subjects = [];
  state.subjectDoctorId = null;
  state.periods = [];
  state.reportKey = "";
  document.getElementById("viewerReportBody").innerHTML = "";
  await refreshStatus();
}

function bindEvents() {
  document.getElementById("btnChooseStorage").addEventListener("click", chooseStorage);
  document.getElementById("btnOpenAdmin").addEventListener("click", openAdminDialog);
  document.getElementById("btnCloseAdmin").addEventListener("click", () => document.getElementById("viewerAdminDialog").close());
  document.getElementById("btnAdminLogin").addEventListener("click", loginAdmin);
  document.getElementById("viewerAdminPin").addEventListener("keydown", event => { if (event.key === "Enter") loginAdmin(); });
  document.getElementById("btnAdminChooseStorage").addEventListener("click", chooseStorage);
  document.getElementById("viewerPackageDrop").addEventListener("click", pickPackage);
  for (const type of ["dragenter", "dragover"]) document.getElementById("viewerPackageDrop").addEventListener(type, event => {
    event.preventDefault(); event.currentTarget.classList.add("dragover");
  });
  for (const type of ["dragleave", "drop"]) document.getElementById("viewerPackageDrop").addEventListener(type, event => {
    event.preventDefault(); event.currentTarget.classList.remove("dragover");
  });
  document.getElementById("viewerPackageDrop").addEventListener("drop", event => {
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) previewDroppedPackage(file);
  });
  document.getElementById("btnImportPackage").addEventListener("click", importPackage);
  document.getElementById("btnDoctorLogin").addEventListener("click", loginDoctor);
  document.getElementById("viewerDoctorPin").addEventListener("keydown", event => { if (event.key === "Enter") loginDoctor(); });
  document.getElementById("btnDoctorLogout").addEventListener("click", logoutDoctor);
  document.getElementById("viewerPeriod").addEventListener("change", async event => { state.periodKey = event.target.value; await loadReport(); });
  document.getElementById("viewerSubject").addEventListener("change", async event => { await changeSubject(event.target.value); });
  document.getElementById("btnPreviousPeriod").addEventListener("click", () => changePeriod(1));
  document.getElementById("btnNextPeriod").addEventListener("click", () => changePeriod(-1));
  document.getElementById("btnPrintReport").addEventListener("click", () => window.print());
}

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  try {
    const appInfo = await API.appInfo();
    document.getElementById("viewerAppVersion").textContent = `v${appInfo.version}`;
    await refreshStatus();
  } catch (error) { showError("viewerSetupError", error.message); }
});
