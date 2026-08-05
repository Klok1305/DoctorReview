"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { BackupService } = require("../desktop/services/backup-service.cjs");
const { ConfigStore } = require("../desktop/services/config-store.cjs");
const { DatabaseService } = require("../desktop/services/database.cjs");

function snapshot() {
  return {
    version: 4,
    settings: { showScores: true, depts: {} },
    doctors: {
      d1: { name: "Тестов Врач", aliases: [], department: "Терапия", specialization: "Кардиология" },
    },
    months: { "2026-01": { vyrabotka: {}, kb: {}, naznach: {}, pervichka: {}, prostoy: {}, zapis: {}, manual6: {} } },
    dynamicNotes: {},
    fileLog: [],
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-admin-local-"));
  const config = new ConfigStore({ userDataDir: path.join(root, "config"), documentsDir: path.join(root, "documents") });
  config.setWorkspaceRoot(path.join(root, "workspace"));
  const database = new DatabaseService(config.databasePath());
  database.saveSnapshot(snapshot());
  t.after(() => {
    try { database.close(); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, config, database };
}

test("local administrator is available without login or password", t => {
  const { database } = fixture(t);
  const first = database.ensureLocalAdministrator();
  assert.equal(first.role, "admin");
  assert.equal(first.active, 1);
  assert.equal(first.password_hash, "");

  database.setUserActive(first.id, false);
  const restored = database.ensureLocalAdministrator();
  assert.equal(restored.id, first.id);
  assert.equal(restored.active, 1);
  assert.equal(database.listUsers().filter(user => user.role === "admin").length, 1);
});

test("legacy doctor rows remain stored while the local administrator is created automatically", t => {
  const { database } = fixture(t);
  database.createUser({
    username: "legacy-doctor",
    displayName: "Старый Врач",
    role: "doctor",
    doctorId: "d1",
    passwordHash: "legacy",
    passwordSalt: "legacy",
    passwordParams: "{}",
  });
  const admin = database.ensureLocalAdministrator();
  assert.equal(admin.role, "admin");
  assert.equal(database.listUsers().length, 2);
});

test("administrative comments and legacy publications survive a portable backup", async t => {
  const { root, config, database } = fixture(t);
  const adminId = database.ensureLocalAdministrator().id;
  database.saveCommentDraft({
    scopeType: "doctor",
    scopeId: "d1",
    periodKey: "2026-01",
    blockKey: "doctor.overview",
    bodyHtml: "<strong>Хороший результат</strong>",
    bodyText: "Хороший результат",
    authorUserId: adminId,
  });
  database.publish({
    periodKey: "2026-01",
    createdBy: adminId,
    pages: [{ doctorId: "d1", pageType: "doctor", scopeId: "d1", title: "Архивный отчёт", html: "<div>Версия 1</div>" }],
  });

  const backups = new BackupService({ database, configStore: config });
  const portable = path.join(root, "complete.ovbackup");
  await backups.createPortable(portable);
  const preview = DatabaseService.inspect(portable);
  assert.equal(preview.users, 1);
  assert.equal(preview.comments, 1);
  assert.equal(preview.publications, 1);

  database.archiveComment(1, adminId);
  await backups.restore(portable);
  assert.equal(database.listComments({ periodKey: "2026-01" })[0].status, "published");
  assert.match(database.getPublishedPage({ doctorId: "d1", periodKey: "2026-01", pageType: "doctor" }).html, /Версия 1/);
});

test("a full backup restores data, keeps target paths and opens with a local administrator", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-admin-transfer-"));
  const sourceConfig = new ConfigStore({ userDataDir: path.join(root, "source-config"), documentsDir: path.join(root, "source-documents") });
  sourceConfig.setWorkspaceRoot(path.join(root, "source-workspace"));
  const sourceDatabase = new DatabaseService(sourceConfig.databasePath());
  const targetConfig = new ConfigStore({ userDataDir: path.join(root, "target-config"), documentsDir: path.join(root, "target-documents") });
  targetConfig.setWorkspaceRoot(path.join(root, "target-workspace"));
  const targetDatabase = new DatabaseService(targetConfig.databasePath());
  t.after(() => {
    try { sourceDatabase.close(); } catch (_) {}
    try { targetDatabase.close(); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  sourceDatabase.saveSnapshot(snapshot());
  const admin = sourceDatabase.ensureLocalAdministrator();
  sourceDatabase.saveCommentDraft({
    scopeType: "department",
    scopeId: "Терапия",
    periodKey: "2026-01",
    blockKey: "department.overview",
    bodyHtml: "<p>Комментарий отделения</p>",
    bodyText: "Комментарий отделения",
    authorUserId: admin.id,
  });
  sourceDatabase.recordImport({
    source: { sha256: "b".repeat(64), path: "C:\\1C\\report.xlsx", name: "report.xlsx", size: 100 },
    log: { status: "загружено", type: "vyrabotka", month: "2026-01", doctor: "Тестов Врач" },
  });

  const portable = path.join(root, "transfer.ovbackup");
  await new BackupService({ database: sourceDatabase, configStore: sourceConfig }).createPortable(portable);
  const targetWorkspace = targetConfig.publicConfig().workspaceRoot;
  const restored = await new BackupService({ database: targetDatabase, configStore: targetConfig }).restore(portable);

  assert.equal(restored.preview.users, 1);
  assert.equal(restored.preview.comments, 1);
  assert.equal(targetConfig.publicConfig().workspaceRoot, targetWorkspace);
  assert.equal(targetDatabase.db.prepare("SELECT COUNT(*) AS n FROM import_events").get().n, 1);
  assert.equal(targetDatabase.ensureLocalAdministrator().role, "admin");
});
