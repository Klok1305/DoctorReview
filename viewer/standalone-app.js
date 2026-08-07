"use strict";

const BUNDLE = JSON.parse(document.getElementById("standaloneViewerData").textContent);
const LOCK_MS = 15 * 60 * 1000;
const state = {
  doctor: null,
  subjects: [],
  subjectDoctorId: null,
  reports: [],
  periods: [],
  periodKey: null,
  pageType: "doctor",
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

async function decryptDoctor(doctor, pin) {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error("Браузер не поддерживает локальное расшифрование. Откройте файл в актуальной версии Chrome, Edge, Firefox или Safari.");
  }
  const encryption = doctor.encryption || {};
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
  const encrypted = joinBytes(base64Bytes(doctor.ciphertext), base64Bytes(encryption.tag));
  const decrypted = new Uint8Array(await crypto.subtle.decrypt({
    name: "AES-GCM", iv: base64Bytes(encryption.iv), tagLength: 128,
  }, key, encrypted));
  const plainBytes = encryption.compression === "gzip" ? await gunzip(decrypted) : decrypted;
  const payload = JSON.parse(new TextDecoder().decode(plainBytes));
  if (payload.format !== "pulse-clinic-standalone-viewer" || Number(payload.formatVersion) !== 2
    || payload.packageId !== BUNDLE.packageId || String(payload.doctorId) !== String(doctor.doctorId)
    || !Array.isArray(payload.subjects) || !Array.isArray(payload.reports)) {
    throw new Error("Нарушена целостность автономной публикации.");
  }
  return payload;
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
    state.doctor = doctor;
    state.subjects = payload.subjects;
    state.reports = payload.reports;
    const ownSubject = state.subjects.find(subject => String(subject.doctorId) === String(doctor.doctorId)) || state.subjects[0];
    state.subjectDoctorId = ownSubject ? ownSubject.doctorId : null;
    state.periods = periodsFromReports(state.reports, state.subjectDoctorId);
    state.periodKey = state.periods[0] ? state.periods[0].periodKey : null;
    state.pageType = state.periods[0] && state.periods[0].pageTypes.includes("doctor")
      ? "doctor" : (state.periods[0] && state.periods[0].pageTypes[0]) || "doctor";
    document.getElementById("viewerDoctorPin").value = "";
    document.getElementById("viewerDoctorName").textContent = doctor.displayName;
    document.getElementById("viewerDoctorStructure").textContent = [state.subjects.length > 1 ? "Заведующий отделением" : "", doctor.department, doctor.specialization].filter(Boolean).join(" · ");
    const subjectControl = document.getElementById("viewerSubjectControl");
    subjectControl.classList.toggle("hidden", state.subjects.length <= 1);
    document.getElementById("viewerSubject").innerHTML = state.subjects.map(subject =>
      `<option value="${esc(subject.doctorId)}">${esc(subject.displayName)}${subject.specialization ? ` · ${esc(subject.specialization)}` : ""}</option>`
    ).join("");
    document.getElementById("viewerSubject").value = state.subjectDoctorId || "";
    document.getElementById("viewerPeriod").innerHTML = state.periods.map(item =>
      `<option value="${esc(item.periodKey)}">${esc(monthLabel(item.periodKey))}</option>`).join("");
    document.getElementById("viewerLogin").classList.add("hidden");
    document.getElementById("viewerReport").classList.remove("hidden");
    showLoginError("");
    loadReport();
  } catch (error) {
    const failures = Number(state.failures.get(doctorId) || 0) + 1;
    if (failures >= 5) {
      state.failures.delete(doctorId);
      state.lockedUntil.set(doctorId, Date.now() + LOCK_MS);
      showLoginError("Вход врача заблокирован на 15 минут после пяти неверных PIN.");
    } else if (/слишком старый|не поддерживает|Формат шифрования|целостность/.test(String(error.message || ""))) {
      showLoginError(error.message);
    } else {
      state.failures.set(doctorId, failures);
      showLoginError(`Неверный PIN врача. Осталось попыток: ${5 - failures}.`);
    }
  } finally {
    button.disabled = false;
    button.textContent = "Открыть отчёты";
  }
}

function updatePeriodButtons() {
  const index = state.periods.findIndex(item => item.periodKey === state.periodKey);
  document.getElementById("btnPreviousPeriod").disabled = index < 0 || index >= state.periods.length - 1;
  document.getElementById("btnNextPeriod").disabled = index <= 0;
}

function loadReport() {
  const period = state.periods.find(item => item.periodKey === state.periodKey);
  if (!period) return;
  if (!period.pageTypes.includes(state.pageType)) {
    state.pageType = period.pageTypes.includes("doctor") ? "doctor" : period.pageTypes[0];
  }
  const labels = { doctor: state.subjectDoctorId === state.doctor.doctorId ? "Мой отчёт" : "Личный отчёт", specialization: "Специализация", department: "Отделение" };
  document.getElementById("viewerTabs").innerHTML = period.pageTypes.map(pageType =>
    `<button class="btn ${pageType === state.pageType ? "active" : ""}" data-page-type="${esc(pageType)}">${esc(labels[pageType] || pageType)}</button>`
  ).join("");
  document.querySelectorAll("[data-page-type]").forEach(button => button.addEventListener("click", () => {
    state.pageType = button.dataset.pageType;
    loadReport();
  }));
  const report = state.reports.find(item => String(item.doctorId) === String(state.subjectDoctorId)
    && item.periodKey === state.periodKey && item.pageType === state.pageType);
  document.getElementById("viewerReportBody").innerHTML = report && report.html
    ? report.html : '<div class="card"><p class="muted">Для этого периода страница не опубликована.</p></div>';
  document.getElementById("viewerPeriod").value = state.periodKey;
  updatePeriodButtons();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function changeSubject(doctorId) {
  const subject = state.subjects.find(item => String(item.doctorId) === String(doctorId));
  if (!subject) return;
  state.subjectDoctorId = subject.doctorId;
  state.periods = periodsFromReports(state.reports, state.subjectDoctorId);
  state.periodKey = state.periods[0] ? state.periods[0].periodKey : null;
  state.pageType = state.periods[0] && state.periods[0].pageTypes.includes("doctor")
    ? "doctor" : (state.periods[0]?.pageTypes[0] || "doctor");
  document.getElementById("viewerPeriod").innerHTML = state.periods.map(item =>
    `<option value="${esc(item.periodKey)}">${esc(monthLabel(item.periodKey))}</option>`).join("");
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
  state.doctor = null;
  state.subjects = [];
  state.subjectDoctorId = null;
  state.reports = [];
  state.periods = [];
  document.getElementById("viewerReportBody").innerHTML = "";
  document.getElementById("viewerReport").classList.add("hidden");
  document.getElementById("viewerLogin").classList.remove("hidden");
  document.getElementById("viewerDoctorPin").focus();
}

function initialize() {
  if (BUNDLE.format !== "pulse-clinic-standalone-viewer" || Number(BUNDLE.formatVersion) !== 2 || !Array.isArray(BUNDLE.doctors)) {
    showLoginError("Формат автономного Viewer не поддерживается.");
    document.getElementById("btnDoctorLogin").disabled = true;
    return;
  }
  document.getElementById("viewerPublicationCaption").textContent = `Сформировано ${new Date(BUNDLE.createdAt).toLocaleString("ru-RU")} · периодов: ${BUNDLE.periods.length}`;
  document.getElementById("viewerAppVersion").textContent = BUNDLE.appVersion
    ? `Версия отчётов ${BUNDLE.appVersion} · автономный файл`
    : "Автономный файл";
  document.getElementById("viewerDoctorSelect").innerHTML = BUNDLE.doctors.map(doctor =>
    `<option value="${esc(doctor.doctorId)}">${esc(doctor.displayName)}${doctor.department ? ` · ${esc(doctor.department)}` : ""}</option>`
  ).join("");
  document.getElementById("btnDoctorLogin").disabled = !BUNDLE.doctors.length;
  document.getElementById("btnDoctorLogin").addEventListener("click", loginDoctor);
  document.getElementById("viewerDoctorPin").addEventListener("keydown", event => { if (event.key === "Enter") loginDoctor(); });
  document.getElementById("btnDoctorLogout").addEventListener("click", logoutDoctor);
  document.getElementById("viewerPeriod").addEventListener("change", event => { state.periodKey = event.target.value; loadReport(); });
  document.getElementById("viewerSubject").addEventListener("change", event => changeSubject(event.target.value));
  document.getElementById("btnPreviousPeriod").addEventListener("click", () => changePeriod(1));
  document.getElementById("btnNextPeriod").addEventListener("click", () => changePeriod(-1));
  document.getElementById("btnPrintReport").addEventListener("click", () => window.print());
}

initialize();
