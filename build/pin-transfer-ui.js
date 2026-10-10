/* PIN-only migration; no report calculations or analytical database writes. */
let PIN_TRANSFER_PREVIEW = null, PIN_TRANSFER_STATUS = "", pinTransferBusy = false;
function pinTransferSettingsHtml() {
  const sync = VIEWER_ACCESS.pinSync;
  return `<details id="pinTransferPanel"><summary>Перенос и синхронизация PIN</summary>
    <p class="small muted">Сохраните PIN из основного Admin, откройте файл во втором Admin, затем выгрузите отдельный JSON PIN для онлайн-КлинВекта.</p>
    <p class="small">${sync ? `Набор ${esc(sync.setId.slice(0, 8))} · версия ${sync.revision}${sync.partial ? " · перенесён частично" : ""}` : "Набор появится после загрузки доступов"}</p>
    <div class="toolbar"><label>Пароль файла <input id="pinTransferPassword" type="password" autocomplete="new-password" minlength="8" maxlength="128" placeholder="Не менее 8 символов"></label>
    <label><input id="pinTransferIncludeAdmin" type="checkbox"> Добавить администраторский PIN</label></div>
    <div class="toolbar"><button class="btn" type="button" onclick="pinTransferFileAction('export')">Сохранить PIN для другого Admin</button>
      <button class="btn" type="button" onclick="pinTransferFileAction('preview')">Открыть файл PIN и сравнить</button>
      <button class="btn" type="button" onclick="pinTransferFileAction('cloud')">Выгрузить PIN для онлайн</button>
      <button class="btn mini" type="button" onclick="pinTransferFileAction('restore')">Откатить последний перенос</button></div>
    <p class="small muted">Пароль защищает .kvpins. Онлайн-JSON содержит проверочные хеши. Отчёты, комментарии и роли сохраняются. Для уже выданных HTML/ZIP нужна новая обычная публикация.</p>
    <p id="pinTransferStatus" class="small" role="status">${esc(PIN_TRANSFER_STATUS)}</p><div id="pinTransferComparison">${pinTransferComparisonHtml()}</div>
  </details>`;
}
function pinTransferComparisonHtml() {
  const preview = PIN_TRANSFER_PREVIEW;
  if (!preview) return "";
  const relation = { different: "Другой набор PIN", conflict: "Версии совпадают, но PIN различаются", stale: "Устаревшая версия: нужен свежий файл", same: "Тот же набор и версия", newer: "Более новая версия общего набора" }[preview.relation];
  const rows = preview.rows.map(row => `<tr><td><b>${esc(row.sourceName)}</b><div class="small muted">${esc([row.department, row.specialization].filter(Boolean).join(" · "))}</div></td>
    <td><select data-pin-source="${esc(row.syncId)}" onchange="updatePinTransferTarget(this)" aria-label="Сопоставление ${esc(row.sourceName)}"><option value="">Пропустить</option>${preview.targets.map(target => `<option value="${esc(target.doctorId)}" ${target.doctorId === row.targetId ? "selected" : ""}>${esc(target.displayName)} · ${esc(target.department)}</option>`).join("")}</select></td>
    <td><code>${esc(row.currentPin || "—")} → ${esc(row.pin)}</code>${!row.targetId ? '<div class="small muted">Выберите врача или пропустите</div>' : ""}</td></tr>`).join("");
  return `<h3>Сравнение PIN · версия ${preview.sync.revision}</h3><p class="small">${esc(relation)}. Проверьте каждое сопоставление.</p>
    <div class="pin-transfer-scroll"><table class="data pin-transfer-table"><thead><tr><th>Врач в файле</th><th>Врач в этой базе</th><th>PIN: сейчас → из файла</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${["different", "conflict"].includes(preview.relation) ? '<p><label><input id="pinTransferAdopt" type="checkbox"> Использовать файл как общий набор PIN</label></p>' : ""}
    ${preview.hasAdmin ? '<p><label><input id="pinTransferImportAdmin" type="checkbox"> Также заменить администраторский PIN</label></p>' : ""}
    <div class="toolbar"><button class="btn primary" type="button" onclick="applyPinTransferFromSettings()" ${preview.relation === "stale" ? "disabled" : ""}>Применить выбранные PIN</button>
    <button class="btn" type="button" onclick="discardPinTransferFromSettings()">Закрыть сравнение</button></div>`;
}
function updatePinTransferTarget(select) {
  const source = PIN_TRANSFER_PREVIEW?.rows.find(row => row.syncId === select.dataset.pinSource);
  const target = (VIEWER_ACCESS.doctors || []).find(doctor => doctor.doctorId === select.value);
  if (source) select.closest("tr").querySelector("code").textContent = `${target?.pin || "—"} → ${source.pin}`;
}
function showPinTransferStatus(message) {
  PIN_TRANSFER_STATUS = message;
  const element = document.getElementById("pinTransferStatus");
  if (element) element.textContent = message;
}
function setPinTransferBusy(value) {
  pinTransferBusy = value;
  document.querySelectorAll("#pinTransferPanel button, #pinTransferPanel input, #pinTransferPanel select").forEach(element => element.disabled = value);
  if (!value && PIN_TRANSFER_PREVIEW?.relation === "stale") document.querySelector('#pinTransferPanel button[onclick="applyPinTransferFromSettings()"]')?.setAttribute("disabled", "");
}
async function discardPinTransferFromSettings() {
  if (pinTransferBusy) return;
  if (PIN_TRANSFER_PREVIEW) await DESKTOP_API.discardViewerPinImport(PIN_TRANSFER_PREVIEW.token);
  PIN_TRANSFER_PREVIEW = null;
  document.getElementById("pinTransferComparison").innerHTML = "";
}
async function pinTransferFileAction(action) {
  if (pinTransferBusy || !DESKTOP_API) return;
  const passwordInput = document.getElementById("pinTransferPassword"), password = passwordInput.value;
  const includeAdmin = document.getElementById("pinTransferIncludeAdmin").checked;
  passwordInput.value = "";
  if (["export", "preview"].includes(action) && (password.length < 8 || password.length > 128)) { showPinTransferStatus("Введите пароль файла: от 8 до 128 символов"); return; }
  if (action === "restore" && !confirm("Вернуть PIN из резервного набора перед последним переносом? Отчёты и роли сохранятся.")) return;
  if (action === "preview") await discardPinTransferFromSettings();
  setPinTransferBusy(true); showPinTransferStatus("Обрабатываются PIN…");
  try {
    const options = { password, includeAdmin, operationId: crypto.randomUUID() };
    const result = action === "export" ? await DESKTOP_API.exportViewerPinTransfer(options)
      : action === "preview" ? await DESKTOP_API.prepareViewerPinImport(options)
      : action === "cloud" ? await DESKTOP_API.exportCloudPins({ includeAdmin }) : await DESKTOP_API.restoreViewerPinBackup();
    if (result.canceled) { showPinTransferStatus("Выбор файла отменён"); return; }
    if (action === "preview") {
      PIN_TRANSFER_PREVIEW = result;
      document.getElementById("pinTransferComparison").innerHTML = pinTransferComparisonHtml();
      showPinTransferStatus(`Открыт ${result.fileName}. PIN ещё не изменены.`);
    } else if (action === "restore") {
      PIN_TRANSFER_PREVIEW = null; await refreshViewerPublicationAccess(); renderSettings();
      document.getElementById("pinTransferPanel").open = true;
      showPinTransferStatus(`Восстановлены PIN: ${result.restored} врачей. Для синхронизации выгрузите новый общий набор.`);
    } else showPinTransferStatus(`Сохранено ${result.doctors} PIN: ${result.path}`);
  } catch (error) { showPinTransferStatus(error.message); }
  finally { setPinTransferBusy(false); }
}
async function applyPinTransferFromSettings() {
  if (pinTransferBusy || !PIN_TRANSFER_PREVIEW) return;
  const mapping = Array.from(document.querySelectorAll("[data-pin-source]"), select => ({ syncId: select.dataset.pinSource, targetId: select.value }));
  const input = { token: PIN_TRANSFER_PREVIEW.token, mapping, importAdmin: document.getElementById("pinTransferImportAdmin")?.checked === true,
    adopt: document.getElementById("pinTransferAdopt")?.checked === true };
  setPinTransferBusy(true); showPinTransferStatus("Сохраняются выбранные PIN…");
  try {
    const result = await DESKTOP_API.applyViewerPinImport(input);
    PIN_TRANSFER_PREVIEW = null; await refreshViewerPublicationAccess(); renderSettings();
    document.getElementById("pinTransferPanel").open = true;
    showPinTransferStatus(`Перенесено: ${result.matched}; изменено: ${result.updated}; пропущено: ${result.skipped}.${result.partial ? " Набор перенесён частично: завершите сопоставление до дальнейшей выгрузки." : " Общая версия PIN сохранена."}`);
  } catch (error) { showPinTransferStatus(error.message); }
  finally { setPinTransferBusy(false); }
}
