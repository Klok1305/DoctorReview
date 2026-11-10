"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { webkit, devices } = require("@playwright/test");
const { createMobileServer } = require("../mobile-server/server.cjs");
const crypto = require("node:crypto");
const { createCloudPublication, cloudAccountsFromViewer, PIN_PARAMS } = require("../desktop/services/cloud-publication-service.cjs");
const root = path.resolve(__dirname, "..");
const layoutResults = [];
function legacyClientBaseHtml() {
  const groups = require("../mobile-pilot/report-presentation.js").clientBaseGroups;
  const current = [20,20,30,30], previous = [10,30,40,20];
  return `<div class="viewer-dashboard-snapshot"><div class="card" data-vector-key="v4" data-client-base-methodology="partition-v1-36m" data-legacy-v4-fixture>
    <h3>Вектор 4 · прежний HTML</h3><p data-client-base-methodology-note>Методика блока: partition-v1-36m, балл legacy-overlap-v1.</p>
    <div class="kb-vector-key-note">Ключевые показатели Вектора 4</div><div class="kb-summary-grid">${groups.map((group,i)=>`<div class="kb-summary-card" data-client-base-group="${group.key}"><b>${group.label}</b><div class="kb-summary-value">${current[i]} чел.</div><div class="kb-share-comparison"><span>Январь 2026: ${previous[i]}%</span><span>Февраль 2026: ${current[i]}%</span></div><p class="kb-summary-meta">Прежнее пояснение группы</p></div>`).join("")}</div>
    <div class="kb-share-history"><h3>Как меняется доля каждой аудитории</h3><div class="chart-box"><svg class="old-line-marker" viewBox="0 0 100 30"><path d="M0,0L100,30"/></svg></div>
    <div class="primary-patients-scroll"><table class="data"><thead><tr><th>Аудитория</th><th>Январь 2026</th><th>Февраль 2026</th></tr></thead><tbody>${groups.map((group,i)=>`<tr><td>${group.label}</td><td>${previous[i]}%</td><td>${current[i]}%</td></tr>`).join("")}</tbody></table></div></div>
    <div><h3>ДИНАМИКА КЛИЕНТСКОЙ БАЗЫ ПО МЕСЯЦАМ</h3><p class="small muted">Каждая полоса — вся база.</p><div class="chart-box"><svg class="old-line-marker"></svg></div></div></div></div>`;
}
async function auditLayout(page, state, report = false) {
  const originalViewport = page.viewportSize();
  const originalName = await page.locator("#onlineUser").textContent();
  const selectedScope = page.locator("#onlineScope option:checked");
  const originalScope = await selectedScope.count() ? await selectedScope.textContent() : null;
  if (originalName) await page.locator("#onlineUser").evaluate(element => {
    element.textContent = "Александрова-Константинопольская Александра Александровна";
  });
  if (originalScope) await page.locator("#onlineScope option:checked").evaluate(element => {
    element.textContent = "Александрова-Константинопольская Александра Александровна";
  });
  const viewports = process.argv.includes("--layout")
    ? [[320,720],[360,800],[390,844],[430,932],[768,1024],[1040,900],[1280,800],[1440,1000],[1920,1080],[844,390],[568,320]] : [[320,720],[568,320]];
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height });
    const geometry = await page.evaluate(() => {
      const visible = element => element.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility !== "hidden";
      const outside = [...document.querySelectorAll("header,header button,.controls select,#onlineLoginForm,#onlineUploadPanel")]
        .filter(visible).filter(element => { const rect = element.getBoundingClientRect(); return rect.left < -2 || rect.right > innerWidth + 2; })
        .map(element => element.id || element.tagName);
      return { overflow: document.documentElement.scrollWidth - innerWidth, outside, frameHeight: document.getElementById("onlineFrame").clientHeight,
        shellOverflowing: [...document.querySelectorAll("body *")].filter(element => element.getBoundingClientRect().right > innerWidth + 2 && !element.closest(".pins-scroll"))
          .slice(0,12).map(element => ({ tag: element.tagName, id: element.id, className: element.className, width: element.getBoundingClientRect().width })) };
    });
    const reportFrame = report && page.frames().find(frame => frame.parentFrame() === page.mainFrame());
    const reportGeometry = reportFrame ? await reportFrame.evaluate(() => ({ reportOverflow: document.documentElement.scrollWidth - innerWidth,
      overflowing: [...document.querySelectorAll("body *")].filter(element => element.getBoundingClientRect().right > innerWidth + 2 && !element.closest(".cloud-table-scroll,.chart-data-scroll,.department-year-scroll,.reputation-table-scroll,.specialization-table-scroll"))
        .slice(0,12).map(element => ({ tag: element.tagName, className: element.className, width: element.getBoundingClientRect().width }))
    })) : { reportOverflow: 0 };
    layoutResults.push({ state, width, height, ...geometry, ...reportGeometry });
    await page.screenshot({ path: path.join(root,"tmp",`online-layout-${state}-${width}.png`) });
  }
  if (report) {
    await page.locator("#onlineFrame").scrollIntoViewIfNeeded();
    assert.ok(await page.locator("#onlineFrame").evaluate(element => {
      const rect = element.getBoundingClientRect(); return Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0) >= 180;
    }), "report remains reachable by scrolling the shell on a short landscape screen");
    await page.screenshot({ path: path.join(root,"tmp",`online-layout-${state}-landscape-report.png`) });
    await page.evaluate(() => scrollTo(0, 0));
  }
  await page.locator("#onlineUser").evaluate((element, name) => { element.textContent = name; }, originalName);
  if (originalScope) await page.locator("#onlineScope option:checked").evaluate((element, name) => { element.textContent = name; }, originalScope);
  await page.setViewportSize(originalViewport);
}

async function main() {
  require("./build-mobile-server-package.cjs");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "klinvekt-cloud-webkit-"));
  const samplePath = path.join(root, "tmp", "cloud-publication-smoke.kvcloud");
  const sample = fs.existsSync(samplePath) ? JSON.parse(fs.readFileSync(samplePath, "utf8")) : null;
  const samplePage = sample?.pages.filter(page => page.kind === "doctor"
    && page.report?.numbers?.metrics.some(metric => metric.id === "primary.year.count" && metric.value > 0)
    && page.report.vectors[3]?.windows?.some(window => window.sections.some(section => section.charts?.some(chart => chart.id === "overlap-shares")))).at(-1)
    || sample?.pages.find(page => page.kind === "doctor");
  const html = ((samplePage?.report ? require("../mobile-server/cloud-report-renderer.cjs").renderCloudReport(samplePage.report, samplePage.title) : samplePage?.html)
    || '<div class="viewer-dashboard-snapshot"><div class="card"><h2>Синтетический отчёт</h2><p>43 визита</p><p>Комментарий администратора</p></div></div>')
    + '<section class="reputation-honor-board"><h2>Доска почёта · старый HTML</h2></section>'
    + legacyClientBaseHtml()
    + `<div class="viewer-dashboard-snapshot"><div data-vector-key="v3" data-legacy-v3-fixture>
      <div class="vhead"><h3>Вектор 3</h3><span class="vscore">5<span> из 6 фокусов</span></span></div>
      <details class="collapsible-list" data-list-key="appointmentConversionBlock" open><summary>Планы лечения <span class="section-detail">· окно 1 мес.</span><strong class="appointment-conversion-summary-value">75%</strong></summary>
      <div class="appointment-conversion-body"><div class="tracked-metric"><div class="tracked-note">Услуги: выполнено + продано · 6 из 8</div><div class="tracked-goal">цель ≥ 30%</div></div>
      <details class="collapsible-list" data-list-key="appointmentDetails" open><summary>Детализация по услугам и группам 1С</summary><p>Группа 1С</p></details>
      <h3 class="appointment-focus-title">Фокусы междисциплинарного подхода</h3><div class="grid">Список фокусов</div></div></details>
      <section class="completed-referrals-section"><h3>Выполненные планы</h3><p>Сентябрь 2026 · источник: отчёт «Выработка»</p>
      <div class="tracked-metric"><div class="tracked-note">Учтено 200 ₽ из 300 ₽ выполненных</div><strong class="tracked-value">20%</strong></div><div>Позиции из выработки</div></section>
      </div></div>`
    + '<div class="viewer-dashboard-snapshot"><div class="card" data-legacy-specialization-fixture><table class="data" id="tblRisk"><tr><th>Специалист</th><th>Период</th><th>Общая база</th><th>Активные</th></tr><tr><td>Врач А</td><td>12 мес.</td><td><b>3</b></td><td><b>1</b><br><span class="small muted">33,3%</span></td></tr><tr><td>Врач Б</td><td>12 мес.</td><td><b>5</b></td><td><b>0</b><br><span class="small muted">0%</span></td></tr></table><table id="tblCompare"><tr><th>Метрика</th><th>Итог</th><th>Врач А</th></tr><tr><td>Визиты за месяц</td><td>7</td><td>3</td></tr><tr><td>Пациенты за месяц</td><td>3</td><td>2</td></tr></table></div></div>'
    + '<section class="reputation-report" data-legacy-reputation-fixture><table><tr><th>Сотрудник</th><th>Всего отзывов</th><th>Общий балл</th></tr><tr><td>Врач В</td><td>5 шт.</td><td>100</td></tr><tr><td>Врач Б</td><td>50 шт.</td><td>10</td></tr><tr><td>Врач А</td><td>50 шт.</td><td>1</td></tr></table></section>'
    + '<div class="card"><table class="data" id="tblDepartmentYear"><tr><th>Выручка с перенаправлениями</th><th>Доля перенаправлений от выручки</th><th>Возвращаемость первички за 3 месяца</th></tr><tr><td>3 000 ₽</td><td>20%</td><td>50%</td></tr></table></div>';
  const publication = createCloudPublication({ appVersion: "test", doctors: [
    { doctorId: "a", displayName: "Врач А", department: "A", specialization: "X" },
    { doctorId: "b", displayName: "Врач Б", department: "B", specialization: "Y" },
  ], accounts: [
    { userId: "1", doctorId: "a", admin: false, departments: [], specializations: [] },
    { userId: "2", doctorId: "", admin: true, departments: [], specializations: [] },
  ], pages: ["2026-01", "2026-03"].flatMap(periodKey => [
    { kind: "doctor", doctorId: "a", department: "A", specialization: "X", periodKey, title: `Врач А · ${periodKey}`, html },
    { kind: "doctor", doctorId: "b", department: "B", specialization: "Y", periodKey, title: `Врач Б · ${periodKey}`, html },
    { kind: "specialization", doctorId: "", department: "", specialization: "X", periodKey, title: `Специализация X · ${periodKey}`,
      html: html + '<div class="viewer-dashboard-snapshot"><table data-archived-score-table><tr><td>Общий балл</td><td>78</td></tr></table><div data-archived-score-chart><h3>СРЕДНИЕ БАЛЛЫ ПО ВЕКТОРАМ ПО МЕСЯЦАМ</h3><div class="chart-box score-chart"></div></div></div>' },
    { kind: "clinic", doctorId: "", department: "", specialization: "", periodKey, title: `Вся клиника · ${periodKey}`, html },
  ]) });
  fs.writeFileSync(path.join(dataDir, "publications.kvcloud"), JSON.stringify({ portalId: "test-portal", publication }));
  const server = createMobileServer({ dataDir, cloudPortalId: "test-portal", trustLocal: true, staticRoot: path.join(root, "tmp", "klinvekt-mobile-server", "public") });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser, iframeServer;
  try {
    browser = await webkit.launch({ headless: true });
    const base = `http://127.0.0.1:${server.address().port}`;
    const context = await browser.newContext({ ...devices["iPhone 13"], extraHTTPHeaders: {
      "X-Vibe-User-Id": "1", "X-Vibe-Portal-Id": "test-portal", "X-Vibe-User-Name-Encoded": encodeURIComponent("Врач А") } });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(base);
    await page.locator("#onlineScope:not([disabled])").waitFor();
    assert.equal(await page.locator("#onlineScope option").count(), 1);
    assert.equal(await page.locator("#onlinePeriod option").count(), 2);
    assert.equal(await page.locator("#onlineUploadPanel").isVisible(), false);
    await page.frameLocator("#onlineFrame").locator("body.online-report").waitFor();
    const narrow = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth,
      frameHeight: document.getElementById("onlineFrame").clientHeight }));
    assert.ok(narrow.overflow <= 2); assert.ok(narrow.frameHeight > 200);
    const frame = page.frameLocator("#onlineFrame");
    const legacyV3 = frame.locator("[data-legacy-v3-fixture]");
    await legacyV3.locator('[data-v3-section="focus"]').waitFor();
    assert.deepEqual(await legacyV3.locator("[data-v3-section]").evaluateAll(elements => elements.map(element => element.dataset.v3Section)), ["focus", "revenue", "conversion"]);
    assert.equal(await legacyV3.locator('[data-v3-section="focus"] strong').textContent(), "5 из 6");
    assert.equal(await legacyV3.locator('[data-v3-section="revenue"] strong').textContent(), "20%");
    const legacyConversion = legacyV3.locator('[data-v3-section="conversion"]');
    assert.equal(await legacyConversion.evaluate(element => element.open), false);
    await legacyConversion.locator(":scope > summary").click();
    const legacyBreakdown = legacyConversion.locator('[data-list-key="appointmentDetails"]');
    assert.equal(await legacyBreakdown.evaluate(element => element.open), false);
    await legacyBreakdown.locator("summary").click();
    await legacyBreakdown.locator("p").waitFor({ state: "visible" });
    await legacyConversion.locator(":scope > summary").click();
    assert.equal(await frame.locator(".reputation-honor-board").count(), 0, "old HTML publications must also lose the honor board");
    assert.equal(await frame.locator("#tblDepartmentYear .report-table-heading-line").count(), 6);
    assert.equal(await frame.locator("[data-viewer-patient-register]").count(), 0);
    const legacyBase = frame.locator("[data-legacy-v4-fixture]");
    await legacyBase.locator("[data-client-base-composition] svg").waitFor();
    assert.equal(await legacyBase.locator('[data-client-base-group="active"] .kb-summary-value').textContent(), "20%");
    const legacySpecialization = frame.locator("[data-legacy-specialization-fixture]");
    assert.equal(await legacySpecialization.locator(".client-base-average strong").textContent(), "16,7%");
    assert.deepEqual(await legacySpecialization.locator("#tblRisk .client-base-cell-share").allTextContents(), ["33,3%", "0%"]);
    assert.deepEqual(await legacySpecialization.locator("#tblCompare tr:last-child td").allTextContents(), ["Визитов на пациента", "2,33", "1,5"]);
    assert.equal(await legacyBase.locator(".old-line-marker").count(), 0);
    assert.equal(await legacyBase.locator("[data-client-base-methodology-note]").isVisible(), false);
    assert.equal(await legacyBase.locator("[data-report-help]").evaluate(element => element.open), false);
    assert.doesNotMatch(await legacyBase.innerText(), /partition-v1|legacy-overlap/);
    assert.equal(await legacyBase.locator("[data-client-base-legacy-note]").isVisible(),true);
    assert.deepEqual(await frame.locator("[data-legacy-reputation-fixture] tr td:first-child").allTextContents(),["Врач А","Врач Б","Врач В"]);
    assert.equal(await legacyBase.locator('tr[data-client-base-group="active"] td.period-best').textContent(), "20%");
    assert.equal(await legacyBase.locator('tr[data-client-base-group="lost"] td.period-best').textContent(), "20%");
    assert.equal(await legacyBase.locator('tr[data-client-base-group="lost"] td.period-worst').textContent(), "30%");
    const headerKpisFit = await frame.locator(".gauge-wrap .kpi").evaluateAll(elements => elements.every(element => {
      const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth;
    }));
    assert.ok(headerKpisFit, "doctor header KPI cards must fit the phone report viewport");
    await auditLayout(page, "legacy-report", true);
    await page.locator("#onlinePeriod").selectOption("2026-01");
    await page.waitForFunction(() => document.getElementById("onlineStatus").textContent.includes("2026-01"));
    await page.setViewportSize({ width: 844, height: 390 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 2));
    fs.mkdirSync(path.join(root, "tmp"), { recursive: true });
    await page.screenshot({ path: path.join(root, "tmp", "cloud-online-landscape.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(root, "tmp", "cloud-online-iphone.png") });
    await context.close();
    const admin = await browser.newContext({ viewport: { width: 1440, height: 1000 }, extraHTTPHeaders: {
      "X-Vibe-User-Id": "2", "X-Vibe-Portal-Id": "test-portal" } });
    const adminPage = await admin.newPage(); await adminPage.goto(base);
    await adminPage.locator("#onlineScope:not([disabled])").waitFor();
    assert.equal(await adminPage.locator("#onlineScope option").count(), 4);
    await adminPage.locator("#onlineScope").selectOption({ label: "Специализация X" });
    const archivedSpecialization = adminPage.frameLocator("#onlineFrame");
    await archivedSpecialization.locator("[data-archived-score-table]").waitFor();
    assert.equal(await archivedSpecialization.locator("[data-archived-score-chart]").count(), 0);
    assert.match(await archivedSpecialization.locator("[data-archived-score-table]").textContent(), /Общий балл78/);
    await adminPage.locator("#onlineUploadPanel > summary").click();
    await adminPage.locator("#onlineUploadFile").setInputFiles({ name: "database.json", mimeType: "application/json", buffer: Buffer.from('{"format":"klinvekt-portable-json"}') });
    await adminPage.locator("#onlineUploadButton").click();
    await adminPage.waitForFunction(() => document.getElementById("onlineUploadStatus").textContent.includes("Полная копия базы"));
    const updated = structuredClone(publication); updated.pages = updated.pages.filter(page => page.periodKey === "2026-03");
    await adminPage.locator("#onlineUploadFile").setInputFiles({ name: "anonymous.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(updated)) });
    await adminPage.locator("#onlineUploadButton").click();
    await adminPage.waitForFunction(() => document.getElementById("onlineUploadStatus").textContent.includes("Загружено:"));
    await adminPage.waitForFunction(() => document.querySelectorAll("#onlinePeriod option").length === 1);
    await adminPage.frameLocator("#onlineFrame").locator("body.online-report").waitFor();
    await adminPage.screenshot({ path: path.join(root, "tmp", "cloud-online-admin.png") });
    const verifier = pin => {
      const salt = crypto.randomBytes(24);
      return { pinSalt: salt.toString("base64"), pinHash: crypto.scryptSync(pin, salt, 64, { ...PIN_PARAMS, maxmem: 64 * 1024 * 1024 }).toString("base64"), pinParams: PIN_PARAMS };
    };
    const accounts = cloudAccountsFromViewer(publication.doctors, {}, { admin: verifier("654321"),
      doctors: publication.doctors.map(doctor => ({ doctorId: doctor.doctorId, ...verifier("0123"), headDepartments: [] })) });
    const pinPublication = createCloudPublication({ ...publication, version: 2, accounts });
    await adminPage.locator("#onlineUploadFile").setInputFiles({ name: "pin-publication.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(pinPublication)) });
    await adminPage.locator("#onlineUploadButton").click();
    await adminPage.locator("#onlineLoginForm").waitFor({ state: "visible" });
    assert.equal(await adminPage.locator("#onlineFrame").isVisible(), false);
    const pinContext = await browser.newContext({ ...devices["iPhone 13"], extraHTTPHeaders: {
      "X-Vibe-User-Id": "999", "X-Vibe-Portal-Id": "test-portal" } });
    const pinPage = await pinContext.newPage(); pinPage.on("pageerror", error => errors.push(error.message));
    await pinPage.goto(base); await pinPage.locator("#onlineLoginForm").waitFor({ state: "visible" });
    await auditLayout(pinPage, "login");
    assert.equal(await pinPage.locator("#onlineAccount option").count(), 3);
    await pinPage.locator("#onlineAccount").selectOption("doctor:a");
    await pinPage.locator("#onlinePin").fill("9999"); await pinPage.locator("#onlineLoginButton").click();
    await pinPage.waitForFunction(() => document.getElementById("onlineLoginStatus").textContent.includes("Неверный PIN"));
    assert.equal(await pinPage.locator("#onlinePin").inputValue(), "");
    await pinPage.locator("#onlinePin").fill("0123"); await pinPage.locator("#onlineLoginButton").click();
    await pinPage.locator("#onlineScope:not([disabled])").waitFor();
    assert.equal(await pinPage.locator("#onlineScope option").count(), 1);
    assert.equal(await pinPage.locator("#onlineUploadPanel").isVisible(), false);
    assert.equal(await pinPage.locator("#onlineUser").textContent(), "Врач А");
    await pinPage.frameLocator("#onlineFrame").locator("body.online-report").waitFor();
    assert.ok(await pinPage.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 2 && document.getElementById("onlineFrame").clientHeight > 200));
    await pinPage.screenshot({ path: path.join(root, "tmp", "cloud-online-pin-doctor.png") });
    await pinPage.reload(); await pinPage.locator("#onlineScope:not([disabled])").waitFor();
    await pinPage.locator("#onlineLogout").click(); await pinPage.locator("#onlineLoginForm").waitFor({ state: "visible" });
    assert.equal(await pinPage.locator("#onlineFrame").isVisible(), false);
    await pinPage.locator("#onlineAccount").selectOption("admin");
    await pinPage.locator("#onlinePin").fill("654321"); await pinPage.locator("#onlineLoginButton").click();
    await pinPage.locator("#onlineScope:not([disabled])").waitFor();
    assert.equal(await pinPage.locator("#onlineScope option").count(), 4);
    await pinPage.locator("#onlineUploadPanel > summary").click();
    const pinUpdated = structuredClone(pinPublication); pinUpdated.pages = pinUpdated.pages.filter(page => page.periodKey === "2026-03");
    await pinPage.locator("#onlineUploadFile").setInputFiles({ name: "anonymous-pin.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(pinUpdated)) });
    await pinPage.locator("#onlineUploadButton").click();
    await pinPage.locator("#onlineLoginForm").waitFor({ state: "visible" });
    await pinPage.locator("#onlinePin").fill("654321"); await pinPage.locator("#onlineLoginButton").click();
    await pinPage.locator("#onlineScope:not([disabled])").waitFor();
    assert.equal(await pinPage.locator("#onlinePeriod option").count(), 1);
    await pinPage.locator("#onlineUploadPanel > summary").click();
    await pinPage.screenshot({ path: path.join(root, "tmp", "cloud-online-pin-admin.png") });
    const numericReport = structuredClone(samplePage?.report || { id: "2026-03", label: "Март 2026", shortLabel: "Март",
      overall: 80, assessment: "Синтетический отчёт", summary: "Проверка числового JSON", headlineMetrics: [],
      vectors: Array.from({ length: 6 }, (_, i) => ({ id: `v${i + 1}`, number: i + 1, title: `Вектор ${i + 1}`, score: 80, sections: [] })), goals: [], comments: [] });
    numericReport.id = "2026-09";
    numericReport.label = "Сентябрь 2026"; numericReport.shortLabel = "Сентябрь";
    delete numericReport.vectors[2].sections;
    Object.assign(numericReport.vectors[2], {
      windowPickerLabel: "Окно назначений",
      windows: [1, 3].map(window => ({
        id: String(window), label: `${window} мес.`, period: `Сентябрь 2026 · ${window} мес.`,
        sections: [
          { title: `Конверсия назначений · ${window} мес.`, metrics: [
            { label: "Конверсия", value: window === 1 ? "75%" : "50%", target: "цель ≥ 30%", state: "good" },
            { label: "Назначено", value: "8" }, { label: "Результат", value: window === 1 ? "6" : "4" },
          ] },
          { title: "Детали назначений", columns: ["Группа", "Назначено"], rows: [["Группа 1С", "8"]] },
          { title: "Фокусы междисциплинарного подхода", metrics: [{ label: "Позиций выполнено", value: window === 1 ? "5 из 6" : "6 из 6" }],
            columns: ["Фокус", "Назначено"], rows: [["Фокус А", "4"]] },
          { title: "Выполненные направления", metrics: [
            { label: "Выполнено по выработке", value: "300 ₽" }, { label: "Учтено в перенаправлениях", value: "200 ₽" },
            { label: "Выручка с перенаправлениями", value: "1 000 ₽" }, { label: "Доля выручки", value: "20%" },
          ], columns: ["Тип", "Учтено"], rows: [["Услуги", "200 ₽"]] },
        ],
      })),
    });
    numericReport.vectors[0].sections.push({ title: "Годовая таблица показателей", columns: ["Выручка с перенаправлениями", "Доля перенаправлений от выручки", "Возвращаемость первички за 3 месяца"], rows: [["3 000 ₽", "20%", "50%"]] });
    numericReport.vectors[0].sections.push({ title: "Точные данные графика", charts: [{ id: "precision", title: "Проверка графика", type: "line",
      labels: ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь"], unit: "₽", series: [
        { label: "Первая серия", color: "#2563eb", values: [25.25, null, 31.375, 35, 36, 37, 38, 39, 40] },
        { label: "Вторая серия", color: "#16a34a", values: [100, null, 150, 160, 170, 180, 190, 200, 210] },
      ] }] });
    const specializationReport = structuredClone(numericReport);
    const chartLabels = ["Январь 2026", "Февраль 2026", "Март 2026"];
    specializationReport.vectors[1].sections.push({ title: "Загрузка аппаратов", charts: [{
      id: "specialization-devices-0", title: "Выручка по аппаратам", type: "line", labels: chartLabels, unit: "₽",
      series: [{ label: "Аппарат А", color: "#2563eb", values: [15000, null, 25000], pointNotes: ["3 шт.", "", "5 шт."] }],
    }] });
    specializationReport.vectors[4].sections.push({ title: "Первичные пациенты", columns: ["Врач", "Первичных за месяц"],
      rows: [["Итого по специализации", "7"]], charts: [{
        id: "specialization-primary", title: "Первичные пациенты по месяцам", type: "line", labels: chartLabels, unit: "чел.",
        series: [{ label: "Первичные пациенты", color: "#2563eb", values: [8, null, 7] },
          { label: "Из них с 4+ посещениями", color: "#16a34a", values: [2, null, 1], pointNotes: ["25% от первичных", "", "14,3% от первичных"] }],
      }] });
    const baseLabels = Array.from({ length: 36 }, (_, i) => {
      const date = new Date(Date.UTC(2023, 9 + i));
      return date.toLocaleDateString("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" }).replace(/ г\.$/, "");
    });
    Object.assign(specializationReport.vectors[3], {
      methodologyId: "report-overlap-v1", sections: [],
      windows: [36, 12].map(window => ({ id: String(window), label: `${window} мес.`, period: `Давность посещений · ${window} мес.`,
        sections: [{ title: "Динамика клиентской базы", charts: [{ id: "specialization-base-history", type: "line", unit: "чел.",
          title: `«Давность посещений» · ${window} мес. · Октябрь 2023 — Сентябрь 2026`, labels: baseLabels,
          series: [{ label: "Активная база", color: "#16a34a", values: [...Array(33).fill(null), window, null, 10] }],
        }] }],
      })),
    });
    const dataPublication = createCloudPublication({ ...pinPublication, version: 3, pages: pinUpdated.pages.map(({ html, id, ...metadata }) =>
      ({ ...metadata, periodKey: "2026-09", report: metadata.kind === "specialization" ? specializationReport : numericReport })) });
    if (!await pinPage.locator("#onlineUploadPanel").evaluate(element => element.open)) await pinPage.locator("#onlineUploadPanel > summary").click();
    await pinPage.locator("#onlineUploadFile").setInputFiles({ name: "numeric-json.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(dataPublication)) });
    await pinPage.locator("#onlineUploadButton").click();
    await pinPage.locator("#onlineLoginForm").waitFor({ state: "visible" });
    await pinPage.locator("#onlineAccount").selectOption("doctor:a");
    await pinPage.locator("#onlinePin").fill("0123"); await pinPage.locator("#onlineLoginButton").click();
    const numericFrame = pinPage.frameLocator("#onlineFrame");
    await numericFrame.locator(".cloud-data-report").waitFor();
    const numericV3 = numericFrame.locator('[data-vector-key="v3"]');
    const visibleV3 = numericV3.locator("[data-v3-section]:visible");
    assert.deepEqual(await visibleV3.evaluateAll(elements => elements.map(element => element.dataset.v3Section)), ["focus", "revenue", "conversion"]);
    assert.deepEqual(await visibleV3.locator("summary strong").allTextContents(), ["5 из 6", "20%", "75%"]);
    const revenueSummary = numericV3.locator('[data-v3-section="revenue"] > summary');
    const revenueText = await revenueSummary.textContent();
    await numericV3.locator("[data-v3-window]").selectOption("3");
    assert.deepEqual(await visibleV3.locator("summary strong").allTextContents(), ["6 из 6", "20%", "50%"]);
    assert.equal(await revenueSummary.textContent(), revenueText);
    const conversion = numericV3.locator('[data-v3-section="conversion"]:visible');
    assert.equal(await conversion.evaluate(element => element.open), false);
    await conversion.locator(":scope > summary").click();
    const breakdown = conversion.locator("details");
    assert.equal(await breakdown.evaluate(element => element.open), false);
    await breakdown.locator("summary").click();
    await breakdown.locator("td", { hasText: "Группа 1С" }).waitFor({ state: "visible" });
    await conversion.locator(":scope > summary").click();
    await auditLayout(pinPage, "numeric-report", true);
    assert.equal(await pinPage.locator("#onlineScope option").count(), 1);
    assert.equal(await numericFrame.locator("[data-viewer-patient-register], [data-primary-patient-register], canvas, img").count(), 0);
    if (samplePage?.report) {
      const primarySection = numericFrame.locator(".cloud-section").filter({ has: numericFrame.locator("h3", { hasText: "Первичные пациенты врача" }) });
      assert.equal(await primarySection.count(), 1);
      const primaryTotal = samplePage.report.numbers.metrics.find(metric => metric.id === "primary.year.count");
      assert.ok(primaryTotal, "new online reports retain numeric primary cohort");
      assert.match(await primarySection.textContent(), /1[\s\S]*2[\s\S]*3 и более/);
      const clientBase = numericFrame.locator('[data-vector-key="v4"]');
      await clientBase.locator("[data-client-base-definitions]").waitFor();
      const sourceBase = samplePage.report.vectors[3].windows[0].sections[0];
      assert.equal(await clientBase.locator("[data-client-base-composition]").count(), 0);
      const visibleBase = clientBase.locator('[data-client-base-window-panel="12"]');
      const history = sourceBase.charts.find(chart=>chart.id==='overlap-shares');
      assert.deepEqual(await visibleBase.locator("[data-client-base-share-table] tbody tr").evaluateAll(rows=>rows.map(row=>JSON.parse(row.dataset.periodValues))),history.series.map(series=>series.values));
      assert.equal(await clientBase.locator("[data-report-help]").evaluate(element=>element.open), false);
      assert.equal(await visibleBase.locator("[data-client-base-share-table] tbody tr").count(), 5);
      await clientBase.locator("[data-client-base-window]").selectOption("36");
      assert.equal(await visibleBase.isVisible(),false);
      assert.equal(await clientBase.locator('[data-client-base-window-panel="36"]').isVisible(),true);
      await clientBase.locator("[data-client-base-window]").selectOption("6");
      const shortRows=clientBase.locator('[data-client-base-window-panel="6"] .cloud-section').first().locator('table').first().locator('tbody tr');
      assert.equal(await shortRows.count(),3);
      assert.doesNotMatch(await shortRows.allTextContents().then(rows=>rows.join("|")),/^Лояльные|Потерянные/);
      await clientBase.locator("[data-client-base-window]").selectOption("12");
      assert.equal(await clientBase.locator('.report-chart[data-chart*="partition-shares"]').count(), 0);
      await clientBase.locator("[data-report-help] > summary").click();
      assert.equal(await clientBase.locator(".report-help-body").isVisible(), true);
      await clientBase.locator("[data-report-help] > summary").click();
      await primarySection.screenshot({ path: path.join(root, "tmp", "cloud-primary-patients.png") });
      const sources = numericFrame.locator("[data-primary-sources]");
      assert.equal(await sources.locator("svg").count(),2);
      const sourceCharts=samplePage.report.vectors[4].sections.find(section=>section.title==='Источники первичных пациентов').charts;
      assert.deepEqual(await sources.locator("[data-primary-source-composition]").evaluateAll(pies=>pies.map(pie=>JSON.parse(pie.dataset.clientBaseValues))),sourceCharts.map(chart=>chart.series[0].values));
      const preview = await pinContext.newPage();
      const v4Html = await clientBase.evaluate(element => element.outerHTML);
      await preview.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><body class="online-report"><main class="cloud-data-report">${v4Html}</main></body>`);
      await preview.addStyleTag({ content: fs.readFileSync(path.join(root,"tmp/klinvekt-mobile-server/public/online-report.css"),"utf8") });
      for (const width of [1440,390]) {
        await preview.setViewportSize({ width, height: 1000 });
        await preview.screenshot({ path: path.join(root,"tmp",`client-base-online-${width}.png`), fullPage:true, scale:"css" });
        assert.ok(await preview.evaluate(()=>document.documentElement.scrollWidth-innerWidth<=2));
      }
      const sourcesHtml=await sources.evaluate(element=>element.outerHTML);
      await preview.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><body class="online-report"><main class="cloud-data-report">${sourcesHtml}</main></body>`);
      await preview.addStyleTag({ content: fs.readFileSync(path.join(root,"tmp/klinvekt-mobile-server/public/online-report.css"),"utf8") });
      for (const width of [1440,390]) {
        await preview.setViewportSize({width,height:1000});
        await preview.screenshot({path:path.join(root,'tmp',`primary-sources-online-${width}.png`),fullPage:true,scale:'css'});
        const geometry=await preview.evaluate(()=>({overflow:document.documentElement.scrollWidth-innerWidth, outside:[...document.querySelectorAll('body *')].filter(element=>element.getBoundingClientRect().right>innerWidth+2).slice(0,12).map(element=>({tag:element.tagName,cls:element.className,width:element.getBoundingClientRect().width}))}));
        assert.ok(geometry.overflow<=2,JSON.stringify({width,...geometry}));
      }
      await preview.close();
    }
    const headerTable = numericFrame.locator(".cloud-section").filter({ has: numericFrame.locator("h3", { hasText: "Годовая таблица показателей" }) });
    assert.ok(await headerTable.locator("th").evaluateAll(cells => cells.length === 3 && cells.every(cell => {
      const lines = [...cell.querySelectorAll(".report-table-heading-line")];
      return lines.length === 2 && lines[1].getBoundingClientRect().top >= lines[0].getBoundingClientRect().bottom - 1;
    })), "online headers occupy exactly two separate lines");
    const chart = numericFrame.locator('.report-chart').filter({ has: numericFrame.locator('h5', { hasText: "Проверка графика" }) });
    await chart.scrollIntoViewIfNeeded();
    await chart.locator(".chart-plot svg:visible").first().waitFor();
    assert.equal(JSON.parse(await chart.getAttribute("data-chart")).labels.length, 9, "online September graph contains January through September");
    await chart.locator("[data-chart-series]").selectOption("0");
    const expectedPlot = require("../mobile-pilot/report-charts.js").chartPlot(JSON.parse(await chart.getAttribute("data-chart")), "0");
    const expectedPath = expectedPlot.match(/<path d="([^"]*)"/)[1];
    assert.equal(await chart.locator(".line-wide path").first().getAttribute("d"), expectedPath, "selection uses exact JSON values and keeps February as a gap");
    for (const viewport of [{ width: 320, height: 720 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await pinPage.setViewportSize(viewport);
      assert.ok(await pinPage.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 2));
      const reportFrame = pinPage.frames().find(frame => frame.parentFrame() === pinPage.mainFrame());
      assert.ok(await reportFrame.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 2), "numeric report fits the phone viewport");
      assert.ok(await numericFrame.locator(".cloud-kpis .kpi").evaluateAll(elements => elements.every(element => element.getBoundingClientRect().right <= innerWidth + 2)));
      const screenName = viewport.width === 320 ? "compact" : viewport.width === 390 ? "iphone" : "landscape";
      assert.ok(await visibleV3.evaluateAll(sections => sections.every(section => {
        const summary = section.querySelector("summary");
        const rect = summary.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth + 2 && summary.scrollWidth <= summary.clientWidth + 2;
      })), "Vector 3 summary tiles fit the phone viewport");
      if (viewport.width === 390) await numericV3.screenshot({ path: path.join(root, "tmp", "cloud-v3-iphone.png") });
      await pinPage.screenshot({ path: path.join(root, "tmp", `cloud-json-${screenName}.png`) });
      await chart.screenshot({ path: path.join(root, "tmp", `cloud-json-chart-${screenName}.png`) });
      await headerTable.screenshot({ path: path.join(root, "tmp", `cloud-table-headers-${screenName}.png`) });
      if (samplePage?.report) {
        const primarySection = numericFrame.locator(".cloud-section").filter({ has: numericFrame.locator("h3", { hasText: "Первичные пациенты врача" }) });
        await primarySection.screenshot({ path: path.join(root, "tmp", `cloud-primary-${screenName}.png`) });
      }
    }
    await chart.evaluate(element => {
      window.dispatchEvent(new Event("beforeprint"));
      if (document.querySelector("[data-chart-deferred]")) throw Error("Print left unrendered charts");
    });
    const specializationPage = await pinContext.newPage();
    await specializationPage.setViewportSize({ width: 390, height: 844 });
    const { renderCloudReport } = require("../mobile-server/cloud-report-renderer.cjs");
    const publicRoot = path.join(root, "tmp", "klinvekt-mobile-server", "public");
    await specializationPage.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><body class="online-report">
      ${renderCloudReport(specializationReport, "Специализация X", { deferred: true, kind: "specialization" })}</body>`);
    await specializationPage.addStyleTag({ path: path.join(publicRoot, "online-report.css") });
    for (const asset of ["report-presentation.js", "report-charts.js", "online-report.js"]) {
      await specializationPage.addScriptTag({ path: path.join(publicRoot, asset) });
    }
    const scopeBase = specializationPage.locator('[data-vector-key="v4"]');
    const baseChart = window => scopeBase.locator(`[data-client-base-window-panel="${window}"] .report-chart`);
    const basePath = async window => {
      const chart = baseChart(window);
      await chart.scrollIntoViewIfNeeded();
      assert.equal(await chart.locator("h5").textContent(), "Динамика в разрезе 3-х лет");
      await chart.locator("svg.line-narrow").waitFor();
      return chart.locator(".line-narrow path").getAttribute("d");
    };
    const longPath = await basePath(36);
    await baseChart(36).screenshot({ path: path.join(root, "tmp", "specialization-base-online-390.png") });
    await scopeBase.locator("[data-client-base-window]").selectOption("12");
    assert.equal(await baseChart(36).isVisible(), false);
    assert.notEqual(await basePath(12), longPath);
    const deviceHistory = specializationPage.locator("[data-specialization-device-history]");
    assert.equal(await deviceHistory.evaluate(element => element.open), false);
    await deviceHistory.locator(":scope > summary").click();
    await deviceHistory.locator("svg.line-narrow").waitFor();
    assert.match(await deviceHistory.locator("svg.line-narrow circle title").first().textContent(), /3 шт\./);
    await deviceHistory.locator(".chart-data > summary").click();
    assert.match(await deviceHistory.locator(".chart-data tbody").innerText(), /5 шт\./);
    const primaryChart = specializationPage.locator(".report-chart").filter({ hasText: "Первичные пациенты по месяцам" });
    await primaryChart.scrollIntoViewIfNeeded();
    await primaryChart.locator("svg.line-narrow").waitFor();
    assert.match(await primaryChart.locator("svg.line-narrow").textContent(), /25% от первичных/);
    assert.ok(await specializationPage.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 2));
    await pinContext.close();
    // Model the HTTPS app inside a different Bitrix origin with production
    // Secure cookies. WebKit blocks these third-party cookies by default.
    iframeServer = createMobileServer({ dataDir, cloudPortalId: "test-portal", staticRoot: path.join(root, "tmp", "klinvekt-mobile-server", "public") });
    await new Promise(resolve => iframeServer.listen(0, "127.0.0.1", resolve));
    const iframeBase = `http://127.0.0.1:${iframeServer.address().port}`;
    const embedded = await browser.newContext({ ...devices["iPhone 13"] });
    await embedded.route("https://test.bitrix24.ru/**", route => route.fulfill({ contentType: "text/html",
      body: '<meta name="viewport" content="width=device-width,initial-scale=1"><iframe id="app" style="width:100%;height:800px;border:0" src="https://app-test.vibecode.bitrix24.tech/"></iframe>' }));
    let tokenHeaderSeen = false, cookieSeen = false;
    await embedded.route("https://app-test.vibecode.bitrix24.tech/**", async route => {
      const request = route.request(), url = new URL(request.url());
      const headers = { ...request.headers(), "X-Vibe-User-Id": "999", "X-Vibe-Portal-Id": "test-portal" };
      tokenHeaderSeen ||= Boolean(headers["x-klinvekt-cloud-session"]);
      cookieSeen ||= Boolean(headers.cookie?.includes("klinvekt_cloud_session="));
      delete headers.host; delete headers["content-length"];
      const response = await fetch(iframeBase + url.pathname + url.search, { method: request.method(), headers,
        ...(request.postDataBuffer() ? { body: request.postDataBuffer() } : {}) });
      const responseHeaders = Object.fromEntries(response.headers); delete responseHeaders["content-length"];
      await route.fulfill({ status: response.status, headers: responseHeaders, body: Buffer.from(await response.arrayBuffer()) });
    });
    const embeddedPage = await embedded.newPage(); embeddedPage.on("pageerror", error => errors.push(error.message));
    await embeddedPage.goto("https://test.bitrix24.ru");
    const app = embeddedPage.frameLocator("#app"); await app.locator("#onlineLoginForm").waitFor({ state: "visible" });
    await app.locator("#onlineAccount").selectOption("doctor:a");
    await app.locator("#onlinePin").fill("0123"); await app.locator("#onlineLoginButton").click();
    await app.frameLocator("#onlineFrame").locator("body.online-report").waitFor();
    assert.equal(await app.locator("#onlineScope option").count(), 1);
    assert.equal(await app.locator("#onlineLoginForm").isVisible(), false);
    assert.ok(tokenHeaderSeen); assert.equal(cookieSeen, false, "session works with blocked third-party cookies");
    const applicationFrame = embeddedPage.frames().find(frame => frame.url().startsWith("https://app-test."));
    assert.equal(await applicationFrame.evaluate(() => localStorage.length + sessionStorage.length), 0, "clinical token is held only in page memory");
    assert.equal(await app.locator("#onlineFrame").getAttribute("src"), null, "session token never appears in the report URL");
    await app.locator("#onlineLogout").click(); await app.locator("#onlineLoginForm").waitFor({ state: "visible" });
    assert.equal(await app.locator("#onlineFrame").isVisible(), false);
    await embedded.close();
    const pinService = require("../desktop/services/pin-transfer-service.cjs");
    const transferDoctors = dataPublication.doctors.map((doctor, index) => ({ ...doctor, doctorId: `source-${index}`, syncId: crypto.randomUUID(), ...verifier(index ? "5432" : "0987") }));
    const pinUpdate = { format: "klinvekt-cloud-pins", version: 1, createdAt: new Date().toISOString(), appVersion: "test",
      sync: { setId: crypto.randomUUID(), revision: 1, digest: pinService.pinDigest(transferDoctors) }, doctors: transferDoctors, admin: null };
    const beforePins = JSON.parse(fs.readFileSync(path.join(dataDir, "publications.kvcloud"), "utf8")).publication;
    await adminPage.reload();
    await adminPage.locator("#onlineLoginForm").waitFor({ state: "visible" });
    await adminPage.locator("#onlineAccount").selectOption("admin"); await adminPage.locator("#onlinePin").fill("654321"); await adminPage.locator("#onlineLoginButton").click();
    await adminPage.locator("#onlineScope:not([disabled])").waitFor();
    await adminPage.locator("#onlineUploadPanel > summary").click(); await adminPage.locator("#onlinePinsPanel > summary").click();
    const pinFile = { name: "online-pins.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(pinUpdate)) };
    await adminPage.locator("#onlinePinsFile").setInputFiles(pinFile); await adminPage.locator("#onlinePinsPreviewButton").click();
    await adminPage.locator("#onlinePinsApply").waitFor(); assert.equal(await adminPage.locator("[data-pin-source]").count(), 2);
    await auditLayout(adminPage, "pin-comparison", true);
    assert.equal(await adminPage.locator("[data-pin-source]").first().inputValue(), "a");
    await adminPage.screenshot({ path: path.join(root, "tmp", "pin-transfer-online-pc.png") });
    await adminPage.locator("#onlinePinsComparison button", { hasText: "Закрыть сравнение" }).click();
    const migrationContext = await browser.newContext({ ...devices["iPhone 13"], extraHTTPHeaders: {
      "X-Vibe-User-Id": "2", "X-Vibe-Portal-Id": "test-portal", "X-Vibe-User-Role": "ADMIN" } });
    const migrationPage = await migrationContext.newPage(); migrationPage.on("pageerror", error => errors.push(error.message));
    await migrationPage.goto(base); await migrationPage.locator("#onlineUploadPanel").waitFor();
    await migrationPage.locator("#onlineUploadPanel > summary").click(); await migrationPage.locator("#onlinePinsPanel > summary").click();
    await migrationPage.locator("#onlinePinsFile").setInputFiles(pinFile); await migrationPage.locator("#onlinePinsPreviewButton").click();
    await migrationPage.locator("#onlinePinsApply").waitFor();
    assert.ok(await migrationPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
    await migrationPage.screenshot({ path: path.join(root, "tmp", "pin-transfer-online-phone.png") });
    await migrationPage.locator("#onlinePinsAdopt").check(); await migrationPage.locator("#onlinePinsApply").click();
    await migrationPage.waitForFunction(() => document.getElementById("onlinePinsStatus").textContent.includes("Обновлены PIN: 2"));
    await migrationPage.locator("#onlineAccount").selectOption("doctor:a"); await migrationPage.locator("#onlinePin").fill("0987"); await migrationPage.locator("#onlineLoginButton").click();
    await migrationPage.frameLocator("#onlineFrame").locator(".cloud-data-report").waitFor();
    const afterPins = JSON.parse(fs.readFileSync(path.join(dataDir, "publications.kvcloud"), "utf8")).publication;
    assert.deepEqual(afterPins.pages, beforePins.pages); assert.equal(afterPins.createdAt, beforePins.createdAt);
    assert.deepEqual(afterPins.pinSync, pinUpdate.sync);
    await migrationContext.close();
    assert.deepEqual(errors, []);
    await admin.close();
    if (layoutResults.length) {
      fs.writeFileSync(path.join(root,"tmp","online-layout-results.json"), JSON.stringify(layoutResults,null,2));
      const failures = layoutResults.filter(item => item.overflow > 2 || item.outside.length || item.reportOverflow > 2 || (item.state !== "login" && item.frameHeight < 180));
      assert.deepEqual(failures, [], "online layout must fit all tested viewports with long physician names");
    }
    process.stdout.write(JSON.stringify({ online: true, browser: "WebKit", device: "iPhone 13 emulation", narrow, admin: true,
      pinLogin: true, pinMigrationPcAndPhone: true, numericJson: true, exactChartValues: true, noEmployeeIdMapping: true, bitrixIframeWithBlockedCookies: true, realAdminSnapshot: Boolean(sample), layoutCases: layoutResults.length, errors: 0 }) + "\n");
  } finally {
    await browser?.close(); if (iframeServer) await new Promise(resolve => iframeServer.close(resolve));
    await new Promise(resolve => server.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
