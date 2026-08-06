"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { backup, DatabaseSync } = require("node:sqlite");

const SCHEMA_VERSION = 4;
const SNAPSHOT_VERSION = 4;
const MIN_SNAPSHOT_VERSION = 1;

function stableJson(value) {
  return JSON.stringify(value == null ? null : value);
}

function contentHash(json) {
  return crypto.createHash("sha256").update(json, "utf8").digest("hex");
}

function parseJson(json, fallback) {
  try { return JSON.parse(json); } catch (_) { return fallback; }
}

function doctorLoginBase(displayName) {
  return String(displayName || "")
    .trim()
    .split(/\s+/)[0]
    .toLocaleLowerCase("ru-RU")
    .replace(/[^a-zа-яё0-9_-]+/gi, "")
    .slice(0, 40);
}

const VIEWER_PIN_PARAMS = Object.freeze({ N: 32768, r: 8, p: 1, keylen: 64 });

function viewerPinRecord(pin) {
  const salt = crypto.randomBytes(24);
  const hash = crypto.scryptSync(String(pin), salt, VIEWER_PIN_PARAMS.keylen, {
    N: VIEWER_PIN_PARAMS.N,
    r: VIEWER_PIN_PARAMS.r,
    p: VIEWER_PIN_PARAMS.p,
    maxmem: 64 * 1024 * 1024,
  });
  return {
    hash: hash.toString("base64"),
    salt: salt.toString("base64"),
    params: JSON.stringify(VIEWER_PIN_PARAMS),
  };
}

function randomViewerPin(used) {
  for (let attempt = 0; attempt < 20000; attempt++) {
    const pin = String(crypto.randomInt(0, 10000)).padStart(4, "0");
    if (pin !== "0000" && !used.has(pin)) return pin;
  }
  throw new Error("Не удалось подобрать уникальный PIN врача");
}

class DatabaseService {
  constructor(databasePath) {
    this.databasePath = null;
    this.db = null;
    this.open(databasePath);
  }

  open(databasePath) {
    if (this.db) this.close();
    this.databasePath = path.resolve(databasePath);
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    this.db = new DatabaseSync(this.databasePath, { timeout: 5000 });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    try {
      this.#migrate();
      this.#assertSnapshotCompatible();
    } catch (error) {
      try { this.db.close(); } catch (_) { /* preserve the validation error */ }
      this.db = null;
      throw error;
    }
  }

  close() {
    if (!this.db) return;
    try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (_) { /* already closing */ }
    this.db.close();
    this.db = null;
  }

  #transaction(action) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch (_) { /* original error is more useful */ }
      throw error;
    }
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const current = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version;
    if (current < 1) {
      this.#transaction(() => {
        this.db.exec(`
          CREATE TABLE app_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            data_json TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE doctors (
            id TEXT PRIMARY KEY,
            data_json TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE months (
            month_key TEXT PRIMARY KEY,
            data_json TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE app_meta (
            key TEXT PRIMARY KEY,
            data_json TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE source_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sha256 TEXT NOT NULL UNIQUE,
            original_path TEXT,
            file_name TEXT NOT NULL,
            byte_size INTEGER,
            modified_at TEXT,
            first_imported_at TEXT NOT NULL,
            last_imported_at TEXT NOT NULL,
            successful INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE import_batches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            total_files INTEGER NOT NULL DEFAULT 0,
            loaded_files INTEGER NOT NULL DEFAULT 0,
            error_files INTEGER NOT NULL DEFAULT 0,
            skipped_files INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            backup_path TEXT
          );
          CREATE TABLE import_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            batch_id INTEGER,
            source_file_id INTEGER,
            report_type TEXT,
            month_key TEXT,
            doctor_name TEXT,
            status TEXT NOT NULL,
            note TEXT,
            replaced INTEGER NOT NULL DEFAULT 0,
            imported_at TEXT NOT NULL,
            FOREIGN KEY(batch_id) REFERENCES import_batches(id),
            FOREIGN KEY(source_file_id) REFERENCES source_files(id)
          );
          CREATE TABLE export_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            month_key TEXT,
            kind TEXT NOT NULL,
            output_dir TEXT NOT NULL,
            requested_files INTEGER NOT NULL DEFAULT 0,
            written_files INTEGER NOT NULL DEFAULT 0,
            failed_files INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            details_json TEXT,
            started_at TEXT NOT NULL,
            finished_at TEXT
          );
          CREATE INDEX idx_import_events_month ON import_events(month_key, imported_at);
          CREATE INDEX idx_import_events_batch ON import_events(batch_id);
          CREATE INDEX idx_export_runs_month ON export_runs(month_key, started_at);
        `);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(1, new Date().toISOString());
      });
    }
    if (current < 2) {
      this.#transaction(() => {
        this.db.exec(`
          CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            display_name TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('admin', 'doctor')),
            doctor_id TEXT,
            password_hash TEXT NOT NULL,
            password_salt TEXT NOT NULL,
            password_params TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            must_change_password INTEGER NOT NULL DEFAULT 0,
            failed_attempts INTEGER NOT NULL DEFAULT 0,
            locked_until TEXT,
            last_login_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE UNIQUE INDEX idx_users_doctor
            ON users(doctor_id) WHERE doctor_id IS NOT NULL;

          CREATE TABLE comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope_type TEXT NOT NULL CHECK (scope_type IN ('department', 'specialization', 'doctor')),
            scope_id TEXT NOT NULL,
            period_key TEXT NOT NULL,
            block_key TEXT NOT NULL,
            body_html TEXT NOT NULL DEFAULT '',
            body_text TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
            author_user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            published_at TEXT,
            archived_at TEXT,
            UNIQUE(scope_type, scope_id, period_key, block_key),
            FOREIGN KEY(author_user_id) REFERENCES users(id)
          );
          CREATE INDEX idx_comments_context
            ON comments(period_key, scope_type, scope_id, block_key);

          CREATE TABLE comment_versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            comment_id INTEGER NOT NULL,
            version INTEGER NOT NULL,
            body_html TEXT NOT NULL,
            body_text TEXT NOT NULL,
            status TEXT NOT NULL,
            changed_by INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(comment_id, version),
            FOREIGN KEY(comment_id) REFERENCES comments(id),
            FOREIGN KEY(changed_by) REFERENCES users(id)
          );

          CREATE TABLE publications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            period_key TEXT NOT NULL,
            version INTEGER NOT NULL,
            created_by INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(period_key, version),
            FOREIGN KEY(created_by) REFERENCES users(id)
          );
          CREATE INDEX idx_publications_period
            ON publications(period_key, version DESC);

          CREATE TABLE published_pages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            publication_id INTEGER NOT NULL,
            doctor_id TEXT NOT NULL,
            page_type TEXT NOT NULL CHECK (page_type IN ('department', 'specialization', 'doctor')),
            scope_id TEXT NOT NULL,
            title TEXT NOT NULL,
            html TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(publication_id, doctor_id, page_type),
            FOREIGN KEY(publication_id) REFERENCES publications(id) ON DELETE CASCADE
          );
          CREATE INDEX idx_published_pages_doctor
            ON published_pages(doctor_id, page_type, publication_id);

          CREATE TABLE audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_user_id INTEGER,
            action TEXT NOT NULL,
            target_type TEXT,
            target_id TEXT,
            details_json TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY(actor_user_id) REFERENCES users(id)
          );
          CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
        `);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(2, new Date().toISOString());
      });
    }
    if (current < 3) {
      this.#transaction(() => {
        this.db.exec(`
          CREATE TABLE viewer_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            admin_pin_hash TEXT,
            admin_pin_salt TEXT,
            admin_pin_params TEXT,
            admin_pin_version INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
          );

          CREATE TABLE viewer_doctor_access (
            doctor_id TEXT PRIMARY KEY,
            active INTEGER NOT NULL DEFAULT 0,
            pin_code TEXT NOT NULL,
            pin_hash TEXT NOT NULL,
            pin_salt TEXT NOT NULL,
            pin_params TEXT NOT NULL,
            pin_version INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL
          );

          CREATE TABLE viewer_exports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            package_id TEXT NOT NULL UNIQUE,
            file_name TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            manifest_json TEXT NOT NULL,
            created_by INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(created_by) REFERENCES users(id)
          );
          CREATE INDEX idx_viewer_exports_created ON viewer_exports(created_at DESC);
        `);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(3, new Date().toISOString());
      });
    }
    if (current < 4) {
      this.#transaction(() => {
        this.db.exec(`
          CREATE TABLE viewer_doctor_access_v4 (
            doctor_id TEXT PRIMARY KEY,
            active INTEGER NOT NULL DEFAULT 0,
            pin_code TEXT NOT NULL,
            pin_hash TEXT NOT NULL,
            pin_salt TEXT NOT NULL,
            pin_params TEXT NOT NULL,
            pin_version INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL
          );
          INSERT INTO viewer_doctor_access_v4(
            doctor_id, active, pin_code, pin_hash, pin_salt, pin_params, pin_version, updated_at
          )
          SELECT doctor_id, active, pin_code, pin_hash, pin_salt, pin_params, pin_version, updated_at
          FROM viewer_doctor_access;
          DROP TABLE viewer_doctor_access;
          ALTER TABLE viewer_doctor_access_v4 RENAME TO viewer_doctor_access;
        `);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(4, new Date().toISOString());
      });
    }
    const finalVersion = this.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version;
    if (finalVersion !== SCHEMA_VERSION) {
      throw new Error(`Неподдерживаемая версия базы: ${finalVersion}`);
    }
  }

  #assertSnapshotCompatible() {
    const hasMeta = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_meta'").get();
    if (!hasMeta) return;
    const row = this.db.prepare("SELECT data_json FROM app_meta WHERE key = 'version'").get();
    if (!row) return;
    const version = Number(parseJson(row.data_json, null));
    if (!Number.isInteger(version) || version < MIN_SNAPSHOT_VERSION || version > SNAPSHOT_VERSION) {
      throw new Error(`Версия данных ${version || "не определена"} не поддерживается этой версией приложения (поддерживаются ${MIN_SNAPSHOT_VERSION}–${SNAPSHOT_VERSION})`);
    }
  }

  loadSnapshot() {
    const settingsRow = this.db.prepare("SELECT data_json FROM app_settings WHERE id = 1").get();
    if (!settingsRow) return null;
    const doctors = {};
    const months = {};
    for (const row of this.db.prepare("SELECT id, data_json FROM doctors ORDER BY id").all()) {
      doctors[row.id] = parseJson(row.data_json, {});
    }
    for (const row of this.db.prepare("SELECT month_key, data_json FROM months ORDER BY month_key").all()) {
      months[row.month_key] = parseJson(row.data_json, {});
    }
    const meta = {};
    for (const row of this.db.prepare("SELECT key, data_json FROM app_meta").all()) {
      meta[row.key] = parseJson(row.data_json, null);
    }
    return {
      version: Number(meta.version || 3),
      settings: parseJson(settingsRow.data_json, {}),
      doctors,
      months,
      dynamicNotes: meta.dynamicNotes && typeof meta.dynamicNotes === "object" ? meta.dynamicNotes : {},
      fileLog: Array.isArray(meta.fileLog) ? meta.fileLog : [],
    };
  }

  saveSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || !snapshot.settings || !snapshot.months || !snapshot.doctors) {
      throw new Error("Некорректный снимок базы");
    }
    const snapshotVersion = Number(snapshot.version);
    if (!Number.isInteger(snapshotVersion) || snapshotVersion < MIN_SNAPSHOT_VERSION || snapshotVersion > SNAPSHOT_VERSION) {
      throw new Error(`Неподдерживаемая версия данных: ${snapshot.version}`);
    }
    const now = new Date().toISOString();
    const upsertSettings = this.db.prepare(`
      INSERT INTO app_settings(id, data_json, content_hash, updated_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        data_json = excluded.data_json,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at
      WHERE app_settings.content_hash <> excluded.content_hash
    `);
    const upsertDoctor = this.db.prepare(`
      INSERT INTO doctors(id, data_json, content_hash, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        data_json = excluded.data_json,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at
      WHERE doctors.content_hash <> excluded.content_hash
    `);
    const upsertMonth = this.db.prepare(`
      INSERT INTO months(month_key, data_json, content_hash, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(month_key) DO UPDATE SET
        data_json = excluded.data_json,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at
      WHERE months.content_hash <> excluded.content_hash
    `);
    const upsertMeta = this.db.prepare(`
      INSERT INTO app_meta(key, data_json, content_hash, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        data_json = excluded.data_json,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at
      WHERE app_meta.content_hash <> excluded.content_hash
    `);

    this.#transaction(() => {
      const settingsJson = stableJson(snapshot.settings);
      upsertSettings.run(settingsJson, contentHash(settingsJson), now);

      const doctorIds = Object.keys(snapshot.doctors);
      const existingDoctors = this.db.prepare("SELECT id FROM doctors").all().map(row => row.id);
      const deleteDoctor = this.db.prepare("DELETE FROM doctors WHERE id = ?");
      for (const id of existingDoctors) if (!Object.hasOwn(snapshot.doctors, id)) deleteDoctor.run(id);
      for (const id of doctorIds) {
        const json = stableJson(snapshot.doctors[id]);
        upsertDoctor.run(id, json, contentHash(json), now);
      }

      const monthKeys = Object.keys(snapshot.months);
      const existingMonths = this.db.prepare("SELECT month_key FROM months").all().map(row => row.month_key);
      const deleteMonth = this.db.prepare("DELETE FROM months WHERE month_key = ?");
      for (const key of existingMonths) if (!Object.hasOwn(snapshot.months, key)) deleteMonth.run(key);
      for (const key of monthKeys) {
        if (!/^\d{4}-\d{2}$/.test(key)) throw new Error(`Некорректный месяц: ${key}`);
        const json = stableJson(snapshot.months[key]);
        upsertMonth.run(key, json, contentHash(json), now);
      }

      const metadata = {
        version: snapshotVersion,
        dynamicNotes: snapshot.dynamicNotes || {},
        fileLog: Array.isArray(snapshot.fileLog) ? snapshot.fileLog.slice(0, 300) : [],
      };
      for (const [key, value] of Object.entries(metadata)) {
        const json = stableJson(value);
        upsertMeta.run(key, json, contentHash(json), now);
      }
    });
    return this.summary();
  }

  summary() {
    return {
      months: this.db.prepare("SELECT COUNT(*) AS n FROM months").get().n,
      doctors: this.db.prepare("SELECT COUNT(*) AS n FROM doctors").get().n,
      imports: this.db.prepare("SELECT COUNT(*) AS n FROM import_events").get().n,
      users: this.db.prepare("SELECT COUNT(*) AS n FROM users").get().n,
      comments: this.db.prepare("SELECT COUNT(*) AS n FROM comments").get().n,
      publications: this.db.prepare("SELECT COUNT(*) AS n FROM publications").get().n,
      databasePath: this.databasePath,
      schemaVersion: SCHEMA_VERSION,
    };
  }

  hasUsers() {
    return this.db.prepare("SELECT 1 FROM users LIMIT 1").get() != null;
  }

  hasAdminUser() {
    return this.db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get() != null;
  }

  ensureLocalAdministrator() {
    const existing = this.db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    if (existing) {
      this.db.prepare(`
        UPDATE users
        SET active = 1, must_change_password = 0, failed_attempts = 0, locked_until = NULL, updated_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), Number(existing.id));
      return this.getUserById(existing.id);
    }

    let username = "local-admin";
    let suffix = 2;
    while (this.getUserByUsername(username)) username = `local-admin-${suffix++}`;
    return this.createUser({
      username,
      displayName: "Администратор",
      role: "admin",
      passwordHash: "",
      passwordSalt: "",
      passwordParams: "{}",
    });
  }

  createUser({ username, displayName, role, doctorId = null, passwordHash, passwordSalt, passwordParams, mustChangePassword = false }) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO users(username, display_name, role, doctor_id, password_hash, password_salt, password_params,
        active, must_change_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      String(username).trim(),
      String(displayName).trim(),
      role,
      doctorId || null,
      passwordHash,
      passwordSalt,
      passwordParams,
      mustChangePassword ? 1 : 0,
      now,
      now,
    );
    return this.getUserById(Number(result.lastInsertRowid));
  }

  getUserById(id) {
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(Number(id)) || null;
  }

  getUserByUsername(username) {
    return this.db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(String(username || "").trim()) || null;
  }

  listUsers() {
    return this.db.prepare(`
      SELECT id, username, display_name, role, doctor_id, active, must_change_password,
        failed_attempts, locked_until, last_login_at, created_at, updated_at
      FROM users ORDER BY role, display_name COLLATE NOCASE
    `).all().map(row => ({
      id: Number(row.id),
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      doctorId: row.doctor_id,
      active: Boolean(row.active),
      mustChangePassword: Boolean(row.must_change_password),
      failedAttempts: Number(row.failed_attempts) || 0,
      lockedUntil: row.locked_until,
      lastLoginAt: row.last_login_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  syncDoctorUserIdentities() {
    const doctors = new Map(
      this.db.prepare("SELECT id, data_json FROM doctors").all()
        .map(row => [row.id, parseJson(row.data_json, {})]),
    );
    const users = this.db.prepare("SELECT id, username, display_name, doctor_id FROM users WHERE role = 'doctor'").all();
    const occupied = new Set(
      this.db.prepare("SELECT username FROM users").all()
        .map(row => String(row.username).toLocaleLowerCase("ru-RU")),
    );
    const update = this.db.prepare("UPDATE users SET username = ?, display_name = ?, updated_at = ? WHERE id = ?");
    let changed = 0;
    this.#transaction(() => {
      for (const user of users) {
        const doctor = doctors.get(user.doctor_id);
        if (!doctor) continue;
        const displayName = String(doctor.name || user.display_name || "Врач").trim();
        let username = String(user.username || "").trim();
        if (/^doctor_/i.test(username)) {
          occupied.delete(username.toLocaleLowerCase("ru-RU"));
          const base = doctorLoginBase(displayName);
          if (base) {
            username = base;
            let suffix = 2;
            while (occupied.has(username.toLocaleLowerCase("ru-RU"))) {
              const number = String(suffix++);
              username = `${base.slice(0, Math.max(1, 40 - number.length))}${number}`;
            }
            occupied.add(username.toLocaleLowerCase("ru-RU"));
          }
        }
        if (username !== user.username || displayName !== user.display_name) {
          update.run(username, displayName, new Date().toISOString(), Number(user.id));
          changed++;
        }
      }
    });
    return changed;
  }

  rebindDoctorUsers({ sourceDoctorIds, targetDoctorId }) {
    const sources = [...new Set((sourceDoctorIds || []).map(String))]
      .filter(id => id && id !== String(targetDoctorId));
    const target = String(targetDoctorId || "");
    if (!target || !sources.length) return { moved: 0 };
    const targetDoctor = this.db.prepare("SELECT data_json FROM doctors WHERE id = ?").get(target);
    if (!targetDoctor) throw new Error("Итоговая карточка врача не найдена");
    const sourceUsers = this.db.prepare(`
      SELECT * FROM users WHERE role = 'doctor' AND doctor_id IN (${sources.map(() => "?").join(",")})
    `).all(...sources);
    const targetUser = this.db.prepare("SELECT * FROM users WHERE role = 'doctor' AND doctor_id = ?").get(target);
    if (sourceUsers.length > 1 || (sourceUsers.length && targetUser)) {
      throw new Error("У объединяемых карточек несколько учётных записей. Сначала оставьте одну активную запись врача.");
    }
    if (!sourceUsers.length) return { moved: 0 };
    const doctor = parseJson(targetDoctor.data_json, {});
    const userId = Number(sourceUsers[0].id);
    const displayName = String(doctor.name || sourceUsers[0].display_name || "Врач").trim();
    const base = doctorLoginBase(displayName);
    if (!base) throw new Error("Не удалось сформировать логин из фамилии итогового врача");
    let username = base;
    let suffix = 2;
    const occupied = this.db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND id <> ?");
    while (occupied.get(username, userId)) {
      const number = String(suffix++);
      username = `${base.slice(0, Math.max(1, 40 - number.length))}${number}`;
    }
    this.#transaction(() => {
      this.db.prepare("UPDATE users SET doctor_id = ?, username = ?, display_name = ?, updated_at = ? WHERE id = ?")
        .run(target, username, displayName, new Date().toISOString(), userId);
    });
    return { moved: 1, userId, doctorId: target, username };
  }

  updateUserPassword(id, { passwordHash, passwordSalt, passwordParams, mustChangePassword = false }) {
    this.db.prepare(`
      UPDATE users
      SET password_hash = ?, password_salt = ?, password_params = ?, must_change_password = ?,
        failed_attempts = 0, locked_until = NULL, updated_at = ?
      WHERE id = ?
    `).run(passwordHash, passwordSalt, passwordParams, mustChangePassword ? 1 : 0, new Date().toISOString(), Number(id));
    return this.getUserById(id);
  }

  setUserActive(id, active) {
    this.db.prepare("UPDATE users SET active = ?, updated_at = ? WHERE id = ?")
      .run(active ? 1 : 0, new Date().toISOString(), Number(id));
    return this.getUserById(id);
  }

  recordLoginFailure(id, { lock = false } = {}) {
    const until = lock ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
    this.db.prepare(`
      UPDATE users
      SET failed_attempts = failed_attempts + 1,
        locked_until = CASE WHEN ? IS NULL THEN locked_until ELSE ? END,
        updated_at = ?
      WHERE id = ?
    `).run(until, until, new Date().toISOString(), Number(id));
    return this.getUserById(id);
  }

  recordLoginSuccess(id) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?
    `).run(now, now, Number(id));
    return this.getUserById(id);
  }

  listDoctorLoginCandidates(query = "") {
    const needle = String(query || "").trim().toLocaleLowerCase("ru-RU");
    const users = this.listUsers().filter(user => user.role === "doctor" && user.active);
    const doctors = new Map(
      this.db.prepare("SELECT id, data_json FROM doctors").all()
        .map(row => [row.id, parseJson(row.data_json, {})]),
    );
    return users
      .map(user => {
        const doctor = doctors.get(user.doctorId) || {};
        const haystack = `${user.displayName} ${doctor.department || ""} ${doctor.specialization || ""} ${doctor.spec || ""}`
          .toLocaleLowerCase("ru-RU");
        return {
          userId: user.id,
          displayName: user.displayName,
          doctorId: user.doctorId,
          department: doctor.department || "",
          specialization: doctor.specialization || doctor.dept || "",
          haystack,
        };
      })
      .filter(item => !needle || needle.split(/\s+/).every(token => item.haystack.includes(token)))
      .slice(0, 30)
      .map(({ haystack, ...item }) => item);
  }

  saveCommentDraft({ scopeType, scopeId, periodKey, blockKey, bodyHtml, bodyText, authorUserId }) {
    const now = new Date().toISOString();
    return this.#transaction(() => {
      this.db.prepare(`
        INSERT INTO comments(scope_type, scope_id, period_key, block_key, body_html, body_text, status,
          author_user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)
        ON CONFLICT(scope_type, scope_id, period_key, block_key) DO UPDATE SET
          body_html = excluded.body_html,
          body_text = excluded.body_text,
          status = 'draft',
          author_user_id = excluded.author_user_id,
          updated_at = excluded.updated_at,
          archived_at = NULL
      `).run(scopeType, scopeId, periodKey, blockKey, bodyHtml, bodyText, Number(authorUserId), now, now);
      const comment = this.db.prepare(`
        SELECT * FROM comments WHERE scope_type = ? AND scope_id = ? AND period_key = ? AND block_key = ?
      `).get(scopeType, scopeId, periodKey, blockKey);
      const version = this.db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS n FROM comment_versions WHERE comment_id = ?")
        .get(comment.id).n;
      this.db.prepare(`
        INSERT INTO comment_versions(comment_id, version, body_html, body_text, status, changed_by, created_at)
        VALUES (?, ?, ?, ?, 'draft', ?, ?)
      `).run(comment.id, version, bodyHtml, bodyText, Number(authorUserId), now);
      return this.#publicComment(comment);
    });
  }

  listComments({ periodKey, scopeType = null, scopeId = null } = {}) {
    const clauses = ["period_key = ?"];
    const values = [periodKey];
    if (scopeType) { clauses.push("scope_type = ?"); values.push(scopeType); }
    if (scopeId) { clauses.push("scope_id = ?"); values.push(scopeId); }
    return this.db.prepare(`
      SELECT c.*, u.display_name AS author_name
      FROM comments c JOIN users u ON u.id = c.author_user_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY c.scope_type, c.scope_id, c.block_key
    `).all(...values).map(row => this.#publicComment(row));
  }

  listCommentVersions(commentId) {
    return this.db.prepare(`
      SELECT cv.version, cv.body_text, cv.status, cv.created_at, u.display_name AS author_name
      FROM comment_versions cv
      JOIN users u ON u.id = cv.changed_by
      WHERE cv.comment_id = ?
      ORDER BY cv.version DESC
    `).all(Number(commentId)).map(row => ({
      version: Number(row.version),
      bodyText: row.body_text,
      status: row.status,
      createdAt: row.created_at,
      authorName: row.author_name,
    }));
  }

  #publicComment(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      periodKey: row.period_key,
      blockKey: row.block_key,
      bodyHtml: row.body_html,
      bodyText: row.body_text,
      status: row.status,
      authorUserId: Number(row.author_user_id),
      authorName: row.author_name || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      publishedAt: row.published_at,
      archivedAt: row.archived_at,
    };
  }

  archiveComment(id, actorUserId) {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE comments SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, Number(id));
    const comment = this.db.prepare("SELECT * FROM comments WHERE id = ?").get(Number(id));
    if (comment) {
      const version = this.db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS n FROM comment_versions WHERE comment_id = ?")
        .get(comment.id).n;
      this.db.prepare(`
        INSERT INTO comment_versions(comment_id, version, body_html, body_text, status, changed_by, created_at)
        VALUES (?, ?, ?, ?, 'archived', ?, ?)
      `).run(comment.id, version, comment.body_html, comment.body_text, Number(actorUserId), now);
    }
    return this.#publicComment(comment);
  }

  viewerAccessSnapshot() {
    const now = new Date().toISOString();
    const usedPins = new Set(this.db.prepare("SELECT pin_code FROM viewer_doctor_access").all().map(row => row.pin_code));
    const doctors = this.db.prepare("SELECT id, data_json FROM doctors ORDER BY id").all();
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO viewer_doctor_access(
        doctor_id, active, pin_code, pin_hash, pin_salt, pin_params, pin_version, updated_at
      ) VALUES (?, 0, ?, ?, ?, ?, 1, ?)
    `);
    this.#transaction(() => {
      for (const doctor of doctors) {
        const existing = this.db.prepare("SELECT 1 FROM viewer_doctor_access WHERE doctor_id = ?").get(doctor.id);
        if (existing) continue;
        const pin = randomViewerPin(usedPins);
        usedPins.add(pin);
        const record = viewerPinRecord(pin);
        insert.run(doctor.id, pin, record.hash, record.salt, record.params, now);
      }
    });
    const settings = this.db.prepare("SELECT * FROM viewer_settings WHERE id = 1").get();
    const access = new Map(this.db.prepare("SELECT * FROM viewer_doctor_access").all().map(row => [row.doctor_id, row]));
    return {
      adminPinConfigured: Boolean(settings && settings.admin_pin_hash),
      adminPinVersion: settings ? Number(settings.admin_pin_version) : 0,
      doctors: doctors.map(row => {
        const doctor = parseJson(row.data_json, {});
        const item = access.get(row.id);
        return {
          doctorId: row.id,
          displayName: String(doctor.name || row.id),
          department: String(doctor.department || ""),
          specialization: String(doctor.specialization || doctor.dept || ""),
          active: Boolean(item.active),
          pin: item.pin_code,
          pinVersion: Number(item.pin_version),
          updatedAt: item.updated_at,
        };
      }),
    };
  }

  setViewerAdminPin(pin) {
    const value = String(pin || "");
    if (!/^\d{6,12}$/.test(value)) throw new Error("Администраторский PIN должен содержать от 6 до 12 цифр");
    const now = new Date().toISOString();
    const record = viewerPinRecord(value);
    const current = this.db.prepare("SELECT admin_pin_version FROM viewer_settings WHERE id = 1").get();
    const version = Number(current ? current.admin_pin_version : 0) + 1;
    this.db.prepare(`
      INSERT INTO viewer_settings(id, admin_pin_hash, admin_pin_salt, admin_pin_params, admin_pin_version, updated_at)
      VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET admin_pin_hash = excluded.admin_pin_hash, admin_pin_salt = excluded.admin_pin_salt,
        admin_pin_params = excluded.admin_pin_params, admin_pin_version = excluded.admin_pin_version,
        updated_at = excluded.updated_at
    `).run(record.hash, record.salt, record.params, version, now);
    return { configured: true, version };
  }

  updateViewerDoctorAccess({ doctorId, active, pin }) {
    const id = String(doctorId || "");
    if (!this.db.prepare("SELECT 1 FROM doctors WHERE id = ?").get(id)) throw new Error("Врач не найден в рабочей базе");
    this.viewerAccessSnapshot();
    const current = this.db.prepare("SELECT * FROM viewer_doctor_access WHERE doctor_id = ?").get(id);
    const nextPin = String(pin == null ? current.pin_code : pin);
    if (!/^\d{4}$/.test(nextPin)) throw new Error("PIN врача должен состоять ровно из четырёх цифр");
    const duplicate = this.db.prepare("SELECT doctor_id FROM viewer_doctor_access WHERE pin_code = ? AND doctor_id <> ?").get(nextPin, id);
    if (duplicate) throw new Error("Такой PIN уже назначен другому врачу");
    const changedPin = nextPin !== current.pin_code;
    const record = changedPin ? viewerPinRecord(nextPin) : {
      hash: current.pin_hash, salt: current.pin_salt, params: current.pin_params,
    };
    this.db.prepare(`
      UPDATE viewer_doctor_access SET active = ?, pin_code = ?, pin_hash = ?, pin_salt = ?, pin_params = ?,
        pin_version = ?, updated_at = ? WHERE doctor_id = ?
    `).run(active == null ? current.active : (active ? 1 : 0), nextPin, record.hash, record.salt, record.params,
      Number(current.pin_version) + (changedPin ? 1 : 0), new Date().toISOString(), id);
    return this.viewerAccessSnapshot().doctors.find(item => item.doctorId === id);
  }

  viewerExportCredentials(doctorIds, { requireAdmin = true } = {}) {
    const ids = [...new Set((doctorIds || []).map(String))];
    const settings = this.db.prepare("SELECT * FROM viewer_settings WHERE id = 1").get();
    if (requireAdmin && (!settings || !settings.admin_pin_hash)) throw new Error("Сначала задайте администраторский PIN Viewer");
    const doctors = ids.map(id => {
      const row = this.db.prepare("SELECT * FROM viewer_doctor_access WHERE doctor_id = ?").get(id);
      if (!row || !row.active) throw new Error(`Доступ врача ${id} не включён`);
      return {
        doctorId: id,
        pinCode: row.pin_code,
        pinHash: row.pin_hash,
        pinSalt: row.pin_salt,
        pinParams: row.pin_params,
        pinVersion: Number(row.pin_version),
      };
    });
    return {
      admin: settings && settings.admin_pin_hash ? {
        pinHash: settings.admin_pin_hash,
        pinSalt: settings.admin_pin_salt,
        pinParams: settings.admin_pin_params,
        pinVersion: Number(settings.admin_pin_version),
      } : null,
      doctors,
    };
  }

  recordViewerExport({ packageId, fileName, sha256, manifest, createdBy }) {
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO viewer_exports(package_id, file_name, sha256, manifest_json, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(String(packageId), String(fileName), String(sha256), stableJson(manifest), Number(createdBy), createdAt);
    this.audit({ actorUserId: createdBy, action: "viewer-package.created", targetType: "viewer-package", targetId: packageId,
      details: { fileName, sha256, doctors: manifest.doctors.length, periods: manifest.periods.length } });
    return { packageId, fileName, sha256, createdAt };
  }

  publish({ periodKey, createdBy, pages }) {
    const now = new Date().toISOString();
    return this.#transaction(() => {
      const version = this.db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS n FROM publications WHERE period_key = ?")
        .get(periodKey).n;
      const publication = this.db.prepare(`
        INSERT INTO publications(period_key, version, created_by, created_at) VALUES (?, ?, ?, ?)
      `).run(periodKey, version, Number(createdBy), now);
      const publicationId = Number(publication.lastInsertRowid);
      const insertPage = this.db.prepare(`
        INSERT INTO published_pages(publication_id, doctor_id, page_type, scope_id, title, html, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const page of pages) {
        insertPage.run(publicationId, page.doctorId, page.pageType, page.scopeId, page.title, page.html, now);
      }
      const draftComments = this.db.prepare("SELECT * FROM comments WHERE period_key = ? AND status = 'draft'").all(periodKey);
      this.db.prepare(`
        UPDATE comments SET status = 'published', published_at = ?, updated_at = ?
        WHERE period_key = ? AND status = 'draft'
      `).run(now, now, periodKey);
      const nextVersion = this.db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS n FROM comment_versions WHERE comment_id = ?");
      const insertCommentVersion = this.db.prepare(`
        INSERT INTO comment_versions(comment_id, version, body_html, body_text, status, changed_by, created_at)
        VALUES (?, ?, ?, ?, 'published', ?, ?)
      `);
      for (const comment of draftComments) {
        insertCommentVersion.run(
          comment.id,
          nextVersion.get(comment.id).n,
          comment.body_html,
          comment.body_text,
          Number(createdBy),
          now,
        );
      }
      this.audit({ actorUserId: createdBy, action: "publication.created", targetType: "period", targetId: periodKey, details: { publicationId, version, pages: pages.length } });
      return { publicationId, periodKey, version, pages: pages.length, createdAt: now };
    });
  }

  listPublishedPeriods(doctorId) {
    return this.db.prepare(`
      SELECT p.period_key, MAX(p.version) AS version, MAX(p.created_at) AS created_at
      FROM publications p
      JOIN published_pages pp ON pp.publication_id = p.id
      WHERE pp.doctor_id = ?
      GROUP BY p.period_key
      ORDER BY p.period_key DESC
    `).all(String(doctorId)).map(row => ({
      periodKey: row.period_key,
      version: Number(row.version),
      createdAt: row.created_at,
    }));
  }

  getPublishedPage({ doctorId, periodKey, pageType }) {
    const row = this.db.prepare(`
      SELECT pp.page_type, pp.scope_id, pp.title, pp.html, p.period_key, p.version, p.created_at
      FROM published_pages pp
      JOIN publications p ON p.id = pp.publication_id
      WHERE pp.doctor_id = ? AND pp.page_type = ? AND pp.publication_id = (
        SELECT p2.id
        FROM publications p2
        JOIN published_pages pp2 ON pp2.publication_id = p2.id
        WHERE p2.period_key = ? AND pp2.doctor_id = ?
        ORDER BY p2.version DESC
        LIMIT 1
      )
      LIMIT 1
    `).get(String(doctorId), String(pageType), String(periodKey), String(doctorId));
    return row ? {
      pageType: row.page_type,
      scopeId: row.scope_id,
      title: row.title,
      html: row.html,
      periodKey: row.period_key,
      version: Number(row.version),
      createdAt: row.created_at,
    } : null;
  }

  audit({ actorUserId = null, action, targetType = null, targetId = null, details = null }) {
    this.db.prepare(`
      INSERT INTO audit_log(actor_user_id, action, target_type, target_id, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(actorUserId == null ? null : Number(actorUserId), action, targetType, targetId, stableJson(details), new Date().toISOString());
  }

  hasSuccessfulSource(sha256) {
    const row = this.db.prepare("SELECT successful FROM source_files WHERE sha256 = ?").get(String(sha256 || ""));
    return Boolean(row && row.successful);
  }

  listImportedSourcePaths(reportType) {
    const rows = this.db.prepare(`
      SELECT DISTINCT sf.original_path
      FROM source_files sf
      JOIN import_events ie ON ie.source_file_id = sf.id
      WHERE sf.successful = 1
        AND ie.report_type = ?
        AND sf.original_path IS NOT NULL
        AND TRIM(sf.original_path) <> ''
      ORDER BY sf.original_path COLLATE NOCASE
    `).all(String(reportType || ""));
    const seen = new Set();
    const paths = [];
    for (const row of rows) {
      const originalPath = String(row.original_path || "").split("::", 1)[0].trim();
      const key = originalPath.toLocaleLowerCase("ru-RU");
      if (!originalPath || seen.has(key)) continue;
      seen.add(key);
      paths.push(originalPath);
    }
    return paths;
  }

  beginImportBatch({ totalFiles = 0, backupPath = null } = {}) {
    const result = this.db.prepare(`
      INSERT INTO import_batches(started_at, total_files, status, backup_path)
      VALUES (?, ?, 'running', ?)
    `).run(new Date().toISOString(), Number(totalFiles) || 0, backupPath);
    return Number(result.lastInsertRowid);
  }

  recordImport({ batchId = null, source = {}, log = {} }) {
    const now = new Date().toISOString();
    const sha256 = String(source.sha256 || "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Некорректная контрольная сумма исходного файла");
    const successful = log.status === "загружено"
      || log.status === "архив обработан"
      || (log.status === "пропущено" && log.skipReason === "identical");
    this.#transaction(() => {
      this.db.prepare(`
        INSERT INTO source_files(sha256, original_path, file_name, byte_size, modified_at, first_imported_at, last_imported_at, successful)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sha256) DO UPDATE SET
          original_path = COALESCE(excluded.original_path, source_files.original_path),
          last_imported_at = excluded.last_imported_at,
          successful = MAX(source_files.successful, excluded.successful)
      `).run(
        sha256,
        source.path || null,
        String(source.name || log.name || "файл"),
        Number(source.size) || null,
        source.modifiedAt || null,
        now,
        now,
        successful ? 1 : 0,
      );
      const sourceRow = this.db.prepare("SELECT id FROM source_files WHERE sha256 = ?").get(sha256);
      this.db.prepare(`
        INSERT INTO import_events(batch_id, source_file_id, report_type, month_key, doctor_name, status, note, replaced, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        batchId || null,
        sourceRow.id,
        log.type || null,
        log.month || null,
        log.doctor || null,
        String(log.status || "ошибка"),
        log.note || null,
        log.replaced ? 1 : 0,
        now,
      );
    });
  }

  finishImportBatch(batchId, counts = {}) {
    this.db.prepare(`
      UPDATE import_batches
      SET finished_at = ?, loaded_files = ?, error_files = ?, skipped_files = ?, status = ?
      WHERE id = ?
    `).run(
      new Date().toISOString(),
      Number(counts.loaded) || 0,
      Number(counts.errors) || 0,
      Number(counts.skipped) || 0,
      Number(counts.errors) ? "completed_with_errors" : "completed",
      Number(batchId),
    );
  }

  beginExportRun({ month = null, kind = "batch", outputDir, requestedFiles = 0 }) {
    const result = this.db.prepare(`
      INSERT INTO export_runs(month_key, kind, output_dir, requested_files, status, started_at)
      VALUES (?, ?, ?, ?, 'running', ?)
    `).run(month, kind, outputDir, Number(requestedFiles) || 0, new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  finishExportRun(id, { writtenFiles = 0, failedFiles = 0, details = {} } = {}) {
    this.db.prepare(`
      UPDATE export_runs
      SET written_files = ?, failed_files = ?, status = ?, details_json = ?, finished_at = ?
      WHERE id = ?
    `).run(
      Number(writtenFiles) || 0,
      Number(failedFiles) || 0,
      Number(failedFiles) ? "completed_with_errors" : "completed",
      stableJson(details),
      new Date().toISOString(),
      Number(id),
    );
  }

  failExportRun(id, error) {
    this.db.prepare(`
      UPDATE export_runs
      SET failed_files = requested_files, status = 'failed', details_json = ?, finished_at = ?
      WHERE id = ?
    `).run(stableJson({ error: String(error && error.message ? error.message : error) }), new Date().toISOString(), Number(id));
  }

  abortExportRun(id) {
    this.db.prepare(`
      UPDATE export_runs
      SET status = 'aborted', finished_at = ?
      WHERE id = ? AND status = 'running'
    `).run(new Date().toISOString(), Number(id));
  }

  async backupTo(destination) {
    const target = path.resolve(destination);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const staged = `${target}.part-${process.pid}-${Date.now()}`;
    const previous = `${target}.previous-${process.pid}-${Date.now()}`;
    try {
      await backup(this.db, staged);
      const preview = DatabaseService.inspect(staged);
      if (!preview.ok) throw new Error("Проверка резервной копии не пройдена");
      if (fs.existsSync(target)) fs.renameSync(target, previous);
      try {
        fs.renameSync(staged, target);
      } catch (error) {
        if (fs.existsSync(previous)) fs.renameSync(previous, target);
        throw error;
      }
      if (fs.existsSync(previous)) fs.rmSync(previous, { force: true });
      return preview;
    } finally {
      if (fs.existsSync(staged)) fs.rmSync(staged, { force: true });
      if (fs.existsSync(previous) && !fs.existsSync(target)) fs.renameSync(previous, target);
    }
  }

  static inspect(databasePath) {
    let db;
    try {
      db = new DatabaseSync(databasePath, { readOnly: true, timeout: 5000 });
      const integrityRow = db.prepare("PRAGMA integrity_check").get();
      const integrity = integrityRow ? Object.values(integrityRow)[0] : "unknown";
      if (String(integrity).toLowerCase() !== "ok") {
        return { ok: false, integrity: String(integrity) };
      }
      const tableExists = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
      const versionRow = tableExists("app_meta")
        ? db.prepare("SELECT data_json FROM app_meta WHERE key = 'version'").get()
        : null;
      const snapshotVersion = versionRow ? Number(parseJson(versionRow.data_json, null)) : null;
      const compatible = snapshotVersion == null
        || (Number.isInteger(snapshotVersion) && snapshotVersion >= MIN_SNAPSHOT_VERSION && snapshotVersion <= SNAPSHOT_VERSION);
      return {
        ok: true,
        integrity: "ok",
        compatible,
        snapshotVersion,
        schemaVersion: tableExists("schema_migrations")
          ? db.prepare("SELECT COALESCE(MAX(version), 0) AS n FROM schema_migrations").get().n
          : 0,
        months: tableExists("months") ? db.prepare("SELECT COUNT(*) AS n FROM months").get().n : 0,
        doctors: tableExists("doctors") ? db.prepare("SELECT COUNT(*) AS n FROM doctors").get().n : 0,
        imports: tableExists("import_events") ? db.prepare("SELECT COUNT(*) AS n FROM import_events").get().n : 0,
        users: tableExists("users") ? db.prepare("SELECT COUNT(*) AS n FROM users").get().n : 0,
        comments: tableExists("comments") ? db.prepare("SELECT COUNT(*) AS n FROM comments").get().n : 0,
        publications: tableExists("publications") ? db.prepare("SELECT COUNT(*) AS n FROM publications").get().n : 0,
        hasSnapshot: tableExists("app_settings") ? Boolean(db.prepare("SELECT 1 FROM app_settings WHERE id = 1").get()) : false,
      };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      if (db) db.close();
    }
  }
}

module.exports = { DatabaseService, SCHEMA_VERSION, SNAPSHOT_VERSION, MIN_SNAPSHOT_VERSION, contentHash };
