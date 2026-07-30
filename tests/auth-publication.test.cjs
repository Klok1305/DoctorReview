"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AuthService, verifyPassword } = require("../desktop/services/auth-service.cjs");
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

test("administrator setup and doctor password flow keep hashes out of public records", t => {
  const { database, auth } = fixture(t);
  const setup = auth.setupAdmin({ username: "boss", displayName: "Руководитель", password: "SecureAdmin2026" });
  assert.equal(setup.user.role, "admin");
  const doctor = auth.createDoctorUser({
    doctorId: "d1",
    username: "doctor_d1",
    displayName: "Тестов Врач",
    password: "Temporary2026",
  });
  assert.equal(doctor.mustChangePassword, true);
  const raw = database.getUserById(doctor.id);
  assert.notEqual(raw.password_hash, "Temporary2026");
  assert.equal(verifyPassword("Temporary2026", raw), true);
  assert.equal(Object.hasOwn(doctor, "passwordHash"), false);

  auth.logout();
  const candidates = database.listDoctorLoginCandidates("тест");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].department, "Терапия");
  const loggedIn = auth.login({ userId: doctor.id, password: "Temporary2026" });
  assert.equal(loggedIn.user.doctorId, "d1");
  auth.changePassword({ currentPassword: "Temporary2026", newPassword: "Personal2026" });
  assert.equal(database.getUserById(doctor.id).must_change_password, 0);
});

test("five failed password attempts lock the doctor account", t => {
  const { auth } = fixture(t);
  auth.setupAdmin({ username: "boss", displayName: "Руководитель", password: "SecureAdmin2026" });
  const doctor = auth.createDoctorUser({
    doctorId: "d1",
    username: "doctor_d1",
    displayName: "Тестов Врач",
    password: "Temporary2026",
  });
  auth.logout();
  for (let attempt = 1; attempt <= 4; attempt++) {
    assert.throws(() => auth.login({ userId: doctor.id, password: "WrongPassword1" }), /Неверный/);
  }
  assert.throws(() => auth.login({ userId: doctor.id, password: "WrongPassword1" }), /заблокирован/);
  assert.throws(() => auth.login({ userId: doctor.id, password: "Temporary2026" }), /временно заблокирован/);
});

test("comments and immutable published pages survive a portable backup", async t => {
  const { root, config, database, auth } = fixture(t);
  const setup = auth.setupAdmin({ username: "boss", displayName: "Руководитель", password: "SecureAdmin2026" });
  const adminId = setup.user.id;
  auth.createDoctorUser({
    doctorId: "d1",
    username: "doctor_d1",
    displayName: "Тестов Врач",
    password: "Temporary2026",
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
