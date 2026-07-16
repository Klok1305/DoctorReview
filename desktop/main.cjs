"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
} = require("electron");
const { ConfigStore, isUnsupportedStoragePath } = require("./services/config-store.cjs");
const { DatabaseService } = require("./services/database.cjs");
const { BackupService } = require("./services/backup-service.cjs");
const { FileService } = require("./services/file-service.cjs");
const { UpdateService } = require("./services/update-service.cjs");

const PDF_SMOKE_TEST = process.argv.includes("--pdf-smoke");
const SMOKE_TEST = PDF_SMOKE_TEST || process.argv.includes("--smoke-test");
const APP_NAME = "Оценка врачей";
const APPLICATION_ROOT = path.resolve(__dirname, "..");
const SMOKE_ROOT = app.isPackaged
  ? path.join(app.getPath("temp"), "doctor-app-smoke", String(process.pid))
  : path.join(APPLICATION_ROOT, "tmp", "electron-smoke", String(process.pid));
const SMOKE_ARTIFACT_ROOT = app.isPackaged ? path.join(SMOKE_ROOT, "artifacts") : path.join(APPLICATION_ROOT, "tmp");

if (SMOKE_TEST) {
  for (const name of ["user-data", "documents", "temp"]) {
    fs.mkdirSync(path.join(SMOKE_ROOT, name), { recursive: true });
  }
  app.setPath("userData", path.join(SMOKE_ROOT, "user-data"));
  app.setPath("documents", path.join(SMOKE_ROOT, "documents"));
  app.setPath("temp", path.join(SMOKE_ROOT, "temp"));
}

let mainWindow = null;
let configStore = null;
let database = null;
let backupService = null;
let fileService = null;
let updateService = null;

function logEvent(event, details = {}) {
  const record = JSON.stringify({ time: new Date().toISOString(), event, details });
  try {
    const logsDir = configStore ? configStore.publicConfig().logsDir : app.getPath("userData");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(path.join(logsDir, "application.log"), `${record}\r\n`, "utf8");
  } catch (_) { /* logs must never stop the app */ }
}

function ensureObject(value, label = "данные") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Некорректные ${label}`);
  return value;
}

async function copyDatabaseToWorkspace(rootPath) {
  const requestedRoot = path.resolve(rootPath);
  if (requestedRoot === path.resolve(configStore.publicConfig().workspaceRoot)) return configStore.markConfigured();
  const currentPath = database.databasePath;
  const previousConfig = configStore.snapshot();
  const migrationCopy = path.join(app.getPath("temp"), `doctor-app-workspace-${Date.now()}.sqlite`);
  await database.backupTo(migrationCopy);
  database.close();
  try {
    const newConfig = configStore.setWorkspaceRoot(rootPath);
    const newPath = newConfig.databasePath;
    if (path.resolve(newPath) !== path.resolve(currentPath)) {
      if (fs.existsSync(newPath)) {
        const existing = DatabaseService.inspect(newPath);
        if (existing.ok && (existing.hasSnapshot || existing.months || existing.doctors || existing.imports)) {
          const options = {
            type: "question",
            title: APP_NAME,
            message: "В выбранной рабочей папке уже есть база.",
            detail: `Месяцев: ${existing.months}, врачей: ${existing.doctors}. Как поступить?`,
            buttons: ["Использовать существующую", "Скопировать текущую поверх неё", "Отмена"],
            defaultId: 0,
            cancelId: 2,
          };
          const choice = mainWindow
            ? await dialog.showMessageBox(mainWindow, options)
            : await dialog.showMessageBox(options);
          if (choice.response === 2) {
            configStore.restore(previousConfig);
            database.open(currentPath);
            return null;
          }
          if (choice.response === 1) {
            const preserved = `${newPath}.before-switch-${Date.now()}`;
            fs.copyFileSync(newPath, preserved);
            fs.copyFileSync(migrationCopy, newPath);
          }
        } else {
          if (!existing.ok) fs.copyFileSync(newPath, `${newPath}.unreadable-before-switch-${Date.now()}`);
          fs.copyFileSync(migrationCopy, newPath);
        }
      } else {
        fs.copyFileSync(migrationCopy, newPath);
      }
    }
    database.open(newPath);
    return configStore.publicConfig();
  } catch (error) {
    configStore.restore(previousConfig);
    try { if (database.db) database.close(); } catch (_) { /* reopen the original below */ }
    database.open(currentPath);
    throw error;
  } finally {
    fs.rmSync(migrationCopy, { force: true });
  }
}

async function initializeServices() {
  app.setName(APP_NAME);
  const userDataDir = app.getPath("userData");
  const documentsDir = app.getPath("home");
  configStore = new ConfigStore({
    userDataDir,
    documentsDir,
  });
  database = new DatabaseService(configStore.databasePath());
  backupService = new BackupService({ database, configStore, logger: logEvent });
  fileService = new FileService({ configStore, database, logger: logEvent });
  updateService = new UpdateService({
    app,
    backupService,
    configStore,
    resourcesPath: process.resourcesPath,
    logger: logEvent,
  });
  updateService.onStatus(status => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("update:status", status);
  });
}

async function rejectUnsupportedStoragePath(targetPath) {
  if (!isUnsupportedStoragePath(targetPath)) return false;
  await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: APP_NAME,
    message: "Выберите локальную папку вне OneDrive",
    detail: "На этом компьютере операции с рабочими файлами внутри OneDrive блокируют запуск приложения. Данные можно хранить в профиле пользователя, на диске C: или на другом локальном диске.",
    buttons: ["Понятно"],
  });
  return true;
}

async function promptForWorkspaceOnFirstRun() {
  if (SMOKE_TEST || configStore.publicConfig().configured || !mainWindow || mainWindow.isDestroyed()) return;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Выберите рабочую папку приложения",
    defaultPath: configStore.publicConfig().workspaceRoot,
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Использовать эту папку",
  });
  if (result.canceled || !result.filePaths[0]) {
    configStore.markConfigured();
    return;
  }
  if (await rejectUnsupportedStoragePath(result.filePaths[0])) return;
  await copyDatabaseToWorkspace(result.filePaths[0]);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1040,
    minHeight: 720,
    show: false,
    backgroundColor: "#f4f6fa",
    title: APP_NAME,
    icon: path.join(__dirname, "..", "resources", "app-icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", event => event.preventDefault());
  mainWindow.once("ready-to-show", () => {
    if (SMOKE_TEST) return;
    mainWindow.show();
    mainWindow.focus();
    setImmediate(() => {
      promptForWorkspaceOnFirstRun().catch(error => {
        logEvent("workspace-prompt-error", { message: error.message, stack: error.stack });
        if (mainWindow && !mainWindow.isDestroyed()) {
          dialog.showMessageBox(mainWindow, {
            type: "error",
            title: APP_NAME,
            message: "Не удалось открыть выбор рабочей папки",
            detail: error.message,
          });
        }
      });
    });
  });
  mainWindow.on("closed", () => { mainWindow = null; });

  if (SMOKE_TEST) {
    mainWindow.webContents.once("did-finish-load", async () => {
      try {
        const smokeAction = PDF_SMOKE_TEST
          ? `(async () => {
              await new Promise(resolve => setTimeout(resolve, 1200));
              const optionalLibrariesDeferred = typeof XLSX === 'undefined' && typeof JSZip === 'undefined' && typeof html2canvas === 'undefined' && !window.jspdf;
              loadBundledLibrary('lib-xlsx', 'XLSX');
              DB.doctors = { d1: { name: 'Тестов Врач', aliases: [], dept: 'По умолчанию', spec: 'Терапевт' } };
              DB.months = { '2026-01': emptyMonth() };
              DB.months['2026-01'].vyrabotka.d1 = {
                period: extractPeriod('01.01.2026 - 31.01.2026'),
                items: [{ form: '', cat: 'Прием', n: 'Прием врача', q: 5, sOwn: 100000, sRef: 20000, goods: false }]
              };
              UI.repMonth = '2026-01';
              clearMetricsCache();
              renderAll();
              const saved = await saveLocal();
              await exportAllReportsToFolder();
              return {
                title: document.title,
                dataPage: Boolean(document.getElementById('page-data')),
                optionalLibrariesDeferred,
                xlsx: typeof XLSX !== 'undefined',
                chart: typeof Chart !== 'undefined',
                desktop: Boolean(window.desktopAPI),
                saved
              };
            })()`
          : `(async () => {
              await new Promise(resolve => setTimeout(resolve, 1200));
              const optionalLibrariesDeferred = typeof XLSX === 'undefined' && typeof JSZip === 'undefined' && typeof html2canvas === 'undefined' && !window.jspdf;
              loadBundledLibrary('lib-xlsx', 'XLSX');
              DB.doctors = {
                d1: { name: 'Тестов Косметолог', aliases: [], dept: 'Косметология', spec: 'Косметолог' },
                d2: { name: 'Тестов Терапевт', aliases: [], dept: 'Терапия', spec: 'Терапевт' }
              };
              DB.months = { '2026-01': emptyMonth(), '2026-02': emptyMonth() };
              for (const mk of Object.keys(DB.months)) {
                DB.months[mk].vyrabotka.d1 = { items: [{ form: '', cat: 'Прием', n: 'Прием врача', q: 5, sOwn: mk.endsWith('01') ? 100000 : 120000, sRef: 20000, goods: false }] };
                DB.months[mk].vyrabotka.d2 = { items: [{ form: '', cat: 'Прием', n: 'Прием врача', q: 4, sOwn: mk.endsWith('01') ? 80000 : 90000, sRef: 10000, goods: false }] };
              }
              clearMetricsCache();
              UI.departmentMonth = '2026-02';
              UI.departmentFilter = 'all';
              switchTab('department');
              await new Promise(resolve => setTimeout(resolve, 300));
              const departmentPage = document.getElementById('page-department').classList.contains('active');
              const departmentCharts = Boolean(UI.charts.chDepartmentRevenue && UI.charts.chDepartmentRates && UI.charts.chDepartmentBase);
              UI.setDoctor = 'd1';
              switchTab('settings');
              enableDoctorMetricSettings();
              document.getElementById('dm_bm_revenue').value = '150000';
              saveDoctorMetricSettings();
              document.getElementById('doctorMetricSettingsCard').scrollIntoView({ block: 'start' });
              await new Promise(resolve => setTimeout(resolve, 200));
              return {
                title: document.title,
                dataPage: Boolean(document.getElementById('page-data')),
                optionalLibrariesDeferred,
                departmentPage,
                departmentCharts,
                doctorMetricSettings: profileForDoctor('d1').scoring.benchmarks.revenue === 150000 && !document.getElementById('dm_bm_revenue').disabled,
                xlsx: typeof XLSX !== 'undefined',
                chart: typeof Chart !== 'undefined',
                desktop: Boolean(window.desktopAPI)
              };
            })()`;
        const result = await mainWindow.webContents.executeJavaScript(smokeAction);
        const artifactRoot = SMOKE_ARTIFACT_ROOT;
        fs.mkdirSync(artifactRoot, { recursive: true });
        const screenshotPath = path.join(artifactRoot, "desktop-smoke.png");
        const screenshot = await mainWindow.webContents.capturePage();
        fs.writeFileSync(screenshotPath, screenshot.toPNG());
        result.screenshot = screenshotPath;
        if (PDF_SMOKE_TEST) {
          const sourceDir = path.join(configStore.publicConfig().outputDir, "2026-01");
          const pdfDir = path.join(artifactRoot, "pdfs");
          fs.mkdirSync(pdfDir, { recursive: true });
          const pdfFiles = fs.existsSync(sourceDir)
            ? fs.readdirSync(sourceDir).filter(name => name.toLowerCase().endsWith(".pdf"))
            : [];
          for (const fileName of pdfFiles) {
            fs.copyFileSync(path.join(sourceDir, fileName), path.join(pdfDir, fileName));
          }
          result.pdfFiles = pdfFiles;
          result.pdfDir = pdfDir;
        }
        process.stdout.write(`${JSON.stringify(result)}\n`);
        const passed = result.dataPage && result.optionalLibrariesDeferred && result.xlsx && result.chart && result.desktop
          && (PDF_SMOKE_TEST || (result.departmentPage && result.departmentCharts && result.doctorMetricSettings))
          && (!PDF_SMOKE_TEST || (result.saved && result.pdfFiles.length === 2));
        app.exit(passed ? 0 : 2);
      } catch (error) {
        process.stderr.write(`${error.stack || error.message}\n`);
        app.exit(3);
      }
    });
  }
  mainWindow.loadFile(path.join(__dirname, "..", "index.html"));
}

function registerIpc() {
  ipcMain.handle("app:initialize", () => ({
    app: { name: APP_NAME, version: app.getVersion(), packaged: app.isPackaged, smokeTest: SMOKE_TEST },
    config: configStore.publicConfig(),
    snapshot: database.loadSnapshot(),
    summary: database.summary(),
    update: updateService.getStatus(),
  }));

  ipcMain.handle("database:save", (_event, json) => {
    if (typeof json !== "string" || json.length > 200 * 1024 * 1024) throw new Error("Некорректный размер снимка базы");
    const snapshot = JSON.parse(json);
    return database.saveSnapshot(snapshot);
  });

  ipcMain.handle("database:export-json", async (_event, json) => {
    if (typeof json !== "string") throw new Error("Некорректный JSON");
    const date = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Сохранить переносимую JSON-копию",
      defaultPath: path.join(configStore.publicConfig().backupDir, `база_оценки_врачей_${date}.json`),
      filters: [{ name: "JSON-база", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    return { canceled: false, path: fileService.writeJsonExport(result.filePath, json) };
  });

  ipcMain.handle("config:choose-workspace", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Выберите рабочую папку",
      defaultPath: configStore.publicConfig().workspaceRoot,
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Использовать эту папку",
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true, config: configStore.publicConfig() };
    if (await rejectUnsupportedStoragePath(result.filePaths[0])) return { canceled: true, config: configStore.publicConfig() };
    const config = await copyDatabaseToWorkspace(result.filePaths[0]);
    if (!config) return { canceled: true, config: configStore.publicConfig() };
    fileService = new FileService({ configStore, database, logger: logEvent });
    return { canceled: false, config, snapshot: database.loadSnapshot(), summary: database.summary() };
  });

  ipcMain.handle("config:choose-folder", async (_event, kind) => {
    const config = configStore.publicConfig();
    const keyMap = { input: "inputDir", output: "outputDir", backup: "backupDir" };
    if (!keyMap[kind]) throw new Error("Неизвестный тип папки");
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Выберите папку",
      defaultPath: config[keyMap[kind]],
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Выбрать",
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true, config };
    if (await rejectUnsupportedStoragePath(result.filePaths[0])) return { canceled: true, config };
    return { canceled: false, config: configStore.setFolder(kind, result.filePaths[0]) };
  });

  ipcMain.handle("path:open", async (_event, kind) => {
    const config = configStore.publicConfig();
    const paths = {
      workspace: config.workspaceRoot,
      input: config.inputDir,
      output: config.outputDir,
      backup: config.backupDir,
      database: config.databaseDir,
      logs: config.logsDir,
    };
    if (!paths[kind]) throw new Error("Неизвестная папка");
    const error = await shell.openPath(paths[kind]);
    if (error) throw new Error(error);
    return paths[kind];
  });

  ipcMain.handle("files:pick-input", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Выберите выгрузки 1С",
      defaultPath: configStore.publicConfig().inputDir,
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Выгрузки 1С и архивы", extensions: ["xls", "xlsx", "zip"] }],
    });
    if (result.canceled) return [];
    return fileService.describeSelected(result.filePaths);
  });
  ipcMain.handle("files:scan-input", () => fileService.scanInputFolder());
  ipcMain.handle("files:read-input", (_event, filePath) => fileService.readInputFile(String(filePath)));
  ipcMain.handle("import:has-source", (_event, sha256) => database.hasSuccessfulSource(String(sha256)));

  ipcMain.handle("import:begin", async (_event, payload) => {
    const input = ensureObject(payload || {}, "параметры импорта");
    const backup = await backupService.createAutomatic("перед-импортом");
    return { batchId: database.beginImportBatch({ totalFiles: input.totalFiles, backupPath: backup.path }), backupPath: backup.path };
  });
  ipcMain.handle("import:record", (_event, payload) => {
    const input = ensureObject(payload, "сведения об импорте");
    database.recordImport(input);
    return true;
  });
  ipcMain.handle("import:finish", (_event, payload) => {
    const input = ensureObject(payload, "итоги импорта");
    database.finishImportBatch(input.batchId, input.counts || {});
    return database.summary();
  });

  ipcMain.handle("export:begin", (_event, payload) => fileService.beginExportBatch(ensureObject(payload, "параметры выгрузки")));
  ipcMain.handle("export:write", (_event, payload) => fileService.writeExportFile(ensureObject(payload, "файл выгрузки")));
  ipcMain.handle("export:finish", (_event, payload) => fileService.finishExportBatch(ensureObject(payload, "итоги выгрузки")));
  ipcMain.handle("export:abort", (_event, token) => fileService.abortExportBatch(token));

  ipcMain.handle("backup:create", async () => backupService.createAutomatic("ручная"));
  ipcMain.handle("backup:export", async () => {
    const date = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Сохранить переносимую резервную копию",
      defaultPath: path.join(configStore.publicConfig().backupDir, `ОценкаВрачей-backup-${date}.ovbackup`),
      filters: [{ name: "Резервная копия", extensions: ["ovbackup"] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const saved = await backupService.createPortable(result.filePath);
    return Object.assign({ canceled: false }, saved);
  });
  ipcMain.handle("backup:restore", async () => {
    const selected = await dialog.showOpenDialog(mainWindow, {
      title: "Выберите резервную копию",
      defaultPath: configStore.publicConfig().backupDir,
      properties: ["openFile"],
      filters: [{ name: "Резервные копии", extensions: ["ovbackup", "sqlite"] }],
    });
    if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
    const source = selected.filePaths[0];
    const preview = backupService.preview(source);
    if (!preview.ok) throw new Error(`Копия повреждена: ${preview.error || preview.integrity}`);
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Восстановление базы",
      message: "Заменить текущую базу выбранной резервной копией?",
      detail: `В копии: месяцев — ${preview.months}, врачей — ${preview.doctors}, импортов — ${preview.imports}. Текущая база будет предварительно сохранена.`,
      buttons: ["Восстановить", "Отмена"],
      defaultId: 1,
      cancelId: 1,
    });
    if (confirmation.response !== 0) return { canceled: true };
    const restored = await backupService.restore(source);
    return { canceled: false, restored, snapshot: database.loadSnapshot(), summary: database.summary() };
  });

  ipcMain.handle("update:check", () => updateService.check());
  ipcMain.handle("update:install-downloaded", () => updateService.installDownloaded());
  ipcMain.handle("update:install-file", async () => {
    const selected = await dialog.showOpenDialog(mainWindow, {
      title: "Выберите установщик новой версии",
      properties: ["openFile"],
      filters: [{ name: "Установщик Windows", extensions: ["exe"] }],
    });
    if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
    await backupService.createAutomatic("перед-обновлением");
    const installer = selected.filePaths[0];
    const error = await shell.openPath(installer);
    if (error) throw new Error(error);
    setTimeout(() => app.quit(), 750);
    return { canceled: false, installer };
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      await initializeServices();
      registerIpc();
      createWindow();
    } catch (error) {
      logEvent("startup-error", { message: error.message, stack: error.stack });
      dialog.showErrorBox("Не удалось запустить приложение", error.stack || error.message);
      app.exit(1);
    }
  });
}

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  try { if (database) database.close(); } catch (_) { /* best effort */ }
});
