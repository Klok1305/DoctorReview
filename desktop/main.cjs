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
const { createStandaloneViewerHtml, createViewerPackage } = require("./services/viewer-package-service.cjs");

const PDF_SMOKE_TEST = process.argv.includes("--pdf-smoke");
const SMOKE_TEST = PDF_SMOKE_TEST || process.argv.includes("--smoke-test");
const APP_NAME = "КлинВект Щербатова — Администратор";
const APPLICATION_ROOT = path.resolve(__dirname, "..");
if (SMOKE_TEST) app.disableHardwareAcceleration();
const SMOKE_ROOT = app.isPackaged
  ? path.join(app.getPath("temp"), "doctor-app-smoke", String(process.pid))
  : path.join(APPLICATION_ROOT, "tmp", "electron-smoke", String(process.pid));
const SMOKE_ARTIFACT_ROOT = app.isPackaged ? path.join(SMOKE_ROOT, "artifacts") : path.join(APPLICATION_ROOT, "tmp");

// После переименования используем старую папку настроек, если в ней уже есть
// конфигурация: обновление не должно «терять» выбранную рабочую базу.
if (!SMOKE_TEST) {
  const currentUserData = app.getPath("userData");
  const previousUserData = [
    path.join(app.getPath("appData"), "Пульс клиники — Администратор"),
    path.join(app.getPath("appData"), "Пульс клиники"),
    path.join(app.getPath("appData"), "Оценка врачей"),
  ];
  if (!fs.existsSync(path.join(currentUserData, "config.json"))) {
    const configuredPreviousPath = previousUserData.find(candidate => fs.existsSync(path.join(candidate, "config.json")));
    if (configuredPreviousPath) app.setPath("userData", configuredPreviousPath);
  }
}

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

app.on("child-process-gone", (_event, details) => {
  logEvent("child-process-gone", {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    serviceName: details.serviceName || null,
    name: details.name || null,
  });
});

function ensureObject(value, label = "данные") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Некорректные ${label}`);
  return value;
}

function localAdminActor() {
  const user = database.ensureLocalAdministrator();
  return {
    userId: Number(user.id),
    role: "admin",
    user: {
      id: Number(user.id),
      username: user.username,
      displayName: user.display_name,
      role: "admin",
    },
  };
}

function sanitizeRichTextHtml(value) {
  let html = String(value || "").slice(0, 20000);
  html = html.replace(/<\s*(script|style|iframe|object|embed|form)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  html = html.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  html = html.replace(/\s(?:href|src)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  return html.replace(/<(?!\/?(?:strong|b|br|span)(?:\s|>|\/))[^>]+>/gi, "");
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
  const documentsDir = app.getPath("documents");
  const localDataDir = !SMOKE_TEST && process.env.LOCALAPPDATA
    ? process.env.LOCALAPPDATA
    : documentsDir;
  configStore = new ConfigStore({
    userDataDir,
    documentsDir,
    defaultWorkspaceRoot: path.join(localDataDir, APP_NAME, "Рабочие данные"),
  });
  database = new DatabaseService(configStore.databasePath());
  database.ensureLocalAdministrator();
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
    detail: "Рабочие данные нельзя размещать в OneDrive или на сетевом пути SMB/UNC. Используйте диск C: или другой локальный диск этого компьютера.",
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
  const smokeRendererErrors = [];
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
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logEvent("render-process-gone", details);
    if (SMOKE_TEST) process.stderr.write(`[renderer-gone] ${JSON.stringify(details)}\n`);
  });
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) logEvent("renderer-load-failed", { errorCode, errorDescription, validatedURL });
  });
  mainWindow.on("unresponsive", () => logEvent("window-unresponsive"));
  mainWindow.on("responsive", () => logEvent("window-responsive"));
  if (SMOKE_TEST) {
    mainWindow.webContents.on("console-message", details => {
      const level = details && details.level ? details.level : "unknown";
      const message = details && details.message ? details.message : "";
      const sourceId = details && details.sourceId ? details.sourceId : "renderer";
      const line = details && details.lineNumber ? details.lineNumber : 0;
      process.stderr.write(`[renderer:${level}] ${message} (${sourceId}:${line})\n`);
      if (level === "error") smokeRendererErrors.push({ message, sourceId, line });
    });
  }
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
  mainWindow.on("closed", () => {
    logEvent("window-closed");
    mainWindow = null;
  });

  if (SMOKE_TEST) {
    mainWindow.webContents.once("did-finish-load", async () => {
      try {
        process.stdout.write("[smoke] renderer loaded\n");
        const smokeAction = PDF_SMOKE_TEST
          ? `(async () => {
              await new Promise(resolve => setTimeout(resolve, 1200));
              const optionalLibrariesDeferred = typeof XLSX === 'undefined' && typeof JSZip === 'undefined' && typeof html2canvas === 'undefined' && !window.jspdf;
              loadBundledLibrary('lib-xlsx', 'XLSX');
              DB.doctors = { d1: {
                name: 'Тестов Врач', aliases: [], structureManual: true,
                department: 'Терапия', specialization: 'Кардиология', spec: 'Кардиолог'
              } };
              DB.settings.depts['Кардиология'].crossFocus = {
                title: 'Фокусы назначений',
                items: [
                  { name: 'Фокус А', syn: ['фокус а'], core: true },
                  { name: 'Фокус Б', syn: ['фокус б'], core: true },
                  { name: 'Фокус В', syn: ['фокус в'], core: true }
                ],
                rules: []
              };
              DB.months = { '2026-01': emptyMonth(), '2026-02': emptyMonth(), '2026-03': emptyMonth() };
              for (const [index, mk] of Object.keys(DB.months).entries()) {
                DB.months[mk].vyrabotka.d1 = {
                  period: extractPeriod('01.' + String(index + 1).padStart(2, '0') + '.2026 - 28.' + String(index + 1).padStart(2, '0') + '.2026'),
                  items: [
                    { form: '', cat: 'Приемы', n: 'Прием врача', q: 5 + index, sOwn: 100000 + index * 20000, sRef: 20000 + index * 5000, goods: false },
                    { form: '', cat: 'Диагностика и процедуры', n: 'ЭхоКГ', q: 2 + index, sOwn: 30000 + index * 5000, sRef: 0, goods: false }
                  ]
                };
                DB.months[mk].naznach.d1 = { '3': { items: [
                  { n: 'Фокус А — приём', a: 12, d: 3, sq: 2, ss: 20000 },
                  { n: 'Фокус Б — анализы', a: 10, d: 4, sq: 3, ss: 30000 },
                  { n: 'Фокус В — диагностика', a: 8, d: 2, sq: 1, ss: 15000 }
                ] } };
              }
              UI.repMonth = '2026-03';
              clearMetricsCache();
              switchTab('settings');
              await new Promise(resolve => setTimeout(resolve, 150));
              document.getElementById('btnExportAllPdf').click();
              const exportDialog = document.getElementById('pdfExportDialog');
              const dialogOpenedBeforeExport = exportDialog.open;
              document.getElementById('pdfExportClearAll').click();
              const emptySelectionBlocked = document.getElementById('pdfExportDialogStart').disabled;
              document.querySelector('label.pdf-choice-doctor input').click();
              const doctorsOnlyTargets = selectedPdfExportTargets();
              const exactSelectionValid = doctorsOnlyTargets.length === 1
                && doctorsOnlyTargets[0].kind === 'Врач'
                && document.getElementById('pdfExportDialogStatus').textContent.includes('Выбрано: 1 PDF');
              document.getElementById('pdfExportSelectAll').click();
              const allTargetsSelected = selectedPdfExportTargets().length === 3;
              UI.deptMonth = '2026-03';
              UI.deptFilter = 'Кардиология';
              UI.subFilter = 'all';
              switchTab('dept');
              await new Promise(resolve => setTimeout(resolve, 300));
              const deptScoreCanvas = document.getElementById('chDeptScores');
              const deptScoreChart = UI.charts.chDeptScores;
              const deptScoreChartCheck = {
                width: deptScoreCanvas ? deptScoreCanvas.width : 0,
                height: deptScoreCanvas ? deptScoreCanvas.height : 0,
                imageBytes: deptScoreCanvas ? deptScoreCanvas.toDataURL('image/png').length : 0,
                datasets: deptScoreChart ? deptScoreChart.data.datasets.length : 0,
                emptyPlaceholderHidden: !document.getElementById('chDeptScoresWrap')
              };
              const saved = await saveSessionState();
              const sessionSaveStatus = document.getElementById('sessionSaveStatus').textContent;
              const pdfExport = await startPdfExportFromDialog();
              return {
                title: document.title,
                dataPage: Boolean(document.getElementById('page-data')),
                optionalLibrariesDeferred,
                xlsx: typeof XLSX !== 'undefined',
                chart: typeof Chart !== 'undefined',
                desktop: Boolean(window.desktopAPI),
                saved,
                sessionSaveStatus,
                deptScoreChartCheck,
                pdfSelectionDialogValid: dialogOpenedBeforeExport && emptySelectionBlocked && exactSelectionValid && allTargetsSelected,
                pdfExport
              };
            })()`
          : `(async () => {
              await new Promise(resolve => setTimeout(resolve, 1200));
              const optionalLibrariesDeferred = typeof XLSX === 'undefined' && typeof JSZip === 'undefined' && typeof html2canvas === 'undefined' && !window.jspdf;
              loadBundledLibrary('lib-xlsx', 'XLSX');
              DB.doctors = {
                d1: {
                  name: 'Тестов Косметолог',
                  aliases: [],
                  department: 'Косметология',
                  specialization: 'Косметология',
                  structureManual: true,
                  spec: 'Косметолог'
                },
                d3: {
                  name: 'Примерова Косметолог',
                  aliases: [],
                  department: 'Косметология',
                  specialization: 'Косметология',
                  structureManual: true,
                  spec: 'Косметолог'
                },
                d2: { name: 'Тестов Терапевт', aliases: [], dept: 'Терапия', spec: 'Терапевт' }
              };
              DB.months = { '2026-01': emptyMonth(), '2026-02': emptyMonth() };
              DB.settings.depts['Косметология'].crossFocus = {
                title: 'Фокусы назначений',
                items: [
                  { name: 'Фокус А', syn: ['фокус а'], core: true },
                  { name: 'Фокус Б', syn: ['фокус б'], core: true }
                ],
                rules: []
              };
              DB.settings.depts['Косметология'].expertise = {
                title: 'Фокусы специализации',
                mode: 'services',
                group: '',
                items: [
                  { name: 'ЭхоКГ', syn: ['эхокг'], core: true },
                  { name: 'Велоэргометрия', syn: ['велоэргометрия'], core: true }
                ],
                rules: [],
                hints: []
              };
              DB.settings.depts['Косметология'].newRiskM = 6;
              DB.settings.depts['Косметология'].sleepM = 18;
              DB.settings.depts['Косметология'].lostM = 18;
              DB.settings.depts['Косметология'].riskM = 18;
              for (const mk of Object.keys(DB.months)) {
                DB.months[mk].vyrabotka.d1 = { items: [
                  { form: '', cat: 'Прием', n: 'Прием врача', q: 5, sOwn: mk.endsWith('01') ? 100000 : 120000, sRef: 20000, goods: false },
                  { form: '', cat: 'Диагностика и процедуры', n: 'ЭхоКГ', q: 12, sOwn: 12000, sRef: 0, goods: false },
                  { form: '', cat: 'Диагностика и процедуры', n: 'Велоэргометрия', q: 2, sOwn: 4000, sRef: 0, goods: false }
                ] };
                DB.months[mk].vyrabotka.d3 = { items: [
                  { form: '', cat: 'Прием', n: 'Прием врача', q: 3, sOwn: mk.endsWith('01') ? 70000 : 75000, sRef: 5000, goods: false },
                  { form: '', cat: 'Диагностика и процедуры', n: 'ЭхоКГ', q: 1, sOwn: 1000, sRef: 0, goods: false }
                ] };
                DB.months[mk].vyrabotka.d2 = { items: [{ form: '', cat: 'Прием', n: 'Прием врача', q: 4, sOwn: mk.endsWith('01') ? 80000 : 90000, sRef: 10000, goods: false }] };
                DB.months[mk].kb.d1 = {
                  '1': { clients: [
                    { name: 'Месячный пациент 1', patientId: 'm1', s: 50000, v: 2, r: 10 },
                    { name: 'Месячный пациент 2', patientId: 'm2', s: 40000, v: 1, r: 15 },
                    ...(mk.endsWith('02') ? [{ name: 'Месячный пациент 3', patientId: 'm3', s: 30000, v: 1, r: 8 }] : [])
                  ] },
                  '12': { clients: [
                    { name: 'Активный Пациент', patientId: '1', s: 50000, v: 3, r: 30 },
                    { name: 'Пациент Риска', patientId: '2', s: 70000, v: 2, r: 210 }
                  ] },
                  '24': { clients: [
                    { name: 'Активный Пациент', patientId: '1', s: 70000, v: 4, r: 30 },
                    { name: 'Пациент Риска', patientId: '2', s: 85000, v: 2, r: 210 },
                    { name: 'Потерянный Пациент', patientId: '3', s: 50000, v: 1, r: 500 }
                  ] },
                  '36': { clients: [
                    { name: 'Активный Пациент', patientId: '1', s: 90000, v: 5, r: 30 },
                    { name: 'Пациент Риска', patientId: '2', s: 100000, v: 3, r: 210 },
                    { name: 'Потерянный Пациент', patientId: '3', s: 60000, v: 1, r: 500 },
                    ...(mk.endsWith('02')
                      ? [{ name: 'Новый Активный', patientId: '4', s: 40000, v: 4, r: 20 }]
                      : [{ name: 'Второй Потерянный', patientId: '5', s: 30000, v: 1, r: 600 }])
                  ] }
                };
                DB.months[mk].naznach.d1 = { '1': { items: [
                  { n: 'Фокус А услуга', a: 2, d: 1, sq: 1, ss: 10000, groupPath: ['Клиника', 'Диагностика', 'Фокусные услуги'] },
                  { n: 'Прочая услуга', a: 2, d: 0, sq: 1, ss: 10000, groupPath: ['Клиника', 'Диагностика', 'Прочие услуги'] }
                ] } };
              }
              clearMetricsCache();
              UI.departmentMonth = '2026-02';
              UI.departmentFilter = 'all';
              switchTab('department');
              await new Promise(resolve => setTimeout(resolve, 300));
              const departmentPage = document.getElementById('page-department').classList.contains('active');
              const departmentCharts = Boolean(UI.charts.chDepartmentRevenue && UI.charts.chDepartmentRates && UI.charts.chDepartmentBase);
              const departmentAllLeaderboardCount = document.querySelectorAll('#departmentBody .doctor-score-leader').length;
              UI.departmentFilter = 'Косметология';
              renderDepartment();
              await new Promise(resolve => setTimeout(resolve, 150));
              const departmentFilteredLeaderboardCount = document.querySelectorAll('#departmentBody .doctor-score-leader').length;
              const departmentTotalRow = document.querySelector('#tblDepartmentSpecs .department-total-row');
              const departmentTotalValid = Boolean(departmentTotalRow)
                && departmentTotalRow.cells.length === document.querySelectorAll('#tblDepartmentSpecs tr:first-child th').length
                && departmentTotalRow.cells[0]?.textContent.includes('Итого по отделению')
                && departmentTotalRow.cells[2]?.textContent.includes('₽');
              UI.deptMonth = '2026-02';
              UI.deptFilter = 'Косметология';
              UI.subFilter = 'all';
              switchTab('dept');
              await new Promise(resolve => setTimeout(resolve, 150));
              const specializationLeaderboardCount = document.querySelectorAll('#deptBody .doctor-score-leader').length;
              const comparisonTable = document.getElementById('tblCompare');
              const comparisonHeaders = comparisonTable
                ? [...comparisonTable.querySelectorAll('tr:first-child th')].map(cell => cell.textContent.trim())
                : [];
              const comparisonRows = comparisonTable ? [...comparisonTable.querySelectorAll('tr')].slice(1) : [];
              const comparisonHeaderWidths = comparisonTable
                ? [...comparisonTable.querySelectorAll('tr:first-child th')].map(cell => Math.round(cell.getBoundingClientRect().width))
                : [];
              const specializationSummaryValid = comparisonHeaders.includes('Цель специализации')
                && comparisonHeaders.includes('Итог специализации')
                && comparisonRows.length > 0
                && comparisonRows.every(row => row.cells.length === comparisonHeaders.length)
                && comparisonRows.some(row => row.cells[0]?.textContent.trim() === 'Выручка'
                  && row.querySelector('.compare-total-cell')?.textContent.includes('₽'))
                && comparisonHeaderWidths.length === 5
                && Math.abs(comparisonHeaderWidths[1] - comparisonHeaderWidths[2]) <= 2
                && Math.abs(comparisonHeaderWidths[3] - comparisonHeaderWidths[4]) <= 2;
              const specializationPrimaryReturnHeader = [...document.querySelectorAll('#tblRating th')]
                .find(cell => cell.textContent.includes('Возвращаемость'));
              const specializationPrimaryReturnHeaderValid = Boolean(specializationPrimaryReturnHeader)
                && specializationPrimaryReturnHeader.innerHTML === 'Возвращаемость<br>первички (3 мес.)';
              const heatmapFocusWidths = [...document.querySelectorAll('#tblHeat .heatmap-focus-heading')]
                .map(cell => Math.round(cell.getBoundingClientRect().width));
              const heatmapCellWidths = [...document.querySelectorAll('#tblHeat tr:nth-child(2) .heat-cell')]
                .map(cell => Math.round(cell.getBoundingClientRect().width));
              const heatmapLayoutValid = heatmapFocusWidths.length === 2
                && heatmapCellWidths.length === 2
                && Math.max(...heatmapFocusWidths) - Math.min(...heatmapFocusWidths) <= 2
                && Math.max(...heatmapCellWidths) - Math.min(...heatmapCellWidths) <= 2;
              const specializationFocusTable = document.getElementById('tblSpecializationFocus');
              const specializationFocusNames = specializationFocusTable
                ? [...specializationFocusTable.querySelectorAll('tr')].slice(1, -1).map(row => row.cells[0]?.textContent.trim())
                : [];
              const specializationFocusTotal = specializationFocusTable?.querySelector('.specialization-focus-total');
              const specializationGrouping = document.querySelector('#deptBody .specialization-1c-grouping');
              const specializationFirstDoctorGroup = specializationGrouping?.querySelector('.specialization-1c-doctor');
              const specializationFocusBlockValid = Boolean(specializationFocusTable && specializationFocusTotal && specializationGrouping && specializationFirstDoctorGroup)
                && specializationFocusNames.some(name => name.includes('Фокус А'))
                && specializationFocusNames.some(name => name.includes('Фокус Б'))
                && specializationFocusTotal.textContent.includes('Итого по фокусам')
                && specializationFocusTotal.textContent.includes('2')
                && specializationFirstDoctorGroup.open
                && specializationGrouping.textContent.includes('Клиника')
                && specializationGrouping.textContent.includes('Фокусные услуги');
              const specializationDoctorSummary = document.querySelector('#deptBody .specialization-doctor-summary-table');
              const specializationFocusMatrixDetails = {
                table: Boolean(specializationFocusTable),
                total: Boolean(specializationFocusTotal),
                summary: Boolean(specializationDoctorSummary),
                headerCount: specializationFocusTable?.querySelectorAll('tr:first-child th').length || 0,
                doctorRows: specializationFocusNames.length,
                metrics: specializationFocusTable?.querySelectorAll('.specialization-doctor-focus-metric').length || 0,
                totalCells: specializationFocusTotal?.cells.length || 0,
                summaryRows: specializationDoctorSummary?.querySelectorAll('tr').length || 0,
                legacyGrouping: Boolean(specializationGrouping),
              };
              const specializationFocusMatrixValid = Boolean(specializationFocusTable && specializationFocusTotal && specializationDoctorSummary)
                && specializationFocusTable.querySelectorAll('tr:first-child th').length === 4
                && specializationFocusNames.length >= 1
                && specializationFocusTable.querySelectorAll('.specialization-doctor-focus-metric').length >= 1
                && specializationFocusTotal.cells.length === 4
                && specializationDoctorSummary.querySelectorAll('tr').length === specializationFocusNames.length + 1
                && !specializationGrouping;
              UI.departmentMonth = '2026-02';
              UI.departmentFilter = 'Терапия';
              switchTab('department');
              await new Promise(resolve => setTimeout(resolve, 150));
              const reportLeaderboardCount = document.querySelectorAll('#departmentBody .doctor-score-leader').length;
              const smokeCommentContext = { scopeType: 'department', scopeId: 'Терапия', periodKey: '2026-02', pageType: 'department' };
              const smokeCommentBlockKey = 'department.overview';
              await DESKTOP_API.saveComment({
                ...smokeCommentContext,
                blockKey: smokeCommentBlockKey,
                bodyText: 'Комментарий smoke-теста',
                bodyHtml: 'Комментарий smoke-теста'
              });
              await new Promise(resolve => setTimeout(resolve, 250));
              const smokeDrafts = await DESKTOP_API.listComments({
                periodKey: smokeCommentContext.periodKey,
                scopeType: smokeCommentContext.scopeType,
                scopeId: smokeCommentContext.scopeId
              });
              const commentWorkflowDraftSaved = smokeDrafts.some(comment => comment.bodyText === 'Комментарий smoke-теста');
              const leaderboardFixture = document.createElement('div');
              leaderboardFixture.innerHTML = doctorScoreLeaderboardHtml([
                { id: 'd1', r: { scores: { total: 82, rankEligible: true } } },
                { id: 'd1', r: { scores: { total: 55, rankEligible: true } } },
                { id: 'd1', r: { scores: { total: 20, rankEligible: true } } }
              ], '2026-02', 'Проверка цветов');
              const leaderboardColorStates = [...leaderboardFixture.querySelectorAll('.doctor-score-leader')]
                .map(element => element.dataset.scoreState).sort();
              const reportLeaderboardsValid = departmentAllLeaderboardCount === 3
                && departmentFilteredLeaderboardCount === 2
                && specializationLeaderboardCount === 2
                && reportLeaderboardCount === 1
                && leaderboardColorStates.join(',') === 'bad,good,warn';
              DB.months['2026-02'].naznach.d3 = { '1': { items: [
                { n: 'Смежная услуга', a: 5, d: 2, sq: 0, ss: 5000 }
              ] } };
              clearMetricsCache();
              UI.docId = 'd1';
              UI.docMonth = '2026-02';
              switchTab('doctor');
              await new Promise(resolve => setTimeout(resolve, 300));
              const shortWindowButton = [...document.querySelectorAll('#kbWinSeg button')].find(button => button.dataset.segmentValue === '12');
              if (shortWindowButton) shortWindowButton.click();
              await new Promise(resolve => setTimeout(resolve, 100));
              const shortWindowSelected = document.querySelector('#kbWinSeg button.active')?.dataset.segmentValue === '12';
              const shortLostHidden = !document.querySelector('#blkV4 [data-client-base-group="lost"]');
              const mediumWindowButton = [...document.querySelectorAll('#kbWinSeg button')].find(button => button.dataset.segmentValue === '24');
              if (mediumWindowButton) mediumWindowButton.click();
              await new Promise(resolve => setTimeout(resolve, 100));
              const mediumWindowSelected = document.querySelector('#kbWinSeg button.active')?.dataset.segmentValue === '24';
              const mediumLostVisible = Boolean(document.querySelector('#blkV4 [data-client-base-group="lost"]'));
              const fullWindowButton = [...document.querySelectorAll('#kbWinSeg button')].find(button => button.dataset.segmentValue === '36');
              if (fullWindowButton) fullWindowButton.click();
              await new Promise(resolve => setTimeout(resolve, 100));
              const fullWindowSelected = document.querySelector('#kbWinSeg button.active')?.dataset.segmentValue === '36';
              const clientBaseCards = [...document.querySelectorAll('#blkV4 .kb-summary-card')];
              const clientBaseCard = group => clientBaseCards.find(card => card.dataset.clientBaseGroup === group);
              const activeBaseCard = clientBaseCard('active');
              const lostBaseCard = clientBaseCard('lost');
              const totalBaseCard = clientBaseCard('total');
              const clientBaseDynamicsValid = clientBaseCards.length >= 6
                && clientBaseCards.every(card => Boolean(card.querySelector('.kb-summary-share'))
                  && card.querySelectorAll('.kb-summary-trends > div').length === 2)
                && totalBaseCard?.querySelector('.kb-summary-share')?.textContent.trim() === '100%'
                && activeBaseCard?.classList.contains('key-indicator')
                && lostBaseCard?.classList.contains('key-indicator')
                && activeBaseCard?.querySelector('.kb-summary-trends .kb-trend.good')?.textContent.includes('▲')
                && lostBaseCard?.querySelector('.kb-summary-trends .kb-trend.good')?.textContent.includes('▼');
              const riskActionButton = [...document.querySelectorAll('.kb-action-controls button')].find(button => button.textContent.includes('Новые, риск'));
              if (riskActionButton) riskActionButton.click();
              await new Promise(resolve => setTimeout(resolve, 100));
              const clientActionOpened = Boolean(document.getElementById('clientSegmentPatients')?.open)
                && UI.clientSegment === 'newRisk';
              const doctorHeaderMetrics = [...document.querySelectorAll('#blkHead .kpi .lbl')].map(element => element.textContent.trim());
              const doctorHeaderMetricsValid = doctorHeaderMetrics.length === 5
                && doctorHeaderMetrics.some(label => label.includes('Пациентов за месяц'))
                && doctorHeaderMetrics.some(label => label.includes('Загрузка расписания'))
                && doctorHeaderMetrics.some(label => label.includes('Коэффициент визитов на пациента за месяц'))
                && doctorHeaderMetrics.some(label => label.includes('Коэффициент визитов на пациента за 12 мес.'))
                && doctorHeaderMetrics.some(label => label.includes('Объём активной клиентской базы'))
                && !doctorHeaderMetrics.some(label => label.includes('Количество визитов за месяц'));
              const doctorHeaderCardRects = [...document.querySelectorAll('#blkHead .kpi')].map(element => {
                const rect = element.getBoundingClientRect();
                return { width: Math.round(rect.width), top: Math.round(rect.top) };
              });
              const doctorHeaderLayoutValid = doctorHeaderCardRects.length === 5
                && doctorHeaderCardRects.every(rect => rect.width >= 150)
                && Math.max(...doctorHeaderCardRects.map(rect => rect.top)) - Math.min(...doctorHeaderCardRects.map(rect => rect.top)) <= 2;
              const doctorGoalCards = [...document.querySelectorAll('#doctorGoalsSummary .doctor-goal-item')].map(element => ({
                key: element.dataset.goalKey,
                vector: element.dataset.goalVector,
                vectorLabel: element.closest('.doctor-goals-vector-column')?.querySelector('.doctor-goals-vector-head b')?.textContent.trim() || '',
                target: element.querySelector('.doctor-goal-target')?.textContent.trim() || '',
                fact: element.querySelector('.doctor-goal-fact')?.textContent.trim() || '',
                state: ['goal-good', 'goal-warn', 'goal-bad', 'goal-na'].find(name => element.classList.contains(name)) || ''
              }));
              const doctorGoalsSummaryValid = doctorGoalCards.length > 0
                && doctorGoalCards.every(goal => /^v[1-6]$/.test(goal.vector)
                  && /^В[1-6]\\*?$/.test(goal.vectorLabel)
                  && goal.target.startsWith('Цель:')
                  && goal.fact.startsWith('Факт:')
                  && Boolean(goal.state))
                && doctorGoalCards.some(goal => goal.fact !== 'Факт: нет данных')
                && doctorGoalCards.some(goal => goal.state === 'goal-good')
                && doctorGoalCards.some(goal => goal.state === 'goal-bad');
              const appointmentConversionBlock = document.querySelector('#blkV3 [data-list-key="appointmentConversionBlock"]');
              const appointmentConversionInitiallyCollapsed = Boolean(appointmentConversionBlock) && !appointmentConversionBlock.open;
              if (appointmentConversionBlock) appointmentConversionBlock.open = true;
              await new Promise(resolve => setTimeout(resolve, 0));
              const appointmentDetails = document.querySelector('#blkV3 [data-list-key="appointmentDetails"]');
              const appointmentDetailsInitiallyCollapsed = Boolean(appointmentDetails) && !appointmentDetails.open;
              if (appointmentDetails) appointmentDetails.open = true;
              await new Promise(resolve => setTimeout(resolve, 0));
              const appointmentRootGroup = document.querySelector('#tblNaz .source-group-depth-0[data-g]');
              const appointmentDescendants = appointmentRootGroup
                ? [...document.querySelectorAll('#tblNaz [data-group-ancestors~="' + appointmentRootGroup.dataset.g + '"]')]
                : [];
              if (appointmentRootGroup) appointmentRootGroup.click();
              await new Promise(resolve => setTimeout(resolve, 0));
              const appointmentExpandedShowsChild = appointmentDescendants.some(row => row.style.display !== 'none');
              if (appointmentRootGroup) appointmentRootGroup.click();
              await new Promise(resolve => setTimeout(resolve, 0));
              if (appointmentDetails) appointmentDetails.open = false;
              if (appointmentConversionBlock) appointmentConversionBlock.open = false;
              await new Promise(resolve => setTimeout(resolve, 0));
              const appointmentConversionCollapsed = Boolean(appointmentConversionBlock)
                && !appointmentConversionBlock.open;
              const primaryAppointmentCollapseChecks = {
                initiallyCollapsed: appointmentConversionInitiallyCollapsed,
                compactSummary: Boolean(appointmentConversionBlock?.querySelector('summary')?.textContent.includes('назначено 4')),
                compactValue: Boolean(appointmentConversionBlock?.querySelector('.appointment-conversion-summary-value')?.textContent.includes('75%')),
                bodyHidden: appointmentConversionCollapsed,
                detailsInitiallyCollapsed: appointmentDetailsInitiallyCollapsed,
                detailsSummary: Boolean(appointmentDetails?.querySelector('summary')?.textContent.includes('назначено 4')),
                hasDescendants: appointmentDescendants.length > 0,
                expandedShowsChild: appointmentExpandedShowsChild,
                collapsedHidesDescendants: appointmentDescendants.every(row => row.style.display === 'none')
              };
              const primaryAppointmentCollapseValid = Object.values(primaryAppointmentCollapseChecks).every(Boolean);
              UI.docId = 'd3';
              renderDoctor();
              await new Promise(resolve => setTimeout(resolve, 0));
              const anotherDoctorAppointmentBlock = document.querySelector('#blkV3 [data-list-key="appointmentConversionBlock"]');
              const anotherDoctorAppointmentCollapseValid = Boolean(anotherDoctorAppointmentBlock)
                && !anotherDoctorAppointmentBlock.open
                && anotherDoctorAppointmentBlock.querySelector('summary')?.textContent.includes('назначено 5')
                && anotherDoctorAppointmentBlock.querySelector('.appointment-conversion-summary-value')?.textContent.includes('40%');
              UI.docId = 'd1';
              renderDoctor();
              await new Promise(resolve => setTimeout(resolve, 0));
              const appointmentTablesCollapseValid = primaryAppointmentCollapseValid && anotherDoctorAppointmentCollapseValid;
              const appointmentCollapseDetails = {
                primaryAppointmentCollapseValid,
                primaryAppointmentCollapseChecks,
                anotherDoctorAppointmentCollapseValid,
                anotherDoctorSummary: anotherDoctorAppointmentBlock?.querySelector('summary')?.textContent.trim() || ''
              };
              const dynamicsCard = document.getElementById('blkDyn');
              const dynamicsTable = document.getElementById('blkDyn_tbl');
              const dynamicsOutcome = document.querySelector('#blkDynOutcome .dynamic-report-outcome');
              const dynamicsEditor = document.getElementById('blkDyn_narrative');
              const doctorReferralAverageDynamicsRow = dynamicsTable
                ? [...dynamicsTable.querySelectorAll('tr')].find(row => row.cells[0]?.textContent.trim() === 'Средний чек пациента с перенаправлениями')
                : null;
              const doctorReferralAverageDynamicsResult = computeMetrics('d1', '2026-02');
              const doctorReferralAverageDynamicsData = computeDoctorDynamics('d1', '2026-02');
              const doctorReferralAverageDynamicsDetails = {
                sourceWindow: Boolean(DB.months['2026-02']?.kb?.d1?.['1']),
                patients: doctorReferralAverageDynamicsResult?.traffic?.patients,
                revenueWithRef: doctorReferralAverageDynamicsResult?.econ?.revenueWithRef,
                avgClientRef: doctorReferralAverageDynamicsResult?.econ?.avgClientRef,
                rowNames: doctorReferralAverageDynamicsData?.rows?.map(row => row.name) || []
              };
              const doctorReferralAverageDynamicsValid = Boolean(doctorReferralAverageDynamicsRow)
                && doctorReferralAverageDynamicsRow.cells.length === dynamicsTable.rows[0].cells.length
                && [...doctorReferralAverageDynamicsRow.cells].slice(2).some(cell => cell.textContent.includes('₽'));
              const doctorSemanticSections = [...document.querySelectorAll('#doctorBody > .doctor-semantic-section')];
              const doctorSemanticTitles = doctorSemanticSections.map(section => section.querySelector('.doctor-semantic-heading b')?.textContent.trim() || '');
              const secondSemanticSection = doctorSemanticSections[1];
              if (secondSemanticSection) secondSemanticSection.open = false;
              await new Promise(resolve => setTimeout(resolve, 0));
              const semanticCollapseRemembered = Boolean(secondSemanticSection)
                && secondSemanticSection.open === false
                && UI.openLists.doctorSemantic2 === false;
              if (secondSemanticSection) secondSemanticSection.open = true;
              await new Promise(resolve => setTimeout(resolve, 0));
              const doctorSemanticSectionsValid = doctorSemanticSections.length === 4
                && doctorSemanticTitles.join('|') === 'Итоговый рейтинговый балл|Расшифровка векторов|Годовая динамика показателей|Выводы и фокусы развития'
                && Boolean(doctorSemanticSections[0]?.querySelector('#blkHead'))
                && Boolean(doctorSemanticSections[1]?.querySelector('#doctorGoalsSummary'))
                && Boolean(doctorSemanticSections[1]?.querySelector('#blkV1'))
                && Boolean(doctorSemanticSections[1]?.querySelector('#blkV6'))
                && Boolean(doctorSemanticSections[2]?.querySelector('#blkStack'))
                && Boolean(doctorSemanticSections[2]?.querySelector('#blkDyn'))
                && !doctorSemanticSections[2]?.querySelector('.dynamic-report-outcome')
                && Boolean(doctorSemanticSections[3]?.querySelector('#blkDynOutcome .dynamic-report-outcome'))
                && semanticCollapseRemembered;
              if (dynamicsEditor) {
                dynamicsEditor.innerHTML = '<strong>Ключевой вывод</strong><br><span style="color:#dc2626">Зона риска</span><br>' + Array.from({ length: 18 }, (_, index) => 'Строка подробного комментария ' + (index + 1)).join('<br>');
                saveDynamicNarrative('blkDyn');
              }
              const savedNarrative = DB.dynamicNotes && DB.dynamicNotes['doctor|2026-02|d1'];
              const reportWithNarrative = document.getElementById('doctorBody').innerHTML;
              const dynamicConclusionDetails = {
                finalSection: doctorSemanticSections.at(-1)?.id === 'doctorSemanticSection4',
                outcomeAfterDetails: Boolean(dynamicsTable && dynamicsOutcome
                  && (dynamicsTable.compareDocumentPosition(dynamicsOutcome) & Node.DOCUMENT_POSITION_FOLLOWING)),
                editorFullyVisible: Boolean(dynamicsEditor) && dynamicsEditor.scrollHeight <= dynamicsEditor.clientHeight + 2,
                savedRich: Boolean(savedNarrative && savedNarrative.format === 'rich-v1'
                  && savedNarrative.html.includes('<strong>Ключевой вывод</strong>')
                  && savedNarrative.html.includes('color:#dc2626')),
                reportIncludesSaved: reportWithNarrative.includes('<strong>Ключевой вывод</strong>')
                  && reportWithNarrative.includes('Ключевой итог отчёта')
              };
              const dynamicConclusionValid = Object.values(dynamicConclusionDetails).every(Boolean);
              const mirrorChart = UI.charts.chStack;
              const mirrorGap = mirrorChart ? Number(mirrorChart.options.plugins.mirrorRevenue.gap) : 0;
              const mirrorOwnDatasets = mirrorChart ? mirrorChart.data.datasets.filter(dataset => dataset.mirrorSide === 'own') : [];
              const mirrorRefDataset = mirrorChart ? mirrorChart.data.datasets.find(dataset => dataset.mirrorSide === 'ref') : null;
              const mirrorRevenueDetails = {
                ownDatasets: mirrorOwnDatasets.length,
                refDataset: Boolean(mirrorRefDataset),
                gap: mirrorGap,
                gapPixels: mirrorChart ? Math.round(Math.abs(mirrorChart.scales.x.getPixelForValue(mirrorGap) - mirrorChart.scales.x.getPixelForValue(-mirrorGap))) : 0,
                ownRangesValid: mirrorOwnDatasets.length > 0 && mirrorOwnDatasets.every(dataset => dataset.data.every((range, index) => Array.isArray(range)
                  && range.length === 2
                  && range[1] <= -mirrorGap + 0.01
                  && Math.abs((range[1] - range[0]) - (dataset.mirrorValues[index] || 0)) < 0.01)),
                refRangesValid: Boolean(mirrorRefDataset) && mirrorRefDataset.data.every((range, index) => Array.isArray(range)
                  && range.length === 2
                  && Math.abs(range[0] - mirrorGap) < 0.01
                  && Math.abs((range[1] - range[0]) - (mirrorRefDataset.mirrorValues[index] || 0)) < 0.01)
              };
              const mirrorRevenueChartValid = mirrorRevenueDetails.ownRangesValid
                && mirrorRevenueDetails.refRangesValid
                && mirrorRevenueDetails.gapPixels >= 20;
              const focusResult = computeMetrics('d1', '2026-02');
              const interdisciplinaryFocusDetails = {
                block: document.getElementById('blkV3').textContent.includes('ФОКУСЫ НАЗНАЧЕНИЙ'),
                charts: Boolean(UI.charts.chNazFocusAssigned && UI.charts.chNazFocusResult),
                used: focusResult.cross.naz[1].focus ? focusResult.cross.naz[1].focus.used : null,
                park: focusResult.cross.naz[1].focus ? focusResult.cross.naz[1].focus.park : null,
                score: focusResult.scores.vec.v3
              };
              const interdisciplinaryFocus = interdisciplinaryFocusDetails.block
                && interdisciplinaryFocusDetails.charts
                && interdisciplinaryFocusDetails.used === 1
                && interdisciplinaryFocusDetails.park === 2
                && interdisciplinaryFocusDetails.score === 100;
              UI.setDoctor = 'd1';
              switchTab('settings');
              enableDoctorMetricSettings();
              document.getElementById('dm_bm_revenue').value = '150000';
              saveDoctorMetricSettings();
              document.getElementById('doctorMetricSettingsCard').scrollIntoView({ block: 'start' });
              await new Promise(resolve => setTimeout(resolve, 200));
              const doctorMetricSettings = profileForDoctor('d1').scoring.benchmarks.revenue === 150000 && !document.getElementById('dm_bm_revenue').disabled;
              switchTab('doctor');
              await new Promise(resolve => setTimeout(resolve, 200));
              return {
                title: document.title,
                dataPage: Boolean(document.getElementById('page-data')),
                optionalLibrariesDeferred,
                departmentPage,
                departmentCharts,
                departmentTotalValid,
                reportLeaderboardsValid,
                specializationSummaryValid,
                specializationPrimaryReturnHeaderValid,
                specializationFocusBlockValid: specializationFocusMatrixValid,
                specializationFocusMatrixDetails,
                comparisonHeaders,
                comparisonHeaderWidths,
                heatmapLayoutValid,
                heatmapFocusWidths,
                heatmapCellWidths,
                reportLeaderboardDetails: {
                  departmentAllLeaderboardCount,
                  departmentFilteredLeaderboardCount,
                  specializationLeaderboardCount,
                  reportLeaderboardCount,
                  leaderboardColorStates
                },
                commentWorkflowDraftSaved,
                smokeCommentContext,
                smokeCommentBlockKey,
                doctorHeaderMetrics,
                doctorHeaderMetricsValid,
                doctorHeaderCardRects,
                doctorHeaderLayoutValid,
                clientBaseDynamicsValid,
                clientBaseButtonsValid: Boolean(shortWindowButton && mediumWindowButton && fullWindowButton && riskActionButton)
                  && shortWindowSelected && mediumWindowSelected && fullWindowSelected && shortLostHidden && mediumLostVisible && clientActionOpened,
                doctorGoalsSummaryValid,
                doctorGoalCards,
                appointmentTablesCollapseValid,
                appointmentCollapseDetails,
                doctorSemanticSectionsValid,
                doctorSemanticTitles,
                doctorReferralAverageDynamicsValid,
                doctorReferralAverageDynamicsDetails,
                dynamicConclusionValid,
                dynamicConclusionDetails,
                mirrorRevenueChartValid,
                mirrorRevenueDetails,
                interdisciplinaryFocus,
                interdisciplinaryFocusDetails,
                doctorMetricSettings,
                xlsx: typeof XLSX !== 'undefined',
                chart: typeof Chart !== 'undefined',
                desktop: Boolean(window.desktopAPI)
              };
            })()`;
        const result = await mainWindow.webContents.executeJavaScript(smokeAction);
        process.stdout.write("[smoke] renderer assertions completed\n");
        if (!PDF_SMOKE_TEST) {
          const savedComment = database.listComments({
            periodKey: result.smokeCommentContext.periodKey,
            scopeType: result.smokeCommentContext.scopeType,
            scopeId: result.smokeCommentContext.scopeId,
          }).find(comment => comment.blockKey === result.smokeCommentBlockKey);
          result.commentWorkflowDraftSaved = Boolean(savedComment);
          result.commentWorkflowValid = Boolean(
            savedComment
            && savedComment.status === "draft"
            && savedComment.bodyText === "Комментарий smoke-теста",
          );
        }
        const artifactRoot = SMOKE_ARTIFACT_ROOT;
        fs.mkdirSync(artifactRoot, { recursive: true });
        if (!PDF_SMOKE_TEST) {
          const goalsScreenshotPath = path.join(artifactRoot, "doctor-goals-smoke.png");
          const goalsScreenshot = await mainWindow.webContents.executeJavaScript(`(async () => {
            loadBundledLibrary('lib-html2canvas', 'html2canvas');
            document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
            document.getElementById('page-doctor')?.classList.add('active');
            const element = document.getElementById('doctorGoalsSummary');
            if (!element) return '';
            const canvas = await html2canvas(element, { backgroundColor: '#ffffff', scale: 1.5, logging: false, windowWidth: 1400 });
            return canvas.toDataURL('image/png');
          })()`);
          if (!goalsScreenshot.startsWith('data:image/png;base64,')) throw new Error('Не удалось получить снимок блока целей врача');
          fs.writeFileSync(goalsScreenshotPath, Buffer.from(goalsScreenshot.slice('data:image/png;base64,'.length), 'base64'));
          result.goalsScreenshot = goalsScreenshotPath;
          const clientBaseScreenshotPath = path.join(artifactRoot, "client-base-vector-smoke.png");
          const clientBaseScreenshot = await mainWindow.webContents.executeJavaScript(`(async () => {
            const element = document.getElementById('blkV4');
            if (!element) return '';
            const canvas = await html2canvas(element, { backgroundColor: '#ffffff', scale: 1.25, logging: false, windowWidth: 1400 });
            return canvas.toDataURL('image/png');
          })()`);
          if (!clientBaseScreenshot.startsWith('data:image/png;base64,')) throw new Error('Не удалось получить снимок Вектора 4');
          fs.writeFileSync(clientBaseScreenshotPath, Buffer.from(clientBaseScreenshot.slice('data:image/png;base64,'.length), 'base64'));
          result.clientBaseScreenshot = clientBaseScreenshotPath;
          const appointmentCollapseScreenshotPath = path.join(artifactRoot, "appointment-conversion-collapsed-smoke.png");
          const appointmentCollapseScreenshot = await mainWindow.webContents.executeJavaScript(`(async () => {
            const element = document.getElementById('blkV3');
            if (!element) return '';
            const canvas = await html2canvas(element, { backgroundColor: '#ffffff', scale: 1.25, logging: false, windowWidth: 1400 });
            return canvas.toDataURL('image/png');
          })()`);
          if (!appointmentCollapseScreenshot.startsWith('data:image/png;base64,')) throw new Error('Не удалось получить снимок свёрнутых таблиц назначений');
          fs.writeFileSync(appointmentCollapseScreenshotPath, Buffer.from(appointmentCollapseScreenshot.slice('data:image/png;base64,'.length), 'base64'));
          result.appointmentCollapseScreenshot = appointmentCollapseScreenshotPath;
          const mirrorScreenshotPath = path.join(artifactRoot, "mirror-revenue-smoke.png");
          const mirrorScreenshot = await mainWindow.webContents.executeJavaScript(`document.getElementById('chStack')?.toDataURL('image/png') || ''`);
          if (!mirrorScreenshot.startsWith('data:image/png;base64,')) throw new Error('Не удалось получить снимок зеркального графика');
          fs.writeFileSync(mirrorScreenshotPath, Buffer.from(mirrorScreenshot.slice('data:image/png;base64,'.length), 'base64'));
          result.mirrorScreenshot = mirrorScreenshotPath;
          const leaderboardScreenshotPath = path.join(artifactRoot, "report-leaderboard-smoke.png");
          const leaderboardScreenshot = await mainWindow.webContents.executeJavaScript(`(async () => {
            UI.deptMonth = '2026-02'; UI.deptFilter = 'Косметология'; UI.subFilter = 'all'; switchTab('dept');
            await new Promise(resolve => setTimeout(resolve, 150));
            const element = document.querySelector('#deptBody .doctor-score-leaderboard');
            if (!element) return '';
            const canvas = await html2canvas(element, { backgroundColor: '#ffffff', scale: 1.5, logging: false, windowWidth: 1400 });
            return canvas.toDataURL('image/png');
          })()`);
          if (!leaderboardScreenshot.startsWith('data:image/png;base64,')) throw new Error('Не удалось получить снимок лидерборда врачей');
          fs.writeFileSync(leaderboardScreenshotPath, Buffer.from(leaderboardScreenshot.slice('data:image/png;base64,'.length), 'base64'));
          result.leaderboardScreenshot = leaderboardScreenshotPath;
          const specializationRatingScreenshotPath = path.join(artifactRoot, "specialization-rating-summary-smoke.png");
          const specializationRatingScreenshot = await mainWindow.webContents.executeJavaScript(`(async () => {
            const table = document.getElementById('tblRating');
            const element = table ? table.closest('.card') : null;
            if (!element) return '';
            const canvas = await html2canvas(element, { backgroundColor: '#ffffff', scale: 1.5, logging: false, windowWidth: 1400 });
            return canvas.toDataURL('image/png');
          })()`);
          if (!specializationRatingScreenshot.startsWith('data:image/png;base64,')) throw new Error('Не удалось получить снимок сводной таблицы специализации');
          fs.writeFileSync(specializationRatingScreenshotPath, Buffer.from(specializationRatingScreenshot.slice('data:image/png;base64,'.length), 'base64'));
          result.specializationRatingScreenshot = specializationRatingScreenshotPath;
          const specializationFocusScreenshotPath = path.join(artifactRoot, "specialization-focuses-smoke.png");
          const specializationFocusScreenshot = await mainWindow.webContents.executeJavaScript(`(async () => {
            const element = document.querySelector('#deptBody .specialization-interdisciplinary');
            if (!element) return '';
            const canvas = await html2canvas(element, { backgroundColor: '#ffffff', scale: 1.25, logging: false, windowWidth: 1400 });
            return canvas.toDataURL('image/png');
          })()`);
          if (!specializationFocusScreenshot.startsWith('data:image/png;base64,')) throw new Error('Не удалось получить снимок фокусов специализации');
          fs.writeFileSync(specializationFocusScreenshotPath, Buffer.from(specializationFocusScreenshot.slice('data:image/png;base64,'.length), 'base64'));
          result.specializationFocusScreenshot = specializationFocusScreenshotPath;
          const heatmapScreenshotPath = path.join(artifactRoot, "heatmap-focus-smoke.png");
          const heatmapScreenshot = await mainWindow.webContents.executeJavaScript(`(async () => {
            const table = document.getElementById('tblHeat');
            const element = table ? table.closest('.card') : null;
            if (!element) return '';
            const canvas = await html2canvas(element, { backgroundColor: '#ffffff', scale: 1.5, logging: false, windowWidth: 1400 });
            return canvas.toDataURL('image/png');
          })()`);
          if (!heatmapScreenshot.startsWith('data:image/png;base64,')) throw new Error('Не удалось получить снимок тепловой карты');
          fs.writeFileSync(heatmapScreenshotPath, Buffer.from(heatmapScreenshot.slice('data:image/png;base64,'.length), 'base64'));
          result.heatmapScreenshot = heatmapScreenshotPath;
          const comparisonScreenshotPath = path.join(artifactRoot, "specialization-summary-smoke.png");
          const comparisonScreenshot = await mainWindow.webContents.executeJavaScript(`(async () => {
            const element = document.getElementById('cmpTable');
            if (!element) return '';
            const canvas = await html2canvas(element, { backgroundColor: '#ffffff', scale: 1.5, logging: false, windowWidth: 1400 });
            return canvas.toDataURL('image/png');
          })()`);
          if (!comparisonScreenshot.startsWith('data:image/png;base64,')) throw new Error('Не удалось получить снимок итогов специализации');
          fs.writeFileSync(comparisonScreenshotPath, Buffer.from(comparisonScreenshot.slice('data:image/png;base64,'.length), 'base64'));
          result.comparisonScreenshot = comparisonScreenshotPath;
          const semanticSectionsScreenshotPath = path.join(artifactRoot, "doctor-semantic-sections-smoke.png");
          const semanticSectionsScreenshot = await mainWindow.webContents.executeJavaScript(`(async () => {
            UI.docId = 'd1'; UI.docMonth = '2026-02'; switchTab('doctor');
            await new Promise(resolve => setTimeout(resolve, 150));
            setDoctorSemanticSections(false);
            await new Promise(resolve => setTimeout(resolve, 50));
            const element = document.getElementById('doctorBody');
            if (!element) return '';
            const canvas = await html2canvas(element, { backgroundColor: '#f4f6fa', scale: 1.25, logging: false, windowWidth: 1400 });
            return canvas.toDataURL('image/png');
          })()`);
          if (!semanticSectionsScreenshot.startsWith('data:image/png;base64,')) throw new Error('Не удалось получить снимок четырёх разделов отчёта врача');
          fs.writeFileSync(semanticSectionsScreenshotPath, Buffer.from(semanticSectionsScreenshot.slice('data:image/png;base64,'.length), 'base64'));
          result.semanticSectionsScreenshot = semanticSectionsScreenshotPath;
          const dynamicConclusionScreenshotPath = path.join(artifactRoot, "dynamic-conclusion-smoke.png");
          const dynamicConclusionScreenshot = await mainWindow.webContents.executeJavaScript(`(async () => {
            UI.docId = 'd1'; UI.docMonth = '2026-02'; switchTab('doctor');
            await new Promise(resolve => setTimeout(resolve, 150));
            setDoctorSemanticSections(true);
            await new Promise(resolve => setTimeout(resolve, 100));
            const element = document.querySelector('#blkDynOutcome .dynamic-report-outcome');
            if (!element) return '';
            const canvas = await html2canvas(element, { backgroundColor: '#ffffff', scale: 1.25, logging: false, windowWidth: 1400 });
            return canvas.toDataURL('image/png');
          })()`);
          if (!dynamicConclusionScreenshot.startsWith('data:image/png;base64,')) throw new Error('Не удалось получить снимок ключевого итогового блока');
          fs.writeFileSync(dynamicConclusionScreenshotPath, Buffer.from(dynamicConclusionScreenshot.slice('data:image/png;base64,'.length), 'base64'));
          result.dynamicConclusionScreenshot = dynamicConclusionScreenshotPath;
          const doctorDynamicsTableScreenshotPath = path.join(artifactRoot, "doctor-dynamics-table-smoke.png");
          const doctorDynamicsTableScreenshot = await mainWindow.webContents.executeJavaScript(`(async () => {
            const element = document.getElementById('blkDyn_tbl');
            if (!element) return '';
            const canvas = await html2canvas(element, { backgroundColor: '#ffffff', scale: 1.25, logging: false, windowWidth: 1400 });
            return canvas.toDataURL('image/png');
          })()`);
          if (!doctorDynamicsTableScreenshot.startsWith('data:image/png;base64,')) throw new Error('Не удалось получить снимок таблицы динамики врача');
          fs.writeFileSync(doctorDynamicsTableScreenshotPath, Buffer.from(doctorDynamicsTableScreenshot.slice('data:image/png;base64,'.length), 'base64'));
          result.doctorDynamicsTableScreenshot = doctorDynamicsTableScreenshotPath;
          await mainWindow.webContents.executeJavaScript(`(() => {
            UI.docId = 'd1'; UI.docMonth = '2026-02'; switchTab('doctor');
            document.getElementById('blkHead')?.scrollIntoView({ block: 'start' });
          })()`);
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        const screenshotPath = path.join(artifactRoot, "desktop-smoke.png");
        const screenshot = await mainWindow.webContents.capturePage();
        fs.writeFileSync(screenshotPath, screenshot.toPNG());
        result.screenshot = screenshotPath;
        if (PDF_SMOKE_TEST) {
          const sourceDir = path.join(configStore.publicConfig().outputDir, "2026-03");
          const pdfDir = path.join(artifactRoot, "pdfs");
          fs.rmSync(pdfDir, { recursive: true, force: true });
          fs.mkdirSync(pdfDir, { recursive: true });
          const pdfFiles = [];
          const collectPdfFiles = (directory, relative = "") => {
            if (!fs.existsSync(directory)) return;
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
              if (entry.name === "Предыдущие версии") continue;
              const childRelative = path.join(relative, entry.name);
              const fullPath = path.join(directory, entry.name);
              if (entry.isDirectory()) collectPdfFiles(fullPath, childRelative);
              else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) pdfFiles.push(childRelative);
            }
          };
          collectPdfFiles(sourceDir);
          for (const fileName of pdfFiles) {
            fs.mkdirSync(path.dirname(path.join(pdfDir, fileName)), { recursive: true });
            fs.copyFileSync(path.join(sourceDir, fileName), path.join(pdfDir, fileName));
          }
          result.pdfFiles = pdfFiles;
          result.pdfDir = pdfDir;
        }
        result.rendererErrors = smokeRendererErrors.slice();
        fs.writeFileSync(path.join(artifactRoot, "smoke-result.json"), JSON.stringify(result, null, 2), "utf8");
        process.stdout.write(`${JSON.stringify(result)}\n`);
        const passed = result.dataPage && result.optionalLibrariesDeferred && result.xlsx && result.chart && result.desktop
          && result.rendererErrors.length === 0
          && (PDF_SMOKE_TEST || (result.departmentPage && result.departmentCharts && result.departmentTotalValid && result.reportLeaderboardsValid && result.specializationSummaryValid && result.specializationPrimaryReturnHeaderValid && result.specializationFocusBlockValid && result.heatmapLayoutValid && result.doctorHeaderMetricsValid && result.doctorHeaderLayoutValid && result.clientBaseDynamicsValid && result.clientBaseButtonsValid && result.doctorGoalsSummaryValid && result.appointmentTablesCollapseValid && result.doctorSemanticSectionsValid && result.doctorReferralAverageDynamicsValid && result.dynamicConclusionValid && result.mirrorRevenueChartValid && result.interdisciplinaryFocus && result.doctorMetricSettings && result.commentWorkflowValid))
          && (!PDF_SMOKE_TEST || (result.saved && result.pdfSelectionDialogValid && result.pdfExport && result.pdfExport.saved === 3
            && result.pdfExport.chartImages >= 3 && result.pdfFiles.length === 3
            && result.sessionSaveStatus && result.sessionSaveStatus.includes('Сохранено в рабочую базу SQLite')
            && result.deptScoreChartCheck && (result.deptScoreChartCheck.datasets > 0
              ? result.deptScoreChartCheck.imageBytes > 10000
              : result.deptScoreChartCheck.emptyPlaceholderHidden)));
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
  ipcMain.on("app:renderer-error", (event, payload) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
    const input = payload && typeof payload === "object" ? payload : {};
    logEvent("renderer-error", {
      message: String(input.message || "Неизвестная ошибка renderer").slice(0, 2000),
      stack: String(input.stack || "").slice(0, 8000),
      source: String(input.source || "").slice(0, 500),
    });
  });
  ipcMain.handle("app:initialize", () => {
    return {
      app: { name: APP_NAME, version: app.getVersion(), packaged: app.isPackaged, smokeTest: SMOKE_TEST },
      config: configStore.publicConfig(),
      snapshot: database.loadSnapshot(),
      summary: database.summary(),
      update: updateService.getStatus(),
    };
  });
  ipcMain.handle("comments:list", (_event, payload) => {
    localAdminActor();
    return database.listComments(ensureObject(payload, "контекст комментариев"));
  });
  ipcMain.handle("comments:save", (_event, payload) => {
    const session = localAdminActor();
    const input = ensureObject(payload, "комментарий");
    const bodyHtml = sanitizeRichTextHtml(input.bodyHtml);
    const bodyText = String(input.bodyText || "").slice(0, 10000);
    if (!/^(department|specialization|doctor)$/.test(String(input.scopeType))) throw new Error("Некорректная область комментария");
    if (!/^\d{4}-\d{2}$/.test(String(input.periodKey))) throw new Error("Некорректный период комментария");
    if (!/^[a-z0-9._:-]{2,120}$/i.test(String(input.blockKey))) throw new Error("Некорректный ключ аналитического блока");
    const saved = database.saveCommentDraft({
      scopeType: input.scopeType,
      scopeId: String(input.scopeId || "").slice(0, 200),
      periodKey: input.periodKey,
      blockKey: input.blockKey,
      bodyHtml,
      bodyText,
      authorUserId: session.userId,
    });
    database.audit({ actorUserId: session.userId, action: "comment.saved", targetType: "comment", targetId: String(saved.id), details: { periodKey: input.periodKey, blockKey: input.blockKey } });
    return saved;
  });
  ipcMain.handle("comments:history", (_event, id) => {
    localAdminActor();
    return database.listCommentVersions(id);
  });
  ipcMain.handle("comments:archive", (_event, id) => {
    const session = localAdminActor();
    const archived = database.archiveComment(id, session.userId);
    database.audit({ actorUserId: session.userId, action: "comment.archived", targetType: "comment", targetId: String(id) });
    return archived;
  });
  ipcMain.handle("viewer-publication:access", () => {
    localAdminActor();
    return database.viewerAccessSnapshot();
  });
  ipcMain.handle("viewer-publication:update-doctor", (_event, payload) => {
    const session = localAdminActor();
    const input = ensureObject(payload, "настройки доступа врача");
    const updated = database.updateViewerDoctorAccess(input);
    database.audit({ actorUserId: session.userId, action: "viewer-access.updated", targetType: "doctor", targetId: updated.doctorId,
      details: { active: updated.active, pinVersion: updated.pinVersion } });
    return updated;
  });
  ipcMain.handle("viewer-publication:update-department-head", (_event, payload) => {
    const session = localAdminActor();
    const input = ensureObject(payload, "назначение заведующего отделением");
    const snapshot = database.updateViewerDepartmentHead(input);
    database.audit({ actorUserId: session.userId, action: "viewer-department-head.updated", targetType: "department",
      targetId: String(input.department || ""), details: { doctorId: String(input.doctorId || "") } });
    return snapshot;
  });
  ipcMain.handle("viewer-publication:set-admin-pin", (_event, payload) => {
    const session = localAdminActor();
    const input = ensureObject(payload, "PIN администратора Viewer");
    const result = database.setViewerAdminPin(input.pin);
    database.audit({ actorUserId: session.userId, action: "viewer-admin-pin.updated", targetType: "viewer", targetId: "admin",
      details: { pinVersion: result.version } });
    return result;
  });
  ipcMain.handle("viewer-publication:export", async (_event, payload) => {
    const session = localAdminActor();
    const input = ensureObject(payload, "публикация Viewer");
    if (!Array.isArray(input.doctors) || !Array.isArray(input.periods) || !Array.isArray(input.pages)) {
      throw new Error("Некорректное содержимое публикации Viewer");
    }
    const snapshot = database.loadSnapshot() || {};
    const knownDoctors = new Set(Object.keys(snapshot.doctors || {}));
    const doctorIds = input.doctors.map(doctor => String(doctor.doctorId || ""));
    if (doctorIds.some(id => !knownDoctors.has(id))) throw new Error("В публикации указан неизвестный врач");
    const subjects = Array.isArray(input.subjects) ? input.subjects : input.doctors;
    const subjectIds = subjects.map(doctor => String(doctor.doctorId || ""));
    if (subjectIds.some(id => !knownDoctors.has(id))) throw new Error("В публикации указан неизвестный врач отделения");
    const format = String(input.format || "html");
    if (format !== "html" && format !== "zip") throw new Error("Неизвестный формат публикации Viewer");
    const credentials = database.viewerExportCredentials(doctorIds, { requireAdmin: format === "zip" });
    const publication = {
      appVersion: app.getVersion(),
      doctors: input.doctors,
      subjects,
      periods: input.periods,
      pages: input.pages,
      credentials,
    };
    const created = format === "html"
      ? await createStandaloneViewerHtml(publication)
      : await createViewerPackage(publication);
    const date = new Date().toISOString().slice(0, 10);
    const selected = await dialog.showSaveDialog(mainWindow, {
      title: format === "html" ? "Сохранить автономный Viewer" : "Сохранить ZIP для КлинВект Щербатова Viewer",
      defaultPath: path.join(configStore.publicConfig().outputDir, `КлинВект-Щербатова-отчёты-${date}.${format}`),
      filters: format === "html"
        ? [{ name: "Автономный HTML Viewer", extensions: ["html"] }]
        : [{ name: "Пакет отчётов Viewer", extensions: ["zip"] }],
    });
    if (selected.canceled || !selected.filePath) return { canceled: true };
    fs.writeFileSync(selected.filePath, created.buffer, { flag: "w" });
    const recorded = database.recordViewerExport({
      packageId: created.manifest.packageId,
      fileName: path.basename(selected.filePath),
      sha256: created.sha256,
      manifest: created.manifest,
      createdBy: session.userId,
    });
    return { canceled: false, format, path: selected.filePath, ...recorded, doctors: doctorIds.length, periods: input.periods.length };
  });
  ipcMain.handle("viewer-publication:export-pins", async (_event, payload) => {
    const session = localAdminActor();
    const input = ensureObject(payload, "таблица PIN Viewer");
    let buffer;
    try {
      buffer = Buffer.from(input.bytes || []);
    } catch (_) {
      throw new Error("Некорректный файл таблицы PIN Viewer");
    }
    if (!buffer.length || buffer.length > 20 * 1024 * 1024) throw new Error("Некорректный размер таблицы PIN Viewer");
    const doctorCount = Number(input.doctorCount);
    if (!Number.isInteger(doctorCount) || doctorCount < 1 || doctorCount > 10000) throw new Error("Некорректное количество врачей в таблице PIN Viewer");
    const date = new Date().toISOString().slice(0, 10);
    const selected = await dialog.showSaveDialog(mainWindow, {
      title: "Сохранить таблицу PIN Viewer",
      defaultPath: path.join(configStore.publicConfig().outputDir, `PIN-коды-Viewer-${date}.xlsx`),
      filters: [{ name: "Таблица Excel", extensions: ["xlsx"] }],
    });
    if (selected.canceled || !selected.filePath) return { canceled: true };
    fs.writeFileSync(selected.filePath, buffer, { flag: "w" });
    database.audit({ actorUserId: session.userId, action: "viewer-pins.exported", targetType: "viewer", targetId: "doctor-pins",
      details: { doctorCount, fileName: path.basename(selected.filePath) } });
    return { canceled: false, path: selected.filePath, doctorCount };
  });
  ipcMain.handle("database:save", (_event, json) => {
    localAdminActor();
    if (typeof json !== "string" || json.length > 200 * 1024 * 1024) throw new Error("Некорректный размер снимка базы");
    const snapshot = JSON.parse(json);
    return database.saveSnapshot(snapshot);
  });

  ipcMain.handle("database:export-json", async (_event, json) => {
    localAdminActor();
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
    localAdminActor();
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
    database.ensureLocalAdministrator();
    return { canceled: false, config };
  });

  ipcMain.handle("config:choose-folder", async (_event, kind) => {
    localAdminActor();
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
    localAdminActor();
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
    localAdminActor();
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Выберите выгрузки 1С",
      defaultPath: configStore.publicConfig().inputDir,
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Выгрузки 1С и архивы", extensions: ["xls", "xlsx", "zip"] }],
    });
    if (result.canceled) return [];
    return fileService.describeSelected(result.filePaths);
  });
  ipcMain.handle("files:scan-input", () => { localAdminActor(); return fileService.scanInputFolder(); });
  ipcMain.handle("files:list-imported", (_event, reportType) => {
    localAdminActor();
    const type = String(reportType || "");
    if (!new Set(["vyrabotka", "kb", "naznach", "pervichka", "prostoy", "zapis"]).has(type)) {
      throw new Error("Неподдерживаемый тип ранее импортированных данных");
    }
    return fileService.listImportedSources(type);
  });
  ipcMain.handle("files:read-input", (_event, filePath) => { localAdminActor(); return fileService.readInputFile(String(filePath)); });
  ipcMain.handle("import:has-source", (_event, sha256) => { localAdminActor(); return database.hasSuccessfulSource(String(sha256)); });

  ipcMain.handle("import:begin", async (_event, payload) => {
    localAdminActor();
    const input = ensureObject(payload || {}, "параметры импорта");
    const backup = await backupService.createAutomatic("перед-импортом");
    return { batchId: database.beginImportBatch({ totalFiles: input.totalFiles, backupPath: backup.path }), backupPath: backup.path };
  });
  ipcMain.handle("import:record", (_event, payload) => {
    localAdminActor();
    const input = ensureObject(payload, "сведения об импорте");
    database.recordImport(input);
    return true;
  });
  ipcMain.handle("import:finish", (_event, payload) => {
    localAdminActor();
    const input = ensureObject(payload, "итоги импорта");
    database.finishImportBatch(input.batchId, input.counts || {});
    return database.summary();
  });

  ipcMain.handle("export:begin", (_event, payload) => { localAdminActor(); return fileService.beginExportBatch(ensureObject(payload, "параметры выгрузки")); });
  ipcMain.handle("export:write", (_event, payload) => { localAdminActor(); return fileService.writeExportFile(ensureObject(payload, "файл выгрузки")); });
  ipcMain.handle("export:finish", (_event, payload) => { localAdminActor(); return fileService.finishExportBatch(ensureObject(payload, "итоги выгрузки")); });
  ipcMain.handle("export:abort", (_event, token) => { localAdminActor(); return fileService.abortExportBatch(token); });

  ipcMain.handle("backup:create", async () => { localAdminActor(); return backupService.createAutomatic("ручная"); });
  ipcMain.handle("backup:export", async () => {
    localAdminActor();
    const date = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Сохранить переносимую резервную копию",
      defaultPath: path.join(configStore.publicConfig().backupDir, `КлинВект-Щербатова-backup-${date}.ovbackup`),
      filters: [{ name: "Резервная копия", extensions: ["ovbackup"] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const saved = await backupService.createPortable(result.filePath);
    return Object.assign({ canceled: false }, saved);
  });
  ipcMain.handle("backup:restore", async () => {
    localAdminActor();
    const selected = await dialog.showOpenDialog(mainWindow, {
      title: "Выберите резервную копию",
      defaultPath: configStore.publicConfig().backupDir,
      properties: ["openFile"],
      filters: [
        { name: "Резервные копии SQLite", extensions: ["ovbackup", "sqlite", "db", "backup"] },
        { name: "Все файлы", extensions: ["*"] },
      ],
    });
    if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
    const source = selected.filePaths[0];
    const preview = backupService.preview(source);
    if (!preview.ok) throw new Error(`Копия повреждена: ${preview.error || preview.integrity}`);
    if (!preview.compatible) throw new Error(`Копия создана более новой версией приложения (версия данных ${preview.snapshotVersion})`);
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Восстановление базы",
      message: "Заменить текущую базу выбранной резервной копией?",
      detail: `В копии: месяцев — ${preview.months}, врачей — ${preview.doctors}, пользователей — ${preview.users || 0}, комментариев — ${preview.comments || 0}, публикаций — ${preview.publications || 0}, импортов — ${preview.imports}, версия данных — ${preview.snapshotVersion || "без версии"}. Текущая база будет предварительно сохранена.`,
      buttons: ["Восстановить", "Отмена"],
      defaultId: 1,
      cancelId: 1,
    });
    if (confirmation.response !== 0) return { canceled: true };
    const restored = await backupService.restore(source);
    database.ensureLocalAdministrator();
    return { canceled: false, restored };
  });

  ipcMain.handle("update:check", () => { localAdminActor(); return updateService.check(); });
  ipcMain.handle("update:install-downloaded", () => { localAdminActor(); return updateService.installDownloaded(); });
  ipcMain.handle("update:install-file", async () => {
    localAdminActor();
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
app.on("will-quit", () => {
  try { if (database) database.close(); } catch (_) { /* best effort */ }
});
