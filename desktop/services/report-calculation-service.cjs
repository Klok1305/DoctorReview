"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const v8 = require("node:v8");
const zlib = require("node:zlib");
const { DatabaseService } = require("./database.cjs");

const SOURCE_FILES = ["app-core.js", "app-parsers.js", "app-metrics.js", "report-worker.js"];
const BUILD_ROOT = path.resolve(__dirname, "../../build");
const CACHE_FORMAT = "report-year-v1";

function calculationSource() {
  const source = SOURCE_FILES.map(file => fs.readFileSync(path.join(BUILD_ROOT, file), "utf8")).join("\n");
  return { source, version: crypto.createHash("sha256").update(CACHE_FORMAT).update(source).digest("hex") };
}

class ReportCalculationStore {
  constructor(database, version) {
    this.database = database;
    this.version = version;
    // Derived data is expendable and deliberately excluded from portable exports.
    database.db.exec(`CREATE TABLE IF NOT EXISTS report_calculations (
      year TEXT PRIMARY KEY, source_hash TEXT NOT NULL, format_version TEXT NOT NULL,
      payload BLOB NOT NULL, updated_at TEXT NOT NULL
    )`);
  }

  sourceKey(year) {
    if (!/^\d{4}$/.test(String(year))) throw new Error("Некорректный год отчётов");
    const db = this.database.db;
    const months = db.prepare("SELECT month_key, content_hash FROM months WHERE month_key <= ? ORDER BY month_key")
      .all(`${year}-12`);
    const settings = db.prepare("SELECT content_hash FROM app_settings WHERE id=1").get();
    const doctors = db.prepare("SELECT id, content_hash FROM doctors ORDER BY id").all();
    return crypto.createHash("sha256").update(JSON.stringify([this.version, year, settings, doctors, months])).digest("hex");
  }

  read(year, sourceKey = this.sourceKey(year)) {
    const row = this.database.db.prepare("SELECT payload FROM report_calculations WHERE year=? AND source_hash=? AND format_version=?")
      .get(year, sourceKey, this.version);
    if (!row) return null;
    try {
      const prepared = v8.deserialize(zlib.inflateSync(row.payload, { maxOutputLength: 512 * 1024 * 1024 }));
      if (!["metrics", "department", "reportBase", "basePoints", "activity", "kbSummary", "adminBase", "primaryPatients"]
        .every(name => prepared[name] instanceof Map)) return null;
      return prepared;
    } catch (_) { return null; }
  }

  write(year, sourceKey, prepared) {
    const payload = zlib.deflateSync(v8.serialize(prepared), { level: 1 });
    const db = this.database.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (sourceKey !== this.sourceKey(year)) {
        const error = new Error("Данные изменились во время подготовки отчётов");
        error.name = "ReportDataChangedError";
        throw error;
      }
      db.prepare(`INSERT INTO report_calculations(year, source_hash, format_version, payload, updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(year) DO UPDATE SET source_hash=excluded.source_hash, format_version=excluded.format_version,
        payload=excluded.payload, updated_at=excluded.updated_at`).run(year, sourceKey, this.version, payload, new Date().toISOString());
      db.exec("COMMIT");
      return payload.length;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
}

function preparePersistedReportYear({ databasePath, year }, onProgress = () => {}) {
  year = String(year);
  if (!/^\d{4}$/.test(year)) throw new Error("Некорректный год отчётов");
  const database = new DatabaseService(databasePath);
  try {
    const { source, version } = calculationSource();
    const store = new ReportCalculationStore(database, version);
    // Read the fingerprint and source rows from one SQLite snapshot.
    database.db.exec("BEGIN");
    let sourceKey, prepared, snapshot;
    try {
      sourceKey = store.sourceKey(year);
      onProgress({ stage: "load", completed: 0, total: 1, year });
      prepared = store.read(year, sourceKey);
      if (!prepared) {
        const keys = database.db.prepare("SELECT month_key FROM months WHERE month_key <= ? ORDER BY month_key")
          .all(`${year}-12`).map(row => row.month_key);
        snapshot = database.loadSnapshotSelection({ monthKeys: keys });
      }
      database.db.exec("COMMIT");
    } catch (error) { database.db.exec("ROLLBACK"); throw error; }
    const fromCache = Boolean(prepared);
    if (!prepared) {
      const context = vm.createContext({ window: {}, localStorage: { getItem() { return null; }, setItem() {} }, Intl, console });
      vm.runInContext(source, context);
      context.snapshot = snapshot || { settings: {}, doctors: {}, months: {} };
      context.year = year;
      context.progress = (completed, total) => onProgress({ stage: "calculate", completed, total, year });
      prepared = vm.runInContext("DB=snapshot; clearMetricsCache(); prepareSpecializationCalculations(year, progress)", context);
      // Remove transient patient lists; their getters are restored on demand in the renderer.
      vm.runInContext("compactPreparedReportYear", context)(prepared);
      onProgress({ stage: "save", completed: 0, total: 1, year });
      store.write(year, sourceKey, prepared);
    }
    if (sourceKey !== store.sourceKey(year)) {
      const error = new Error("Данные изменились во время загрузки готовых отчётов");
      error.name = "ReportDataChangedError";
      throw error;
    }
    onProgress({ stage: "ready", completed: 1, total: 1, year });
    return { prepared, fromCache, dataRevision: database.summary().dataRevision };
  } finally { database.close(); }
}

module.exports = { ReportCalculationStore, preparePersistedReportYear, calculationSource };
