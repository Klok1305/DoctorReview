"use strict";

const crypto = require("node:crypto");
const { promisify } = require("node:util");
const scrypt = promisify(crypto.scrypt);
const PIN_PARAMS = Object.freeze({ N: 32768, r: 8, p: 1, keylen: 64 });
const FILE_KDF = Object.freeze({ name: "scrypt", N: 32768, r: 8, p: 1, keylen: 32 });
const TRANSFER_FORMAT = "klinvekt-pin-transfer", CLOUD_PIN_FORMAT = "klinvekt-cloud-pins";
const ENCRYPTED_FORMAT = "klinvekt-pin-transfer-encrypted";
const MAX_PIN_BYTES = 2 * 1024 * 1024;
const fail = message => { throw new Error(message); };
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
function object(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail("Некорректный файл PIN: неизвестное поле");
}
function text(value, label, empty = false) {
  if (typeof value !== "string" || value.length > 240 || (!empty && !value.trim())) fail(`Некорректный файл PIN: ${label}`);
}
function base64(value, bytes) {
  if (typeof value !== "string") fail("Некорректный файл PIN: кодировка");
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== bytes || decoded.toString("base64") !== value) fail("Некорректный файл PIN: длина или кодировка");
  return decoded;
}
function verifier(value) {
  base64(value.pinHash, 64); base64(value.pinSalt, 24);
  object(value.pinParams, Object.keys(PIN_PARAMS));
  if (Object.entries(PIN_PARAMS).some(([key, expected]) => value.pinParams[key] !== expected)) fail("Некорректный файл PIN: параметры проверки");
}
function validatePinSync(value) {
  object(value, ["setId", "revision", "digest"]);
  if (!uuid(value.setId) || !Number.isSafeInteger(value.revision) || value.revision < 1 || !/^[a-f0-9]{64}$/.test(value.digest || "")) fail("Некорректная версия набора PIN");
  return value;
}
function pinDigest(doctors) {
  return crypto.createHash("sha256").update(JSON.stringify(doctors.map(doctor => [doctor.syncId, doctor.pinHash, doctor.pinSalt])
    .sort((a, b) => a[0].localeCompare(b[0])))).digest("hex");
}
function validatePinTransfer(value, cloud = false) {
  object(value, ["format", "version", "createdAt", "appVersion", "sync", "doctors", "admin"]);
  if (value.format !== (cloud ? CLOUD_PIN_FORMAT : TRANSFER_FORMAT) || value.version !== 1) fail("Нужен файл переноса PIN из обновлённого Admin");
  text(value.createdAt, "дата"); text(value.appVersion, "версия приложения");
  if (!Number.isFinite(Date.parse(value.createdAt))) fail("Некорректная дата файла PIN");
  validatePinSync(value.sync);
  if (!Array.isArray(value.doctors) || !value.doctors.length || value.doctors.length > 1000) fail("Некорректный список врачей файла PIN");
  const ids = new Set(), syncIds = new Set(), pins = new Set();
  for (const doctor of value.doctors) {
    object(doctor, ["doctorId", "syncId", "displayName", "department", "specialization", "pinHash", "pinSalt", "pinParams", ...(cloud ? [] : ["pin"])]);
    text(doctor.doctorId, "ID врача"); text(doctor.displayName, "ФИО врача");
    text(doctor.department, "отделение", true); text(doctor.specialization, "специализация", true);
    if (!uuid(doctor.syncId) || ids.has(doctor.doctorId) || syncIds.has(doctor.syncId)) fail("В файле PIN повторяется врач");
    ids.add(doctor.doctorId); syncIds.add(doctor.syncId); verifier(doctor);
    if (!cloud) {
      if (typeof doctor.pin !== "string" || !/^\d{4}$/.test(doctor.pin) || pins.has(doctor.pin)) fail("PIN врача должен быть уникальной строкой из четырёх цифр");
      pins.add(doctor.pin);
    }
  }
  if (value.admin != null) {
    object(value.admin, ["pinHash", "pinSalt", "pinParams"]); verifier(value.admin);
  }
  if (pinDigest(value.doctors) !== value.sync.digest) fail("Контрольная сумма набора PIN не совпадает");
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_PIN_BYTES) fail("Файл PIN превышает 2 МиБ");
  return value;
}
function cloudPinsFromTransfer(value) {
  validatePinTransfer(value);
  const result = { ...value, format: CLOUD_PIN_FORMAT, doctors: value.doctors.map(({ pin, ...doctor }) => doctor) };
  return validatePinTransfer(result, true);
}
function passwordValue(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > 128) fail("Пароль файла должен содержать от 8 до 128 символов");
  return value;
}
async function encryptPinTransfer(value, password) {
  validatePinTransfer(value); passwordValue(password);
  const salt = crypto.randomBytes(24), iv = crypto.randomBytes(12);
  const key = await scrypt(password, salt, 32, { N: FILE_KDF.N, r: FILE_KDF.r, p: FILE_KDF.p, maxmem: 64 * 1024 * 1024 });
  try {
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(ENCRYPTED_FORMAT + ":1"));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return JSON.stringify({ format: ENCRYPTED_FORMAT, version: 1, kdf: FILE_KDF, salt: salt.toString("base64"), iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") });
  } finally { key.fill(0); }
}
async function decryptPinTransfer(serialized, password) {
  passwordValue(password);
  if (typeof serialized !== "string" || Buffer.byteLength(serialized) > MAX_PIN_BYTES * 2) fail("Файл PIN слишком велик");
  let value;
  try { value = JSON.parse(serialized); } catch (_) { fail("Файл PIN повреждён"); }
  object(value, ["format", "version", "kdf", "salt", "iv", "tag", "ciphertext"]);
  if (value.format !== ENCRYPTED_FORMAT || value.version !== 1) fail("Выберите защищённый файл .kvpins из Admin");
  object(value.kdf, Object.keys(FILE_KDF));
  if (Object.entries(FILE_KDF).some(([key, expected]) => value.kdf[key] !== expected)) fail("Некорректные параметры защиты файла PIN");
  const salt = base64(value.salt, 24), iv = base64(value.iv, 12), tag = base64(value.tag, 16);
  if (typeof value.ciphertext !== "string" || value.ciphertext.length > MAX_PIN_BYTES * 1.5) fail("Файл PIN слишком велик");
  const bytes = Buffer.from(value.ciphertext, "base64");
  if (bytes.toString("base64") !== value.ciphertext) fail("Файл PIN повреждён");
  const key = await scrypt(password, salt, 32, { N: FILE_KDF.N, r: FILE_KDF.r, p: FILE_KDF.p, maxmem: 64 * 1024 * 1024 });
  let payload;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(ENCRYPTED_FORMAT + ":1")); decipher.setAuthTag(tag);
    payload = JSON.parse(Buffer.concat([decipher.update(bytes), decipher.final()]).toString("utf8"));
  } catch (_) { fail("Неверный пароль или файл PIN повреждён"); }
  finally { key.fill(0); }
  validatePinTransfer(payload);
  // Validate the displayed PIN against its existing verifier in a bounded pair
  // of KDF jobs. Online exports carry only the verified records, never the PIN.
  let index = 0;
  await Promise.all([0, 1].map(async () => {
    while (index < payload.doctors.length) {
      const doctor = payload.doctors[index++];
      const actual = await scrypt(doctor.pin, Buffer.from(doctor.pinSalt, "base64"), 64, { N: PIN_PARAMS.N, r: PIN_PARAMS.r, p: PIN_PARAMS.p, maxmem: 64 * 1024 * 1024 });
      if (!crypto.timingSafeEqual(actual, Buffer.from(doctor.pinHash, "base64"))) fail("PIN врача в файле не соответствует проверочному хешу");
    }
  }));
  return payload;
}
const normalized = value => String(value || "").normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
function pinSyncRelation(current, incoming) {
  validatePinSync(incoming);
  if (!current || current.setId !== incoming.setId) return "different";
  if (incoming.revision < current.revision) return "stale";
  if (incoming.revision === current.revision) return incoming.digest === current.digest ? "same" : "conflict";
  return "newer";
}
function assertPinSyncTransition(current, incoming, adopt = false) {
  const relation = pinSyncRelation(current, incoming);
  if (relation === "stale") fail("Это старая версия PIN. Выберите свежий файл из основного Admin");
  if (["different", "conflict"].includes(relation) && !adopt) fail("Подтвердите выбор файла как общего набора PIN");
  return relation;
}
function previewPinTransfer(payload, targets, currentSync) {
  const rows = payload.doctors.map(source => {
    const canonical = targets.filter(target => target.syncId === source.syncId);
    const exact = targets.filter(target => target.doctorId === source.doctorId && normalized(target.displayName) === normalized(source.displayName));
    const names = targets.filter(target => normalized(target.displayName) === normalized(source.displayName));
    const scoped = names.filter(target => normalized(target.department) === normalized(source.department) && normalized(target.specialization) === normalized(source.specialization));
    const candidates = canonical.length ? canonical : exact.length ? exact : scoped.length ? scoped : names;
    const target = candidates.length === 1 ? candidates[0] : null;
    return { syncId: source.syncId, sourceName: source.displayName, sourceDoctorId: source.doctorId, department: source.department, specialization: source.specialization,
      targetId: target?.doctorId || "", candidateIds: candidates.map(item => item.doctorId),
      status: !target ? candidates.length ? "ambiguous" : "missing" : target.pinHash === source.pinHash && target.pinSalt === source.pinSalt ? "same" : "changed",
      ...(source.pin == null ? {} : { pin: source.pin, currentPin: target?.pin || "" }) };
  });
  const selected = rows.map(row => row.targetId).filter(Boolean);
  for (const row of rows) if (row.targetId && selected.filter(id => id === row.targetId).length > 1) { row.targetId = ""; row.status = "ambiguous"; }
  return { sync: payload.sync, currentSync: currentSync || null, relation: pinSyncRelation(currentSync, payload.sync), hasAdmin: Boolean(payload.admin), rows,
    targets: targets.map(({ doctorId, displayName, department, specialization }) => ({ doctorId, displayName, department, specialization })) };
}
function resolvePinMappings(payload, targets, mapping) {
  if (!Array.isArray(mapping) || mapping.length !== payload.doctors.length) fail("Сопоставьте всех врачей файла PIN или явно пропустите отсутствующих");
  const sources = new Map(payload.doctors.map(doctor => [doctor.syncId, doctor]));
  const targetMap = new Map(targets.map(target => [target.doctorId, target]));
  const usedSources = new Set(), usedTargets = new Set(), changes = [];
  for (const item of mapping) {
    object(item, ["syncId", "targetId"]);
    if (!sources.has(item.syncId) || usedSources.has(item.syncId) || typeof item.targetId !== "string") fail("Некорректное сопоставление врачей");
    usedSources.add(item.syncId);
    if (!item.targetId) continue;
    if (!targetMap.has(item.targetId) || usedTargets.has(item.targetId)) fail("Один врач не может получить два PIN или отсутствует в базе");
    usedTargets.add(item.targetId); changes.push({ source: sources.get(item.syncId), target: targetMap.get(item.targetId) });
  }
  if (!changes.length) fail("Не выбран ни один врач для переноса PIN");
  return changes;
}
function cloudPinTargets(publication) {
  if (!publication || publication.version < 2) fail("Сначала загрузите отчёты с PIN из обновлённого Admin");
  return publication.accounts.filter(account => !account.admin).map(account => {
    const doctor = publication.doctors.find(item => item.doctorId === account.doctorId);
    return { ...doctor, syncId: account.pinSyncId, pinHash: account.pinHash, pinSalt: account.pinSalt };
  });
}
function previewCloudPins(publication, payload) {
  validatePinTransfer(payload, true);
  return previewPinTransfer(payload, cloudPinTargets(publication), publication.pinSync);
}
function applyCloudPins(publication, payload, { mapping, importAdmin = false, adopt = false } = {}) {
  validatePinTransfer(payload, true);
  assertPinSyncTransition(publication.pinSync, payload.sync, adopt);
  const targets = cloudPinTargets(publication), changes = resolvePinMappings(payload, targets, mapping);
  if (changes.length !== targets.length) fail("Сопоставьте всех врачей онлайн-публикации, чтобы сохранить единый набор PIN");
  if (importAdmin && !payload.admin) fail("В файле нет администраторского PIN");
  const selected = new Map(changes.map(({ source, target }) => [target.doctorId, source]));
  const candidate = { ...publication, pinSync: { ...payload.sync }, accounts: publication.accounts.map(account => {
    const source = account.admin ? importAdmin ? payload.admin : null : selected.get(account.doctorId);
    return source ? { ...account, pinHash: source.pinHash, pinSalt: source.pinSalt, pinParams: { ...source.pinParams },
      ...(account.admin ? {} : { pinSyncId: source.syncId }) } : { ...account };
  }) };
  return { publication: candidate, updated: changes.filter(({ source, target }) => source.pinHash !== target.pinHash || source.pinSalt !== target.pinSalt).length,
    adminChanged: importAdmin && publication.accounts.some(account => account.admin && (account.pinHash !== payload.admin.pinHash || account.pinSalt !== payload.admin.pinSalt)),
    repeated: JSON.stringify(candidate) === JSON.stringify(publication) };
}
function assertCloudPublicationPins(current, incoming) {
  if (!current?.pinSync) return;
  if (!incoming.pinSync) fail("Этот JSON не содержит версии PIN. Выгрузите отчёты из синхронизированного обновлённого Admin");
  if (["different", "conflict"].includes(pinSyncRelation(current.pinSync, incoming.pinSync))) fail("JSON относится к другому набору PIN. Сначала синхронизируйте Admin и обновите только PIN онлайн, затем выгрузите отчёты заново");
  const relation = assertPinSyncTransition(current.pinSync, incoming.pinSync);
  if (relation === "same") {
    const previousAdmin = current.accounts.find(account => account.admin), nextAdmin = incoming.accounts.find(account => account.admin);
    if (previousAdmin && nextAdmin && (previousAdmin.pinHash !== nextAdmin.pinHash || previousAdmin.pinSalt !== nextAdmin.pinSalt)) fail("Администраторский PIN изменён без новой версии. Синхронизируйте его отдельно перед загрузкой отчётов");
    const old = new Map(current.accounts.filter(account => !account.admin).map(account => [account.pinSyncId, account]));
    if (incoming.accounts.some(account => {
      const prior = old.get(account.pinSyncId);
      return prior && (prior.pinHash !== account.pinHash || prior.pinSalt !== account.pinSalt);
    })) fail("PIN в JSON отличаются от набора с той же версией");
  }
}
module.exports = { TRANSFER_FORMAT, CLOUD_PIN_FORMAT, MAX_PIN_BYTES, PIN_PARAMS, validatePinSync, validatePinTransfer,
  pinDigest, cloudPinsFromTransfer, encryptPinTransfer, decryptPinTransfer, previewPinTransfer, resolvePinMappings,
  pinSyncRelation, assertPinSyncTransition, previewCloudPins, applyCloudPins, assertCloudPublicationPins };
