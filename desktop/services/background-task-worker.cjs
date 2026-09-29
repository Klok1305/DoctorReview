"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const progress = value => parentPort.postMessage({ type: "progress", progress: value });

async function execute() {
  const { task, payload } = workerData;
  if (task === "database-save-mutation" || task === "database-save-snapshot") {
    const { DatabaseService } = require("./database.cjs");
    const database = new DatabaseService(payload.databasePath);
    try {
      progress({ stage: "sqlite", completed: 0, total: 1 });
      const result = task === "database-save-mutation"
        ? database.saveMutation(payload.value, payload.importRecords || [])
        : database.saveSnapshot(typeof payload.value === "string" ? JSON.parse(payload.value) : payload.value,
          payload.importRecords || []);
      progress({ stage: "sqlite", completed: 1, total: 1 });
      return result;
    } finally {
      database.close();
    }
  }
  if (task === "viewer-zip" || task === "viewer-html") {
    const service = require("./viewer-package-service.cjs");
    return task === "viewer-zip"
      ? service.createViewerPackage(payload, progress)
      : service.createStandaloneViewerHtml(payload, progress);
  }
  if (task === "mobile-bundle") {
    const service = require("./mobile-publication-service.cjs");
    const bundle = await service.createMobilePublicationBundleAsync({ ...payload, onProgress: progress });
    progress({ stage: "serialize", completed: 0, total: 1 });
    const serialized = service.serializeMobilePublicationBundle(bundle);
    progress({ stage: "serialize", completed: 1, total: 1 });
    return { serialized, doctors: bundle.doctors.length };
  }
  throw new Error("Неизвестная фоновая операция");
}

execute().then(result => parentPort.postMessage({ type: "result", result }), error => {
  parentPort.postMessage({ type: "error", error: { name: error.name, message: error.message } });
});
