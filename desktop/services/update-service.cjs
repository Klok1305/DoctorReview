"use strict";

const fs = require("node:fs");
const path = require("node:path");

class UpdateService {
  constructor({ app, backupService, configStore, resourcesPath, logger = () => {} }) {
    this.app = app;
    this.backupService = backupService;
    this.configStore = configStore;
    this.resourcesPath = resourcesPath;
    this.logger = logger;
    this.listeners = new Set();
    this.status = {
      state: "idle",
      message: "Обновления ещё не проверялись",
      version: app.getVersion(),
      configured: false,
    };
    this.autoUpdater = null;
    this.#configure();
  }

  #loadUrl() {
    if (process.env.DOCTOR_APP_UPDATE_URL) return process.env.DOCTOR_APP_UPDATE_URL.trim();
    const configured = this.configStore.publicConfig().updateUrl;
    if (configured) return configured;
    const candidates = [
      path.join(this.resourcesPath, "update-config.json"),
      path.join(this.resourcesPath, "resources", "update-config.json"),
      path.join(__dirname, "..", "..", "resources", "update-config.json"),
    ];
    for (const filePath of candidates) {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (parsed && parsed.url) return String(parsed.url).trim();
      } catch (_) { /* optional configuration */ }
    }
    return "";
  }

  #configure() {
    const url = this.#loadUrl();
    this.status.configured = Boolean(url);
    if (!this.app.isPackaged) {
      this.status.message = "В режиме разработки автообновление отключено";
      return;
    }
    if (!url) {
      this.status.message = "Сервер автообновлений не настроен; доступна установка из файла";
      return;
    }
    const { autoUpdater } = require("electron-updater");
    this.autoUpdater = autoUpdater;
    // У electron-updater по умолчанию консольный логгер. У Windows GUI stdout
    // может быть уже закрыт, и попытка записи тогда завершает процесс с EPIPE.
    const writeUpdateLog = (level, values) => this.logger(`update-${level}`, {
      message: values.map(value => value instanceof Error ? value.message : String(value)).join(" "),
    });
    autoUpdater.logger = {
      info: (...values) => writeUpdateLog("info", values),
      warn: (...values) => writeUpdateLog("warn", values),
      error: (...values) => writeUpdateLog("error", values),
      debug: (...values) => writeUpdateLog("debug", values),
    };
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.setFeedURL({ provider: "generic", url });
    autoUpdater.on("checking-for-update", () => this.#set("checking", "Проверяю обновления…"));
    autoUpdater.on("update-available", info => this.#set("downloading", `Загружается версия ${info.version}…`, info.version));
    autoUpdater.on("update-not-available", () => this.#set("current", "Установлена актуальная версия"));
    autoUpdater.on("download-progress", progress => this.#set("downloading", `Загружено ${Math.round(progress.percent || 0)}%`));
    autoUpdater.on("update-downloaded", info => this.#set("downloaded", `Версия ${info.version} готова к установке`, info.version));
    autoUpdater.on("error", error => {
      this.logger("update-error", { message: error.message });
      this.#set("error", `Ошибка обновления: ${error.message}`);
    });
    setTimeout(() => this.check().catch(() => {}), 15000).unref();
  }

  #set(state, message, availableVersion = null) {
    this.status = Object.assign({}, this.status, { state, message, availableVersion, checkedAt: new Date().toISOString() });
    for (const listener of this.listeners) listener(this.getStatus());
  }

  onStatus(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStatus() {
    return Object.assign({}, this.status);
  }

  async check() {
    if (!this.autoUpdater) {
      this.#set("unconfigured", this.status.message);
      return this.getStatus();
    }
    await this.autoUpdater.checkForUpdates();
    return this.getStatus();
  }

  async installDownloaded() {
    if (!this.autoUpdater || this.status.state !== "downloaded") throw new Error("Загруженное обновление отсутствует");
    await this.backupService.createAutomatic("перед-обновлением");
    this.autoUpdater.quitAndInstall(false, true);
  }
}

module.exports = { UpdateService };
