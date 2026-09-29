"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");

function cancelledError() {
  const error = new Error("Операция отменена");
  error.name = "AbortError";
  return error;
}

class BackgroundTaskQueue {
  constructor({ workerPath = path.join(__dirname, "background-task-worker.cjs"), maxQueued = 2 } = {}) {
    this.workerPath = workerPath;
    this.maxQueued = maxQueued;
    this.pending = [];
    this.active = null;
    this.idleWaiters = [];
    this.closed = false;
  }

  run(task, payload, { signal, onProgress } = {}) {
    if (this.closed) return Promise.reject(new Error("Фоновая очередь закрыта"));
    if (signal?.aborted) return Promise.reject(cancelledError());
    if (this.pending.length >= this.maxQueued) return Promise.reject(new Error("Очередь фоновых операций занята. Повторите позже."));
    return new Promise((resolve, reject) => {
      const job = { task, payload, signal, onProgress, resolve, reject, settled: false, worker: null, abort: null };
      job.abort = () => {
        if (job.settled) return;
        if (job.worker) {
          job.worker.terminate().catch(() => {});
        } else {
          this.pending = this.pending.filter(item => item !== job);
          this.#settle(job, cancelledError());
          this.#pump();
        }
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      this.pending.push(job);
      this.#pump();
    });
  }

  idle() {
    if (!this.active && !this.pending.length) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }

  close() {
    this.closed = true;
    for (const job of [...this.pending]) job.abort();
    if (this.active) this.active.abort();
  }

  #settle(job, error, result) {
    if (job.settled) return;
    job.settled = true;
    job.signal?.removeEventListener("abort", job.abort);
    if (error) job.reject(error);
    else job.resolve(result);
  }

  #pump() {
    if (this.active || !this.pending.length) {
      if (!this.active && !this.pending.length) this.idleWaiters.splice(0).forEach(resolve => resolve());
      return;
    }
    const job = this.pending.shift();
    this.active = job;
    let worker;
    try {
      worker = new Worker(this.workerPath, { workerData: { task: job.task, payload: job.payload } });
      job.worker = worker;
    } catch (error) {
      this.active = null;
      this.#settle(job, error);
      this.#pump();
      return;
    }
    worker.on("message", message => {
      if (job.settled) return;
      if (message?.type === "progress") {
        try { job.onProgress?.(message.progress); } catch (_) { /* UI callback is advisory */ }
      } else if (message?.type === "result") {
        this.#settle(job, null, message.result);
      } else if (message?.type === "error") {
        const error = new Error(message.error?.message || "Фоновая операция завершилась с ошибкой");
        error.name = message.error?.name || "Error";
        this.#settle(job, error);
      }
    });
    worker.on("error", error => this.#settle(job, error));
    worker.on("exit", code => {
      if (!job.settled) this.#settle(job, job.signal?.aborted ? cancelledError() : new Error(`Фоновый worker завершился с кодом ${code}`));
      if (this.active === job) this.active = null;
      this.#pump();
    });
  }
}

module.exports = { BackgroundTaskQueue };
