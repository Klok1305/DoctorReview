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

function safeDirectorySegment(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw || raw === "." || raw === "..") throw new Error("Некорректная папка результата");
  let name = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 120);
  if (!name || name === "." || name === "..") throw new Error("Некорректная папка результата");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}

function normalizeExportRelativePath(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 16) throw new Error("Некорректный путь результата");
  return value.map(safeDirectorySegment);
}

function filesRecursive(root, { skipRootNames = [] } = {}) {
  if (!fs.existsSync(root)) return [];
  const skip = new Set(skipRootNames.map(name => String(name).toLocaleLowerCase("ru-RU")));
  const found = [];
  const walk = (directory, depth) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (depth === 0 && skip.has(entry.name.toLocaleLowerCase("ru-RU"))) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath, depth + 1);
      else if (entry.isFile()) found.push(fullPath);
    }
  };
  walk(root, 0);
  return found;
}

function removeEmptyExportDirectories(root) {
  if (!fs.existsSync(root)) return;
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === "Предыдущие версии") continue;
      const fullPath = path.join(directory, entry.name);
      walk(fullPath);
      if (!fs.readdirSync(fullPath).length) fs.rmdirSync(fullPath);
    }
  };
  walk(root);
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

  writeExportFile({ token, fileName, relativePath = [], bytes }) {
    const batch = this.batches.get(String(token));
    if (!batch) throw new Error("Пакет выгрузки не найден или уже завершён");
    const safeName = safeFileName(fileName);
    const safePath = normalizeExportRelativePath(relativePath);
    if (!EXPORT_EXTENSIONS.has(path.extname(safeName).toLowerCase())) throw new Error("Недопустимое расширение результата");
    const relativeName = path.join(...safePath, safeName);
    const displayName = relativeName.replace(/\\/g, "/");
    const target = path.join(batch.tempDir, relativeName);
    if (!isPathInside(target, batch.tempDir)) throw new Error("Некорректное имя результата");
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (buffer.length > 500 * 1024 * 1024) throw new Error("Файл результата превышает 500 МБ");
    if (batch.files.some(file => file.name.toLocaleLowerCase("ru-RU") === displayName.toLocaleLowerCase("ru-RU"))) {
      throw new Error(`Файл «${displayName}» уже добавлен в этот пакет`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.part`;
    fs.writeFileSync(temp, buffer);
    fs.renameSync(temp, target);
    batch.files.push({ name: displayName, relativeName, bytes: buffer.length });
    return { name: displayName, relativePath: safePath, bytes: buffer.length };
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
        const currentFiles = filesRecursive(batch.targetDir, { skipRootNames: ["Предыдущие версии"] })
          .filter(filePath => path.extname(filePath).toLowerCase() === currentExtension);
        if (currentFiles.length) fs.mkdirSync(archiveDir, { recursive: true });
        for (const source of currentFiles) {
          const relativeName = path.relative(batch.targetDir, source);
          const destination = path.join(archiveDir, relativeName);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.renameSync(source, destination);
          archivedFiles.push({ source, destination });
          archived++;
        }
      }
      for (const file of batch.files) {
        const source = path.join(batch.tempDir, file.relativeName || file.name);
        const destination = path.join(batch.targetDir, file.relativeName || file.name);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        if (fs.existsSync(destination)) {
          fs.mkdirSync(archiveDir, { recursive: true });
          const archivedDestination = path.join(archiveDir, file.relativeName || file.name);
          fs.mkdirSync(path.dirname(archivedDestination), { recursive: true });
          fs.renameSync(destination, archivedDestination);
          archivedFiles.push({ source: destination, destination: archivedDestination });
          archived++;
        }
        fs.renameSync(source, destination);
        publishedFiles.push(destination);
      }
      removeEmptyExportDirectories(batch.targetDir);
      const protocol = [
        "Пульс клиники — протокол выгрузки",
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
            fs.mkdirSync(path.dirname(archivedFile.source), { recursive: true });
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

module.exports = { FileService, INPUT_EXTENSIONS, safeFileName, safeDirectorySegment, normalizeExportRelativePath, isPathInside, sha256File };
