"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const servicePath = fs.existsSync(path.join(__dirname, "cloud-publication-service.cjs"))
  ? "./cloud-publication-service.cjs" : "../desktop/services/cloud-publication-service.cjs";
const { validateCloudPublication, visibleCloudPages, MAX_CLOUD_BYTES } = require(servicePath);
const CHUNK_BYTES = 512 * 1024;
const TTL = 20 * 60 * 1000;
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function createCloudRoutes({ dataDir, portalId, publisherKeyIds = [], sendJson, readBody, readJson, securityHeaders, isAdminRole }) {
  const filePath = path.join(dataDir, "publications.kvcloud");
  let publication = null;
  if (fs.existsSync(filePath)) {
    if (fs.statSync(filePath).size > MAX_CLOUD_BYTES + 1024) throw error("Сохранённая облачная публикация слишком велика");
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!portalId || stored.portalId !== portalId) throw error("Сохранённая облачная публикация принадлежит другому порталу");
    publication = validateCloudPublication(stored.publication);
  }
  const uploads = new Map(), completed = new Map();
  const allowedKeys = new Set(publisherKeyIds);
  const clean = () => {
    for (const [id, upload] of uploads) if (!upload.busy && upload.expiresAt <= Date.now()) {
      fs.rmSync(upload.filePath, { force: true }); uploads.delete(id);
    }
    for (const [id, item] of completed) if (item.expiresAt <= Date.now()) completed.delete(id);
  };
  const publisher = request => {
    const headers = request.headers;
    if (!portalId || headers["x-vibe-caller-kind"] !== "external-api" || headers["x-vibe-caller-portal-id"] !== portalId
      || !allowedKeys.has(headers["x-vibe-caller-key-id"])) throw error("Ключ не разрешён для публикации КлинВекта", 403);
    return String(headers["x-vibe-caller-key-id"]);
  };
  const requireUser = (request, identity) => {
    if (request.headers["x-vibe-caller-kind"]) throw error("Внешний API не предоставляет доступ к отчётам", 403);
    if (!identity || !portalId || identity.portalId !== portalId || !/^[1-9]\d*$/.test(identity.userId)) throw error("Откройте КлинВект из своего портала Битрикс24", 401);
  };
  const canUpload = identity => publication
    ? publication.accounts.some(account => account.userId === identity.userId && account.admin)
    : isAdminRole(identity.role);
  const manualPublisher = (request, identity) => {
    requireUser(request, identity);
    // A custom header forces cross-origin requests through an unsupported CORS
    // preflight. Portal identity alone must not authorize a cross-site upload.
    if (request.headers["x-klinvekt-cloud-upload"] !== "1" || !canUpload(identity)) throw error("Загрузка доступна только администратору КлинВекта", 403);
    return `user:${identity.portalId}:${identity.userId}`;
  };
  const ownedUpload = (id, key) => {
    const upload = uploads.get(id);
    if (!upload || upload.key !== key) throw error("Загрузка не найдена. Повторите отправку", 404);
    if (upload.busy) throw error("Порция уже обрабатывается", 409);
    upload.expiresAt = Date.now() + TTL;
    return upload;
  };
  async function handle(request, response, url, identity) {
    clean();
    const manual = url.pathname.startsWith("/api/cloud/manual/");
    const uploadMatch = /^\/api\/cloud\/(?:publications|manual)\/uploads\/([a-f0-9-]+)(?:\/(complete)|\/chunks\/(\d+))?$/.exec(url.pathname);
    if (["/api/cloud/publications/uploads", "/api/cloud/manual/uploads"].includes(url.pathname) && request.method === "POST") {
      const key = manual ? manualPublisher(request, identity) : publisher(request);
      const input = await readJson(request, 16384);
      if (!Number.isInteger(input.bytes) || input.bytes < 1 || input.bytes > MAX_CLOUD_BYTES || !/^[a-f0-9]{64}$/.test(input.sha256)) throw error("Некорректный размер/хеш пакета");
      const existing = [...uploads.values()].find(upload => upload.key === key && upload.sha256 === input.sha256 && upload.bytes === input.bytes);
      if (existing) { sendJson(response, 200, { ok: true, uploadId: existing.id, nextIndex: existing.nextIndex, chunkBytes: CHUNK_BYTES }); return; }
      if (uploads.size >= 4) throw error("Слишком много загрузок, повторите позже", 503);
      const id = crypto.randomUUID();
      const upload = { id, key, bytes: input.bytes, sha256: input.sha256, nextIndex: 0, hashes: [], received: 0,
        filePath: path.join(dataDir, `.cloud-upload-${id}.tmp`), expiresAt: Date.now() + TTL, busy: false };
      fs.writeFileSync(upload.filePath, "", { flag: "wx", mode: 0o600 }); uploads.set(id, upload);
      sendJson(response, 200, { ok: true, uploadId: id, nextIndex: 0, chunkBytes: CHUNK_BYTES }); return;
    }
    if (uploadMatch) {
      const key = manual ? manualPublisher(request, identity) : publisher(request), id = uploadMatch[1];
      if (request.method === "POST" && uploadMatch[2] && completed.get(id)?.key === key) {
        sendJson(response, 200, { ...completed.get(id).result, repeated: true }); return;
      }
      const upload = ownedUpload(id, key);
      if (request.method === "PUT" && uploadMatch[3] != null) {
        upload.busy = true;
        try {
          if (!String(request.headers["content-type"] || "").startsWith("application/octet-stream")) throw error("Ожидается двоичная порция", 415);
          const index = Number(uploadMatch[3]);
          const chunks = Math.ceil(upload.bytes / CHUNK_BYTES);
          if (index >= chunks || index > upload.nextIndex) throw error("Неверный порядок порций", 409);
          const bytes = await readBody(request, CHUNK_BYTES);
          const expected = index === chunks - 1 ? upload.bytes - index * CHUNK_BYTES : CHUNK_BYTES;
          const hash = sha256(bytes);
          if (bytes.length !== expected || hash !== request.headers["x-chunk-sha256"]) throw error("Повреждённая порция");
          if (index < upload.nextIndex) {
            if (upload.hashes[index] !== hash) throw error("Повторная порция отличается", 409);
          } else {
            await fs.promises.appendFile(upload.filePath, bytes);
            upload.hashes.push(hash); upload.nextIndex++; upload.received += bytes.length;
          }
          sendJson(response, 200, { ok: true, nextIndex: upload.nextIndex });
        } finally { upload.busy = false; }
        return;
      }
      if (request.method === "POST" && uploadMatch[2]) {
        upload.busy = true;
        try {
          if (upload.received !== upload.bytes) throw error("Не все порции получены", 409);
          const raw = await fs.promises.readFile(upload.filePath);
          if (sha256(raw) !== upload.sha256) throw error("Не совпадает контрольная сумма пакета");
          let value;
          try { value = JSON.parse(raw.toString("utf8")); } catch (_) { throw error("Пакет JSON повреждён"); }
          const validated = validateCloudPublication(value);
          if (manual && !validated.accounts.some(account => account.userId === identity.userId && account.admin)) {
            throw error(`В JSON должен быть указан ваш ID ${identity.userId} среди администраторов КлинВекта`);
          }
          // Persist first, then replace the in-memory publication. An invalid or
          // interrupted upload never discards the previous working publication.
          const candidatePath = `${upload.filePath}.validated`;
          await fs.promises.writeFile(candidatePath, JSON.stringify({ portalId, publication: validated }), { mode: 0o600 });
          try { await fs.promises.rename(candidatePath, filePath); }
          finally { await fs.promises.rm(candidatePath, { force: true }).catch(() => {}); }
          publication = validated; uploads.delete(id);
          const result = { ok: true, doctors: validated.doctors.length, pages: validated.pages.length, createdAt: validated.createdAt };
          completed.set(id, { key, result, expiresAt: Date.now() + TTL });
          await fs.promises.rm(upload.filePath, { force: true }).catch(() => {});
          sendJson(response, 200, result);
        } finally { upload.busy = false; }
        return;
      }
      throw error("Метод не поддерживается", 405);
    }
    // External API keys publish only. They cannot read reports or impersonate a
    // doctor, including when a caller supplies fake user headers.
    requireUser(request, identity);
    if (request.method === "GET" && url.pathname === "/api/cloud/admin") {
      sendJson(response, 200, { ok: true, userId: identity.userId, userName: identity.userName,
        canUpload: canUpload(identity), publicationAvailable: Boolean(publication) }); return;
    }
    if (!publication) throw error("Администратор ещё не загрузил отчёты", 409);
    const pages = visibleCloudPages(publication, identity.userId);
    if (!pages.length) throw error("Доступ не назначен. Обратитесь к администратору КлинВекта", 403);
    if (request.method === "GET" && url.pathname === "/api/cloud/context") {
      const cursor = Number(url.searchParams.get("cursor") || 0);
      if (!Number.isInteger(cursor) || cursor < 0 || cursor >= pages.length) throw error("Некорректная позиция каталога");
      const end = Math.min(cursor + 128, pages.length);
      sendJson(response, 200, { ok: true, userName: identity.userName, createdAt: publication.createdAt,
        pages: pages.slice(cursor, end).map(({ html, ...descriptor }) => descriptor),
        nextCursor: end < pages.length ? end : null }); return;
    }
    const pageMatch = /^\/api\/cloud\/pages\/([a-f0-9]{64})$/.exec(url.pathname);
    if (request.method === "GET" && pageMatch) {
      const page = pages.find(page => page.pageId === pageMatch[1]);
      if (!page) throw error("Нет доступа к этому отчёту", 403);
      securityHeaders(response);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end('<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
        + '<link rel="stylesheet" href="/mobile/online-report.css?v=2"><script src="/mobile/online-report.js?v=1" defer></script></head><body class="online-report">'
        + page.html + "</body></html>"); return;
    }
    throw error("API не найден", 404);
  }
  return { handle, filePath, configured: Boolean(portalId), get available() { return Boolean(publication); } };
}
module.exports = { createCloudRoutes, CHUNK_BYTES };
