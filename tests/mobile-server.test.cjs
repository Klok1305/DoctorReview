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
  encryptMobilePublication,
} = require("../desktop/services/mobile-publication-service.cjs");
const { createMobileServer, MAX_UPLOAD_CHUNK_BYTES, MAX_SESSIONS } = require("../mobile-server/server.cjs");
const crypto = require("node:crypto");

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

test("session capacity rejects a new login without expiring active sessions or uploads and recovers after restart", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "klinvekt-session-capacity-"));
  const servers = [];
  const start = async () => {
    const server = createMobileServer({ dataDir, staticRoot: path.join(root, "mobile-pilot") });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    return server;
  };
  t.after(async () => { for (const server of servers) if (server.listening) await new Promise(resolve => server.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const server = await start();
  const base = `http://127.0.0.1:${server.address().port}`;
  const publish = await fetch(`${base}/api/admin/publications`, { method: "POST", headers: { ...vibeHeaders({ role: "portal_admin" }), "Content-Type": "application/json" }, body: JSON.stringify(testBundle()) });
  assert.equal(publish.status, 200);
  const login = (url, userId) => fetch(`${url}/api/login`, { method: "POST", headers: { ...vibeHeaders({ userId }), "Content-Type": "application/json" }, body: JSON.stringify({ doctorId: "doctor-1", pin: "2468" }) });
  const initial = await login(base, "existing-user");
  assert.equal(initial.status, 200);
  const state = server.klinvekt.state;
  const session = [...state.sessions.values()][0];
  for (let index = 1; index < MAX_SESSIONS; index++) state.sessions.set("synthetic-" + index, { ...session, userId: "synthetic-" + index });
  const activeUpload = path.join(dataDir, ".synthetic-active.tmp");
  const expiredUpload = path.join(dataDir, ".synthetic-expired.tmp");
  fs.writeFileSync(activeUpload, "synthetic"); fs.writeFileSync(expiredUpload, "synthetic");
  state.uploads.set("active", { temporaryPath: activeUpload, expiresAt: Date.now() + 60000 });
  state.uploads.set("expired", { temporaryPath: expiredUpload, expiresAt: Date.now() - 1 });
  let response = await login(base, "new-user");
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /предел.*сессий/i);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.ok(response.headers.get("retry-after"));
  assert.equal(state.sessions.size, MAX_SESSIONS);
  assert.equal(state.uploads.has("active"), true);
  assert.equal(fs.existsSync(activeUpload), true);
  assert.equal(state.uploads.has("expired"), false);
  assert.equal(fs.existsSync(expiredUpload), false);
  response = await login(base, "existing-user");
  assert.equal(response.status, 200, "same account replaces only its own session at capacity");
  const cookie = response.headers.get("set-cookie").split(";")[0];
  assert.equal(state.sessions.size, MAX_SESSIONS);
  assert.equal(state.uploads.has("active"), true);
  assert.equal((await fetch(`${base}/api/report`, { headers: { ...vibeHeaders({ userId: "existing-user" }), Cookie: cookie } })).status, 200);
  state.sessions.get("synthetic-1").expiresAt = Date.now() - 1;
  response = await login(base, "new-user");
  assert.equal(response.status, 200);
  assert.equal(state.sessions.size, MAX_SESSIONS);
  assert.equal(state.sessions.has("synthetic-1"), false);
  await new Promise(resolve => server.close(resolve));
  const restarted = await start();
  const restartedBase = `http://127.0.0.1:${restarted.address().port}`;
  assert.equal(restarted.klinvekt.state.sessions.size, 0);
  assert.equal((await fetch(`${restartedBase}/api/report`, { headers: { ...vibeHeaders({ userId: "existing-user" }), Cookie: cookie } })).status, 401);
  assert.equal((await login(restartedBase, "existing-user")).status, 200, "saved publication opens after fresh login on restart");
});

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

  for (const [route, contentType] of [
    ["/", "text/html"],
    ["/app.css?v=10", "text/css"],
    ["/app.js?v=10", "text/javascript"],
    ["/icons/app-icon-192.png", "image/png"],
    ["/mobile/", "text/html"],
    ["/mobile/app.css?v=10", "text/css"],
    ["/mobile/app.js?v=10", "text/javascript"],
    ["/mobile/icons/app-icon-192.png", "image/png"],
  ]) {
    const assetResponse = await fetch(`${base}${route}`);
    assert.equal(assetResponse.status, 200, route);
    assert.match(assetResponse.headers.get("content-type"), new RegExp(`^${contentType.replace("/", "\\/")}`), route);
  }

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

  const chunkedBundle = { ...testBundle(), transportPadding: "x".repeat(MAX_UPLOAD_CHUNK_BYTES + 1000) };
  const chunkedBytes = Buffer.from(JSON.stringify(chunkedBundle), "utf8");
  response = await fetch(`${base}/api/admin/publications/uploads`, {
    method: "POST",
    headers: { ...vibeHeaders({ userId: "admin-1", role: "portal_admin" }), "Content-Type": "application/json" },
    body: JSON.stringify({
      bytes: chunkedBytes.length,
      sha256: crypto.createHash("sha256").update(chunkedBytes).digest("hex"),
    }),
  });
  assert.equal(response.status, 201);
  const upload = await response.json();
  assert.equal(upload.chunkBytes, MAX_UPLOAD_CHUNK_BYTES);
  assert.ok(upload.chunks > 1);
  for (let index = 0; index < upload.chunks; index += 1) {
    const start = index * upload.chunkBytes;
    const chunk = chunkedBytes.subarray(start, Math.min(chunkedBytes.length, start + upload.chunkBytes));
    response = await fetch(`${base}/api/admin/publications/uploads/${upload.uploadId}/chunks/${index}`, {
      method: "PUT",
      headers: { ...vibeHeaders({ userId: "admin-1", role: "portal_admin" }), "Content-Type": "application/octet-stream", "X-Chunk-SHA256": crypto.createHash("sha256").update(chunk).digest("hex") },
      body: chunk,
    });
    assert.equal(response.status, 200);
    if (index === 0) {
      response = await fetch(`${base}/api/admin/publications/uploads`, {
        method: "POST",
        headers: { ...vibeHeaders({ userId: "admin-1", role: "portal_admin" }), "Content-Type": "application/json" },
        body: JSON.stringify({ bytes: chunkedBytes.length, sha256: crypto.createHash("sha256").update(chunkedBytes).digest("hex") }),
      });
      assert.equal(response.status, 200);
      const resumed = await response.json();
      assert.equal(resumed.uploadId, upload.uploadId);
      assert.equal(resumed.nextIndex, 1);
      response = await fetch(`${base}/api/admin/publications/uploads/${upload.uploadId}/chunks/0`, {
        method: "PUT",
        headers: { ...vibeHeaders({ userId: "admin-1", role: "portal_admin" }), "Content-Type": "application/octet-stream", "X-Chunk-SHA256": crypto.createHash("sha256").update(chunk).digest("hex") },
        body: chunk,
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).duplicate, true);
      response = await fetch(`${base}/api/admin/publications/uploads/${upload.uploadId}`, { headers: vibeHeaders({ userId: "admin-1", role: "portal_admin" }) });
      assert.equal((await response.json()).nextIndex, 1);
    }
  }
  response = await fetch(`${base}/api/admin/publications/uploads/${upload.uploadId}/complete`, {
    method: "POST",
    headers: { ...vibeHeaders({ userId: "admin-1", role: "portal_admin" }), "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).doctors, 1);
  response = await fetch(`${base}/api/admin/publications/uploads/${upload.uploadId}/complete`, {
    method: "POST",
    headers: { ...vibeHeaders({ userId: "admin-1", role: "portal_admin" }), "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).repeated, true);

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
  const loginResult = await response.json();
  assert.equal(loginResult.publication.doctor.name, "Иванов Иван");
  assert.equal(loginResult.publication.periods.length, 1, "login transfers only the current period");
  assert.equal(loginResult.availablePeriods.length, 3);

  const requestedPeriod = loginResult.availablePeriods[1].id;
  response = await fetch(`${base}/api/report?periodId=${encodeURIComponent(requestedPeriod)}`, { headers: { ...vibeHeaders(), Cookie: cookie } });
  assert.equal(response.status, 200);
  const periodResult = await response.json();
  assert.equal(periodResult.publication.doctor.id, "doctor-1");
  assert.deepEqual(periodResult.publication.periods.map(period => period.id), [requestedPeriod]);
  assert.equal(periodResult.availablePeriods.length, 3);

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

test("mobile heads can switch only authenticated subordinate grants, including heads without own reports", async (t) => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, "mobile-pilot/demo-data.js"), "utf8"), context);
  const demo = JSON.parse(JSON.stringify(context.window.KLINVEKT_MOBILE_DEMO));
  const definitions = [["head", "Заведующий", "A", "1234"], ["a", "Врач А", "A", "2345"],
    ["b", "Врач Б", "B", "3456"], ["outsider", "Другой врач", "C", "4567"], ["head-only", "Без личного отчёта", "B", "5678"], ["technical", "Техническая учётка", "A", "6789"]];
  const publications = definitions.filter(([id]) => !["head-only", "technical"].includes(id)).map(([doctorId, name, department]) => ({ doctorId, department,
    publication: { format: MOBILE_PUBLICATION_FORMAT, version: 1, security: { patientRegistryIncluded: false, rawExportsIncluded: false },
      doctor: { id: doctorId, name, department: `${department} · Специализация` }, periods: demo.periods } }));
  const recipients = definitions.map(([doctorId, displayName, department]) => ({ doctorId, displayName, department,
    // Renderer-supplied roles must not grant an ordinary doctor access.
    headDepartments: ["A", "B", "C"] }));
  const makeBundle = (departments = ["A", "B"]) => createMobilePublicationBundle({ publications, recipients,
    credentials: { doctors: definitions.map(([doctorId, , , pinCode]) => ({ doctorId, pinCode, pinVersion: 1,
      headDepartments: doctorId === "head" ? departments : doctorId === "head-only" ? ["B"] : [] })) } });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "klinvekt-mobile-heads-"));
  const server = createMobileServer({ dataDir });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const publish = bundle => fetch(`${base}/api/admin/publications`, { method: "POST",
    headers: { ...vibeHeaders({ role: "admin" }), "Content-Type": "application/json" }, body: JSON.stringify(bundle) });
  const login = async (doctorId, pin, userId = doctorId) => {
    const response = await fetch(`${base}/api/login`, { method: "POST", headers: { ...vibeHeaders({ userId }), "Content-Type": "application/json" },
      body: JSON.stringify({ doctorId, pin }) });
    assert.equal(response.status, 200);
    return { data: await response.json(), headers: { ...vibeHeaders({ userId }), Cookie: response.headers.get("set-cookie").split(";", 1)[0] } };
  };
  const bundle = makeBundle();
  assert.equal(bundle.version, 2);
  assert.equal(bundle.reports.length, 4, "report ciphertext is stored once, not duplicated for heads");
  assert.equal(bundle.doctors.length, 5);
  assert.equal((await publish(bundle)).status, 200);
  const loginOptions = await (await fetch(`${base}/api/context`, { headers: vibeHeaders() })).json();
  assert.ok(loginOptions.doctors.some(item => item.doctorId === "head-only"));
  assert.ok(!loginOptions.doctors.some(item => item.doctorId === "technical"));
  const head = await login("head", "1234");
  assert.equal(head.data.publication.doctor.id, "head");
  assert.deepEqual(head.data.access.reports.map(report => report.doctorId), ["head", "a", "b"]);
  assert.deepEqual(head.data.access.managedDepartments, ["A", "B"]);
  assert.doesNotMatch(JSON.stringify(head.data), /"grants"|"ciphertext"|"pinCode"|"encryption"/);
  for (const id of ["a", "b", "head"]) {
    const response = await fetch(`${base}/api/report?doctorId=${id}`, { headers: head.headers });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.publication.doctor.id, id);
    assert.equal(body.access.selectedDoctorId, id);
    assert.deepEqual(body.publication.periods[0].comments, demo.periods[0].comments);
  }
  for (const id of ["outsider", "missing", "head-only"]) {
    assert.equal((await fetch(`${base}/api/report?doctorId=${id}`, { headers: head.headers })).status, 403);
  }
  const doctor = await login("a", "2345");
  assert.deepEqual(doctor.data.access.reports.map(report => report.doctorId), ["a"]);
  assert.deepEqual(doctor.data.access.managedDepartments, []);
  assert.equal((await fetch(`${base}/api/report?doctorId=b`, { headers: { ...doctor.headers, "X-Vibe-User-Role": "admin" } })).status, 403);
  assert.equal((await fetch(`${base}/api/report?doctorId=a`, { headers: { ...head.headers, "X-Vibe-User-Id": "different" } })).status, 401);
  assert.equal((await fetch(`${base}/api/report?doctorId=a`, { headers: { ...head.headers, "X-Vibe-Portal-Id": "different" } })).status, 401);
  const noOwn = await login("head-only", "5678");
  assert.equal(noOwn.data.access.owner.doctorId, "head-only");
  assert.equal(noOwn.data.access.owner.periods, 0);
  assert.equal(noOwn.data.publication.doctor.id, "b");
  assert.equal((await fetch(`${base}/api/report?doctorId=a`, { headers: noOwn.headers })).status, 403);
  await fetch(`${base}/api/report?doctorId=b`, { headers: head.headers });
  assert.equal((await (await fetch(`${base}/api/report`, { headers: head.headers })).json()).publication.doctor.id, "b", "selection survives page reload");
  assert.equal((await publish(makeBundle(["A"]))).status, 200);
  assert.equal((await fetch(`${base}/api/report`, { headers: head.headers })).status, 401, "new exports revoke previous sessions");
  const reassigned = await login("head", "1234");
  assert.equal((await fetch(`${base}/api/report?doctorId=b`, { headers: reassigned.headers })).status, 403);
  const legacy = { format: "klinvekt-mobile-bundle", version: 1, createdAt: new Date(0).toISOString(),
    security: { patientRegistryIncluded: false, rawExportsIncluded: false, encryptedPerDoctor: true },
    doctors: [encryptMobilePublication(publications[0].publication, { doctorId: "head", pinCode: "1234", pinVersion: 1 })] };
  assert.equal((await publish(legacy)).status, 200);
  const old = await login("head", "1234");
  assert.deepEqual(old.data.access.reports.map(report => report.doctorId), ["head"]);
  assert.deepEqual(old.data.access.managedDepartments, [], "old bundles never infer head privileges from the login name or department");
});
