"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");
const JSZip = require("../build/jszip.min.js");
const { DatabaseService } = require("../desktop/services/database.cjs");
const {
  FORMAT_VERSION,
  SHARED_PAGE_FORMAT,
  STANDALONE_FORMAT,
  createStandaloneViewerHtml,
  createViewerPackage,
  decryptSharedPage,
  decryptViewerGrant,
  encryptViewerPage,
  estimateViewerPublication,
  inspectViewerPackage,
  reportModelFromLegacyPages,
  reportModelJsonAdapter,
  reportDoctorIdsInSnapshot,
  validateFullViewerExportSelection,
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

function decryptStandaloneRecord(record, pin) {
  const key = crypto.pbkdf2Sync(pin, Buffer.from(record.encryption.salt, "base64"), record.encryption.iterations,
    record.encryption.keyLength / 8, "sha256");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(record.encryption.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.encryption.tag, "base64"));
  return JSON.parse(zlib.gunzipSync(Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final(),
  ])).toString("utf8"));
}

function reportsFromStandaloneBundle(bundle, payload) {
  const records = new Map(bundle.sharedPages.map(record => [record.pageId, record]));
  return payload.bindings.map(binding => ({
    ...decryptSharedPage(records.get(binding.pageId), payload.pageKeys[binding.pageId]),
    doctorId: binding.doctorId,
  }));
}

async function createLegacyV3Package({ doctor, credentials, html = "<div>Старый отчёт</div>" }) {
  const zip = new JSZip();
  const packageId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const folderId = crypto.createHash("sha256").update(doctor.doctorId).digest("hex").slice(0, 24);
  const files = {};
  const addJson = (filePath, value) => {
    const bytes = Buffer.from(JSON.stringify(value, null, 2), "utf8");
    files[filePath] = crypto.createHash("sha256").update(bytes).digest("hex");
    zip.file(filePath, bytes);
  };
  addJson(`doctors/${folderId}/profile.json`, { ...doctor, folderId, managedDepartments: [], visibleDoctorIds: [doctor.doctorId] });
  const access = credentials.doctors[0];
  addJson(`doctors/${folderId}/access.json`, {
    pinHash: access.pinHash, pinSalt: access.pinSalt, pinParams: access.pinParams, pinVersion: access.pinVersion,
  });
  addJson(`doctors/${folderId}/subjects/${folderId}/reports/2026-01/doctor.json`, encryptViewerPage({
    packageId, createdAt, doctorId: doctor.doctorId, periodKey: "2026-01", pageType: "doctor",
    scopeId: doctor.doctorId, title: "Старый отчёт", html,
  }, access.pinCode));
  const manifest = {
    format: "pulse-clinic-viewer-package", formatVersion: 3, packageId, createdAt, appVersion: "2.6.15",
    periods: ["2026-01"], pageTypes: ["doctor"],
    doctors: [{ ...doctor, folderId, pinVersion: access.pinVersion, managedDepartments: [], visibleDoctorIds: [doctor.doctorId] }],
    subjects: [{ ...doctor, folderId }],
    adminAccess: {
      pinHash: credentials.admin.pinHash, pinSalt: credentials.admin.pinSalt,
      pinParams: credentials.admin.pinParams, pinVersion: credentials.admin.pinVersion,
    },
    files,
  };
  zip.file("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
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

  const beforeReopen = database.viewerExportCredentials([original.doctorId], { requireAdmin: false }).doctors[0];
  const databasePath = database.databasePath;
  database.close();
  database.open(databasePath);
  const afterReopen = database.viewerExportCredentials([original.doctorId], { requireAdmin: false }).doctors[0];
  assert.deepEqual(
    [afterReopen.pinCode, afterReopen.pinVersion, afterReopen.pinHash, afterReopen.pinSalt, afterReopen.pinParams],
    [beforeReopen.pinCode, beforeReopen.pinVersion, beforeReopen.pinHash, beforeReopen.pinSalt, beforeReopen.pinParams],
  );
});

test("full HTML gives every doctor with a work report their own existing PIN without enabling ordinary access", async t => {
  const { database } = fixture(t);
  const state = snapshot();
  state.months["2026-01"].vyrabotka = { d1: {}, d2: {} };
  database.saveSnapshot(state);
  database.setViewerAdminPin("654321");
  const access = database.viewerAccessSnapshot().doctors;
  const pinById = Object.fromEntries(access.map(item => [item.doctorId, item.pin]));
  database.updateViewerDoctorAccess({ doctorId: "d1", active: true, pin: pinById.d1 });
  assert.deepEqual(reportDoctorIdsInSnapshot(state), ["d1", "d2"]);
  const fullSelection = { doctors: [{ doctorId: "d1" }, { doctorId: "d2" }], periods: ["2026-01"],
    reportModel: { bindings: [{ doctorId: "d1", periodKey: "2026-01", pageType: "doctor" },
      { doctorId: "d2", periodKey: "2026-01", pageType: "doctor" }] } };
  assert.deepEqual(validateFullViewerExportSelection(state, fullSelection, "html"), ["d1", "d2"]);
  assert.throws(() => validateFullViewerExportSelection(state, { ...fullSelection, doctors: [{ doctorId: "d1" }] }, "html"),
    /не все врачи/);
  assert.throws(() => validateFullViewerExportSelection(state, { ...fullSelection, reportModel: { bindings: fullSelection.reportModel.bindings.slice(0, 1) } }, "html"),
    /отсутствует личный отчёт/);
  assert.throws(() => validateFullViewerExportSelection(state, fullSelection, "zip"), /только для HTML/);
  assert.throws(() => database.viewerExportCredentials(["d1", "d2"], { adminPin: "654321" }), /Доступ врача d2 не включён/);
  const credentials = database.viewerExportCredentials(["d1", "d2"], {
    adminPin: "654321", allowInactiveDoctorIds: reportDoctorIdsInSnapshot(state),
  });
  assert.deepEqual(credentials.doctors.map(item => item.pinCode), [pinById.d1, pinById.d2]);
  const doctors = [
    { doctorId: "d1", displayName: "Первый Врач", department: "Терапия", specialization: "Кардиология" },
    { doctorId: "d2", displayName: "Второй Врач", department: "Терапия", specialization: "Неврология" },
  ];
  const created = await createStandaloneViewerHtml({
    appVersion: "2.6.19", credentials, doctors, subjects: doctors, periods: ["2026-01"],
    pages: doctors.map(doctor => ({ doctorId: doctor.doctorId, periodKey: "2026-01", pageType: "doctor",
      scopeId: doctor.doctorId, title: "Личный отчёт", html: `<div>${doctor.displayName}</div>` })),
  });
  const embedded = created.buffer.toString("utf8").match(/<script id="standaloneViewerData" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(embedded);
  const bundle = JSON.parse(embedded[1]);
  assert.equal(bundle.doctors.length, 2);
  const inactiveDoctor = bundle.doctors.find(doctor => doctor.doctorId === "d2");
  const grant = decryptStandaloneRecord(inactiveDoctor, pinById.d2);
  assert.deepEqual(grant.subjects.map(subject => subject.doctorId), ["d2"]);
  assert.match(reportsFromStandaloneBundle(bundle, grant)[0].html, /Второй Врач/);
  assert.equal(database.viewerAccessSnapshot().doctors.find(item => item.doctorId === "d2").active, false);
});

test("department head assignment persists, enables the head and reaches export credentials", t => {
  const { database } = fixture(t);
  const before = database.viewerAccessSnapshot();
  assert.deepEqual(before.departmentHeads, {});
  const assigned = database.updateViewerDepartmentHead({ department: "Терапия", doctorId: "d1" });
  assert.equal(assigned.departmentHeads["Терапия"], "d1");
  assert.equal(assigned.doctors.find(item => item.doctorId === "d1").active, true);
  const databasePath = database.databasePath;
  database.close();
  database.open(databasePath);
  assert.equal(database.viewerAccessSnapshot().departmentHeads["Терапия"], "d1");
  const credentials = database.viewerExportCredentials(["d1"], { requireAdmin: false });
  assert.deepEqual(credentials.doctors[0].headDepartments, ["Терапия"]);
  assert.throws(() => database.updateViewerDoctorAccess({ doctorId: "d1", active: false }), /снимите врача с роли заведующего/);
  const cleared = database.updateViewerDepartmentHead({ department: "Терапия", doctorId: "" });
  assert.deepEqual(cleared.departmentHeads, {});
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
  const headTable = database.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'viewer_department_heads'").get();
  const row = database.db.prepare("SELECT * FROM viewer_doctor_access WHERE doctor_id = 'd1'").get();
  assert.equal(columns.includes("windows_account"), false);
  assert.equal(row.pin_code, "1357");
  assert.equal(row.pin_version, 3);
  assert.ok(headTable);
});

test("encrypted ZIP bootstraps Viewer and doctor enters by name and PIN only", async t => {
  const { root, database } = fixture(t);
  database.setViewerAdminPin("654321");
  const access = database.viewerAccessSnapshot().doctors[0];
  database.updateViewerDoctorAccess({ doctorId: access.doctorId, active: true, pin: "1357" });
  const credentials = database.viewerExportCredentials([access.doctorId]);
  const created = await createViewerPackage({
    appVersion: "2.3.0",
    periods: ["2026-01"],
    doctors: [{ doctorId: access.doctorId, displayName: "Первый Врач", department: "Терапия", specialization: "Кардиология" }],
    pages: [{
      doctorId: access.doctorId,
      periodKey: "2026-01",
      pageType: "doctor",
      scopeId: access.doctorId,
      title: "Январский отчёт",
      html: '<div class="card"><h1>Отчёт</h1><script>bad()</script><p>Комментарий</p><img class="pdf-chart-image" src="data:image/webp;base64,UklGRg==" alt="График"></div>',
    }],
    credentials,
  });
  const inspected = await inspectViewerPackage(created.buffer, { includeZip: true });
  assert.equal(inspected.preview.doctors.length, 1);
  assert.equal(inspected.preview.periods[0], "2026-01");
  assert.equal(inspected.manifest.formatVersion, FORMAT_VERSION);
  assert.equal(inspected.manifest.adminAccess.pinVersion, 1);
  assert.equal("pinCode" in inspected.manifest.adminAccess, false);
  assert.equal("windowsAccount" in inspected.manifest.doctors[0], false);

  const folderId = inspected.manifest.doctors[0].folderId;
  const profile = JSON.parse(await inspected.zip.file(`doctors/${folderId}/profile.json`).async("string"));
  const publishedAccess = JSON.parse(await inspected.zip.file(`doctors/${folderId}/access.json`).async("string"));
  const encryptedText = await inspected.zip.file(`doctors/${folderId}/grant.json`).async("string");
  const grant = decryptViewerGrant(JSON.parse(encryptedText), "1357");
  const pageId = grant.bindings[0].pageId;
  const sharedText = await inspected.zip.file(`pages/${pageId}.json`).async("string");
  const shared = JSON.parse(sharedText);
  assert.equal(shared.format, SHARED_PAGE_FORMAT);
  assert.match(decryptSharedPage(shared, grant.pageKeys[pageId]).html, /Комментарий/);
  assert.equal("pinCode" in publishedAccess, false);
  assert.equal("windowsAccount" in profile, false);
  assert.doesNotMatch(encryptedText + sharedText, /Комментарий|<script|<div/);

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
  assert.match(report.html, /data:image\/webp;base64,UklGRg==/);
  assert.doesNotMatch(report.html, /<script/i);
  assert.equal(viewer.readReport(session, { periodKey: "2026-01", pageType: "department" }), null);

  for (let attempt = 1; attempt <= 4; attempt++) {
    assert.throws(() => viewer.doctorLogin({ doctorId: access.doctorId, pin: "0000" }), /Неверный PIN/);
  }
  assert.throws(() => viewer.doctorLogin({ doctorId: access.doctorId, pin: "0000" }), /заблокирован/);
  assert.throws(() => viewer.doctorLogin({ doctorId: access.doctorId, pin: "1357" }), /временно заблокирован/);
});

test("ReportModel is immutable, revisioned and deduplicates shared pages before size estimation", t => {
  const periods = ["2026-01"];
  const pages = ["d1", "d2"].map(doctorId => ({
    doctorId,
    periodKey: "2026-01",
    pageType: "department",
    scopeId: "Терапия",
    title: "Общий отчёт",
    html: "<div>Одна общая страница</div>",
  }));
  const model = reportModelFromLegacyPages(periods, pages);
  assert.match(model.revision, /^[a-f0-9]{64}$/);
  assert.equal(model.pages.length, 1);
  assert.equal(model.bindings.length, 2);
  assert.equal(Object.isFrozen(model), true);
  assert.equal(Object.isFrozen(model.pages), true);
  assert.throws(() => { model.pages.push({}); }, TypeError);
  const json = reportModelJsonAdapter(model);
  json.pages[0].title = "Изменено только в адаптере";
  assert.equal(model.pages[0].title, "Общий отчёт");

  const credentials = {
    doctors: [
      { doctorId: "d1", pinCode: "1357", pinVersion: 1, pinHash: "a", pinSalt: "b", pinParams: "{}", headDepartments: [] },
      { doctorId: "d2", pinCode: "2468", pinVersion: 1, pinHash: "c", pinSalt: "d", pinParams: "{}", headDepartments: [] },
    ],
    admin: { pinVersion: 1, pinHash: "e", pinSalt: "f", pinParams: "{}" },
  };
  const doctors = ["d1", "d2"].map(doctorId => ({ doctorId, displayName: doctorId, department: "Терапия", specialization: "Общая" }));
  const estimate = estimateViewerPublication({ doctors, subjects: doctors, periods, reportModel: model, credentials }, "zip");
  assert.equal(estimate.uniquePages, 1);
  assert.equal(estimate.bindings, 2);
  assert.equal(estimate.duplicatedPagesAvoided, 1);
  assert.equal(estimate.withinLimit, true);
});

test("renderer sanitizes Viewer HTML before hashing pages and the service verifies the same model", async () => {
  const sanitizerSource = fs.readFileSync(path.join(__dirname, "..", "build", "viewer-html-sanitizer.js"), "utf8");
  const uiSource = fs.readFileSync(path.join(__dirname, "..", "build", "app-ui.js"), "utf8");
  const modelSource = uiSource.slice(uiSource.indexOf("const REPORT_MODEL_FORMAT ="), uiSource.indexOf("function reportModelJsonAdapter"));
  const context = vm.createContext({ window: { crypto: crypto.webcrypto }, TextEncoder });
  vm.runInContext(sanitizerSource, context);
  vm.runInContext(modelSource, context);
  const createModel = vm.runInContext("createImmutableReportModel", context);
  const model = await createModel(["2026-01"], [{
    doctorId: "d1", periodKey: "2026-01", pageType: "doctor", scopeId: "d1", title: "Отчёт",
    html: '<div>Отчёт <a href="#" onclick="switchTab(\'settings\')">Настройки</a><img src="data:image/png;base64,AA==" onerror="alert(1)"><script>alert(1)</script></div>',
  }]);
  assert.match(model.pages[0].html, /href="#"/);
  assert.match(model.pages[0].html, /data:image\/png/);
  assert.doesNotMatch(model.pages[0].html, /onclick|onerror|<script/);
  const doctor = { doctorId: "d1", displayName: "Врач", department: "Терапия", specialization: "Общая" };
  const credentials = {
    doctors: [{ doctorId: "d1", pinCode: "1357", pinVersion: 1, pinHash: "a", pinSalt: "b", pinParams: "{}", headDepartments: [] }],
    admin: { pinVersion: 1, pinHash: "c", pinSalt: "d", pinParams: "{}" },
  };
  assert.equal(estimateViewerPublication({ doctors: [doctor], subjects: [doctor], periods: ["2026-01"], reportModel: model, credentials }, "zip").uniquePages, 1);
  const altered = reportModelJsonAdapter(model);
  altered.pages[0].html += "<div>Подмена</div>";
  assert.throws(() => estimateViewerPublication({ doctors: [doctor], subjects: [doctor], periods: ["2026-01"], reportModel: altered, credentials }, "zip"),
    /Содержимое страницы не соответствует её идентификатору/);
});

test("Viewer imports legacy format 3 into an atomic catalog generation", async t => {
  const { root, database } = fixture(t);
  database.setViewerAdminPin("654321");
  database.updateViewerDoctorAccess({ doctorId: "d1", active: true, pin: "1357" });
  const credentials = database.viewerExportCredentials(["d1"]);
  const doctor = { doctorId: "d1", displayName: "Первый Врач", department: "Терапия", specialization: "Кардиология" };
  const buffer = await createLegacyV3Package({ doctor, credentials });
  const archive = path.join(root, "legacy-v3.zip");
  fs.writeFileSync(archive, buffer);
  const storageRoot = path.join(root, "legacy-share");
  fs.mkdirSync(storageRoot, { recursive: true });
  const viewer = new ViewerStorageService({ configPath: path.join(root, "legacy-viewer-config.json") });
  viewer.setStorageRoot(storageRoot);
  const imported = await viewer.importPackageFile(archive, { bootstrapPin: "654321" });
  assert.ok(imported.generationId);
  assert.equal(JSON.parse(fs.readFileSync(path.join(storageRoot, "_viewer", "current.json"), "utf8")).generationId, imported.generationId);
  const report = viewer.readReport(viewer.doctorLogin({ doctorId: "d1", pin: "1357" }), {
    periodKey: "2026-01", pageType: "doctor",
  });
  assert.equal(report.format, undefined);
  assert.match(report.html, /Старый отчёт/);
});

test("Viewer opens a pre-generation root catalog without migrating or deleting it", async t => {
  const { root, database } = fixture(t);
  database.setViewerAdminPin("654321");
  database.updateViewerDoctorAccess({ doctorId: "d1", active: true, pin: "1357" });
  const credentials = database.viewerExportCredentials(["d1"]);
  const doctor = { doctorId: "d1", displayName: "Первый Врач", department: "Терапия", specialization: "Кардиология" };
  const inspected = await inspectViewerPackage(await createLegacyV3Package({ doctor, credentials, html: "<div>Корневой каталог</div>" }), { includeZip: true });
  const folderId = inspected.preview.doctors[0].folderId;
  const storageRoot = path.join(root, "legacy-root-share");
  const metadataRoot = path.join(storageRoot, "doctors", folderId);
  const reportRelative = path.join("subjects", folderId, "reports", "2026-01", "doctor.json");
  fs.mkdirSync(path.join(storageRoot, "_viewer"), { recursive: true });
  fs.mkdirSync(path.join(metadataRoot, "releases", "legacy-release", path.dirname(reportRelative)), { recursive: true });
  fs.writeFileSync(path.join(storageRoot, "catalog.json"), JSON.stringify({ doctors: inspected.preview.doctors }), "utf8");
  fs.writeFileSync(path.join(storageRoot, "_viewer", "admin.json"), JSON.stringify(inspected.manifest.adminAccess), "utf8");
  fs.writeFileSync(path.join(metadataRoot, "profile.json"), await inspected.zip.file(`doctors/${folderId}/profile.json`).async("nodebuffer"));
  fs.writeFileSync(path.join(metadataRoot, "access.json"), await inspected.zip.file(`doctors/${folderId}/access.json`).async("nodebuffer"));
  fs.writeFileSync(path.join(metadataRoot, "releases", "legacy-release", reportRelative),
    await inspected.zip.file(`doctors/${folderId}/subjects/${folderId}/reports/2026-01/doctor.json`).async("nodebuffer"));
  fs.writeFileSync(path.join(metadataRoot, "index.json"), JSON.stringify({
    doctorId: "d1",
    subjects: [{ ...inspected.preview.subjects[0], publications: [{
      periodKey: "2026-01",
      pages: { doctor: { releaseId: "legacy-release", relativePath: reportRelative.replace(/\\/g, "/") } },
    }] }],
  }), "utf8");

  const viewer = new ViewerStorageService({ configPath: path.join(root, "legacy-root-config.json") });
  viewer.setStorageRoot(storageRoot);
  assert.equal(viewer.status().initialized, true);
  assert.equal(fs.existsSync(path.join(storageRoot, "_viewer", "current.json")), false);
  const report = viewer.readReport(viewer.doctorLogin({ doctorId: "d1", pin: "1357" }), {
    periodKey: "2026-01", pageType: "doctor",
  });
  assert.match(report.html, /Корневой каталог/);
  assert.equal(fs.existsSync(path.join(storageRoot, "catalog.json")), true);
});

test("Viewer keeps the previous complete generation when the catalog pointer cannot switch", async t => {
  const { root, database } = fixture(t);
  database.setViewerAdminPin("654321");
  database.updateViewerDoctorAccess({ doctorId: "d1", active: true, pin: "1357" });
  const credentials = database.viewerExportCredentials(["d1"]);
  const doctor = { doctorId: "d1", displayName: "Первый Врач", department: "Терапия", specialization: "Кардиология" };
  const publication = html => createViewerPackage({
    appVersion: "2.6.15", periods: ["2026-01"], doctors: [doctor], subjects: [doctor], credentials,
    pages: [{ doctorId: "d1", periodKey: "2026-01", pageType: "doctor", scopeId: "d1", title: "Отчёт", html }],
  });
  const first = await publication("<div>Первая версия</div>");
  const storageRoot = path.join(root, "atomic-share");
  fs.mkdirSync(storageRoot, { recursive: true });
  const archive1 = path.join(root, "atomic-1.zip");
  fs.writeFileSync(archive1, first.buffer);
  const viewer = new ViewerStorageService({ configPath: path.join(root, "atomic-viewer-config.json") });
  viewer.setStorageRoot(storageRoot);
  await viewer.importPackageFile(archive1, { bootstrapPin: "654321" });
  const pointerPath = path.join(storageRoot, "_viewer", "current.json");
  const firstGeneration = JSON.parse(fs.readFileSync(pointerPath, "utf8")).generationId;

  const second = await publication("<div>Вторая версия</div>");
  const archive2 = path.join(root, "atomic-2.zip");
  fs.writeFileSync(archive2, second.buffer);
  const originalRename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (path.resolve(destination) === path.resolve(pointerPath) && String(source).includes(".tmp-")) {
      throw new Error("injected pointer failure");
    }
    return originalRename(source, destination);
  };
  try {
    await assert.rejects(viewer.importPackageFile(archive2), /injected pointer failure/);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(JSON.parse(fs.readFileSync(pointerPath, "utf8")).generationId, firstGeneration);
  const report = viewer.readReport(viewer.doctorLogin({ doctorId: "d1", pin: "1357" }), {
    periodKey: "2026-01", pageType: "doctor",
  });
  assert.match(report.html, /Первая версия/);
  assert.doesNotMatch(report.html, /Вторая версия/);
});

test("standalone HTML encrypts doctor access and a complete administrator catalog with separate PINs", async t => {
  const { database } = fixture(t);
  database.setViewerAdminPin("654321");
  const access = database.viewerAccessSnapshot().doctors[0];
  database.updateViewerDoctorAccess({ doctorId: access.doctorId, active: true, pin: "1357" });
  assert.throws(() => database.viewerExportCredentials([access.doctorId], { adminPin: "000000" }), /Неверный администраторский PIN/);
  const credentials = database.viewerExportCredentials([access.doctorId], { adminPin: "654321" });
  assert.equal(credentials.admin.pinCode, "654321");
  const created = await createStandaloneViewerHtml({
    appVersion: "2.3.0",
    periods: ["2026-01"],
    doctors: [{ doctorId: access.doctorId, displayName: "Первый Врач", department: "Терапия", specialization: "Кардиология" }],
    pages: [{
      doctorId: access.doctorId,
      periodKey: "2026-01",
      pageType: "doctor",
      scopeId: access.doctorId,
      title: "Январский отчёт",
      html: '<div class="card"><h1>Секретный отчёт</h1><script>bad()</script><p>Комментарий врача</p><section data-viewer-patient-register><input type="search" data-viewer-patient-search><select data-viewer-patient-segment><option value="all">Все</option></select><table><tr data-viewer-patient-row><td>Секретный Пациент</td><td>P-42</td></tr></table></section></div>',
    }],
    credentials,
  });

  const html = created.buffer.toString("utf8");
  assert.match(html, /<title>КлинВект Щербатова — автономный Viewer<\/title>/);
  assert.match(html, /rel="icon" type="image\/png" href="data:image\/png;base64,[A-Za-z0-9+/=]+"/);
  assert.match(html, /class="brand-symbol" src="data:image\/png;base64,[A-Za-z0-9+/=]+"/);
  assert.doesNotMatch(html, /\/\*__FAVICON__\*\//);
  assert.equal(created.manifest.format, STANDALONE_FORMAT);
  assert.equal(created.manifest.formatVersion, 4);
  assert.equal(created.manifest.adminAccess.enabled, true);
  assert.match(html, /Автономный файл/);
  assert.match(html, /DecompressionStream/);
  assert.doesNotMatch(html, /Секретный отчёт|Комментарий врача|Секретный Пациент|P-42|<script>bad|654321/);
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=["'](?!data:image\/png)/i);

  const embedded = html.match(/<script id="standaloneViewerData" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(embedded, "standalone data must be embedded into the HTML");
  const bundle = JSON.parse(embedded[1]);
  assert.equal(bundle.doctors.length, 1);
  assert.ok(bundle.adminAccess.ciphertext);
  assert.equal(JSON.stringify(bundle).includes('"pinCode"'), false);
  const doctor = bundle.doctors[0];
  const payload = decryptStandaloneRecord(doctor, "1357");
  assert.equal(payload.doctorId, access.doctorId);
  const doctorReports = reportsFromStandaloneBundle(bundle, payload);
  assert.match(doctorReports[0].html, /Секретный отчёт|Комментарий врача/);
  assert.match(doctorReports[0].html, /Секретный Пациент|P-42/);
  assert.match(doctorReports[0].html, /data-viewer-patient-search|data-viewer-patient-segment/);
  assert.doesNotMatch(doctorReports[0].html, /<script/i);
  const adminPayload = decryptStandaloneRecord(bundle.adminAccess, "654321");
  const adminReports = reportsFromStandaloneBundle(bundle, adminPayload);
  assert.equal(adminPayload.accessRole, "admin");
  assert.deepEqual(adminPayload.subjects.map(subject => subject.doctorId), [access.doctorId]);
  assert.equal(adminReports.length, 1);
  assert.match(adminReports[0].html, /Секретный отчёт|Секретный Пациент/);
  assert.throws(() => decryptStandaloneRecord(bundle.adminAccess, "000000"));

  const standaloneSource = fs.readFileSync(path.join(__dirname, "..", "viewer", "standalone-app.js"), "utf8")
    .replace(/\ninitialize\(\);\s*$/, "");
  const browserContext = vm.createContext({
    window: { crypto: crypto.webcrypto }, crypto: crypto.webcrypto,
    document: { getElementById: id => id === "standaloneViewerData" ? { textContent: JSON.stringify(bundle) } : null },
    atob, Blob, DecompressionStream, Response, TextDecoder, TextEncoder, Uint8Array,
  });
  vm.runInContext(`${standaloneSource}\n;globalThis.__decryptStandaloneDoctor = decryptDoctor;`, browserContext);
  const browserPayload = await browserContext.__decryptStandaloneDoctor(bundle.doctors[0], "1357");
  assert.equal(browserPayload.reports.length, 1);
  assert.match(browserPayload.reports[0].html, /Секретный отчёт|Секретный Пациент/);
});

test("department head report switcher lists the department and every published specialization", () => {
  const installedSource = fs.readFileSync(path.join(__dirname, "..", "viewer", "app.js"), "utf8");
  const standaloneSource = fs.readFileSync(path.join(__dirname, "..", "viewer", "standalone-app.js"), "utf8");
  const context = vm.createContext({
    window: { viewerAPI: {} },
    document: { addEventListener() {} },
  });
  vm.runInContext(`${installedSource}\n;globalThis.__viewerNavigation = { state, availableReportScopes, renderReportScopeNavigation };`, context);
  const navigation = context.__viewerNavigation;
  navigation.state.doctor = {
    doctorId: "d1", displayName: "Заведующая", department: "Косметология",
    specialization: "Косметология", managedDepartments: ["Косметология"],
  };
  navigation.state.subjectDoctorId = "d1";
  navigation.state.subjects = [
    { doctorId: "d1", displayName: "Заведующая", department: "Косметология", specialization: "Косметология",
      periods: [{ periodKey: "2026-01", pageTypes: ["doctor", "specialization", "department"] }] },
    { doctorId: "d2", displayName: "Врач-эстетист", department: "Косметология", specialization: "Эстетисты",
      periods: [{ periodKey: "2026-01", pageTypes: ["doctor", "specialization", "department"] }] },
  ];
  const options = JSON.parse(JSON.stringify(navigation.availableReportScopes("2026-01")));
  assert.deepEqual(options.map(option => option.label), ["Мой отчёт", "Всё отделение", "Косметология", "Эстетисты"]);
  assert.deepEqual(options.map(option => option.pageType), ["doctor", "department", "specialization", "specialization"]);
  assert.equal(options.find(option => option.label === "Косметология").subjectDoctorId, "d1");
  assert.equal(options.find(option => option.label === "Эстетисты").subjectDoctorId, "d2");
  const groupedHtml = navigation.renderReportScopeNavigation(options);
  assert.equal((groupedHtml.match(/class="viewer-scope-row"/g) || []).length, 1);
  assert.match(groupedHtml, /class="viewer-scope-cell viewer-scope-department"/);
  assert.match(groupedHtml, /class="viewer-scope-cell viewer-scope-specializations"/);
  assert.match(groupedHtml, /data-department-name="Косметология"/);

  for (const source of [installedSource, standaloneSource]) {
    assert.match(source, /function availableReportScopes\(periodKey\)/);
    assert.match(source, /function renderReportScopeNavigation\(options\)/);
    assert.match(source, /label: departments\.length === 1 \? "Всё отделение"/);
    assert.match(source, /data-report-key/);
    assert.match(source, /managedDepartments/);
  }
});

test("standalone administrator navigation exposes every published doctor, department and specialization", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "viewer", "standalone-app.js"), "utf8")
    .replace(/\ninitialize\(\);\s*$/, "");
  const context = vm.createContext({
    window: {},
    document: {
      getElementById(id) {
        return id === "standaloneViewerData"
          ? { textContent: JSON.stringify({ format: STANDALONE_FORMAT, formatVersion: 3, doctors: [], periods: [] }) }
          : null;
      },
    },
  });
  vm.runInContext(`${source}\n;globalThis.__adminNavigation = { state, availableReportScopes, renderReportScopeNavigation };`, context);
  const navigation = context.__adminNavigation;
  navigation.state.role = "admin";
  navigation.state.doctor = { doctorId: "__admin__", displayName: "Администратор", managedDepartments: [] };
  navigation.state.subjectDoctorId = "d1";
  navigation.state.subjects = [
    { doctorId: "d1", displayName: "Первый", department: "Терапия", specialization: "Эндокринология",
      periods: [{ periodKey: "2026-01", pageTypes: ["doctor", "specialization", "department"] }] },
    { doctorId: "d2", displayName: "Второй", department: "Хирургия", specialization: "Флебология",
      periods: [{ periodKey: "2026-01", pageTypes: ["doctor", "specialization", "department"] }] },
  ];
  const options = JSON.parse(JSON.stringify(navigation.availableReportScopes("2026-01")));
  assert.equal(options.filter(option => option.pageType === "doctor").length, 1);
  assert.equal(options.filter(option => option.pageType === "department").length, 2);
  assert.equal(options.filter(option => option.pageType === "specialization").length, 2);
  assert.deepEqual(new Set(options.filter(option => option.pageType === "department").map(option => option.label)),
    new Set(["Отделение: Терапия", "Отделение: Хирургия"]));
  assert.deepEqual(new Set(options.filter(option => option.pageType === "specialization").map(option => option.label)),
    new Set(["Терапия · Эндокринология", "Хирургия · Флебология"]));
  const groupedHtml = navigation.renderReportScopeNavigation(options);
  assert.equal((groupedHtml.match(/class="viewer-scope-row"/g) || []).length, 2);
  assert.match(groupedHtml, /data-department-name="Терапия"/);
  assert.match(groupedHtml, /data-department-name="Хирургия"/);
  assert.ok(groupedHtml.indexOf("Терапия") < groupedHtml.indexOf("Эндокринология"));
  assert.ok(groupedHtml.indexOf("Хирургия") < groupedHtml.indexOf("Флебология"));
});

test("installed and standalone Viewer keep switching windows from legacy exported pages", () => {
  const sources = [
    fs.readFileSync(path.join(__dirname, "..", "viewer", "app.js"), "utf8"),
    fs.readFileSync(path.join(__dirname, "..", "viewer", "standalone-app.js"), "utf8"),
  ];
  const element = attributes => ({
    attributes: { ...attributes }, hidden: false, listeners: {},
    classList: { values: new Set(), toggle(name, active) { if (active) this.values.add(name); else this.values.delete(name); } },
    getAttribute(name) { return this.attributes[name] || null; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener(name, handler) { this.listeners[name] = handler; },
  });
  for (const source of sources) {
    const context = vm.createContext({
      window: { viewerAPI: {} },
      document: {
        addEventListener() {},
        getElementById(id) {
          return id === "standaloneViewerData"
            ? { textContent: JSON.stringify({ format: "pulse-clinic-standalone-viewer", formatVersion: 2, doctors: [], periods: [] }) }
            : null;
        },
      },
    });
    const testableSource = source.replace(/\ninitialize\(\);\s*$/, "");
    vm.runInContext(`${testableSource}\n;globalThis.__initializeReportWindowSwitchers = initializeReportWindowSwitchers;`, context);
    for (const [containerSelector, buttonAttribute, panelAttribute] of [
      ["[data-viewer-interdisciplinary]", "data-viewer-naz-window", "data-viewer-naz-panel"],
      ["[data-viewer-client-base]", "data-viewer-kb-window", "data-viewer-kb-panel"],
    ]) {
      const buttons = [element({ [buttonAttribute]: "12" }), element({ [buttonAttribute]: "24" })];
      const panels = [element({ [panelAttribute]: "12" }), element({ [panelAttribute]: "24" })];
      panels[1].hidden = true;
      const container = {
        dataset: {},
        querySelectorAll(selector) {
          if (selector === `[${buttonAttribute}]`) return buttons;
          if (selector === `[${panelAttribute}]`) return panels;
          return [];
        },
      };
      const root = { querySelectorAll(selector) { return selector === containerSelector ? [container] : []; } };
      context.__initializeReportWindowSwitchers(root);
      buttons[1].listeners.click();
      assert.equal(buttons[1].attributes["aria-pressed"], "true");
      assert.equal(buttons[0].attributes["aria-pressed"], "false");
      assert.equal(panels[0].hidden, true);
      assert.equal(panels[1].hidden, false);
    }
  }
});

test("department head sees every doctor in the department while a regular doctor stays personal", async t => {
  const { root, database } = fixture(t);
  database.setViewerAdminPin("654321");
  database.updateViewerDoctorAccess({ doctorId: "d1", active: true, pin: "1357" });
  database.updateViewerDoctorAccess({ doctorId: "d2", active: true, pin: "2468" });
  database.updateViewerDepartmentHead({ department: "Терапия", doctorId: "d1" });
  const credentials = database.viewerExportCredentials(["d1", "d2"]);
  const doctors = [
    { doctorId: "d1", displayName: "Первый Врач", department: "Терапия", specialization: "Кардиология" },
    { doctorId: "d2", displayName: "Второй Врач", department: "Терапия", specialization: "Неврология" },
  ];
  const pages = doctors.flatMap(doctor => ([
    {
      doctorId: doctor.doctorId, periodKey: "2026-01", pageType: "doctor", scopeId: doctor.doctorId,
      title: `Отчёт ${doctor.displayName}`,
      html: `<div>${doctor.doctorId === "d1" ? "Секрет первого" : "Секрет второго"}</div>`,
    },
    {
      doctorId: doctor.doctorId, periodKey: "2026-01", pageType: "department", scopeId: "Терапия",
      title: "Общий отчёт Терапии", html: "<div>Все врачи Терапии</div>",
    },
    {
      doctorId: doctor.doctorId, periodKey: "2026-01", pageType: "specialization", scopeId: doctor.specialization,
      title: `Специализация ${doctor.specialization}`, html: `<div>Сводная специализация ${doctor.specialization}</div>`,
    },
  ]));

  const originalScrypt = crypto.scryptSync;
  let packageKdfCalls = 0;
  crypto.scryptSync = (...args) => {
    packageKdfCalls++;
    return originalScrypt(...args);
  };
  let created;
  try {
    created = await createViewerPackage({ appVersion: "2.3.0", periods: ["2026-01"], doctors, subjects: doctors, pages, credentials });
  } finally {
    crypto.scryptSync = originalScrypt;
  }
  assert.equal(packageKdfCalls, doctors.length, "scrypt runs once per recipient grant, not once per page");
  const inspected = await inspectViewerPackage(created.buffer, { includeZip: true });
  const head = inspected.manifest.doctors.find(item => item.doctorId === "d1");
  const regular = inspected.manifest.doctors.find(item => item.doctorId === "d2");
  assert.deepEqual(head.visibleDoctorIds, ["d1", "d2"]);
  assert.deepEqual(regular.visibleDoctorIds, ["d2"]);
  const headFolder = head.folderId;
  const regularFolder = regular.folderId;
  const headGrant = decryptViewerGrant(JSON.parse(await inspected.zip.file(`doctors/${headFolder}/grant.json`).async("string")), "1357");
  const regularGrant = decryptViewerGrant(JSON.parse(await inspected.zip.file(`doctors/${regularFolder}/grant.json`).async("string")), "2468");
  assert.deepEqual([...new Set(headGrant.bindings.map(binding => binding.doctorId))], ["d1", "d2"]);
  assert.deepEqual([...new Set(regularGrant.bindings.map(binding => binding.doctorId))], ["d2"]);
  assert.equal(inspected.manifest.reportModel.bindings.length, 6);
  assert.equal(inspected.manifest.reportModel.pages.length, 5);
  assert.equal(inspected.manifest.sizeEstimate.duplicatedPagesAvoided, 1);

  const archive = path.join(root, "department-head.zip");
  fs.writeFileSync(archive, created.buffer);
  const storageRoot = path.join(root, "department-share");
  fs.mkdirSync(storageRoot, { recursive: true });
  const viewer = new ViewerStorageService({ configPath: path.join(root, "department-viewer-config.json") });
  viewer.setStorageRoot(storageRoot);
  await viewer.importPackageFile(archive, { bootstrapPin: "654321" });
  const headSession = viewer.doctorLogin({ doctorId: "d1", pin: "1357" });
  assert.equal(headSession.subjects.length, 2);
  assert.match(viewer.readReport(headSession, { subjectDoctorId: "d2", periodKey: "2026-01", pageType: "doctor" }).html, /Секрет второго/);
  assert.match(viewer.readReport(headSession, { subjectDoctorId: "d1", periodKey: "2026-01", pageType: "department" }).html, /Все врачи Терапии/);
  assert.match(viewer.readReport(headSession, { subjectDoctorId: "d1", periodKey: "2026-01", pageType: "specialization" }).html, /Кардиология/);
  assert.match(viewer.readReport(headSession, { subjectDoctorId: "d2", periodKey: "2026-01", pageType: "specialization" }).html, /Неврология/);
  assert.deepEqual(headSession.subjects.map(subject => Object.keys(subject.publications[0].pages).sort()), [
    ["department", "doctor", "specialization"], ["department", "doctor", "specialization"],
  ]);
  const regularSession = viewer.doctorLogin({ doctorId: "d2", pin: "2468" });
  assert.equal(regularSession.subjects.length, 1);
  assert.equal(viewer.readReport(regularSession, { subjectDoctorId: "d1", periodKey: "2026-01", pageType: "doctor" }), null);

  const standalone = await createStandaloneViewerHtml({ appVersion: "2.3.0", periods: ["2026-01"], doctors, subjects: doctors, pages,
    credentials: database.viewerExportCredentials(["d1", "d2"], { adminPin: "654321" }) });
  const embedded = standalone.buffer.toString("utf8").match(/<script id="standaloneViewerData" type="application\/json">([\s\S]*?)<\/script>/);
  const bundle = JSON.parse(embedded[1]);
  const headPayload = decryptStandaloneRecord(bundle.doctors.find(item => item.doctorId === "d1"), "1357");
  const regularPayload = decryptStandaloneRecord(bundle.doctors.find(item => item.doctorId === "d2"), "2468");
  const headReports = reportsFromStandaloneBundle(bundle, headPayload);
  const regularReports = reportsFromStandaloneBundle(bundle, regularPayload);
  assert.deepEqual(headPayload.subjects.map(item => item.doctorId), ["d1", "d2"]);
  assert.deepEqual(regularPayload.subjects.map(item => item.doctorId), ["d2"]);
  assert.equal(headReports.length, 6);
  assert.equal(regularReports.length, 3);
  assert.deepEqual([...new Set(headReports.filter(report => report.pageType === "specialization").map(report => report.scopeId))].sort(),
    ["Кардиология", "Неврология"]);
  const adminPayload = decryptStandaloneRecord(bundle.adminAccess, "654321");
  assert.deepEqual(adminPayload.subjects.map(item => item.doctorId), ["d1", "d2"]);
  assert.equal(reportsFromStandaloneBundle(bundle, adminPayload).length, 6);
});

test("department head publication can be limited to the selected doctor and that doctor's summaries", async t => {
  const { database } = fixture(t);
  database.setViewerAdminPin("654321");
  database.updateViewerDoctorAccess({ doctorId: "d1", active: true, pin: "1357" });
  database.updateViewerDepartmentHead({ department: "Терапия", doctorId: "d1" });
  const doctor = {
    doctorId: "d1", displayName: "Первый Врач", department: "Терапия", specialization: "Кардиология",
  };
  const pages = [
    { doctorId: "d1", periodKey: "2026-01", pageType: "doctor", scopeId: "d1", title: "Личный отчёт", html: "<div>Личный</div>" },
    { doctorId: "d1", periodKey: "2026-01", pageType: "department", scopeId: "Терапия", title: "Отделение", html: "<div>Терапия</div>" },
    { doctorId: "d1", periodKey: "2026-01", pageType: "specialization", scopeId: "Кардиология", title: "Специализация", html: "<div>Кардиология</div>" },
  ];
  const created = await createStandaloneViewerHtml({
    appVersion: "2.5.13",
    periods: ["2026-01"],
    doctors: [doctor],
    subjects: [doctor],
    pages,
    credentials: database.viewerExportCredentials(["d1"], { adminPin: "654321" }),
  });
  const embedded = created.buffer.toString("utf8").match(/<script id="standaloneViewerData" type="application\/json">([\s\S]*?)<\/script>/);
  const bundle = JSON.parse(embedded[1]);
  const headPayload = decryptStandaloneRecord(bundle.doctors[0], "1357");
  assert.deepEqual(headPayload.subjects.map(item => item.doctorId), ["d1"]);
  assert.deepEqual(reportsFromStandaloneBundle(bundle, headPayload).map(report => report.pageType).sort(), ["department", "doctor", "specialization"]);
  assert.deepEqual(bundle.subjects.map(item => item.doctorId), ["d1"]);
});
