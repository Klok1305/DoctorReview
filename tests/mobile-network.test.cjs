"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { webcrypto, createHash } = require("node:crypto");

const appSource = fs.readFileSync(path.join(__dirname, "..", "mobile-pilot", "app.js"), "utf8");

function sendJson(response, value) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

test("mobile client retries a timed-out response and resumes after an interrupted chunk", async t => {
  let slowCalls = 0;
  let nextIndex = 0;
  let firstChunkAccepted;
  const accepted = new Promise(resolve => { firstChunkAccepted = resolve; });
  const chunkCalls = [0, 0];
  const server = http.createServer(async (request, response) => {
    try {
      const route = new URL(request.url, "http://localhost").pathname;
      if (route === "/slow") {
        slowCalls++;
        if (slowCalls === 1) await new Promise(resolve => setTimeout(resolve, 1200));
        sendJson(response, { attempt: slowCalls });
      } else if (route === "/api/admin/publications/uploads" && request.method === "POST") {
        await readBody(request);
        sendJson(response, { uploadId: "synthetic-upload", chunkBytes: 3, chunks: 2, nextIndex });
      } else if (route === "/api/admin/publications/uploads/synthetic-upload" && request.method === "GET") {
        sendJson(response, { nextIndex });
      } else if (/\/chunks\/[01]$/.test(route) && request.method === "PUT") {
        const index = Number(route.at(-1));
        const body = await readBody(request);
        assert.equal(createHash("sha256").update(body).digest("hex"), request.headers["x-chunk-sha256"]);
        chunkCalls[index]++;
        if (index === nextIndex) nextIndex++;
        if (index === 0 && chunkCalls[0] === 1) {
          firstChunkAccepted();
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (!response.destroyed) sendJson(response, { nextIndex });
      } else if (route.endsWith("/complete") && request.method === "POST") {
        await readBody(request);
        assert.equal(nextIndex, 2);
        sendJson(response, { doctors: 1 });
      } else {
        response.writeHead(404); response.end();
      }
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = { textContent: "", classList: { add() {}, remove() {} } };
  const cancelButton = { classList: { add() {}, remove() {} } };
  const context = vm.createContext({
    fetch: (route, options) => fetch(new URL(route, base), options),
    AbortController, DOMException, setTimeout, clearTimeout, Blob,
    window: { crypto: webcrypto },
    elements: { serverPublicationStatus: status, cancelBundleButton: cancelButton },
    state: { uploadController: null },
    refreshServerContext: async () => {},
  });
  const apiStart = appSource.indexOf("  async function apiRequest(");
  const apiEnd = appSource.indexOf("  function renderServerContext", apiStart);
  const uploadStart = appSource.indexOf("  async function uploadBundle(");
  const uploadEnd = appSource.indexOf("  elements.openDemoButton.addEventListener", uploadStart);
  assert.ok(apiStart >= 0 && apiEnd > apiStart && uploadStart >= 0 && uploadEnd > uploadStart);
  vm.runInContext(appSource.slice(apiStart, apiEnd) + appSource.slice(uploadStart, uploadEnd), context);

  const slow = await context.apiRequest("/slow", { timeoutMs: 500, retries: 1 });
  assert.equal(slow.attempt, 2);
  assert.equal(slowCalls, 2);

  const file = new Blob([Buffer.from("ABCDEF")]);
  const first = context.uploadBundle(file);
  await accepted;
  context.state.uploadController.abort();
  await assert.rejects(first, /Операция отменена/);
  assert.equal(nextIndex, 1);
  assert.match(status.textContent, /продолжится с принятой части/);
  await context.uploadBundle(file);
  assert.equal(nextIndex, 2);
  assert.deepEqual(chunkCalls, [1, 1], "accepted first chunk must not be uploaded again");
  assert.match(status.textContent, /Обновлено: 1 врачей/);
});
