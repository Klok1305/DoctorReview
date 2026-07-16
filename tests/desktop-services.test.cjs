"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { BackupService } = require("../desktop/services/backup-service.cjs");
const { ConfigStore, isUnsupportedStoragePath } = require("../desktop/services/config-store.cjs");
const { DatabaseService } = require("../desktop/services/database.cjs");
const { FileService } = require("../desktop/services/file-service.cjs");
const { UpdateService } = require("../desktop/services/update-service.cjs");

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeSnapshot(name) {
  return {
    version: 3,
    settings: { showScores: true, marker: name, depts: {} },
    doctors: { d1: { name, aliases: [] } },
    months: { "2026-01": { vyrabotka: {}, kb: {}, naznach: {}, pervichka: {}, prostoy: {}, zapis: {}, manual6: {} } },
    dynamicNotes: {},
    fileLog: [],
  };
}

test("packaged application contains the public GitHub update feed", () => {
  const updateService = new UpdateService({
    app: { getVersion: () => "1.0.5", isPackaged: false },
    backupService: {},
    configStore: { publicConfig: () => ({ updateUrl: "" }) },
    resourcesPath: path.join(__dirname, "..", "resources"),
  });
  assert.equal(updateService.getStatus().configured, true);
});

test("workspace settings can be restored without losing custom folders", t => {
  const root = makeTemp("doctor-app-config-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ConfigStore({ userDataDir: path.join(root, "config"), documentsDir: path.join(root, "documents") });
  store.setWorkspaceRoot(path.join(root, "workspace-a"));
  store.setFolder("output", path.join(root, "custom-output"));
  const before = store.snapshot();
  store.setWorkspaceRoot(path.join(root, "workspace-b"));
  store.restore(before);
  assert.equal(store.publicConfig().workspaceRoot, path.resolve(root, "workspace-a"));
  assert.equal(store.publicConfig().outputDir, path.resolve(root, "custom-output"));
});

test("accepting the default workspace is remembered between launches", t => {
  const root = makeTemp("doctor-app-configured-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { userDataDir: path.join(root, "config"), documentsDir: path.join(root, "documents") };
  const store = new ConfigStore(options);
  assert.equal(store.publicConfig().configured, false);

  store.markConfigured();

  assert.equal(store.publicConfig().configured, true);
  assert.equal(new ConfigStore(options).publicConfig().configured, true);
});

test("OneDrive paths are rejected before filesystem access can block startup", t => {
  const root = makeTemp("doctor-app-onedrive-guard-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ConfigStore({ userDataDir: path.join(root, "config"), documentsDir: path.join(root, "documents") });
  const blocked = path.join(root, "OneDrive - Clinic", "Оценка врачей");
  assert.equal(isUnsupportedStoragePath(blocked), true);
  assert.throws(() => store.setWorkspaceRoot(blocked), /OneDrive/);
  assert.equal(fs.existsSync(blocked), false);
});

test("PDF publishing replaces the current set and archives stale files", t => {
  const root = makeTemp("doctor-app-export-");
  const store = new ConfigStore({ userDataDir: path.join(root, "config"), documentsDir: path.join(root, "documents") });
  store.setWorkspaceRoot(path.join(root, "workspace"));
  const database = new DatabaseService(store.databasePath());
  t.after(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const files = new FileService({ configStore: store, database });
  const target = path.join(store.publicConfig().outputDir, "2026-01");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "старый-врач.pdf"), "old");
  fs.writeFileSync(path.join(target, "лишний-врач.pdf"), "stale");
  fs.writeFileSync(path.join(target, "Сводная_2026-01.xlsx"), "keep");

  const batch = files.beginExportBatch({ month: "2026-01", kind: "pdf", requestedFiles: 1 });
  files.writeExportFile({ token: batch.token, fileName: "Врач — Тестов Врач.pdf", bytes: Buffer.from("%PDF-1.3") });
  const result = files.finishExportBatch({ token: batch.token, failures: [] });

  assert.equal(result.written, 1);
  assert.equal(result.archived, 2);
  assert.deepEqual(
    fs.readdirSync(target).filter(name => name.endsWith(".pdf")),
    ["Врач — Тестов Врач.pdf"],
  );
  assert.equal(fs.existsSync(path.join(target, "Сводная_2026-01.xlsx")), true);
  const archived = fs.readdirSync(path.join(target, "Предыдущие версии"), { recursive: true })
    .filter(name => String(name).endsWith(".pdf"));
  assert.equal(archived.length, 2);
  assert.match(fs.readFileSync(path.join(target, "Протокол выгрузки.txt"), "utf8"), /Создано файлов: 1/);
});

test("portable SQLite backup restores data after later changes", async t => {
  const root = makeTemp("doctor-app-backup-");
  const store = new ConfigStore({ userDataDir: path.join(root, "config"), documentsDir: path.join(root, "documents") });
  store.setWorkspaceRoot(path.join(root, "workspace"));
  const database = new DatabaseService(store.databasePath());
  t.after(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const backups = new BackupService({ database, configStore: store });
  database.saveSnapshot(makeSnapshot("Первая версия"));
  const portable = path.join(root, "portable.ovbackup");
  await backups.createPortable(portable);
  database.saveSnapshot(makeSnapshot("Вторая версия"));

  const restored = await backups.restore(portable);
  assert.equal(restored.preview.doctors, 1);
  assert.equal(database.loadSnapshot().doctors.d1.name, "Первая версия");
  assert.equal(fs.existsSync(restored.safetyBackup), true);
  assert.equal(DatabaseService.inspect(restored.safetyBackup).ok, true);
});
