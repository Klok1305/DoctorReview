"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { webkit, devices } = require("@playwright/test");
const { createMobileServer } = require("../mobile-server/server.cjs");
const crypto = require("node:crypto");
const { createCloudPublication, cloudAccountsFromViewer, PIN_PARAMS } = require("../desktop/services/cloud-publication-service.cjs");
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
    assert.equal(await pinPage.locator("#onlineScope option").count(), 3);
    await pinPage.locator("#onlineUploadPanel summary").click();
    const pinUpdated = structuredClone(pinPublication); pinUpdated.pages = pinUpdated.pages.filter(page => page.periodKey === "2026-03");
    await pinPage.locator("#onlineUploadFile").setInputFiles({ name: "anonymous-pin.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(pinUpdated)) });
    await pinPage.locator("#onlineUploadButton").click();
    await pinPage.locator("#onlineLoginForm").waitFor({ state: "visible" });
    await pinPage.locator("#onlinePin").fill("654321"); await pinPage.locator("#onlineLoginButton").click();
    await pinPage.locator("#onlineScope:not([disabled])").waitFor();
    assert.equal(await pinPage.locator("#onlinePeriod option").count(), 1);
    await pinPage.locator("#onlineUploadPanel summary").click();
    await pinPage.screenshot({ path: path.join(root, "tmp", "cloud-online-pin-admin.png") });
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
    assert.deepEqual(errors, []);
    await admin.close();
    process.stdout.write(JSON.stringify({ online: true, browser: "WebKit", device: "iPhone 13 emulation", narrow, admin: true,
      pinLogin: true, noEmployeeIdMapping: true, bitrixIframeWithBlockedCookies: true, realAdminSnapshot: Boolean(sample), errors: 0 }) + "\n");
  } finally {
    await browser?.close(); if (iframeServer) await new Promise(resolve => iframeServer.close(resolve));
    await new Promise(resolve => server.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
