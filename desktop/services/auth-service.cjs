"use strict";

const crypto = require("node:crypto");

const SESSION_IDLE_MS = 10 * 60 * 1000;
const PASSWORD_PARAMS = Object.freeze({ N: 32768, r: 8, p: 1, keylen: 64 });

function normalizeUsername(value) {
  return String(value || "").trim().toLocaleLowerCase("ru-RU");
}

function validatePassword(password) {
  const value = String(password || "");
  if (!value.length) throw new Error("Пароль не может быть пустым");
  return value;
}

function doctorUsername(displayName, database) {
  const surname = String(displayName || "")
    .trim()
    .split(/\s+/)[0]
    .toLocaleLowerCase("ru-RU")
    .replace(/[^a-zа-яё0-9_-]+/gi, "")
    .slice(0, 40);
  if (!surname) throw new Error("Не удалось сформировать логин из фамилии врача");
  let username = surname;
  let suffix = 2;
  while (database.getUserByUsername(username)) {
    const number = String(suffix++);
    username = `${surname.slice(0, Math.max(1, 40 - number.length))}${number}`;
  }
  return username;
}

function temporaryPassword() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function passwordRecord(password) {
  const value = validatePassword(password);
  const salt = crypto.randomBytes(24);
  const params = PASSWORD_PARAMS;
  const hash = crypto.scryptSync(value, salt, params.keylen, {
    N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024,
  });
  return {
    passwordHash: hash.toString("base64"),
    passwordSalt: salt.toString("base64"),
    passwordParams: JSON.stringify(params),
  };
}

function verifyPassword(password, user) {
  try {
    const params = JSON.parse(user.password_params);
    const salt = Buffer.from(user.password_salt, "base64");
    const expected = Buffer.from(user.password_hash, "base64");
    const actual = crypto.scryptSync(String(password || ""), salt, params.keylen, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: 64 * 1024 * 1024,
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch (_) {
    return false;
  }
}

class AuthService {
  constructor({ database, logger = () => {} }) {
    this.database = database;
    this.logger = logger;
    this.session = null;
  }

  status() {
    const needsSetup = !this.database.hasUsers();
    const session = this.#activeSession();
    const user = session ? this.database.getUserById(session.userId) : null;
    if (session && (!user || !user.active)) this.session = null;
    return {
      needsSetup,
      authenticated: Boolean(session && user && user.active),
      user: session && user && user.active ? this.#publicUser(user) : null,
      idleTimeoutMs: SESSION_IDLE_MS,
    };
  }

  setupAdmin({ username, displayName, password }) {
    if (this.database.hasUsers()) throw new Error("Администратор уже создан");
    const normalized = normalizeUsername(username);
    if (!/^[a-zа-яё0-9._-]{3,40}$/i.test(normalized)) throw new Error("Некорректный логин администратора");
    const user = this.database.createUser({
      username: normalized,
      displayName: String(displayName || "Администратор").trim(),
      role: "admin",
      ...passwordRecord(password),
    });
    this.database.audit({ actorUserId: user.id, action: "auth.admin-created", targetType: "user", targetId: String(user.id) });
    return this.#startSession(user);
  }

  login({ username = null, userId = null, password }) {
    const user = userId != null ? this.database.getUserById(userId) : this.database.getUserByUsername(normalizeUsername(username));
    if (!user || !user.active) throw new Error("Неверный пользователь или пароль");
    if (user.locked_until && Date.parse(user.locked_until) > Date.now()) {
      throw new Error("Вход временно заблокирован после нескольких ошибок");
    }
    if (!verifyPassword(password, user)) {
      const nextFailures = Number(user.failed_attempts || 0) + 1;
      this.database.recordLoginFailure(user.id, { lock: nextFailures >= 5 });
      this.database.audit({ actorUserId: user.id, action: "auth.login-failed", targetType: "user", targetId: String(user.id) });
      throw new Error(nextFailures >= 5
        ? "Вход заблокирован на 15 минут после пяти ошибок"
        : "Неверный пользователь или пароль");
    }
    const updated = this.database.recordLoginSuccess(user.id);
    this.database.audit({ actorUserId: user.id, action: "auth.login", targetType: "user", targetId: String(user.id) });
    return this.#startSession(updated);
  }

  logout() {
    if (this.session) {
      try {
        this.database.audit({ actorUserId: this.session.userId, action: "auth.logout", targetType: "user", targetId: String(this.session.userId) });
      } catch (_) { /* restored databases may not contain the previous user */ }
    }
    this.session = null;
    return this.status();
  }

  invalidateSession() {
    this.session = null;
    return this.status();
  }

  changePassword({ currentPassword, newPassword }) {
    const session = this.require();
    const user = this.database.getUserById(session.userId);
    if (!verifyPassword(currentPassword, user)) throw new Error("Текущий пароль указан неверно");
    this.database.updateUserPassword(user.id, { ...passwordRecord(newPassword), mustChangePassword: false });
    this.database.audit({ actorUserId: user.id, action: "auth.password-changed", targetType: "user", targetId: String(user.id) });
    return this.#publicUser(this.database.getUserById(user.id));
  }

  createDoctorUser({ doctorId, displayName, password = null }) {
    const admin = this.require("admin");
    const normalized = doctorUsername(displayName, this.database);
    const issuedPassword = password == null ? temporaryPassword() : validatePassword(password);
    const user = this.database.createUser({
      username: normalized,
      displayName,
      role: "doctor",
      doctorId,
      ...passwordRecord(issuedPassword),
      mustChangePassword: true,
    });
    this.database.audit({ actorUserId: admin.userId, action: "user.doctor-created", targetType: "doctor", targetId: doctorId, details: { userId: user.id } });
    return Object.assign(this.#publicUser(user), { temporaryPassword: issuedPassword });
  }

  resetPassword({ userId, password = null }) {
    const admin = this.require("admin");
    const user = this.database.getUserById(userId);
    if (!user || user.role !== "doctor") throw new Error("Учётная запись врача не найдена");
    const issuedPassword = password == null ? temporaryPassword() : validatePassword(password);
    const updated = this.database.updateUserPassword(user.id, { ...passwordRecord(issuedPassword), mustChangePassword: true });
    this.database.audit({ actorUserId: admin.userId, action: "user.password-reset", targetType: "user", targetId: String(user.id) });
    return Object.assign(this.#publicUser(updated), { temporaryPassword: issuedPassword });
  }

  setActive({ userId, active }) {
    const admin = this.require("admin");
    const user = this.database.getUserById(userId);
    if (!user || user.role !== "doctor") throw new Error("Учётная запись врача не найдена");
    const updated = this.database.setUserActive(user.id, active);
    this.database.audit({ actorUserId: admin.userId, action: active ? "user.activated" : "user.deactivated", targetType: "user", targetId: String(user.id) });
    return this.#publicUser(updated);
  }

  require(role = null) {
    const session = this.#activeSession();
    if (!session) throw new Error("Сессия истекла. Войдите снова.");
    const user = this.database.getUserById(session.userId);
    if (!user || !user.active || (role && user.role !== role)) throw new Error("Недостаточно прав");
    session.lastActivityAt = Date.now();
    return Object.assign({}, session, { user: this.#publicUser(user) });
  }

  requireDoctorReady() {
    const session = this.require("doctor");
    if (session.user.mustChangePassword) {
      throw new Error("Перед просмотром отчётов необходимо заменить временный пароль");
    }
    return session;
  }

  #activeSession() {
    if (!this.session) return null;
    if (Date.now() - this.session.lastActivityAt > SESSION_IDLE_MS) {
      this.session = null;
      return null;
    }
    return this.session;
  }

  #startSession(user) {
    this.session = {
      id: crypto.randomUUID(),
      userId: Number(user.id),
      role: user.role,
      doctorId: user.doctor_id || null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    return this.status();
  }

  #publicUser(user) {
    if (!user) return null;
    return {
      id: Number(user.id),
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      doctorId: user.doctor_id,
      active: Boolean(user.active),
      mustChangePassword: Boolean(user.must_change_password),
    };
  }
}

module.exports = {
  AuthService,
  SESSION_IDLE_MS,
  PASSWORD_PARAMS,
  normalizeUsername,
  doctorUsername,
  temporaryPassword,
  validatePassword,
  passwordRecord,
  verifyPassword,
};
