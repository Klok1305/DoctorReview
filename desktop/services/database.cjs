"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { backup, DatabaseSync } = require("node:sqlite");

const SCHEMA_VERSION = 1;

function stableJson(value) {
  return JSON.stringify(value == null ? null : value);
}

function contentHash(json) {
  return crypto.createHash("sha256").update(json, "utf8").digest("hex");
}

function parseJson(json, fallback) {
  try { return JSON.parse(json); } catch (_) { return fallback; }
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
    this.#migrate();
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
    const finalVersion = this.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version;
    if (finalVersion !== SCHEMA_VERSION) {
      throw new Error(`Неподдерживаемая версия базы: ${finalVersion}`);
    }
  }

  hasData() {
    return Boolean(this.db.prepare("SELECT 1 FROM app_settings WHERE id = 1").get());
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
        version: Number(snapshot.version || 3),
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
      databasePath: this.databasePath,
      schemaVersion: SCHEMA_VERSION,
    };
  }

  hasSuccessfulSource(sha256) {
    const row = this.db.prepare("SELECT successful FROM source_files WHERE sha256 = ?").get(String(sha256 || ""));
    return Boolean(row && row.successful);
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
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    await backup(this.db, target);
    const preview = DatabaseService.inspect(target);
    if (!preview.ok) throw new Error("Проверка резервной копии не пройдена");
    return preview;
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
      return {
        ok: true,
        integrity: "ok",
        schemaVersion: tableExists("schema_migrations")
          ? db.prepare("SELECT COALESCE(MAX(version), 0) AS n FROM schema_migrations").get().n
          : 0,
        months: tableExists("months") ? db.prepare("SELECT COUNT(*) AS n FROM months").get().n : 0,
        doctors: tableExists("doctors") ? db.prepare("SELECT COUNT(*) AS n FROM doctors").get().n : 0,
        imports: tableExists("import_events") ? db.prepare("SELECT COUNT(*) AS n FROM import_events").get().n : 0,
        hasSnapshot: tableExists("app_settings") ? Boolean(db.prepare("SELECT 1 FROM app_settings WHERE id = 1").get()) : false,
      };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      if (db) db.close();
    }
  }
}

module.exports = { DatabaseService, SCHEMA_VERSION, contentHash };
