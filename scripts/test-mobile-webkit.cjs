"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { webkit, devices } = require("@playwright/test");

const root = path.resolve(__dirname, "..", "mobile-pilot");
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/report-charts.js", ["report-charts.js", "text/javascript; charset=utf-8"]],
  ["/report-presentation.js", ["report-presentation.js", "text/javascript; charset=utf-8"]],
  ["/app.css", ["app.css", "text/css; charset=utf-8"]],
  ["/online.html", ["online.html", "text/html; charset=utf-8"]],
  ["/online.js", ["online.js", "text/javascript; charset=utf-8"]],
  ["/online.css", ["online.css", "text/css; charset=utf-8"]],
  ["/online-report.js", ["online-report.js", "text/javascript; charset=utf-8"]],
  ["/demo-data.js", ["demo-data.js", "text/javascript; charset=utf-8"]],
  ["/service-worker.js", ["service-worker.js", "text/javascript; charset=utf-8"]],
  ["/manifest.webmanifest", ["manifest.webmanifest", "application/manifest+json"]],
  ["/icons/app-icon-192.png", ["icons/app-icon-192.png", "image/png"]],
  ["/icons/app-icon-512.png", ["icons/app-icon-512.png", "image/png"]],
]);

async function main() {
  const server = http.createServer((request, response) => {
    const route = new URL(request.url, "http://localhost").pathname;
    const asset = assets.get(route);
    if (!asset) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "Content-Type": asset[1], "Cache-Control": "no-store" });
    fs.createReadStream(path.join(root, asset[0])).pipe(response);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await webkit.launch({ headless: true });
  try {
    const base = `http://127.0.0.1:${server.address().port}/`;
    const context = await browser.newContext({ ...devices["iPhone 13"], serviceWorkers: "allow" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(base);
    await page.locator("#openDemoButton").waitFor({ state: "visible" });
    const inputFontPx = await page.locator(".login-field").first().evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    assert.ok(inputFontPx >= 16, `iPhone input font ${inputFontPx}px can trigger zoom`);
    await page.locator("#openDemoButton").click();
    await page.locator("#reportView").waitFor({ state: "visible" });
    const narrow = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      reportScroll: document.querySelector("#reportScroller").scrollHeight > document.querySelector("#reportScroller").clientHeight,
      doctor: document.querySelector("#doctorName").textContent.trim(),
    }));
    assert.ok(narrow.overflow <= 2, `narrow screen overflows by ${narrow.overflow}px`);
    assert.equal(narrow.reportScroll, true);
    assert.ok(narrow.doctor);
    await page.setViewportSize({ width: 844, height: 390 });
    const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(horizontalOverflow <= 2, `landscape screen overflows by ${horizontalOverflow}px`);

    const iframePage = await context.newPage();
    await iframePage.setContent(`<iframe title="Проверка PWA" src="${base}" style="width:390px;height:700px;border:0"></iframe>`);
    await iframePage.frameLocator("iframe").locator("#loginTitle").waitFor({ state: "visible" });
    await iframePage.close();

    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    const shellCache = await page.evaluate(async () => ({
      controlled: Boolean(navigator.serviceWorker.controller),
      cached: Boolean(await caches.match("./index.html")),
    }));
    assert.deepEqual(shellCache, { controlled: true, cached: true });
    await page.locator("#reportView").waitFor({ state: "visible" });
    assert.deepEqual(errors, []);
    process.stdout.write(JSON.stringify({ browser: "WebKit", device: "iPhone 13 emulation", narrow, horizontalOverflow,
      iframe: true, shellCache, errors: errors.length }) + "\n");
    await context.close();
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
