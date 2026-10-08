"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

class CloudConnectionStore {
  constructor(userDataDir, safeStorage) {
    this.filePath = path.join(userDataDir, "cloud-connection.json");
    this.safeStorage = safeStorage;
    this.value = {};
    if (fs.existsSync(this.filePath)) {
      try {
        const value = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
        if (value && typeof value.applicationId === "string" && typeof value.encryptedKey === "string") this.value = value;
      } catch (_) { /* A damaged connection must not prevent opening the local Admin. */ }
    }
  }
  publicSettings() { return { applicationId: this.value.applicationId || "", keyConfigured: Boolean(this.value.encryptedKey) }; }
  save({ applicationId, apiKey }) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(String(applicationId || ""))) throw new Error("Укажите ID приложения Вайбкод");
    let encryptedKey = this.value.encryptedKey;
    if (apiKey) {
      if (typeof apiKey !== "string" || apiKey.length > 2000 || /[\r\n]/.test(apiKey)) throw new Error("Некорректный ключ внешнего API");
      if (!this.safeStorage.isEncryptionAvailable()) throw new Error("Windows не предоставляет защищённое хранение ключа");
      encryptedKey = this.safeStorage.encryptString(apiKey).toString("base64");
    } else if (this.value.applicationId && applicationId !== this.value.applicationId) {
      throw new Error("При смене приложения укажите его ключ внешнего API");
    }
    if (!encryptedKey) throw new Error("Укажите ключ внешнего API приложения");
    const value = { applicationId, encryptedKey };
    fs.writeFileSync(`${this.filePath}.tmp`, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(`${this.filePath}.tmp`, this.filePath);
    this.value = value;
    return this.publicSettings();
  }
  credentials() {
    if (!this.value.encryptedKey) throw new Error("Сначала сохраните подключение к облаку в настройках");
    return { applicationId: this.value.applicationId,
      apiKey: this.safeStorage.decryptString(Buffer.from(this.value.encryptedKey, "base64")) };
  }
}

async function publishCloudPublication(serialized, connection, { signal, onProgress = () => {},
  fetchImpl = fetch, baseUrl = "https://vibecode.bitrix24.tech/v1/applications", timeoutMs = 35000, paceMs = 550, resumeState } = {}) {
  const hash = buffer => crypto.createHash("sha256").update(buffer).digest("hex");
  if (resumeState) {
    const publication = JSON.parse(serialized);
    const identity = hash(Buffer.from(JSON.stringify({ ...publication, createdAt: "" })));
    // Rebuilding an unchanged snapshot after cancel/network failure changes its
    // timestamp. Keep the original timestamp so the server can resume its chunks.
    if (resumeState.identity === identity && resumeState.applicationId === connection.applicationId) publication.createdAt = resumeState.createdAt;
    else Object.assign(resumeState, { identity, applicationId: connection.applicationId, createdAt: publication.createdAt });
    serialized = JSON.stringify(publication);
  }
  const bytes = Buffer.from(serialized, "utf8");
  const prefix = `${baseUrl}/${encodeURIComponent(connection.applicationId)}/api/api/cloud/publications/uploads`;
  const request = async (suffix, method, body, binary = false) => {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      let response;
      try {
        response = await fetchImpl(prefix + suffix, { method, redirect: "error", signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
          headers: { "X-Api-Key": connection.apiKey, "Content-Type": binary ? "application/octet-stream" : "application/json",
            ...(binary ? { "X-Chunk-Sha256": hash(body) } : {}) }, body: binary ? body : JSON.stringify(body) });
      } catch (_) {
        signal?.throwIfAborted();
        if (attempt >= 2) throw new Error("Связь с облаком прервана. Повторите отправку: принятые порции будут продолжены");
        await delay(700 * (attempt + 1), undefined, { signal }); continue;
      }
      let data;
      try { data = await response.json(); } catch (_) { throw new Error(`Облако вернуло неожиданный ответ (HTTP ${response.status})`); }
      if (response.ok && data.ok === true) return data;
      if ([429, 503].includes(response.status) && attempt < 2) {
        const seconds = Number(response.headers.get("retry-after"));
        if (seconds > 30) throw new Error("Облако временно недоступно. Повторите отправку позже");
        await delay(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000 * (attempt + 1), undefined, { signal }); continue;
      }
      const code = typeof data.error === "object" ? data.error?.code : "";
      throw new Error(code ? `Битрикс отклонил отправку: ${code}` : typeof data.error === "string" ? data.error : `Ошибка отправки (HTTP ${response.status})`);
    }
  };
  const upload = await request("", "POST", { bytes: bytes.length, sha256: hash(bytes) });
  if (!upload.uploadId || !Number.isInteger(upload.chunkBytes) || upload.chunkBytes < 1 || upload.chunkBytes > 1024 * 1024
    || !Number.isInteger(upload.nextIndex) || upload.nextIndex < 0) throw new Error("Облако вернуло некорректные параметры загрузки");
  const chunks = Math.ceil(bytes.length / upload.chunkBytes);
  if (upload.nextIndex > chunks) throw new Error("Некорректная позиция продолжения загрузки");
  for (let index = upload.nextIndex; index < chunks; index++) {
    onProgress({ stage: "upload", completed: index, total: chunks });
    await request(`/${encodeURIComponent(upload.uploadId)}/chunks/${index}`, "PUT", bytes.subarray(index * upload.chunkBytes, (index + 1) * upload.chunkBytes), true);
    if (paceMs) await delay(paceMs, undefined, { signal });
  }
  onProgress({ stage: "upload", completed: chunks, total: chunks });
  const result = await request(`/${encodeURIComponent(upload.uploadId)}/complete`, "POST", {});
  if (resumeState) delete resumeState.identity;
  return result;
}
module.exports = { CloudConnectionStore, publishCloudPublication };
