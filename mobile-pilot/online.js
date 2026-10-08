"use strict";
const periodSelect = document.getElementById("onlinePeriod"), scopeSelect = document.getElementById("onlineScope");
const reportFrame = document.getElementById("onlineFrame"), statusLine = document.getElementById("onlineStatus");
let catalog = [], publicationDate = "", loading = null, uploading = null;
const uploadPanel = document.getElementById("onlineUploadPanel"), uploadStatus = document.getElementById("onlineUploadStatus");
const scopeKey = page => JSON.stringify([page.kind, page.doctorId, page.department, page.specialization]);
function showReport() {
  const page = catalog.find(page => page.periodKey === periodSelect.value && scopeKey(page) === scopeSelect.value);
  if (!page) { reportFrame.hidden = true; return; }
  reportFrame.hidden = false;
  reportFrame.src = `/api/cloud/pages/${encodeURIComponent(page.pageId)}`;
  statusLine.textContent = `Публикация: ${new Date(publicationDate).toLocaleString("ru-RU")} · ${page.title}`;
}
function updateScopes(previousKey = scopeSelect.value) {
  const pages = catalog.filter(page => page.periodKey === periodSelect.value);
  scopeSelect.replaceChildren(...pages.map(page => new Option(page.title.replace(/ · [^·]+$/, ""), scopeKey(page))));
  if (pages.some(page => scopeKey(page) === previousKey)) scopeSelect.value = previousKey;
  scopeSelect.disabled = !pages.length; showReport();
}
async function requestJson(url, signal, options = {}) {
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(url, { ...options, cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
      if (![429, 503].includes(response.status) || attempt === 2) break;
    } catch (error) { if (signal.aborted || attempt === 2) throw error; }
    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Не удалось открыть отчёты");
  return data;
}
async function refresh() {
  loading?.abort(); loading = new AbortController();
  const signal = loading.signal;
  statusLine.textContent = "Загружаются доступные отчёты…";
  // Clear the old report immediately: an updated publication may revoke access.
  reportFrame.hidden = true; reportFrame.removeAttribute("src");
  periodSelect.disabled = true; scopeSelect.disabled = true;
  try {
    const access = await requestJson("/api/cloud/admin", signal);
    if (signal.aborted) return;
    document.getElementById("onlineUser").textContent = access.userName;
    uploadPanel.hidden = !access.canUpload;
    document.getElementById("onlineUploadHelp").textContent = `Ваш ID в Битриксе: ${access.userId}. Укажите его среди администраторов КлинВекта в Admin → Настройки → Онлайн-КлинВект. Файл обновляет все отчёты и права.`;
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
    if (value.format !== "klinvekt-cloud-publication" || value.version !== 1) throw new Error("Нужен файл из кнопки «Выгрузить обезличенный JSON» в Admin. Полная копия базы сюда не подходит");
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
