"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  decryptSharedPage,
  decryptViewerGrant,
  decryptViewerPage,
  inspectViewerPackage,
} = require("../desktop/services/viewer-package-service.cjs");
const DOCTOR_LOCK_MS = 15 * 60 * 1000;

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
    if (fs.existsSync(previous)) {
      try { fs.rmSync(previous, { force: true }); } catch (_) { /* новый файл уже опубликован атомарно */ }
    }
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    if (fs.existsSync(previous) && !fs.existsSync(filePath)) fs.renameSync(previous, filePath);
    throw error;
  }
}

function normalizeDoctorSubjects(index, doctor) {
  if (index && Array.isArray(index.subjects) && index.subjects.length) {
    return index.subjects.map(subject => ({
      doctorId: String(subject.doctorId),
      folderId: String(subject.folderId || ""),
      displayName: String(subject.displayName || subject.doctorId),
      department: String(subject.department || ""),
      specialization: String(subject.specialization || ""),
      publications: Array.isArray(subject.publications) ? subject.publications : [],
    }));
  }
  return [{
    doctorId: String(doctor.doctorId),
    folderId: String(doctor.folderId || ""),
    displayName: String(doctor.displayName || doctor.doctorId),
    department: String(doctor.department || ""),
    specialization: String(doctor.specialization || ""),
    publications: index && Array.isArray(index.publications) ? index.publications : [],
  }];
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

class ViewerStorageService {
  constructor({ configPath }) {
    this.configPath = configPath;
    this.root = null;
    this.doctorFailures = new Map();
    this.doctorLockedUntil = new Map();
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

  activeStateRoot(root = this.requireRoot()) {
    const pointer = readJson(path.join(root, "_viewer", "current.json"), null);
    if (pointer && pointer.format === "pulse-clinic-viewer-generation-pointer" && Number(pointer.formatVersion) === 1) {
      const generationId = safeSegment(pointer.generationId, "поколение каталога");
      const generationRoot = path.join(root, "_viewer", "generations", generationId);
      if (fs.existsSync(path.join(generationRoot, "catalog.json")) && fs.existsSync(path.join(generationRoot, "admin.json"))) {
        return generationRoot;
      }
    }
    return root;
  }

  stateAdminPath(stateRoot, root = this.requireRoot()) {
    return stateRoot === root ? path.join(root, "_viewer", "admin.json") : path.join(stateRoot, "admin.json");
  }

  adminPath() {
    const root = this.requireRoot();
    return this.stateAdminPath(this.activeStateRoot(root), root);
  }
  catalogPath() { return path.join(this.activeStateRoot(), "catalog.json"); }

  status() {
    let online = false;
    let catalog = { doctors: [], updatedAt: null };
    let initialized = false;
    if (this.root) {
      try {
        online = fs.existsSync(this.root) && fs.statSync(this.root).isDirectory();
        if (online) {
          const stateRoot = this.activeStateRoot(this.root);
          catalog = readJson(path.join(stateRoot, "catalog.json"), catalog);
          initialized = fs.existsSync(this.stateAdminPath(stateRoot, this.root));
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
    const currentStateRoot = this.activeStateRoot(root);
    const currentAdmin = readJson(this.stateAdminPath(currentStateRoot, root), null);
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

    const previousCatalog = readJson(path.join(currentStateRoot, "catalog.json"), { doctors: [] });
    const catalogMap = new Map((previousCatalog.doctors || []).map(item => [String(item.doctorId), {
      doctorId: String(item.doctorId),
      folderId: String(item.folderId || ""),
      displayName: String(item.displayName || item.doctorId),
      department: String(item.department || ""),
      specialization: String(item.specialization || ""),
      managedDepartments: Array.isArray(item.managedDepartments) ? item.managedDepartments.map(String) : [],
    }]));
    const subjectMap = new Map((preview.subjects || preview.doctors).map(item => [String(item.doctorId), item]));
    const modelPages = new Map(preview.formatVersion >= 4 && preview.reportModel
      ? preview.reportModel.pages.map(page => [String(page.pageId), page]) : []);
    const modelBindings = preview.formatVersion >= 4 && preview.reportModel && Array.isArray(preview.reportModel.bindings)
      ? preview.reportModel.bindings : [];
    const sharedPageFiles = new Map();
    const staged = [];
    for (const doctor of preview.doctors.filter(item => selectedDoctors.has(item.doctorId))) {
      const folderId = safeSegment(doctor.folderId, "папка врача");
      const doctorRoot = path.join(root, "doctors", folderId);
      const currentDoctorRoot = path.join(currentStateRoot, "doctors", folderId);
      const profileEntry = zip.file(`doctors/${folderId}/profile.json`);
      const accessEntry = zip.file(`doctors/${folderId}/access.json`);
      if (!profileEntry || !accessEntry) throw new Error(`В ZIP неполные данные врача ${doctor.displayName}`);
      const profile = JSON.parse(await profileEntry.async("string"));
      const incomingAccess = JSON.parse(await accessEntry.async("string"));
      const currentAccess = readJson(path.join(currentDoctorRoot, "access.json"), null);
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
        const visibleDoctorIds = preview.formatVersion >= 3 ? doctor.visibleDoctorIds : [doctor.doctorId];
        if (preview.formatVersion >= 4) {
          const grantEntry = zip.file(`doctors/${folderId}/grant.json`);
          if (!grantEntry) throw new Error(`В ZIP отсутствуют ключи страниц врача ${doctor.displayName}`);
          fs.writeFileSync(path.join(stagingRoot, "grant.json"), await grantEntry.async("nodebuffer"));
          const visible = new Set(visibleDoctorIds.map(String));
          for (const binding of modelBindings) {
            const subjectDoctorId = String(binding.doctorId || "");
            if (!visible.has(subjectDoctorId) || !selectedPeriods.has(String(binding.periodKey))) continue;
            const pageId = safeSegment(binding.pageId, "идентификатор страницы");
            const page = modelPages.get(pageId);
            if (!page) throw new Error(`В ZIP отсутствует описание страницы ${pageId}`);
            const pageEntry = zip.file(`pages/${pageId}.json`);
            if (!pageEntry) throw new Error(`В ZIP отсутствует общая страница ${pageId}`);
            if (!sharedPageFiles.has(pageId)) sharedPageFiles.set(pageId, await pageEntry.async("nodebuffer"));
            importedPages.push({
              doctorId: subjectDoctorId,
              periodKey: String(binding.periodKey),
              pageType: String(binding.pageType),
              title: String(page.title || "Отчёт"),
              sharedPageId: pageId,
            });
          }
        } else {
          for (const subjectDoctorId of visibleDoctorIds) {
            const subject = subjectMap.get(String(subjectDoctorId));
            if (!subject) throw new Error(`В ZIP отсутствует профиль врача ${subjectDoctorId}`);
            for (const periodKey of selectedPeriods) {
              for (const pageType of ["department", "specialization", "doctor"]) {
                const archivePath = preview.formatVersion >= 3
                  ? `doctors/${folderId}/subjects/${subject.folderId}/reports/${periodKey}/${pageType}.json`
                  : `doctors/${folderId}/reports/${periodKey}/${pageType}.json`;
                const entry = zip.file(archivePath);
                if (!entry) continue;
                const report = JSON.parse(await entry.async("string"));
                const relativePath = preview.formatVersion >= 3
                  ? path.join("subjects", subject.folderId, "reports", periodKey, `${pageType}.json`)
                  : path.join("reports", periodKey, `${pageType}.json`);
                const targetPath = path.join(stagingRoot, relativePath);
                fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                fs.writeFileSync(targetPath, JSON.stringify(report), "utf8");
                importedPages.push({ doctorId: String(subjectDoctorId), periodKey, pageType, title: report.title,
                  relativePath: relativePath.replace(/\\/g, "/") });
              }
            }
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

    for (const [pageId, bytes] of sharedPageFiles) {
      const targetPath = path.join(root, "_viewer", "pages", safeSegment(manifest.packageId, "пакет"), `${pageId}.json`);
      if (fs.existsSync(targetPath)) {
        if (!fs.readFileSync(targetPath).equals(bytes)) throw new Error(`Общая страница ${pageId} конфликтует с уже импортированной`);
        continue;
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const temporaryPath = `${targetPath}.tmp-${crypto.randomUUID()}`;
      fs.writeFileSync(temporaryPath, bytes);
      fs.renameSync(temporaryPath, targetPath);
    }

    const nextDoctorMetadata = new Map();
    for (const doctor of catalogMap.values()) {
      const folderId = safeSegment(doctor.folderId, "папка врача");
      const metadataRoot = path.join(currentStateRoot, "doctors", folderId);
      const profile = readJson(path.join(metadataRoot, "profile.json"), null);
      const access = readJson(path.join(metadataRoot, "access.json"), null);
      const index = readJson(path.join(metadataRoot, "index.json"), null);
      if (profile && access && index) nextDoctorMetadata.set(String(doctor.doctorId), { profile, access, index });
    }

    for (const item of staged) {
      const previousMetadata = nextDoctorMetadata.get(String(item.doctor.doctorId));
      const previousIndex = previousMetadata ? previousMetadata.index : { publications: [] };
      const previousSubjects = new Map(normalizeDoctorSubjects(previousIndex, item.doctor).map(subject => [subject.doctorId, subject]));
      const visibleDoctorIds = preview.formatVersion >= 3 ? item.doctor.visibleDoctorIds : [item.doctor.doctorId];
      const nextSubjects = new Map(visibleDoctorIds.map(doctorId => {
        const subject = subjectMap.get(String(doctorId)) || item.doctor;
        const previous = previousSubjects.get(String(doctorId));
        return [String(doctorId), {
          doctorId: String(doctorId),
          folderId: String(subject.folderId || ""),
          displayName: String(subject.displayName || doctorId),
          department: String(subject.department || ""),
          specialization: String(subject.specialization || ""),
          publications: previous && Array.isArray(previous.publications) ? previous.publications : [],
        }];
      }));
      for (const page of item.importedPages) {
        const subject = nextSubjects.get(page.doctorId);
        if (!subject) continue;
        const periodsMap = new Map((subject.publications || []).map(publication => [publication.periodKey, publication]));
        const publication = periodsMap.get(page.periodKey) || { periodKey: page.periodKey, pages: {}, updatedAt: null };
        publication.pages[page.pageType] = preview.formatVersion >= 4 ? {
          releaseId: item.releaseId,
          grantRelativePath: "grant.json",
          sharedPageId: page.sharedPageId,
          title: page.title,
          packageId: manifest.packageId,
          reportRevision: preview.reportRevision,
          createdAt: manifest.createdAt,
        } : {
          releaseId: item.releaseId,
          relativePath: page.relativePath,
          title: page.title,
          packageId: manifest.packageId,
          createdAt: manifest.createdAt,
        };
        publication.updatedAt = new Date().toISOString();
        periodsMap.set(page.periodKey, publication);
        subject.publications = [...periodsMap.values()].sort((a, b) => b.periodKey.localeCompare(a.periodKey));
      }
      nextDoctorMetadata.set(String(item.doctor.doctorId), {
        profile: item.profile,
        access: item.incomingAccess,
        index: {
          doctorId: item.doctor.doctorId,
          subjects: [...nextSubjects.values()],
          updatedAt: new Date().toISOString(),
        },
      });
      catalogMap.set(item.doctor.doctorId, {
        doctorId: item.doctor.doctorId,
        folderId: item.doctor.folderId,
        displayName: item.doctor.displayName,
        department: item.doctor.department,
        specialization: item.doctor.specialization,
        managedDepartments: item.doctor.managedDepartments || [],
      });
    }

    const now = new Date().toISOString();
    const generationId = safeSegment(`${manifest.packageId}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`, "поколение каталога");
    const generationRoot = path.join(root, "_viewer", "generations", generationId);
    const generationStagingRoot = `${generationRoot}.staging-${crypto.randomUUID()}`;
    const nextCatalog = {
      format: "pulse-clinic-viewer-catalog",
      updatedAt: now,
      doctors: [...catalogMap.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, "ru")),
    };
    try {
      writeJson(path.join(generationStagingRoot, "admin.json"), manifest.adminAccess);
      writeJson(path.join(generationStagingRoot, "catalog.json"), nextCatalog);
      for (const doctor of nextCatalog.doctors) {
        const metadata = nextDoctorMetadata.get(String(doctor.doctorId));
        if (!metadata) throw new Error(`Не удалось перенести метаданные врача ${doctor.displayName}`);
        const metadataRoot = path.join(generationStagingRoot, "doctors", safeSegment(doctor.folderId, "папка врача"));
        writeJson(path.join(metadataRoot, "profile.json"), metadata.profile);
        writeJson(path.join(metadataRoot, "access.json"), metadata.access);
        writeJson(path.join(metadataRoot, "index.json"), metadata.index);
      }
      fs.mkdirSync(path.dirname(generationRoot), { recursive: true });
      fs.renameSync(generationStagingRoot, generationRoot);
    } catch (error) {
      if (fs.existsSync(generationStagingRoot)) fs.rmSync(generationStagingRoot, { recursive: true, force: true });
      throw error;
    }
    atomicWriteJson(path.join(root, "_viewer", "current.json"), {
      format: "pulse-clinic-viewer-generation-pointer",
      formatVersion: 1,
      generationId,
      updatedAt: now,
    });
    fs.rmSync(path.join(root, "_viewer", "acl-mapping.csv"), { force: true });
    return {
      packageId: manifest.packageId,
      reportRevision: preview.reportRevision || null,
      generationId,
      doctors: staged.length,
      periods: selectedPeriods.size,
      sha256: preview.sha256,
      importedAt: now,
    };
  }

  doctorLogin({ doctorId, pin }) {
    const status = this.status();
    const doctor = status.catalog.doctors.find(item => String(item.doctorId) === String(doctorId));
    if (!doctor) throw new Error("Врач не найден в опубликованном каталоге");
    const key = String(doctor.doctorId);
    if (Number(this.doctorLockedUntil.get(key) || 0) > Date.now()) {
      throw new Error("Вход врача временно заблокирован после пяти неверных PIN");
    }
    const folderId = safeSegment(doctor.folderId, "папка врача");
    const root = this.requireRoot();
    const doctorRoot = path.join(root, "doctors", folderId);
    const stateRoot = this.activeStateRoot();
    const metadataDoctorRoot = path.join(stateRoot, "doctors", folderId);
    const access = readJson(path.join(metadataDoctorRoot, "access.json"), null);
    if (!access || !verifyPin(pin, access)) {
      const failures = Number(this.doctorFailures.get(key) || 0) + 1;
      if (failures >= 5) {
        this.doctorFailures.delete(key);
        this.doctorLockedUntil.set(key, Date.now() + DOCTOR_LOCK_MS);
        throw new Error("Вход врача заблокирован на 15 минут после пяти неверных PIN");
      }
      this.doctorFailures.set(key, failures);
      throw new Error(`Неверный PIN врача. Осталось попыток: ${5 - failures}`);
    }
    this.doctorFailures.delete(key);
    this.doctorLockedUntil.delete(key);
    const index = readJson(path.join(metadataDoctorRoot, "index.json"), { publications: [] });
    const subjects = normalizeDoctorSubjects(index, doctor);
    return { doctor, doctorRoot, metadataDoctorRoot, index, subjects, pin: String(pin), grants: new Map() };
  }

  readReport(session, { subjectDoctorId, periodKey, pageType }) {
    if (!session || !session.doctorRoot || !session.index) throw new Error("Сессия врача не открыта");
    const subjectId = String(subjectDoctorId || session.doctor.doctorId);
    const subject = (session.subjects || normalizeDoctorSubjects(session.index, session.doctor))
      .find(item => item.doctorId === subjectId);
    if (!subject) return null;
    const publication = (subject.publications || []).find(item => item.periodKey === String(periodKey));
    const page = publication && publication.pages ? publication.pages[String(pageType)] : null;
    if (!page) return null;
    const releaseId = safeSegment(page.releaseId, "версия отчёта");
    if (page.sharedPageId) {
      const packageId = safeSegment(page.packageId, "пакет отчёта");
      const pageId = safeSegment(page.sharedPageId, "идентификатор страницы");
      const cacheKey = `${releaseId}\u0000${packageId}`;
      let grant = session.grants && session.grants.get(cacheKey);
      if (!grant) {
        const relativeGrant = String(page.grantRelativePath || "grant.json").replace(/\//g, path.sep);
        const grantPath = path.resolve(session.doctorRoot, "releases", releaseId, relativeGrant);
        const releaseRoot = path.resolve(session.doctorRoot, "releases", releaseId) + path.sep;
        if (!grantPath.startsWith(releaseRoot)) throw new Error("Некорректный путь ключей отчёта");
        const encryptedGrant = readJson(grantPath, null);
        if (!encryptedGrant) throw new Error("Ключи страниц отчёта не найдены");
        grant = decryptViewerGrant(encryptedGrant, session.pin);
        if (grant.packageId !== packageId || (page.reportRevision && grant.reportRevision !== page.reportRevision)) {
          throw new Error("Ключи не соответствуют выбранному выпуску отчёта");
        }
        if (session.grants) session.grants.set(cacheKey, grant);
      }
      const pageKey = grant.pageKeys && grant.pageKeys[pageId];
      const permitted = Array.isArray(grant.bindings) && grant.bindings.some(binding =>
        String(binding.doctorId) === subjectId
          && String(binding.periodKey) === String(periodKey)
          && String(binding.pageType) === String(pageType)
          && String(binding.pageId) === pageId);
      if (!pageKey || !permitted) throw new Error("Нет доступа к выбранной странице отчёта");
      const sharedPath = path.resolve(this.requireRoot(), "_viewer", "pages", packageId, `${pageId}.json`);
      const sharedRoot = path.resolve(this.requireRoot(), "_viewer", "pages", packageId) + path.sep;
      if (!sharedPath.startsWith(sharedRoot)) throw new Error("Некорректный путь общей страницы");
      const encryptedSharedPage = readJson(sharedPath, null);
      if (!encryptedSharedPage) throw new Error("Общая страница отчёта не найдена");
      const report = decryptSharedPage(encryptedSharedPage, pageKey);
      if (report.periodKey !== String(periodKey) || report.pageType !== String(pageType)) {
        throw new Error("Общая страница не соответствует запросу");
      }
      return { ...report, doctorId: subjectId };
    }
    const relative = String(page.relativePath || "").replace(/\//g, path.sep);
    const reportPath = path.resolve(session.doctorRoot, "releases", releaseId, relative);
    const releaseRoot = path.resolve(session.doctorRoot, "releases", releaseId) + path.sep;
    if (!reportPath.startsWith(releaseRoot)) throw new Error("Некорректный путь отчёта");
    const encrypted = readJson(reportPath, null);
    return encrypted ? decryptViewerPage(encrypted, session.pin) : null;
  }
}

module.exports = { ViewerStorageService, DOCTOR_LOCK_MS, atomicWriteJson, verifyPin };
