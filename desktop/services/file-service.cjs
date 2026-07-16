"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const INPUT_EXTENSIONS = new Set([".xls", ".xlsx", ".zip"]);
const EXPORT_EXTENSIONS = new Set([".pdf", ".xlsx", ".txt", ".json"]);

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function isPathInside(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeFileName(value) {
  const name = path.basename(String(value || "файл"))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 180);
  return name || "файл";
}

function monthFolder(month) {
  const value = String(month || "без-месяца");
  return /^\d{4}-\d{2}$/.test(value) ? value : "без-месяца";
}

class FileService {
  constructor({ configStore, database, logger = () => {} }) {
    this.configStore = configStore;
    this.database = database;
    this.logger = logger;
    this.allowedInputPaths = new Set();
    this.batches = new Map();
  }

  #descriptor(filePath) {
    const fullPath = path.resolve(filePath);
    const stat = fs.statSync(fullPath);
    const sha256 = sha256File(fullPath);
    this.allowedInputPaths.add(fullPath.toLocaleLowerCase("ru-RU"));
    return {
      path: fullPath,
      name: path.basename(fullPath),
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      sha256,
      imported: this.database.hasSuccessfulSource(sha256),
    };
  }

  describeSelected(paths) {
    return paths
      .map(filePath => path.resolve(filePath))
      .filter(filePath => {
        try {
          return fs.statSync(filePath).isFile() && INPUT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
        } catch (_) {
          return false;
        }
      })
      .map(filePath => this.#descriptor(filePath));
  }

  scanInputFolder() {
    const root = this.configStore.publicConfig().inputDir;
    const found = [];
    const walk = directory => {
      const entries = fs.readdirSync(directory, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(fullPath);
        else if (entry.isFile() && INPUT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) found.push(fullPath);
      }
    };
    walk(root);
    return found.sort((a, b) => a.localeCompare(b, "ru-RU")).map(filePath => this.#descriptor(filePath));
  }

  readInputFile(filePath) {
    const fullPath = path.resolve(filePath);
    const config = this.configStore.publicConfig();
    const allowed = this.allowedInputPaths.has(fullPath.toLocaleLowerCase("ru-RU")) || isPathInside(fullPath, config.inputDir);
    if (!allowed) throw new Error("Файл не был выбран пользователем и находится вне входной папки");
    if (!INPUT_EXTENSIONS.has(path.extname(fullPath).toLowerCase())) throw new Error("Неподдерживаемый тип входного файла");
    return fs.readFileSync(fullPath);
  }

  beginExportBatch({ month, kind = "pdf", requestedFiles = 0 }) {
    const config = this.configStore.publicConfig();
    const token = crypto.randomUUID();
    const targetDir = path.join(config.outputDir, monthFolder(month));
    const tempDir = path.join(config.outputDir, `.tmp-${token}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const exportRunId = this.database.beginExportRun({ month, kind, outputDir: targetDir, requestedFiles });
    this.batches.set(token, {
      token,
      month,
      kind,
      targetDir,
      tempDir,
      exportRunId,
      files: [],
      startedAt: new Date(),
    });
    return { token, outputDir: targetDir };
  }

  writeExportFile({ token, fileName, bytes }) {
    const batch = this.batches.get(String(token));
    if (!batch) throw new Error("Пакет выгрузки не найден или уже завершён");
    const safeName = safeFileName(fileName);
    if (!EXPORT_EXTENSIONS.has(path.extname(safeName).toLowerCase())) throw new Error("Недопустимое расширение результата");
    const target = path.join(batch.tempDir, safeName);
    if (!isPathInside(target, batch.tempDir)) throw new Error("Некорректное имя результата");
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (buffer.length > 500 * 1024 * 1024) throw new Error("Файл результата превышает 500 МБ");
    if (batch.files.some(file => file.name.toLocaleLowerCase("ru-RU") === safeName.toLocaleLowerCase("ru-RU"))) {
      throw new Error(`Файл «${safeName}» уже добавлен в этот пакет`);
    }
    const temp = `${target}.part`;
    fs.writeFileSync(temp, buffer);
    fs.renameSync(temp, target);
    batch.files.push({ name: safeName, bytes: buffer.length });
    return { name: safeName, bytes: buffer.length };
  }

  finishExportBatch({ token, failures = [] }) {
    const batch = this.batches.get(String(token));
    if (!batch) throw new Error("Пакет выгрузки не найден или уже завершён");
    failures = Array.isArray(failures) ? failures.slice(0, 100).map(value => String(value).replace(/[\r\n]+/g, " ").slice(0, 1000)) : [];
    fs.mkdirSync(batch.targetDir, { recursive: true });
    const archiveDir = path.join(batch.targetDir, "Предыдущие версии", batch.startedAt.toISOString().replace(/[:.]/g, "-"));
    let archived = 0;
    const archivedFiles = [];
    const publishedFiles = [];
    try {
      const currentExtension = batch.kind === "pdf" ? ".pdf" : batch.kind === "excel" ? ".xlsx" : null;
      if (currentExtension) {
        const currentFiles = fs.readdirSync(batch.targetDir, { withFileTypes: true })
          .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === currentExtension);
        if (currentFiles.length) fs.mkdirSync(archiveDir, { recursive: true });
        for (const entry of currentFiles) {
          const source = path.join(batch.targetDir, entry.name);
          const destination = path.join(archiveDir, entry.name);
          fs.renameSync(source, destination);
          archivedFiles.push({ source, destination });
          archived++;
        }
      }
      for (const file of batch.files) {
        const source = path.join(batch.tempDir, file.name);
        const destination = path.join(batch.targetDir, file.name);
        if (fs.existsSync(destination)) {
          fs.mkdirSync(archiveDir, { recursive: true });
          const archivedDestination = path.join(archiveDir, file.name);
          fs.renameSync(destination, archivedDestination);
          archivedFiles.push({ source: destination, destination: archivedDestination });
          archived++;
        }
        fs.renameSync(source, destination);
        publishedFiles.push(destination);
      }
      const protocol = [
        "Оценка врачей — протокол выгрузки",
        `Дата: ${new Date().toLocaleString("ru-RU")}`,
        `Месяц: ${batch.month || "не указан"}`,
        `Тип: ${batch.kind}`,
        `Создано файлов: ${batch.files.length}`,
        `Ошибок: ${failures.length}`,
        `Предыдущих файлов перемещено в архив: ${archived}`,
        "",
        "Созданные файлы:",
        ...batch.files.map(file => `- ${file.name} (${file.bytes} байт)`),
        ...(failures.length ? ["", "Ошибки:", ...failures.map(value => `- ${value}`)] : []),
        "",
      ].join("\r\n");
      fs.writeFileSync(path.join(batch.targetDir, "Протокол выгрузки.txt"), protocol, "utf8");
      this.database.finishExportRun(batch.exportRunId, {
        writtenFiles: batch.files.length,
        failedFiles: failures.length,
        details: { files: batch.files, failures, archived },
      });
      this.logger("export-finished", { targetDir: batch.targetDir, files: batch.files.length, failures: failures.length });
      return { outputDir: batch.targetDir, written: batch.files.length, failed: failures.length, archived };
    } catch (error) {
      for (const published of publishedFiles.reverse()) {
        try { fs.rmSync(published, { force: true }); } catch (_) { /* continue rollback */ }
      }
      for (const archivedFile of archivedFiles.reverse()) {
        try {
          if (fs.existsSync(archivedFile.destination) && !fs.existsSync(archivedFile.source)) {
            fs.renameSync(archivedFile.destination, archivedFile.source);
          }
        } catch (_) { /* original error is more useful */ }
      }
      try { this.database.failExportRun(batch.exportRunId, error); } catch (_) { /* original error is more useful */ }
      throw error;
    } finally {
      this.batches.delete(String(token));
      fs.rmSync(batch.tempDir, { recursive: true, force: true });
    }
  }

  abortExportBatch(token) {
    const batch = this.batches.get(String(token));
    if (!batch) return;
    this.batches.delete(String(token));
    try { this.database.abortExportRun(batch.exportRunId); } catch (_) { /* cleanup must continue */ }
    fs.rmSync(batch.tempDir, { recursive: true, force: true });
  }

  writeJsonExport(destination, json) {
    const target = path.resolve(destination);
    const temp = `${target}.part`;
    fs.writeFileSync(temp, String(json), "utf8");
    fs.renameSync(temp, target);
    return target;
  }
}

module.exports = { FileService, INPUT_EXTENSIONS, safeFileName, isPathInside, sha256File };
