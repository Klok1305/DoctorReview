"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { performance, monitorEventLoopDelay } = require("node:perf_hooks");
const { BackgroundTaskQueue } = require("../desktop/services/background-task-queue.cjs");
const { DatabaseService } = require("../desktop/services/database.cjs");

async function measure(label, action) {
  const delay = monitorEventLoopDelay({ resolution: 10 });
  let ticks = 0;
  const ticker = setInterval(() => { ticks++; }, 5);
  const started = performance.now();
  delay.enable();
  try {
    await action();
    const elapsedMs = Math.round(performance.now() - started);
    const maxEventDelayMs = Math.round(delay.max / 1e6);
    assert.ok(ticks > 0, `${label}: интерфейсный цикл не получил управление`);
    assert.ok(maxEventDelayMs < 250, `${label}: задержка событий ${maxEventDelayMs} мс`);
    assert.ok(elapsedMs < 30000, `${label}: операция заняла ${elapsedMs} мс`);
    return { label, elapsedMs, maxEventDelayMs, timerTicks: ticks };
  } finally {
    delay.disable();
    clearInterval(ticker);
  }
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "klinvekt-background-benchmark-"));
  const databasePath = path.join(directory, "synthetic.sqlite");
  const database = new DatabaseService(databasePath);
  const databaseQueue = new BackgroundTaskQueue({ maxQueued: 2 });
  const packageQueue = new BackgroundTaskQueue({ maxQueued: 1 });
  try {
    const doctors = { d1: { name: "Синтетический Врач", department: "Терапия", specialization: "Терапия" } };
    const months = {};
    for (let month = 1; month <= 12; month++) {
      const key = `2026-${String(month).padStart(2, "0")}`;
      months[key] = { vyrabotka: { d1: { items: Array.from({ length: 250 }, (_, index) => ({
        n: `Синтетическая услуга ${index}`, q: index + 1, sOwn: index * 100, sRef: 0,
      })) } } };
    }
    const results = [];
    results.push(await measure("sqlite-snapshot", () => databaseQueue.run("database-save-snapshot", {
      databasePath, value: { version: 4, settings: {}, doctors, months, dynamicNotes: {}, fileLog: [] },
    })));
    database.setViewerAdminPin("654321");
    database.updateViewerDoctorAccess({ doctorId: "d1", active: true, pin: "1357" });
    const viewerInput = {
      appVersion: "benchmark", periods: ["2026-01"],
      doctors: [{ doctorId: "d1", displayName: "Синтетический Врач", department: "Терапия", specialization: "Терапия" }],
      pages: [{ doctorId: "d1", periodKey: "2026-01", pageType: "doctor", scopeId: "d1",
        title: "Синтетический отчёт", html: `<div class="card">${"Синтетические данные ".repeat(10000)}</div>` }],
      credentials: database.viewerExportCredentials(["d1"]),
    };
    let viewerResult;
    results.push(await measure("viewer-zip", async () => { viewerResult = await packageQueue.run("viewer-zip", viewerInput); }));
    const viewerBytes = Buffer.from(viewerResult.buffer);
    assert.equal(viewerBytes.subarray(0, 2).toString("ascii"), "PK");
    assert.equal(crypto.createHash("sha256").update(viewerBytes).digest("hex"), viewerResult.sha256);
    const demoContext = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "mobile-pilot", "demo-data.js"), "utf8"), demoContext);
    const demo = JSON.parse(JSON.stringify(demoContext.window.KLINVEKT_MOBILE_DEMO));
    const publication = { format: "klinvekt-mobile-publication", version: 1, createdAt: new Date(0).toISOString(),
      security: { patientRegistryIncluded: false, rawExportsIncluded: false },
      doctor: { id: "d1", ...demo.doctor }, periods: demo.periods };
    let mobileResult;
    results.push(await measure("mobile-bundle", async () => { mobileResult = await packageQueue.run("mobile-bundle", {
      publications: [{ doctorId: "d1", publication }],
      recipients: [{ doctorId: "d1", displayName: publication.doctor.name, department: publication.doctor.department }],
      credentials: { doctors: [{ doctorId: "d1", pinCode: "1357", pinVersion: 1 }] },
      appVersion: "benchmark",
    }); }));
    assert.equal(JSON.parse(mobileResult.serialized).doctors.length, 1);
    process.stdout.write(JSON.stringify({ syntheticOnly: true, node: process.version, results }, null, 2) + "\n");
  } finally {
    await Promise.all([databaseQueue.idle(), packageQueue.idle()]);
    databaseQueue.close();
    packageQueue.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
