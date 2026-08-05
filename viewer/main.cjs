"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { ViewerStorageService } = require("./storage-service.cjs");

const APP_NAME = "Пульс клиники — Viewer";
const ADMIN_SESSION_MS = 10 * 60 * 1000;
let mainWindow = null;
let storage = null;
let adminSessionUntil = 0;
let adminFailures = 0;
let adminLockedUntil = 0;
let doctorSession = null;

app.setName(APP_NAME);

function requireAdmin() {
  if (Date.now() >= adminSessionUntil) {
    adminSessionUntil = 0;
    throw new Error("Администраторская сессия истекла. Введите PIN снова.");
  }
  adminSessionUntil = Date.now() + ADMIN_SESSION_MS;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: APP_NAME,
    backgroundColor: "#f4f6fa",
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
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

function registerIpc() {
  ipcMain.handle("viewer:status", () => storage.status());
  ipcMain.handle("viewer:choose-storage", async () => {
    const selected = await dialog.showOpenDialog(mainWindow, {
      title: "Выберите общую папку опубликованных отчётов",
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Использовать эту папку",
    });
    if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
    doctorSession = null;
    adminSessionUntil = 0;
    return { canceled: false, status: storage.setStorageRoot(selected.filePaths[0]) };
  });
  ipcMain.handle("viewer:admin-login", (_event, pin) => {
    if (Date.now() < adminLockedUntil) throw new Error("Вход временно заблокирован после нескольких ошибок");
    if (!storage.verifyAdminPin(pin)) {
      adminFailures++;
      if (adminFailures >= 5) {
        adminFailures = 0;
        adminLockedUntil = Date.now() + 60 * 1000;
      }
      throw new Error("Неверный администраторский PIN");
    }
    adminFailures = 0;
    adminSessionUntil = Date.now() + ADMIN_SESSION_MS;
    return { authenticated: true, expiresAt: adminSessionUntil };
  });
  ipcMain.handle("viewer:admin-logout", () => {
    adminSessionUntil = 0;
    return { authenticated: false };
  });
  ipcMain.handle("viewer:pick-package", async () => {
    const status = storage.status();
    if (status.initialized) requireAdmin();
    const selected = await dialog.showOpenDialog(mainWindow, {
      title: "Выберите ZIP с отчётами",
      properties: ["openFile"],
      filters: [{ name: "ZIP-пакет Пульс клиники", extensions: ["zip"] }],
    });
    if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
    return { canceled: false, preview: await storage.inspectPackageFile(selected.filePaths[0]) };
  });
  ipcMain.handle("viewer:preview-package-path", async (_event, filePath) => {
    const status = storage.status();
    if (status.initialized) requireAdmin();
    const resolved = path.resolve(String(filePath || ""));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error("ZIP-файл не найден");
    return storage.inspectPackageFile(resolved);
  });
  ipcMain.handle("viewer:import-package", async (_event, payload) => {
    const input = payload && typeof payload === "object" ? payload : {};
    const status = storage.status();
    if (status.initialized) requireAdmin();
    const result = await storage.importPackageFile(input.path, {
      doctorIds: input.doctorIds,
      periods: input.periods,
      bootstrapPin: status.initialized ? null : input.adminPin,
    });
    if (!status.initialized) adminSessionUntil = Date.now() + ADMIN_SESSION_MS;
    doctorSession = null;
    return { result, status: storage.status() };
  });
  ipcMain.handle("viewer:doctor-login", (_event, payload) => {
    const input = payload && typeof payload === "object" ? payload : {};
    doctorSession = storage.doctorLogin({ doctorId: input.doctorId, pin: input.pin });
    return {
      doctor: doctorSession.doctor,
      periods: (doctorSession.index.publications || []).map(item => ({
        periodKey: item.periodKey,
        pageTypes: Object.keys(item.pages || {}),
        updatedAt: item.updatedAt,
      })),
    };
  });
  ipcMain.handle("viewer:doctor-logout", () => {
    doctorSession = null;
    return true;
  });
  ipcMain.handle("viewer:report", (_event, payload) => {
    if (!doctorSession) throw new Error("Сначала выберите врача и введите PIN");
    const input = payload && typeof payload === "object" ? payload : {};
    if (!/^\d{4}-\d{2}$/.test(String(input.periodKey)) || !/^(doctor|specialization|department)$/.test(String(input.pageType))) {
      throw new Error("Некорректный запрос отчёта");
    }
    return storage.readReport(doctorSession, input);
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(() => {
    storage = new ViewerStorageService({ configPath: path.join(app.getPath("userData"), "viewer-config.json") });
    registerIpc();
    createWindow();
  }).catch(error => {
    dialog.showErrorBox("Не удалось запустить Viewer", error.stack || error.message);
    app.exit(1);
  });
}

app.on("window-all-closed", () => app.quit());
