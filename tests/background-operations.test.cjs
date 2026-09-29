"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { BackgroundTaskQueue } = require("../desktop/services/background-task-queue.cjs");
const { DatabaseService } = require("../desktop/services/database.cjs");

test("bounded worker queue keeps the event loop responsive and cancels the active task", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "klinvekt-background-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const workerPath = path.join(directory, "fixture-worker.cjs");
  fs.writeFileSync(workerPath, `const { parentPort, workerData } = require('node:worker_threads');
    parentPort.postMessage({ type: 'progress', progress: { stage: 'busy', completed: 0, total: 1 } });
    const until = Date.now() + workerData.payload.delay;
    while (Date.now() < until) {}
    parentPort.postMessage({ type: 'result', result: workerData.payload.value });`, "utf8");
  const queue = new BackgroundTaskQueue({ workerPath, maxQueued: 1 });
  t.after(() => queue.close());
  const controller = new AbortController();
  const progress = [];
  let progressReady;
  const started = new Promise(resolve => { progressReady = resolve; });
  let timerFired = false;
  setTimeout(() => { timerFired = true; }, 10);
  const active = queue.run("fixture", { delay: 300, value: "first" }, { signal: controller.signal, onProgress: value => {
    progress.push(value);
    progressReady();
  } });
  const queued = queue.run("fixture", { delay: 5, value: "second" });
  await assert.rejects(queue.run("fixture", { delay: 5, value: "third" }), /Очередь фоновых операций занята/);
  await started;
  assert.equal(timerFired, true, "main event loop must keep processing timers");
  assert.equal(progress[0]?.stage, "busy");
  controller.abort();
  await assert.rejects(active, error => error.name === "AbortError");
  assert.equal(await queued, "second");
  await queue.idle();
});

test("SQLite snapshot and import provenance commit on a worker without blocking the event loop", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "klinvekt-sqlite-worker-test-"));
  const databasePath = path.join(directory, "test.sqlite");
  const database = new DatabaseService(databasePath);
  const queue = new BackgroundTaskQueue({ maxQueued: 1 });
  t.after(async () => {
    await queue.idle();
    queue.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let timerFired = false;
  setTimeout(() => { timerFired = true; }, 0);
  const summary = await queue.run("database-save-snapshot", { databasePath,
    value: { version: 4, settings: {}, doctors: {}, months: {}, dynamicNotes: {}, fileLog: [] } });
  assert.equal(timerFired, true);
  assert.equal(summary.dataRevision, 1);
  const mutation = { version: 4, expectedRevision: 1, months: { "2026-01": { synthetic: true } } };
  const source = { sha256: "a".repeat(64), name: "synthetic.xlsx", size: 2 };
  await assert.rejects(queue.run("database-save-mutation", { databasePath, value: mutation,
    importRecords: [{ source, log: { status: "загружено", month: "2026-01" }, batchId: -1 }] }), /FOREIGN KEY|batch|пачк/i);
  assert.equal(database.summary().dataRevision, 1, "failed import must roll back its month and revision");
  assert.equal(database.loadSnapshot().months["2026-01"], undefined);
  const saved = await queue.run("database-save-mutation", { databasePath, value: mutation });
  assert.equal(saved.dataRevision, 2);
  assert.equal(database.loadSnapshot().months["2026-01"].synthetic, true);
});
