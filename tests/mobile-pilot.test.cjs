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
  encryptMobilePublication,
  openMobileReportSession,
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

test("mobile Safari layout reserves navigation space and keeps controls readable", () => {
  const css = read("mobile-pilot/app.css"), html = read("mobile-pilot/index.html"), app = read("mobile-pilot/app.js");
  assert.match(html, /<main id="reportScroller">/);
  assert.match(css, /body\s*\{[^}]*height:\s*100dvh[^}]*overflow:\s*hidden/s);
  assert.match(css, /main\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.bottom-nav\s*\{[^}]*flex:\s*0 0 auto/s);
  assert.doesNotMatch(css, /\.bottom-nav\s*\{[^}]*position:\s*fixed/s);
  for (const selector of ["\\.login-field", "\\.period-control select", "\\.team-reports select", "\\.chart-picker select"]) {
    assert.match(css, new RegExp(`${selector}\\s*\\{[^}]*font-size:\\s*16px`, "s"));
  }
  assert.doesNotMatch(html, /user-scalable=no|maximum-scale=1/);
  assert.doesNotMatch(app, /window\.scrollTo|\.scrollIntoView/);
  assert.match(app, /preserveAspectRatio="xMidYMid meet"/);
});

test("report navigation scrolls only the report container with header clearance", () => {
  const app = read("mobile-pilot/app.js");
  const source = app.slice(app.indexOf("  function scrollReportTo("), app.indexOf("  function formatCommentDate("));
  const calls = [];
  let reducedMotion = false;
  const context = { elements: { reportScroller: { scrollTop: 450, getBoundingClientRect: () => ({ top: 66 }), scrollTo: value => calls.push(value) } },
    window: { matchMedia: () => ({ matches: reducedMotion }) } };
  vm.runInNewContext(source, context);
  context.scrollReportTo({ getBoundingClientRect: () => ({ top: 166 }) });
  assert.equal(calls.at(-1).top, 538);
  assert.equal(calls.at(-1).behavior, "smooth");
  reducedMotion = true;
  context.scrollReportTo();
  assert.equal(calls.at(-1).top, 0);
  assert.equal(calls.at(-1).behavior, "auto");
});

test("installation help closes explicitly without form submission and restores focus", () => {
  const html = read("mobile-pilot/index.html"), app = read("mobile-pilot/app.js");
  assert.equal((html.match(/type="button" data-close-install/g) || []).length, 2);
  assert.doesNotMatch(html, /method="dialog"/);
  assert.match(app, /addEventListener\("cancel", event => \{ event\.preventDefault\(\); closeInstallHelp\(\); \}\)/);
  const source = app.slice(app.indexOf("  function showInstallHelp("), app.indexOf("  async function apiRequest("));
  let opened = 0, closed = 0, focused;
  const dialog = { open: false, showModal() { this.open = true; opened += 1; }, close() { this.open = false; closed += 1; } };
  const context = { elements: { installDialog: dialog, installButton: { focus: options => { focused = options; } } } };
  vm.runInNewContext(source, context);
  context.showInstallHelp(); context.showInstallHelp();
  assert.equal(opened, 1);
  context.closeInstallHelp(); context.closeInstallHelp();
  assert.equal(closed, 1);
  assert.equal(dialog.open, false);
  assert.equal(focused.preventScroll, true);
});

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
  assert.match(html, /src="\.\/demo-data\.js\?v=10"/);
  assert.match(html, /src="\.\/app\.js\?v=12"/);
  assert.match(html, /href="\.\/app\.css\?v=13"/);
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
    period.vectors.forEach(vector => (vector.windows ? vector.windows.flatMap(window => window.sections) : vector.sections).forEach(section => {
      delete section.tree;
      delete section.charts;
    }));
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

test("mobile visual schema rejects malformed trees, unsafe colors and invalid numbers", () => {
  const context = { window: {} };
  vm.runInNewContext(read("mobile-pilot/demo-data.js"), context);
  const base = { format: MOBILE_PUBLICATION_FORMAT, version: 1,
    security: { patientRegistryIncluded: false, rawExportsIncluded: false },
    ...JSON.parse(JSON.stringify(context.window.KLINVEKT_MOBILE_DEMO)) };
  for (const mutate of [
    file => { file.periods[0].vectors[1].sections[1].tree[0].values.pop(); },
    file => { file.periods[0].dynamics.charts[0].series[0].values.pop(); },
    file => { file.periods[0].dynamics.charts[0].series[0].values[0] = NaN; },
    file => { file.periods[0].dynamics.charts[0].series[0].color = "url(https://example.com)"; },
    file => { file.periods[0].vectors[1].sections[1].charts[0].series[0].values[0] = -10; },
    file => { file.periods[0].vectors[1].sections[1].tree[0].patientId = "must-not-leak"; },
    file => {
      let node = file.periods[0].vectors[1].sections[1].tree[0];
      for (let i = 0; i < 34; i++) { node.children = [{ label: "Группа", values: ["1", "2", "3"] }]; node = node.children[0]; }
    },
  ]) {
    const file = structuredClone(base);
    mutate(file);
    assert.throws(() => validateMobilePublication(file), /Некорректная мобильная публикация/);
  }
  const roundTrip = JSON.parse(serializeMobilePublication(base));
  assert.deepEqual(roundTrip.periods[0].vectors[2].sections[1].tree, base.periods[0].vectors[2].sections[1].tree);
  assert.deepEqual(roundTrip.periods[0].dynamics.charts, base.periods[0].dynamics.charts);
});

function mobileVisualContext() {
  const app = read("mobile-pilot/app.js");
  const context = vm.createContext({ Intl });
  vm.runInContext(`const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');\n`
    + app.slice(app.indexOf("  function legacyRevenueTree"), app.indexOf("  function renderSection")), context);
  return context;
}

test("mobile chart typography excludes icon strokes and keeps moderate font weights", () => {
  const css = read("mobile-pilot/app.css");
  const rule = selector => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
    assert.ok(match, `missing rule: ${selector}`);
    return match[1];
  };
  assert.match(rule(".chart-plot svg text"), /stroke:\s*none/);
  assert.match(rule(".chart-plot svg text"), /font-weight:\s*400/);
  for (const selector of [".chart-plot .donut-total", ".chart-legend b", ".bar-item b", ".chart-data th"]) {
    assert.match(rule(selector), /font-weight:\s*500/);
  }
  assert.match(rule(".report-chart h5"), /font-weight:\s*600/);
  assert.match(read("mobile-pilot/service-worker.js"), /klinvekt-mobile-pilot-v14/);
  assert.match(read("mobile-pilot/service-worker.js"), /app\.css\?v=13/);
});

test("mobile tree renderer supports nested native disclosures and old revenue markers", () => {
  const context = mobileVisualContext();
  const result = vm.runInContext(`(() => {
    const nodes = legacyRevenueTree({ title: 'Распределение выручки', rows: [
      ['Аппараты · итого', '2', '100 ₽', '100%'], ['↳ Кутера', '2', '100 ₽', '100%']
    ] });
    nodes[0].children[0].children = [{ label: '<img src=x onerror=alert(1)>', values: ['2', '100 ₽', '100%'] }];
    return { nodes, html: renderTree(nodes, ['Категория', 'Количество', 'Выручка', 'Доля']) };
  })()`, context);
  assert.equal(result.nodes[0].label, "Аппараты");
  assert.equal(result.nodes[0].children[0].label, "Кутера");
  assert.equal((result.html.match(/<details /g) || []).length, 2);
  assert.match(result.html, /data-tree-action="open"/);
  assert.match(result.html, /&lt;img/);
  assert.doesNotMatch(result.html, /<img/);
});

test("mobile SVG charts retain gaps, zeroes, exact tables and single-month values", () => {
  const context = mobileVisualContext();
  const result = vm.runInContext(`(() => {
    const chart = { id: 'money', title: 'Выручка', type: 'line', unit: '₽', labels: ['Янв', 'Фев', 'Мар'],
      series: [{ label: 'Собственная', color: '#2563eb', values: [0, null, 12345.67] }] };
    const gap = chartPlot(chart);
    const table = chartTable(chart);
    const single = chartPlot({ ...chart, labels: ['Мар'], series: [{ ...chart.series[0], values: [12345.67] }] });
    const signed = chartPlot({ ...chart, type: 'mirror', series: [{ ...chart.series[0], side: 'own', values: [1, null, -2] }] });
    return { gap, table, single, signed };
  })()`, context);
  assert.match(result.gap, /d="M[^"L]+M/);
  assert.equal((result.gap.match(/<circle /g) || []).length, 4); // desktop + compact SVG, two known values each
  assert.match(result.table, /12 345,67/);
  assert.match(result.table, /<td>—<\/td>/);
  assert.equal((result.single.match(/<circle /g) || []).length, 2);
  assert.doesNotMatch(result.gap + result.single, /NaN|Infinity/);
  assert.match(result.signed, /отрицательные корректировки/);
});

test("mobile dynamics remains visible without an overall score", () => {
  const source = read("mobile-pilot/app.js");
  const elements = Object.fromEntries(["trendChart", "trendLabels", "trendValue", "trendCaption", "desktopCharts", "comparisonList", "dynamicsInsights"].map(id => [id, { innerHTML: "stale", style: {} }]));
  const period = { id: "2026-03", overall: null, dynamics: { columns: ["Март"], rows: [{ label: "Выручка", values: ["10 ₽"], delta: "—" }], charts: [] } };
  const context = vm.createContext({ elements, currentPeriod: () => period, reportData: { periods: [period] }, escapeHtml: String, renderCharts: () => "charts", bindCharts: () => {} });
  vm.runInContext(source.slice(source.indexOf("  function renderTrend()"), source.indexOf("  function renderGoals")) + "\nrenderTrend();", context);
  assert.match(elements.comparisonList.innerHTML, /10 ₽/);
  assert.equal(elements.trendValue.textContent, "—");
  assert.equal(elements.desktopCharts.innerHTML, "charts");
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
  assert.equal(openMobileReportSession(bundle, "d1", "1234").readReport("d1").doctor.name, demo.doctor.name);
  assert.equal(openMobileReportSession(bundle, "d2", "5678").readReport("d2").doctor.name, "Второй врач");
  assert.throws(() => openMobileReportSession(bundle, "d1", "0000"), /Проверьте PIN/);
  const serialized = serializeMobilePublicationBundle(bundle);
  assert.doesNotMatch(serialized, /"pinCode"|"pinHash"|"patientsforwork"|"rawExports"\s*:/i);
  const legacyRecord = encryptMobilePublication(publication, { doctorId: "d1", pinCode: "1234", pinVersion: 2 });
  assert.equal(decryptMobilePublication(legacyRecord, "1234").doctor.name, demo.doctor.name);
  const clone = () => JSON.parse(serialized);
  for (const mutate of [
    value => { value.bundleId += "changed"; },
    value => { value.doctors.find(item => item.doctorId === "d1").displayName = "Подмена"; },
    value => { const record = value.doctors.find(item => item.doctorId === "d1"); record.ciphertext = (record.ciphertext[0] === "A" ? "B" : "A") + record.ciphertext.slice(1); },
  ]) {
    const value = clone(); mutate(value);
    assert.throws(() => openMobileReportSession(value, "d1", "1234"), /Проверьте PIN/);
  }
  const swapped = clone();
  swapped.reports[0].ciphertext = swapped.reports[1].ciphertext;
  assert.throws(() => openMobileReportSession(swapped, "d1", "1234").readReport("d1"));
  assert.throws(() => openMobileReportSession(bundle, "d1", "1234").readReport("d2"), /Нет доступа/);
  const malformed = clone();
  malformed.doctors[0].encryption.params.N = 2 ** 28;
  assert.throws(() => validateMobilePublicationBundle(malformed), /параметры PIN/);
});

test("mobile vectors advertise an action and head report controls start hidden", () => {
  const source = read("mobile-pilot/app.js");
  assert.match(source, /Открыть показатели/);
  assert.match(source, /Показатели открыты/);
  assert.match(source, /aria-controls="vectorDetail"/);
  assert.match(read("mobile-pilot/app.css"), /\.vector-card:focus-visible/);
  assert.match(read("mobile-pilot/index.html"), /class="team-reports hidden" id="teamReports"/);
  assert.match(source, /encodeURIComponent\(doctorId\)/);
  assert.match(read("build/app-ui.js"), /department: resolvedDepartmentName\(doctorId\), publication: buildMobilePublication/);
  assert.match(read("desktop/main.cjs"), /viewerExportCredentials\(recipientIds, \{ requireAdmin: false \}\)/);
});
