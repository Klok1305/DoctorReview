"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseService } = require("../desktop/services/database.cjs");

function snapshot() {
  return {
    version: 3,
    settings: { showScores: true, depts: {} },
    doctors: { d1: { name: "Тестов Врач", aliases: [] } },
    months: { "2026-01": { vyrabotka: {}, kb: {}, naznach: {}, pervichka: {}, prostoy: {}, zapis: {}, manual6: {} } },
    dynamicNotes: {},
    fileLog: [],
  };
}

test("SQLite snapshot, import history and verified backup round-trip", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-app-db-"));
  const databasePath = path.join(temp, "data.sqlite");
  const database = new DatabaseService(databasePath);
  t.after(() => {
    try { database.close(); } catch (_) {}
    fs.rmSync(temp, { recursive: true, force: true });
  });

  const summary = database.saveSnapshot(snapshot());
  assert.equal(summary.months, 1);
  assert.equal(summary.doctors, 1);
  assert.deepEqual(database.loadSnapshot(), snapshot());

  const source = { sha256: "a".repeat(64), path: "C:\\input\\test.xlsx", name: "test.xlsx", size: 123 };
  const batchId = database.beginImportBatch({ totalFiles: 1 });
  database.recordImport({ batchId, source, log: { status: "загружено", type: "vyrabotka", month: "2026-01", doctor: "Тестов Врач" } });
  database.finishImportBatch(batchId, { loaded: 1 });
  assert.equal(database.hasSuccessfulSource(source.sha256), true);

  const backup = path.join(temp, "backup.ovbackup");
  const preview = await database.backupTo(backup);
  assert.equal(preview.ok, true);
  assert.equal(preview.months, 1);
  assert.equal(preview.doctors, 1);
  assert.equal(DatabaseService.inspect(backup).integrity, "ok");
});
