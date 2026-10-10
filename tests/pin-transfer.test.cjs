"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const crypto = require("node:crypto"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { DatabaseService } = require("../desktop/services/database.cjs");
const pins = require("../desktop/services/pin-transfer-service.cjs");
const { createCloudPublication, cloudAccountsFromViewer } = require("../desktop/services/cloud-publication-service.cjs");
const { createMobileServer } = require("../mobile-server/server.cjs");
const { BackgroundTaskQueue } = require("../desktop/services/background-task-queue.cjs");
const verifiers = new Map();
function verifier(pin) {
  if (!verifiers.has(pin)) {
    const salt = crypto.randomBytes(24);
    verifiers.set(pin, { pinHash: crypto.scryptSync(pin, salt, 64, { ...pins.PIN_PARAMS, maxmem: 64 * 1024 * 1024 }).toString("base64"), pinSalt: salt.toString("base64"), pinParams: pins.PIN_PARAMS });
  }
  return verifiers.get(pin);
}
function fixture(t, ids = ["a", "b"], codes = ["0123", "4567"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "klinvekt-pin-transfer-")), db = new DatabaseService(path.join(dir, "db.sqlite"));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  db.saveSnapshot({ version: 4, settings: { cloudSpecializationHeadDoctorIds: [ids[1]] }, doctors: {
    [ids[0]]: { name: "Врач Анна", department: "Отделение", specialization: "Терапия" },
    [ids[1]]: { name: "Врач Борис", department: "Отделение", specialization: "Терапия" },
  }, months: { "2026-01": { manual6: { [ids[0]]: { rating: 4.7 } } } }, dynamicNotes: { a: "Сохранить" }, fileLog: [] });
  db.viewerAccessSnapshot();
  for (let index = 0; index < ids.length; index++) {
    const value = verifier(codes[index]);
    db.db.prepare("UPDATE viewer_doctor_access SET pin_code=?,pin_hash=?,pin_salt=?,pin_params=? WHERE doctor_id=?")
      .run(codes[index], value.pinHash, value.pinSalt, JSON.stringify(value.pinParams), ids[index]);
  }
  db.setViewerAdminPin("654321"); db.updateViewerDepartmentHead({ department: "Отделение", doctorId: ids[1] });
  const admin = db.ensureLocalAdministrator();
  db.saveCommentDraft({ scopeType: "doctor", scopeId: ids[0], periodKey: "2026-01", blockKey: "doctor.overview", bodyHtml: "<p>Комментарий</p>", bodyText: "Комментарий", authorUserId: admin.id });
  db.publish({ periodKey: "2026-01", createdBy: admin.id, pages: [{ doctorId: ids[0], pageType: "doctor", scopeId: ids[0], title: "Готовый отчёт", html: "<p>Результат 43</p>" }] });
  return { db, dir, ids };
}
const mapping = preview => preview.rows.map(row => ({ syncId: row.syncId, targetId: row.targetId }));
function apply(db, payload, options = {}) {
  const preview = db.previewViewerPinTransfer(payload);
  return db.applyViewerPinTransfer(payload, { mapping: mapping(preview), expectedState: preview.expectedState, adopt: true, ...options });
}
test("protected transfer preserves leading zero, authenticates file and verifies displayed codes", async t => {
  const { db } = fixture(t), payload = db.viewerPinTransferPayload(), password = "file-password-123";
  const encrypted = await pins.encryptPinTransfer(payload, password);
  assert.doesNotMatch(encrypted, /Врач Анна|pinHash|"0123"|file-password/);
  assert.deepEqual(await pins.decryptPinTransfer(encrypted, password), payload);
  await assert.rejects(pins.decryptPinTransfer(encrypted, "wrong-password"), /пароль|повреждён/);
  const damaged = JSON.parse(encrypted); damaged.tag = Buffer.alloc(16).toString("base64");
  await assert.rejects(pins.decryptPinTransfer(JSON.stringify(damaged), password), /пароль|повреждён/);
  damaged.kdf.N = 1073741824;
  await assert.rejects(pins.decryptPinTransfer(JSON.stringify(damaged), password), /параметры/);
  const mismatch = structuredClone(payload); mismatch.doctors[0].pin = "9999";
  await assert.rejects(pins.decryptPinTransfer(await pins.encryptPinTransfer(mismatch, password), password), /хешу/);
  assert.doesNotMatch(JSON.stringify(pins.cloudPinsFromTransfer(payload)), /"pin"|"0123"|"654321"/);
});
test("two Admin databases with different IDs adopt identical PIN set while preserving roles and analytics", t => {
  const source = fixture(t), target = fixture(t, ["x", "y"], ["4567", "0123"]), payload = source.db.viewerPinTransferPayload();
  target.db.setViewerAdminPin("111111");
  const before = target.db.createPortableJson(), preview = target.db.previewViewerPinTransfer(payload);
  assert.deepEqual(mapping(preview).map(item => item.targetId), ["x", "y"]);
  assert.throws(() => target.db.applyViewerPinTransfer(payload, { mapping: mapping(preview), expectedState: preview.expectedState }), /общего набора/);
  const result = apply(target.db, payload);
  assert.equal(result.updated, 2); assert.equal(result.partial, false);
  const after = target.db.createPortableJson();
  assert.deepEqual(after.snapshot, before.snapshot);
  for (const name of ["comments", "comment_versions", "viewer_department_heads", "publications", "published_pages"]) assert.deepEqual(after.tables[name], before.tables[name]);
  assert.deepEqual(after.tables.viewer_settings, before.tables.viewer_settings, "admin remains unchanged unless selected");
  assert.deepEqual(target.db.viewerPinTransferPayload().sync, payload.sync);
  assert.equal(target.db.viewerAccessSnapshot().doctors.find(item => item.doctorId === "x").pin, "0123");
  assert.equal(apply(target.db, payload).repeated, true);
  assert.equal(apply(target.db, payload, { importAdmin: true }).adminChanged, true);
  assert.deepEqual(target.db.viewerPinTransferPayload().sync, payload.sync);
});
test("PIN import transaction rolls back every doctor and backup on mid-write failure", t => {
  const source = fixture(t), target = fixture(t, ["x", "y"], ["8901", "2345"]), payload = source.db.viewerPinTransferPayload();
  const before = target.db.viewerAccessSnapshot();
  target.db.db.exec("CREATE TRIGGER fail_pin BEFORE UPDATE ON viewer_doctor_access WHEN NEW.doctor_id='y' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.throws(() => apply(target.db, payload), /synthetic failure/);
  assert.deepEqual(target.db.viewerAccessSnapshot(), before);
  assert.equal(target.db.db.prepare("SELECT COUNT(*) AS n FROM app_meta WHERE key LIKE 'viewerPinBackup:%'").get().n, 0);
});
test("PIN backup rollback changes only access and creates a fresh lineage", t => {
  const source = fixture(t), target = fixture(t, ["x", "y"], ["8901", "2345"]), payload = source.db.viewerPinTransferPayload();
  const before = target.db.createPortableJson(); apply(target.db, payload, { importAdmin: true });
  const result = target.db.restoreViewerPinTransferBackup(), after = target.db.createPortableJson();
  assert.equal(result.restored, 2); assert.notEqual(result.pinSync.setId, payload.sync.setId);
  assert.deepEqual(after.snapshot, before.snapshot); assert.deepEqual(after.tables.comments, before.tables.comments);
  assert.deepEqual(after.tables.viewer_doctor_access.map(item => item.pin_code), before.tables.viewer_doctor_access.map(item => item.pin_code));
  assert.throws(() => target.db.restoreViewerPinTransferBackup(), /уже отменён/);
});
test("stale files, changed preview, duplicate mappings and ambiguous names cannot silently overwrite PIN", t => {
  const source = fixture(t), target = fixture(t, ["x", "y"], ["8901", "2345"]), first = source.db.viewerPinTransferPayload();
  apply(target.db, first);
  source.db.updateViewerDoctorAccess({ doctorId: "a", pin: "1111", active: true });
  const next = source.db.viewerPinTransferPayload(); assert.ok(next.sync.revision > first.sync.revision);
  apply(target.db, next); assert.throws(() => apply(target.db, first), /старая версия/);
  const preview = target.db.previewViewerPinTransfer(next);
  target.db.setViewerAdminPin("222222");
  assert.throws(() => target.db.applyViewerPinTransfer(next, { mapping: mapping(preview), expectedState: preview.expectedState }), /после сравнения/);
  const duplicate = mapping(target.db.previewViewerPinTransfer(next)); duplicate[1].targetId = duplicate[0].targetId;
  const current = { ...next, sync: { ...next.sync, revision: target.db.viewerPinSyncState().revision } };
  assert.throws(() => apply(target.db, current, { mapping: duplicate }), /два PIN/);
  const ambiguous = pins.previewPinTransfer(first, [{ doctorId: "x", displayName: "Врач Анна", department: "Отделение", specialization: "Терапия" }, { doctorId: "z", displayName: "Врач Анна", department: "Отделение", specialization: "Терапия" }], null);
  assert.equal(ambiguous.rows[0].status, "ambiguous"); assert.equal(ambiguous.rows[0].targetId, "");
  const bad = structuredClone(first); bad.doctors[0].pinParams.N = 1;
  assert.throws(() => pins.validatePinTransfer(bad), /параметры/);
});
test("portable backup retains canonical mapping; partial PIN import is explicit and cannot be re-exported", t => {
  const source = fixture(t), target = fixture(t, ["x", "y"], ["8901", "2345"]), restored = fixture(t, ["r", "s"]), payload = source.db.viewerPinTransferPayload();
  apply(target.db, payload);
  restored.db.restorePortableJson(target.db.createPortableJson());
  assert.deepEqual(restored.db.viewerPinTransferPayload().sync, payload.sync);
  const partialTarget = fixture(t, ["p", "q"], ["7890", "6789"]), selected = mapping(partialTarget.db.previewViewerPinTransfer(payload)); selected[1].targetId = "";
  assert.equal(apply(partialTarget.db, payload, { mapping: selected }).partial, true);
  assert.throws(() => partialTarget.db.viewerPinTransferPayload(), /частично/);
  assert.equal(apply(partialTarget.db, payload).partial, false);
});
test("native PIN IPC validates preview ownership and expiry without exposing verifiers to renderer", async t => {
  const { db, dir } = fixture(t), vm = require("node:vm"), queue = new BackgroundTaskQueue();
  t.after(() => queue.close());
  const handlers = new Map(), pinImportFiles = new Map(), filePath = path.join(dir, "access.kvpins");
  const source = fs.readFileSync(path.join(__dirname, "../desktop/main.cjs"), "utf8");
  const context = vm.createContext({ require, fs, path, Date, mainWindow: {}, pinImportFiles, database: db, MAX_PIN_BYTES: pins.MAX_PIN_BYTES,
    cloudPinsFromTransfer: pins.cloudPinsFromTransfer, ensureObject: input => input, app: { getVersion: () => "test" },
    localAdminActor: () => ({ userId: db.ensureLocalAdministrator().id }), ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    configStore: { publicConfig: () => ({ outputDir: dir }) },
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath }), showOpenDialog: async () => ({ canceled: false, filePaths: [filePath] }) },
    runPublicationTask: (_event, _id, task, payload) => queue.run(task, payload) });
  vm.runInContext(source.slice(source.indexOf("  const cleanPinImports ="), source.indexOf('  ipcMain.handle("mobile-publication:export",')), context);
  const event = { sender: { id: 1, isDestroyed: () => false } }, stranger = { sender: { id: 2, isDestroyed: () => false } };
  const options = { password: "synthetic-password", operationId: crypto.randomUUID() };
  await handlers.get("pins:export")(event, options);
  const preview = await handlers.get("pins:preview")(event, options);
  assert.equal(preview.expectedState, undefined); assert.doesNotMatch(JSON.stringify(preview), /pinHash|pinSalt|pinParams/);
  const input = { token: preview.token, mapping: mapping(preview) };
  assert.throws(() => handlers.get("pins:apply")(stranger, input), /истекло/);
  handlers.get("pins:discard")(stranger, preview.token); assert.equal(pinImportFiles.size, 1);
  pinImportFiles.get(preview.token).expiresAt = 0;
  assert.throws(() => handlers.get("pins:apply")(event, input), /истекло/); assert.equal(pinImportFiles.size, 0);
  const second = await handlers.get("pins:preview")(event, options);
  assert.equal(handlers.get("pins:apply")(event, { token: second.token, mapping: mapping(second) }).repeated, true);
  assert.throws(() => handlers.get("pins:apply")(event, { token: second.token, mapping: mapping(second) }), /истекло/);
});

test("online PIN-only update preserves report IDs and roles, revokes sessions, persists and rejects stale full JSON", async t => {
  const source = fixture(t), target = fixture(t, ["x", "y"], ["8901", "2345"]), servers = [];
  t.after(async () => { for (const server of servers) await new Promise(resolve => server.close(resolve)); });
  const dir = path.join(target.dir, "server"); fs.mkdirSync(dir);
  const doctors = target.db.viewerPinTransferPayload().doctors.map(({ doctorId, displayName, department, specialization }) => ({ doctorId, displayName, department, specialization }));
  const pub = createCloudPublication({ version: 2, appVersion: "test", doctors,
    accounts: cloudAccountsFromViewer(doctors, target.db.loadSnapshot().settings, target.db.viewerExportCredentials(target.ids, { allowInactiveDoctorIds: target.ids })),
    pages: doctors.map(doctor => ({ ...doctor, kind: "doctor", periodKey: "2026-01", title: doctor.displayName, html: "<p>43 визита · Комментарий</p>" })).map(({ displayName, ...page }) => page) });
  let base;
  async function start() { const server = createMobileServer({ dataDir: dir, cloudPortalId: "portal" }); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); servers.push(server); base = `http://127.0.0.1:${server.address().port}`; }
  await start();
  const headers = { "X-Vibe-User-Id": "9", "X-Vibe-Portal-Id": "portal", "X-Vibe-User-Role": "ADMIN", "X-Klinvekt-Cloud-Upload": "1", "Content-Type": "application/json" };
  const call = (url, body, extra = {}) => fetch(base + url, { method: body === undefined ? "GET" : "POST", headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function upload(value) {
    const bytes = Buffer.from(JSON.stringify(value)), hash = crypto.createHash("sha256").update(bytes).digest("hex");
    const begun = await call("/api/cloud/manual/uploads", { bytes: bytes.length, sha256: hash }); assert.equal(begun.status, 200);
    const { uploadId } = await begun.json();
    const chunk = await fetch(base + `/api/cloud/manual/uploads/${uploadId}/chunks/0`, { method: "PUT", headers: { ...headers, "Content-Type": "application/octet-stream", "X-Chunk-Sha256": hash }, body: bytes }); assert.equal(chunk.status, 200);
    return call(`/api/cloud/manual/uploads/${uploadId}/complete`, {});
  }
  const login = (pin, accountId = "doctor:x") => call("/api/cloud/login", { accountId, pin }, { "X-Klinvekt-Cloud-Auth": "1" });
  assert.equal((await upload(pub)).status, 200);
  const oldSession = (await (await login("8901")).json()).sessionToken;
  const update = pins.cloudPinsFromTransfer(source.db.viewerPinTransferPayload());
  assert.equal((await call("/api/cloud/pins/preview", update, { "X-Vibe-User-Role": "USER" })).status, 403);
  assert.equal((await call("/api/cloud/pins/preview", update, { "X-Klinvekt-Cloud-Upload": "" })).status, 403);
  const previewResponse = await call("/api/cloud/pins/preview", update); assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json(); assert.doesNotMatch(JSON.stringify(preview), /pinHash|pinSalt|pinParams|"pin"/);
  const input = { token: preview.token, mapping: mapping(preview), adopt: true, importAdmin: false };
  assert.equal((await call("/api/cloud/pins/apply", input, { "X-Vibe-User-Id": "8" })).status, 404);
  assert.equal((await call("/api/cloud/pins/apply", { ...input, adopt: false })).status, 400);
  const rename = fs.promises.rename;
  try {
    fs.promises.rename = async (from, to) => { if (to === path.join(dir, "publications.kvcloud")) throw new Error("synthetic storage failure"); return rename(from, to); };
    assert.ok((await call("/api/cloud/pins/apply", input)).status >= 400);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "publications.kvcloud"), "utf8")).publication, pub);
    assert.equal((await call("/api/cloud/context", undefined, { "X-Klinvekt-Cloud-Session": oldSession })).status, 200);
  } finally { fs.promises.rename = rename; }
  const applied = await call("/api/cloud/pins/apply", input); assert.equal(applied.status, 200, await applied.text());
  assert.equal((await (await call("/api/cloud/pins/apply", input)).json()).repeated, true);
  assert.equal((await call("/api/cloud/context", undefined, { "X-Klinvekt-Cloud-Session": oldSession })).status, 401);
  assert.equal((await login("8901")).status, 401); assert.equal((await login("0123")).status, 200);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, "publications.kvcloud"), "utf8")).publication;
  assert.deepEqual(stored.pages, pub.pages); assert.equal(stored.createdAt, pub.createdAt);
  assert.deepEqual(stored.accounts.map(({ pinHash, pinSalt, pinParams, pinSyncId, ...account }) => account), pub.accounts.map(({ pinHash, pinSalt, pinParams, ...account }) => account));
  assert.deepEqual(stored.pinSync, update.sync);
  assert.equal((await upload(pub)).status, 400, "old full JSON cannot restore PIN after synchronization");
  await start(); assert.equal((await login("0123")).status, 200);
  source.db.updateViewerDoctorAccess({ doctorId: "a", pin: "1111", active: true });
  const fresh = pins.cloudPinsFromTransfer(source.db.viewerPinTransferPayload()), newer = await (await call("/api/cloud/pins/preview", fresh)).json();
  assert.equal((await call("/api/cloud/pins/apply", { token: newer.token, mapping: mapping(newer) })).status, 200);
  const old = await (await call("/api/cloud/pins/preview", update)).json();
  assert.equal(old.relation, "stale"); assert.equal((await call("/api/cloud/pins/apply", { token: old.token, mapping: mapping(old), adopt: true })).status, 400);
});

