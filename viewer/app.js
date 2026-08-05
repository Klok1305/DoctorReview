"use strict";

const API = window.viewerAPI;
const state = {
  status: null,
  adminAuthenticated: false,
  packagePreview: null,
  doctor: null,
  periods: [],
  periodKey: null,
  pageType: "doctor",
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
  const doctors = state.status.catalog.doctors || [];
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
  document.getElementById("viewerImportDoctors").innerHTML = preview.doctors.map(doctor =>
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
    state.periods = result.periods || [];
    state.periodKey = state.periods[0] ? state.periods[0].periodKey : null;
    state.pageType = state.periods[0] && state.periods[0].pageTypes.includes("doctor") ? "doctor" : (state.periods[0]?.pageTypes[0] || "doctor");
    document.getElementById("viewerDoctorPin").value = "";
    showError("viewerLoginError", "");
    document.getElementById("viewerDoctorName").textContent = state.doctor.displayName;
    document.getElementById("viewerDoctorStructure").textContent = [state.doctor.department, state.doctor.specialization].filter(Boolean).join(" · ");
    document.getElementById("viewerPeriod").innerHTML = state.periods.map(item => `<option value="${esc(item.periodKey)}">${esc(monthLabel(item.periodKey))}</option>`).join("");
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

async function loadReport() {
  const period = state.periods.find(item => item.periodKey === state.periodKey);
  if (!period) return;
  if (!period.pageTypes.includes(state.pageType)) state.pageType = period.pageTypes.includes("doctor") ? "doctor" : period.pageTypes[0];
  const labels = { doctor: "Мой отчёт", specialization: "Специализация", department: "Отделение" };
  document.getElementById("viewerTabs").innerHTML = period.pageTypes.map(pageType =>
    `<button class="btn ${pageType === state.pageType ? "active" : ""}" data-page-type="${pageType}">${labels[pageType] || pageType}</button>`
  ).join("");
  document.querySelectorAll("[data-page-type]").forEach(button => button.addEventListener("click", async () => {
    state.pageType = button.dataset.pageType;
    await loadReport();
  }));
  const report = await API.report({ periodKey: state.periodKey, pageType: state.pageType });
  document.getElementById("viewerReportBody").innerHTML = report && report.html
    ? report.html
    : '<div class="card"><p class="muted">Для этого периода страница не опубликована.</p></div>';
  document.getElementById("viewerPeriod").value = state.periodKey;
  updatePeriodButtons();
  window.scrollTo({ top: 0, behavior: "smooth" });
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
  state.periods = [];
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
  document.getElementById("btnPreviousPeriod").addEventListener("click", () => changePeriod(1));
  document.getElementById("btnNextPeriod").addEventListener("click", () => changePeriod(-1));
  document.getElementById("btnPrintReport").addEventListener("click", () => window.print());
}

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  try { await refreshStatus(); } catch (error) { showError("viewerSetupError", error.message); }
});
