"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const JSZip = require("../../build/jszip.min.js");

const FORMAT = "pulse-clinic-viewer-package";
const FORMAT_VERSION = 3;
const LEGACY_FORMAT_VERSION = 2;
const ENCRYPTED_PAGE_FORMAT = "pulse-clinic-viewer-encrypted-page";
const ENCRYPTED_PAGE_VERSION = 1;
const STANDALONE_FORMAT = "pulse-clinic-standalone-viewer";
const STANDALONE_FORMAT_VERSION = 2;
const CONTENT_KDF_PARAMS = Object.freeze({ N: 32768, r: 8, p: 1, keylen: 32 });
const STANDALONE_KDF_PARAMS = Object.freeze({ iterations: 600000, hash: "sha256", keylen: 32 });
const MAX_PACKAGE_BYTES = 300 * 1024 * 1024;
const MAX_STANDALONE_BYTES = 400 * 1024 * 1024;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const PAGE_TYPES = new Set(["department", "specialization", "doctor"]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeSegment(value, label) {
  const result = String(value || "");
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(result) || result === "." || result === "..") {
    throw new Error(`Некорректный ${label}`);
  }
  return result;
}

function sanitizeReportHtml(value) {
  let html = String(value || "");
  if (Buffer.byteLength(html, "utf8") > MAX_PAGE_BYTES) throw new Error("Одна страница отчёта превышает 8 МБ");
  html = html.replace(/<\s*(script|iframe|object|embed|form|meta|link|base)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  html = html.replace(/<\s*(script|iframe|object|embed|form|meta|link|base)\b[^>]*\/?\s*>/gi, "");
  html = html.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  html = html.replace(/\s(?:href|src)\s*=\s*(?:"\s*(?:javascript:|file:|https?:)[^"]*"|'\s*(?:javascript:|file:|https?:)[^']*'|(?:javascript:|file:|https?:)[^\s>]*)/gi, "");
  return html;
}

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value, null, 2), "utf8");
}

function encryptViewerPage(page, pin) {
  if (!/^\d{4}$/.test(String(pin || ""))) throw new Error("Для шифрования страницы не настроен PIN врача");
  const salt = crypto.randomBytes(24);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(String(pin), salt, CONTENT_KDF_PARAMS.keylen, {
    N: CONTENT_KDF_PARAMS.N,
    r: CONTENT_KDF_PARAMS.r,
    p: CONTENT_KDF_PARAMS.p,
    maxmem: 64 * 1024 * 1024,
  });
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(jsonBytes(page)), cipher.final()]);
  return {
    format: ENCRYPTED_PAGE_FORMAT,
    formatVersion: ENCRYPTED_PAGE_VERSION,
    periodKey: page.periodKey,
    pageType: page.pageType,
    doctorId: page.doctorId ? String(page.doctorId) : undefined,
    title: page.title,
    encryption: {
      algorithm: "aes-256-gcm",
      kdf: "scrypt",
      salt: salt.toString("base64"),
      params: CONTENT_KDF_PARAMS,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    },
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptViewerPage(record, pin) {
  try {
    if (!record || record.format !== ENCRYPTED_PAGE_FORMAT || Number(record.formatVersion) !== ENCRYPTED_PAGE_VERSION) {
      throw new Error("legacy-format");
    }
    const encryption = record.encryption || {};
    if (encryption.algorithm !== "aes-256-gcm" || encryption.kdf !== "scrypt") throw new Error("unsupported-encryption");
    const params = encryption.params || {};
    const salt = Buffer.from(encryption.salt, "base64");
    const key = crypto.scryptSync(String(pin || ""), salt, Number(params.keylen), {
      N: Number(params.N), r: Number(params.r), p: Number(params.p), maxmem: 64 * 1024 * 1024,
    });
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(encryption.iv, "base64"));
    decipher.setAuthTag(Buffer.from(encryption.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]);
    const page = JSON.parse(plaintext.toString("utf8"));
    if (String(page.periodKey) !== String(record.periodKey) || String(page.pageType) !== String(record.pageType)
      || (record.doctorId && String(page.doctorId) !== String(record.doctorId))) {
      throw new Error("metadata-mismatch");
    }
    return page;
  } catch (error) {
    if (error && error.message === "legacy-format") {
      throw new Error("Отчёт создан без PIN-шифрования. Сформируйте и импортируйте новый ZIP");
    }
    throw new Error("Не удалось расшифровать отчёт. Проверьте PIN и целостность публикации");
  }
}

function normalizePage(page) {
  if (!page || typeof page !== "object") throw new Error("Некорректная страница публикации");
  const doctorId = String(page.doctorId || "");
  const periodKey = String(page.periodKey || "");
  const pageType = String(page.pageType || "");
  if (!doctorId) throw new Error("В странице не указан врач");
  if (!/^\d{4}-\d{2}$/.test(periodKey)) throw new Error("Некорректный период страницы");
  if (!PAGE_TYPES.has(pageType)) throw new Error("Некорректный тип страницы");
  return {
    doctorId,
    periodKey,
    pageType,
    scopeId: String(page.scopeId || "").slice(0, 240),
    title: String(page.title || "Отчёт").slice(0, 300),
    html: sanitizeReportHtml(page.html),
  };
}

function prepareViewerPublication({ doctors, subjects = doctors, periods, pages, credentials }) {
  if (!Array.isArray(doctors) || !doctors.length || doctors.length > 1000) throw new Error("Не выбраны врачи для публикации");
  if (!Array.isArray(subjects) || !subjects.length || subjects.length > 1000) throw new Error("Не выбраны врачи для отчётов");
  if (!Array.isArray(periods) || !periods.length || periods.length > 120) throw new Error("Не выбраны периоды публикации");
  if (!Array.isArray(pages) || !pages.length || pages.length > 10000) throw new Error("В публикации нет страниц");
  if (!credentials || !Array.isArray(credentials.doctors)) throw new Error("Не настроены доступы Viewer");

  const normalizedPeriods = [...new Set(periods.map(String))].sort();
  if (normalizedPeriods.some(value => !/^\d{4}-\d{2}$/.test(value))) throw new Error("Некорректный период публикации");
  const credentialMap = new Map(credentials.doctors.map(item => [String(item.doctorId), item]));
  const doctorMap = new Map();
  for (const doctor of doctors) {
    const doctorId = String(doctor.doctorId || "");
    if (!doctorId || doctorMap.has(doctorId)) throw new Error("Некорректный список врачей");
    const access = credentialMap.get(doctorId);
    if (!access) throw new Error(`Нет доступа Viewer для врача ${doctorId}`);
    const folderId = sha256(doctorId).slice(0, 24);
    doctorMap.set(doctorId, {
      doctorId,
      folderId,
      displayName: String(doctor.displayName || doctorId).slice(0, 240),
      department: String(doctor.department || "").slice(0, 240),
      specialization: String(doctor.specialization || "").slice(0, 240),
      pinVersion: Number(access.pinVersion),
      managedDepartments: [...new Set((access.headDepartments || []).map(String).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru")),
      access,
    });
  }

  const subjectMap = new Map();
  for (const subject of subjects) {
    const doctorId = String(subject.doctorId || "");
    if (!doctorId || subjectMap.has(doctorId)) throw new Error("Некорректный список врачей для отчётов");
    subjectMap.set(doctorId, {
      doctorId,
      folderId: sha256(doctorId).slice(0, 24),
      displayName: String(subject.displayName || doctorId).slice(0, 240),
      department: String(subject.department || "").slice(0, 240),
      specialization: String(subject.specialization || "").slice(0, 240),
    });
  }
  for (const doctor of doctorMap.values()) {
    if (!subjectMap.has(doctor.doctorId)) throw new Error(`Для врача ${doctor.displayName} отсутствует личный отчёт`);
    const managed = new Set(doctor.managedDepartments);
    doctor.visibleDoctorIds = [...subjectMap.values()]
      .filter(subject => subject.doctorId === doctor.doctorId || managed.has(subject.department))
      .map(subject => subject.doctorId);
  }

  const normalizedPages = pages.map(normalizePage);
  for (const page of normalizedPages) {
    if (!subjectMap.has(page.doctorId)) throw new Error("Страница относится к невыбранному врачу");
    if (!normalizedPeriods.includes(page.periodKey)) throw new Error("Страница относится к невыбранному периоду");
  }

  return { normalizedPeriods, normalizedPages, doctorMap, subjectMap };
}

async function createViewerPackage(input) {
  const { appVersion, credentials } = input;
  const { normalizedPeriods, normalizedPages, doctorMap, subjectMap } = prepareViewerPublication(input);
  if (!credentials.admin) throw new Error("Сначала задайте администраторский PIN Viewer");

  const packageId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const zip = new JSZip();
  const fileHashes = {};
  const addJson = (filePath, value) => {
    const bytes = jsonBytes(value);
    fileHashes[filePath] = sha256(bytes);
    zip.file(filePath, bytes);
  };

  for (const doctor of doctorMap.values()) {
    const prefix = `doctors/${doctor.folderId}`;
    if (!/^\d{4}$/.test(String(doctor.access.pinCode || ""))) throw new Error(`Не настроен PIN Viewer для врача ${doctor.displayName}`);
    addJson(`${prefix}/profile.json`, {
      doctorId: doctor.doctorId,
      displayName: doctor.displayName,
      department: doctor.department,
      specialization: doctor.specialization,
      managedDepartments: doctor.managedDepartments,
      visibleDoctorIds: doctor.visibleDoctorIds,
    });
    addJson(`${prefix}/access.json`, {
      pinHash: doctor.access.pinHash,
      pinSalt: doctor.access.pinSalt,
      pinParams: doctor.access.pinParams,
      pinVersion: doctor.pinVersion,
    });
    const doctorPages = normalizedPages.filter(page => doctor.visibleDoctorIds.includes(page.doctorId));
    for (const page of doctorPages) {
      const subject = subjectMap.get(page.doctorId);
      const report = {
        packageId,
        createdAt,
        doctorId: page.doctorId,
        periodKey: page.periodKey,
        pageType: page.pageType,
        scopeId: page.scopeId,
        title: page.title,
        html: page.html,
      };
      addJson(`${prefix}/subjects/${subject.folderId}/reports/${page.periodKey}/${page.pageType}.json`, encryptViewerPage(report, doctor.access.pinCode));
    }
  }

  const manifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    packageId,
    createdAt,
    appVersion: String(appVersion || ""),
    periods: normalizedPeriods,
    pageTypes: [...new Set(normalizedPages.map(page => page.pageType))].sort(),
    doctors: [...doctorMap.values()].map(doctor => ({
      doctorId: doctor.doctorId,
      folderId: doctor.folderId,
      displayName: doctor.displayName,
      department: doctor.department,
      specialization: doctor.specialization,
      pinVersion: doctor.pinVersion,
      managedDepartments: doctor.managedDepartments,
      visibleDoctorIds: doctor.visibleDoctorIds,
    })),
    subjects: [...subjectMap.values()].map(subject => ({
      doctorId: subject.doctorId,
      folderId: subject.folderId,
      displayName: subject.displayName,
      department: subject.department,
      specialization: subject.specialization,
    })),
    adminAccess: {
      pinHash: credentials.admin.pinHash,
      pinSalt: credentials.admin.pinSalt,
      pinParams: credentials.admin.pinParams,
      pinVersion: Number(credentials.admin.pinVersion),
    },
    files: fileHashes,
  };
  zip.file("manifest.json", jsonBytes(manifest));
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  if (buffer.length > MAX_PACKAGE_BYTES) throw new Error("Архив публикации превышает 300 МБ");
  return { buffer, manifest, sha256: sha256(buffer) };
}

function encryptStandaloneDoctorPayload(payload, pin) {
  if (!/^\d{4}$/.test(String(pin || ""))) throw new Error("Для автономного Viewer не настроен PIN врача");
  const salt = crypto.randomBytes(24);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(String(pin), salt, STANDALONE_KDF_PARAMS.iterations,
    STANDALONE_KDF_PARAMS.keylen, STANDALONE_KDF_PARAMS.hash);
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(payload), "utf8"), { level: 9 });
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return {
    encryption: {
      algorithm: "aes-256-gcm",
      kdf: "pbkdf2",
      hash: "sha-256",
      iterations: STANDALONE_KDF_PARAMS.iterations,
      keyLength: STANDALONE_KDF_PARAMS.keylen * 8,
      compression: "gzip",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    },
    ciphertext: ciphertext.toString("base64"),
  };
}

function standaloneAsset(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, "../..", relativePath), "utf8");
}

function jsonForInlineScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

async function createStandaloneViewerHtml(input) {
  const { appVersion } = input;
  const { normalizedPeriods, normalizedPages, doctorMap, subjectMap } = prepareViewerPublication(input);
  const packageId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const encryptedDoctors = [];

  for (const doctor of doctorMap.values()) {
    const reports = normalizedPages
      .filter(page => doctor.visibleDoctorIds.includes(page.doctorId))
      .map(page => ({
        doctorId: page.doctorId,
        periodKey: page.periodKey,
        pageType: page.pageType,
        scopeId: page.scopeId,
        title: page.title,
        html: page.html,
      }));
    if (!reports.length) throw new Error(`Для врача ${doctor.displayName} нет выбранных страниц`);
    const encrypted = encryptStandaloneDoctorPayload({
      format: STANDALONE_FORMAT,
      formatVersion: STANDALONE_FORMAT_VERSION,
      packageId,
      doctorId: doctor.doctorId,
      subjects: doctor.visibleDoctorIds.map(doctorId => subjectMap.get(doctorId)),
      reports,
    }, doctor.access.pinCode);
    encryptedDoctors.push({
      doctorId: doctor.doctorId,
      displayName: doctor.displayName,
      department: doctor.department,
      specialization: doctor.specialization,
      pinVersion: doctor.pinVersion,
      managedDepartments: doctor.managedDepartments,
      visibleDoctorIds: doctor.visibleDoctorIds,
      periods: [...new Set(reports.map(report => report.periodKey))].sort().reverse(),
      pageTypes: [...new Set(reports.map(report => report.pageType))].sort(),
      ...encrypted,
    });
  }

  const manifest = {
    format: STANDALONE_FORMAT,
    formatVersion: STANDALONE_FORMAT_VERSION,
    packageId,
    createdAt,
    appVersion: String(appVersion || ""),
    periods: normalizedPeriods,
    pageTypes: [...new Set(normalizedPages.map(page => page.pageType))].sort(),
    subjects: [...subjectMap.values()],
    doctors: encryptedDoctors.map(({ encryption, ciphertext, ...doctor }) => doctor),
  };
  const bundle = { ...manifest, doctors: encryptedDoctors };
  const template = standaloneAsset("viewer/standalone.html");
  const html = template
    .replace("/*__APP_CSS__*/", standaloneAsset("build/app.css"))
    .replace("/*__VIEWER_CSS__*/", standaloneAsset("viewer/viewer.css"))
    .replace("/*__STANDALONE_DATA__*/", jsonForInlineScript(bundle))
    .replace("/*__STANDALONE_APP__*/", standaloneAsset("viewer/standalone-app.js"));
  if (/\/\*__[A-Z0-9_]+__\*\//.test(html)) throw new Error("Не удалось собрать автономный HTML Viewer");
  const buffer = Buffer.from(html, "utf8");
  if (buffer.length > MAX_STANDALONE_BYTES) throw new Error("Автономный HTML Viewer превышает 400 МБ");
  return { buffer, manifest, sha256: sha256(buffer) };
}

async function inspectViewerPackage(buffer, { includeZip = false } = {}) {
  const bytes = Buffer.from(buffer || []);
  if (!bytes.length || bytes.length > MAX_PACKAGE_BYTES || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error("Выбранный файл не является допустимым ZIP-пакетом Viewer");
  }
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
  const manifestEntry = zip.file("manifest.json");
  if (!manifestEntry) throw new Error("В архиве отсутствует manifest.json");
  const manifest = JSON.parse(await manifestEntry.async("string"));
  const formatVersion = Number(manifest.formatVersion);
  if (manifest.format !== FORMAT || ![LEGACY_FORMAT_VERSION, FORMAT_VERSION].includes(formatVersion)) {
    throw new Error("Формат архива Viewer не поддерживается");
  }
  safeSegment(manifest.packageId, "идентификатор пакета");
  if (!Array.isArray(manifest.doctors) || !manifest.doctors.length || !Array.isArray(manifest.periods) || !manifest.periods.length) {
    throw new Error("Manifest архива неполон");
  }
  for (const [filePath, expectedHash] of Object.entries(manifest.files || {})) {
    if (path.posix.normalize(filePath) !== filePath || filePath.startsWith("/") || filePath.includes("../")) {
      throw new Error("Архив содержит небезопасный путь");
    }
    const entry = zip.file(filePath);
    if (!entry) throw new Error(`В архиве отсутствует файл ${filePath}`);
    const entryBytes = await entry.async("nodebuffer");
    if (sha256(entryBytes) !== expectedHash) throw new Error(`Нарушена целостность файла ${filePath}`);
  }
  const preview = {
    packageId: manifest.packageId,
    createdAt: manifest.createdAt,
    appVersion: manifest.appVersion,
    formatVersion,
    doctors: manifest.doctors.map(doctor => ({
      doctorId: String(doctor.doctorId),
      folderId: safeSegment(doctor.folderId, "каталог врача"),
      displayName: String(doctor.displayName || doctor.doctorId),
      department: String(doctor.department || ""),
      specialization: String(doctor.specialization || ""),
      pinVersion: Number(doctor.pinVersion),
      managedDepartments: Array.isArray(doctor.managedDepartments) ? doctor.managedDepartments.map(String) : [],
      visibleDoctorIds: Array.isArray(doctor.visibleDoctorIds) ? doctor.visibleDoctorIds.map(String) : [String(doctor.doctorId)],
    })),
    subjects: (Array.isArray(manifest.subjects) ? manifest.subjects : manifest.doctors).map(doctor => ({
      doctorId: String(doctor.doctorId),
      folderId: safeSegment(doctor.folderId, "каталог врача"),
      displayName: String(doctor.displayName || doctor.doctorId),
      department: String(doctor.department || ""),
      specialization: String(doctor.specialization || ""),
    })),
    periods: manifest.periods.map(String),
    pageTypes: Array.isArray(manifest.pageTypes) ? manifest.pageTypes.map(String) : [],
    sha256: sha256(bytes),
  };
  return includeZip ? { manifest, preview, zip } : { manifest, preview };
}

module.exports = {
  FORMAT,
  FORMAT_VERSION,
  ENCRYPTED_PAGE_FORMAT,
  STANDALONE_FORMAT,
  STANDALONE_FORMAT_VERSION,
  MAX_PACKAGE_BYTES,
  createStandaloneViewerHtml,
  createViewerPackage,
  decryptViewerPage,
  encryptViewerPage,
  inspectViewerPackage,
  sanitizeReportHtml,
  sha256,
};
