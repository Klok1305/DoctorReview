"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { webkit, devices } = require("@playwright/test");
const { createMobileServer } = require("../mobile-server/server.cjs");
const { createCloudPublication } = require("../desktop/services/cloud-publication-service.cjs");
const root = path.resolve(__dirname, "..");

async function main() {
  require("./build-mobile-server-package.cjs");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "klinvekt-cloud-webkit-"));
  const samplePath = path.join(root, "tmp", "cloud-publication-smoke.kvcloud");
  const sample = fs.existsSync(samplePath) ? JSON.parse(fs.readFileSync(samplePath, "utf8")) : null;
  const html = sample?.pages.find(page => page.kind === "doctor")?.html
    || '<div class="viewer-dashboard-snapshot"><div class="card"><h2>Синтетический отчёт</h2><p>43 визита</p><p>Комментарий администратора</p></div></div>';
  const publication = createCloudPublication({ appVersion: "test", doctors: [
    { doctorId: "a", displayName: "Врач А", department: "A", specialization: "X" },
    { doctorId: "b", displayName: "Врач Б", department: "B", specialization: "Y" },
  ], accounts: [
    { userId: "1", doctorId: "a", admin: false, departments: [], specializations: [] },
    { userId: "2", doctorId: "", admin: true, departments: [], specializations: [] },
  ], pages: ["2026-01", "2026-03"].flatMap(periodKey => [
    { kind: "doctor", doctorId: "a", department: "A", specialization: "X", periodKey, title: `Врач А · ${periodKey}`, html },
    { kind: "doctor", doctorId: "b", department: "B", specialization: "Y", periodKey, title: `Врач Б · ${periodKey}`, html },
    { kind: "clinic", doctorId: "", department: "", specialization: "", periodKey, title: `Вся клиника · ${periodKey}`, html },
  ]) });
  fs.writeFileSync(path.join(dataDir, "publications.kvcloud"), JSON.stringify({ portalId: "test-portal", publication }));
  const server = createMobileServer({ dataDir, cloudPortalId: "test-portal", staticRoot: path.join(root, "tmp", "klinvekt-mobile-server", "public") });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
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
    assert.equal(await frame.locator("[data-viewer-patient-register]").count(), 0);
    const headerKpisFit = await frame.locator(".gauge-wrap .kpi").evaluateAll(elements => elements.every(element => {
      const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth;
    }));
    assert.ok(headerKpisFit, "doctor header KPI cards must fit the phone report viewport");
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
    assert.equal(await adminPage.locator("#onlineScope option").count(), 3);
    await adminPage.locator("#onlineUploadPanel summary").click();
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
    assert.deepEqual(errors, []);
    await admin.close();
    process.stdout.write(JSON.stringify({ online: true, browser: "WebKit", device: "iPhone 13 emulation", narrow, admin: true,
      realAdminSnapshot: Boolean(sample), errors: 0 }) + "\n");
  } finally {
    await browser?.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
