"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");
const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld("viewerAPI", Object.freeze({
  status: () => invoke("viewer:status"),
  chooseStorage: () => invoke("viewer:choose-storage"),
  adminLogin: pin => invoke("viewer:admin-login", pin),
  adminLogout: () => invoke("viewer:admin-logout"),
  pickPackage: () => invoke("viewer:pick-package"),
  previewPackagePath: filePath => invoke("viewer:preview-package-path", filePath),
  pathForFile: file => webUtils.getPathForFile(file),
  importPackage: payload => invoke("viewer:import-package", payload),
  doctorLogin: payload => invoke("viewer:doctor-login", payload),
  doctorLogout: () => invoke("viewer:doctor-logout"),
  report: payload => invoke("viewer:report", payload),
  openAclMapping: () => invoke("viewer:open-acl-mapping"),
}));
