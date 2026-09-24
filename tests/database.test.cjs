"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  DatabaseService,
  PORTABLE_JSON_FORMAT,
  PORTABLE_JSON_VERSION,
} = require("../desktop/services/database.cjs");

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
  const bootstrap = database.loadSnapshotSelection({ monthKeys: [] });
  assert.deepEqual(bootstrap.months, {});
  assert.deepEqual(bootstrap.monthKeys, ["2026-01"]);
  assert.deepEqual(database.loadSnapshotSelection({ monthKeys: ["2026-01"] }).months, snapshot().months);
  assert.throws(() => database.loadSnapshotSelection({ monthKeys: ["not-a-month"] }), /список месяцев/);

  const source = { sha256: "a".repeat(64), path: "C:\\input\\test.xlsx", name: "test.xlsx", size: 123 };
  const batchId = database.beginImportBatch({ totalFiles: 1 });
  database.recordImport({ batchId, source, log: { status: "загружено", type: "vyrabotka", month: "2026-01", doctor: "Тестов Врач" } });
  database.finishImportBatch(batchId, { loaded: 1 });
  assert.equal(database.hasSuccessfulSource(source.sha256), true);

  const zipPath = path.join(temp, "назначения.zip");
  const appointmentSource = { sha256: "b".repeat(64), path: `${zipPath}::врачи/Пан.xls`, name: "Пан.xls", size: 456 };
  const appointmentBatchId = database.beginImportBatch({ totalFiles: 1 });
  database.recordImport({ batchId: appointmentBatchId, source: appointmentSource, log: { status: "загружено", type: "naznach", month: "2026-06", doctor: "Пан К. А." } });
  database.finishImportBatch(appointmentBatchId, { loaded: 1 });
  assert.deepEqual(database.listImportedSourcePaths("naznach"), [zipPath]);

  const backup = path.join(temp, "backup.ovbackup");
  const preview = await database.backupTo(backup);
  assert.equal(preview.ok, true);
  assert.equal(preview.months, 1);
  assert.equal(preview.doctors, 1);
  assert.equal(DatabaseService.inspect(backup).integrity, "ok");
});

test("revisioned mutations update only requested rows and reject stale writers atomically", t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-app-mutations-"));
  const database = new DatabaseService(path.join(temp, "data.sqlite"));
  t.after(() => { database.close(); fs.rmSync(temp, { recursive: true, force: true }); });

  const initial = snapshot();
  const first = database.saveSnapshot(initial);
  assert.equal(first.dataRevision, 1);
  const monthHash = database.db.prepare("SELECT content_hash FROM months WHERE month_key = '2026-01'").get().content_hash;
  const doctorHash = database.db.prepare("SELECT content_hash FROM doctors WHERE id = 'd1'").get().content_hash;

  const settings = structuredClone(initial.settings);
  settings.showScores = false;
  const second = database.saveMutation({ version: 3, expectedRevision: 1, settings, doctors: {}, months: {}, deleteDoctors: [], deleteMonths: [] });
  assert.equal(second.dataRevision, 2);
  assert.equal(database.loadSnapshot().settings.showScores, false);
  assert.equal(database.db.prepare("SELECT content_hash FROM months WHERE month_key = '2026-01'").get().content_hash, monthHash);
  assert.equal(database.db.prepare("SELECT content_hash FROM doctors WHERE id = 'd1'").get().content_hash, doctorHash);

  const third = database.saveMutation({ version: 3, expectedRevision: 2, doctors: {}, months: {}, deleteDoctors: [], deleteMonths: [], dynamicNotes: { note: "точечно" } });
  assert.equal(third.dataRevision, 3);
  assert.deepEqual(database.loadSnapshot().dynamicNotes, { note: "точечно" });
  assert.throws(() => database.saveMutation({ version: 3, expectedRevision: 2, doctors: {}, months: {}, deleteDoctors: [], deleteMonths: [], fileLog: [] }), /Конфликт ревизии/);
  assert.equal(database.summary().dataRevision, 3);

  const changedMonth = structuredClone(initial.months["2026-01"]);
  changedMonth.vyrabotka.d1 = { items: [{ n: "Synthetic", q: 1, sOwn: 100 }] };
  const source = { sha256: "f".repeat(64), name: "mutation.xlsx" };
  database.db.exec("CREATE TEMP TRIGGER fail_mutation_import BEFORE INSERT ON import_events BEGIN SELECT RAISE(ABORT, 'mutation failure'); END");
  assert.throws(() => database.saveMutation({ version: 3, expectedRevision: 3, doctors: {}, months: { "2026-01": changedMonth }, deleteDoctors: [], deleteMonths: [], fileLog: [] },
    [{ source, log: { status: "загружено", month: "2026-01" } }]), /mutation failure/);
  assert.equal(database.summary().dataRevision, 3);
  assert.equal(database.db.prepare("SELECT content_hash FROM months WHERE month_key = '2026-01'").get().content_hash, monthHash);
  assert.equal(database.hasSuccessfulSource(source.sha256), false);
  database.db.exec("DROP TRIGGER fail_mutation_import");
  const fourth = database.saveMutation({ version: 3, expectedRevision: 3, doctors: {}, months: { "2026-01": changedMonth }, deleteDoctors: [], deleteMonths: [], fileLog: [] },
    [{ source, log: { status: "загружено", month: "2026-01" } }]);
  assert.equal(fourth.dataRevision, 4);
  assert.equal(database.loadSnapshot().months["2026-01"].vyrabotka.d1.items[0].sOwn, 100);
  assert.equal(database.hasSuccessfulSource(source.sha256), true);
});

test("import snapshot and source history commit together and roll back together on write failure", t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-app-atomic-import-"));
  const database = new DatabaseService(path.join(temp, "data.sqlite"));
  t.after(() => { database.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  const before = snapshot();
  database.saveSnapshot(before);
  const batchId = database.beginImportBatch({ totalFiles: 2 });
  const source = { sha256: "d".repeat(64), name: "synthetic.xlsx" };
  const imported = snapshot();
  imported.months["2026-01"].vyrabotka.d1 = { items: [{ n: "Synthetic", q: 1, sOwn: 1000 }] };
  const records = [{ batchId, source, log: { status: "загружено", type: "vyrabotka", month: "2026-01" } }];
  // Fails after source_files was updated: both that write and the snapshot must roll back.
  database.db.exec("CREATE TEMP TRIGGER fail_import_event BEFORE INSERT ON import_events BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END");
  assert.throws(() => database.saveSnapshot(imported, records), /synthetic disk failure/);
  assert.deepEqual(database.loadSnapshot(), before);
  assert.equal(database.hasSuccessfulSource(source.sha256), false);
  assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM import_events").get().n, 0);
  database.db.exec("DROP TRIGGER fail_import_event");
  database.saveSnapshot(imported, records);
  assert.deepEqual(database.loadSnapshot(), imported);
  assert.equal(database.hasSuccessfulSource(source.sha256), true);
  assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM import_events").get().n, 1);
  const invalid = structuredClone(imported);
  invalid.months["invalid"] = {};
  const otherSource = { sha256: "e".repeat(64), name: "other.xlsx" };
  assert.throws(() => database.saveSnapshot(invalid, [{ ...records[0], source: otherSource }]), /Некорректный месяц/);
  assert.equal(database.hasSuccessfulSource(otherSource.sha256), false);
  assert.deepEqual(database.loadSnapshot(), imported);
  assert.equal(database.summary().schemaVersion, 5);
});

test("atomic import preserves old SQLite data and accepts snapshot versions one through four", t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-old-atomic-import-"));
  const file = path.join(temp, "legacy.sqlite");
  let database = new DatabaseService(file);
  t.after(() => { database.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  const original = snapshot();
  original.version = 1;
  database.saveSnapshot(original);
  database.db.exec("DROP TABLE viewer_department_heads; ALTER TABLE viewer_doctor_access ADD COLUMN windows_account TEXT NOT NULL DEFAULT ''; DELETE FROM schema_migrations WHERE version > 3");
  database.close();
  database = new DatabaseService(file);
  assert.deepEqual(database.loadSnapshot(), original);
  for (let version = 1; version <= 4; version++) {
    const next = structuredClone(original);
    next.version = version;
    next.dynamicNotes.synthetic = String(version);
    const source = { sha256: String(version).repeat(64), name: "synthetic.xlsx" };
    database.saveSnapshot(next, [{ source, log: { status: "загружено", month: "2026-01" } }]);
    assert.deepEqual(database.loadSnapshot(), next);
    assert.equal(database.hasSuccessfulSource(source.sha256), true);
  }
  assert.equal(database.summary().schemaVersion, 5);
});

test("full JSON round-trip preserves comments, publications, Viewer access and department heads", t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-app-json-"));
  const source = new DatabaseService(path.join(temp, "source.sqlite"));
  const target = new DatabaseService(path.join(temp, "target.sqlite"));
  t.after(() => {
    try { source.close(); } catch (_) {}
    try { target.close(); } catch (_) {}
    fs.rmSync(temp, { recursive: true, force: true });
  });

  const data = snapshot();
  data.version = 4;
  data.doctors.d1.department = "Терапия";
  data.doctors.d1.specialization = "Кардиология";
  source.saveSnapshot(data);
  const admin = source.ensureLocalAdministrator();
  const comment = source.saveCommentDraft({
    scopeType: "department", scopeId: "Терапия", periodKey: "2026-01", blockKey: "department.overview",
    bodyHtml: "<strong>Комментарий заведующего</strong>", bodyText: "Комментарий заведующего", authorUserId: admin.id,
  });
  source.saveCommentDraft({
    scopeType: "department", scopeId: "Терапия", periodKey: "2026-01", blockKey: "department.overview",
    bodyHtml: "<strong>Обновлённый комментарий</strong>", bodyText: "Обновлённый комментарий", authorUserId: admin.id,
  });
  source.publish({
    periodKey: "2026-01", createdBy: admin.id,
    pages: [{ doctorId: "d1", pageType: "doctor", scopeId: "d1", title: "Отчёт", html: "<div>Опубликованный отчёт</div>" }],
  });
  const batchId = source.beginImportBatch({ totalFiles: 1 });
  source.recordImport({ batchId, source: { sha256: "c".repeat(64), path: "C:\\1C\\report.xlsx", name: "report.xlsx", size: 123 },
    log: { status: "загружено", type: "vyrabotka", month: "2026-01", doctor: "Тестов Врач" } });
  source.finishImportBatch(batchId, { loaded: 1 });
  source.setViewerAdminPin("654321");
  source.updateViewerDoctorAccess({ doctorId: "d1", active: true, pin: "1357" });
  source.updateViewerDepartmentHead({ department: "Терапия", doctorId: "d1" });
  source.audit({ actorUserId: admin.id, action: "test.export", targetType: "database", targetId: "source" });

  const portable = source.createPortableJson({ appVersion: "2.5.9" });
  assert.equal(portable.format, PORTABLE_JSON_FORMAT);
  assert.equal(portable.formatVersion, PORTABLE_JSON_VERSION);
  assert.equal(portable.containsSensitiveData, true);
  assert.equal(portable.snapshot.settings.departmentHeadDoctorIds["Терапия"], "d1");
  assert.equal(portable.counts.comments, 1);
  assert.equal(portable.counts.comment_versions, 3);
  assert.equal(portable.counts.viewer_department_heads, 1);
  assert.equal(portable.counts.import_events, 1);
  assert.doesNotThrow(() => JSON.stringify(portable));

  target.saveSnapshot(data);
  const restored = target.restorePortableJson(JSON.parse(JSON.stringify(portable)));
  assert.equal(restored.departmentHeads["Терапия"], "d1");
  assert.equal(restored.comments, 1);
  assert.equal(restored.commentVersions, 3);
  assert.equal(target.viewerAccessSnapshot().adminPinConfigured, true);
  const restoredAccess = target.viewerAccessSnapshot().doctors.find(item => item.doctorId === "d1");
  assert.equal(restoredAccess.active, true);
  assert.equal(restoredAccess.pin, "1357");
  assert.equal(target.listComments({ periodKey: "2026-01" })[0].bodyText, "Обновлённый комментарий");
  assert.equal(target.listCommentVersions(comment.id).length, 3);
  assert.match(target.getPublishedPage({ doctorId: "d1", periodKey: "2026-01", pageType: "doctor" }).html, /Опубликованный отчёт/);
  assert.equal(target.hasSuccessfulSource("c".repeat(64)), true);
  assert.equal(target.db.prepare("SELECT COUNT(*) AS n FROM audit_log").get().n, portable.counts.audit_log);
});
