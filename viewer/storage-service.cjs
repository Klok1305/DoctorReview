"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { inspectViewerPackage } = require("../desktop/services/viewer-package-service.cjs");

function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch (_) { return fallback; }
}

function safeSegment(value, label = "часть пути") {
  const result = String(value || "");
  if (!/^[a-zA-Z0-9._-]{1,160}$/.test(result) || result === "." || result === "..") throw new Error(`Некорректная ${label}`);
  return result;
}

function verifyPin(pin, access) {
  try {
    const params = typeof access.pinParams === "string" ? JSON.parse(access.pinParams) : access.pinParams;
    const salt = Buffer.from(access.pinSalt, "base64");
    const expected = Buffer.from(access.pinHash, "base64");
    const actual = crypto.scryptSync(String(pin || ""), salt, params.keylen, {
      N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024,
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch (_) {
    return false;
  }
}

function atomicWriteJson(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const suffix = `${process.pid}-${crypto.randomUUID()}`;
  const temporary = `${filePath}.tmp-${suffix}`;
  const previous = `${filePath}.previous-${suffix}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  try {
    if (fs.existsSync(filePath)) fs.renameSync(filePath, previous);
    fs.renameSync(temporary, filePath);
    if (fs.existsSync(previous)) fs.rmSync(previous, { force: true });
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    if (fs.existsSync(previous) && !fs.existsSync(filePath)) fs.renameSync(previous, filePath);
    throw error;
  }
}

function normalizeWindowsAccount(value) {
  return String(value || "").trim().replace(/\//g, "\\").toLocaleLowerCase("ru-RU");
}

function windowsIdentity() {
  const username = os.userInfo().username;
  const domain = String(process.env.USERDOMAIN || "").trim();
  return {
    username,
    domain,
    qualified: domain ? `${domain}\\${username}` : username,
  };
}

function accountMatches(expected) {
  const wanted = normalizeWindowsAccount(expected);
  if (!wanted) return true;
  const identity = windowsIdentity();
  const candidates = new Set([
    normalizeWindowsAccount(identity.username),
    normalizeWindowsAccount(identity.qualified),
    normalizeWindowsAccount(process.env.USERNAME || ""),
  ]);
  return candidates.has(wanted);
}

class ViewerStorageService {
  constructor({ configPath }) {
    this.configPath = configPath;
    this.root = null;
    this.loadConfig();
  }

  loadConfig() {
    const config = readJson(this.configPath, {});
    this.root = config && config.storageRoot ? path.resolve(config.storageRoot) : null;
    return this.root;
  }

  setStorageRoot(storageRoot) {
    const root = path.resolve(String(storageRoot || ""));
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error("Выбранная папка недоступна");
    fs.accessSync(root, fs.constants.R_OK);
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    atomicWriteJson(this.configPath, { storageRoot: root });
    this.root = root;
    return this.status();
  }

  requireRoot() {
    if (!this.root) throw new Error("Сначала выберите общую папку отчётов");
    if (!fs.existsSync(this.root)) throw new Error("Общая папка отчётов сейчас недоступна");
    return this.root;
  }

  adminPath() { return path.join(this.requireRoot(), "_viewer", "admin.json"); }
  catalogPath() { return path.join(this.requireRoot(), "catalog.json"); }

  status() {
    let online = false;
    let catalog = { doctors: [], updatedAt: null };
    let initialized = false;
    if (this.root) {
      try {
        online = fs.existsSync(this.root) && fs.statSync(this.root).isDirectory();
        if (online) {
          catalog = readJson(path.join(this.root, "catalog.json"), catalog);
          initialized = fs.existsSync(path.join(this.root, "_viewer", "admin.json"));
        }
      } catch (_) { online = false; }
    }
    return {
      configured: Boolean(this.root),
      storageRoot: this.root,
      online,
      initialized,
      catalog: {
        doctors: Array.isArray(catalog.doctors) ? catalog.doctors : [],
        updatedAt: catalog.updatedAt || null,
      },
      windowsIdentity: windowsIdentity(),
    };
  }

  readAdminAccess() {
    const record = readJson(this.adminPath(), null);
    if (!record) throw new Error("Viewer ещё не инициализирован публикацией");
    return record;
  }

  verifyAdminPin(pin) {
    return verifyPin(pin, this.readAdminAccess());
  }

  async inspectPackageFile(filePath) {
    const buffer = fs.readFileSync(filePath);
    const { preview } = await inspectViewerPackage(buffer);
    return { ...preview, path: filePath };
  }

  async importPackageFile(filePath, { doctorIds, periods, bootstrapPin = null } = {}) {
    const root = this.requireRoot();
    fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
    const buffer = fs.readFileSync(filePath);
    const { manifest, preview, zip } = await inspectViewerPackage(buffer, { includeZip: true });
    const currentAdmin = readJson(path.join(root, "_viewer", "admin.json"), null);
    if (!currentAdmin) {
      if (!verifyPin(bootstrapPin, manifest.adminAccess || {})) throw new Error("Неверный администраторский PIN из программы администратора");
    } else {
      const incomingVersion = Number(manifest.adminAccess && manifest.adminAccess.pinVersion);
      const currentVersion = Number(currentAdmin.pinVersion);
      if (incomingVersion < currentVersion) throw new Error("Архив содержит устаревший администраторский PIN");
      if (incomingVersion === currentVersion
        && (manifest.adminAccess.pinHash !== currentAdmin.pinHash || manifest.adminAccess.pinSalt !== currentAdmin.pinSalt)) {
        throw new Error("Архив содержит другой администраторский PIN с той же версией");
      }
    }

    const selectedDoctors = new Set((doctorIds && doctorIds.length ? doctorIds : preview.doctors.map(item => item.doctorId)).map(String));
    const selectedPeriods = new Set((periods && periods.length ? periods : preview.periods).map(String));
    const allowedDoctors = new Set(preview.doctors.map(item => item.doctorId));
    const allowedPeriods = new Set(preview.periods);
    if ([...selectedDoctors].some(id => !allowedDoctors.has(id)) || [...selectedPeriods].some(value => !allowedPeriods.has(value))) {
      throw new Error("Выбранные данные отсутствуют в ZIP");
    }
    if (!selectedDoctors.size || !selectedPeriods.size) throw new Error("Не выбраны врачи или периоды для импорта");

    const previousCatalog = readJson(path.join(root, "catalog.json"), { doctors: [] });
    const catalogMap = new Map((previousCatalog.doctors || []).map(item => [String(item.doctorId), item]));
    const staged = [];
    for (const doctor of preview.doctors.filter(item => selectedDoctors.has(item.doctorId))) {
      const folderId = safeSegment(doctor.folderId, "папка врача");
      const doctorRoot = path.join(root, "doctors", folderId);
      const profileEntry = zip.file(`doctors/${folderId}/profile.json`);
      const accessEntry = zip.file(`doctors/${folderId}/access.json`);
      if (!profileEntry || !accessEntry) throw new Error(`В ZIP неполные данные врача ${doctor.displayName}`);
      const profile = JSON.parse(await profileEntry.async("string"));
      const incomingAccess = JSON.parse(await accessEntry.async("string"));
      const currentAccess = readJson(path.join(doctorRoot, "access.json"), null);
      if (currentAccess) {
        if (Number(incomingAccess.pinVersion) < Number(currentAccess.pinVersion)) throw new Error(`В ZIP устаревший PIN врача ${doctor.displayName}`);
        if (Number(incomingAccess.pinVersion) === Number(currentAccess.pinVersion)
          && (incomingAccess.pinHash !== currentAccess.pinHash || incomingAccess.pinSalt !== currentAccess.pinSalt)) {
          throw new Error(`PIN врача ${doctor.displayName} конфликтует с уже импортированным`);
        }
      }

      const releaseId = safeSegment(`${manifest.packageId}-${Date.now()}-${folderId.slice(0, 6)}`, "версия публикации");
      const releaseRoot = path.join(doctorRoot, "releases", releaseId);
      const stagingRoot = `${releaseRoot}.staging-${crypto.randomUUID()}`;
      fs.mkdirSync(stagingRoot, { recursive: true });
      const importedPages = [];
      try {
        for (const periodKey of selectedPeriods) {
          for (const pageType of ["department", "specialization", "doctor"]) {
            const archivePath = `doctors/${folderId}/reports/${periodKey}/${pageType}.json`;
            const entry = zip.file(archivePath);
            if (!entry) continue;
            const report = JSON.parse(await entry.async("string"));
            const relativePath = path.join("reports", periodKey, `${pageType}.json`);
            const targetPath = path.join(stagingRoot, relativePath);
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(targetPath, JSON.stringify(report), "utf8");
            importedPages.push({ periodKey, pageType, title: report.title, relativePath: relativePath.replace(/\\/g, "/") });
          }
        }
        if (!importedPages.length) throw new Error(`Для врача ${doctor.displayName} нет выбранных страниц`);
        fs.mkdirSync(path.dirname(releaseRoot), { recursive: true });
        fs.renameSync(stagingRoot, releaseRoot);
      } catch (error) {
        if (fs.existsSync(stagingRoot)) fs.rmSync(stagingRoot, { recursive: true, force: true });
        throw error;
      }
      staged.push({ doctor, doctorRoot, profile, incomingAccess, releaseId, importedPages });
    }

    for (const item of staged) {
      fs.mkdirSync(item.doctorRoot, { recursive: true });
      const previousIndex = readJson(path.join(item.doctorRoot, "index.json"), { publications: [] });
      const periodsMap = new Map((previousIndex.publications || []).map(publication => [publication.periodKey, publication]));
      for (const page of item.importedPages) {
        const publication = periodsMap.get(page.periodKey) || { periodKey: page.periodKey, pages: {}, updatedAt: null };
        publication.pages[page.pageType] = {
          releaseId: item.releaseId,
          relativePath: page.relativePath,
          title: page.title,
          packageId: manifest.packageId,
          createdAt: manifest.createdAt,
        };
        publication.updatedAt = new Date().toISOString();
        periodsMap.set(page.periodKey, publication);
      }
      atomicWriteJson(path.join(item.doctorRoot, "profile.json"), item.profile);
      atomicWriteJson(path.join(item.doctorRoot, "access.json"), item.incomingAccess);
      atomicWriteJson(path.join(item.doctorRoot, "index.json"), {
        doctorId: item.doctor.doctorId,
        publications: [...periodsMap.values()].sort((a, b) => b.periodKey.localeCompare(a.periodKey)),
        updatedAt: new Date().toISOString(),
      });
      catalogMap.set(item.doctor.doctorId, {
        doctorId: item.doctor.doctorId,
        folderId: item.doctor.folderId,
        displayName: item.doctor.displayName,
        department: item.doctor.department,
        specialization: item.doctor.specialization,
        windowsAccount: item.doctor.windowsAccount,
      });
    }

    const now = new Date().toISOString();
    atomicWriteJson(path.join(root, "_viewer", "admin.json"), manifest.adminAccess);
    atomicWriteJson(path.join(root, "catalog.json"), {
      format: "pulse-clinic-viewer-catalog",
      updatedAt: now,
      doctors: [...catalogMap.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, "ru")),
    });
    const aclRows = ["folder;doctor;windows_account"];
    for (const doctor of catalogMap.values()) {
      const cell = value => `"${String(value || "").replace(/"/g, '""')}"`;
      aclRows.push([doctor.folderId, doctor.displayName, doctor.windowsAccount].map(cell).join(";"));
    }
    fs.mkdirSync(path.join(root, "_viewer"), { recursive: true });
    fs.writeFileSync(path.join(root, "_viewer", "acl-mapping.csv"), `\uFEFF${aclRows.join("\r\n")}\r\n`, "utf8");
    return { packageId: manifest.packageId, doctors: staged.length, periods: selectedPeriods.size, sha256: preview.sha256, importedAt: now };
  }

  doctorLogin({ doctorId, pin, allowWindowsMismatch = false }) {
    const status = this.status();
    const doctor = status.catalog.doctors.find(item => String(item.doctorId) === String(doctorId));
    if (!doctor) throw new Error("Врач не найден в опубликованном каталоге");
    if (!allowWindowsMismatch && doctor.windowsAccount && !accountMatches(doctor.windowsAccount)) {
      throw new Error(`Отчёт доступен только Windows-пользователю ${doctor.windowsAccount}`);
    }
    const folderId = safeSegment(doctor.folderId, "папка врача");
    const doctorRoot = path.join(this.requireRoot(), "doctors", folderId);
    const access = readJson(path.join(doctorRoot, "access.json"), null);
    if (!access || !verifyPin(pin, access)) throw new Error("Неверный PIN врача");
    const index = readJson(path.join(doctorRoot, "index.json"), { publications: [] });
    return { doctor, doctorRoot, index };
  }

  readReport(session, { periodKey, pageType }) {
    if (!session || !session.doctorRoot || !session.index) throw new Error("Сессия врача не открыта");
    const publication = (session.index.publications || []).find(item => item.periodKey === String(periodKey));
    const page = publication && publication.pages ? publication.pages[String(pageType)] : null;
    if (!page) return null;
    const releaseId = safeSegment(page.releaseId, "версия отчёта");
    const relative = String(page.relativePath || "").replace(/\//g, path.sep);
    const reportPath = path.resolve(session.doctorRoot, "releases", releaseId, relative);
    const releaseRoot = path.resolve(session.doctorRoot, "releases", releaseId) + path.sep;
    if (!reportPath.startsWith(releaseRoot)) throw new Error("Некорректный путь отчёта");
    return readJson(reportPath, null);
  }
}

module.exports = { ViewerStorageService, accountMatches, atomicWriteJson, verifyPin, windowsIdentity };
