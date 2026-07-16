"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld("desktopAPI", Object.freeze({
  initialize: () => invoke("app:initialize"),
  saveDatabase: json => invoke("database:save", json),
  exportJson: json => invoke("database:export-json", json),

  chooseWorkspace: () => invoke("config:choose-workspace"),
  chooseFolder: kind => invoke("config:choose-folder", kind),
  openPath: kind => invoke("path:open", kind),

  pickInputFiles: () => invoke("files:pick-input"),
  scanInputFolder: () => invoke("files:scan-input"),
  readInputFile: filePath => invoke("files:read-input", filePath),
  hasImportedSource: sha256 => invoke("import:has-source", sha256),
  beginImport: payload => invoke("import:begin", payload),
  recordImport: payload => invoke("import:record", payload),
  finishImport: payload => invoke("import:finish", payload),

  beginExport: payload => invoke("export:begin", payload),
  writeExportFile: payload => invoke("export:write", payload),
  finishExport: payload => invoke("export:finish", payload),
  abortExport: token => invoke("export:abort", token),

  createBackup: () => invoke("backup:create"),
  exportBackup: () => invoke("backup:export"),
  restoreBackup: () => invoke("backup:restore"),

  getUpdateStatus: () => invoke("update:status"),
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
