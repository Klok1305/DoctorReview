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
      d2: { name: "Другая Врач", aliases: [], department: "Терапия", specialization: "Неврология" },
    },
    months: { "2026-01": { vyrabotka: {}, kb: {}, naznach: {}, pervichka: {}, prostoy: {}, zapis: {}, manual6: {} } },
    dynamicNotes: {},
    fileLog: [],
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-auth-"));
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

test("administrator setup accepts a short password and doctor credentials are generated from the surname", t => {
  const { database, auth } = fixture(t);
  const setup = auth.setupAdmin({ username: "boss", displayName: "Руководитель", password: "1" });
  assert.equal(setup.user.role, "admin");
  const doctor = auth.createDoctorUser({
    doctorId: "d1",
    displayName: "Тестов Врач",
  });
  assert.equal(doctor.mustChangePassword, true);
  assert.equal(doctor.username, "тестов");
  assert.match(doctor.temporaryPassword, /^\d{6}$/);
  const raw = database.getUserById(doctor.id);
  assert.notEqual(raw.password_hash, doctor.temporaryPassword);
  assert.equal(verifyPassword(doctor.temporaryPassword, raw), true);
  assert.equal(Object.hasOwn(doctor, "passwordHash"), false);

  auth.logout();
  const candidates = database.listDoctorLoginCandidates("тест");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].department, "Терапия");
  const loggedIn = auth.login({ userId: doctor.id, password: doctor.temporaryPassword });
  assert.equal(loggedIn.user.doctorId, "d1");
  auth.changePassword({ currentPassword: doctor.temporaryPassword, newPassword: "я" });
  assert.equal(database.getUserById(doctor.id).must_change_password, 0);
});

test("identical doctor surnames get a numeric login suffix", t => {
  const { auth } = fixture(t);
  auth.setupAdmin({ username: "boss", displayName: "Руководитель", password: "1" });
  const first = auth.createDoctorUser({ doctorId: "d1", displayName: "Иванов Первый" });
  const second = auth.createDoctorUser({ doctorId: "d2", displayName: "Иванов Второй" });
  assert.equal(first.username, "иванов");
  assert.equal(second.username, "иванов2");
});

test("doctor cannot read publications until the temporary password is changed", t => {
  const { auth } = fixture(t);
  auth.setupAdmin({ username: "boss", displayName: "Руководитель", password: "1" });
  const doctor = auth.createDoctorUser({ doctorId: "d1", displayName: "Тестов Врач" });
  auth.logout();
  auth.login({ userId: doctor.id, password: doctor.temporaryPassword });
  assert.throws(() => auth.requireDoctorReady(), /заменить временный пароль/);
  auth.changePassword({ currentPassword: doctor.temporaryPassword, newPassword: "я" });
  assert.equal(auth.requireDoctorReady().doctorId, "d1");
});

test("legacy doctor logins and merged doctor bindings stay aligned with the final surname", t => {
  const { database, auth } = fixture(t);
  auth.setupAdmin({ username: "boss", displayName: "Руководитель", password: "1" });
  const doctor = auth.createDoctorUser({ doctorId: "d1", displayName: "Тестов Врач" });
  database.db.prepare("UPDATE users SET username = 'doctor_d1' WHERE id = ?").run(doctor.id);
  assert.equal(database.syncDoctorUserIdentities(), 1);
  assert.equal(database.getUserById(doctor.id).username, "тестов");

  const moved = database.rebindDoctorUsers({ sourceDoctorIds: ["d1"], targetDoctorId: "d2" });
  assert.equal(moved.moved, 1);
  assert.equal(moved.username, "другая");
  assert.equal(database.getUserById(doctor.id).doctor_id, "d2");
  assert.equal(database.getUserById(doctor.id).display_name, "Другая Врач");
});

test("five failed password attempts lock the doctor account", t => {
  const { auth } = fixture(t);
  auth.setupAdmin({ username: "boss", displayName: "Руководитель", password: "1" });
  const doctor = auth.createDoctorUser({
    doctorId: "d1",
    displayName: "Тестов Врач",
  });
  auth.logout();
  for (let attempt = 1; attempt <= 4; attempt++) {
    assert.throws(() => auth.login({ userId: doctor.id, password: "WrongPassword1" }), /Неверный/);
  }
  assert.throws(() => auth.login({ userId: doctor.id, password: "WrongPassword1" }), /заблокирован/);
  assert.throws(() => auth.login({ userId: doctor.id, password: doctor.temporaryPassword }), /временно заблокирован/);
});

test("a newer publication never leaks a page left over from an older publication bundle", t => {
  const { database, auth } = fixture(t);
  const admin = auth.setupAdmin({ username: "boss", displayName: "Руководитель", password: "1" }).user;
  database.publish({
    periodKey: "2026-01",
    createdBy: admin.id,
    pages: [
      { doctorId: "d1", pageType: "doctor", scopeId: "d1", title: "Врач", html: "<div>Врач v1</div>" },
      { doctorId: "d1", pageType: "specialization", scopeId: "Кардиология", title: "Специализация", html: "<div>Специализация v1</div>" },
    ],
  });
  database.publish({
    periodKey: "2026-01",
    createdBy: admin.id,
    pages: [
      { doctorId: "d1", pageType: "doctor", scopeId: "d1", title: "Врач", html: "<div>Врач v2</div>" },
    ],
  });
  assert.match(database.getPublishedPage({ doctorId: "d1", periodKey: "2026-01", pageType: "doctor" }).html, /v2/);
  assert.equal(database.getPublishedPage({ doctorId: "d1", periodKey: "2026-01", pageType: "specialization" }), null);
});

test("comments and immutable published pages survive a portable backup", async t => {
  const { root, config, database, auth } = fixture(t);
  const setup = auth.setupAdmin({ username: "boss", displayName: "Руководитель", password: "SecureAdmin2026" });
  const adminId = setup.user.id;
  auth.createDoctorUser({
    doctorId: "d1",
    displayName: "Тестов Врач",
  });
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
    pages: [{
      doctorId: "d1",
      pageType: "doctor",
      scopeId: "d1",
      title: "Личный отчёт",
      html: '<div class="card">Опубликованная версия 1</div>',
    }],
  });
  const firstPage = database.getPublishedPage({ doctorId: "d1", periodKey: "2026-01", pageType: "doctor" });
  database.publish({
    periodKey: "2026-01",
    createdBy: adminId,
    pages: [{
      doctorId: "d1",
      pageType: "doctor",
      scopeId: "d1",
      title: "Личный отчёт",
      html: '<div class="card">Опубликованная версия 2</div>',
    }],
  });
  assert.match(firstPage.html, /версия 1/);
  assert.match(database.getPublishedPage({ doctorId: "d1", periodKey: "2026-01", pageType: "doctor" }).html, /версия 2/);

  const backups = new BackupService({ database, configStore: config });
  const portable = path.join(root, "complete.ovbackup");
  await backups.createPortable(portable);
  const preview = DatabaseService.inspect(portable);
  assert.equal(preview.users, 2);
  assert.equal(preview.comments, 1);
  assert.equal(preview.publications, 2);

  database.archiveComment(1, adminId);
  await backups.restore(portable);
  assert.equal(database.listComments({ periodKey: "2026-01" })[0].status, "published");
  assert.match(database.getPublishedPage({ doctorId: "d1", periodKey: "2026-01", pageType: "doctor" }).html, /версия 2/);
});

test("a full backup from one installation restores users, comments and publications into a clean installation", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-transfer-"));
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
  const doctor = sourceAuth.createDoctorUser({ doctorId: "d1", displayName: "Тестов Врач" });
  const commentFixtures = [
    { scopeType: "department", scopeId: "Терапия", blockKey: "department.overview", text: "Комментарий отделения" },
    { scopeType: "specialization", scopeId: "Кардиология", blockKey: "specialization.overview", text: "Комментарий специализации" },
    { scopeType: "doctor", scopeId: "d1", blockKey: "doctor.overview", text: "Личный комментарий" },
  ];
  for (const item of commentFixtures) {
    sourceDatabase.saveCommentDraft({
      scopeType: item.scopeType,
      scopeId: item.scopeId,
      periodKey: "2026-01",
      blockKey: item.blockKey,
      bodyHtml: `<p>${item.text}</p>`,
      bodyText: item.text,
      authorUserId: admin.id,
    });
  }
  sourceDatabase.publish({
    periodKey: "2026-01",
    createdBy: admin.id,
    pages: [
      { doctorId: "d1", pageType: "department", scopeId: "Терапия", title: "Отделение", html: "<div>Комментарий отделения</div>" },
      { doctorId: "d1", pageType: "specialization", scopeId: "Кардиология", title: "Специализация", html: "<div>Комментарий специализации</div>" },
      { doctorId: "d1", pageType: "doctor", scopeId: "d1", title: "Врач", html: "<div>Личный комментарий</div>" },
    ],
  });
  sourceDatabase.recordImport({
    source: { sha256: "b".repeat(64), path: "C:\\1C\\report.xlsx", name: "report.xlsx", size: 100 },
    log: { status: "загружено", type: "vyrabotka", month: "2026-01", doctor: "Тестов Врач" },
  });

  assert.equal(targetDatabase.hasUsers(), false);
  assert.equal(targetDatabase.listComments({ periodKey: "2026-01" }).length, 0);
  const portable = path.join(root, "transfer.ovbackup");
  await new BackupService({ database: sourceDatabase, configStore: sourceConfig }).createPortable(portable);
  const targetWorkspace = targetConfig.publicConfig().workspaceRoot;
  const restored = await new BackupService({ database: targetDatabase, configStore: targetConfig }).restore(portable);

  assert.equal(restored.preview.users, 2);
  assert.equal(restored.preview.comments, 3);
  assert.equal(restored.preview.publications, 1);
  assert.equal(targetConfig.publicConfig().workspaceRoot, targetWorkspace);
  assert.deepEqual(
    targetDatabase.listComments({ periodKey: "2026-01" }).map(item => item.bodyText).sort(),
    commentFixtures.map(item => item.text).sort(),
  );
  assert.equal(targetDatabase.db.prepare("SELECT COUNT(*) AS n FROM comment_versions").get().n, 6);
  assert.equal(targetDatabase.db.prepare("SELECT COUNT(*) AS n FROM import_events").get().n, 1);

  const targetAuth = new AuthService({ database: targetDatabase });
  const loggedIn = targetAuth.login({ userId: doctor.id, password: doctor.temporaryPassword });
  assert.equal(loggedIn.user.doctorId, "d1");
  assert.throws(() => targetAuth.requireDoctorReady(), /заменить временный пароль/);
  targetAuth.changePassword({ currentPassword: doctor.temporaryPassword, newPassword: "1" });
  assert.match(targetDatabase.getPublishedPage({
    doctorId: targetAuth.requireDoctorReady().doctorId,
    periodKey: "2026-01",
    pageType: "doctor",
  }).html, /Личный комментарий/);
});
