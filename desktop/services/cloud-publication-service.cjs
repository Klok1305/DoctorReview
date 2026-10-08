"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const sanitizerPath = fs.existsSync(path.join(__dirname, "viewer-html-sanitizer.js"))
  ? "./viewer-html-sanitizer.js" : "../../build/viewer-html-sanitizer.js";
const { sanitizeReportHtml } = require(sanitizerPath);
const { validateCloudReport } = require("./cloud-report-model.cjs");

const CLOUD_FORMAT = "klinvekt-cloud-publication";
const MAX_CLOUD_BYTES = 100 * 1024 * 1024;
// The external gateway limits one response to 4 MiB; leave room for its document shell.
const MAX_CLOUD_PAGE_BYTES = 4 * 1024 * 1024 - 4096;
const PAGE_KINDS = new Set(["clinic", "department", "specialization", "doctor"]);
const PIN_PARAMS = Object.freeze({ N: 32768, r: 8, p: 1, keylen: 64 });
const fail = message => { throw new Error(`Некорректная облачная публикация: ${message}`); };
function object(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(label);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`неразрешённое поле ${label}.${key}`);
  return value;
}
function text(value, label, max = 240, empty = false) {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max) fail(label);
  return value;
}
function list(value, label, max = 1000) {
  if (!Array.isArray(value) || value.length > max) fail(label);
  return value;
}
function unique(values, label) {
  if (new Set(values).size !== values.length) fail(`повтор ${label}`);
}
function pageId(page) {
  return crypto.createHash("sha256").update(JSON.stringify([
    page.kind, page.periodKey, page.doctorId, page.department, page.specialization, page.title, page.report || page.html,
  ])).digest("hex");
}

// Unknown fields are rejected rather than carried into the cloud. HTML comes only
// from an aggregate dashboard snapshot, never from a portable database/Viewer file.
function validateCloudPublication(value) {
  object(value, ["format", "version", "createdAt", "appVersion", "security", "doctors", "pages", "accounts"], "публикация");
  if (value.format !== CLOUD_FORMAT || ![1, 2, 3].includes(value.version)) fail("формат/версия");
  text(value.createdAt, "дата", 50);
  if (!Number.isFinite(Date.parse(value.createdAt))) fail("дата");
  text(value.appVersion, "версия приложения", 50);
  object(value.security, ["patientRegistryIncluded", "rawExportsIncluded"], "безопасность");
  if (value.security.patientRegistryIncluded !== false || value.security.rawExportsIncluded !== false) fail("реестр пациентов/исходники");
  const doctors = list(value.doctors, "врачи");
  doctors.forEach(doctor => {
    object(doctor, ["doctorId", "displayName", "department", "specialization"], "врач");
    text(doctor.doctorId, "ID врача"); text(doctor.displayName, "ФИО врача");
    text(doctor.department, "отделение врача", 240, true); text(doctor.specialization, "специализация врача", 240, true);
  });
  unique(doctors.map(doctor => doctor.doctorId), "врача");
  const ids = new Set(doctors.map(doctor => doctor.doctorId));
  const departments = new Set(doctors.map(doctor => doctor.department).filter(Boolean));
  const specializations = new Set(doctors.map(doctor => doctor.specialization).filter(Boolean));
  list(value.accounts, "учётные записи").forEach(account => {
    object(account, value.version === 1 ? ["userId", "doctorId", "admin", "departments", "specializations"]
      : ["accountId", "displayName", "doctorId", "admin", "departments", "specializations", "pinHash", "pinSalt", "pinParams"], "доступ");
    if (value.version === 1) {
      if (!/^[1-9]\d{0,19}$/.test(text(account.userId, "ID Битрикса", 20))) fail("ID Битрикса");
    } else {
      text(account.accountId, "учётная запись"); text(account.displayName, "имя учётной записи");
      for (const [key, bytes] of [["pinHash", 64], ["pinSalt", 24]]) {
        text(account[key], key, 100);
        const decoded = Buffer.from(account[key], "base64");
        if (decoded.length !== bytes || decoded.toString("base64") !== account[key]) fail(key);
      }
      object(account.pinParams, Object.keys(PIN_PARAMS), "параметры PIN");
      if (Object.entries(PIN_PARAMS).some(([key, expected]) => account.pinParams[key] !== expected)) fail("параметры PIN");
    }
    text(account.doctorId, "ID врача учётной записи", 240, true);
    if (account.doctorId && !ids.has(account.doctorId)) fail("неизвестный врач учётной записи");
    if (typeof account.admin !== "boolean") fail("роль администратора");
    if (value.version >= 2 && (account.admin ? account.doctorId !== "" || account.accountId !== "admin"
      : !account.doctorId || account.accountId !== `doctor:${account.doctorId}`)) fail("область учётной записи PIN");
    for (const [key, known] of [["departments", departments], ["specializations", specializations]]) {
      list(account[key], key, 100).forEach(name => { text(name, key); if (!known.has(name)) fail(`неизвестная область ${key}`); });
      unique(account[key], key);
    }
  });
  unique(value.accounts.map(account => value.version === 1 ? account.userId : account.accountId), "учётной записи");
  if (value.version >= 2 && value.accounts.filter(account => account.admin).length !== 1) fail("нужен администраторский PIN Viewer");
  const pages = list(value.pages, "страницы", 50000);
  if (!pages.length) fail("нет отчётов");
  pages.forEach(page => {
    object(page, ["pageId", "kind", "periodKey", "doctorId", "department", "specialization", "title", value.version === 3 ? "report" : "html"], "страница");
    if (!PAGE_KINDS.has(page.kind)) fail("тип страницы");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(page.periodKey)) fail("период");
    text(page.doctorId, "врач страницы", 240, true);
    text(page.department, "отделение страницы", 240, true); text(page.specialization, "специализация страницы", 240, true);
    if (page.kind === "doctor") {
      const doctor = doctors.find(item => item.doctorId === page.doctorId);
      if (!doctor || doctor.department !== page.department || doctor.specialization !== page.specialization) fail("область личного отчёта");
    } else if (page.doctorId) fail("врач сводного отчёта");
    if (page.kind === "clinic" && (page.department || page.specialization)) fail("область клиники");
    if (page.kind === "department" && (!departments.has(page.department) || page.specialization)) fail("область отделения");
    if (page.kind === "specialization" && (!specializations.has(page.specialization) || page.department)) fail("область специализации");
    text(page.title, "название отчёта", 600);
    if (value.version === 3) {
      validateCloudReport(page.report, page);
      if (Buffer.byteLength(JSON.stringify(page.report), "utf8") > MAX_CLOUD_PAGE_BYTES) fail("JSON отчёта превышает 4 МиБ");
    } else {
    text(page.html, "HTML отчёта", 8 * 1024 * 1024);
    if (Buffer.byteLength(page.html, "utf8") > MAX_CLOUD_PAGE_BYTES) fail(`отчёт «${page.title}» превышает предел страницы внешнего API (4 МиБ)`);
    if (/data-(?:viewer-patient|patient-search|patient-groups)|viewer-patient-(?:register|table)|clientSegment(?:Patients|Rows)|data-viewer-client-base/i.test(page.html)) fail("пациентский блок в HTML");
    if (sanitizeReportHtml(page.html) !== page.html) fail("неочищенный HTML");
    }
    if (page.pageId !== pageId(page)) fail("контрольная сумма страницы");
  });
  unique(pages.map(page => page.pageId), "страницы");
  unique(pages.map(page => JSON.stringify([page.kind, page.periodKey, page.doctorId, page.department, page.specialization])), "области отчёта");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_CLOUD_BYTES) fail("пакет превышает 100 МБ");
  return value;
}

function createCloudPublication({ doctors, pages, accounts = [], appVersion, version = 1 }) {
  const publication = { format: CLOUD_FORMAT, version, createdAt: new Date().toISOString(), appVersion,
    security: { patientRegistryIncluded: false, rawExportsIncluded: false }, doctors, accounts,
    pages: pages.map(page => { const cleaned = version === 3 ? { ...page } : { ...page, html: sanitizeReportHtml(page.html) }; return { ...cleaned, pageId: pageId(cleaned) }; }),
  };
  return validateCloudPublication(publication);
}

function visibleCloudPages(publication, accountId) {
  const account = publication.accounts.find(item => (publication.version === 1 ? item.userId : item.accountId) === String(accountId));
  if (!account) return [];
  if (account.admin) return publication.pages;
  const managed = new Set(account.departments);
  const specializations = new Set(account.specializations);
  // Specializations are unique in the Admin structure. A department head gets
  // its specialization summaries; a specialization head gets the summary + self.
  for (const doctor of publication.doctors) if (managed.has(doctor.department) && doctor.specialization) specializations.add(doctor.specialization);
  return publication.pages.filter(page => {
    if (page.kind === "doctor") return page.doctorId === account.doctorId || managed.has(page.department);
    if (page.kind === "department") return managed.has(page.department);
    if (page.kind === "specialization") return specializations.has(page.specialization);
    return false;
  });
}

// Credentials and department appointments come from SQLite, not renderer input.
// Export only existing verifiers; never include the plaintext pinCode.
function cloudAccountsFromViewer(doctors, settings, credentials) {
  if (!credentials.admin) fail("сначала задайте администраторский PIN Viewer");
  const verifier = item => ({ pinHash: item.pinHash, pinSalt: item.pinSalt,
    pinParams: typeof item.pinParams === "string" ? JSON.parse(item.pinParams) : item.pinParams });
  const heads = new Set(settings.cloudSpecializationHeadDoctorIds || []);
  return [{ accountId: "admin", displayName: "Администратор", doctorId: "", admin: true,
    departments: [], specializations: [], ...verifier(credentials.admin) }, ...credentials.doctors.map(item => {
    const doctor = doctors.find(doctor => doctor.doctorId === item.doctorId);
    if (!doctor) fail("неизвестный врач PIN");
    return { accountId: `doctor:${doctor.doctorId}`, displayName: doctor.displayName, doctorId: doctor.doctorId, admin: false,
      departments: item.headDepartments || [], specializations: heads.has(doctor.doctorId) && doctor.specialization ? [doctor.specialization] : [],
      ...verifier(item) };
  })];
}

function cloudAccountsFromSettings(doctors, settings, departmentHeads) {
  const accounts = new Map();
  const heads = new Set(settings.cloudSpecializationHeadDoctorIds || []);
  for (const doctor of doctors) {
    const userId = String(settings.cloudDoctorUserIds?.[doctor.doctorId] || "").trim();
    if (!userId) continue;
    if (accounts.has(userId)) fail("один ID Битрикса назначен нескольким врачам");
    accounts.set(userId, { userId, doctorId: doctor.doctorId, admin: false,
      departments: Object.entries(departmentHeads || {}).filter(([, id]) => String(id) === doctor.doctorId).map(([name]) => name),
      specializations: heads.has(doctor.doctorId) && doctor.specialization ? [doctor.specialization] : [] });
  }
  for (const id of settings.cloudAdminUserIds || []) {
    const userId = String(id).trim();
    if (!accounts.has(userId)) accounts.set(userId, { userId, doctorId: "", admin: true, departments: [], specializations: [] });
    else accounts.get(userId).admin = true;
  }
  return [...accounts.values()];
}
module.exports = { CLOUD_FORMAT, MAX_CLOUD_BYTES, MAX_CLOUD_PAGE_BYTES, PIN_PARAMS, createCloudPublication, validateCloudPublication, visibleCloudPages, pageId, cloudAccountsFromSettings, cloudAccountsFromViewer };
