"use strict";
const periodSelect = document.getElementById("onlinePeriod"), scopeSelect = document.getElementById("onlineScope");
const reportFrame = document.getElementById("onlineFrame"), statusLine = document.getElementById("onlineStatus");
let catalog = [], publicationDate = "", loading = null, uploading = null, reportLoading = null, cloudSessionToken = "";
const uploadPanel = document.getElementById("onlineUploadPanel"), uploadStatus = document.getElementById("onlineUploadStatus");
const loginForm = document.getElementById("onlineLoginForm"), accountSelect = document.getElementById("onlineAccount");
const pinInput = document.getElementById("onlinePin"), loginStatus = document.getElementById("onlineLoginStatus");
const logoutButton = document.getElementById("onlineLogout");
const scopeKey = page => JSON.stringify([page.kind, page.doctorId, page.department, page.specialization]);
async function showReport() {
  reportLoading?.abort(); const controller = new AbortController(); reportLoading = controller;
  const page = catalog.find(page => page.periodKey === periodSelect.value && scopeKey(page) === scopeSelect.value);
  reportFrame.hidden = true; reportFrame.removeAttribute("src"); reportFrame.removeAttribute("srcdoc");
  if (!page) return;
  try {
    const response = await fetch(`/api/cloud/pages/${encodeURIComponent(page.pageId)}`, { cache: "no-store",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
      headers: cloudSessionToken ? { "X-Klinvekt-Cloud-Session": cloudSessionToken } : {} });
    if (!response.ok) {
      const data = await response.json(); throw Object.assign(new Error(data.error || "Не удалось открыть отчёт"), { status: response.status });
    }
    const html = await response.text(); if (controller.signal.aborted) return;
    // srcdoc keeps the token out of iframe URLs/history and works when Safari
    // blocks third-party cookies. The server still checks each requested page.
    reportFrame.srcdoc = html; reportFrame.hidden = false;
    statusLine.textContent = `Публикация: ${new Date(publicationDate).toLocaleString("ru-RU")} · ${page.title}`;
  } catch (error) {
    if (controller.signal.aborted) return;
    if (error.status === 401) { cloudSessionToken = ""; await refresh(); }
    else statusLine.textContent = error.message;
  }
}
function updateScopes(previousKey = scopeSelect.value) {
  const pages = catalog.filter(page => page.periodKey === periodSelect.value);
  scopeSelect.replaceChildren(...pages.map(page => new Option(page.title.replace(/ · [^·]+$/, ""), scopeKey(page))));
  if (pages.some(page => scopeKey(page) === previousKey)) scopeSelect.value = previousKey;
  scopeSelect.disabled = !pages.length; showReport();
}
async function requestJson(url, signal, options = {}) {
  const { retry = true, ...fetchOptions } = options;
  let response;
  for (let attempt = 0; attempt < (retry ? 3 : 1); attempt++) {
    try {
      response = await fetch(url, { ...fetchOptions, headers: { ...fetchOptions.headers,
        ...(cloudSessionToken ? { "X-Klinvekt-Cloud-Session": cloudSessionToken } : {}) },
        cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
      if (!retry || ![429, 503].includes(response.status) || attempt === 2) break;
    } catch (error) { if (!retry || signal.aborted || attempt === 2) throw error; }
    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
  }
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || "Не удалось открыть отчёты"), { status: response.status });
  return data;
}
async function refresh() {
  loading?.abort(); loading = new AbortController();
  reportLoading?.abort();
  const signal = loading.signal;
  statusLine.textContent = "Загружаются доступные отчёты…";
  // Clear the old report immediately: an updated publication may revoke access.
  reportFrame.hidden = true; reportFrame.removeAttribute("src"); reportFrame.removeAttribute("srcdoc");
  periodSelect.disabled = true; scopeSelect.disabled = true;
  try {
    const access = await requestJson("/api/cloud/admin", signal);
    if (signal.aborted) return;
    if (!access.account) cloudSessionToken = "";
    document.getElementById("onlineUser").textContent = access.userName;
    uploadPanel.hidden = !access.canUpload;
    document.getElementById("onlineUploadHelp").textContent = access.authMode === "pin"
      ? "Выберите файл «Выгрузить обезличенный JSON» из Admin. Он обновит все отчёты, роли и PIN. После загрузки войдите снова."
      : "Это прежняя публикация с доступом по Битриксу. Для входа по ФИО и PIN загрузите JSON из обновлённого Admin.";
    logoutButton.hidden = !access.account;
    loginForm.hidden = access.authMode !== "pin" || !access.publicationAvailable || Boolean(access.account);
    if (!loginForm.hidden) {
      const previous = accountSelect.value;
      const accounts = [...access.accounts].sort((a, b) => a.accountId === "admin" ? -1 : b.accountId === "admin" ? 1 : a.displayName.localeCompare(b.displayName, "ru"));
      accountSelect.replaceChildren(...accounts.map(account => new Option(account.displayName, account.accountId)));
      if (accounts.some(account => account.accountId === previous)) accountSelect.value = previous;
      updatePinInput();
      catalog = []; periodSelect.replaceChildren(); scopeSelect.replaceChildren();
      statusLine.textContent = "Выберите ФИО и введите PIN"; return;
    }
    if (!access.publicationAvailable) {
      catalog = []; periodSelect.replaceChildren(); scopeSelect.replaceChildren();
      uploadPanel.open = access.canUpload;
      statusLine.textContent = "Администратор ещё не загрузил отчёты"; return;
    }
    const pages = [];
    let data, cursor = 0, createdAt = "";
    do {
      data = await requestJson(`/api/cloud/context?cursor=${cursor}`, signal);
      if (createdAt && createdAt !== data.createdAt) throw new Error("Публикация обновилась. Нажмите «Обновить» ещё раз");
      createdAt = data.createdAt; pages.push(...data.pages);
      if (data.nextCursor != null && (!Number.isInteger(data.nextCursor) || data.nextCursor <= cursor)) throw new Error("Некорректный каталог отчётов");
      cursor = data.nextCursor;
    } while (cursor != null);
    if (signal.aborted) return;
    document.getElementById("onlineUser").textContent = data.userName;
    catalog = pages; publicationDate = createdAt;
    const periods = [...new Set(catalog.map(page => page.periodKey))].sort().reverse();
    const previous = periodSelect.value;
    periodSelect.replaceChildren(...periods.map(period => new Option(period, period)));
    if (periods.includes(previous)) periodSelect.value = previous;
    periodSelect.disabled = !periods.length; updateScopes();
  } catch (error) { if (!signal.aborted) statusLine.textContent = error.message || "Нет связи с облаком. Нажмите «Обновить»"; }
}
function updatePinInput() {
  const admin = accountSelect.value === "admin";
  pinInput.minLength = admin ? 6 : 4; pinInput.maxLength = admin ? 12 : 4;
  pinInput.pattern = admin ? "[0-9]{6,12}" : "[0-9]{4}";
  pinInput.placeholder = admin ? "PIN администратора Viewer (6–12 цифр)" : "PIN врача (4 цифры)";
  pinInput.value = "";
}
accountSelect.addEventListener("change", updatePinInput);
loginForm.addEventListener("submit", async event => {
  event.preventDefault(); const button = document.getElementById("onlineLoginButton");
  if (button.disabled) return;
  button.disabled = true; loginStatus.textContent = "Проверяется PIN…";
  try {
    const body = JSON.stringify({ accountId: accountSelect.value, pin: pinInput.value });
    pinInput.value = "";
    const result = await requestJson("/api/cloud/login", new AbortController().signal, { method: "POST", retry: false,
      headers: { "Content-Type": "application/json", "X-Klinvekt-Cloud-Auth": "1" }, body });
    if (!/^[a-f0-9]{64}$/.test(result.sessionToken || "")) throw new Error("Не удалось открыть сессию. Обновите приложение");
    cloudSessionToken = result.sessionToken;
    loginStatus.textContent = ""; await refresh();
  } catch (error) { loginStatus.textContent = error.message; }
  finally { button.disabled = false; }
});
logoutButton.addEventListener("click", async () => {
  loading?.abort(); reportLoading?.abort(); catalog = []; reportFrame.hidden = true;
  reportFrame.removeAttribute("src"); reportFrame.removeAttribute("srcdoc");
  periodSelect.disabled = true; scopeSelect.disabled = true; logoutButton.disabled = true;
  try {
    await requestJson("/api/cloud/logout", new AbortController().signal, { method: "POST", retry: false, headers: { "X-Klinvekt-Cloud-Auth": "1" } });
    cloudSessionToken = "";
    await refresh();
  } catch (error) { statusLine.textContent = error.message; }
  finally { logoutButton.disabled = false; }
});
async function hash(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}
document.getElementById("onlineUploadForm").addEventListener("submit", async event => {
  event.preventDefault(); if (uploading) return;
  const file = document.getElementById("onlineUploadFile").files[0];
  if (!file) return;
  const controller = new AbortController(); uploading = controller;
  const signal = controller.signal, button = document.getElementById("onlineUploadButton"), cancel = document.getElementById("onlineUploadCancel");
  const progress = document.getElementById("onlineUploadProgress"), input = document.getElementById("onlineUploadFile");
  button.disabled = true; input.disabled = true; cancel.hidden = false; progress.hidden = false; progress.value = 0;
  try {
    if (file.size < 1 || file.size > 100 * 1024 * 1024) throw new Error("Выберите обезличенный JSON размером до 100 МиБ");
    uploadStatus.textContent = "Проверяется файл…";
    const bytes = new Uint8Array(await file.arrayBuffer());
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (value.format !== "klinvekt-cloud-publication" || ![1, 2].includes(value.version)) throw new Error("Нужен файл из кнопки «Выгрузить обезличенный JSON» в Admin. Полная копия базы сюда не подходит");
    const sha256 = await hash(bytes);
    if (signal.aborted) throw new DOMException("Отменено", "AbortError");
    const headers = { "X-Klinvekt-Cloud-Upload": "1" };
    const upload = await requestJson("/api/cloud/manual/uploads", signal, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ bytes: bytes.length, sha256 }) });
    const chunks = Math.ceil(bytes.length / upload.chunkBytes);
    if (upload.chunkBytes !== 512 * 1024 || !Number.isInteger(upload.nextIndex) || upload.nextIndex < 0 || upload.nextIndex > chunks) throw new Error("Некорректный ответ сервера");
    for (let index = upload.nextIndex; index < chunks; index++) {
      uploadStatus.textContent = `Загрузка: ${index + 1} из ${chunks} порций…`;
      const chunk = bytes.subarray(index * upload.chunkBytes, Math.min((index + 1) * upload.chunkBytes, bytes.length));
      await requestJson(`/api/cloud/manual/uploads/${encodeURIComponent(upload.uploadId)}/chunks/${index}`, signal, { method: "PUT", headers: { ...headers, "Content-Type": "application/octet-stream", "X-Chunk-Sha256": await hash(chunk) }, body: chunk });
      progress.value = (index + 1) * 100 / chunks;
    }
    uploadStatus.textContent = "Сервер проверяет отчёты и права…";
    const result = await requestJson(`/api/cloud/manual/uploads/${encodeURIComponent(upload.uploadId)}/complete`, signal, { method: "POST", headers });
    uploadStatus.textContent = `Загружено: ${result.doctors} врачей, ${result.pages} отчётов`;
    input.value = ""; await refresh();
  } catch (error) {
    uploadStatus.textContent = signal.aborted ? "Загрузка остановлена. Выберите тот же файл и нажмите «Загрузить отчёты», чтобы продолжить" : error.message || "Не удалось загрузить файл";
  } finally {
    uploading = null; button.disabled = false; input.disabled = false; cancel.hidden = true; progress.hidden = true;
  }
});
document.getElementById("onlineUploadCancel").addEventListener("click", () => uploading?.abort());
periodSelect.addEventListener("change", () => updateScopes());
scopeSelect.addEventListener("change", showReport);
document.getElementById("onlineRefresh").addEventListener("click", refresh);
refresh();
