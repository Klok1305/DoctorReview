"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseService } = require("./database.cjs");

function pad(value) { return String(value).padStart(2, "0"); }

function timestamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function safeReason(reason) {
  return String(reason || "автоматическая")
    .replace(/[^а-яёa-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "автоматическая";
}

function isSqliteSidecar(filePath) {
  return /(?:^|[._-])(shm|wal)$/i.test(path.basename(String(filePath || "")));
}

function assertRestorableDatabase(filePath) {
  if (isSqliteSidecar(filePath)) {
    throw new Error("Выбран служебный файл SQLite (SHM/WAL). Он не содержит полную базу и не восстанавливается отдельно. Выберите основной файл .sqlite, .db или .ovbackup; если копию прислали комплектом, положите рядом также WAL/SHM и выбирайте основной файл.");
  }
}

class BackupService {
  constructor({ database, configStore, logger = () => {} }) {
    this.database = database;
    this.configStore = configStore;
    this.logger = logger;
  }

  async createAutomatic(reason = "автоматическая") {
    const directory = this.configStore.publicConfig().backupDir;
    fs.mkdirSync(directory, { recursive: true });
    const destination = path.join(directory, `оценка-врачей_${timestamp()}_${safeReason(reason)}.sqlite`);
    const preview = await this.database.backupTo(destination);
    this.logger("backup-created", { destination, reason, preview });
    this.prune();
    return { path: destination, preview };
  }

  async createPortable(destination) {
    const target = path.resolve(destination);
    const preview = await this.database.backupTo(target);
    this.logger("portable-backup-created", { target, preview });
    return { path: target, preview };
  }

  preview(sourcePath) {
    assertRestorableDatabase(sourcePath);
    return Object.assign({ path: path.resolve(sourcePath) }, DatabaseService.inspect(sourcePath));
  }

  async restore(sourcePath) {
    assertRestorableDatabase(sourcePath);
    const source = path.resolve(sourcePath);
    const preview = DatabaseService.inspect(source);
    if (!preview.ok) throw new Error(`Резервная копия повреждена: ${preview.error || preview.integrity}`);

    const safety = await this.createAutomatic("перед-восстановлением");
    const target = this.database.databasePath;
    const temp = `${target}.restore-${Date.now()}`;
    fs.copyFileSync(source, temp);
    const copiedPreview = DatabaseService.inspect(temp);
    if (!copiedPreview.ok) {
      fs.rmSync(temp, { force: true });
      throw new Error("Проверка скопированной базы не пройдена");
    }

    this.database.close();
    try {
      for (const suffix of ["", "-wal", "-shm"]) {
        fs.rmSync(`${target}${suffix}`, { force: true });
      }
      fs.renameSync(temp, target);
      this.database.open(target);
    } catch (error) {
      try {
        if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
        fs.copyFileSync(safety.path, target);
        this.database.open(target);
      } catch (_) { /* original error is more useful */ }
      throw error;
    }
    this.logger("backup-restored", { source, safety: safety.path, preview });
    return { source, safetyBackup: safety.path, preview: this.database.summary() };
  }

  prune() {
    const directory = this.configStore.publicConfig().backupDir;
    let files = [];
    try {
      files = fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && /^оценка-врачей_.*\.sqlite$/i.test(entry.name))
        .map(entry => {
          const fullPath = path.join(directory, entry.name);
          const stat = fs.statSync(fullPath);
          return { path: fullPath, mtime: stat.mtime, time: stat.mtimeMs };
        })
        .sort((a, b) => b.time - a.time);
    } catch (_) {
      return;
    }

    const keep = new Set();
    const daily = new Set();
    const monthly = new Set();
    for (const file of files) {
      const day = `${file.mtime.getFullYear()}-${pad(file.mtime.getMonth() + 1)}-${pad(file.mtime.getDate())}`;
      const month = day.slice(0, 7);
      if (daily.size < 30 && !daily.has(day)) {
        daily.add(day);
        keep.add(file.path);
      }
      if (monthly.size < 12 && !monthly.has(month)) {
        monthly.add(month);
        keep.add(file.path);
      }
    }
    for (const file of files) {
      if (!keep.has(file.path)) {
        try { fs.rmSync(file.path, { force: true }); } catch (_) { /* keep if locked */ }
      }
    }
  }
}

module.exports = { BackupService, timestamp, isSqliteSidecar };
