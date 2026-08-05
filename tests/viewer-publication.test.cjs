"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { DatabaseService } = require("../desktop/services/database.cjs");
const {
  ENCRYPTED_PAGE_FORMAT,
  createViewerPackage,
  inspectViewerPackage,
} = require("../desktop/services/viewer-package-service.cjs");
const { ViewerStorageService } = require("../viewer/storage-service.cjs");

function snapshot() {
  return {
    version: 4,
    settings: { showScores: true, depts: {} },
    doctors: {
      d1: { name: "Первый Врач", department: "Терапия", specialization: "Кардиология", aliases: [] },
      d2: { name: "Второй Врач", department: "Терапия", specialization: "Неврология", aliases: [] },
    },
    months: { "2026-01": { vyrabotka: {}, kb: {}, naznach: {}, pervichka: {}, prostoy: {}, zapis: {}, manual6: {} } },
    dynamicNotes: {},
    fileLog: [],
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-viewer-test-"));
  const database = new DatabaseService(path.join(root, "admin.sqlite"));
  database.saveSnapshot(snapshot());
  t.after(() => {
    try { database.close(); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, database };
}

test("doctor PINs are unique, persistent and independent from Windows accounts", t => {
  const { database } = fixture(t);
  const first = database.viewerAccessSnapshot();
  const second = database.viewerAccessSnapshot();
  assert.equal(first.doctors.length, 2);
  assert.equal(new Set(first.doctors.map(item => item.pin)).size, 2);
  assert.deepEqual(second.doctors.map(item => [item.doctorId, item.pin, item.pinVersion]),
    first.doctors.map(item => [item.doctorId, item.pin, item.pinVersion]));

  const original = first.doctors[0];
  const unchanged = database.updateViewerDoctorAccess({ doctorId: original.doctorId, active: true, pin: original.pin });
  assert.equal(unchanged.pinVersion, original.pinVersion);
  assert.equal("windowsAccount" in unchanged, false);
  const columns = database.db.prepare("PRAGMA table_info(viewer_doctor_access)").all().map(row => row.name);
  assert.equal(columns.includes("windows_account"), false);

  const replacement = original.pin === "1234" ? "4321" : "1234";
  const changed = database.updateViewerDoctorAccess({ doctorId: original.doctorId, active: true, pin: replacement });
  assert.equal(changed.pinVersion, original.pinVersion + 1);
  assert.equal(changed.pin, replacement);
});

test("schema 3 viewer access migrates without losing PINs and drops the Windows account column", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-viewer-v3-"));
  const dbPath = path.join(root, "legacy.sqlite");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations(version, applied_at) VALUES (3, '2026-01-01T00:00:00.000Z');
    CREATE TABLE viewer_doctor_access (
      doctor_id TEXT PRIMARY KEY,
      active INTEGER NOT NULL DEFAULT 0,
      pin_code TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      pin_salt TEXT NOT NULL,
      pin_params TEXT NOT NULL,
      pin_version INTEGER NOT NULL DEFAULT 1,
      windows_account TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    INSERT INTO viewer_doctor_access VALUES ('d1', 1, '1357', 'hash', 'salt', '{}', 3, 'CLINIC\\doctor', '2026-01-01T00:00:00.000Z');
  `);
  legacy.close();
  const database = new DatabaseService(dbPath);
  t.after(() => {
    try { database.close(); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  const columns = database.db.prepare("PRAGMA table_info(viewer_doctor_access)").all().map(row => row.name);
  const row = database.db.prepare("SELECT * FROM viewer_doctor_access WHERE doctor_id = 'd1'").get();
  assert.equal(columns.includes("windows_account"), false);
  assert.equal(row.pin_code, "1357");
  assert.equal(row.pin_version, 3);
});

test("encrypted ZIP bootstraps Viewer and doctor enters by name and PIN only", async t => {
  const { root, database } = fixture(t);
  database.setViewerAdminPin("654321");
  const access = database.viewerAccessSnapshot().doctors[0];
  database.updateViewerDoctorAccess({ doctorId: access.doctorId, active: true, pin: "1357" });
  const credentials = database.viewerExportCredentials([access.doctorId]);
  const created = await createViewerPackage({
    appVersion: "2.2.1",
    periods: ["2026-01"],
    doctors: [{ doctorId: access.doctorId, displayName: "Первый Врач", department: "Терапия", specialization: "Кардиология" }],
    pages: [{
      doctorId: access.doctorId,
      periodKey: "2026-01",
      pageType: "doctor",
      scopeId: access.doctorId,
      title: "Январский отчёт",
      html: '<div class="card"><h1>Отчёт</h1><script>bad()</script><p>Комментарий</p></div>',
    }],
    credentials,
  });
  const inspected = await inspectViewerPackage(created.buffer, { includeZip: true });
  assert.equal(inspected.preview.doctors.length, 1);
  assert.equal(inspected.preview.periods[0], "2026-01");
  assert.equal(inspected.manifest.formatVersion, 2);
  assert.equal(inspected.manifest.adminAccess.pinVersion, 1);
  assert.equal("pinCode" in inspected.manifest.adminAccess, false);
  assert.equal("windowsAccount" in inspected.manifest.doctors[0], false);

  const folderId = inspected.manifest.doctors[0].folderId;
  const profile = JSON.parse(await inspected.zip.file(`doctors/${folderId}/profile.json`).async("string"));
  const publishedAccess = JSON.parse(await inspected.zip.file(`doctors/${folderId}/access.json`).async("string"));
  const encryptedText = await inspected.zip.file(`doctors/${folderId}/reports/2026-01/doctor.json`).async("string");
  const encrypted = JSON.parse(encryptedText);
  assert.equal(encrypted.format, ENCRYPTED_PAGE_FORMAT);
  assert.equal("pinCode" in publishedAccess, false);
  assert.equal("windowsAccount" in profile, false);
  assert.doesNotMatch(encryptedText, /Комментарий|<script|<div/);

  const archive = path.join(root, "publication.zip");
  fs.writeFileSync(archive, created.buffer);
  const storageRoot = path.join(root, "share");
  fs.mkdirSync(path.join(storageRoot, "_viewer"), { recursive: true });
  fs.writeFileSync(path.join(storageRoot, "_viewer", "acl-mapping.csv"), "stale", "utf8");
  const viewer = new ViewerStorageService({ configPath: path.join(root, "viewer-config.json") });
  viewer.setStorageRoot(storageRoot);
  const imported = await viewer.importPackageFile(archive, { bootstrapPin: "654321" });
  assert.equal(imported.doctors, 1);
  assert.equal(viewer.status().initialized, true);
  assert.equal(viewer.status().catalog.doctors.length, 1);
  assert.equal(fs.existsSync(path.join(storageRoot, "_viewer", "acl-mapping.csv")), false);

  const session = viewer.doctorLogin({ doctorId: access.doctorId, pin: "1357" });
  const report = viewer.readReport(session, { periodKey: "2026-01", pageType: "doctor" });
  assert.match(report.html, /Комментарий/);
  assert.doesNotMatch(report.html, /<script/i);
  assert.equal(viewer.readReport(session, { periodKey: "2026-01", pageType: "department" }), null);

  for (let attempt = 1; attempt <= 4; attempt++) {
    assert.throws(() => viewer.doctorLogin({ doctorId: access.doctorId, pin: "0000" }), /Неверный PIN/);
  }
  assert.throws(() => viewer.doctorLogin({ doctorId: access.doctorId, pin: "0000" }), /заблокирован/);
  assert.throws(() => viewer.doctorLogin({ doctorId: access.doctorId, pin: "1357" }), /временно заблокирован/);
});
