"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld("desktopAPI", Object.freeze({
  initialize: () => invoke("app:initialize"),
  listComments: payload => invoke("comments:list", payload),
  saveComment: payload => invoke("comments:save", payload),
  getCommentHistory: id => invoke("comments:history", id),
  archiveComment: id => invoke("comments:archive", id),
  getViewerPublicationAccess: () => invoke("viewer-publication:access"),
  updateViewerDoctorAccess: payload => invoke("viewer-publication:update-doctor", payload),
  updateViewerDepartmentHead: payload => invoke("viewer-publication:update-department-head", payload),
  setViewerAdminPin: pin => invoke("viewer-publication:set-admin-pin", { pin }),
  exportViewerPackage: payload => invoke("viewer-publication:export", payload),
  exportViewerPins: payload => invoke("viewer-publication:export-pins", payload),
  exportMobilePublication: payload => invoke("mobile-publication:export", payload),
  saveDatabase: json => invoke("database:save", json),
  exportJson: json => invoke("database:export-json", json),
  importJson: json => invoke("database:import-json", json),

  chooseWorkspace: () => invoke("config:choose-workspace"),
  chooseFolder: kind => invoke("config:choose-folder", kind),
  openPath: kind => invoke("path:open", kind),

  pickInputFiles: () => invoke("files:pick-input"),
  scanInputFolder: () => invoke("files:scan-input"),
  listImportedSources: reportType => invoke("files:list-imported", reportType),
  readInputFile: filePath => invoke("files:read-input", filePath),
  hasImportedSource: sha256 => invoke("import:has-source", sha256),
  beginImport: payload => invoke("import:begin", payload),
  recordImport: payload => invoke("import:record", payload),
  finishImport: payload => invoke("import:finish", payload),

  beginExport: payload => invoke("export:begin", payload),
  renderPdf: payload => invoke("export:render-pdf", payload),
  writeExportFile: payload => invoke("export:write", payload),
  finishExport: payload => invoke("export:finish", payload),
  abortExport: token => invoke("export:abort", token),

  createBackup: () => invoke("backup:create"),
  exportBackup: () => invoke("backup:export"),
  restoreBackup: () => invoke("backup:restore"),
  reportRendererError: payload => ipcRenderer.send("app:renderer-error", payload),

  checkUpdates: () => invoke("update:check"),
  installDownloadedUpdate: () => invoke("update:install-downloaded"),
  installUpdateFile: () => invoke("update:install-file"),
  onUpdateStatus: callback => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("update:status", listener);
    return () => ipcRenderer.removeListener("update:status", listener);
  },
}));
