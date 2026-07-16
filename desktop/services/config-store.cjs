"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CONFIG_VERSION = 1;
const FOLDER_NAMES = Object.freeze({
  input: "Входящие",
  database: "База",
  output: "Результаты",
  backup: "Резервные копии",
  logs: "Журналы",
});

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function isUnsupportedStoragePath(targetPath) {
  if (typeof targetPath !== "string" || !targetPath.trim()) return false;
  return path.resolve(targetPath).split(/[\\/]+/).some(part => /^onedrive(?:\s|\s*-|$)/i.test(part));
}

function assertSupportedStoragePath(targetPath) {
  if (isUnsupportedStoragePath(targetPath)) {
    throw new Error("Папки OneDrive нельзя использовать для рабочих данных: файловая система блокирует приложение. Выберите локальную папку вне OneDrive.");
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      const broken = `${filePath}.broken-${Date.now()}`;
      try { fs.copyFileSync(filePath, broken); } catch (_) { /* best effort */ }
    }
    return null;
  }
}

class ConfigStore {
  constructor({ userDataDir, documentsDir }) {
    this.userDataDir = ensureDirectory(userDataDir);
    this.documentsDir = documentsDir;
    this.configPath = path.join(this.userDataDir, "config.json");
    this.config = this.#load();
    this.ensureFolders();
  }

  #defaultRoot() {
    return path.join(this.documentsDir, "Пульс клиники");
  }

  #defaults(root = this.#defaultRoot()) {
    return {
      version: CONFIG_VERSION,
      configured: false,
      workspaceRoot: root,
      inputDir: path.join(root, FOLDER_NAMES.input),
      databaseDir: path.join(root, FOLDER_NAMES.database),
      outputDir: path.join(root, FOLDER_NAMES.output),
      backupDir: path.join(root, FOLDER_NAMES.backup),
      logsDir: path.join(root, FOLDER_NAMES.logs),
      updateUrl: "",
      updatedAt: new Date().toISOString(),
    };
  }

  #load() {
    const stored = readJson(this.configPath);
    const storageKeys = ["workspaceRoot", "inputDir", "databaseDir", "outputDir", "backupDir", "logsDir"];
    const containsUnsupportedPath = stored && storageKeys.some(key => isUnsupportedStoragePath(stored[key]));
    if (containsUnsupportedPath) {
      return Object.assign(this.#defaults(), {
        updateUrl: typeof stored.updateUrl === "string" ? stored.updateUrl : "",
      });
    }
    const root = stored && typeof stored.workspaceRoot === "string"
      ? path.resolve(stored.workspaceRoot)
      : this.#defaultRoot();
    return Object.assign(this.#defaults(root), stored || {}, {
      version: CONFIG_VERSION,
      workspaceRoot: root,
    });
  }

  ensureFolders() {
    for (const key of ["workspaceRoot", "inputDir", "databaseDir", "outputDir", "backupDir", "logsDir"]) {
      ensureDirectory(this.config[key]);
    }
    this.save();
    return this.publicConfig();
  }

  save() {
    this.config.updatedAt = new Date().toISOString();
    const temp = `${this.configPath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.config, null, 2), "utf8");
    fs.renameSync(temp, this.configPath);
  }

  publicConfig() {
    return Object.assign({}, this.config, {
      databasePath: this.databasePath(),
      configPath: this.configPath,
    });
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.config));
  }

  restore(snapshot) {
    if (!snapshot || typeof snapshot.workspaceRoot !== "string") throw new Error("Некорректная копия настроек");
    for (const key of ["workspaceRoot", "inputDir", "databaseDir", "outputDir", "backupDir", "logsDir"]) {
      assertSupportedStoragePath(snapshot[key]);
    }
    const root = path.resolve(snapshot.workspaceRoot);
    this.config = Object.assign(this.#defaults(root), snapshot, {
      version: CONFIG_VERSION,
      workspaceRoot: root,
    });
    this.ensureFolders();
    return this.publicConfig();
  }

  databasePath() {
    return path.join(this.config.databaseDir, "оценка-врачей.sqlite");
  }

  markConfigured() {
    this.config.configured = true;
    this.save();
    return this.publicConfig();
  }

  setWorkspaceRoot(rootPath) {
    assertSupportedStoragePath(rootPath);
    const root = path.resolve(rootPath);
    const preservedUpdateUrl = this.config.updateUrl || "";
    this.config = Object.assign(this.#defaults(root), {
      configured: true,
      updateUrl: preservedUpdateUrl,
    });
    this.ensureFolders();
    return this.publicConfig();
  }

  setFolder(kind, folderPath) {
    const keyMap = {
      input: "inputDir",
      output: "outputDir",
      backup: "backupDir",
    };
    const key = keyMap[kind];
    if (!key) throw new Error("Неизвестный тип папки");
    assertSupportedStoragePath(folderPath);
    this.config[key] = path.resolve(folderPath);
    this.config.configured = true;
    ensureDirectory(this.config[key]);
    this.save();
    return this.publicConfig();
  }

}

module.exports = { ConfigStore, FOLDER_NAMES, ensureDirectory, isUnsupportedStoragePath };
