"use strict";

const MOBILE_PUBLICATION_FORMAT = "klinvekt-mobile-publication";
const MOBILE_PUBLICATION_VERSION = 1;
const MOBILE_PUBLICATION_EXTENSION = "kvmobile";
const MAX_PUBLICATION_BYTES = 10 * 1024 * 1024;
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

function rejectForbiddenKeys(value, path = "публикация") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectForbiddenKeys(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(String(key).toLowerCase())) fail(`запрещённое поле ${path}.${key}`);
    rejectForbiddenKeys(nested, `${path}.${key}`);
  }
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
  if (!metrics.length && !rows.length) fail(`${label}: пустой раздел`);
  if (metrics.length > 30 || rows.length > 500) fail(`${label}: слишком много данных`);
  metrics.forEach((metric, index) => validateMetric(metric, `${label}: показатель ${index + 1}`));
  if (rows.length) {
    if (!Array.isArray(item.columns) || item.columns.length < 2 || item.columns.length > 6) fail(`${label}: столбцы таблицы`);
    item.columns.forEach((column, index) => shortText(column, `${label}: столбец ${index + 1}`, 100));
    rows.forEach((row, rowIndex) => {
      if (!Array.isArray(row) || row.length !== item.columns.length) fail(`${label}: строка ${rowIndex + 1}`);
      row.forEach((cell, cellIndex) => shortText(cell, `${label}: ячейка ${rowIndex + 1}.${cellIndex + 1}`, 1000));
    });
  }
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
    if (!Array.isArray(item.goals) || item.goals.length > 12) fail(`цели периода ${item.id}`);
    item.goals.forEach((goal, index) => {
      const entry = plainObject(goal, `цель ${item.id}.${index + 1}`);
      shortText(entry.title, `название цели ${item.id}.${index + 1}`, 300);
      shortText(entry.description, `описание цели ${item.id}.${index + 1}`, 1000);
      finiteNumber(entry.progress, `прогресс цели ${item.id}.${index + 1}`, { min: 0, max: 100 });
    });
  });

  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > MAX_PUBLICATION_BYTES) fail("файл превышает 10 МБ");
  return value;
}

function serializeMobilePublication(publication) {
  return JSON.stringify(validateMobilePublication(publication), null, 2);
}

module.exports = {
  MAX_PUBLICATION_BYTES,
  MOBILE_PUBLICATION_EXTENSION,
  MOBILE_PUBLICATION_FORMAT,
  MOBILE_PUBLICATION_VERSION,
  serializeMobilePublication,
  validateMobilePublication,
};
