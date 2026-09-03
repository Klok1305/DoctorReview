"use strict";

const crypto = require("node:crypto");

const MOBILE_PUBLICATION_FORMAT = "klinvekt-mobile-publication";
const MOBILE_PUBLICATION_VERSION = 1;
const MOBILE_PUBLICATION_EXTENSION = "kvmobile";
const MAX_PUBLICATION_BYTES = 10 * 1024 * 1024;
const MOBILE_BUNDLE_FORMAT = "klinvekt-mobile-bundle";
const MOBILE_BUNDLE_VERSION = 1;
const MOBILE_BUNDLE_EXTENSION = "kvmobilebundle";
const MOBILE_ENCRYPTED_PUBLICATION_FORMAT = "klinvekt-mobile-encrypted-publication";
const MOBILE_ENCRYPTED_PUBLICATION_VERSION = 1;
const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
const MAX_BUNDLE_DOCTORS = 1000;
const CONTENT_KDF_PARAMS = Object.freeze({ N: 32768, r: 8, p: 1, keylen: 32 });
const VECTOR_IDS = ["v1", "v2", "v3", "v4", "v5", "v6"];
const FORBIDDEN_KEYS = new Set([
  "clients",
  "clientrows",
  "patientregistry",
  "patientid",
  "patientname",
  "patientsforwork",
  "reactivationrows",
  "riskrows",
  "sourcefiles",
  "rawexports",
]);

function fail(message) {
  throw new Error(`Некорректная мобильная публикация: ${message}`);
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(label);
  return value;
}

function shortText(value, label, max = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail(label);
  return value;
}

function optionalText(value, label, max = 1000) {
  if (value == null || value === "") return;
  if (typeof value !== "string" || value.length > max) fail(label);
}

function finiteNumber(value, label, { nullable = false, min = -1000000, max = 1000000 } = {}) {
  if (nullable && value == null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail(label);
}

function rejectForbiddenKeys(value, path = "публикация", depth = 0) {
  if (depth > 80) fail("слишком глубокая вложенность");
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectForbiddenKeys(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(String(key).toLowerCase())) fail(`запрещённое поле ${path}.${key}`);
    rejectForbiddenKeys(nested, `${path}.${key}`, depth + 1);
  }
}

function validateCharts(charts, label) {
  if (charts == null) return;
  if (!Array.isArray(charts) || charts.length > 12) fail(`${label}: графики`);
  charts.forEach(chart => {
    plainObject(chart, `${label}: график`);
    shortText(chart.id, `${label}: код графика`, 100);
    shortText(chart.title, `${label}: название графика`, 300);
    if (!["donut", "bar", "line", "mirror"].includes(chart.type)) fail(`${label}: тип графика`);
    optionalText(chart.unit, `${label}: единица измерения`, 30);
    if (!Array.isArray(chart.labels) || !chart.labels.length || chart.labels.length > 500) fail(`${label}: подписи графика`);
    chart.labels.forEach(value => shortText(value, `${label}: подпись`, 1000));
    if (!Array.isArray(chart.series) || !chart.series.length || chart.series.length > 30) fail(`${label}: ряды графика`);
    if (["donut", "bar"].includes(chart.type) && chart.series.length !== 1) fail(`${label}: число рядов`);
    const color = value => { if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) fail(`${label}: цвет графика`); };
    chart.series.forEach(series => {
      plainObject(series, `${label}: ряд графика`);
      shortText(series.label, `${label}: название ряда`, 300);
      if (!Array.isArray(series.values) || series.values.length !== chart.labels.length) fail(`${label}: значения графика`);
      series.values.forEach(value => finiteNumber(value, `${label}: число графика`, { nullable: true, min: -1e15, max: 1e15 }));
      if (series.color != null) color(series.color);
      if (series.colors != null) {
        if (!Array.isArray(series.colors) || series.colors.length !== chart.labels.length) fail(`${label}: цвета графика`);
        series.colors.forEach(color);
      }
      if (chart.type === "donut" && series.values.some(value => value != null && value < 0)) fail(`${label}: отрицательный сектор`);
      if (chart.type === "mirror" && !["own", "ref"].includes(series.side)) fail(`${label}: сторона выручки`);
    });
  });
}

function validateTree(tree, columns, label) {
  let count = 0;
  const visit = (nodes, depth) => {
    if (!Array.isArray(nodes) || depth > 32) fail(`${label}: вложенность групп`);
    for (const node of nodes) {
      if (++count > 10000) fail(`${label}: слишком много групп и позиций`);
      plainObject(node, `${label}: группа`);
      shortText(node.label, `${label}: название группы`, 1000);
      if (!Array.isArray(node.values) || node.values.length !== columns.length - 1) fail(`${label}: значения группы`);
      node.values.forEach(value => shortText(value, `${label}: значение группы`, 1000));
      if (node.children != null) visit(node.children, depth + 1);
    }
  };
  visit(tree, 0);
}

function validateMetric(metric, label) {
  const item = plainObject(metric, label);
  shortText(item.label, `${label}: название`);
  shortText(item.value, `${label}: значение`);
  optionalText(item.note, `${label}: пояснение`);
  optionalText(item.target, `${label}: цель`);
  optionalText(item.state, `${label}: состояние`, 30);
}

function validateSection(section, label) {
  const item = plainObject(section, label);
  shortText(item.title, `${label}: заголовок`);
  optionalText(item.note, `${label}: пояснение`, 2000);
  const metrics = Array.isArray(item.metrics) ? item.metrics : [];
  const rows = Array.isArray(item.rows) ? item.rows : [];
  if (!metrics.length && !rows.length && !item.tree?.length && !item.charts?.length) fail(`${label}: пустой раздел`);
  if (metrics.length > 30 || rows.length > 500) fail(`${label}: слишком много данных`);
  metrics.forEach((metric, index) => validateMetric(metric, `${label}: показатель ${index + 1}`));
  if (rows.length || item.tree != null) {
    if (!Array.isArray(item.columns) || item.columns.length < 2 || item.columns.length > 6) fail(`${label}: столбцы таблицы`);
    item.columns.forEach((column, index) => shortText(column, `${label}: столбец ${index + 1}`, 100));
    rows.forEach((row, rowIndex) => {
      if (!Array.isArray(row) || row.length !== item.columns.length) fail(`${label}: строка ${rowIndex + 1}`);
      row.forEach((cell, cellIndex) => shortText(cell, `${label}: ячейка ${rowIndex + 1}.${cellIndex + 1}`, 1000));
    });
  }
  if (item.tree != null) validateTree(item.tree, item.columns, label);
  validateCharts(item.charts, label);
}

function validateSections(sections, label) {
  if (!Array.isArray(sections) || !sections.length || sections.length > 12) fail(label);
  sections.forEach((section, index) => validateSection(section, `${label}: раздел ${index + 1}`));
}

function validateVector(vector, index) {
  const item = plainObject(vector, `вектор ${index + 1}`);
  if (item.id !== VECTOR_IDS[index]) fail(`порядок векторов: ожидался ${VECTOR_IDS[index]}`);
  if (item.number !== index + 1) fail(`номер вектора ${item.id}`);
  shortText(item.title, `название вектора ${item.id}`);
  finiteNumber(item.score, `балл вектора ${item.id}`, { nullable: true, min: 0, max: 100 });
  finiteNumber(item.delta, `динамика вектора ${item.id}`, { nullable: true, min: -100, max: 100 });
  shortText(item.detail, `описание вектора ${item.id}`, 1500);
  if (Array.isArray(item.windows)) {
    if (!item.windows.length || item.windows.length > 12) fail(`окна вектора ${item.id}`);
    item.windows.forEach((window, windowIndex) => {
      const entry = plainObject(window, `окно ${item.id}.${windowIndex + 1}`);
      shortText(entry.id, `идентификатор окна ${item.id}`, 30);
      shortText(entry.label, `название окна ${item.id}`, 100);
      optionalText(entry.period, `период окна ${item.id}`, 500);
      validateSections(entry.sections, `метрики окна ${item.id}.${entry.id}`);
    });
  } else {
    validateSections(item.sections, `метрики вектора ${item.id}`);
  }
}

function validatePublicationDynamics(dynamics, periodId) {
  if (dynamics == null) return;
  const value = plainObject(dynamics, `динамика периода ${periodId}`);
  if (!Array.isArray(value.columns) || !value.columns.length || value.columns.length > 6) fail(`месяцы динамики ${periodId}`);
  value.columns.forEach((column, index) => shortText(column, `месяц динамики ${periodId}.${index + 1}`, 100));
  if (!Array.isArray(value.rows) || !value.rows.length || value.rows.length > 30) fail(`показатели динамики ${periodId}`);
  value.rows.forEach((row, index) => {
    const entry = plainObject(row, `показатель динамики ${periodId}.${index + 1}`);
    shortText(entry.key, `код показателя динамики ${periodId}.${index + 1}`, 100);
    shortText(entry.label, `название показателя динамики ${periodId}.${index + 1}`, 300);
    if (!Array.isArray(entry.values) || entry.values.length !== value.columns.length) fail(`значения динамики ${periodId}.${index + 1}`);
    entry.values.forEach((cell, cellIndex) => shortText(cell, `значение динамики ${periodId}.${index + 1}.${cellIndex + 1}`, 200));
    shortText(entry.delta, `изменение динамики ${periodId}.${index + 1}`, 50);
    optionalText(entry.averageDelta, `изменение к среднему ${periodId}.${index + 1}`, 50);
    optionalText(entry.target, `цель динамики ${periodId}.${index + 1}`, 200);
    optionalText(entry.state, `состояние динамики ${periodId}.${index + 1}`, 30);
  });
  for (const [key, label] of [["growth", "точки роста"], ["risk", "точки риска"]]) {
    if (!Array.isArray(value[key]) || value[key].length > 20) fail(`${label} ${periodId}`);
    value[key].forEach((item, index) => shortText(item, `${label} ${periodId}.${index + 1}`, 1000));
  }
  optionalText(value.conclusion, `выводы динамики ${periodId}`, 10000);
  if (value.conclusionManual != null && typeof value.conclusionManual !== "boolean") fail(`признак ручных выводов ${periodId}`);
  validateCharts(value.charts, `динамика ${periodId}`);
}

function validatePublicationComments(comments, periodId) {
  if (comments == null) return;
  if (!Array.isArray(comments) || comments.length > 50) fail(`комментарии периода ${periodId}`);
  comments.forEach((comment, index) => {
    const entry = plainObject(comment, `комментарий ${periodId}.${index + 1}`);
    shortText(entry.blockKey, `раздел комментария ${periodId}.${index + 1}`, 200);
    shortText(entry.title, `заголовок комментария ${periodId}.${index + 1}`, 300);
    shortText(entry.text, `текст комментария ${periodId}.${index + 1}`, 10000);
    shortText(entry.author, `автор комментария ${periodId}.${index + 1}`, 300);
    optionalText(entry.updatedAt, `дата комментария ${periodId}.${index + 1}`, 100);
  });
}

function validateMobilePublication(publication) {
  const value = plainObject(publication, "корневой объект");
  rejectForbiddenKeys(value);
  if (value.format !== MOBILE_PUBLICATION_FORMAT) fail("неизвестный формат");
  if (value.version !== MOBILE_PUBLICATION_VERSION) fail("неподдерживаемая версия");
  optionalText(value.createdAt, "дата создания", 50);

  const security = plainObject(value.security, "описание безопасности");
  if (security.patientRegistryIncluded !== false || security.rawExportsIncluded !== false) {
    fail("публикация не подтверждает отсутствие реестра пациентов и исходных выгрузок");
  }

  const doctor = plainObject(value.doctor, "врач");
  if (doctor.id != null) shortText(String(doctor.id), "идентификатор врача", 200);
  shortText(doctor.name, "имя врача", 200);
  shortText(doctor.department, "подразделение врача", 300);

  if (!Array.isArray(value.periods) || !value.periods.length || value.periods.length > 24) fail("периоды");
  const periodIds = new Set();
  value.periods.forEach((period, periodIndex) => {
    const item = plainObject(period, `период ${periodIndex + 1}`);
    shortText(item.id, `идентификатор периода ${periodIndex + 1}`, 20);
    if (periodIds.has(item.id)) fail(`повтор периода ${item.id}`);
    periodIds.add(item.id);
    shortText(item.label, `название периода ${item.id}`, 100);
    shortText(item.shortLabel, `краткое название периода ${item.id}`, 50);
    finiteNumber(item.overall, `общий балл ${item.id}`, { nullable: true, min: 0, max: 100 });
    finiteNumber(item.overallDelta, `динамика общего балла ${item.id}`, { nullable: true, min: -100, max: 100 });
    shortText(item.assessment, `оценка периода ${item.id}`, 300);
    shortText(item.summary, `резюме периода ${item.id}`, 1000);
    optionalText(item.updatedAt, `дата обновления ${item.id}`, 100);
    optionalText(item.comment, `комментарий ${item.id}`, 3000);
    if (!Array.isArray(item.headlineMetrics) || item.headlineMetrics.length !== 5) fail(`верхние показатели ${item.id}`);
    item.headlineMetrics.forEach((metric, index) => {
      validateMetric(metric, `верхний показатель ${item.id}.${index + 1}`);
      optionalText(metric.delta, `динамика верхнего показателя ${item.id}.${index + 1}`, 50);
    });
    if (!Array.isArray(item.vectors) || item.vectors.length !== VECTOR_IDS.length) fail(`векторы периода ${item.id}`);
    item.vectors.forEach(validateVector);
    if (!Array.isArray(item.goals) || item.goals.length > 20) fail(`цели периода ${item.id}`);
    item.goals.forEach((goal, index) => {
      const entry = plainObject(goal, `цель ${item.id}.${index + 1}`);
      shortText(entry.title, `название цели ${item.id}.${index + 1}`, 300);
      shortText(entry.description, `описание цели ${item.id}.${index + 1}`, 1000);
      finiteNumber(entry.progress, `прогресс цели ${item.id}.${index + 1}`, { min: 0, max: 100 });
      optionalText(entry.key, `код цели ${item.id}.${index + 1}`, 100);
      optionalText(entry.vector, `вектор цели ${item.id}.${index + 1}`, 10);
      optionalText(entry.target, `целевое значение ${item.id}.${index + 1}`, 300);
      optionalText(entry.fact, `фактическое значение ${item.id}.${index + 1}`, 300);
      optionalText(entry.state, `состояние цели ${item.id}.${index + 1}`, 30);
    });
    optionalText(item.goalsSource, `источник целей ${item.id}`, 500);
    validatePublicationDynamics(item.dynamics, item.id);
    validatePublicationComments(item.comments, item.id);
  });

  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > MAX_PUBLICATION_BYTES) fail("файл превышает 10 МБ");
  return value;
}

function serializeMobilePublication(publication) {
  return JSON.stringify(validateMobilePublication(publication), null, 2);
}

function bundleFail(message) {
  throw new Error(`Некорректный пакет мобильных публикаций: ${message}`);
}

function bundleText(value, label, max = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > max) bundleFail(label);
  return value;
}

function base64Bytes(value, label, { exact = null, min = 1, max = MAX_PUBLICATION_BYTES + 1024 } = {}) {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) bundleFail(label);
  const buffer = Buffer.from(value, "base64");
  if (buffer.toString("base64") !== value || (exact != null && buffer.length !== exact) || buffer.length < min || buffer.length > max) {
    bundleFail(label);
  }
  return buffer;
}

function encryptionAad(doctorId, pinVersion) {
  return Buffer.from(`${MOBILE_ENCRYPTED_PUBLICATION_FORMAT}:${MOBILE_ENCRYPTED_PUBLICATION_VERSION}:${doctorId}:${pinVersion}`, "utf8");
}

function validateEncryptedMobilePublication(record) {
  const value = record && typeof record === "object" && !Array.isArray(record) ? record : bundleFail("зашифрованная публикация");
  if (value.format !== MOBILE_ENCRYPTED_PUBLICATION_FORMAT || Number(value.version) !== MOBILE_ENCRYPTED_PUBLICATION_VERSION) {
    bundleFail("неподдерживаемый формат зашифрованной публикации");
  }
  bundleText(value.doctorId, "идентификатор врача", 200);
  bundleText(value.displayName, "имя врача", 200);
  if (typeof value.department !== "string" || value.department.length > 300) bundleFail("подразделение врача");
  if (!Number.isInteger(value.pinVersion) || value.pinVersion < 1) bundleFail("версия PIN врача");
  if (!Number.isInteger(value.periods) || value.periods < 1 || value.periods > 24) bundleFail("количество периодов врача");
  const encryption = value.encryption && typeof value.encryption === "object" && !Array.isArray(value.encryption)
    ? value.encryption
    : bundleFail("описание шифрования");
  if (encryption.algorithm !== "aes-256-gcm" || encryption.kdf !== "scrypt") bundleFail("алгоритм шифрования");
  const params = encryption.params || {};
  if (Number(params.N) !== CONTENT_KDF_PARAMS.N || Number(params.r) !== CONTENT_KDF_PARAMS.r
    || Number(params.p) !== CONTENT_KDF_PARAMS.p || Number(params.keylen) !== CONTENT_KDF_PARAMS.keylen) {
    bundleFail("параметры шифрования");
  }
  base64Bytes(encryption.salt, "соль шифрования", { exact: 24 });
  base64Bytes(encryption.iv, "вектор шифрования", { exact: 12 });
  base64Bytes(encryption.tag, "метка целостности", { exact: 16 });
  base64Bytes(value.ciphertext, "зашифрованные данные");
  return value;
}

function encryptMobilePublication(publication, { doctorId, pinCode, pinVersion }) {
  const value = validateMobilePublication(publication);
  const id = bundleText(String(doctorId || ""), "идентификатор врача", 200);
  if (!/^\d{4}$/.test(String(pinCode || ""))) bundleFail(`не настроен четырёхзначный PIN врача ${id}`);
  const version = Number(pinVersion);
  if (!Number.isInteger(version) || version < 1) bundleFail(`версия PIN врача ${id}`);
  const doctor = value.doctor || {};
  if (doctor.id != null && String(doctor.id) !== id) bundleFail(`публикация не принадлежит врачу ${id}`);
  const salt = crypto.randomBytes(24);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(String(pinCode), salt, CONTENT_KDF_PARAMS.keylen, {
    N: CONTENT_KDF_PARAMS.N,
    r: CONTENT_KDF_PARAMS.r,
    p: CONTENT_KDF_PARAMS.p,
    maxmem: 64 * 1024 * 1024,
  });
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(encryptionAad(id, version));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), "utf8")), cipher.final()]);
  return validateEncryptedMobilePublication({
    format: MOBILE_ENCRYPTED_PUBLICATION_FORMAT,
    version: MOBILE_ENCRYPTED_PUBLICATION_VERSION,
    doctorId: id,
    displayName: String(doctor.name),
    department: String(doctor.department),
    pinVersion: version,
    periods: value.periods.length,
    encryption: {
      algorithm: "aes-256-gcm",
      kdf: "scrypt",
      salt: salt.toString("base64"),
      params: CONTENT_KDF_PARAMS,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    },
    ciphertext: ciphertext.toString("base64"),
  });
}

function decryptMobilePublication(record, pin) {
  try {
    const value = validateEncryptedMobilePublication(record);
    if (!/^\d{4}$/.test(String(pin || ""))) throw new Error("invalid-pin");
    const encryption = value.encryption;
    const key = crypto.scryptSync(String(pin), Buffer.from(encryption.salt, "base64"), CONTENT_KDF_PARAMS.keylen, {
      N: CONTENT_KDF_PARAMS.N,
      r: CONTENT_KDF_PARAMS.r,
      p: CONTENT_KDF_PARAMS.p,
      maxmem: 64 * 1024 * 1024,
    });
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(encryption.iv, "base64"));
    decipher.setAAD(encryptionAad(value.doctorId, value.pinVersion));
    decipher.setAuthTag(Buffer.from(encryption.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]);
    const publication = validateMobilePublication(JSON.parse(plaintext.toString("utf8")));
    if (publication.doctor.id != null && String(publication.doctor.id) !== value.doctorId) throw new Error("doctor-mismatch");
    if (publication.doctor.name !== value.displayName || publication.doctor.department !== value.department
      || publication.periods.length !== value.periods) throw new Error("metadata-mismatch");
    return publication;
  } catch (_) {
    throw new Error("Не удалось открыть отчёт. Проверьте PIN врача");
  }
}

function validateMobilePublicationBundle(bundle) {
  const value = bundle && typeof bundle === "object" && !Array.isArray(bundle) ? bundle : bundleFail("корневой объект");
  rejectForbiddenKeys(value, "пакет");
  if (value.format !== MOBILE_BUNDLE_FORMAT || Number(value.version) !== MOBILE_BUNDLE_VERSION) bundleFail("неподдерживаемая версия");
  if (typeof value.createdAt !== "string" || !value.createdAt || value.createdAt.length > 50) bundleFail("дата создания");
  if (value.appVersion != null && (typeof value.appVersion !== "string" || value.appVersion.length > 50)) bundleFail("версия приложения");
  const security = value.security && typeof value.security === "object" && !Array.isArray(value.security) ? value.security : bundleFail("описание безопасности");
  if (security.patientRegistryIncluded !== false || security.rawExportsIncluded !== false || security.encryptedPerDoctor !== true) {
    bundleFail("пакет не подтверждает безопасный состав и шифрование по врачам");
  }
  if (!Array.isArray(value.doctors) || !value.doctors.length || value.doctors.length > MAX_BUNDLE_DOCTORS) bundleFail("список врачей");
  const ids = new Set();
  value.doctors.forEach((doctor) => {
    const entry = validateEncryptedMobilePublication(doctor);
    if (ids.has(entry.doctorId)) bundleFail(`врач ${entry.doctorId} указан повторно`);
    ids.add(entry.doctorId);
  });
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > MAX_BUNDLE_BYTES) bundleFail("файл превышает 100 МБ");
  return value;
}

function createMobilePublicationBundle({ publications, credentials, appVersion = "" }) {
  if (!Array.isArray(publications) || !publications.length || publications.length > MAX_BUNDLE_DOCTORS) bundleFail("список публикаций");
  const credentialItems = credentials && Array.isArray(credentials.doctors) ? credentials.doctors : [];
  const credentialsByDoctor = new Map(credentialItems.map(item => [String(item.doctorId || ""), item]));
  const doctors = publications.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) bundleFail("публикация врача");
    const doctorId = String(item.doctorId || "");
    const access = credentialsByDoctor.get(doctorId);
    if (!access) bundleFail(`нет настроенного доступа врача ${doctorId}`);
    return encryptMobilePublication(item.publication, {
      doctorId,
      pinCode: access.pinCode,
      pinVersion: Number(access.pinVersion),
    });
  }).sort((a, b) => a.displayName.localeCompare(b.displayName, "ru", { sensitivity: "base" }) || a.doctorId.localeCompare(b.doctorId, "ru"));
  return validateMobilePublicationBundle({
    format: MOBILE_BUNDLE_FORMAT,
    version: MOBILE_BUNDLE_VERSION,
    createdAt: new Date().toISOString(),
    appVersion: String(appVersion || ""),
    security: {
      patientRegistryIncluded: false,
      rawExportsIncluded: false,
      encryptedPerDoctor: true,
    },
    doctors,
  });
}

function serializeMobilePublicationBundle(bundle) {
  return JSON.stringify(validateMobilePublicationBundle(bundle), null, 2);
}

module.exports = {
  CONTENT_KDF_PARAMS,
  MAX_PUBLICATION_BYTES,
  MAX_BUNDLE_BYTES,
  MAX_BUNDLE_DOCTORS,
  MOBILE_BUNDLE_EXTENSION,
  MOBILE_BUNDLE_FORMAT,
  MOBILE_BUNDLE_VERSION,
  MOBILE_PUBLICATION_EXTENSION,
  MOBILE_PUBLICATION_FORMAT,
  MOBILE_PUBLICATION_VERSION,
  createMobilePublicationBundle,
  decryptMobilePublication,
  encryptMobilePublication,
  serializeMobilePublication,
  serializeMobilePublicationBundle,
  validateEncryptedMobilePublication,
  validateMobilePublication,
  validateMobilePublicationBundle,
};
