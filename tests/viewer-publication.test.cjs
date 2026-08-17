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
const { DatabaseService } = require("../desktop/services/database.cjs");
const {
  ENCRYPTED_PAGE_FORMAT,
  STANDALONE_FORMAT,
  createStandaloneViewerHtml,
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

function decryptStandaloneRecord(record, pin) {
  const key = crypto.pbkdf2Sync(pin, Buffer.from(record.encryption.salt, "base64"), record.encryption.iterations,
    record.encryption.keyLength / 8, "sha256");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(record.encryption.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.encryption.tag, "base64"));
  return JSON.parse(zlib.gunzipSync(Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final(),
  ])).toString("utf8"));
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
  assert.equal(inspected.manifest.formatVersion, 3);
  assert.equal(inspected.manifest.adminAccess.pinVersion, 1);
  assert.equal("pinCode" in inspected.manifest.adminAccess, false);
  assert.equal("windowsAccount" in inspected.manifest.doctors[0], false);

  const folderId = inspected.manifest.doctors[0].folderId;
  const profile = JSON.parse(await inspected.zip.file(`doctors/${folderId}/profile.json`).async("string"));
  const publishedAccess = JSON.parse(await inspected.zip.file(`doctors/${folderId}/access.json`).async("string"));
  const encryptedText = await inspected.zip.file(`doctors/${folderId}/subjects/${folderId}/reports/2026-01/doctor.json`).async("string");
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
  assert.match(report.html, /data:image\/webp;base64,UklGRg==/);
  assert.doesNotMatch(report.html, /<script/i);
  assert.equal(viewer.readReport(session, { periodKey: "2026-01", pageType: "department" }), null);

  for (let attempt = 1; attempt <= 4; attempt++) {
    assert.throws(() => viewer.doctorLogin({ doctorId: access.doctorId, pin: "0000" }), /Неверный PIN/);
  }
  assert.throws(() => viewer.doctorLogin({ doctorId: access.doctorId, pin: "0000" }), /заблокирован/);
  assert.throws(() => viewer.doctorLogin({ doctorId: access.doctorId, pin: "1357" }), /временно заблокирован/);
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
  assert.equal(created.manifest.formatVersion, 3);
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
  assert.match(payload.reports[0].html, /Секретный отчёт|Комментарий врача/);
  assert.match(payload.reports[0].html, /Секретный Пациент|P-42/);
  assert.match(payload.reports[0].html, /data-viewer-patient-search|data-viewer-patient-segment/);
  assert.doesNotMatch(payload.reports[0].html, /<script/i);
  const adminPayload = decryptStandaloneRecord(bundle.adminAccess, "654321");
  assert.equal(adminPayload.accessRole, "admin");
  assert.deepEqual(adminPayload.subjects.map(subject => subject.doctorId), [access.doctorId]);
  assert.equal(adminPayload.reports.length, 1);
  assert.match(adminPayload.reports[0].html, /Секретный отчёт|Секретный Пациент/);
  assert.throws(() => decryptStandaloneRecord(bundle.adminAccess, "000000"));
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

test("installed and standalone Viewer switch exported appointment and client-base windows", () => {
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

  const created = await createViewerPackage({ appVersion: "2.3.0", periods: ["2026-01"], doctors, subjects: doctors, pages, credentials });
  const inspected = await inspectViewerPackage(created.buffer, { includeZip: true });
  const head = inspected.manifest.doctors.find(item => item.doctorId === "d1");
  const regular = inspected.manifest.doctors.find(item => item.doctorId === "d2");
  assert.deepEqual(head.visibleDoctorIds, ["d1", "d2"]);
  assert.deepEqual(regular.visibleDoctorIds, ["d2"]);
  const headFolder = head.folderId;
  const regularFolder = regular.folderId;
  assert.ok(inspected.zip.file(`doctors/${headFolder}/subjects/${regularFolder}/reports/2026-01/doctor.json`));
  assert.equal(inspected.zip.file(`doctors/${regularFolder}/subjects/${headFolder}/reports/2026-01/doctor.json`), null);

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
  assert.deepEqual(headPayload.subjects.map(item => item.doctorId), ["d1", "d2"]);
  assert.deepEqual(regularPayload.subjects.map(item => item.doctorId), ["d2"]);
  assert.equal(headPayload.reports.length, 6);
  assert.equal(regularPayload.reports.length, 3);
  assert.deepEqual([...new Set(headPayload.reports.filter(report => report.pageType === "specialization").map(report => report.scopeId))].sort(),
    ["Кардиология", "Неврология"]);
  const adminPayload = decryptStandaloneRecord(bundle.adminAccess, "654321");
  assert.deepEqual(adminPayload.subjects.map(item => item.doctorId), ["d1", "d2"]);
  assert.equal(adminPayload.reports.length, 6);
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
  assert.deepEqual(headPayload.reports.map(report => report.pageType).sort(), ["department", "doctor", "specialization"]);
  assert.deepEqual(bundle.subjects.map(item => item.doctorId), ["d1"]);
});
