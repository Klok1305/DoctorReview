"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AuthService, validatePassword, verifyPassword } = require("../desktop/services/auth-service.cjs");
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-admin-auth-"));
  const config = new ConfigStore({ userDataDir: path.join(root, "config"), documentsDir: path.join(root, "documents") });
  config.setWorkspaceRoot(path.join(root, "workspace"));
  const database = new DatabaseService(config.databasePath());
  database.saveSnapshot(snapshot());
  t.after(() => {
    try { database.close(); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, config, database, auth: new AuthService({ database }) };
}

test("password may contain any single character but cannot be empty", () => {
  assert.equal(validatePassword("я"), "я");
  assert.equal(validatePassword(" "), " ");
  assert.throws(() => validatePassword(""), /не может быть пустым/);
});

test("administrator can be created, authenticated and change the password", t => {
  const { database, auth } = fixture(t);
  const setup = auth.setupAdmin({ username: "boss", displayName: "Руководитель", password: "1" });
  assert.equal(setup.user.role, "admin");
  assert.equal(database.hasAdminUser(), true);
  assert.equal(verifyPassword("1", database.getUserById(setup.user.id)), true);

  auth.logout();
  const loggedIn = auth.login({ username: "boss", password: "1" });
  assert.equal(loggedIn.user.displayName, "Руководитель");
  auth.changePassword({ currentPassword: "1", newPassword: "новый" });
  auth.logout();
  assert.equal(auth.login({ username: "boss", password: "новый" }).user.role, "admin");
});

test("legacy doctor accounts remain stored but cannot authenticate in the admin build", t => {
  const { database, auth } = fixture(t);
  database.createUser({
    username: "legacy-doctor",
    displayName: "Старый врач",
    role: "doctor",
    doctorId: "d1",
    passwordHash: "legacy",
    passwordSalt: "legacy",
    passwordParams: "{}",
  });

  assert.equal(auth.status().needsSetup, true, "a doctor-only legacy database still needs an administrator");
  assert.throws(() => auth.login({ username: "legacy-doctor", password: "anything" }), /только администратору/);
  assert.equal(typeof auth.createDoctorUser, "undefined");
  assert.equal(typeof auth.requireDoctorReady, "undefined");

  auth.setupAdmin({ username: "boss", displayName: "Руководитель", password: "admin" });
  assert.equal(database.listUsers().length, 2, "legacy rows are preserved for backup compatibility");
});

test("five failed administrator password attempts lock the account", t => {
  const { auth } = fixture(t);
  auth.setupAdmin({ username: "boss", displayName: "Руководитель", password: "correct" });
  auth.logout();
  for (let attempt = 1; attempt <= 4; attempt++) {
    assert.throws(() => auth.login({ username: "boss", password: "wrong" }), /Неверный/);
  }
  assert.throws(() => auth.login({ username: "boss", password: "wrong" }), /заблокирован/);
  assert.throws(() => auth.login({ username: "boss", password: "correct" }), /временно заблокирован/);
});

test("administrative comments and legacy publications survive a portable backup", async t => {
  const { root, config, database, auth } = fixture(t);
  const adminId = auth.setupAdmin({ username: "boss", displayName: "Руководитель", password: "SecureAdmin2026" }).user.id;
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

test("a full backup restores data but keeps the target installation paths", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-admin-transfer-"));
  const sourceConfig = new ConfigStore({
    userDataDir: path.join(root, "source-config"),
    documentsDir: path.join(root, "source-documents"),
  });
  sourceConfig.setWorkspaceRoot(path.join(root, "source-workspace"));
  const sourceDatabase = new DatabaseService(sourceConfig.databasePath());
  const targetConfig = new ConfigStore({
    userDataDir: path.join(root, "target-config"),
    documentsDir: path.join(root, "target-documents"),
  });
  targetConfig.setWorkspaceRoot(path.join(root, "target-workspace"));
  const targetDatabase = new DatabaseService(targetConfig.databasePath());
  t.after(() => {
    try { sourceDatabase.close(); } catch (_) {}
    try { targetDatabase.close(); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  sourceDatabase.saveSnapshot(snapshot());
  const sourceAuth = new AuthService({ database: sourceDatabase });
  const admin = sourceAuth.setupAdmin({ username: "boss", displayName: "Руководитель", password: "admin" }).user;
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
  assert.equal(new AuthService({ database: targetDatabase }).login({ username: "boss", password: "admin" }).user.role, "admin");
});
