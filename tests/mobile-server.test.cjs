"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const {
  MOBILE_PUBLICATION_FORMAT,
  MOBILE_PUBLICATION_VERSION,
  createMobilePublicationBundle,
} = require("../desktop/services/mobile-publication-service.cjs");
const { createMobileServer } = require("../mobile-server/server.cjs");

const root = path.resolve(__dirname, "..");

function testBundle() {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, "mobile-pilot", "demo-data.js"), "utf8"), context);
  const demo = JSON.parse(JSON.stringify(context.window.KLINVEKT_MOBILE_DEMO));
  const publication = {
    format: MOBILE_PUBLICATION_FORMAT,
    version: MOBILE_PUBLICATION_VERSION,
    createdAt: new Date(0).toISOString(),
    security: { patientRegistryIncluded: false, rawExportsIncluded: false },
    doctor: { id: "doctor-1", ...demo.doctor, name: "Иванов Иван" },
    periods: demo.periods,
  };
  return createMobilePublicationBundle({
    publications: [{ doctorId: "doctor-1", publication }],
    credentials: { doctors: [{ doctorId: "doctor-1", pinCode: "2468", pinVersion: 1 }] },
    appVersion: "test",
  });
}

function vibeHeaders({ userId = "user-1", role = "user" } = {}) {
  return {
    "X-Vibe-User-Id": userId,
    "X-Vibe-User-Name": `Employee ${userId}`,
    "X-Vibe-User-Name-Encoded": encodeURIComponent(`Сотрудник ${userId}`),
    "X-Vibe-User-Role": role,
    "X-Vibe-Portal-Id": "portal-1",
  };
}

test("Black Hole server gates access by Bitrix account, admin role and doctor PIN", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "klinvekt-mobile-server-"));
  const server = createMobileServer({ dataDir, staticRoot: path.join(root, "mobile-pilot") });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  let response = await fetch(`${base}/api/context`);
  assert.equal(response.status, 401);

  response = await fetch(`${base}/api/admin/publications`, {
    method: "POST",
    headers: { ...vibeHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(testBundle()),
  });
  assert.equal(response.status, 403);

  response = await fetch(`${base}/api/admin/publications`, {
    method: "POST",
    headers: { ...vibeHeaders({ userId: "admin-1", role: "portal_admin" }), "Content-Type": "application/json" },
    body: JSON.stringify(testBundle()),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).doctors, 1);

  response = await fetch(`${base}/api/context`, { headers: vibeHeaders() });
  const context = await response.json();
  assert.equal(context.canUpload, false);
  assert.equal(context.user.name, "Сотрудник user-1");
  assert.deepEqual(context.doctors.map(item => item.displayName), ["Иванов Иван"]);
  assert.equal(context.doctors[0].periods, 3);
  assert.equal(JSON.stringify(context).includes("ciphertext"), false);

  response = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { ...vibeHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ doctorId: "doctor-1", pin: "2468" }),
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly; SameSite=None; Secure; Partitioned/);
  const cookie = setCookie.split(";", 1)[0];
  assert.equal((await response.json()).publication.doctor.name, "Иванов Иван");

  response = await fetch(`${base}/api/report`, { headers: { ...vibeHeaders(), Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).publication.doctor.id, "doctor-1");

  response = await fetch(`${base}/api/report`, { headers: { ...vibeHeaders({ userId: "other-user" }), Cookie: cookie } });
  assert.equal(response.status, 401);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    response = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { ...vibeHeaders({ userId: "limited-user" }), "Content-Type": "application/json" },
      body: JSON.stringify({ doctorId: "doctor-1", pin: "0000" }),
    });
    assert.equal(response.status, 401);
  }
  response = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { ...vibeHeaders({ userId: "limited-user" }), "Content-Type": "application/json" },
    body: JSON.stringify({ doctorId: "doctor-1", pin: "2468" }),
  });
  assert.equal(response.status, 429);
});
