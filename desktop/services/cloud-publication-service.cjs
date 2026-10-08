"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const sanitizerPath = fs.existsSync(path.join(__dirname, "viewer-html-sanitizer.js"))
  ? "./viewer-html-sanitizer.js" : "../../build/viewer-html-sanitizer.js";
const { sanitizeReportHtml } = require(sanitizerPath);

const CLOUD_FORMAT = "klinvekt-cloud-publication";
const MAX_CLOUD_BYTES = 100 * 1024 * 1024;
// The external gateway limits one response to 4 MiB; leave room for its document shell.
const MAX_CLOUD_PAGE_BYTES = 4 * 1024 * 1024 - 4096;
const PAGE_KINDS = new Set(["clinic", "department", "specialization", "doctor"]);
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
    page.kind, page.periodKey, page.doctorId, page.department, page.specialization, page.title, page.html,
  ])).digest("hex");
}

// Unknown fields are rejected rather than carried into the cloud. HTML comes only
// from an aggregate dashboard snapshot, never from a portable database/Viewer file.
function validateCloudPublication(value) {
  object(value, ["format", "version", "createdAt", "appVersion", "security", "doctors", "pages", "accounts"], "публикация");
  if (value.format !== CLOUD_FORMAT || value.version !== 1) fail("формат/версия");
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
    object(account, ["userId", "doctorId", "admin", "departments", "specializations"], "доступ");
    if (!/^[1-9]\d{0,19}$/.test(text(account.userId, "ID Битрикса", 20))) fail("ID Битрикса");
    text(account.doctorId, "ID врача учётной записи", 240, true);
    if (account.doctorId && !ids.has(account.doctorId)) fail("неизвестный врач учётной записи");
    if (typeof account.admin !== "boolean") fail("роль администратора");
    for (const [key, known] of [["departments", departments], ["specializations", specializations]]) {
      list(account[key], key, 100).forEach(name => { text(name, key); if (!known.has(name)) fail(`неизвестная область ${key}`); });
      unique(account[key], key);
    }
  });
  unique(value.accounts.map(account => account.userId), "ID Битрикса");
  const pages = list(value.pages, "страницы", 50000);
  if (!pages.length) fail("нет отчётов");
  pages.forEach(page => {
    object(page, ["pageId", "kind", "periodKey", "doctorId", "department", "specialization", "title", "html"], "страница");
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
    text(page.html, "HTML отчёта", 8 * 1024 * 1024);
    if (Buffer.byteLength(page.html, "utf8") > MAX_CLOUD_PAGE_BYTES) fail(`отчёт «${page.title}» превышает предел страницы внешнего API (4 МиБ)`);
    if (/data-(?:viewer-patient|patient-search|patient-groups)|viewer-patient-(?:register|table)|clientSegment(?:Patients|Rows)|data-viewer-client-base/i.test(page.html)) fail("пациентский блок в HTML");
    if (sanitizeReportHtml(page.html) !== page.html) fail("неочищенный HTML");
    if (page.pageId !== pageId(page)) fail("контрольная сумма страницы");
  });
  unique(pages.map(page => page.pageId), "страницы");
  unique(pages.map(page => JSON.stringify([page.kind, page.periodKey, page.doctorId, page.department, page.specialization])), "области отчёта");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_CLOUD_BYTES) fail("пакет превышает 100 МБ");
  return value;
}

function createCloudPublication({ doctors, pages, accounts = [], appVersion }) {
  const publication = { format: CLOUD_FORMAT, version: 1, createdAt: new Date().toISOString(), appVersion,
    security: { patientRegistryIncluded: false, rawExportsIncluded: false }, doctors, accounts,
    pages: pages.map(page => { const cleaned = { ...page, html: sanitizeReportHtml(page.html) }; return { ...cleaned, pageId: pageId(cleaned) }; }),
  };
  return validateCloudPublication(publication);
}

function visibleCloudPages(publication, userId) {
  const account = publication.accounts.find(item => item.userId === String(userId));
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
module.exports = { CLOUD_FORMAT, MAX_CLOUD_BYTES, MAX_CLOUD_PAGE_BYTES, createCloudPublication, validateCloudPublication, visibleCloudPages, pageId, cloudAccountsFromSettings };
