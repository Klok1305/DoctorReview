"use strict";
const assert = require("node:assert/strict"), test = require("node:test");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { DatabaseService } = require("../desktop/services/database.cjs");
const { createMobileServer } = require("../mobile-server/server.cjs");
const { createCloudAuth } = require("../mobile-server/cloud-auth.cjs");
const { createCloudPublication, validateCloudPublication, cloudAccountsFromViewer, visibleCloudPages, PIN_PARAMS } = require("../desktop/services/cloud-publication-service.cjs");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function verifier(pin) {
  const salt = crypto.randomBytes(24);
  return { pinSalt: salt.toString("base64"), pinHash: crypto.scryptSync(pin, salt, 64, { ...PIN_PARAMS, maxmem: 64 * 1024 * 1024 }).toString("base64"), pinParams: PIN_PARAMS };
}
const doctorVerifier = verifier("0123"), adminVerifier = verifier("654321");
function publication() {
  const doctors = [
    { doctorId: "a", displayName: "Врач А", department: "A", specialization: "X" },
    { doctorId: "b", displayName: "Врач Б", department: "A", specialization: "Y" },
    { doctorId: "c", displayName: "Врач В", department: "B", specialization: "Z" },
    { doctorId: "head", displayName: "Заведующий без выработки", department: "A", specialization: "X" },
  ];
  const accounts = cloudAccountsFromViewer(doctors, { cloudSpecializationHeadDoctorIds: ["c"] }, {
    admin: adminVerifier, doctors: doctors.map(doctor => ({ doctorId: doctor.doctorId, ...doctorVerifier,
      headDepartments: doctor.doctorId === "head" ? ["A"] : [] })) });
  const pages = ["2026-01", "2026-03"].flatMap(periodKey => [
    ...doctors.filter(doctor => doctor.doctorId !== "head").map(doctor => ({ kind: "doctor", doctorId: doctor.doctorId, department: doctor.department, specialization: doctor.specialization, periodKey, title: doctor.displayName, html: "<p>43 визита</p>" })),
    { kind: "clinic", periodKey, doctorId: "", department: "", specialization: "", title: "Клиника", html: "<p>129 визитов</p>" },
    ...["A", "B"].map(department => ({ kind: "department", periodKey, doctorId: "", department, specialization: "", title: department, html: "<p>Сводка</p>" })),
    ...["X", "Y", "Z"].map(specialization => ({ kind: "specialization", periodKey, doctorId: "", department: "", specialization, title: specialization, html: "<p>Сводка</p>" })),
  ]);
  return createCloudPublication({ version: 2, doctors, accounts, pages, appVersion: "test" });
}
test("PIN publication exports existing SQLite verifiers and retains doctor PINs across a portable restore", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "klinvekt-pin-backup-"));
  const db = new DatabaseService(path.join(dir, "source.sqlite")), restored = new DatabaseService(path.join(dir, "restored.sqlite"));
  t.after(() => { db.close(); restored.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const source = publication();
  db.saveSnapshot({ version: 4, settings: {}, doctors: Object.fromEntries(source.doctors.map(doctor => [doctor.doctorId, { name: doctor.displayName, department: doctor.department, specialization: doctor.specialization }])), months: {}, dynamicNotes: {}, fileLog: [] });
  db.viewerAccessSnapshot(); db.updateViewerDoctorAccess({ doctorId: "a", pin: "0123", active: false });
  db.setViewerAdminPin("654321"); db.updateViewerDepartmentHead({ department: "A", doctorId: "head" });
  restored.restorePortableJson(db.createPortableJson());
  assert.deepEqual(restored.viewerAccessSnapshot(), db.viewerAccessSnapshot());
  assert.equal(restored.viewerAccessSnapshot().doctors.find(doctor => doctor.doctorId === "a").pin, "0123");
  const ids = source.doctors.map(doctor => doctor.doctorId);
  const credentials = restored.viewerExportCredentials(ids, { allowInactiveDoctorIds: ids });
  const accounts = cloudAccountsFromViewer(source.doctors, { cloudSpecializationHeadDoctorIds: ["c"] }, credentials);
  const value = createCloudPublication({ ...source, accounts });
  assert.equal(value.accounts.find(account => account.accountId === "doctor:a").pinHash, credentials.doctors.find(doctor => doctor.doctorId === "a").pinHash);
  assert.doesNotMatch(JSON.stringify(value), /pinCode|"0123"|"654321"|userId|cloudDoctorUserIds/);
  const labels = id => [...new Set(visibleCloudPages(value, id).map(page => `${page.kind}:${page.doctorId || page.department || page.specialization}`))].sort();
  assert.deepEqual(labels("doctor:a"), ["doctor:a"]);
  assert.deepEqual(labels("doctor:c"), ["doctor:c", "specialization:Z"]);
  assert.deepEqual(labels("doctor:head"), ["department:A", "doctor:a", "doctor:b", "specialization:X", "specialization:Y"]);
  assert.equal(visibleCloudPages(value, "admin").length, value.pages.length);
  assert.deepEqual(labels("999"), []);
  for (const mutate of [v => { v.accounts[0].pinParams.N = 1073741824; }, v => { v.accounts[0].pinHash = "AA=="; },
    v => { v.accounts[0].pinSalt = "AA=="; }, v => { v.accounts[1].pinCode = "0123"; }, v => { v.accounts.shift(); },
    v => { v.accounts[1].accountId = "admin"; }, v => { v.accounts[1].userId = "1"; }]) {
    const bad = structuredClone(value); mutate(bad); assert.throws(() => validateCloudPublication(bad), /облачная публикация/);
  }
});
test("online name + PIN login grants roles, binds cookies to portal staff and revokes access on upload/restart/logout", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "klinvekt-cloud-pin-http-")), servers = [];
  t.after(async () => { for (const server of servers) await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  async function start() {
    const server = createMobileServer({ dataDir: dir, cloudPortalId: "portal" });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  }
  let base = await start();
  const headers = { "X-Vibe-User-Id": "999", "X-Vibe-Portal-Id": "portal" };
  const call = (url, options = {}) => fetch(base + url, { ...options, headers: { ...headers, ...options.headers } });
  const upload = async (value, cookie = "", role = "ADMIN") => {
    const bytes = Buffer.from(JSON.stringify(value)), h = { "X-Klinvekt-Cloud-Upload": "1", "X-Vibe-User-Role": role, Cookie: cookie };
    const begin = await call("/api/cloud/manual/uploads", { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ bytes: bytes.length, sha256: hash(bytes) }) });
    assert.equal(begin.status, 200); const { uploadId } = await begin.json();
    assert.equal((await call(`/api/cloud/manual/uploads/${uploadId}/chunks/0`, { method: "PUT", headers: { ...h, "Content-Type": "application/octet-stream", "X-Chunk-Sha256": hash(bytes) }, body: bytes })).status, 200);
    const finish = () => call(`/api/cloud/manual/uploads/${uploadId}/complete`, { method: "POST", headers: h });
    return { response: await finish(), finish };
  };
  const login = (accountId, pin, extra = {}) => call("/api/cloud/login", { method: "POST", headers: { "Content-Type": "application/json", "X-Klinvekt-Cloud-Auth": "1", ...extra }, body: JSON.stringify({ accountId, pin }) });
  const pub = publication(); const uploaded = await upload(pub);
  assert.equal(uploaded.response.status, 200); assert.equal((await uploaded.finish()).status, 200);
  const access = await (await call("/api/cloud/admin")).json();
  assert.equal(access.authMode, "pin"); assert.equal(access.account, null); assert.equal(access.accounts.length, 5);
  assert.doesNotMatch(JSON.stringify(access), /pinHash|pinSalt|pinParams|0123|654321/);
  assert.equal((await call("/api/cloud/context")).status, 401);
  assert.equal((await login("doctor:a", "9999")).status, 401);
  assert.equal((await login("doctor:a", "0123", { "X-Klinvekt-Cloud-Auth": "" })).status, 403);
  let cookie;
  for (const [id, expected] of [["doctor:a", 2], ["doctor:c", 4], ["doctor:head", 10], ["admin", 18]]) {
    const result = await login(id, id === "admin" ? "654321" : "0123");
    assert.equal(result.status, 200); const rawCookie = result.headers.get("set-cookie");
    const loginResult = await result.json();
    assert.match(loginResult.sessionToken, /^[a-f0-9]{64}$/);
    assert.match(rawCookie, /HttpOnly/); assert.match(rawCookie, /SameSite=None; Secure; Partitioned/);
    cookie = rawCookie.split(";")[0];
    const context = await (await call("/api/cloud/context", { headers: { Cookie: cookie } })).json();
    assert.equal(context.pages.length, expected);
    const headerContext = await (await call("/api/cloud/context", { headers: { "X-Klinvekt-Cloud-Session": loginResult.sessionToken } })).json();
    assert.equal(headerContext.pages.length, expected, "iframe can authenticate without third-party cookies");
    if (id === "doctor:a") {
      assert.equal((await call(`/api/cloud/pages/${pub.pages.find(page => page.doctorId === "b").pageId}`, { headers: { Cookie: cookie } })).status, 403);
      assert.equal((await call("/api/cloud/context", { headers: { Cookie: cookie, "X-Vibe-User-Id": "888" } })).status, 401);
      assert.equal((await call("/api/cloud/context", { headers: { "X-Klinvekt-Cloud-Session": loginResult.sessionToken, "X-Vibe-User-Id": "888" } })).status, 401);
      assert.equal((await call("/api/cloud/context", { headers: { Cookie: cookie, "X-Vibe-Portal-Id": "other" } })).status, 401);
      assert.equal((await call("/api/cloud/context", { headers: { Cookie: cookie, "X-Vibe-Caller-Kind": "external-api" } })).status, 403);
    }
  }
  assert.equal((await (await call("/api/cloud/admin", { headers: { Cookie: cookie } })).json()).canUpload, true);
  const changed = await upload({ ...pub, appVersion: "updated" }, cookie, "USER");
  assert.equal(changed.response.status, 200); assert.equal((await changed.finish()).status, 200, "lost acknowledgement is repeatable after PIN session revocation");
  assert.equal((await call("/api/cloud/context", { headers: { Cookie: cookie } })).status, 401);
  cookie = (await login("admin", "654321")).headers.get("set-cookie").split(";")[0];
  assert.equal((await call("/api/cloud/logout", { method: "POST", headers: { Cookie: cookie, "X-Klinvekt-Cloud-Auth": "1" } })).status, 200);
  assert.equal((await call("/api/cloud/context", { headers: { Cookie: cookie } })).status, 401);
  cookie = (await login("admin", "654321")).headers.get("set-cookie").split(";")[0];
  base = await start();
  assert.equal((await call("/api/cloud/context", { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await login("admin", "654321")).status, 200, "publication survives restart; login requires no employee ID mapping");
  for (let index = 0; index < 5; index++) {
    const result = await login(index % 2 ? "doctor:a" : "doctor:c", "0000", { "X-Vibe-User-Id": "777" });
    assert.equal(result.status, index === 4 ? 429 : 401);
  }
  assert.equal((await login("admin", "654321", { "X-Vibe-User-Id": "777" })).status, 429, "switching names cannot bypass the identity lock");
});
test("PIN session capacity preserves active sessions and uses wall time for expiry", async () => {
  let now = 1000;
  const auth = createCloudAuth({ now: () => now, maxSessions: 2 });
  const pub = publication(), cookies = [];
  for (const userId of ["1", "2", "3"]) {
    const identity = { userId, portalId: "p" }, request = { headers: {} }, response = { setHeader: (_key, value) => cookies.push(value.split(";")[0]) };
    const attempt = auth.login(request, response, identity, { accountId: "doctor:a", pin: "0123" }, () => pub);
    if (userId === "3") await assert.rejects(attempt, error => error.statusCode === 503);
    else await attempt;
  }
  assert.equal(auth.current({ headers: { cookie: cookies[1] } }, { userId: "1", portalId: "p" }), "doctor:a");
  now += 12 * 60 * 60 * 1000;
  assert.equal(auth.current({ headers: { cookie: cookies[1] } }, { userId: "1", portalId: "p" }), "");
  await auth.login({ headers: {} }, { setHeader: () => {} }, { userId: "3", portalId: "p" }, { accountId: "doctor:a", pin: "0123" }, () => pub);
});
