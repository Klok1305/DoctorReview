"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createCloudPublication, validateCloudPublication, visibleCloudPages, cloudAccountsFromSettings, MAX_CLOUD_PAGE_BYTES } = require("../desktop/services/cloud-publication-service.cjs");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), http = require("node:http");
const { createMobileServer } = require("../mobile-server/server.cjs");
const { publishCloudPublication, CloudConnectionStore } = require("../desktop/services/cloud-publisher.cjs");

function fixture() {
  const doctors = [
    { doctorId: "a", displayName: "Врач А", department: "A", specialization: "X" },
    { doctorId: "b", displayName: "Врач Б", department: "A", specialization: "Y" },
    { doctorId: "c", displayName: "Врач В", department: "B", specialization: "Z" },
    { doctorId: "head", displayName: "Заведующий без выработки", department: "A", specialization: "X" },
  ];
  const pages = [];
  for (const periodKey of ["2026-01", "2026-03"]) {
    for (const kind of ["clinic", "department", "specialization", "doctor"]) {
      const subjects = kind === "clinic" ? [""] : kind === "department" ? ["A", "B"] : kind === "specialization" ? ["X", "Y", "Z"] : ["a", "b", "c"];
      for (const subject of subjects) {
        const doctor = doctors.find(doctor => doctor.doctorId === subject);
        pages.push({ kind, periodKey, doctorId: kind === "doctor" ? subject : "",
          department: kind === "department" ? subject : doctor?.department || "",
          specialization: kind === "specialization" ? subject : doctor?.specialization || "",
          title: `${kind} ${subject} ${periodKey}`, html: '<div class="kpi">43 визита</div><p>Комментарий администратора</p>' });
      }
    }
  }
  return createCloudPublication({ appVersion: "test", doctors, pages, accounts: [
    { userId: "1", doctorId: "a", admin: false, departments: [], specializations: [] },
    { userId: "2", doctorId: "c", admin: false, departments: [], specializations: ["X"] },
    { userId: "3", doctorId: "head", admin: false, departments: ["A"], specializations: [] },
    { userId: "4", doctorId: "c", admin: false, departments: ["A"], specializations: ["Z"] },
    { userId: "5", doctorId: "", admin: true, departments: [], specializations: [] },
  ] });
}
test("cloud roles are enforced on pages: self, specialization + self, department + all its specializations, admin", () => {
  const publication = fixture();
  const labels = userId => [...new Set(visibleCloudPages(publication, userId).map(page => `${page.kind}:${page.doctorId || page.department || page.specialization}`))].sort();
  assert.deepEqual(labels("1"), ["doctor:a"]);
  assert.deepEqual(labels("2"), ["doctor:c", "specialization:X"]);
  assert.deepEqual(labels("3"), ["department:A", "doctor:a", "doctor:b", "specialization:X", "specialization:Y"]);
  assert.deepEqual(labels("4"), ["department:A", "doctor:a", "doctor:b", "doctor:c", "specialization:X", "specialization:Y", "specialization:Z"]);
  assert.equal(visibleCloudPages(publication, "5").length, publication.pages.length);
  assert.deepEqual(labels("unknown"), []);
  assert.deepEqual([...new Set(publication.pages.map(page => page.periodKey))], ["2026-01", "2026-03"]);
  const accounts = cloudAccountsFromSettings(publication.doctors, { cloudDoctorUserIds: { a: "1", c: "2", head: "3" },
    cloudSpecializationHeadDoctorIds: ["c"], cloudAdminUserIds: ["1", "5"] }, { A: "head" });
  assert.equal(accounts.find(account => account.userId === "1").admin, true);
  assert.deepEqual(accounts.find(account => account.userId === "2").specializations, ["Z"]);
  assert.deepEqual(accounts.find(account => account.userId === "3").departments, ["A"]);
  assert.throws(() => cloudAccountsFromSettings(publication.doctors, { cloudDoctorUserIds: { a: "1", b: "1" } }, {}), /нескольким врачам/);
});
test("cloud rejects portable databases, unknown patient fields, patient HTML, tampered scope and hashes", () => {
  for (const mutate of [
    value => { value.patients = [{ name: "Пациент" }]; },
    value => { value.doctors[0].patients = [{ id: 1 }]; },
    value => { value.security.patientRegistryIncluded = true; },
    value => { value.pages[0].html = '<table data-viewer-patient-register><tr><td>Пациент</td></tr></table>'; },
    value => { value.pages[0].html += '<script>alert(1)</script>'; },
    value => { value.pages[0].html = `<p>${"я".repeat(Math.ceil(MAX_CLOUD_PAGE_BYTES / 2))}</p>`; },
    value => { value.pages.find(page => page.kind === "doctor").department = "B"; },
    value => { value.accounts[0].departments = ["other"]; },
    value => { value.accounts[0].userId = "share:anonymous"; },
    value => { value.accounts.push(value.accounts[0]); },
  ]) {
    const value = structuredClone(fixture()); mutate(value);
    assert.throws(() => validateCloudPublication(value), /облачная публикация/);
  }
});

test("cloud upload survives a lost chunk response, enforces gateway identity/portal/key, and persists access on restart", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "klinvekt-cloud-test-"));
  const servers = [];
  t.after(async () => { for (const server of servers) await new Promise(resolve => server.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const start = async () => {
    const server = createMobileServer({ dataDir, cloudPortalId: "portal", cloudPublisherKeyIds: ["publish-key"] });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  };
  let base = await start(), dropped = false, cancelAfterChunk = null;
  const uploadIds = [];
  const proxy = http.createServer(async (request, response) => {
    if (request.headers["x-api-key"] !== "test-secret") { response.writeHead(403).end(); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const targetPath = request.url.replace(/^\/applications\/app\/api/, "");
    const headers = { "X-Vibe-Caller-Kind": "external-api", "X-Vibe-Caller-Portal-Id": "portal", "X-Vibe-Caller-Key-Id": "publish-key",
      "Content-Type": request.headers["content-type"], ...(request.headers["x-chunk-sha256"] ? { "X-Chunk-Sha256": request.headers["x-chunk-sha256"] } : {}) };
    const upstream = await fetch(base + targetPath, { method: request.method, headers, body: Buffer.concat(chunks) });
    const body = Buffer.from(await upstream.arrayBuffer());
    if (targetPath === "/api/cloud/publications/uploads") uploadIds.push(JSON.parse(body.toString()).uploadId);
    if (!dropped && request.method === "PUT") { dropped = true; response.destroy(); return; }
    if (cancelAfterChunk && request.method === "PUT") { cancelAfterChunk.abort(); cancelAfterChunk = null; }
    response.writeHead(upstream.status, { "Content-Type": "application/json" }).end(body);
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve)); servers.push(proxy);
  const publication = fixture();
  const result = await publishCloudPublication(JSON.stringify(publication), { applicationId: "app", apiKey: "test-secret" },
    { baseUrl: `http://127.0.0.1:${proxy.address().port}/applications`, paceMs: 0 });
  assert.equal(result.pages, publication.pages.length); assert.equal(dropped, true);
  const resumeState = {}, canceled = new AbortController();
  cancelAfterChunk = canceled;
  const rebuilt = createCloudPublication({ ...publication,
    pages: publication.pages.map((page, index) => index ? page : { ...page, html: `${page.html}<p>${"0".repeat(600000)}</p>` }) });
  rebuilt.createdAt = new Date(Date.parse(publication.createdAt) + 1000).toISOString();
  const connection = { applicationId: "app", apiKey: "test-secret" };
  const options = { baseUrl: `http://127.0.0.1:${proxy.address().port}/applications`, paceMs: 0, resumeState };
  await assert.rejects(publishCloudPublication(JSON.stringify(rebuilt), connection, { ...options, signal: canceled.signal }), { name: "AbortError" });
  rebuilt.createdAt = new Date(Date.parse(rebuilt.createdAt) + 1000).toISOString();
  await publishCloudPublication(JSON.stringify(rebuilt), connection, options);
  assert.equal(uploadIds.at(-1), uploadIds.at(-2), "rebuilding after cancellation resumes the accepted upload despite a new timestamp");
  const identity = (userId, portalId = "portal") => ({ "X-Vibe-User-Id": userId, "X-Vibe-Portal-Id": portalId, "X-Vibe-User-Role": "ADMIN" });
  const context = await (await fetch(base + "/api/cloud/context", { headers: identity("1") })).json();
  assert.equal(context.pages.length, 2); assert.ok(context.pages.every(page => page.kind === "doctor" && page.doctorId === "a"));
  assert.doesNotMatch(JSON.stringify(context), /Комментарий|<div|accounts|test-secret/);
  const own = await fetch(base + "/api/cloud/pages/" + context.pages[0].pageId, { headers: identity("1") });
  assert.equal(own.status, 200); assert.equal(own.headers.get("cache-control"), "no-store");
  assert.match(await own.text(), /43 визита.*Комментарий администратора/);
  const forbidden = publication.pages.find(page => page.kind === "doctor" && page.doctorId === "b");
  assert.equal((await fetch(base + "/api/cloud/pages/" + forbidden.pageId, { headers: identity("1") })).status, 403);
  assert.equal((await fetch(base + "/api/cloud/context", { headers: identity("5", "other-portal") })).status, 401);
  assert.equal((await fetch(base + "/api/cloud/context", { headers: identity("999") })).status, 403, "portal admin is not automatically a clinical admin");
  assert.equal((await fetch(base + "/api/cloud/context", { headers: { ...identity("5"), "X-Vibe-Caller-Kind": "external-api" } })).status, 403);
  for (const headers of [identity("5"), { "X-Vibe-Caller-Kind": "external-api", "X-Vibe-Caller-Portal-Id": "portal", "X-Vibe-Caller-Key-Id": "other" }]) {
    assert.equal((await fetch(base + "/api/cloud/publications/uploads", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" })).status, 403);
  }
  const persisted = fs.readFileSync(path.join(dataDir, "publications.kvcloud"), "utf8");
  const bad = structuredClone(publication); bad.pages[0].patientName = "Тестовый пациент";
  await assert.rejects(publishCloudPublication(JSON.stringify(bad), { applicationId: "app", apiKey: "test-secret" },
    { baseUrl: `http://127.0.0.1:${proxy.address().port}/applications`, paceMs: 0 }), /неразрешённое поле/);
  assert.equal(fs.readFileSync(path.join(dataDir, "publications.kvcloud"), "utf8"), persisted);
  base = await start();
  const admin = await (await fetch(base + "/api/cloud/context", { headers: identity("5") })).json();
  assert.equal(admin.pages.length, publication.pages.length);
  const expanded = createCloudPublication({ ...publication, accounts: publication.accounts.filter(account => account.userId !== "1"),
    pages: Array.from({ length: 20 }, (_, year) => publication.pages.map(page => ({ ...page,
      periodKey: `${2026 + year}-${page.periodKey.slice(5)}`, title: `${page.title} ${2026 + year}` }))).flat() });
  await publishCloudPublication(JSON.stringify(expanded), connection, options);
  assert.equal((await fetch(base + "/api/cloud/context", { headers: identity("1") })).status, 403, "a new publication revokes the removed employee immediately");
  const catalog = [];
  let cursor = 0;
  do {
    const slice = await (await fetch(base + `/api/cloud/context?cursor=${cursor}`, { headers: identity("5") })).json();
    assert.ok(slice.pages.length <= 128); catalog.push(...slice.pages); cursor = slice.nextCursor;
  } while (cursor !== null);
  assert.equal(catalog.length, expanded.pages.length);
  assert.equal(new Set(catalog.map(page => page.pageId)).size, expanded.pages.length);
});

test("manual JSON upload bootstraps a portal admin, retains the uploading admin, and checks roles on every chunk", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "klinvekt-cloud-manual-"));
  const server = createMobileServer({ dataDir, cloudPortalId: "portal" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const crypto = require("node:crypto"), hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
  const identity = (userId, role = "USER") => ({ "X-Vibe-User-Id": userId, "X-Vibe-Portal-Id": "portal", "X-Vibe-User-Role": role, "X-Klinvekt-Cloud-Upload": "1" });
  const call = (url, headers, options = {}) => fetch(base + url, { ...options, headers: { ...headers, ...options.headers } });
  const admin = identity("5", "ADMIN"), doctor = identity("1");
  const start = async (value, headers = admin) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const response = await call("/api/cloud/manual/uploads", headers, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bytes: bytes.length, sha256: hash(bytes) }) });
    assert.equal(response.status, 200); return { bytes, ...(await response.json()) };
  };
  const chunk = (upload, headers = admin) => call(`/api/cloud/manual/uploads/${upload.uploadId}/chunks/0`, headers,
    { method: "PUT", headers: { "Content-Type": "application/octet-stream", "X-Chunk-Sha256": hash(upload.bytes) }, body: upload.bytes });
  const complete = (upload, headers = admin) => call(`/api/cloud/manual/uploads/${upload.uploadId}/complete`, headers, { method: "POST" });
  const access = await (await call("/api/cloud/admin", admin)).json();
  assert.equal(access.canUpload, true); assert.equal(access.publicationAvailable, false); assert.equal(access.userId, "5");
  assert.equal((await (await call("/api/cloud/admin", doctor)).json()).canUpload, false);
  assert.equal((await call("/api/cloud/manual/uploads", doctor, { method: "POST", body: "{}" })).status, 403);
  assert.equal((await call("/api/cloud/manual/uploads", { ...admin, "X-Klinvekt-Cloud-Upload": "" }, { method: "POST", body: "{}" })).status, 403);
  assert.equal((await call("/api/cloud/manual/uploads", { ...admin, "X-Vibe-Caller-Kind": "external-api" }, { method: "POST", body: "{}" })).status, 403);
  assert.equal((await call("/api/cloud/admin", { ...admin, "X-Vibe-Portal-Id": "other" })).status, 401);
  const locked = fixture(); locked.accounts = locked.accounts.filter(account => account.userId !== "5");
  const lockedUpload = await start(locked); assert.equal((await chunk(lockedUpload)).status, 200);
  const denied = await complete(lockedUpload); assert.equal(denied.status, 400); assert.match((await denied.json()).error, /ваш ID 5/);
  assert.equal(fs.existsSync(path.join(dataDir, "publications.kvcloud")), false);
  const upload = await start(fixture());
  assert.equal((await chunk(upload, doctor)).status, 403);
  assert.equal((await chunk(upload)).status, 200); assert.equal((await chunk(upload)).status, 200);
  assert.equal((await complete(upload)).status, 200); assert.equal((await complete(upload)).status, 200);
  assert.equal((await (await call("/api/cloud/admin", identity("5"))).json()).canUpload, true, "clinical admin can upload without being a portal admin");
  assert.equal((await (await call("/api/cloud/admin", identity("999", "ADMIN"))).json()).canUpload, false);
  const persisted = fs.readFileSync(path.join(dataDir, "publications.kvcloud"), "utf8");
  const bad = fixture(); bad.patients = [{ name: "synthetic patient" }];
  const invalid = await start(bad); assert.equal((await chunk(invalid)).status, 200);
  assert.equal((await complete(invalid)).status, 400);
  assert.equal(fs.readFileSync(path.join(dataDir, "publications.kvcloud"), "utf8"), persisted);
  // An administrator whose access is revoked cannot finish an older upload.
  const pending = await start({ ...fixture(), appVersion: "pending" });
  assert.equal((await chunk(pending)).status, 200);
  const switched = fixture(); switched.accounts.find(account => account.userId === "1").admin = true;
  const grant = await start(switched); await chunk(grant); await complete(grant);
  switched.accounts.find(account => account.userId === "5").admin = false;
  const revoke = await start(switched, doctor); await chunk(revoke, doctor); await complete(revoke, doctor);
  assert.equal((await complete(pending)).status, 403);
  assert.equal((await chunk(pending)).status, 403);
});

test("connection stores only encrypted keys and does not reuse a key for a different application", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "klinvekt-cloud-key-"));
  try {
    const safe = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value.split("").reverse().join("")),
      decryptString: bytes => bytes.toString().split("").reverse().join("") };
    const store = new CloudConnectionStore(dataDir, safe);
    assert.deepEqual(store.save({ applicationId: "app", apiKey: "test-secret" }), { applicationId: "app", keyConfigured: true });
    assert.doesNotMatch(fs.readFileSync(store.filePath, "utf8"), /test-secret/);
    assert.deepEqual(new CloudConnectionStore(dataDir, safe).credentials(), { applicationId: "app", apiKey: "test-secret" });
    assert.throws(() => store.save({ applicationId: "another-app", apiKey: "" }), /смене приложения/);
    const unavailable = new CloudConnectionStore(dataDir, { isEncryptionAvailable: () => false });
    assert.throws(() => unavailable.save({ applicationId: "app", apiKey: "new-secret" }), /защищённое хранение/);
    fs.writeFileSync(store.filePath, "{broken");
    assert.deepEqual(new CloudConnectionStore(dataDir, safe).publicSettings(), { applicationId: "", keyConfigured: false });
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
