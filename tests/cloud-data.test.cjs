"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), crypto = require("node:crypto"), os = require("node:os");
const { createCloudPublication, validateCloudPublication, cloudAccountsFromViewer, PIN_PARAMS } = require("../desktop/services/cloud-publication-service.cjs");
const { assertCloudPatientPrivacy, cloudPrivacyPatterns } = require("../desktop/services/cloud-privacy.cjs");
const { createMobileServer } = require("../mobile-server/server.cjs");
const { renderCloudReport } = require("../mobile-server/cloud-report-renderer.cjs");
const { BackgroundTaskQueue } = require("../desktop/services/background-task-queue.cjs");
const root = path.resolve(__dirname, "..");
function fixtureContext() {
  const context = vm.createContext({ console, window: { desktopAPI: { listComments: async ({ periodKey }) => [
    { scopeType: "doctor", scopeId: "d1", periodKey, blockKey: "doctor.overview", bodyText: "Комментарий <script>текст</script>", authorName: "Администратор" },
    { scopeType: "department", scopeId: "A", periodKey, blockKey: "department.overview", bodyText: "Комментарий отделения", authorName: "Администратор" },
  ], saveDatabase: async () => ({ dataRevision: 1 }) }, addEventListener() {} },
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {}, createElement() { throw new Error("JSON attempted dashboard rendering"); } },
    localStorage: { getItem: () => null, setItem() {} }, navigator: {}, crypto: crypto.webcrypto, TextEncoder, DOMException, Blob, Intl, setTimeout, clearTimeout });
  for (const file of ["app-core.js", "app-parsers.js", "app-metrics.js", "cloud-report-data.js", "app-ui.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, "build", file), "utf8"), context, { filename: file });
  }
  vm.runInContext(`
    DB.doctors = { d1: { name: 'Доктор Первый', department: 'A', specialization: 'X', structureManual: true, aliases: [] },
      d2: { name: 'Доктор Второй', department: 'A', specialization: 'Y', structureManual: true, aliases: [] } };
    DB.settings.depts.X = defaultProfile(); DB.settings.depts.Y = defaultProfile();
    DB.settings.departments = { A: ['X', 'Y'] }; DB.settings.departmentUsesSpecializations.A = true;
    normalizeProfiles(); DB.months = { '2026-01': emptyMonth(), '2026-03': emptyMonth() };
    for (const [key, month] of Object.entries(DB.months)) {
      for (const [id, n] of [['d1', 1], ['d2', 2]]) {
        month.vyrabotka[id] = { items: [{ n: 'Процедура', cat: '', sourceForm: 'Сотрудник', q: n, sOwn: n * 1000, sRef: 0 }] };
        month.kb[id] = Object.fromEntries([1, 12, 36].map(win => [win, { clients: [
          { name: 'Пациент Общий Секретный', patientId: 'shared-private-id', v: 1, r: 20, s: 1000 },
          { name: 'Пациент Личный Секретный ' + n, patientId: 'private-id-' + n, v: n + 1, r: 50, s: 2000 },
        ] }]));
      }
    }
    DB.dynamicNotes = { 'doctor|2026-03|d1': { format: 'rich-v1', html: '<b>Ручной вывод</b><br>Ноль &amp; пропуск &#1040;' } };
    saveLocal = async () => true;
  `, context);
  return context;
}
const verifier = pin => { const salt = crypto.randomBytes(24); return { pinSalt: salt.toString("base64"), pinHash: crypto.scryptSync(pin, salt, 64, { ...PIN_PARAMS, maxmem: 64 * 1024 * 1024 }).toString("base64"), pinParams: PIN_PARAMS }; };
function bundle(payload) {
  return createCloudPublication({ ...payload, version: 3, appVersion: "test", accounts: cloudAccountsFromViewer(payload.doctors, {}, {
    admin: verifier("654321"), doctors: payload.doctors.map(doctor => ({ doctorId: doctor.doctorId, headDepartments: [], ...verifier("0123") })),
  }) });
}

test("cloud JSON exports all periods without DOM/charts, retains numeric Admin results, gaps, partition and comments", async () => {
  const context = fixtureContext(), progress = [];
  context.progress = text => progress.push(text);
  const payload = await vm.runInContext("buildCloudPublicationPayload(progress)", context), publication = bundle(payload);
  assert.equal(publication.pages.length, 12);
  assert.deepEqual([...new Set(publication.pages.map(page => page.periodKey))], ["2026-01", "2026-03"]);
  const personal = publication.pages.find(page => page.doctorId === "d1" && page.periodKey === "2026-03");
  const number = (page, id) => page.report.numbers.metrics.find(metric => metric.id === id).value;
  assert.equal(number(personal, "traffic.patients"), vm.runInContext("computeMetrics('d1','2026-03').traffic.patients", context));
  assert.equal(number(personal, "economy.sales"), 1000);
  assert.equal(personal.report.overallDelta, null, "February gap must not compare March to January");
  assert.equal(personal.report.vectors[3].methodologyId, "partition-v1-36m");
  assert.equal(personal.report.dynamics.conclusion, "Ручной вывод\nНоль & пропуск А");
  const money = personal.report.dynamics.charts.find(chart => chart.id === "money");
  assert.equal(money.labels.length, 3); assert.equal(money.series[0].values[1], null);
  const department = publication.pages.find(page => page.kind === "department" && page.periodKey === "2026-03");
  assert.equal(number(department, "traffic.patients"), 3, "shared patient must be deduplicated across doctors");
  assert.equal(number(department, "economy.sales"), 3000);
  assert.equal(number(department, "loyalty.scheduleLoad"), null, "missing data must not become zero");
  assert.ok(department.report.comments.some(comment => comment.text === "Комментарий отделения"));
  assert.ok(personal.report.comments.some(comment => comment.text.includes("<script>")));
  const snapshot = vm.runInContext("DB", context);
  assert.doesNotThrow(() => assertCloudPatientPrivacy(publication.pages, cloudPrivacyPatterns(snapshot)));
  assert.doesNotMatch(JSON.stringify(publication), /"html":|data:image|Секретный|private-id|clientRows|pinCode/);
  assert.match(progress.at(-1), /12 из 12/);
  const html = renderCloudReport(personal.report, personal.title);
  assert.match(html, /<svg/); assert.match(html, /Ручной вывод/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
});

test("cloud privacy permits a labelled doctor who is also a patient but still rejects that name in free text", () => {
  const page = { title: "Доктор Первый · март", report: { sections: [{ columns: ["Врач", "Балл"], rows: [["Доктор Первый", "80"]] }] } };
  const options = { doctorNames: ["Доктор Первый"] };
  assert.doesNotThrow(() => assertCloudPatientPrivacy([page], ["Доктор Первый"], options));
  page.report.comments = [{ text: "Пациент: Доктор Первый" }];
  assert.throws(() => assertCloudPatientPrivacy([page], ["Доктор Первый"], options), /пациента/);
  assert.throws(() => assertCloudPatientPrivacy([{ report: { note: "xxbabcc" } }], ["abc", "bab", "bcc", "babcc"]), /пациента/);
});

test("structured cloud reports reject nested patient/HTML fields, forged numbers and changed checksums", async () => {
  const original = bundle(await vm.runInContext("buildCloudPublicationPayload()", fixtureContext()));
  for (const mutate of [
    page => { page.report.vectors[0].sections[0].clients = [{ name: "Patient" }]; },
    page => { page.html = "<p>Snapshot</p>"; },
    page => { page.report.numbers.metrics[0].value = "100"; },
    page => { page.report.overall = 100; },
  ]) {
    const changed = structuredClone(original); mutate(changed.pages[0]);
    assert.throws(() => validateCloudPublication(changed));
  }
});

test("numeric cloud worker validates and serializes without including its local patient patterns", async () => {
  const payload = bundle(await vm.runInContext("buildCloudPublicationPayload()", fixtureContext()));
  const queue = new BackgroundTaskQueue();
  try {
    const result = await queue.run("cloud-publication", { ...payload, privacyPatterns: ["Hidden Patient Secret"] });
    assert.equal(result.pages, 12); assert.doesNotMatch(result.serialized, /privacyPatterns|Hidden Patient|data:image|"html":/);
  } finally { queue.close(); }
});

test("v3 JSON manual upload, PIN access, report rendering, catalog privacy and denied pages work over HTTP", async t => {
  const publication = bundle(await vm.runInContext("buildCloudPublicationPayload()", fixtureContext()));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "klinvekt-data-http-"));
  const server = createMobileServer({ dataDir: dir, cloudPortalId: "portal" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`, bytes = Buffer.from(JSON.stringify(publication));
  const hash = data => crypto.createHash("sha256").update(data).digest("hex");
  const headers = { "X-Vibe-User-Id": "1", "X-Vibe-Portal-Id": "portal", "X-Vibe-User-Role": "ADMIN", "X-Klinvekt-Cloud-Upload": "1" };
  const upload = await (await fetch(base + "/api/cloud/manual/uploads", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ bytes: bytes.length, sha256: hash(bytes) }) })).json();
  for (let index = 0, offset = 0; offset < bytes.length; index++, offset += upload.chunkBytes) {
    const chunk = bytes.subarray(offset, offset + upload.chunkBytes);
    assert.equal((await fetch(`${base}/api/cloud/manual/uploads/${upload.uploadId}/chunks/${index}`, { method: "PUT", headers: { ...headers, "Content-Type": "application/octet-stream", "X-Chunk-Sha256": hash(chunk) }, body: chunk })).status, 200);
  }
  assert.equal((await fetch(`${base}/api/cloud/manual/uploads/${upload.uploadId}/complete`, { method: "POST", headers })).status, 200);
  const login = await fetch(base + "/api/cloud/login", { method: "POST", headers: { ...headers, "Content-Type": "application/json", "X-Klinvekt-Cloud-Auth": "1" }, body: JSON.stringify({ accountId: "doctor:d1", pin: "0123" }) });
  assert.equal(login.status, 200); const session = await login.json(); headers["X-Klinvekt-Cloud-Session"] = session.sessionToken;
  const catalog = await (await fetch(base + "/api/cloud/context", { headers })).json();
  assert.equal(catalog.pages.length, 2); assert.doesNotMatch(JSON.stringify(catalog), /report|numbers|pinHash|Kommentar/);
  const response = await fetch(base + "/api/cloud/pages/" + catalog.pages[1].pageId, { headers });
  assert.equal(response.status, 200); assert.match(await response.text(), /cloud-data-report.*Доктор Первый/s);
  const forbidden = publication.pages.find(page => page.kind === "clinic");
  assert.equal((await fetch(base + "/api/cloud/pages/" + forbidden.pageId, { headers })).status, 403);
});

test("desktop JSON chooses a destination first, validates its owner and writes the complete v3 file atomically", async t => {
  const payload = await vm.runInContext("buildCloudPublicationPayload()", fixtureContext());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "klinvekt-data-save-")), filePath = path.join(dir, "anonymous.json");
  const source = fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf8");
  const handlers = new Map(), queue = new BackgroundTaskQueue();
  t.after(() => { queue.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let chosen = false, canceled = false;
  const pinIds = Object.fromEntries(payload.doctors.map(doctor => [doctor.doctorId, crypto.randomUUID()]));
  const pinSync = { setId: crypto.randomUUID(), revision: 1, digest: "a".repeat(64) };
  const context = vm.createContext({ require, fs, path, Date, mainWindow: {}, cloudExportFiles: new Map(),
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, localAdminActor: () => ({ userId: "admin" }),
    dialog: { showSaveDialog: async () => { chosen = true; return { canceled, filePath }; } },
    configStore: { publicConfig: () => ({ outputDir: dir }) }, ensureObject: value => value, app: { getVersion: () => "test" },
    database: { loadSnapshot: () => ({ doctors: Object.fromEntries(payload.doctors.map(doctor => [doctor.doctorId, {}])), months: {}, settings: {} }),
      viewerPinTransferPayload: () => ({ sync: pinSync }), viewerPinSyncState: () => ({ ...pinSync, ids: pinIds }),
      viewerAccessSnapshot() {}, viewerExportCredentials: () => ({ admin: verifier("654321"), doctors: payload.doctors.map(doctor => ({ doctorId: doctor.doctorId, headDepartments: [], ...verifier("0123") })) }) },
    cloudAccountsFromViewer, cloudPrivacyPatterns,
    runPublicationTask: (_event, _id, task, value) => { assert.equal(chosen, true); return queue.run(task, value); },
  });
  vm.runInContext(source.slice(source.indexOf('  ipcMain.handle("cloud-publication:choose-file"'), source.indexOf('  ipcMain.handle("mobile-publication:export-bundle"')), context);
  const event = { sender: { id: 1 } }, exportFile = handlers.get("cloud-publication:export");
  await assert.rejects(exportFile(event, { ...payload, action: "json", operationId: "test" }), /Сначала выберите файл/);
  assert.equal(fs.existsSync(filePath), false);
  const selection = await handlers.get("cloud-publication:choose-file")(event);
  assert.equal(fs.existsSync(filePath), false, "selection must not start rendering or create a partial file");
  await assert.rejects(exportFile({ sender: { id: 2 } }, { ...payload, action: "json", operationId: "test", fileToken: selection.token }), /Сначала выберите файл/);
  const result = await exportFile(event, { ...payload, action: "json", operationId: "test", fileToken: selection.token });
  assert.equal(result.path, filePath);
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).version, 3);
  assert.deepEqual(fs.readdirSync(dir), ["anonymous.json"]);
  await assert.rejects(exportFile(event, { ...payload, action: "json", fileToken: selection.token }), /Сначала выберите файл/);
  canceled = true;
  assert.equal((await handlers.get("cloud-publication:choose-file")(event)).canceled, true);
});
