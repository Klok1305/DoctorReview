"use strict";

const BUNDLE = JSON.parse(document.getElementById("standaloneViewerData").textContent);
const LOCK_MS = 15 * 60 * 1000;
const state = {
  role: "doctor",
  doctor: null,
  subjects: [],
  subjectDoctorId: null,
  reports: [],
  periods: [],
  periodKey: null,
  pageType: "doctor",
  reportKey: "",
  failures: new Map(),
  lockedUntil: new Map(),
};

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function monthLabel(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value || ""));
  if (!match) return value;
  return new Date(Number(match[1]), Number(match[2]) - 1, 1)
    .toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
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
  return state.role === "admin" || Boolean(state.doctor && ((Array.isArray(state.doctor.managedDepartments) && state.doctor.managedDepartments.length)
    || state.subjects.length > 1));
}

function managedSubjects() {
  if (state.role === "admin") return state.subjects;
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
        subjectDoctorId: selected.doctorId, department: selected.department, specialization: selected.specialization,
        label: "Специализация" });
    }
    if (selected && subjectHasPage(selected, periodKey, "department")) {
      options.push({ key: reportScopeKey("department", selected.department), pageType: "department",
        subjectDoctorId: selected.doctorId, department: selected.department, label: "Отделение" });
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
      department,
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
      department: item.department,
      specialization: item.specialization,
      label: departments.length === 1 ? item.specialization : `${item.department} · ${item.specialization}`,
    });
  }
  return options;
}

function reportScopeButton(option, label = option.label) {
  return `<button class="btn ${option.key === state.reportKey ? "active" : ""}" data-report-key="${esc(option.key)}">${esc(label)}</button>`;
}

function renderReportScopeNavigation(options) {
  if (!isDepartmentHead()) return options.map(option => reportScopeButton(option)).join("");
  const personal = options.filter(option => option.pageType === "doctor");
  const aggregate = options.filter(option => option.pageType !== "doctor");
  const departments = new Map();
  for (const option of aggregate) {
    const department = String(option.department || "").trim();
    if (!department) continue;
    const group = departments.get(department) || { department, departmentReport: null, specializations: [] };
    if (option.pageType === "department") group.departmentReport = option;
    if (option.pageType === "specialization") group.specializations.push(option);
    departments.set(department, group);
  }
  if (!departments.size) return options.map(option => reportScopeButton(option)).join("");
  const personalHtml = personal.length
    ? `<div class="viewer-scope-personal" aria-label="Личный отчёт">${personal.map(option => reportScopeButton(option)).join("")}</div>`
    : "";
  const rows = [...departments.values()].map(group => {
    const departmentControl = group.departmentReport
      ? reportScopeButton(group.departmentReport, group.department)
      : `<span class="viewer-scope-empty"><b>${esc(group.department)}</b><small>Отчёт отделения не включён</small></span>`;
    const specializationControls = group.specializations.length
      ? group.specializations.map(option => reportScopeButton(option, option.specialization || option.label)).join("")
      : '<span class="viewer-scope-empty">Нет включённых специализаций</span>';
    return `<div class="viewer-scope-row" data-department-name="${esc(group.department)}">
      <div class="viewer-scope-cell viewer-scope-department"><span class="viewer-scope-cell-label">Отделение</span>${departmentControl}</div>
      <div class="viewer-scope-cell viewer-scope-specializations"><span class="viewer-scope-cell-label">Специализации</span>${specializationControls}</div>
    </div>`;
  }).join("");
  return `${personalHtml}<div class="viewer-scope-groups">${rows}</div>`;
}

function base64Bytes(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function joinBytes(first, second) {
  const result = new Uint8Array(first.length + second.length);
  result.set(first, 0);
  result.set(second, first.length);
  return result;
}

async function gunzip(bytes) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("Этот браузер слишком старый. Откройте файл в актуальной версии Chrome, Edge, Firefox или Safari.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decryptStandaloneAccess(access, pin, { role = "doctor", doctorId = access && access.doctorId } = {}) {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error("Браузер не поддерживает локальное расшифрование. Откройте файл в актуальной версии Chrome, Edge, Firefox или Safari.");
  }
  const encryption = access.encryption || {};
  if (encryption.algorithm !== "aes-256-gcm" || encryption.kdf !== "pbkdf2" || encryption.hash !== "sha-256") {
    throw new Error("Формат шифрования этого файла не поддерживается.");
  }
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(pin), { name: "PBKDF2" }, false, ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey({
    name: "PBKDF2",
    salt: base64Bytes(encryption.salt),
    iterations: Number(encryption.iterations),
    hash: "SHA-256",
  }, keyMaterial, { name: "AES-GCM", length: Number(encryption.keyLength) }, false, ["decrypt"]);
  const encrypted = joinBytes(base64Bytes(access.ciphertext), base64Bytes(encryption.tag));
  const decrypted = new Uint8Array(await crypto.subtle.decrypt({
    name: "AES-GCM", iv: base64Bytes(encryption.iv), tagLength: 128,
  }, key, encrypted));
  const plainBytes = encryption.compression === "gzip" ? await gunzip(decrypted) : decrypted;
  const payload = JSON.parse(new TextDecoder().decode(plainBytes));
  const formatVersion = Number(payload.formatVersion);
  const roleMatches = role === "admin"
    ? formatVersion >= 3 && payload.accessRole === "admin"
    : (!payload.accessRole || payload.accessRole === "doctor") && String(payload.doctorId) === String(doctorId);
  if (payload.format !== "pulse-clinic-standalone-viewer" || ![2, 3].includes(formatVersion)
    || payload.packageId !== BUNDLE.packageId || !roleMatches
    || !Array.isArray(payload.subjects) || !Array.isArray(payload.reports)) {
    throw new Error("Нарушена целостность автономной публикации.");
  }
  return payload;
}

function decryptDoctor(doctor, pin) {
  return decryptStandaloneAccess(doctor, pin, { role: "doctor", doctorId: doctor.doctorId });
}

function decryptAdmin(pin) {
  return decryptStandaloneAccess(BUNDLE.adminAccess, pin, { role: "admin" });
}

function showLoginError(message) {
  const box = document.getElementById("viewerLoginError");
  box.textContent = String(message || "");
  box.classList.toggle("hidden", !message);
}

function periodsFromReports(reports, subjectDoctorId) {
  const periods = new Map();
  for (const report of reports.filter(item => String(item.doctorId) === String(subjectDoctorId))) {
    const item = periods.get(report.periodKey) || { periodKey: report.periodKey, pageTypes: [] };
    if (!item.pageTypes.includes(report.pageType)) item.pageTypes.push(report.pageType);
    periods.set(report.periodKey, item);
  }
  return [...periods.values()].sort((a, b) => b.periodKey.localeCompare(a.periodKey));
}

function openReportSession(actor, payload, role = "doctor") {
  state.role = role;
  state.doctor = actor;
  state.reports = payload.reports;
  state.subjects = sortDoctorsAlphabetically(payload.subjects).map(subject => ({
    ...subject,
    periods: periodsFromReports(state.reports, subject.doctorId),
  }));
  const ownSubject = role === "admin"
    ? state.subjects[0]
    : state.subjects.find(subject => String(subject.doctorId) === String(actor.doctorId)) || state.subjects[0];
  state.subjectDoctorId = ownSubject ? ownSubject.doctorId : null;
  state.reportKey = reportScopeKey("doctor", "", "", state.subjectDoctorId);
  state.pageType = "doctor";
  refreshAvailablePeriods(null);
  document.getElementById("viewerDoctorName").textContent = actor.displayName;
  document.getElementById("viewerDoctorStructure").textContent = role === "admin"
    ? `Полный доступ · врачей: ${state.subjects.length} · отчётов: ${state.reports.length}`
    : [state.subjects.length > 1 ? "Заведующий отделением" : "", actor.department, actor.specialization].filter(Boolean).join(" · ");
  const subjectControl = document.getElementById("viewerSubjectControl");
  subjectControl.classList.toggle("hidden", role !== "admin" && state.subjects.length <= 1);
  document.getElementById("viewerSubjectLabel").textContent = role === "admin" ? "Врач:" : "Врач отделения:";
  document.getElementById("viewerSubject").innerHTML = state.subjects.map(subject =>
    `<option value="${esc(subject.doctorId)}">${esc(subject.displayName)}${subject.department ? ` · ${esc(subject.department)}` : ""}${subject.specialization ? ` · ${esc(subject.specialization)}` : ""}</option>`
  ).join("");
  document.getElementById("viewerSubject").value = state.subjectDoctorId || "";
  document.getElementById("viewerLogin").classList.add("hidden");
  document.getElementById("viewerReport").classList.remove("hidden");
  showLoginError("");
  loadReport();
}

function registerLoginFailure(key, role, error) {
  const label = role === "admin" ? "администратора" : "врача";
  const failures = Number(state.failures.get(key) || 0) + 1;
  if (failures >= 5) {
    state.failures.delete(key);
    state.lockedUntil.set(key, Date.now() + LOCK_MS);
    showLoginError(`Вход ${label} заблокирован на 15 минут после пяти неверных PIN.`);
  } else if (/слишком старый|не поддерживает|Формат шифрования|целостность/.test(String(error.message || ""))) {
    showLoginError(error.message);
  } else {
    state.failures.set(key, failures);
    showLoginError(`Неверный PIN ${label}. Осталось попыток: ${5 - failures}.`);
  }
}

async function loginDoctor() {
  const doctorId = document.getElementById("viewerDoctorSelect").value;
  const pin = document.getElementById("viewerDoctorPin").value;
  const doctor = (BUNDLE.doctors || []).find(item => String(item.doctorId) === doctorId);
  const button = document.getElementById("btnDoctorLogin");
  if (!doctor) return showLoginError("Врач не найден в публикации.");
  if (!/^\d{4}$/.test(pin)) return showLoginError("Введите четырёхзначный PIN врача.");
  if (Number(state.lockedUntil.get(doctorId) || 0) > Date.now()) {
    return showLoginError("Вход врача временно заблокирован после пяти неверных PIN.");
  }
  button.disabled = true;
  button.textContent = "Проверяю PIN…";
  try {
    const payload = await decryptDoctor(doctor, pin);
    state.failures.delete(doctorId);
    state.lockedUntil.delete(doctorId);
    document.getElementById("viewerDoctorPin").value = "";
    openReportSession(doctor, payload, "doctor");
  } catch (error) {
    registerLoginFailure(doctorId, "doctor", error);
  } finally {
    button.disabled = false;
    button.textContent = "Открыть отчёты";
  }
}

async function loginAdmin() {
  const pin = document.getElementById("viewerAdminPin").value;
  const key = "__admin__";
  const button = document.getElementById("btnAdminLogin");
  if (!BUNDLE.adminAccess || !BUNDLE.adminAccess.ciphertext) return showLoginError("В этом HTML нет входа администратора.");
  if (!/^\d{6,12}$/.test(pin)) return showLoginError("Введите администраторский PIN Viewer из 6–12 цифр.");
  if (Number(state.lockedUntil.get(key) || 0) > Date.now()) {
    return showLoginError("Вход администратора временно заблокирован после пяти неверных PIN.");
  }
  button.disabled = true;
  button.textContent = "Открываю полный каталог…";
  try {
    const payload = await decryptAdmin(pin);
    state.failures.delete(key);
    state.lockedUntil.delete(key);
    document.getElementById("viewerAdminPin").value = "";
    openReportSession({ doctorId: key, displayName: "Администратор", managedDepartments: [] }, payload, "admin");
  } catch (error) {
    registerLoginFailure(key, "admin", error);
  } finally {
    button.disabled = false;
    button.textContent = "Открыть все отчёты";
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

function loadReport() {
  const period = state.periods.find(item => item.periodKey === state.periodKey);
  if (!period) return;
  const options = availableReportScopes(state.periodKey);
  const preferredDoctorKey = reportScopeKey("doctor", "", "", state.subjectDoctorId);
  const selected = options.find(option => option.key === state.reportKey)
    || options.find(option => option.key === preferredDoctorKey)
    || options[0];
  if (!selected) {
    document.getElementById("viewerTabs").classList.remove("viewer-tabs-grouped");
    document.getElementById("viewerTabs").innerHTML = "";
    document.getElementById("viewerReportBody").innerHTML = '<div class="card"><p class="muted">Для этого периода страницы не опубликованы.</p></div>';
    updatePeriodButtons();
    return;
  }
  state.reportKey = selected.key;
  state.pageType = selected.pageType;
  document.getElementById("viewerTabs").classList.toggle("viewer-tabs-grouped", isDepartmentHead());
  document.getElementById("viewerTabs").innerHTML = renderReportScopeNavigation(options);
  document.querySelectorAll("[data-report-key]").forEach(button => button.addEventListener("click", () => {
    state.reportKey = button.dataset.reportKey;
    loadReport();
  }));
  const report = state.reports.find(item => String(item.doctorId) === String(selected.subjectDoctorId)
    && item.periodKey === state.periodKey && item.pageType === selected.pageType);
  const reportBody = document.getElementById("viewerReportBody");
  reportBody.innerHTML = report && report.html
    ? report.html : '<div class="card"><p class="muted">Для этого периода страница не опубликована.</p></div>';
  initializePatientRegisters(reportBody);
  document.getElementById("viewerPeriod").value = state.periodKey;
  updatePeriodButtons();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function changeSubject(doctorId) {
  const subject = state.subjects.find(item => String(item.doctorId) === String(doctorId));
  if (!subject) return;
  state.subjectDoctorId = subject.doctorId;
  state.reportKey = reportScopeKey("doctor", "", "", subject.doctorId);
  state.pageType = "doctor";
  refreshAvailablePeriods(state.periodKey);
  loadReport();
}

function changePeriod(direction) {
  const index = state.periods.findIndex(item => item.periodKey === state.periodKey);
  const next = state.periods[index + direction];
  if (!next) return;
  state.periodKey = next.periodKey;
  loadReport();
}

function logoutDoctor() {
  state.role = "doctor";
  state.doctor = null;
  state.subjects = [];
  state.subjectDoctorId = null;
  state.reports = [];
  state.periods = [];
  state.reportKey = "";
  document.getElementById("viewerReportBody").innerHTML = "";
  document.getElementById("viewerReport").classList.add("hidden");
  document.getElementById("viewerLogin").classList.remove("hidden");
  document.getElementById("viewerAdminPin").value = "";
  document.getElementById("viewerDoctorPin").focus();
}

function initialize() {
  if (BUNDLE.format !== "pulse-clinic-standalone-viewer" || ![2, 3].includes(Number(BUNDLE.formatVersion)) || !Array.isArray(BUNDLE.doctors)) {
    showLoginError("Формат автономного Viewer не поддерживается.");
    document.getElementById("btnDoctorLogin").disabled = true;
    return;
  }
  document.getElementById("viewerPublicationCaption").textContent = `Сформировано ${new Date(BUNDLE.createdAt).toLocaleString("ru-RU")} · периодов: ${BUNDLE.periods.length}`;
  document.getElementById("viewerAppVersion").textContent = BUNDLE.appVersion
    ? `Версия отчётов ${BUNDLE.appVersion} · автономный файл`
    : "Автономный файл";
  document.getElementById("viewerDoctorSelect").innerHTML = sortDoctorsAlphabetically(BUNDLE.doctors).map(doctor =>
    `<option value="${esc(doctor.doctorId)}">${esc(doctor.displayName)}${doctor.department ? ` · ${esc(doctor.department)}` : ""}</option>`
  ).join("");
  document.getElementById("viewerAdminLogin").classList.toggle("hidden", !BUNDLE.adminAccess || !BUNDLE.adminAccess.ciphertext);
  document.getElementById("btnDoctorLogin").disabled = !BUNDLE.doctors.length;
  document.getElementById("btnDoctorLogin").addEventListener("click", loginDoctor);
  document.getElementById("viewerDoctorPin").addEventListener("keydown", event => { if (event.key === "Enter") loginDoctor(); });
  document.getElementById("btnAdminLogin").addEventListener("click", loginAdmin);
  document.getElementById("viewerAdminPin").addEventListener("keydown", event => { if (event.key === "Enter") loginAdmin(); });
  document.getElementById("btnDoctorLogout").addEventListener("click", logoutDoctor);
  document.getElementById("viewerPeriod").addEventListener("change", event => { state.periodKey = event.target.value; loadReport(); });
  document.getElementById("viewerSubject").addEventListener("change", event => changeSubject(event.target.value));
  document.getElementById("btnPreviousPeriod").addEventListener("click", () => changePeriod(1));
  document.getElementById("btnNextPeriod").addEventListener("click", () => changePeriod(-1));
  document.getElementById("btnPrintReport").addEventListener("click", () => window.print());
}

initialize();
