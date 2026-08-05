"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const JSZip = require("../../build/jszip.min.js");

const FORMAT = "pulse-clinic-viewer-package";
const FORMAT_VERSION = 1;
const MAX_PACKAGE_BYTES = 300 * 1024 * 1024;
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

async function createViewerPackage({ appVersion, doctors, periods, pages, credentials }) {
  if (!Array.isArray(doctors) || !doctors.length || doctors.length > 1000) throw new Error("Не выбраны врачи для публикации");
  if (!Array.isArray(periods) || !periods.length || periods.length > 120) throw new Error("Не выбраны периоды публикации");
  if (!Array.isArray(pages) || !pages.length || pages.length > 10000) throw new Error("В публикации нет страниц");
  if (!credentials || !credentials.admin || !Array.isArray(credentials.doctors)) throw new Error("Не настроены доступы Viewer");

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
      windowsAccount: String(access.windowsAccount || "").slice(0, 160),
      pinVersion: Number(access.pinVersion),
      access,
    });
  }

  const normalizedPages = pages.map(normalizePage);
  for (const page of normalizedPages) {
    if (!doctorMap.has(page.doctorId)) throw new Error("Страница относится к невыбранному врачу");
    if (!normalizedPeriods.includes(page.periodKey)) throw new Error("Страница относится к невыбранному периоду");
  }

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
    addJson(`${prefix}/profile.json`, {
      doctorId: doctor.doctorId,
      displayName: doctor.displayName,
      department: doctor.department,
      specialization: doctor.specialization,
      windowsAccount: doctor.windowsAccount,
    });
    addJson(`${prefix}/access.json`, {
      pinHash: doctor.access.pinHash,
      pinSalt: doctor.access.pinSalt,
      pinParams: doctor.access.pinParams,
      pinVersion: doctor.pinVersion,
    });
    const doctorPages = normalizedPages.filter(page => page.doctorId === doctor.doctorId);
    for (const page of doctorPages) {
      addJson(`${prefix}/reports/${page.periodKey}/${page.pageType}.json`, {
        packageId,
        createdAt,
        periodKey: page.periodKey,
        pageType: page.pageType,
        scopeId: page.scopeId,
        title: page.title,
        html: page.html,
      });
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
      windowsAccount: doctor.windowsAccount,
      pinVersion: doctor.pinVersion,
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

async function inspectViewerPackage(buffer, { includeZip = false } = {}) {
  const bytes = Buffer.from(buffer || []);
  if (!bytes.length || bytes.length > MAX_PACKAGE_BYTES || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error("Выбранный файл не является допустимым ZIP-пакетом Viewer");
  }
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
  const manifestEntry = zip.file("manifest.json");
  if (!manifestEntry) throw new Error("В архиве отсутствует manifest.json");
  const manifest = JSON.parse(await manifestEntry.async("string"));
  if (manifest.format !== FORMAT || Number(manifest.formatVersion) !== FORMAT_VERSION) {
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
    doctors: manifest.doctors.map(doctor => ({
      doctorId: String(doctor.doctorId),
      folderId: safeSegment(doctor.folderId, "каталог врача"),
      displayName: String(doctor.displayName || doctor.doctorId),
      department: String(doctor.department || ""),
      specialization: String(doctor.specialization || ""),
      windowsAccount: String(doctor.windowsAccount || ""),
      pinVersion: Number(doctor.pinVersion),
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
  MAX_PACKAGE_BYTES,
  createViewerPackage,
  inspectViewerPackage,
  sanitizeReportHtml,
  sha256,
};
