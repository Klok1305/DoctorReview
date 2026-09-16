"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const JSZip = require("../../build/jszip.min.js");
const { sanitizeReportHtml } = require("../../build/viewer-html-sanitizer.js");

const FORMAT = "pulse-clinic-viewer-package";
const FORMAT_VERSION = 4;
const LEGACY_FORMAT_VERSION = 2;
const LEGACY_FORMAT_VERSIONS = Object.freeze([2, 3]);
const ENCRYPTED_PAGE_FORMAT = "pulse-clinic-viewer-encrypted-page";
const ENCRYPTED_PAGE_VERSION = 1;
const SHARED_PAGE_FORMAT = "pulse-clinic-viewer-shared-page";
const SHARED_PAGE_VERSION = 1;
const ENCRYPTED_GRANT_FORMAT = "pulse-clinic-viewer-encrypted-grant";
const ENCRYPTED_GRANT_VERSION = 1;
const REPORT_MODEL_FORMAT = "klinvekt-report-model";
const REPORT_MODEL_VERSION = 1;
const STANDALONE_FORMAT = "pulse-clinic-standalone-viewer";
const STANDALONE_FORMAT_VERSION = 4;
const LEGACY_STANDALONE_FORMAT_VERSION = 2;
const LEGACY_STANDALONE_FORMAT_VERSIONS = Object.freeze([2, 3]);
const CONTENT_KDF_PARAMS = Object.freeze({ N: 32768, r: 8, p: 1, keylen: 32 });
const STANDALONE_KDF_PARAMS = Object.freeze({ iterations: 600000, hash: "sha256", keylen: 32 });
const MAX_PACKAGE_BYTES = 300 * 1024 * 1024;
const MAX_STANDALONE_BYTES = 400 * 1024 * 1024;
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

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value, null, 2), "utf8");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function reportModelRevisionPayload(model) {
  return {
    format: REPORT_MODEL_FORMAT,
    formatVersion: REPORT_MODEL_VERSION,
    periods: model.periods,
    pages: model.pages,
    bindings: model.bindings,
  };
}

function contentRevision(model) {
  return sha256(Buffer.from(JSON.stringify(reportModelRevisionPayload(model)), "utf8"));
}

function normalizeBinding(binding) {
  if (!binding || typeof binding !== "object") throw new Error("Некорректная привязка страницы отчёта");
  const doctorId = String(binding.doctorId || binding.subjectDoctorId || "");
  const pageId = safeSegment(binding.pageId, "идентификатор страницы");
  const periodKey = String(binding.periodKey || "");
  const pageType = String(binding.pageType || "");
  if (!doctorId) throw new Error("В привязке страницы не указан врач");
  if (!/^\d{4}-\d{2}$/.test(periodKey)) throw new Error("Некорректный период привязки страницы");
  if (!PAGE_TYPES.has(pageType)) throw new Error("Некорректный тип привязки страницы");
  return { doctorId, periodKey, pageType, pageId };
}

function reportModelFromLegacyPages(periods, pages, requestedRevision = "") {
  const uniquePages = new Map();
  const bindings = [];
  const bindingKeys = new Set();
  for (const rawPage of pages) {
    const page = normalizePage(rawPage);
    const content = {
      periodKey: page.periodKey,
      pageType: page.pageType,
      scopeId: page.scopeId,
      title: page.title,
      html: page.html,
    };
    const pageId = sha256(Buffer.from(JSON.stringify(content), "utf8"));
    if (!uniquePages.has(pageId)) uniquePages.set(pageId, { pageId, ...content });
    const bindingKey = `${page.doctorId}\u0000${page.periodKey}\u0000${page.pageType}`;
    const previous = bindings.find(binding => `${binding.doctorId}\u0000${binding.periodKey}\u0000${binding.pageType}` === bindingKey);
    if (previous && previous.pageId !== pageId) throw new Error("Для одной страницы врача передано несколько разных вариантов");
    if (!bindingKeys.has(bindingKey)) {
      bindingKeys.add(bindingKey);
      bindings.push({ doctorId: page.doctorId, periodKey: page.periodKey, pageType: page.pageType, pageId });
    }
  }
  const model = {
    format: REPORT_MODEL_FORMAT,
    formatVersion: REPORT_MODEL_VERSION,
    revision: String(requestedRevision || ""),
    periods: [...periods],
    pages: [...uniquePages.values()].sort((a, b) => a.pageId.localeCompare(b.pageId)),
    bindings: bindings.sort((a, b) => `${a.doctorId}\u0000${a.periodKey}\u0000${a.pageType}`.localeCompare(`${b.doctorId}\u0000${b.periodKey}\u0000${b.pageType}`)),
  };
  if (!/^[a-f0-9]{64}$/.test(model.revision)) model.revision = contentRevision(model);
  return deepFreeze(model);
}

function normalizeReportModel(reportModel, periods) {
  if (!reportModel || typeof reportModel !== "object") throw new Error("Некорректная модель отчёта");
  if (reportModel.format !== REPORT_MODEL_FORMAT || Number(reportModel.formatVersion) !== REPORT_MODEL_VERSION) {
    throw new Error("Формат модели отчёта не поддерживается");
  }
  const pages = new Map();
  for (const rawPage of reportModel.pages || []) {
    const pageId = safeSegment(rawPage.pageId, "идентификатор страницы");
    if (pages.has(pageId)) throw new Error("В модели повторяется идентификатор страницы");
    const periodKey = String(rawPage.periodKey || "");
    const pageType = String(rawPage.pageType || "");
    if (!periods.includes(periodKey) || !PAGE_TYPES.has(pageType)) throw new Error("Некорректная страница модели отчёта");
    const normalizedPage = {
      pageId,
      periodKey,
      pageType,
      scopeId: String(rawPage.scopeId || "").slice(0, 240),
      title: String(rawPage.title || "Отчёт").slice(0, 300),
      html: sanitizeReportHtml(rawPage.html),
    };
    const expectedPageId = sha256(Buffer.from(JSON.stringify({
      periodKey: normalizedPage.periodKey,
      pageType: normalizedPage.pageType,
      scopeId: normalizedPage.scopeId,
      title: normalizedPage.title,
      html: normalizedPage.html,
    }), "utf8"));
    if (pageId !== expectedPageId) throw new Error("Содержимое страницы не соответствует её идентификатору");
    pages.set(pageId, normalizedPage);
  }
  if (!pages.size || pages.size > 10000) throw new Error("В модели отчёта нет страниц");
  const bindings = [];
  const bindingKeys = new Set();
  for (const rawBinding of reportModel.bindings || []) {
    const binding = normalizeBinding(rawBinding);
    const page = pages.get(binding.pageId);
    if (!page || page.periodKey !== binding.periodKey || page.pageType !== binding.pageType) {
      throw new Error("Привязка не соответствует странице модели отчёта");
    }
    const bindingKey = `${binding.doctorId}\u0000${binding.periodKey}\u0000${binding.pageType}`;
    if (bindingKeys.has(bindingKey)) throw new Error("В модели повторяется привязка страницы врача");
    bindingKeys.add(bindingKey);
    bindings.push(binding);
  }
  if (!bindings.length || bindings.length > 10000) throw new Error("В модели отчёта нет привязок страниц");
  const normalized = {
    format: REPORT_MODEL_FORMAT,
    formatVersion: REPORT_MODEL_VERSION,
    revision: String(reportModel.revision || ""),
    periods: [...periods],
    pages: [...pages.values()].sort((a, b) => a.pageId.localeCompare(b.pageId)),
    bindings: bindings.sort((a, b) => `${a.doctorId}\u0000${a.periodKey}\u0000${a.pageType}`.localeCompare(`${b.doctorId}\u0000${b.periodKey}\u0000${b.pageType}`)),
  };
  const expectedRevision = contentRevision(normalized);
  if (normalized.revision && normalized.revision !== expectedRevision) throw new Error("Модель отчёта изменилась после фиксации ревизии");
  normalized.revision = expectedRevision;
  return deepFreeze(normalized);
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

function encryptViewerGrant(payload, pin) {
  if (!/^\d{4}$/.test(String(pin || ""))) throw new Error("Для выдачи ключей не настроен PIN врача");
  const salt = crypto.randomBytes(24);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(String(pin), salt, CONTENT_KDF_PARAMS.keylen, {
    N: CONTENT_KDF_PARAMS.N,
    r: CONTENT_KDF_PARAMS.r,
    p: CONTENT_KDF_PARAMS.p,
    maxmem: 64 * 1024 * 1024,
  });
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(jsonBytes(payload)), cipher.final()]);
  return {
    format: ENCRYPTED_GRANT_FORMAT,
    formatVersion: ENCRYPTED_GRANT_VERSION,
    packageId: payload.packageId,
    reportRevision: payload.reportRevision,
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

function decryptViewerGrant(record, pin) {
  try {
    if (!record || record.format !== ENCRYPTED_GRANT_FORMAT || Number(record.formatVersion) !== ENCRYPTED_GRANT_VERSION) {
      throw new Error("unsupported-grant");
    }
    const encryption = record.encryption || {};
    const params = encryption.params || {};
    if (encryption.algorithm !== "aes-256-gcm" || encryption.kdf !== "scrypt") throw new Error("unsupported-grant");
    const key = crypto.scryptSync(String(pin || ""), Buffer.from(encryption.salt, "base64"), Number(params.keylen), {
      N: Number(params.N), r: Number(params.r), p: Number(params.p), maxmem: 64 * 1024 * 1024,
    });
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(encryption.iv, "base64"));
    decipher.setAuthTag(Buffer.from(encryption.tag, "base64"));
    const payload = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final(),
    ]).toString("utf8"));
    if (payload.format !== "pulse-clinic-viewer-page-grant" || Number(payload.formatVersion) !== 1
      || payload.packageId !== record.packageId || payload.reportRevision !== record.reportRevision
      || !payload.pageKeys || typeof payload.pageKeys !== "object" || !Array.isArray(payload.bindings)) {
      throw new Error("grant-mismatch");
    }
    return payload;
  } catch (_) {
    throw new Error("Не удалось открыть ключи страниц. Проверьте PIN и целостность публикации");
  }
}

function encryptSharedPage(page, pageKey, { packageId, reportRevision }) {
  const key = Buffer.from(pageKey);
  if (key.length !== 32) throw new Error("Некорректный ключ общей страницы");
  const iv = crypto.randomBytes(12);
  const compressed = zlib.gzipSync(jsonBytes({ packageId, reportRevision, ...page }), { level: 9 });
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return {
    format: SHARED_PAGE_FORMAT,
    formatVersion: SHARED_PAGE_VERSION,
    packageId,
    reportRevision,
    pageId: page.pageId,
    periodKey: page.periodKey,
    pageType: page.pageType,
    encryption: {
      algorithm: "aes-256-gcm",
      compression: "gzip",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    },
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptSharedPage(record, pageKey) {
  try {
    if (!record || record.format !== SHARED_PAGE_FORMAT || Number(record.formatVersion) !== SHARED_PAGE_VERSION) {
      throw new Error("unsupported-page");
    }
    const encryption = record.encryption || {};
    if (encryption.algorithm !== "aes-256-gcm" || encryption.compression !== "gzip") throw new Error("unsupported-page");
    const key = Buffer.isBuffer(pageKey) ? pageKey : Buffer.from(String(pageKey || ""), "base64");
    if (key.length !== 32) throw new Error("invalid-key");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(encryption.iv, "base64"));
    decipher.setAuthTag(Buffer.from(encryption.tag, "base64"));
    const compressed = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]);
    const page = JSON.parse(zlib.gunzipSync(compressed).toString("utf8"));
    if (page.packageId !== record.packageId || page.reportRevision !== record.reportRevision
      || page.pageId !== record.pageId || page.periodKey !== record.periodKey || page.pageType !== record.pageType) {
      throw new Error("page-mismatch");
    }
    return page;
  } catch (_) {
    throw new Error("Не удалось расшифровать общую страницу отчёта");
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

function prepareViewerPublication({ doctors, subjects = doctors, periods, pages, reportModel: suppliedReportModel, credentials }) {
  if (!Array.isArray(doctors) || !doctors.length || doctors.length > 1000) throw new Error("Не выбраны врачи для публикации");
  if (!Array.isArray(subjects) || !subjects.length || subjects.length > 1000) throw new Error("Не выбраны врачи для отчётов");
  if (!Array.isArray(periods) || !periods.length || periods.length > 120) throw new Error("Не выбраны периоды публикации");
  if (!suppliedReportModel && (!Array.isArray(pages) || !pages.length || pages.length > 10000)) throw new Error("В публикации нет страниц");
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

  const reportModel = suppliedReportModel
    ? normalizeReportModel(suppliedReportModel, normalizedPeriods)
    : reportModelFromLegacyPages(normalizedPeriods, pages || []);
  for (const binding of reportModel.bindings) {
    if (!subjectMap.has(binding.doctorId)) throw new Error("Страница относится к невыбранному врачу");
    if (!normalizedPeriods.includes(binding.periodKey)) throw new Error("Страница относится к невыбранному периоду");
  }

  return { normalizedPeriods, reportModel, doctorMap, subjectMap };
}

function reportModelJsonAdapter(reportModel) {
  return JSON.parse(JSON.stringify(reportModel));
}

function allowedBindings(reportModel, visibleDoctorIds) {
  const visible = new Set(visibleDoctorIds.map(String));
  return reportModel.bindings.filter(binding => visible.has(binding.doctorId));
}

function pageDescriptors(reportModel) {
  return reportModel.pages.map(({ html, ...page }) => ({ ...page, bytes: Buffer.byteLength(html, "utf8") }));
}

function estimateViewerPublication(input, format = "zip") {
  const prepared = prepareViewerPublication(input);
  const { reportModel, doctorMap } = prepared;
  const sharedCompressedBytes = reportModel.pages.reduce((sum, page) => {
    const payloadBytes = zlib.gzipSync(jsonBytes({ packageId: "x".repeat(36), reportRevision: reportModel.revision, ...page }), { level: 1 }).length;
    return sum + Math.ceil(payloadBytes * 4 / 3) + 900;
  }, 0);
  const recipientGrantBytes = [...doctorMap.values()].reduce((sum, doctor) => {
    const bindings = allowedBindings(reportModel, doctor.visibleDoctorIds);
    return sum + Buffer.byteLength(JSON.stringify(bindings), "utf8") + new Set(bindings.map(binding => binding.pageId)).size * 96 + 1800;
  }, 0);
  const adminGrantBytes = Buffer.byteLength(JSON.stringify(reportModel.bindings), "utf8") + reportModel.pages.length * 96 + 2200;
  const metadataBytes = Buffer.byteLength(JSON.stringify({
    periods: prepared.normalizedPeriods,
    doctors: [...doctorMap.values()].map(({ access, ...doctor }) => doctor),
    subjects: [...prepared.subjectMap.values()],
    pages: pageDescriptors(reportModel),
    bindings: reportModel.bindings,
  }), "utf8");
  const assetsBytes = format === "html" ? [
    "viewer/standalone.html", "viewer/standalone-app.js", "viewer/viewer.css", "build/app.css", "resources/app-icon.png",
  ].reduce((sum, relativePath) => sum + fs.statSync(path.resolve(__dirname, "../..", relativePath)).size, 0) : 0;
  const rawEstimate = sharedCompressedBytes + recipientGrantBytes + metadataBytes
    + (format === "html" ? adminGrantBytes + assetsBytes : 0);
  const estimatedBytes = Math.ceil(rawEstimate * (format === "html" ? 1.12 : 1.08));
  const limitBytes = format === "html" ? MAX_STANDALONE_BYTES : MAX_PACKAGE_BYTES;
  return deepFreeze({
    format,
    reportRevision: reportModel.revision,
    uniquePages: reportModel.pages.length,
    bindings: reportModel.bindings.length,
    duplicatedPagesAvoided: Math.max(0, reportModel.bindings.length - reportModel.pages.length),
    estimatedBytes,
    limitBytes,
    withinLimit: estimatedBytes <= limitBytes,
  });
}

function ensureEstimatedSize(input, format) {
  const estimate = estimateViewerPublication(input, format);
  if (!estimate.withinLimit) {
    const estimatedMb = Math.ceil(estimate.estimatedBytes / 1024 / 1024);
    const limitMb = Math.floor(estimate.limitBytes / 1024 / 1024);
    throw new Error(`Предварительный размер публикации около ${estimatedMb} МБ и превышает предел ${limitMb} МБ`);
  }
  return estimate;
}

async function createViewerPackage(input) {
  const { appVersion, credentials } = input;
  const estimate = ensureEstimatedSize(input, "zip");
  const { normalizedPeriods, reportModel, doctorMap, subjectMap } = prepareViewerPublication(input);
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

  const pageKeys = new Map();
  for (const page of reportModel.pages) {
    const pageKey = crypto.randomBytes(32);
    pageKeys.set(page.pageId, pageKey.toString("base64"));
    addJson(`pages/${page.pageId}.json`, encryptSharedPage(page, pageKey, {
      packageId,
      reportRevision: reportModel.revision,
    }));
  }

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
    const bindings = allowedBindings(reportModel, doctor.visibleDoctorIds);
    if (!bindings.length) throw new Error(`Для врача ${doctor.displayName} нет выбранных страниц`);
    const permittedPageIds = [...new Set(bindings.map(binding => binding.pageId))];
    addJson(`${prefix}/grant.json`, encryptViewerGrant({
      format: "pulse-clinic-viewer-page-grant",
      formatVersion: 1,
      packageId,
      reportRevision: reportModel.revision,
      accessRole: "doctor",
      doctorId: doctor.doctorId,
      bindings,
      pageKeys: Object.fromEntries(permittedPageIds.map(pageId => [pageId, pageKeys.get(pageId)])),
    }, doctor.access.pinCode));
  }

  const manifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    packageId,
    createdAt,
    appVersion: String(appVersion || ""),
    reportRevision: reportModel.revision,
    periods: normalizedPeriods,
    pageTypes: [...new Set(reportModel.pages.map(page => page.pageType))].sort(),
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
    reportModel: {
      format: REPORT_MODEL_FORMAT,
      formatVersion: REPORT_MODEL_VERSION,
      revision: reportModel.revision,
      pages: pageDescriptors(reportModel),
      bindings: reportModel.bindings,
    },
    sizeEstimate: estimate,
    files: fileHashes,
  };
  zip.file("manifest.json", jsonBytes(manifest));
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  if (buffer.length > MAX_PACKAGE_BYTES) throw new Error("Архив публикации превышает 300 МБ");
  return { buffer, manifest, sha256: sha256(buffer), estimate };
}

function encryptStandalonePayload(payload, pin, role = "doctor") {
  const pinPattern = role === "admin" ? /^\d{6,12}$/ : /^\d{4}$/;
  if (!pinPattern.test(String(pin || ""))) {
    throw new Error(role === "admin"
      ? "Для автономного Viewer не подтверждён администраторский PIN"
      : "Для автономного Viewer не настроен PIN врача");
  }
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

function standaloneAssetBase64(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, "../..", relativePath)).toString("base64");
}

function jsonForInlineScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

async function createStandaloneViewerHtml(input) {
  const { appVersion, credentials } = input;
  const estimate = ensureEstimatedSize(input, "html");
  const { normalizedPeriods, reportModel, doctorMap, subjectMap } = prepareViewerPublication(input);
  if (!credentials.admin || !credentials.admin.pinCode) {
    throw new Error("Для автономного HTML подтвердите администраторский PIN Viewer");
  }
  const packageId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const encryptedDoctors = [];
  const pageKeys = new Map();
  const sharedPages = reportModel.pages.map(page => {
    const pageKey = crypto.randomBytes(32);
    pageKeys.set(page.pageId, pageKey.toString("base64"));
    return encryptSharedPage(page, pageKey, { packageId, reportRevision: reportModel.revision });
  });

  for (const doctor of doctorMap.values()) {
    const bindings = allowedBindings(reportModel, doctor.visibleDoctorIds);
    if (!bindings.length) throw new Error(`Для врача ${doctor.displayName} нет выбранных страниц`);
    const permittedPageIds = [...new Set(bindings.map(binding => binding.pageId))];
    const encrypted = encryptStandalonePayload({
      format: STANDALONE_FORMAT,
      formatVersion: STANDALONE_FORMAT_VERSION,
      packageId,
      reportRevision: reportModel.revision,
      accessRole: "doctor",
      doctorId: doctor.doctorId,
      subjects: doctor.visibleDoctorIds.map(doctorId => subjectMap.get(doctorId)),
      bindings,
      pageKeys: Object.fromEntries(permittedPageIds.map(pageId => [pageId, pageKeys.get(pageId)])),
    }, doctor.access.pinCode);
    encryptedDoctors.push({
      doctorId: doctor.doctorId,
      displayName: doctor.displayName,
      department: doctor.department,
      specialization: doctor.specialization,
      pinVersion: doctor.pinVersion,
      managedDepartments: doctor.managedDepartments,
      visibleDoctorIds: doctor.visibleDoctorIds,
      periods: [...new Set(bindings.map(binding => binding.periodKey))].sort().reverse(),
      pageTypes: [...new Set(bindings.map(binding => binding.pageType))].sort(),
      ...encrypted,
    });
  }

  const adminPageIds = [...new Set(reportModel.bindings.map(binding => binding.pageId))];
  const encryptedAdminAccess = {
    displayName: "Администратор",
    pinVersion: Number(credentials.admin.pinVersion),
    periods: [...new Set(reportModel.bindings.map(binding => binding.periodKey))].sort().reverse(),
    pageTypes: [...new Set(reportModel.bindings.map(binding => binding.pageType))].sort(),
    ...encryptStandalonePayload({
      format: STANDALONE_FORMAT,
      formatVersion: STANDALONE_FORMAT_VERSION,
      packageId,
      reportRevision: reportModel.revision,
      accessRole: "admin",
      subjects: [...subjectMap.values()],
      bindings: reportModel.bindings,
      pageKeys: Object.fromEntries(adminPageIds.map(pageId => [pageId, pageKeys.get(pageId)])),
    }, credentials.admin.pinCode, "admin"),
  };

  const manifest = {
    format: STANDALONE_FORMAT,
    formatVersion: STANDALONE_FORMAT_VERSION,
    packageId,
    createdAt,
    appVersion: String(appVersion || ""),
    reportRevision: reportModel.revision,
    periods: normalizedPeriods,
    pageTypes: [...new Set(reportModel.pages.map(page => page.pageType))].sort(),
    subjects: [...subjectMap.values()],
    doctors: encryptedDoctors.map(({ encryption, ciphertext, ...doctor }) => doctor),
    adminAccess: {
      enabled: true,
      pinVersion: encryptedAdminAccess.pinVersion,
      periods: encryptedAdminAccess.periods,
      pageTypes: encryptedAdminAccess.pageTypes,
    },
    reportModel: {
      format: REPORT_MODEL_FORMAT,
      formatVersion: REPORT_MODEL_VERSION,
      revision: reportModel.revision,
      pages: pageDescriptors(reportModel),
      bindings: reportModel.bindings,
    },
    sizeEstimate: estimate,
  };
  const bundle = { ...manifest, sharedPages, doctors: encryptedDoctors, adminAccess: encryptedAdminAccess };
  const template = standaloneAsset("viewer/standalone.html");
  const html = template
    .replaceAll("/*__FAVICON__*/", standaloneAssetBase64("resources/app-icon.png"))
    .replace("/*__APP_CSS__*/", standaloneAsset("build/app.css"))
    .replace("/*__VIEWER_CSS__*/", standaloneAsset("viewer/viewer.css"))
    .replace("/*__STANDALONE_DATA__*/", jsonForInlineScript(bundle))
    .replace("/*__STANDALONE_APP__*/", standaloneAsset("viewer/standalone-app.js"));
  if (/\/\*__[A-Z0-9_]+__\*\//.test(html)) throw new Error("Не удалось собрать автономный HTML Viewer");
  const buffer = Buffer.from(html, "utf8");
  if (buffer.length > MAX_STANDALONE_BYTES) throw new Error("Автономный HTML Viewer превышает 400 МБ");
  return { buffer, manifest, sha256: sha256(buffer), estimate };
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
  if (manifest.format !== FORMAT || ![...LEGACY_FORMAT_VERSIONS, FORMAT_VERSION].includes(formatVersion)) {
    throw new Error("Формат архива Viewer не поддерживается");
  }
  safeSegment(manifest.packageId, "идентификатор пакета");
  if (!Array.isArray(manifest.doctors) || !manifest.doctors.length || !Array.isArray(manifest.periods) || !manifest.periods.length) {
    throw new Error("Manifest архива неполон");
  }
  if (formatVersion >= 4) {
    const model = manifest.reportModel;
    if (!model || model.format !== REPORT_MODEL_FORMAT || Number(model.formatVersion) !== REPORT_MODEL_VERSION
      || !/^[a-f0-9]{64}$/.test(String(model.revision || "")) || model.revision !== manifest.reportRevision
      || !Array.isArray(model.pages) || !model.pages.length || !Array.isArray(model.bindings) || !model.bindings.length) {
      throw new Error("Manifest не содержит корректную модель отчёта");
    }
    const pages = new Map();
    for (const page of model.pages) {
      const pageId = safeSegment(page.pageId, "идентификатор страницы");
      if (pages.has(pageId) || !/^\d{4}-\d{2}$/.test(String(page.periodKey || "")) || !PAGE_TYPES.has(String(page.pageType || ""))) {
        throw new Error("Manifest содержит некорректную страницу отчёта");
      }
      pages.set(pageId, page);
    }
    const publishedSubjects = new Set((Array.isArray(manifest.subjects) ? manifest.subjects : manifest.doctors)
      .map(subject => String(subject.doctorId || "")));
    const bindingKeys = new Set();
    for (const rawBinding of model.bindings) {
      const binding = normalizeBinding(rawBinding);
      const page = pages.get(binding.pageId);
      const bindingKey = `${binding.doctorId}\u0000${binding.periodKey}\u0000${binding.pageType}`;
      if (!publishedSubjects.has(binding.doctorId) || !page || page.periodKey !== binding.periodKey
        || page.pageType !== binding.pageType || bindingKeys.has(bindingKey)) {
        throw new Error("Manifest содержит некорректную привязку страницы");
      }
      bindingKeys.add(bindingKey);
    }
    const requiredFiles = [
      ...[...pages.keys()].map(pageId => `pages/${pageId}.json`),
      ...manifest.doctors.flatMap(doctor => {
        const folderId = safeSegment(doctor.folderId, "каталог врача");
        return [`doctors/${folderId}/profile.json`, `doctors/${folderId}/access.json`, `doctors/${folderId}/grant.json`];
      }),
    ];
    if (requiredFiles.some(filePath => !Object.prototype.hasOwnProperty.call(manifest.files || {}, filePath))) {
      throw new Error("Manifest не содержит хэши всех обязательных файлов");
    }
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
    reportRevision: formatVersion >= 4 ? String(manifest.reportRevision || "") : "",
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
    reportModel: formatVersion >= 4 && manifest.reportModel && typeof manifest.reportModel === "object"
      ? manifest.reportModel : null,
    sha256: sha256(bytes),
  };
  return includeZip ? { manifest, preview, zip } : { manifest, preview };
}

module.exports = {
  FORMAT,
  FORMAT_VERSION,
  LEGACY_FORMAT_VERSION,
  ENCRYPTED_PAGE_FORMAT,
  ENCRYPTED_GRANT_FORMAT,
  SHARED_PAGE_FORMAT,
  REPORT_MODEL_FORMAT,
  REPORT_MODEL_VERSION,
  STANDALONE_FORMAT,
  STANDALONE_FORMAT_VERSION,
  LEGACY_STANDALONE_FORMAT_VERSION,
  LEGACY_STANDALONE_FORMAT_VERSIONS,
  MAX_PACKAGE_BYTES,
  createStandaloneViewerHtml,
  createViewerPackage,
  decryptSharedPage,
  decryptViewerGrant,
  decryptViewerPage,
  encryptViewerPage,
  estimateViewerPublication,
  inspectViewerPackage,
  normalizeReportModel,
  reportModelFromLegacyPages,
  reportModelJsonAdapter,
  sanitizeReportHtml,
  sha256,
};
