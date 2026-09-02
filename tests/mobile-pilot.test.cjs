const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  MOBILE_BUNDLE_EXTENSION,
  MOBILE_BUNDLE_FORMAT,
  MOBILE_PUBLICATION_FORMAT,
  MOBILE_PUBLICATION_VERSION,
  createMobilePublicationBundle,
  decryptMobilePublication,
  serializeMobilePublication,
  serializeMobilePublicationBundle,
  validateMobilePublication,
  validateMobilePublicationBundle,
} = require("../desktop/services/mobile-publication-service.cjs");

const root = path.resolve(__dirname, "..");
const pilotRoot = path.join(root, "mobile-pilot");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function pngSize(relativePath) {
  const buffer = fs.readFileSync(path.join(root, relativePath));
  assert.equal(buffer.toString("ascii", 1, 4), "PNG");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test("mobile pilot contains a complete installable static app shell", () => {
  const required = [
    "index.html",
    "app.css",
    "app.js",
    "demo-data.js",
    "manifest.webmanifest",
    "service-worker.js",
    "icons/app-icon-192.png",
    "icons/app-icon-512.png",
  ];
  for (const file of required) assert.ok(fs.existsSync(path.join(pilotRoot, file)), `missing ${file}`);

  const manifest = JSON.parse(fs.readFileSync(path.join(pilotRoot, "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ["192x192", "512x512"]);
  assert.deepEqual(pngSize("mobile-pilot/icons/app-icon-192.png"), { width: 192, height: 192 });
  assert.deepEqual(pngSize("mobile-pilot/icons/app-icon-512.png"), { width: 512, height: 512 });
});

test("mobile pilot scripts parse and use only bundled relative assets", () => {
  for (const file of ["mobile-pilot/app.js", "mobile-pilot/demo-data.js", "mobile-pilot/service-worker.js", "scripts/serve-mobile-pilot.cjs"]) {
    assert.doesNotThrow(() => new vm.Script(read(file), { filename: file }));
  }

  const html = read("mobile-pilot/index.html");
  assert.match(html, /rel="manifest" href="\.\/manifest\.webmanifest"/);
  assert.match(html, /src="\.\/demo-data\.js\?v=8"/);
  assert.match(html, /src="\.\/app\.js\?v=8"/);
  assert.match(html, /href="\.\/app\.css\?v=8"/);
  assert.doesNotMatch(html, /https?:\/\//i);

  const worker = read("mobile-pilot/service-worker.js");
  for (const asset of ["index.html", "app.css", "demo-data.js", "app.js", "manifest.webmanifest", "app-icon-192.png", "app-icon-512.png"]) {
    assert.match(worker, new RegExp(asset.replaceAll(".", "\\.")));
  }
});

test("mobile pilot bundles only synthetic fallback data and accepts a separate mobile file", () => {
  const data = read("mobile-pilot/demo-data.js");
  assert.match(data, /Synthetic demo data only/);
  assert.match(data, /demo:\s*true/);
  assert.match(data, /Тестовый врач/);
  assert.doesNotMatch(data, /\.sqlite|viewer_doctor_access|patientRegistry|source_files/i);

  const page = read("mobile-pilot/index.html");
  assert.match(page, /агрегированные показатели врача.+без списка пациентов/i);
  assert.match(page, /id="loadPublicationButton"/);
  assert.match(page, /accept="\.kvmobile,application\/json"/);
  assert.match(page, /accept="\.kvmobilebundle,application\/json"/);
  assert.match(page, /id="serverLoginForm"/);
  assert.match(page, /id="serverPin"/);
  assert.match(page, />Открыть отчёт</);
  assert.doesNotMatch(page, /Открыть тестовый отчёт|Открыть загруженный отчёт/);
  assert.doesNotMatch(page, /pilot-note|Безопасный макет/);
  assert.doesNotMatch(page, /ПАЦИЕНТЫ ДЛЯ РАБОТЫ|clientSegmentPatients/i);
  assert.match(page, />Комментарии</);
  assert.doesNotMatch(page, /Комментарий руководителя/);
  const app = read("mobile-pilot/app.js");
  assert.match(app, /klinvekt-mobile-publication/);
  assert.match(app, /patientRegistryIncluded !== false/);
  assert.match(app, /findForbiddenPublicationKey/);
  assert.match(app, /api\/admin\/publications\/uploads/);
  assert.match(app, /application\/octet-stream/);
  assert.match(app, /SHA-256/);
});

test("mobile pilot mirrors all aggregate doctor metrics without a patient registry", () => {
  const context = { window: {} };
  vm.runInNewContext(read("mobile-pilot/demo-data.js"), context);
  const demo = context.window.KLINVEKT_MOBILE_DEMO;

  assert.equal(demo.periods.length, 3);
  for (const period of demo.periods) {
    assert.equal(period.headlineMetrics.length, 5);
    assert.equal(period.vectors.length, 6);
    assert.ok(period.dynamics.rows.length >= 4);
    assert.ok(period.comments.length >= 1);
    for (const vector of period.vectors) {
      if (vector.id === "v4") {
        assert.deepEqual(Array.from(vector.windows, (item) => item.id), ["12", "24", "36"]);
        assert.ok(vector.windows.every((item) => item.sections.length >= 2));
      } else {
        assert.ok(vector.sections.length >= 1, `${period.id} ${vector.id} has no metric sections`);
      }
    }
  }

  const css = read("mobile-pilot/app.css");
  assert.match(css, /\.progress-track\s*\{[^}]*display:\s*block/s);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*?\.vector-grid\s*\{\s*grid-template-columns:\s*1fr/);
});

test("mobile publication format validates aggregates and rejects patient-bearing fields", () => {
  const context = { window: {} };
  vm.runInNewContext(read("mobile-pilot/demo-data.js"), context);
  const demo = JSON.parse(JSON.stringify(context.window.KLINVEKT_MOBILE_DEMO));
  const publication = {
    format: MOBILE_PUBLICATION_FORMAT,
    version: MOBILE_PUBLICATION_VERSION,
    createdAt: new Date(0).toISOString(),
    security: { patientRegistryIncluded: false, rawExportsIncluded: false },
    doctor: demo.doctor,
    periods: demo.periods,
  };

  assert.equal(validateMobilePublication(publication), publication);
  assert.match(serializeMobilePublication(publication), /"klinvekt-mobile-publication"/);

  publication.periods[0].comments = [{
    blockKey: "doctor.dynamics",
    title: "Динамика, точки роста и риска",
    text: "Сохранённый комментарий",
    author: "Администратор",
    updatedAt: new Date(0).toISOString(),
  }];
  assert.equal(validateMobilePublication(publication).periods[0].comments[0].text, "Сохранённый комментарий");

  const unsafe = JSON.parse(JSON.stringify(publication));
  unsafe.periods[0].vectors[3].patientRegistry = [{ patientId: "secret" }];
  assert.throws(() => validateMobilePublication(unsafe), /запрещённое поле/);
  const raw = JSON.parse(JSON.stringify(publication));
  raw.security.rawExportsIncluded = true;
  assert.throws(() => validateMobilePublication(raw), /отсутствие реестра пациентов/);
});

test("mobile publication keeps reading pre-parity version 1 files", () => {
  const context = { window: {} };
  vm.runInNewContext(read("mobile-pilot/demo-data.js"), context);
  const demo = JSON.parse(JSON.stringify(context.window.KLINVEKT_MOBILE_DEMO));
  for (const period of demo.periods) {
    delete period.comments;
    delete period.dynamics;
    delete period.goalsSource;
    period.goals = period.goals.map(({ title, description, progress }) => ({ title, description, progress }));
  }
  const publication = {
    format: MOBILE_PUBLICATION_FORMAT,
    version: MOBILE_PUBLICATION_VERSION,
    createdAt: new Date(0).toISOString(),
    security: { patientRegistryIncluded: false, rawExportsIncluded: false },
    doctor: demo.doctor,
    periods: demo.periods,
  };
  assert.equal(validateMobilePublication(publication), publication);
});

test("one mobile bundle encrypts every doctor publication with the existing PIN", () => {
  const context = { window: {} };
  vm.runInNewContext(read("mobile-pilot/demo-data.js"), context);
  const demo = JSON.parse(JSON.stringify(context.window.KLINVEKT_MOBILE_DEMO));
  const publication = {
    format: MOBILE_PUBLICATION_FORMAT,
    version: MOBILE_PUBLICATION_VERSION,
    createdAt: new Date(0).toISOString(),
    security: { patientRegistryIncluded: false, rawExportsIncluded: false },
    doctor: { id: "d1", ...demo.doctor },
    periods: demo.periods,
  };
  const second = JSON.parse(JSON.stringify(publication));
  second.doctor = { ...second.doctor, id: "d2", name: "Второй врач" };
  const bundle = createMobilePublicationBundle({
    publications: [{ doctorId: "d1", publication }, { doctorId: "d2", publication: second }],
    credentials: { doctors: [
      { doctorId: "d1", pinCode: "1234", pinVersion: 2 },
      { doctorId: "d2", pinCode: "5678", pinVersion: 1 },
    ] },
    appVersion: "2.6.0",
  });

  assert.equal(bundle.format, MOBILE_BUNDLE_FORMAT);
  assert.equal(MOBILE_BUNDLE_EXTENSION, "kvmobilebundle");
  assert.equal(validateMobilePublicationBundle(bundle), bundle);
  assert.equal(bundle.doctors.length, 2);
  assert.equal(decryptMobilePublication(bundle.doctors.find(item => item.doctorId === "d1"), "1234").doctor.name, demo.doctor.name);
  assert.equal(decryptMobilePublication(bundle.doctors.find(item => item.doctorId === "d2"), "5678").doctor.name, "Второй врач");
  assert.throws(() => decryptMobilePublication(bundle.doctors[0], "0000"), /Проверьте PIN/);
  const serialized = serializeMobilePublicationBundle(bundle);
  assert.doesNotMatch(serialized, /"pinCode"|"pinHash"|"patientsforwork"|"rawExports"\s*:/i);
});
