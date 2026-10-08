"use strict";
const crypto = require("node:crypto");
const COOKIE = "klinvekt_cloud_session";
const SESSION_TTL = 12 * 60 * 60 * 1000;
const LOCK_TTL = 15 * 60 * 1000;
const MAX_SESSIONS = 2000;
const error = (message, statusCode) => Object.assign(new Error(message), { statusCode });

function createCloudAuth({ trustLocal = false, now = Date.now, maxSessions = MAX_SESSIONS } = {}) {
  const sessions = new Map(), failures = new Map(), queue = [];
  let active = 0;
  const key = identity => JSON.stringify([identity.portalId, identity.userId]);
  const cookie = request => String(request.headers.cookie || "").split(";").map(part => part.trim())
    .find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || "";
  const sessionToken = request => String(request.headers["x-klinvekt-cloud-session"] || cookie(request));
  const setCookie = (response, token = "") => response.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/api/cloud; HttpOnly; Max-Age=${token ? SESSION_TTL / 1000 : 0}; ${trustLocal ? "SameSite=Strict" : "SameSite=None; Secure; Partitioned"}`);
  const clean = () => {
    const time = now();
    for (const [token, session] of sessions) if (session.expiresAt <= time) sessions.delete(token);
    for (const [id, failure] of failures) if (failure.expiresAt <= time) failures.delete(id);
  };
  const current = (request, identity) => {
    clean(); const session = sessions.get(sessionToken(request));
    return session?.identity === key(identity) ? session.accountId : "";
  };
  const logout = (request, response, identity) => {
    const token = sessionToken(request);
    if (sessions.get(token)?.identity === key(identity)) sessions.delete(token);
    setCookie(response);
  };
  // Async scrypt is bounded; neither slow logins nor a burst allocate unlimited KDFs.
  const derive = (pin, account) => new Promise((resolve, reject) => {
    const run = () => {
      active++;
      crypto.scrypt(pin, Buffer.from(account.pinSalt, "base64"), 64,
        { ...account.pinParams, maxmem: 64 * 1024 * 1024 }, (err, bytes) => {
          active--; const next = queue.shift(); if (next) next();
          if (err) reject(err); else resolve(bytes);
        });
    };
    if (active < 2) run();
    else if (queue.length < 32) queue.push(run);
    else reject(error("Много попыток входа. Повторите позже", 503));
  });
  async function login(request, response, identity, input, getPublication) {
    clean(); logout(request, response, identity);
    const id = key(identity), failure = failures.get(id);
    if (failure?.lockedUntil > now()) throw error("Слишком много неверных PIN. Повторите через 15 минут", 429);
    if (failures.size >= MAX_SESSIONS && !failure) throw error("Много попыток входа. Повторите позже", 503);
    const publication = getPublication();
    const account = publication.accounts.find(item => item.accountId === input.accountId);
    const validShape = typeof input.pin === "string" && (account?.admin ? /^\d{6,12}$/ : /^\d{4}$/).test(input.pin);
    const hash = account && validShape ? await derive(input.pin, account) : null;
    if (getPublication() !== publication) throw error("Отчёты обновились. Повторите вход", 409);
    if (!hash || !crypto.timingSafeEqual(hash, Buffer.from(account.pinHash, "base64"))) {
      const next = failures.get(id) || { count: 0, expiresAt: now() + LOCK_TTL };
      next.count++;
      if (next.count >= 5) { next.lockedUntil = now() + LOCK_TTL; next.expiresAt = next.lockedUntil; }
      failures.set(id, next);
      throw error(next.lockedUntil ? "Слишком много неверных PIN. Повторите через 15 минут" : "Неверный PIN", next.lockedUntil ? 429 : 401);
    }
    // Concurrent attempts recheck the lock and capacity after the async KDF.
    if (failures.get(id)?.lockedUntil > now()) throw error("Слишком много неверных PIN. Повторите через 15 минут", 429);
    clean();
    const ownTokens = [...sessions].filter(([, session]) => session.identity === id).map(([token]) => token);
    if (sessions.size - ownTokens.length >= maxSessions) throw error("Лимит сессий достигнут. Повторите позже", 503);
    ownTokens.forEach(token => sessions.delete(token)); failures.delete(id);
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { identity: id, accountId: account.accountId, expiresAt: now() + SESSION_TTL });
    setCookie(response, token);
    // The independent clinical token also supports browsers which block cookies
    // in Bitrix iframes. The client holds it only in memory; gateway secrets stay server-side.
    return { account, sessionToken: token };
  }
  return { current, login, logout, revoke: () => sessions.clear() };
}
module.exports = { createCloudAuth };
