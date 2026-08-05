"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseService } = require("../desktop/services/database.cjs");
const { createViewerPackage, inspectViewerPackage } = require("../desktop/services/viewer-package-service.cjs");
const { ViewerStorageService } = require("../viewer/storage-service.cjs");

function adminUser(database) {
  return database.createUser({
    username: "admin",
    displayName: "Администратор",
    role: "admin",
    passwordHash: "hash",
    passwordSalt: "salt",
    passwordParams: "{}",
  });
}

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
  const admin = adminUser(database);
  t.after(() => {
    try { database.close(); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, database, admin };
}

test("doctor PINs are unique, persistent and versioned only after a manual change", t => {
  const { database } = fixture(t);
  const first = database.viewerAccessSnapshot();
  const second = database.viewerAccessSnapshot();
  assert.equal(first.doctors.length, 2);
  assert.equal(new Set(first.doctors.map(item => item.pin)).size, 2);
  assert.deepEqual(second.doctors.map(item => [item.doctorId, item.pin, item.pinVersion]),
    first.doctors.map(item => [item.doctorId, item.pin, item.pinVersion]));

  const original = first.doctors[0];
  const unchanged = database.updateViewerDoctorAccess({
    doctorId: original.doctorId,
    active: true,
    pin: original.pin,
    windowsAccount: "CLINIC\\doctor1",
  });
  assert.equal(unchanged.pinVersion, original.pinVersion);
  assert.equal(unchanged.windowsAccount, "CLINIC\\doctor1");

  const replacement = original.pin === "1234" ? "4321" : "1234";
  const changed = database.updateViewerDoctorAccess({ doctorId: original.doctorId, active: true, pin: replacement });
  assert.equal(changed.pinVersion, original.pinVersion + 1);
  assert.equal(changed.pin, replacement);
});

test("a verified ZIP can bootstrap Viewer and expose only published pages", async t => {
  const { root, database } = fixture(t);
  database.setViewerAdminPin("654321");
  const access = database.viewerAccessSnapshot().doctors[0];
  database.updateViewerDoctorAccess({ doctorId: access.doctorId, active: true, pin: "1357", windowsAccount: "" });
  const credentials = database.viewerExportCredentials([access.doctorId]);
  const created = await createViewerPackage({
    appVersion: "2.2.0",
    periods: ["2026-01"],
    doctors: [{ doctorId: access.doctorId, displayName: "Первый Врач", department: "Терапия", specialization: "Кардиология" }],
    pages: [{ doctorId: access.doctorId, periodKey: "2026-01", pageType: "doctor", scopeId: access.doctorId,
      title: "Январский отчёт", html: '<div class="card"><h1>Отчёт</h1><script>bad()</script><p>Комментарий</p></div>' }],
    credentials,
  });
  const inspected = await inspectViewerPackage(created.buffer);
  assert.equal(inspected.preview.doctors.length, 1);
  assert.equal(inspected.preview.periods[0], "2026-01");
  assert.equal(inspected.manifest.adminAccess.pinVersion, 1);
  assert.equal("pinCode" in inspected.manifest.adminAccess, false);

  const archive = path.join(root, "publication.zip");
  fs.writeFileSync(archive, created.buffer);
  const storageRoot = path.join(root, "share");
  fs.mkdirSync(storageRoot);
  const viewer = new ViewerStorageService({ configPath: path.join(root, "viewer-config.json") });
  viewer.setStorageRoot(storageRoot);
  const imported = await viewer.importPackageFile(archive, { bootstrapPin: "654321" });
  assert.equal(imported.doctors, 1);
  assert.equal(viewer.status().initialized, true);
  assert.equal(viewer.status().catalog.doctors.length, 1);

  const session = viewer.doctorLogin({ doctorId: access.doctorId, pin: "1357" });
  const report = viewer.readReport(session, { periodKey: "2026-01", pageType: "doctor" });
  assert.match(report.html, /Комментарий/);
  assert.doesNotMatch(report.html, /<script/i);
  assert.equal(viewer.readReport(session, { periodKey: "2026-01", pageType: "department" }), null);
  assert.throws(() => viewer.doctorLogin({ doctorId: access.doctorId, pin: "0000" }), /Неверный PIN/);
  assert.equal(fs.existsSync(path.join(storageRoot, "_viewer", "acl-mapping.csv")), true);
});
