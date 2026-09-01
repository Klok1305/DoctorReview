"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");

function loadPublicationService() {
  const candidates = [
    path.join(__dirname, "mobile-publication-service.cjs"),
    path.join(__dirname, "..", "desktop", "services", "mobile-publication-service.cjs"),
  ];
  const target = candidates.find(candidate => fs.existsSync(candidate));
  if (!target) throw new Error("Не найден модуль мобильных публикаций КлинВект");
  return require(target);
}

const {
  MAX_BUNDLE_BYTES,
  decryptMobilePublication,
  serializeMobilePublicationBundle,
  validateMobilePublicationBundle,
} = loadPublicationService();

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LOCK_MS = 15 * 60 * 1000;
const RATE_MAX_FAILURES = 5;
const MAX_SESSIONS = 2000;
const BUNDLE_FILE_NAME = "publications.kvmobilebundle";
const SESSION_COOKIE = "klinvekt_mobile_session";

const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8",
});

function isAdminRole(role) {
  const value = String(role || "").trim().toLowerCase();
  return value === "a" || value === "admin" || value === "administrator" || value === "owner"
    || value.includes("portal_admin") || value.includes("portal-admin") || value.includes("администратор");
}

function requestIdentity(request, { trustLocal = false, localRole = "admin" } = {}) {
  const userId = String(request.headers["x-vibe-user-id"] || "").trim();
  if (userId) {
    let userName = String(request.headers["x-vibe-user-name"] || "Сотрудник Битрикс24");
    const encodedUserName = String(request.headers["x-vibe-user-name-encoded"] || "");
    if (encodedUserName) {
      try { userName = decodeURIComponent(encodedUserName); } catch (_) { /* используем совместимый заголовок */ }
    }
    return {
      userId: userId.slice(0, 200),
      userName: userName.slice(0, 200),
      role: String(request.headers["x-vibe-user-role"] || "").slice(0, 100),
      portalId: String(request.headers["x-vibe-portal-id"] || "").slice(0, 200),
    };
  }
  if (!trustLocal) return null;
  return { userId: "local-developer", userName: "Локальный администратор", role: localRole, portalId: "local" };
}

function cookieValue(request, name) {
  const source = String(request.headers.cookie || "");
  for (const part of source.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function securityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'self' https://vibecode.bitrix24.tech https://*.bitrix24.ru https://*.bitrix24.com https://*.bitrix24.kz https://*.bitrix24.by");
}

function sendJson(response, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  securityHeaders(response);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    ...headers,
  });
  response.end(body);
}

function readBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(Object.assign(new Error("Файл слишком большой"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function readJson(request, maxBytes) {
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    throw Object.assign(new Error("Ожидается JSON"), { statusCode: 415 });
  }
  const body = await readBody(request, maxBytes);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch (_) {
    throw Object.assign(new Error("JSON повреждён"), { statusCode: 400 });
  }
}

function publicDoctors(bundle) {
  return bundle ? bundle.doctors.map(entry => ({
    doctorId: entry.doctorId,
    displayName: entry.displayName,
    department: entry.department,
    periods: entry.periods,
  })) : [];
}

function loadBundle(bundlePath) {
  if (!fs.existsSync(bundlePath)) return null;
  const stat = fs.statSync(bundlePath);
  if (!stat.isFile() || stat.size > MAX_BUNDLE_BYTES) throw new Error("Сохранённый мобильный пакет повреждён или слишком велик");
  return validateMobilePublicationBundle(JSON.parse(fs.readFileSync(bundlePath, "utf8")));
}

function createMobileServer(options = {}) {
  const trustLocal = options.trustLocal === true;
  const staticRoot = path.resolve(options.staticRoot || (fs.existsSync(path.join(__dirname, "public"))
    ? path.join(__dirname, "public")
    : path.join(__dirname, "..", "mobile-pilot")));
  const dataDir = path.resolve(options.dataDir || process.env.KLINVEKT_DATA_DIR || path.join(__dirname, "data"));
  const bundlePath = path.join(dataDir, BUNDLE_FILE_NAME);
  fs.mkdirSync(dataDir, { recursive: true });

  const state = {
    bundle: loadBundle(bundlePath),
    sessions: new Map(),
    failures: new Map(),
  };

  function cleanState(now = Date.now()) {
    for (const [token, session] of state.sessions) if (session.expiresAt <= now) state.sessions.delete(token);
    for (const [key, rate] of state.failures) {
      rate.failures = rate.failures.filter(time => now - time <= RATE_WINDOW_MS);
      if ((!rate.lockedUntil || rate.lockedUntil <= now) && !rate.failures.length) state.failures.delete(key);
    }
  }

  function sessionFor(request, identity) {
    const token = cookieValue(request, SESSION_COOKIE);
    const session = token && state.sessions.get(token);
    if (!session || session.userId !== identity.userId || session.expiresAt <= Date.now()) return null;
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return { token, session };
  }

  function rateKey(identity, doctorId) {
    return `${identity.portalId}:${identity.userId}:${doctorId}`;
  }

  function checkRateLimit(key) {
    const now = Date.now();
    const rate = state.failures.get(key);
    if (!rate) return 0;
    rate.failures = rate.failures.filter(time => now - time <= RATE_WINDOW_MS);
    return rate.lockedUntil && rate.lockedUntil > now ? rate.lockedUntil - now : 0;
  }

  function recordFailure(key) {
    const now = Date.now();
    const rate = state.failures.get(key) || { failures: [], lockedUntil: 0 };
    rate.failures = rate.failures.filter(time => now - time <= RATE_WINDOW_MS);
    rate.failures.push(now);
    if (rate.failures.length >= RATE_MAX_FAILURES) rate.lockedUntil = now + RATE_LOCK_MS;
    state.failures.set(key, rate);
  }

  function saveBundle(bundle) {
    const serialized = serializeMobilePublicationBundle(bundle);
    const temporaryPath = path.join(dataDir, `${BUNDLE_FILE_NAME}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
    try {
      fs.writeFileSync(temporaryPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      fs.renameSync(temporaryPath, bundlePath);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
    state.bundle = bundle;
  }

  async function handleApi(request, response, url, identity) {
    if (!identity) {
      sendJson(response, 401, { error: "Откройте приложение из своей учётной записи Битрикс24" });
      return;
    }
    cleanState();
    const activeSession = sessionFor(request, identity);

    if (request.method === "GET" && url.pathname === "/api/context") {
      sendJson(response, 200, {
        user: { name: identity.userName },
        canUpload: isAdminRole(identity.role),
        sessionActive: Boolean(activeSession),
        publication: state.bundle ? {
          createdAt: state.bundle.createdAt,
          appVersion: state.bundle.appVersion || "",
          doctors: state.bundle.doctors.length,
        } : null,
        doctors: publicDoctors(state.bundle),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/publications") {
      if (!isAdminRole(identity.role)) {
        sendJson(response, 403, { error: "Загрузка доступна только администратору портала" });
        return;
      }
      const bundle = validateMobilePublicationBundle(await readJson(request, MAX_BUNDLE_BYTES));
      saveBundle(bundle);
      state.sessions.clear();
      sendJson(response, 200, { ok: true, doctors: bundle.doctors.length, createdAt: bundle.createdAt });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/login") {
      if (!state.bundle) {
        sendJson(response, 409, { error: "Администратор ещё не загрузил отчёты" });
        return;
      }
      const input = await readJson(request, 16 * 1024);
      const doctorId = String(input && input.doctorId || "").slice(0, 200);
      const pin = String(input && input.pin || "");
      const entry = state.bundle.doctors.find(item => item.doctorId === doctorId);
      if (!entry || !/^\d{4}$/.test(pin)) {
        sendJson(response, 401, { error: "Неверно выбран врач или указан PIN" });
        return;
      }
      const key = rateKey(identity, doctorId);
      const retryAfterMs = checkRateLimit(key);
      if (retryAfterMs > 0) {
        sendJson(response, 429, { error: "Слишком много попыток. Повторите вход позже" }, { "Retry-After": Math.ceil(retryAfterMs / 1000) });
        return;
      }
      let publication;
      try {
        publication = decryptMobilePublication(entry, pin);
      } catch (_) {
        recordFailure(key);
        sendJson(response, 401, { error: "Неверно выбран врач или указан PIN" });
        return;
      }
      state.failures.delete(key);
      for (const [token, session] of state.sessions) if (session.userId === identity.userId) state.sessions.delete(token);
      if (state.sessions.size >= MAX_SESSIONS) cleanState(Date.now() + SESSION_TTL_MS);
      const token = crypto.randomBytes(32).toString("base64url");
      state.sessions.set(token, {
        userId: identity.userId,
        doctorId,
        publication,
        expiresAt: Date.now() + SESSION_TTL_MS,
      });
      const cookieSecurity = trustLocal ? "SameSite=Strict" : "SameSite=None; Secure; Partitioned";
      sendJson(response, 200, { ok: true, publication }, {
        "Set-Cookie": `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; ${cookieSecurity}; Max-Age=${SESSION_TTL_MS / 1000}`,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/report") {
      if (!activeSession) {
        sendJson(response, 401, { error: "Введите PIN врача" });
        return;
      }
      sendJson(response, 200, { publication: activeSession.session.publication });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/logout") {
      if (activeSession) state.sessions.delete(activeSession.token);
      const cookieSecurity = trustLocal ? "SameSite=Strict" : "SameSite=None; Secure; Partitioned";
      sendJson(response, 200, { ok: true }, {
        "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; ${cookieSecurity}; Max-Age=0`,
      });
      return;
    }

    sendJson(response, 404, { error: "API не найден" });
  }

  function serveStatic(request, response, url) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Метод не поддерживается" });
      return;
    }
    if (url.pathname === "/") {
      response.writeHead(302, { Location: "/mobile/", "Cache-Control": "no-store" });
      response.end();
      return;
    }
    let relative = url.pathname.startsWith("/mobile/") ? url.pathname.slice("/mobile/".length) : "";
    if (url.pathname === "/mobile" || url.pathname === "/mobile/") relative = "index.html";
    if (!relative) {
      sendJson(response, 404, { error: "Страница не найдена" });
      return;
    }
    try {
      relative = decodeURIComponent(relative);
    } catch (_) {
      sendJson(response, 400, { error: "Некорректный адрес" });
      return;
    }
    const target = path.resolve(staticRoot, relative);
    if (target !== staticRoot && !target.startsWith(`${staticRoot}${path.sep}`)) {
      sendJson(response, 404, { error: "Страница не найдена" });
      return;
    }
    let stat;
    try {
      stat = fs.statSync(target);
    } catch (_) {
      sendJson(response, 404, { error: "Страница не найдена" });
      return;
    }
    if (!stat.isFile()) {
      sendJson(response, 404, { error: "Страница не найдена" });
      return;
    }
    const extension = path.extname(target).toLowerCase();
    securityHeaders(response);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": ["index.html", "service-worker.js", "manifest.webmanifest"].includes(path.basename(target))
        ? "no-cache"
        : "public, max-age=86400",
    });
    if (request.method === "HEAD") response.end();
    else fs.createReadStream(target).pipe(response);
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    try {
      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response, url, requestIdentity(request, { trustLocal, localRole: options.localRole }));
      } else {
        serveStatic(request, response, url);
      }
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, Number(error && error.statusCode) || 400, { error: error && error.message || "Не удалось выполнить запрос" });
    }
  });

  server.klinvekt = { bundlePath, dataDir, staticRoot, state };
  return server;
}

if (require.main === module) {
  const trustLocal = process.argv.includes("--local");
  const portArgument = process.argv.find(argument => argument.startsWith("--port="));
  const port = Number(portArgument ? portArgument.slice("--port=".length) : (process.env.PORT || 3000));
  const host = trustLocal ? "127.0.0.1" : "0.0.0.0";
  const server = createMobileServer({ trustLocal });
  server.listen(port, host, () => {
    process.stdout.write(`КлинВект mobile server: http://${host}:${port}/mobile/\n`);
  });
}

module.exports = {
  BUNDLE_FILE_NAME,
  RATE_MAX_FAILURES,
  SESSION_COOKIE,
  createMobileServer,
  isAdminRole,
  requestIdentity,
};
