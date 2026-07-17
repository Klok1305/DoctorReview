"use strict";
/* ============================================================
 * ИНТЕРФЕЙС
 * ============================================================ */

const UI = {
  tab: "data",
  departmentMonth: null,
  departmentFilter: "all",
  deptMonth: null,
  deptFilter: "all",
  subFilter: "all",
  docMonth: null,
  docId: null,
  checkMonth: null,
  repMonth: null,
  repScope: "dept",
  cmp: [null, null, null],
  staffFilter: "",
  openGroups: {},
  openLists: {},
  setDoctor: null,
  pvSlice: 3,     // тогл первички: 3/6/12
  nazSlice: 1,    // тогл назначений: 1/3
  kbWin: 12,      // тогл окна базы: 12/36
  kbWinByDoctor: {},
  clientSegment: "risk",
  showLabels: true, // цифры на графиках
  charts: {},
  scoreChartModes: { chDeptScores: "all", chScores: "all" },
  scoreChartSources: {},
  setDepartment: null,
  setSpecialization: "",
};

function setControlsDisabled(ids, disabled) {
  for (const id of ids) {
    const control = document.getElementById(id);
    if (control) control.disabled = Boolean(disabled);
  }
}

function collapsibleListAttrs(key, defaultOpen = true) {
  const isOpen = Object.prototype.hasOwnProperty.call(UI.openLists, key) ? UI.openLists[key] : defaultOpen;
  return `class="collapsible-list" data-list-key="${esc(key)}" ${isOpen ? "open" : ""} ontoggle="rememberListToggle(${esc(JSON.stringify(key))}, this.open)"`;
}

function rememberListToggle(key, isOpen) {
  UI.openLists[key] = Boolean(isOpen);
}

function renderDesktopWorkspace() {
  if (!DESKTOP_API || !DESKTOP_STATE) return;
  const config = DESKTOP_STATE.config;
  document.querySelectorAll(".desktop-only").forEach(el => el.classList.remove("hidden"));
  const values = {
    workspaceRootPath: config.workspaceRoot,
    inputDirPath: config.inputDir,
    outputDirPath: config.outputDir,
    backupDirPath: config.backupDir,
    databasePath: config.databasePath,
  };
  for (const [id, value] of Object.entries(values)) {
    const el = document.getElementById(id);
    if (el) { el.textContent = value; el.title = value; }
  }
  const version = document.getElementById("desktopAppVersion");
  if (version) version.textContent = `Версия ${DESKTOP_STATE.app.version} · база SQLite ${DESKTOP_STATE.summary.schemaVersion}`;
  const footer = document.getElementById("footerText");
  if (footer) footer.textContent = "Приложение работает локально. Рабочая база сохраняется автоматически в SQLite; резервные копии создаются перед импортом и обновлением.";
  const autosaveButton = document.getElementById("btnAutosave");
  if (autosaveButton) autosaveButton.classList.add("hidden");
  const autosaveStatus = document.getElementById("autosaveStatus");
  if (autosaveStatus) autosaveStatus.classList.add("hidden");
  renderUpdateStatus(DESKTOP_STATE.update);
}

function renderUpdateStatus(status) {
  if (!DESKTOP_API || !status) return;
  const el = document.getElementById("updateStatus");
  if (el) el.textContent = status.message || "";
  const check = document.getElementById("btnCheckUpdates");
  if (check) {
    check.classList.toggle("hidden", !status.configured);
    check.disabled = status.state === "checking" || status.state === "downloading";
    check.textContent = status.state === "downloaded" ? "Установить загруженное" : "Проверить обновления";
  }
}

async function desktopDescriptorsToFiles(descriptors) {
  const files = [];
  let alreadyImported = 0;
  for (const descriptor of descriptors || []) {
    if (descriptor.imported) { alreadyImported++; continue; }
    const raw = await DESKTOP_API.readInputFile(descriptor.path);
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw && raw.data ? raw.data : raw);
    const file = new File([bytes], descriptor.name, { lastModified: descriptor.modifiedAt ? Date.parse(descriptor.modifiedAt) : Date.now() });
    Object.defineProperty(file, "__source", { value: descriptor, configurable: true });
    files.push(file);
  }
  if (alreadyImported) toast(`Ранее обработанные файлы пропущены: ${alreadyImported}`);
  return files;
}

async function desktopPickInputFiles() {
  try {
    const descriptors = await DESKTOP_API.pickInputFiles();
    const files = await desktopDescriptorsToFiles(descriptors);
    if (files.length) await handleFiles(files);
  } catch (error) {
    toast("Не удалось открыть файлы: " + error.message, true);
  }
}

async function desktopScanInput() {
  const button = document.getElementById("btnScanInput");
  const old = button ? button.textContent : "";
  if (button) { button.disabled = true; button.textContent = "⏳ Проверяю папку…"; }
  try {
    const descriptors = await DESKTOP_API.scanInputFolder();
    const files = await desktopDescriptorsToFiles(descriptors);
    if (!descriptors.length) toast("Во входной папке нет файлов .xls, .xlsx или .zip", true);
    else if (!files.length) toast("Новых выгрузок нет — все файлы уже обработаны");
    else await handleFiles(files);
  } catch (error) {
    toast("Ошибка проверки входной папки: " + error.message, true);
  } finally {
    if (button) { button.disabled = false; button.textContent = old; }
  }
}

async function desktopChooseWorkspace() {
  try {
    const result = await DESKTOP_API.chooseWorkspace();
    if (result.canceled) return;
    DESKTOP_STATE.config = result.config;
    DESKTOP_STATE.summary = result.summary;
    if (result.snapshot) applyLoadedDatabase(result.snapshot);
    renderDesktopWorkspace();
    renderAll();
    toast("Рабочая папка изменена; исходная база оставлена на прежнем месте как дополнительная копия");
  } catch (error) {
    toast("Не удалось изменить рабочую папку: " + error.message, true);
  }
}

async function desktopChooseFolder(kind) {
  try {
    const result = await DESKTOP_API.chooseFolder(kind);
    if (!result.canceled) {
      DESKTOP_STATE.config = result.config;
      renderDesktopWorkspace();
      toast("Папка сохранена");
      return true;
    }
    return false;
  } catch (error) {
    toast("Не удалось выбрать папку: " + error.message, true);
    return false;
  }
}

async function desktopBackupNow(portable = false) {
  try {
    const result = portable ? await DESKTOP_API.exportBackup() : await DESKTOP_API.createBackup();
    if (!result.canceled) toast("Резервная копия создана: " + result.path);
  } catch (error) {
    toast("Не удалось создать резервную копию: " + error.message, true);
  }
}

async function desktopRestoreBackup() {
  try {
    const result = await DESKTOP_API.restoreBackup();
    if (result.canceled) return;
    applyLoadedDatabase(result.snapshot);
    DESKTOP_STATE.summary = result.summary;
    renderAll();
    toast("База восстановлена. Перед восстановлением автоматически сохранена текущая версия.");
  } catch (error) {
    toast("Не удалось восстановить базу: " + error.message, true);
  }
}

async function desktopCheckUpdates() {
  try {
    if (DESKTOP_STATE.update && DESKTOP_STATE.update.state === "downloaded") {
      await DESKTOP_API.installDownloadedUpdate();
      return;
    }
    const status = await DESKTOP_API.checkUpdates();
    DESKTOP_STATE.update = status;
    renderUpdateStatus(status);
  } catch (error) {
    toast("Не удалось проверить обновления: " + error.message, true);
  }
}

function chart(id, cfg) {
  if (UI.charts[id]) { UI.charts[id].destroy(); delete UI.charts[id]; }
  const el = document.getElementById(id);
  if (!el) return;
  UI.charts[id] = new Chart(el.getContext("2d"), cfg);
}

function switchTab(tab) {
  UI.tab = tab;
  document.querySelectorAll("nav.tabs button").forEach(b => {
    const active = b.dataset.tab === tab;
    b.classList.toggle("active", active);
    if (active) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  document.querySelectorAll(".page").forEach(p => p.classList.toggle("active", p.id === "page-" + tab));
  renderAll();
}

/* сегментный переключатель периодов */
function segToggle(id, options, current, handler) {
  return `<span class="seg" id="${id}">` + options.map(o =>
    `<button type="button" data-segment-value="${esc(String(o.v))}" aria-pressed="${String(o.v) === String(current) ? "true" : "false"}" class="${String(o.v) === String(current) ? "active" : ""}"${o.disabled ? " disabled" : ""}${o.title ? ` title="${esc(o.title)}"` : ""} onclick="${esc(`${handler}(${JSON.stringify(o.v)})`)}">${esc(o.label)}</button>`
  ).join("") + `</span>`;
}

/* ---------- копирование ---------- */
function copyBtn(kind, id, label) {
  return `<button class="btn mini no-print" onclick="${kind}('${id}')" title="Скопировать — можно вставить в Excel/Word/письмо">⧉ ${label || "копировать"}</button>`;
}
async function copyTable(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const text = [...el.rows].map(r => [...r.cells].map(c => c.innerText.replace(/\s*\n\s*/g, " ").trim()).join("\t")).join("\n");
  try {
    const item = new ClipboardItem({
      "text/html": new Blob(['<meta charset="utf-8">' + el.outerHTML], { type: "text/html" }),
      "text/plain": new Blob([text], { type: "text/plain" }),
    });
    await navigator.clipboard.write([item]);
    toast("Таблица скопирована — вставьте в Excel или Word");
  } catch (e) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Таблица скопирована как текст");
    } catch (e2) {
      toast("Буфер обмена недоступен: " + e2.message, true);
    }
  }
}
function copyChart(id) {
  const cv = document.getElementById(id);
  if (!cv) return;
  const tmp = document.createElement("canvas");
  tmp.width = cv.width; tmp.height = cv.height;
  const ctx = tmp.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, tmp.width, tmp.height);
  ctx.drawImage(cv, 0, 0);
  tmp.toBlob(async blob => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast("График скопирован как картинка");
    } catch (e) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = id + ".png";
      a.click();
      toast("Буфер недоступен — график скачан файлом PNG");
    }
  });
}

/* подписи данных на графиках */
function dlDoughnut(totalGetter) {
  return {
    display: () => UI.showLabels,
    color: "#1c2333",
    backgroundColor: "rgba(255,255,255,.75)",
    borderRadius: 4,
    padding: 3,
    font: { size: 10, weight: "600" },
    formatter: (v, ctx) => {
      const total = totalGetter ? totalGetter() : ctx.dataset.data.reduce((a, b) => a + (b || 0), 0);
      const pct = total ? (v / total * 100) : 0;
      if (pct < 3) return null;
      return (v >= 1000000 ? (v / 1000000).toFixed(1) + " млн" : fmtNum(v)) + "\n" + pct.toFixed(0) + "%";
    },
    textAlign: "center",
  };
}

/* ================= СТРАНИЦА: ДАННЫЕ ================= */

async function saveSessionState() {
  const button = document.getElementById("btnSaveSession");
  const status = document.getElementById("sessionSaveStatus");
  if (!button || button.disabled) return false;
  const oldLabel = button.textContent;
  button.disabled = true;
  button.textContent = "⏳ Сохраняю…";
  if (status) status.textContent = "Фиксирую текущее состояние базы…";
  try {
    const saved = await saveLocal();
    if (!saved) throw new Error("хранилище не подтвердило запись");
    const destination = DESKTOP_API ? "в рабочую базу SQLite" : "в локальную базу браузера";
    const message = `Сохранено ${destination} · ${autosaveTime()}`;
    if (status) status.textContent = message;
    toast("✓ Все изменения текущей сессии сохранены");
    return true;
  } catch (error) {
    if (status) status.textContent = "Ошибка сохранения: " + error.message;
    toast("Не удалось сохранить изменения: " + error.message, true);
    return false;
  } finally {
    button.disabled = false;
    button.textContent = oldLabel;
  }
}

function renderData() {
  const asEl = document.getElementById("autosaveStatus");
  if (asEl) asEl.textContent = autosaveStatus || (DESKTOP_API ? "SQLite · автоматическое сохранение" : (window.showSaveFilePicker ? "не подключено" : "недоступно в этом браузере"));
  if (DESKTOP_API) renderDesktopWorkspace();

  const el = document.getElementById("dataSummary");
  const months = monthKeysSorted();
  setControlsDisabled(["btnClear"], !months.length && !Object.keys(DB.doctors).length);
  if (!months.length) {
    el.innerHTML = '<p class="muted">После загрузки здесь появится список месяцев и комплектность данных по каждому типу отчёта.</p>';
  } else {
    let html = '<table class="data"><tr><th>Месяц</th><th class="num">Выработка</th><th class="num">Давность посещений<br><span class="small muted">окна, мес.</span></th><th class="num">Назначения<br><span class="small muted">срезы, мес.</span></th><th class="num">Первичка<br><span class="small muted">срезы, мес.</span></th><th class="num">Загрузка расписания</th><th class="num">Запись в 1С</th></tr>';
    for (const k of [...months].reverse()) {
      const m = DB.months[k];
      const kbWins = new Set();
      Object.values(m.kb).forEach(w => Object.keys(w).forEach(x => kbWins.add(x)));
      const nazSlices = new Set();
      Object.values(m.naznach || {}).forEach(w => Object.keys(w).forEach(x => nazSlices.add(x)));
      const pv = Object.keys(m.pervichka).sort((a, b) => a - b).join(", ");
      html += `<tr><td><b>${monthLabel(k)}</b></td>
        <td class="num">${Object.keys(m.vyrabotka).length ? Object.keys(m.vyrabotka).length + " вр." : '<span class="muted">—</span>'}</td>
        <td class="num">${kbWins.size ? [...kbWins].sort((a, b) => a - b).join(", ") : '<span class="muted">—</span>'}</td>
        <td class="num">${nazSlices.size ? [...nazSlices].sort().join(", ") : '<span class="muted">—</span>'}</td>
        <td class="num">${pv || '<span class="muted">—</span>'}</td>
        <td class="num">${Object.keys(m.prostoy).length || '<span class="muted">—</span>'}</td>
        <td class="num">${Object.keys(m.zapis).length || '<span class="muted">—</span>'}</td></tr>`;
    }
    html += "</table>";
    el.innerHTML = html;
  }

  const completenessCard = document.getElementById("completenessCard");
  if (completenessCard) completenessCard.classList.toggle("hidden", !months.length);
  if (months.length) renderCompleteness();

  const logEl = document.getElementById("fileLog");
  if (!DB.fileLog.length) {
    logEl.innerHTML = '<p class="muted small">Журнал пуст.</p>';
  } else {
    const typeNames = { vyrabotka: "Выработка", kb: "Давность посещений", naznach: "Назначения", pervichka: "Первичка", prostoy: "Загрузка расписания", zapis: "Запись в 1С" };
    let html = '<table class="data"><tr><th>Файл</th><th>Тип</th><th>Врач</th><th>Период</th><th>Статус</th><th></th></tr>';
    DB.fileLog.slice(0, 60).forEach((l, i) => {
      const ok = l.status === "загружено";
      html += `<tr><td>${esc(l.name)}</td><td>${typeNames[l.type] || '<span class="muted">?</span>'}</td><td>${esc(l.doctor || "—")}</td><td class="small">${esc(l.period || "—")}</td>
        <td><span class="badge ${ok ? "ok" : l.status === "удалено" ? "mut" : "bad"}">${l.status}</span> <span class="small muted">${esc(l.note || "")}</span></td>
        <td>${l.slot ? `<button class="btn mini danger" onclick="removeFileData(${i})" title="Файл загружен по ошибке — убрать его данные из базы">🗑 убрать</button>` : ""}</td></tr>`;
    });
    html += "</table>";
    logEl.innerHTML = html;
  }
}

/* убрать из базы данные ошибочно загруженного файла (слот записан при загрузке) */
function removeFileData(i) {
  const l = DB.fileLog[i], s = l && l.slot, m = s && DB.months[s.mk];
  if (!m) { toast("Данные этого файла уже не найдены в базе", true); return; }
  if (!confirm(`Убрать из базы данные файла «${l.name}» (${l.period || s.mk})?`)) return;
  if (s.t === "vyrabotka") delete m.vyrabotka[s.doc];
  else if (s.t === "naznach" && m.naznach[s.doc]) { delete m.naznach[s.doc][s.sl]; if (!Object.keys(m.naznach[s.doc]).length) delete m.naznach[s.doc]; }
  else if (s.t === "kb" && m.kb[s.doc]) { delete m.kb[s.doc][s.sl]; if (!Object.keys(m.kb[s.doc]).length) delete m.kb[s.doc]; }
  else if (s.t === "pervichka") delete m.pervichka[s.sl];
  else if (s.t === "prostoy") m.prostoy = {};
  else if (s.t === "zapis") m.zapis = {};
  if (!Object.values(m).some(o => o && Object.keys(o).length)) delete DB.months[s.mk]; // месяц опустел
  l.status = "удалено";
  delete l.slot;
  saveLocal();
  renderAll();
  toast(`Данные файла «${l.name}» убраны из базы`);
}

function renderCompleteness() {
  const box = document.getElementById("completeness");
  const months = monthKeysSorted();
  if (!months.length) { box.innerHTML = ""; return; }
  if (!UI.checkMonth || !DB.months[UI.checkMonth]) UI.checkMonth = months[months.length - 1];
  const mk = UI.checkMonth;
  const m = DB.months[mk];

  const tracked = new Set();
  for (const mm of Object.values(DB.months)) {
    Object.keys(mm.vyrabotka).forEach(id => tracked.add(id));
    Object.keys(mm.kb).forEach(id => tracked.add(id));
    Object.keys(mm.naznach || {}).forEach(id => tracked.add(id));
  }
  const ids = [...tracked].filter(id => DB.doctors[id]).sort((a, b) => doctorName(a).localeCompare(doctorName(b), "ru"));
  const slices = Object.keys(m.pervichka).map(Number).sort((a, b) => a - b);
  const mark = ok => ok ? '<span style="color:var(--good)">✓</span>' : '<span style="color:var(--bad)">✗</span>';
  let html = `<div class="toolbar" style="margin-bottom:8px">
    <h2 style="margin:0">Полнота данных</h2>
    <span class="spacer"></span>
    <label>Месяц: <select id="checkMonthSel">${months.map(k => `<option value="${k}" ${k === mk ? "selected" : ""}>${monthLabel(k)}</option>`).join("")}</select></label>
  </div>
  <p class="small muted" style="margin-top:0">Общие отчёты за ${monthLabel(mk)}:
    загрузка расписания ${mark(Object.keys(m.prostoy).length)} ·
    запись в 1С ${mark(Object.keys(m.zapis).length)} ·
    первичка ${slices.length ? "срезы: " + slices.join(", ") + " мес." : mark(false)}
  </p>`;
  if (!ids.length) {
    html += '<p class="muted small">Персональные отчёты (выработка / давность / назначения) ещё не загружались.</p>';
  } else {
    const missBlocks = [];
    const missOf = (label, pred) => {
      const lst = ids.filter(pred);
      if (lst.length) missBlocks.push(`<p class="small"><span class="badge bad">Нет: ${label} (${lst.length})</span> ${lst.map(id => esc(doctorName(id))).join(", ")}</p>`);
    };
    missOf("выработка", id => !m.vyrabotka[id]);
    missOf("давность за месяц", id => !(m.kb[id] && m.kb[id]["1"]));
    missOf("давность ровно 12 мес для индекса возвращаемости", id => !(m.kb[id] && m.kb[id]["12"]));
    missOf("достаточное окно клиентской базы по настройкам специализации", id => {
      const wins = m.kb[id] ? Object.keys(m.kb[id]).map(Number) : [];
      const selected = recommendedClientBaseWindow(wins, profileForDoctor(id));
      return selected == null || !clientBaseWindowSufficient(selected, profileForDoctor(id));
    });
    missOf("давность 3 года", id => !(m.kb[id] && Object.keys(m.kb[id]).some(w => Number(w) >= 24)));
    missOf("назначения", id => !(m.naznach && m.naznach[id] && Object.keys(m.naznach[id]).length));
    if (!missBlocks.length) {
      html += `<p><span class="badge ok">Всё на месте</span> <span class="small muted">по всем ${ids.length} отслеживаемым врачам загружен полный комплект</span></p>`;
    } else {
      html += missBlocks.join("");
    }
  }
  box.innerHTML = html;
  document.getElementById("checkMonthSel").addEventListener("change", e => { UI.checkMonth = e.target.value; renderCompleteness(); });
}

/* ================= СТРАНИЦА: ОТДЕЛЕНИЕ ================= */

function departmentMetricDefs() {
  return [
    { key: "sales", label: "Выручка", get: r => r && r.econ.sales, fmt: fmtMoney, mode: "pct", goalKey: "revenue", goalFmt: fmtMoney },
    { key: "withRef", label: "Выручка с перенаправлениями", get: r => r && r.econ.revenueWithRef, fmt: fmtMoney, mode: "pct" },
    { key: "refShare", label: "Доля перенаправлений от выручки", get: r => r && r.cross.crossShare, fmt: fmtPct, mode: "pp", goalKey: "crossShare", goalFmt: fmtPct },
    { key: "pv3", label: "Возвращаемость первички за 3 месяца", get: r => r && r.loyalty.pvSlices[3] ? r.loyalty.pvSlices[3].pct : null, fmt: fmtPct, mode: "pp", goalKey: "pervichka", goalFmt: fmtPct, goalPeriod: 3 },
    { key: "pv6", label: "Возвращаемость первички за 6 месяцев", get: r => r && r.loyalty.pvSlices[6] ? r.loyalty.pvSlices[6].pct : null, fmt: fmtPct, mode: "pp", goalKey: "pervichka", goalFmt: fmtPct, goalPeriod: 6 },
    { key: "active", label: "Активная клиентская база", get: r => r && r.akb.primary ? r.akb.primary.seg.active : null, fmt: v => fmtNum(v), mode: "pct", goalKey: "akbShare", goalFmt: fmtPct, goalLabel: "доля активной базы", goalGet: r => r && r.akb.primary && r.akb.primary.sourceWindowComplete ? r.akb.primary.activeBasePct : null },
    { key: "lost", label: "Потерянная клиентская база", get: r => r && r.akb.primary && r.akb.primary.sourceWindowComplete ? r.akb.primary.seg.lost : null, fmt: v => fmtNum(v), mode: "pct", lower: true, goalKey: "churn", goalFmt: fmtPct, goalLabel: "потерянные за 3 года", goalGet: r => { const kb = r && r.akb.primary; return kb && kb.sourceWindowComplete && kb.windows && kb.windows.length === 1 && kb.windows[0] >= 36 ? kb.lostPct : null; }, goalLower: true },
    { key: "sched", label: "Загрузка отделения за месяц", get: r => r && r.loyalty.sched ? r.loyalty.sched.pct : null, fmt: fmtPct, mode: "pp", goalKey: "schedLoad", goalFmt: fmtPct },
  ];
}

function departmentGoalInfo(def, result, profile) {
  if (!profile || !def.goalKey || (def.goalPeriod && Number(profile.pervichkaM) !== Number(def.goalPeriod))) return null;
  const benchmarks = profile.scoring && profile.scoring.benchmarks;
  const target = benchmarks ? Number(benchmarks[def.goalKey]) : NaN;
  if (!Number.isFinite(target) || target <= 0) return null;
  const value = def.goalGet ? def.goalGet(result) : def.get(result);
  const known = value != null && !isNaN(value);
  const lower = def.goalLower === true;
  const meetsGoal = known && (lower ? Number(value) <= target : Number(value) >= target);
  const state = !known ? "department-goal-plain" : (meetsGoal ? "department-goal-good" : "department-goal-bad");
  const fmt = def.goalFmt || def.fmt || fmtNum;
  const label = def.goalLabel ? `Цель — ${def.goalLabel}` : "Цель";
  return {
    state,
    text: `${label}: ${lower ? "≤" : "≥"} ${fmt(target)}${known && def.goalGet ? ` · факт ${fmt(value)}` : ""}${!known && def.goalGet ? " · факт н/д" : ""}`,
  };
}

function departmentTrend(current, base, def) {
  if (current == null || base == null || isNaN(current) || isNaN(base)) return '<span class="muted">—</span>';
  const delta = def.mode === "pp" ? current - base : (base ? (current - base) / Math.abs(base) * 100 : null);
  if (delta == null || isNaN(delta)) return '<span class="muted">—</span>';
  const flat = Math.abs(delta) < 0.05;
  const favorable = def.lower ? delta < 0 : delta > 0;
  const cls = flat ? "flat" : (favorable ? "up" : "down");
  const arrow = flat ? "→" : (delta > 0 ? "▲" : "▼");
  const value = def.mode === "pp" ? fmtNum(Math.abs(delta), 1) + " п.п." : fmtPct(Math.abs(delta), 1);
  return `<span class="delta ${cls}">${arrow} ${value}</span>`;
}

function renderDepartmentCharts(history, defs) {
  const labels = history.map(x => monthLabel(x.mk).replace(/ \d{4}$/, ""));
  const vals = key => {
    const def = defs.find(d => d.key === key);
    return history.map(x => def.get(x.r));
  };
  const common = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { position: "bottom" }, datalabels: { display: false } },
  };
  chart("chDepartmentRevenue", {
    type: "bar",
    data: { labels, datasets: [
      { label: "Выручка", data: vals("sales"), backgroundColor: "rgba(37,99,235,.55)", borderColor: "#2563eb", borderWidth: 1 },
      { label: "С перенаправлениями", data: vals("withRef"), type: "line", borderColor: "#7c3aed", backgroundColor: "#7c3aed", tension: .25, pointRadius: 3 },
    ] },
    options: { ...common, scales: { y: { beginAtZero: true, ticks: { callback: v => Math.abs(v) >= 1000000 ? fmtNum(v / 1000000, 1) + " млн" : fmtNum(v) } } } },
  });
  chart("chDepartmentRates", {
    type: "line",
    data: { labels, datasets: [
      { label: "Первичка 3 мес.", data: vals("pv3"), borderColor: "#2563eb", backgroundColor: "#2563eb", tension: .25, spanGaps: true },
      { label: "Первичка 6 мес.", data: vals("pv6"), borderColor: "#7c3aed", backgroundColor: "#7c3aed", tension: .25, spanGaps: true },
      { label: "Доля перенаправлений", data: vals("refShare"), borderColor: "#d97706", backgroundColor: "#d97706", tension: .25, spanGaps: true },
      { label: "Загрузка", data: vals("sched"), borderColor: "#059669", backgroundColor: "#059669", tension: .25, spanGaps: true },
    ] },
    options: { ...common, scales: { y: { beginAtZero: true, suggestedMax: 100, ticks: { callback: v => v + "%" } } } },
  });
  chart("chDepartmentBase", {
    type: "line",
    data: { labels, datasets: [
      { label: "Активная база", data: vals("active"), borderColor: "#059669", backgroundColor: "rgba(5,150,105,.15)", fill: true, tension: .25, spanGaps: true },
      { label: "Потерянная база", data: vals("lost"), borderColor: "#dc2626", backgroundColor: "rgba(220,38,38,.1)", fill: true, tension: .25, spanGaps: true },
    ] },
    options: { ...common, scales: { y: { beginAtZero: true } } },
  });
}

function renderDepartment() {
  const months = monthKeysSorted();
  const monthSelect = document.getElementById("departmentMonth");
  const filterSelect = document.getElementById("departmentFilter");
  setControlsDisabled(["departmentMonth", "departmentFilter"], !months.length);
  if (!months.length) {
    monthSelect.innerHTML = "";
    filterSelect.innerHTML = "";
    document.getElementById("departmentBody").innerHTML = '<div class="card"><p class="muted">Загрузите данные на вкладке «Данные».</p></div>';
    return;
  }

  if (!UI.departmentMonth || !DB.months[UI.departmentMonth]) UI.departmentMonth = months[months.length - 1];
  monthSelect.innerHTML = months.map(k => `<option value="${k}" ${k === UI.departmentMonth ? "selected" : ""}>${monthLabel(k)}</option>`).join("");
  const groups = departmentGroups();
  const names = Object.keys(groups);
  if (UI.departmentFilter !== "all" && !groups[UI.departmentFilter]) UI.departmentFilter = "all";
  filterSelect.innerHTML = `<option value="all">все отделения</option>` + names.map(name => `<option value="${esc(name)}" ${name === UI.departmentFilter ? "selected" : ""}>${esc(name)}</option>`).join("");

  const mk = UI.departmentMonth;
  const specs = departmentSpecializations(UI.departmentFilter);
  const year = mk.slice(0, 4);
  const yearMonths = months.filter(k => k.startsWith(year + "-") && k <= mk);
  const history = yearMonths.map(k => ({ mk: k, r: aggregateDeptMonth(k, specs) }));
  const current = history.find(x => x.mk === mk).r;
  const previousKey = prevMonthKey(mk);
  const previousInHistory = history.find(x => x.mk === previousKey);
  const previous = previousInHistory ? previousInHistory.r : aggregateDeptMonth(previousKey, specs);
  const prior = history.filter(x => x.mk < mk && x.r);
  const mean = values => {
    const xs = values.filter(v => v != null && !isNaN(v));
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const defs = departmentMetricDefs();
  const scope = UI.departmentFilter === "all" ? "Все отделения" : UI.departmentFilter;
  const goalProfile = UI.departmentFilter === "all" ? null : departmentProfile(UI.departmentFilter);

  if (!current) {
    document.getElementById("departmentBody").innerHTML = `<div class="notice blue">В ${monthLabel(mk)} по отделению «${esc(scope)}» нет данных. Проверьте состав отделений в настройках или выберите другой месяц.</div>`;
    return;
  }

  let html = `<div class="notice blue"><b>${esc(scope)}</b>: расчетные профили — ${specs.map(esc).join(", ") || "не настроены"}. Стрелки сравнивают месяц с предыдущим календарным месяцем и со средним значением прошлых месяцев ${year} года.${goalProfile ? " Итоговое значение зелёное, если цель отделения выполнена, красное — если не выполнена; без сопоставимой цели цвет нейтральный." : " Для сводной по всем отделениям единая цель не применяется."}</div>`;
  html += '<div class="grid cols-4">' + defs.map(def => {
    const cur = def.get(current);
    const prev = def.get(previous);
    const avg = mean(prior.map(x => def.get(x.r)));
    const goal = departmentGoalInfo(def, current, goalProfile);
    return `<div class="kpi ${goal ? goal.state : "department-goal-plain"}"><div class="lbl">${def.label}</div><div class="val" style="font-size:${def.key === "sales" || def.key === "withRef" ? "19px" : "24px"}">${def.fmt(cur)}</div>
      ${goal ? `<div class="sub department-goal-note">${goal.text}</div>` : ""}
      <div class="sub">к прошлому месяцу: ${departmentTrend(cur, prev, def)}</div>
      <div class="sub">к среднему до текущего месяца: ${departmentTrend(cur, avg, def)}</div></div>`;
  }).join("") + "</div>";

  const specRows = specs.map(spec => ({ spec, r: aggregateDeptMonth(mk, [spec]) })).filter(row => row.r);
  html += `<div class="card"><h2>Итоги профилей внутри отделения за ${monthLabel(mk)} <span class="spacer"></span>${copyBtn("copyTable", "tblDepartmentSpecs")}</h2>
    <p class="small muted" style="margin-top:0">Клиентская база рассчитывается по порогам и окну каждой специализации. Если выгрузка короче требуемого окна, потерянная база не сравнивается как точное значение.</p>
    <table class="data" id="tblDepartmentSpecs"><tr><th>Профиль</th><th class="num">Врачей</th><th class="num">Выручка</th><th class="num">С перенаправлениями</th><th class="num">Доля перенапр.</th><th class="num">Первичка 3 мес.</th><th class="num">Первичка 6 мес.</th><th class="num">Активная база</th><th class="num">Потерянная база</th><th class="num">Загрузка</th></tr>`;
  for (const row of specRows) {
    const r = row.r, kb = r && r.akb.primary;
    const lost = kb ? `${kb.sourceWindowComplete ? "" : "≥"}${fmtNum(kb.seg.lost)}` : "—";
    html += `<tr><td><b>${esc(row.spec)}</b></td><td class="num">${r ? fmtNum(r.doctors) : "—"}</td><td class="num">${r ? fmtMoney(r.econ.sales) : "—"}</td><td class="num">${r ? fmtMoney(r.econ.revenueWithRef) : "—"}</td><td class="num">${r ? fmtPct(r.cross.crossShare) : "—"}</td><td class="num">${r && r.loyalty.pvSlices[3] ? fmtPct(r.loyalty.pvSlices[3].pct) : "—"}</td><td class="num">${r && r.loyalty.pvSlices[6] ? fmtPct(r.loyalty.pvSlices[6].pct) : "—"}</td><td class="num">${kb ? fmtNum(kb.seg.active) : "—"}</td><td class="num">${lost}</td><td class="num">${r && r.loyalty.sched ? fmtPct(r.loyalty.sched.pct) : "—"}</td></tr>`;
  }
  html += "</table></div>";

  html += `<div class="grid cols-2"><div class="card"><h2>Выручка за ${year} год <span class="spacer"></span>${copyBtn("copyChart", "chDepartmentRevenue", "график")}</h2><div class="chart-box"><canvas id="chDepartmentRevenue"></canvas></div></div>
    <div class="card"><h2>Возвращаемость, перенаправления и загрузка <span class="spacer"></span>${copyBtn("copyChart", "chDepartmentRates", "график")}</h2><div class="chart-box"><canvas id="chDepartmentRates"></canvas></div></div></div>
    <div class="card"><h2>Клиентская база за ${year} год <span class="spacer"></span>${copyBtn("copyChart", "chDepartmentBase", "график")}</h2><div class="chart-box"><canvas id="chDepartmentBase"></canvas></div></div>`;

  html += `<div class="card"><h2>Годовая таблица показателей <span class="spacer"></span>${copyBtn("copyTable", "tblDepartmentYear")}</h2><table class="data" id="tblDepartmentYear"><tr><th>Месяц</th>${defs.map(d => `<th class="num">${d.label}</th>`).join("")}</tr>`;
  for (const point of history) html += `<tr><td>${monthLabel(point.mk)}</td>${defs.map(d => `<td class="num">${d.fmt(d.get(point.r))}</td>`).join("")}</tr>`;
  html += "</table></div>";

  document.getElementById("departmentBody").innerHTML = html;
  renderDepartmentCharts(history, defs);
}

/* ================= СТРАНИЦА: СПЕЦИАЛИЗАЦИЯ ================= */

function deptRows(mk, deptFilter = UI.deptFilter, subFilter = UI.subFilter) {
  const core = coreDoctorsInMonth(mk);
  const docIds = core.length ? core : doctorsInMonth(mk);
  let filtered = deptFilter === "all" ? docIds : docIds.filter(id => doctorDept(id) === deptFilter);
  if (deptFilter !== "all" && subFilter && subFilter !== "all") {
    filtered = filtered.filter(id => (DB.doctors[id] && DB.doctors[id].subdept) === subFilter);
  }
  const rows = [];
  for (const id of filtered) {
    const r = computeMetrics(id, mk);
    if (r) rows.push({ id, r });
  }
  rows.sort((a, b) => (b.r.econ.sales ?? -1) - (a.r.econ.sales ?? -1));
  return { rows, allIds: docIds };
}

function deptKpiTrend(current, average, mode) {
  if (current == null || average == null || isNaN(current) || isNaN(average)) return "";
  const delta = mode === "pp" ? current - average : (average ? (current - average) / Math.abs(average) * 100 : null);
  if (delta == null || isNaN(delta)) return "";
  const flat = Math.abs(delta) < 0.05;
  const cls = flat ? "flat" : delta > 0 ? "up" : "down";
  const arrow = flat ? "→" : delta > 0 ? "▲" : "▼";
  const value = mode === "pp" ? fmtNum(Math.abs(delta), 1) + " п.п." : fmtPct(Math.abs(delta), 1);
  return `<span class="delta ${cls}" title="Отклонение от среднего по доступным месяцам года">${arrow} ${value}</span>`;
}

function renderDept() {
  const months = monthKeysSorted();
  const sel = document.getElementById("deptMonth");
  setControlsDisabled(["btnXlsx", "deptMonth", "deptFilter", "subFilter"], !months.length);
  if (!months.length) {
    document.getElementById("deptBody").innerHTML = '<div class="card"><p class="muted">Загрузите данные на вкладке «Данные».</p></div>';
    sel.innerHTML = "";
    document.getElementById("deptFilter").innerHTML = "";
    return;
  }
  if (!UI.deptMonth || !DB.months[UI.deptMonth]) UI.deptMonth = months[months.length - 1];
  sel.innerHTML = months.map(k => `<option value="${k}" ${k === UI.deptMonth ? "selected" : ""}>${monthLabel(k)}</option>`).join("");
  const mk = UI.deptMonth;
  const { rows, allIds } = deptRows(mk);

  const depts = deptListForMonth(mk, allIds);
  const fSel = document.getElementById("deptFilter");
  fSel.innerHTML = `<option value="all">все специализации</option>` + depts.map(d => `<option value="${esc(d)}" ${UI.deptFilter === d ? "selected" : ""}>${esc(d)}</option>`).join("");
  if (UI.deptFilter !== "all" && !depts.includes(UI.deptFilter)) { UI.deptFilter = "all"; fSel.value = "all"; }
  // группы выбранной специализации (задаются в профиле специализации)
  const subSel = document.getElementById("subFilter");
  if (subSel) {
    const subs = UI.deptFilter !== "all" ? (deptProfile(UI.deptFilter).subdivisions || []) : [];
    subSel.innerHTML = `<option value="all">все подразделения</option>` + subs.map(s => `<option value="${esc(s)}" ${UI.subFilter === s ? "selected" : ""}>${esc(s)}</option>`).join("");
    subSel.parentElement.style.display = subs.length ? "" : "none";
    if (UI.subFilter !== "all" && !subs.includes(UI.subFilter)) { UI.subFilter = "all"; subSel.value = "all"; }
  }

  const totalSales = rows.reduce((a, x) => a + (x.r.econ.sales || 0), 0);
  const totalRef = rows.reduce((a, x) => a + (x.r.econ.refRevenue || 0), 0);
  const deptCurrent = aggregateDeptMonth(mk, UI.deptFilter, UI.subFilter);
  const currentPatients = deptCurrent ? deptCurrent.traffic.patients : null;
  const currentKb = deptCurrent && deptCurrent.akb.primary;
  const currentActiveBasePct = currentKb ? currentKb.activeBasePct : null;
  const currentLoadPct = deptCurrent && deptCurrent.loyalty.sched ? deptCurrent.loyalty.sched.pct : null;
  const year = mk.slice(0, 4);
  const ytdDept = monthKeysSorted()
    .filter(k => k.startsWith(year + "-") && k <= mk)
    .map(k => aggregateDeptMonth(k, UI.deptFilter, UI.subFilter))
    .filter(Boolean);
  const meanKnown = values => {
    const xs = values.filter(v => v != null && !isNaN(v));
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const avgPatientsYtd = meanKnown(ytdDept.map(r => r.traffic.patients));
  const avgActiveBasePctYtd = meanKnown(ytdDept.map(r => r.akb.primary ? r.akb.primary.activeBasePct : null));
  const avgLoadPctYtd = meanKnown(ytdDept.map(r => r.loyalty.sched ? r.loyalty.sched.pct : null));

  let html = `<div class="grid cols-5">
    <div class="kpi"><div class="lbl">Пациенты за месяц</div><div class="val">${fmtNum(currentPatients)} ${deptKpiTrend(currentPatients, avgPatientsYtd, "pct")}</div><div class="sub">среднее за ${year}: ${fmtNum(avgPatientsYtd)}</div></div>
    <div class="kpi"><div class="lbl">Доля активной базы</div><div class="val">${fmtPct(currentActiveBasePct)} ${deptKpiTrend(currentActiveBasePct, avgActiveBasePctYtd, "pp")}</div><div class="sub">окно по настройкам${currentKb && !currentKb.sourceWindowComplete ? " · выгрузка неполная" : ""} · среднее за ${year}: ${fmtPct(avgActiveBasePctYtd)}</div></div>
    <div class="kpi"><div class="lbl">Выручка</div><div class="val" style="font-size:19px">${fmtMoney(totalSales)}</div></div>
    <div class="kpi"><div class="lbl">Выручка от перенаправлений</div><div class="val" style="font-size:19px">${fmtMoney(totalRef)}</div></div>
    <div class="kpi"><div class="lbl">Загрузка отделения</div><div class="val">${fmtPct(currentLoadPct)} ${deptKpiTrend(currentLoadPct, avgLoadPctYtd, "pp")}</div><div class="sub">среднее за ${year}: ${fmtPct(avgLoadPctYtd)}</div></div>
  </div>`;

  // сводная таблица: жирным зелёным — лучший по колонке, красным — худший (при ≥3 значениях)
  const showScCol = DB.settings.showScores;
  const colDefs = [
    { name: "Выручка", get: x => x.r.econ.sales, fmt: fmtMoney },
    { name: "С перенаправл.", get: x => x.r.econ.revenueWithRef, fmt: fmtMoney },
    { name: "Ср. чек пациента", get: x => x.r.econ.avgClient, fmt: fmtMoney },
    { name: "Загрузка расписания", get: x => x.r.loyalty.sched ? x.r.loyalty.sched.pct : null, fmt: fmtPct },
    { name: `Возвращаемость первички (${UI.pvSlice} мес.)`, get: x => { const pv = x.r.loyalty.pvSlices[UI.pvSlice]; return pv ? pv.pct : null; }, fmt: fmtPct },
    { name: "Доля выручки от перенаправлений", get: x => x.r.cross.crossShare, fmt: fmtPct },
  ];
  for (const cd of colDefs) {
    const vals = rows.map(cd.get).filter(v => v != null && !isNaN(v));
    cd.best = vals.length >= 3 && new Set(vals).size > 1 ? Math.max(...vals) : null;
    cd.worst = vals.length >= 3 && new Set(vals).size > 1 ? Math.min(...vals) : null;
  }
  const hlCell = (cd, x) => {
    const v = cd.get(x);
    let st = "";
    if (v != null && cd.best != null && v === cd.best) st = "font-weight:700;color:var(--good)";
    else if (v != null && cd.worst != null && v === cd.worst) st = "font-weight:700;color:var(--bad)";
    return `<td class="num" style="${st}">${v != null ? cd.fmt(v) : "—"}</td>`;
  };
  html += `<div class="card"><h2>Сводная по специалистам <span class="small muted">(зелёным — лучший, красным — худший)</span> <span class="spacer"></span>${copyBtn("copyTable", "tblRating")}</h2><table class="data" id="tblRating">
    <tr><th>#</th><th>Специалист</th>${showScCol ? '<th class="num">Балл<br><span class="small muted">из 100</span></th>' : ""}${colDefs.map(cd => `<th class="num">${cd.name}</th>`).join("")}</tr>`;
  rows.forEach((x, i) => {
    html += `<tr style="cursor:pointer" onclick="openDoctor('${x.id}','${mk}')"><td class="muted">${i + 1}</td>
      <td><b>${esc(doctorName(x.id))}</b>${x.r.partial ? ' <span class="badge warn" title="нет: ' + esc(x.r.missing.join(", ")) + '">частично</span>' : ""}</td>
      ${showScCol ? `<td class="num">${scoreBadge(x.r.scores ? x.r.scores.total : null, x.r.scores ? x.r.scores.rankEligible : false, x.r.scores ? x.r.scores.coveragePct : null)}</td>` : ""}
      ${colDefs.map(cd => hlCell(cd, x)).join("")}</tr>`;
  });
  html += '</table><p class="small muted">Клик по строке — профайл специалиста. «частично» — загружены не все отчёты.</p></div>';

  // лидерборды
  const lb = (title, getter, fmt) => {
    const top = rows.map(x => ({ id: x.id, v: getter(x.r) })).filter(x => x.v != null).sort((a, b) => b.v - a.v).slice(0, 5);
    let s = `<div class="card"><h3>${title}</h3>`;
    if (!top.length) return s + '<p class="muted small">нет данных</p></div>';
    s += top.map((x, i) => `<div class="metric-row"><span class="mname">${i + 1}. ${esc(doctorName(x.id))}</span><span class="mval">${fmt(x.v)}</span></div>`).join("");
    return s + "</div>";
  };
  html += '<div class="grid cols-3">';
  html += lb("💳 Максимальный средний чек на пациента", r => r.econ.avgClient, fmtMoney);
  html += lb("🔁 Лучшая возвращаемость первички", r => { const pv = r.loyalty.pvSlices[UI.pvSlice]; return pv ? pv.pct : null; }, fmtPct);
  html += lb("🤝 Наивысшая доля выручки от перенаправлений", r => r.cross.crossShare, fmtPct);
  html += "</div>";

  // тепловая карта экспертных позиций — при выбранной специализации (у каждой свой набор)
  if (UI.deptFilter !== "all") {
    const fProfile = deptProfile(UI.deptFilter);
    const devs = (fProfile.expertise.items || []).map(d => d.name);
    const withVy = rows.filter(x => x.r.product);
    if (devs.length && withVy.length && fProfile.expertise.mode !== "none") {
      let maxQ = 1;
      for (const x of withVy) for (const dv of devs) maxQ = Math.max(maxQ, x.r.product.expert[dv] ? x.r.product.expert[dv].q : 0);
      html += `<div class="card"><h2>🔥 Тепловая карта: ${esc(fProfile.expertise.title)} <span class="small muted">(за месяц, шт)</span> <span class="spacer"></span>${copyBtn("copyTable", "tblHeat")}</h2><table class="data" id="tblHeat"><tr><th>Специалист</th>` + devs.map(d => `<th class="num">${esc(d)}</th>`).join("") + '<th class="num">Итого</th></tr>';
      const devTotals = {};
      for (const x of withVy) {
        let rowTotal = 0;
        html += `<tr><td>${esc(doctorName(x.id))}</td>`;
        for (const dv of devs) {
          const q = x.r.product.expert[dv] ? x.r.product.expert[dv].q : 0;
          rowTotal += q;
          devTotals[dv] = (devTotals[dv] || 0) + q;
          const alpha = q ? 0.15 + 0.7 * (q / maxQ) : 0;
          html += `<td class="num"><div class="heat-cell" style="background:rgba(37,99,235,${alpha.toFixed(2)});color:${alpha > 0.5 ? "#fff" : "inherit"};padding:2px 6px">${q || "·"}</div></td>`;
        }
        html += `<td class="num"><b>${rowTotal}</b></td></tr>`;
      }
      html += '<tr><td><b>Итого по специализации</b></td>' + devs.map(dv => `<td class="num"><b>${devTotals[dv] || 0}</b></td>`).join("") + `<td class="num"><b>${Object.values(devTotals).reduce((a, b) => a + b, 0)}</b></td></tr>`;
      html += '</table><p class="small muted">«·» по всем врачам — простаивающая позиция. Набор настраивается в профиле специализации.</p></div>';
    }
  } else if (rows.some(x => x.r.product)) {
    html += `<div class="card"><p class="small muted" style="margin:0">🔥 Тепловая карта аппаратов/услуг доступна при выборе конкретной специализации в фильтре сверху — у каждой специализации свой набор отслеживаемых позиций.</p></div>`;
  }

  // риск-мониторинг: у каждой специализации своё окно, достаточное для её порога потери
  const withKb = rows.map(x => ({ ...x, kb: selectedClientBaseSummary(x.r, profileForDoctor(x.id)), baseProfile: profileForDoctor(x.id) })).filter(x => x.kb);
  if (withKb.length) {
    html += `<div class="card"><h2>🚨 Мониторинг базы — окна по настройкам специализаций <span class="spacer"></span>${copyBtn("copyTable", "tblRisk")}</h2><table class="data" id="tblRisk"><tr><th>Специалист</th><th>Настройки базы</th><th class="num">Окно выгрузки</th><th class="num">База</th><th class="num">Активная</th><th class="num">Риск</th><th class="num">Спящая</th><th class="num">Потерянная</th><th class="num">Лояльных</th><th class="num">Выручка под риском</th></tr>`;
    for (const x of withKb) {
      const kb = x.kb, p = x.baseProfile;
      const windowStatus = kb.sourceWindowComplete ? `${fmtNum(kb.window)} мес.` : `${fmtNum(kb.window)} мес. · нужно ≥${fmtNum(kb.requiredWindowM)}`;
      html += `<tr><td>${esc(doctorName(x.id))}<br><span class="small muted">${esc(resolvedSpecializationName(x.id) || resolvedDepartmentName(x.id))}</span></td>
        <td class="small">активная ≤${fmtNum(p.activeM, 1)} мес.<br>потерянная &gt;${fmtNum(p.riskM, 1)} мес.</td>
        <td class="num ${kb.sourceWindowComplete ? "" : "muted"}">${windowStatus}</td><td class="num">${fmtNum(kb.total)}</td>
        <td class="num" style="color:var(--good)"><b>${fmtNum(kb.seg.active)}</b></td>
        <td class="num" style="color:var(--warn)"><b>${fmtNum(kb.seg.risk)}</b></td>
        <td class="num muted">${fmtNum(kb.seg.sleep)}</td>
        <td class="num" style="color:var(--bad)">${kb.sourceWindowComplete ? "" : "≥"}${fmtNum(kb.seg.lost)}</td>
        <td class="num">${fmtNum(kb.loyalCount)}</td>
        <td class="num">${fmtMoney(kb.revenueAtRisk)}</td></tr>`;
    }
    html += '</table><p class="small muted">Статус зависит от давности последнего визита и порогов специализации. Знак «≥» означает известный минимум: такая выгрузка короче требуемого окна и не используется как точное значение потерь в динамике.</p></div>';
  }

  // профайлы специалистов — все врачи фильтра, метрики в строках
  if (rows.length >= 1) {
    html += `<div class="card"><h2>👥 Профайлы специалистов <span class="small muted">(все ${rows.length}${UI.deptFilter !== "all" ? " · " + esc(UI.deptFilter) : ""})</span> <span class="spacer"></span>${copyBtn("copyTable", "tblCompare")}</h2>
      <p class="small muted" style="margin-top:0">${UI.deptFilter !== "all" ? "Зелёный — цель специализации выполнена, красный — не выполнена; без цвета — цель не задана." : "Выберите специализацию, чтобы увидеть её цели и раскраску выполнения."} Клик по фамилии — профайл.</p>
      <div id="cmpTable" style="overflow-x:auto"></div></div>`;
  }

  /* ---- динамика специализации: точки роста и риска ---- */
  const deptDyn = computeDeptDynamics(mk, UI.deptFilter, UI.subFilter);
  if (deptDyn && deptDyn.months.length) {
    html += dynamicsHtml(deptDyn, "blkDeptDyn", "Динамика специализации: точки роста и риска",
      `${UI.deptFilter === "all" ? "Все врачи с данными" : "Специализация «" + esc(UI.deptFilter) + "»"} · последние ${deptDyn.months.length} мес. по ${monthLabel(mk)}. Последний месяц сравнивается с прошлым и со средним предыдущих месяцев. Деньги и визиты суммируются, пациенты дедуплицируются, доли и конверсии взвешиваются; средний балл включает только врачей с полнотой данных от 80%.`,
      `dept|${mk}|${UI.deptFilter}|${UI.subFilter}`);
    if (DB.settings.showScores && deptDyn.months.length >= 2) {
      html += `<div id="chDeptScoresWrap"><h3 class="small muted" style="margin:14px 0 6px">СРЕДНИЕ БАЛЛЫ ПО ВЕКТОРАМ ПО МЕСЯЦАМ ${copyBtn("copyChart", "chDeptScores", "PNG")}</h3>
        ${scoreChartPicker("chDeptScores")}
        <div class="chart-box score-chart"><canvas id="chDeptScores"></canvas></div></div>`;
    }
    html += "</div>";
  }

  document.getElementById("deptBody").innerHTML = html;
  renderCompare(mk, rows);
  if (deptDyn && deptDyn.months.length >= 2) {
    renderDynCharts(deptDyn, "blkDeptDyn");
    if (DB.settings.showScores) {
      const rendered = renderScoresChart("chDeptScores", deptDyn.months,
        (k, vk) => { const rr = deptDyn.results[k]; return rr && rr.vecAvg ? rr.vecAvg[vk] : null; },
        k => { const rr = deptDyn.results[k]; return rr && rr.scores ? rr.scores.total : null; });
      if (!rendered) document.getElementById("chDeptScoresWrap")?.remove();
    }
  }
}

function renderCompare(mk, rows) {
  const box = document.getElementById("cmpTable");
  if (!box) return;
  // rows приходят из renderDept (все врачи текущего фильтра); фолбэк — пересчёт
  if (!rows) rows = deptRows(mk).rows;
  if (!rows.length) { box.innerHTML = '<p class="muted small">Нет специалистов.</p>'; return; }
  const goalProfile = UI.deptFilter !== "all" ? deptProfile(UI.deptFilter) : null;
  const specializationGoals = goalProfile && goalProfile.scoring ? goalProfile.scoring.benchmarks : null;
  const primaryReturnMonths = goalProfile ? (goalProfile.pervichkaM || 3) : UI.pvSlice;
  const expertTitle = goalProfile && goalProfile.expertise ? (goalProfile.expertise.title || "экспертных услуг") : "экспертных услуг";
  const hasCrossFocus = rows.some(row => {
    const focus = profileForDoctor(row.id).crossFocus;
    return Boolean(focus && focus.items && focus.items.length);
  });
  const comparisonKb = (r, doctorId) => selectedClientBaseSummary(r, profileForDoctor(doctorId));
  const exactBaseShare = (r, doctorId, key) => {
    const kb = comparisonKb(r, doctorId);
    return kb && kb.sourceWindowComplete ? kb[key] : null;
  };
  const baseShareMarkup = (r, doctorId, key) => {
    const kb = comparisonKb(r, doctorId);
    if (!kb) return "—";
    return kb.sourceWindowComplete ? fmtPct(kb[key]) : `н/д · окно ${fmtNum(kb.window)} мес.`;
  };
  const hasGoal = value => value != null && value !== "" && !isNaN(value) && Number(value) > 0;
  const targetFor = def => def.targetKey && specializationGoals && hasGoal(specializationGoals[def.targetKey])
    ? Number(specializationGoals[def.targetKey])
    : null;
  const targetMarkup = def => {
    const target = targetFor(def);
    if (target == null) return '<span class="muted">—</span>';
    const fmt = def.targetFmt || def.valueFmt || (v => fmtNum(v));
    return `<span class="compare-goal-target">${def.lower ? "≤" : "≥"} ${fmt(target)}</span>`;
  };
  const targetState = (def, value) => {
    const target = targetFor(def);
    if (target == null || value == null || isNaN(value)) return "";
    return def.lower ? (Number(value) <= target ? "goal-good" : "goal-bad") : (Number(value) >= target ? "goal-good" : "goal-bad");
  };
  // Метрики без цели остаются нейтральными. Зелёный/красный означает выполнение цели специализации, а не место среди коллег.
  const rowsDef = [
    { name: "Выручка", fmt: r => fmtMoney(r.econ.sales), num: r => r.econ.sales, targetKey: "revenue", targetFmt: fmtMoney },
    { name: "Выручка с перенаправлениями", fmt: r => fmtMoney(r.econ.revenueWithRef), num: r => r.econ.revenueWithRef },
    { name: "Средний чек на пациента", fmt: r => fmtMoney(r.econ.avgClient), num: r => r.econ.avgClient, targetKey: "avgCheck", targetFmt: fmtMoney },
    { name: "Средний чек посещения", fmt: r => fmtMoney(r.econ.avgVisit), num: r => r.econ.avgVisit },
    { name: "Визиты за месяц", fmt: r => fmtNum(r.traffic.visits), num: r => r.traffic.visits },
    { name: "Пациенты за месяц", fmt: r => fmtNum(r.traffic.patients), num: r => r.traffic.patients },
    { name: "Загрузка расписания", fmt: r => r.loyalty.sched ? fmtPct(r.loyalty.sched.pct) : "—", num: r => r.loyalty.sched ? r.loyalty.sched.pct : null, targetKey: "schedLoad", targetFmt: fmtPct },
    { name: `Возвращаемость первички (${primaryReturnMonths} мес.)`, fmt: r => { const pv = r.loyalty.pvSlices[primaryReturnMonths]; return pv ? fmtPct(pv.pct) : "—"; }, num: r => { const pv = r.loyalty.pvSlices[primaryReturnMonths]; return pv ? pv.pct : null; }, targetKey: "pervichka", targetFmt: fmtPct },
    { name: "Собственная запись в 1С", fmt: r => r.loyalty.ownRec ? fmtPct(r.loyalty.ownRec.pct) : "—", num: r => r.loyalty.ownRec ? r.loyalty.ownRec.pct : null, targetKey: "ownRecords", targetFmt: fmtPct },
    { name: "Курсовое лечение", fmt: r => r.loyalty.courseIdx != null ? fmtPct(r.loyalty.courseIdx) : "—", num: r => r.loyalty.courseIdx, targetKey: "courseIdx", targetFmt: fmtPct },
    { name: "Экспертных позиций", fmt: r => r.product ? r.product.devicesUsed + " из " + r.product.park : "—", num: r => r.product ? r.product.devicesUsed : null },
    { name: `Доля «${expertTitle}» в выручке`, fmt: r => r.product ? fmtPct(r.product.expertShare) : "—", num: r => r.product ? r.product.expertShare : null, targetKey: "hwShare", targetFmt: fmtPct },
    { name: "Доля выручки от перенаправлений", fmt: r => fmtPct(r.cross.crossShare), num: r => r.cross.crossShare, targetKey: "crossShare", targetFmt: fmtPct },
    { name: "Конверсия назначений", fmt: r => { const nz = r.cross.naz[UI.nazSlice] || r.cross.naz[1] || r.cross.naz[3]; return nz && nz.totals.conv != null ? fmtPct(nz.totals.conv) : "—"; }, num: r => { const nz = r.cross.naz[UI.nazSlice] || r.cross.naz[1] || r.cross.naz[3]; return nz ? nz.totals.conv : null; }, targetKey: "nazConv", targetFmt: fmtPct },
    ...(hasCrossFocus ? [
      { name: "Фокусов назначений задействовано", fmt: r => { const nz = r.cross.naz[UI.nazSlice] || r.cross.naz[1] || r.cross.naz[3]; return nz && nz.focus ? `${nz.focus.used} из ${nz.focus.park}` : "—"; }, num: r => { const nz = r.cross.naz[UI.nazSlice] || r.cross.naz[1] || r.cross.naz[3]; return nz && nz.focus ? nz.focus.used : null; } },
      { name: "Доля выручки фокусов назначений", fmt: r => { const nz = r.cross.naz[UI.nazSlice] || r.cross.naz[1] || r.cross.naz[3]; return nz && nz.focus ? fmtPct(nz.focus.revenueShare) : "—"; }, num: r => { const nz = r.cross.naz[UI.nazSlice] || r.cross.naz[1] || r.cross.naz[3]; return nz && nz.focus ? nz.focus.revenueShare : null; }, targetKey: "nazFocusShare", targetFmt: fmtPct },
    ] : []),
    { name: "Доля активной базы (окно по настройкам)", fmt: (r, id) => baseShareMarkup(r, id, "activeBasePct"), num: (r, id) => exactBaseShare(r, id, "activeBasePct"), targetKey: "akbShare", targetFmt: fmtPct },
    { name: "Доля базы в зоне риска (окно по настройкам)", fmt: (r, id) => baseShareMarkup(r, id, "riskShare"), num: (r, id) => exactBaseShare(r, id, "riskShare"), targetKey: "riskShare", targetFmt: fmtPct, lower: true },
    { name: `Потерянные (${goalProfile ? ">" + fmtNum(goalProfile.riskM, 1) + " мес." : "порог специализации"})`, fmt: (r, id) => { const kb = comparisonKb(r, id); return kb ? `${kb.sourceWindowComplete ? "" : "≥"}${fmtNum(kb.seg.lost)} чел.` : "—"; }, num: (r, id) => { const kb = comparisonKb(r, id); return kb && kb.sourceWindowComplete ? kb.seg.lost : null; }, lower: true },
    { name: "Потерянные за 3 года", fmt: r => r.akb.churn36 != null ? fmtPct(r.akb.churn36) : "—", num: r => r.akb.churn36, targetKey: "churn", targetFmt: fmtPct, lower: true },
    { name: "Средний рейтинг площадок", fmt: r => r.rep && r.rep.avgRating != null ? fmtNum(r.rep.avgRating, 2) + " ★" : "—", num: r => r.rep ? r.rep.avgRating : null, targetKey: "rating", targetFmt: v => fmtNum(v, 2) + " ★" },
    { name: "NPS", fmt: r => r.rep && r.rep.nps != null ? fmtPct(r.rep.nps) : "—", num: r => r.rep ? r.rep.nps : null, targetKey: "nps", targetFmt: fmtPct },
    { name: "Новые отзывы", fmt: r => r.rep && r.rep.reviews != null ? fmtNum(r.rep.reviews) + " шт." : "—", num: r => r.rep ? r.rep.reviews : null, targetKey: "reviews", targetFmt: v => fmtNum(v) + " шт." },
  ];
  if (DB.settings.showScores) {
    rowsDef.unshift({
      name: "Общий балл",
      fmt: r => r.scores && r.scores.total != null ? (r.scores.rankEligible ? fmtNum(r.scores.total, 0) : `${fmtNum(r.scores.total, 0)} · предв.`) : "—",
      num: r => r.scores && r.scores.rankEligible ? r.scores.total : null,
    });
  }
  const showSpecializationGoal = Boolean(specializationGoals);
  let t = `<table class="data" id="tblCompare"><tr><th>Метрика</th>${showSpecializationGoal ? '<th class="num compare-goal-head">Цель специализации</th>' : ""}${rows.map(x => `<th class="num" style="cursor:pointer" onclick="openDoctor('${x.id}','${mk}')" title="${esc(doctorName(x.id))}">${esc(doctorName(x.id).split(" ")[0])}</th>`).join("")}</tr>`;
  for (const d of rowsDef) {
    t += `<tr><td class="muted">${esc(d.name)}</td>${showSpecializationGoal ? `<td class="num">${targetMarkup(d)}</td>` : ""}${rows.map(x => {
      const v = d.num(x.r, x.id);
      const state = targetState(d, v);
      return `<td class="num compare-goal-cell ${state}">${d.fmt(x.r, x.id)}</td>`;
    }).join("")}</tr>`;
  }
  t += `</table>`;
  box.innerHTML = t;
}

async function exportDeptXlsx() {
  const mk = UI.deptMonth;
  if (!mk) return;
  const { rows } = deptRows(mk);
  if (!rows.length) { toast("Нет данных за выбранный месяц", true); return; }
  loadBundledLibrary("lib-xlsx", "XLSX");
  const header = ["Специалист", "Отделение", "Специализация", "Общий балл", "Статус балла", "Полнота балла, %", "Выручка, ₽", "Выручка с перенаправл., ₽", "Выручка от перенаправлений, ₽", "Ср. чек пациента, ₽", "Ср. чек посещения, ₽",
    "Визиты", "Пациенты", "Частота", "Загрузка расписания, %", "Часы график", "Часы записано",
    `Возвращаемость первички (${UI.pvSlice} мес.), %`, "Собственных записей в 1С, шт", "Собственная запись в 1С, %", "Курсовое, %",
    "Настройки клиентской базы", "Окно базы, мес.", "Окно достаточно", "База за окно", "Активная база", "Потерянные", "Потерянные — минимум", "Ядро базы", "Экспертных позиций", "Конверсия назначений, %", "Доля выручки от перенаправлений, %"];
  const aoa = [["Сводная по векторам за " + monthLabel(mk)], [], header];
  const num = v => (v == null || isNaN(v)) ? null : Math.round(v * 100) / 100;
  for (const x of rows) {
    const r = x.r, baseProfile = profileForDoctor(x.id), kb = selectedClientBaseSummary(r, baseProfile), pv = r.loyalty.pvSlices[UI.pvSlice], nz = r.cross.naz[UI.nazSlice];
    aoa.push([
      doctorName(x.id), resolvedDepartmentName(x.id), resolvedSpecializationName(x.id) || "—",
      r.scores ? num(r.scores.total) : null,
      r.scores ? (r.scores.rankEligible ? "итоговый" : "предварительный") : null,
      r.scores ? num(r.scores.coveragePct) : null,
      num(r.econ.sales), num(r.econ.revenueWithRef), num(r.econ.refRevenue), num(r.econ.avgClient), num(r.econ.avgVisit),
      r.traffic.visits, r.traffic.patients, num(r.traffic.freq),
      r.loyalty.sched ? num(r.loyalty.sched.pct) : null,
      r.loyalty.sched ? minToHours(r.loyalty.sched.normaMin) : null,
      r.loyalty.sched ? minToHours(r.loyalty.sched.busyMin) : null,
      pv ? num(pv.pct) : null,
      r.loyalty.ownRec ? r.loyalty.ownRec.count : null,
      r.loyalty.ownRec ? num(r.loyalty.ownRec.pct) : null,
      num(r.loyalty.courseIdx),
      `активная ≤${fmtNum(baseProfile.activeM, 1)} мес.; потерянная >${fmtNum(baseProfile.riskM, 1)} мес.`,
      kb ? kb.window : null, kb ? (kb.sourceWindowComplete ? "да" : "нет") : null,
      kb ? kb.total : null, kb ? kb.seg.active : null, kb ? kb.seg.lost : null,
      kb ? (kb.sourceWindowComplete ? "нет" : "да") : null, kb ? kb.core : null,
      r.product ? r.product.devicesUsed : null,
      nz && nz.totals.conv != null ? num(nz.totals.conv) : null,
      num(r.cross.crossShare),
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = header.map((h, i) => ({ wch: i === 0 ? 32 : Math.max(11, Math.min(h.length + 2, 24)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, monthLabel(mk).replace(" ", "_"));
  if (DESKTOP_API) {
    let batch = null;
    try {
      batch = await DESKTOP_API.beginExport({ month: mk, kind: "excel", requestedFiles: 1 });
      const bytes = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      await DESKTOP_API.writeExportFile({ token: batch.token, fileName: `Сводная_${mk}.xlsx`, bytes: new Uint8Array(bytes) });
      const result = await DESKTOP_API.finishExport({ token: batch.token, failures: [] });
      toast("Сводная таблица сохранена: " + result.outputDir);
    } catch (error) {
      if (batch) await DESKTOP_API.abortExport(batch.token).catch(() => {});
      toast("Не удалось сохранить Excel: " + error.message, true);
    }
    return;
  }
  XLSX.writeFile(wb, `Сводная_${mk}.xlsx`);
  toast("Файл Сводная_" + mk + ".xlsx скачан");
}

function openDoctor(id, mk) {
  UI.docId = id;
  UI.docMonth = mk;
  switchTab("doctor");
}

/* ================= СТРАНИЦА: ВРАЧ ================= */

function setPvSlice(v) { UI.pvSlice = v; renderAll(); }
function setNazSlice(v) { UI.nazSlice = v; renderAll(); }
function setKbWin(v) {
  UI.kbWin = Number(v);
  if (UI.docId) UI.kbWinByDoctor[UI.docId] = UI.kbWin;
  renderAll();
}
function clientRowsForSegment(kb, segment) {
  return (kb && kb.clientRows ? kb.clientRows : [])
    .filter(client => client.status === segment)
    .sort((a, b) => b.s - a.s);
}

function clientSegmentRowsMarkup(clients) {
  if (!clients.length) return '<tr><td colspan="5" class="muted small">В этом сегменте пациентов нет.</td></tr>';
  return clients.slice(0, 250).map(c => `<tr><td><b>${esc(c.name)}</b>${c.patientId ? `<br><span class="small muted">ID: ${esc(c.patientId)}</span>` : ""}</td><td>${c.loyal ? '<span class="badge ok">лояльный</span>' : '<span class="badge mut">новый/разовый</span>'}</td><td class="num">${fmtNum(c.v)}</td><td class="num">${c.r != null ? fmtNum(c.r) : "—"}</td><td class="num">${fmtMoney(c.s)}</td></tr>`).join("");
}

function clientSegmentLimitMarkup(clients) {
  return clients.length > 250 ? `Показаны первые 250 из ${fmtNum(clients.length)} пациентов.` : "";
}

function setClientSegment(v) {
  const segment = String(v);
  const allowed = ["active", "risk", "sleep", "lost", "unknown"];
  if (!allowed.includes(segment)) return;
  UI.clientSegment = segment;

  const block = document.getElementById("clientSegmentPatients");
  const rowsBody = document.getElementById("clientSegmentRows");
  if (!block || !rowsBody || !UI.docId || !UI.docMonth) {
    renderDoctor();
    return;
  }

  const result = computeMetrics(UI.docId, UI.docMonth);
  const availableWins = result && result.akb ? result.akb.availableWins : [];
  const requestedWin = Object.prototype.hasOwnProperty.call(UI.kbWinByDoctor, UI.docId)
    ? UI.kbWinByDoctor[UI.docId]
    : null;
  const currentWin = recommendedClientBaseWindow(availableWins, profileForDoctor(UI.docId), requestedWin);
  if (currentWin != null) UI.kbWin = currentWin;
  const kb = currentWin != null && result && result.akb ? result.akb.wins[currentWin] : null;
  if (!kb) {
    renderDoctor();
    return;
  }

  const clients = clientRowsForSegment(kb, segment);
  block.querySelectorAll("#clientSegmentSeg button").forEach(button => {
    const active = button.dataset.segmentValue === segment;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  rowsBody.innerHTML = clientSegmentRowsMarkup(clients);
  const count = document.getElementById("clientSegmentPatientCount");
  if (count) count.textContent = fmtNum(clients.length);
  const limit = document.getElementById("clientSegmentLimitNote");
  if (limit) {
    limit.textContent = clientSegmentLimitMarkup(clients);
    limit.hidden = clients.length <= 250;
  }
}
function toggleLabels() { UI.showLabels = !UI.showLabels; renderAll(); }

function scoreBadge(score, eligible = true, coverage = null) {
  if (score == null) return '<span class="badge mut">н/д</span>';
  if (!eligible) return `<span class="badge warn" title="Предварительный балл: полнота данных ${fmtPct(coverage)}. В рейтинг попадёт при полноте от 80%.">${fmtNum(score, 0)} · предв.</span>`;
  const cls = score >= 70 ? "ok" : score >= 40 ? "warn" : "bad";
  return `<span class="badge ${cls}">${fmtNum(score, 0)}</span>`;
}
/* бейдж балла вектора в заголовке блока (веса — из профиля отделения врача) */
function vecBadge(vk, r, profile, scoreOverride) {
  if (!DB.settings.showScores || !r.scores) return "";
  const sc = (profile && profile.scoring) || defaultScoring();
  const s = scoreOverride !== undefined ? scoreOverride : r.scores.vec[vk];
  const en = sc.enabled[vk];
  if (s == null) return '<span class="badge mut" title="нет данных для расчёта балла">балл: н/д</span>';
  const cls = s >= 70 ? "ok" : s >= 40 ? "warn" : "bad";
  return `<span class="badge ${cls}" title="${en ? "вес в общем балле: " + (sc.weights[vk] || 0) + "%" : "вектор выключен — в общий балл не входит"}">${fmtNum(s, 0)} / 100${en ? "" : " · выкл"}</span>`;
}

/* Цвет отслеживаемой метрики: цель выполнена / близко к цели / ниже цели.
   Если цель не задана, значение остаётся нейтральным (чёрным). */
function trackedMetricState(value, target) {
  if (value == null || isNaN(value) || target == null || target === "" || isNaN(target) || Number(target) <= 0) return "goal-plain";
  if (Number(value) >= Number(target)) return "goal-good";
  if (Number(value) >= Number(target) * 0.8) return "goal-warn";
  return "goal-bad";
}

/* цвет аппарата — фиксированный по позиции в парке (одинаков на всех диаграммах) */
const DEVICE_COLORS = ["#2563eb", "#7c3aed", "#0891b2", "#d97706", "#db2777", "#65a30d", "#0d9488", "#9333ea", "#dc2626", "#64748b", "#16a34a"];
function deviceColor(profile, name) {
  const items = (profile && profile.expertise && profile.expertise.items) || [];
  const i = items.findIndex(d => d.name === name);
  return DEVICE_COLORS[(i >= 0 ? i : items.length) % DEVICE_COLORS.length];
}
function crossFocusColor(profile, name) {
  const items = (profile && profile.crossFocus && profile.crossFocus.items) || [];
  const i = items.findIndex(item => item.name === name);
  return DEVICE_COLORS[(i >= 0 ? i : items.length) % DEVICE_COLORS.length];
}

/* сумма в конце каждой полосы горизонтальной стековой */
const stackTotalsPlugin = {
  id: "stackTotals",
  afterDatasetsDraw(c) {
    const metas = c.getSortedVisibleDatasetMetas();
    const barMeta = metas.find(m => m.type === "bar");
    const stackDatasets = c.data.datasets.filter(ds => ds.stack === "s" && ds.type !== "line");
    if (!barMeta || !stackDatasets.length) return;
    const { ctx } = c;
    ctx.save();
    ctx.font = "700 13px 'Segoe UI', system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    for (let i = 0; i < c.data.labels.length; i++) {
      let total = 0;
      stackDatasets.forEach(ds => { total += ds.data[i] || 0; });
      if (!total) continue;
      const x = c.scales.x.getPixelForValue(total);
      const el = barMeta.data[i];
      const y = el ? el.y : c.scales.y.getPixelForValue(i);
      const txt = total >= 1000000 ? (total / 1000000).toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + " млн ₽" : fmtNum(total) + " ₽";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#ffffff"; // белая обводка, чтобы сумма читалась на любом фоне
      ctx.strokeText(txt, x + 7, y);
      ctx.fillStyle = "#1c2333";
      ctx.fillText(txt, x + 7, y);
    }
    ctx.restore();
  },
};

/* экспорт целого блока (карточки) картинкой — вставляется в Word/PowerPoint/почту */
async function copyBlock(id) {
  const el = document.getElementById(id);
  if (!el) return;
  toast("Готовлю картинку блока…");
  el.classList.add("exporting");
  try {
    loadBundledLibrary("lib-html2canvas", "html2canvas");
    // windowWidth: рендерим блок в десктопной ширине, даже если окно узкое
    const canvas = await html2canvas(el, { backgroundColor: "#ffffff", scale: 2, logging: false, windowWidth: Math.max(1200, document.documentElement.clientWidth) });
    el.classList.remove("exporting");
    canvas.toBlob(async blob => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        toast("Блок скопирован картинкой — вставьте (Ctrl+V) в Word, PowerPoint или письмо");
      } catch (e) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = id + ".png";
        a.click();
        toast("Буфер недоступен — блок скачан файлом PNG");
      }
    });
  } catch (e) {
    el.classList.remove("exporting");
    toast("Не удалось отрисовать блок: " + e.message, true);
  }
}
function blockBtn(id) {
  return `<button class="btn mini no-print" onclick="copyBlock('${id}')" title="Скопировать весь блок одной картинкой — для вставки в Word/PowerPoint">🖼 блок</button>`;
}

/* PDF из последовательных блоков полного дашборда. Короткие блоки упаковываются
   на одну страницу, длинные режутся только если целиком не помещаются на A4. */
async function buildPdfFromSlides(slides, onProgress) {
  if (!slides.length) throw new Error("в отчёте нет блоков");
  loadBundledLibrary("lib-html2canvas", "html2canvas");
  loadBundledLibrary("lib-jspdf", "jspdf");
  const pdf = new window.jspdf.jsPDF({ orientation: "landscape", unit: "mm", format: "a4", compress: true });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 8;
  const gap = 4;
  const imgW = pageW - margin * 2;
  const maxImgH = pageH - margin * 2;
  let pageStarted = false;
  let cursorY = margin;
  const startPage = () => {
    if (pageStarted) pdf.addPage();
    pageStarted = true;
    cursorY = margin;
    pdf.setFillColor(255, 255, 255);
    pdf.rect(0, 0, pageW, pageH, "F");
  };
  for (let i = 0; i < slides.length; i++) {
    const el = slides[i];
    el.classList.add("exporting");
    let canvas;
    try {
      canvas = await html2canvas(el, { backgroundColor: "#ffffff", scale: 1.5, logging: false, windowWidth: 1200 });
    } finally {
      el.classList.remove("exporting");
    }
    if (onProgress) onProgress(i + 1, slides.length);
    const scaledHeight = canvas.height * imgW / canvas.width;
    if (scaledHeight <= maxImgH) {
      if (!pageStarted || cursorY + scaledHeight > pageH - margin) startPage();
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.94), "JPEG", margin, cursorY, imgW, scaledHeight);
      cursorY += scaledHeight + gap;
      canvas.width = canvas.height = 0;
      continue;
    }
    const slicePx = Math.floor(maxImgH * canvas.width / imgW);
    for (let y = 0; y < canvas.height; y += slicePx) {
      const hPx = Math.min(slicePx, canvas.height - y);
      if (hPx < 20) break;
      const part = document.createElement("canvas");
      part.width = canvas.width;
      part.height = hPx;
      part.getContext("2d").drawImage(canvas, 0, y, canvas.width, hPx, 0, 0, canvas.width, hPx);
      startPage();
      pdf.addImage(part.toDataURL("image/jpeg", 0.92), "JPEG", margin, margin, imgW, hPx * imgW / canvas.width);
      cursorY = margin + hPx * imgW / canvas.width + gap;
      part.width = part.height = 0;
    }
    canvas.width = canvas.height = 0;
  }
  if (!pageStarted) throw new Error("не удалось отрисовать страницы отчёта");
  return pdf;
}

function safePdfNamePart(value) {
  const clean = String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 140);
  return clean || "Без названия";
}

function uniquePdfFileName(base, usedNames, relativePath = []) {
  let name = safePdfNamePart(base) + ".pdf";
  let n = 2;
  const key = value => [...relativePath, value].join("/").toLocaleLowerCase("ru-RU");
  while (usedNames.has(key(name))) {
    name = `${safePdfNamePart(base)} (${n++}).pdf`;
  }
  usedNames.add(key(name));
  return name;
}

async function writePdfToDirectory(directory, relativePath, fileName, pdf) {
  let targetDirectory = directory;
  for (const segment of relativePath) {
    targetDirectory = await targetDirectory.getDirectoryHandle(safePdfNamePart(segment), { create: true });
  }
  const file = await targetDirectory.getFileHandle(fileName, { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(pdf.output("blob"));
    await writable.close();
  } catch (e) {
    try { await writable.abort(); } catch (_) { /* поток уже мог закрыться */ }
    throw e;
  }
}

function pdfReportTargets(monthKey) {
  const core = coreDoctorsInMonth(monthKey);
  const doctors = core.length ? core : doctorsInMonth(monthKey);
  const tree = new Map();
  for (const doctorId of doctors) {
    const departmentName = resolvedDepartmentName(doctorId) || "Не распределено";
    const specializationName = resolvedSpecializationName(doctorId);
    const specializationLabel = specializationName || "Без специализации";
    if (!tree.has(departmentName)) tree.set(departmentName, new Map());
    const specializations = tree.get(departmentName);
    if (!specializations.has(specializationLabel)) specializations.set(specializationLabel, { specializationName, doctors: [] });
    specializations.get(specializationLabel).doctors.push(doctorId);
  }

  const targets = [];
  for (const departmentName of [...tree.keys()].sort((a, b) => a.localeCompare(b, "ru"))) {
    const departmentPath = ["Отделения", departmentName];
    if (departmentGroups()[departmentName]) {
      targets.push({
        kind: "Отделение", name: departmentName, tab: "department",
        departmentName, relativePath: departmentPath,
        fileBase: `Отчёт по отделению — ${departmentName} — ${monthKey}`,
      });
    }
    const specializations = tree.get(departmentName);
    for (const specializationLabel of [...specializations.keys()].sort((a, b) => a.localeCompare(b, "ru"))) {
      const group = specializations.get(specializationLabel);
      const specializationPath = [...departmentPath, "Специализации", specializationLabel];
      targets.push({
        kind: "Специализация", name: specializationLabel, tab: "dept",
        departmentName, specializationName: group.specializationName,
        deptFilter: group.specializationName || departmentName,
        relativePath: specializationPath,
        fileBase: `Отчёт по специализации — ${specializationLabel} — ${monthKey}`,
      });
      for (const doctorId of group.doctors.sort((a, b) => doctorName(a).localeCompare(doctorName(b), "ru"))) {
        targets.push({
          kind: "Врач", name: doctorName(doctorId), tab: "doctor", doctorId,
          departmentName, specializationName: group.specializationName,
          relativePath: [...specializationPath, "Врачи"],
          fileBase: `${doctorName(doctorId)} — ${monthKey}`,
        });
      }
    }
  }
  return targets;
}

function pdfTargetSource(target, monthKey) {
  if (target.tab === "department") {
    UI.departmentMonth = monthKey;
    UI.departmentFilter = target.departmentName;
    switchTab("department");
    return document.getElementById("departmentBody");
  }
  if (target.tab === "dept") {
    UI.deptMonth = monthKey;
    UI.deptFilter = target.deptFilter;
    UI.subFilter = "all";
    switchTab("dept");
    return document.getElementById("deptBody");
  }
  UI.docMonth = monthKey;
  UI.docId = target.doctorId;
  switchTab("doctor");
  return document.getElementById("doctorBody");
}

async function settlePdfCharts(source) {
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  for (const canvas of source.querySelectorAll("canvas")) {
    const instance = typeof Chart !== "undefined" && typeof Chart.getChart === "function" ? Chart.getChart(canvas) : null;
    if (!instance) continue;
    instance.stop();
    instance.resize();
    instance.update("none");
  }
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function cloneDashboardForPdf(source) {
  await settlePdfCharts(source);
  const clone = source.cloneNode(true);
  const sourceCanvases = [...source.querySelectorAll("canvas")];
  const cloneCanvases = [...clone.querySelectorAll("canvas")];
  let chartImages = 0;
  sourceCanvases.forEach((canvas, index) => {
    const targetCanvas = cloneCanvases[index];
    if (!targetCanvas || !canvas.width || !canvas.height) return;
    const image = document.createElement("img");
    image.src = canvas.toDataURL("image/png");
    image.alt = canvas.getAttribute("aria-label") || "График";
    image.className = "pdf-chart-image";
    image.dataset.pdfChart = "true";
    targetCanvas.replaceWith(image);
    chartImages++;
  });
  clone.querySelectorAll("[id]").forEach(element => element.removeAttribute("id"));
  clone.querySelectorAll("[onclick], [onchange], [ontoggle]").forEach(element => {
    element.removeAttribute("onclick");
    element.removeAttribute("onchange");
    element.removeAttribute("ontoggle");
  });
  for (const details of clone.querySelectorAll("details:not(.no-print)")) details.open = true;
  await Promise.all([...clone.querySelectorAll("img")].map(image => image.complete ? Promise.resolve() : new Promise(resolve => {
    image.onload = image.onerror = resolve;
  })));
  return { clone, chartImages };
}

function splitDynamicPdfSection(section) {
  const children = [...section.children];
  const narrativeIndex = children.findIndex(child => child.classList.contains("dyn-narrative"));
  if (narrativeIndex < 0) return [section];
  const chartGridIndex = children.findIndex((child, index) => index > narrativeIndex
    && child.classList.contains("grid") && child.querySelector(".pdf-chart-image"));
  if (chartGridIndex < 0) return [section];
  const scoreIndex = children.findIndex((child, index) => index > chartGridIndex
    && child.querySelector(".score-chart"));
  const title = section.querySelector(".vhead h3")?.textContent?.trim() || "Динамика";
  const groups = [
    children.slice(0, chartGridIndex),
    [children[chartGridIndex]],
    children.slice(chartGridIndex + 1, scoreIndex < 0 ? children.length : scoreIndex),
  ];
  if (scoreIndex >= 0) groups.push([children[scoreIndex]]);
  return groups.filter(group => group.length).map((group, index) => {
    const shell = section.cloneNode(false);
    shell.innerHTML = "";
    if (index > 0) {
      const continuation = document.createElement("h3");
      continuation.className = "pdf-continuation-title";
      continuation.textContent = `${title} — продолжение`;
      shell.appendChild(continuation);
    }
    group.forEach(child => shell.appendChild(child));
    return shell;
  });
}

async function preparePdfDashboard(stage, target, monthKey) {
  const source = pdfTargetSource(target, monthKey);
  if (!source) throw new Error("не найден экран отчёта");
  const { clone, chartImages } = await cloneDashboardForPdf(source);
  stage.innerHTML = `<div class="card pdf-export-title"><h1>${esc(target.kind)}: ${esc(target.name)}</h1><div class="muted">${monthLabel(monthKey)} · ${esc(target.departmentName || "")}${target.specializationName ? " · " + esc(target.specializationName) : ""}</div></div>`;
  for (const child of [...clone.children]) {
    if (child.classList.contains("no-print")) continue;
    for (const section of splitDynamicPdfSection(child)) {
      section.classList.add("exporting", "pdf-export-section");
      stage.appendChild(section);
    }
  }
  const sections = [...stage.children].filter(element => !element.classList.contains("no-print"));
  return { sections, chartImages };
}

/* Пакетная выгрузка: один PDF на врача и один PDF на специализацию, все в одной папке. */
async function exportAllReportsToFolder() {
  const mk = UI.repMonth;
  if (!mk || !DB.months[mk]) { toast("Сначала выберите месяц с данными", true); return; }
  try {
    loadBundledLibrary("lib-html2canvas", "html2canvas");
    loadBundledLibrary("lib-jspdf", "jspdf");
  } catch (error) {
    toast("Экспорт в PDF недоступен: " + error.message, true);
    return;
  }
  const useDesktopExport = Boolean(DESKTOP_API);
  if (!useDesktopExport && typeof window.showDirectoryPicker !== "function") {
    toast("Выбор папки поддерживается в Chrome и Edge. Откройте приложение в одном из этих браузеров.", true);
    return;
  }

  let directory = null;
  if (!useDesktopExport) {
    try {
      directory = await window.showDirectoryPicker({ mode: "readwrite" });
    } catch (e) {
      if (e && e.name === "AbortError") return;
      toast("Не удалось открыть папку: " + e.message, true);
      return;
    }
  }

  const targets = pdfReportTargets(mk);
  if (!targets.length) { toast("За выбранный месяц нет отчётов для выгрузки", true); return; }

  let exportBatch = null;
  if (useDesktopExport) {
    try {
      exportBatch = await DESKTOP_API.beginExport({ month: mk, kind: "pdf", requestedFiles: targets.length });
    } catch (error) {
      toast("Не удалось подготовить папку результатов: " + error.message, true);
      return;
    }
  }

  const button = document.getElementById("btnExportAllPdf");
  const oldLabel = button.textContent;
  const stage = document.createElement("div");
  stage.className = "pdf-export-stage";
  stage.setAttribute("aria-hidden", "true");
  const overlay = document.createElement("div");
  overlay.className = "pdf-export-overlay";
  overlay.innerHTML = '<div><b>Формирую полные PDF-отчёты</b><span id="pdfExportOverlayStatus">Подготавливаю графики…</span></div>';
  document.body.appendChild(stage);
  document.body.appendChild(overlay);
  document.body.classList.add("pdf-export-running");
  const usedNames = new Set();
  const failed = [];
  let chartImages = 0;
  const previousUi = {
    tab: UI.tab,
    departmentMonth: UI.departmentMonth, departmentFilter: UI.departmentFilter,
    deptMonth: UI.deptMonth, deptFilter: UI.deptFilter, subFilter: UI.subFilter,
    docMonth: UI.docMonth, docId: UI.docId,
    showLabels: UI.showLabels,
  };
  UI.showLabels = true;
  button.disabled = true;
  try {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const overlayStatus = document.getElementById("pdfExportOverlayStatus");
      if (overlayStatus) overlayStatus.textContent = `${i + 1} из ${targets.length}: ${target.kind.toLowerCase()} «${target.name}»`;
      button.textContent = `⏳ ${i + 1} из ${targets.length}`;
      toast(`PDF ${i + 1} из ${targets.length}: ${target.kind.toLowerCase()} «${target.name}»`);
      try {
        const prepared = await preparePdfDashboard(stage, target, mk);
        chartImages += prepared.chartImages;
        void stage.offsetHeight;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const pdf = await buildPdfFromSlides(prepared.sections, (page, total) => {
          toast(`PDF ${i + 1} из ${targets.length}: страница ${page} из ${total}`);
        });
        const fileName = uniquePdfFileName(target.fileBase, usedNames, target.relativePath);
        if (useDesktopExport) {
          const bytes = new Uint8Array(pdf.output("arraybuffer"));
          await DESKTOP_API.writeExportFile({ token: exportBatch.token, relativePath: target.relativePath, fileName, bytes });
        } else {
          await writePdfToDirectory(directory, [mk, ...target.relativePath], fileName, pdf);
        }
      } catch (e) {
        failed.push(`${target.kind} «${target.name}»: ${e.message}`);
        console.error("exportAllReportsToFolder", target, e);
      } finally {
        stage.innerHTML = "";
      }
    }
  } finally {
    stage.remove();
    overlay.remove();
    document.body.classList.remove("pdf-export-running");
    Object.assign(UI, previousUi);
    switchTab(previousUi.tab);
    button.disabled = false;
    button.textContent = oldLabel;
  }

  const saved = targets.length - failed.length;
  let desktopResult = null;
  if (useDesktopExport) {
    try {
      desktopResult = await DESKTOP_API.finishExport({ token: exportBatch.token, failures: failed });
    } catch (error) {
      await DESKTOP_API.abortExport(exportBatch.token).catch(() => {});
      toast("PDF созданы, но не удалось завершить пакет: " + error.message, true);
      return;
    }
  }
  if (failed.length) {
    toast(`Готово: сохранено ${saved} из ${targets.length} PDF. Ошибок: ${failed.length}. ${desktopResult ? "Папка: " + desktopResult.outputDir : "Подробности — в консоли."}`, true);
  } else {
    toast(`Готово: ${saved} PDF сохранено${desktopResult ? " · " + desktopResult.outputDir : " в выбранную папку"}`);
  }
  return { saved, failed: failed.length, requested: targets.length, chartImages, outputDir: desktopResult ? desktopResult.outputDir : null };
}

/* ---------- блок «Динамика»: таблица трендов + точки роста/риска ---------- */
const VEC_LINE_COLORS = { v1: "#64748b", v2: "#16a34a", v3: "#2563eb", v4: "#dc2626", v5: "#d97706", v6: "#db2777" };

function deltaCell(row, basis = "prev") {
  const delta = basis === "avg" ? row.deltaAvg : row.delta;
  const improving = basis === "avg" ? row.improvingAvg : row.improving;
  if (delta == null) return '<span class="muted small">—</span>';
  if (Math.abs(delta) < 0.0001) return '<span class="delta flat">• 0%</span>';
  const up = delta > 0;
  return `<span class="delta ${improving ? "up" : "down"}">${up ? "▲" : "▼"} ${fmtNum(Math.abs(delta), 1)}%</span>`;
}

/* Мини-график: геометрия показывает ряд по месяцам, цвет — качество последнего
   месяца относительно среднего всех предыдущих отображаемых месяцев. */
function sparkSvg(row) {
  const values = row.values;
  const pts = values.map((v, i) => ({ v, i })).filter(p => p.v != null);
  if (pts.length < 2) return '<span class="muted small">·</span>';
  const W = 76, H = 24, pad = 3;
  const min = Math.min(...pts.map(p => p.v));
  const max = Math.max(...pts.map(p => p.v));
  const span = max - min || 1;
  const x = i => pad + i / (values.length - 1) * (W - pad * 2);
  const y = v => H - pad - (v - min) / span * (H - pad * 2);
  const path = pts.map((p, k) => (k ? "L" : "M") + x(p.i).toFixed(1) + " " + y(p.v).toFixed(1)).join(" ");
  const last = pts[pts.length - 1];
  const flat = row.deltaAvg != null && Math.abs(row.deltaAvg) < 0.0001;
  const col = row.deltaAvg == null || flat ? "#94a3b8" : row.improvingAvg ? "#16a34a" : "#dc2626";
  const colorNote = row.deltaAvg == null ? "Нет данных для сравнения со средним предыдущих месяцев" : flat ? "Последний месяц равен среднему предыдущих месяцев" : `Последний месяц ${row.improvingAvg ? "лучше" : "хуже"} среднего предыдущих месяцев на ${fmtNum(Math.abs(row.deltaAvg), 1)}%`;
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="vertical-align:middle">
    <title>${esc(colorNote)}</title>
    <path d="${path}" fill="none" stroke="${col}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${x(last.i).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="2.6" fill="${col}"/></svg>`;
}

/* панель графиков динамики: деньги / трафик / проценты / база */
function renderDynCharts(dyn, blkId) {
  if (!dyn || dyn.months.length < 2) return;
  const labels = dyn.months.map(monthLabel);
  const val = key => { const row = dyn.rows.find(x => x.key === key); return row ? row.values : null; };
  const mk = (canvas, series, fmt, tickCb) => {
    const datasets = series.filter(s => s.data && s.data.some(v => v != null)).map(s => ({
      label: s.label, data: s.data, borderColor: s.color, backgroundColor: s.color,
      borderWidth: 2, pointRadius: 3, spanGaps: true, tension: 0.25, borderDash: s.dash || [],
    }));
    if (!datasets.length) return;
    // fmt держим в замыкании: если положить его в options, Chart.js трактует функцию
    // как «scriptable» и вызывает с объектом-контекстом
    const numFmt = v => (typeof v === "number" ? fmt(v) : "");
    chart(canvas, {
      type: "line",
      data: { labels, datasets },
      options: {
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } },
          datalabels: {
            display: ctx => UI.showLabels && ctx.dataIndex === ctx.dataset.data.length - 1 && ctx.dataset.data[ctx.dataIndex] != null,
            align: "top", font: { size: 10, weight: "700" }, color: "#1c2333",
            formatter: numFmt,
          },
          tooltip: { callbacks: { label: c => c.dataset.label + ": " + numFmt(c.raw) } },
        },
        scales: { y: { beginAtZero: true, ticks: tickCb ? { callback: v => (typeof v === "number" ? tickCb(v) : v) } : {} } },
      },
    });
  };
  mk(blkId + "_money", [
    { label: "Выручка", data: val("sales"), color: "#2563eb" },
    { label: "С перенаправлениями", data: val("withRef"), color: "#7c3aed", dash: [5, 3] },
  ], v => (v >= 1000000 ? (v / 1000000).toFixed(2) + " млн" : fmtNum(v)), v => (v / 1000000).toFixed(1) + " млн");
  mk(blkId + "_traffic", [
    { label: "Визиты", data: val("visits"), color: "#2563eb" },
    { label: "Пациенты", data: val("patients"), color: "#16a34a" },
  ], v => fmtNum(v));
  mk(blkId + "_pct", [
    { label: "Загрузка расписания", data: val("sched"), color: "#d97706" },
    { label: "Первичка", data: val("perv"), color: "#2563eb" },
    { label: "Доля выручки от перенаправлений", data: val("cross"), color: "#16a34a" },
    { label: "Конверсия назнач.", data: val("nazConv"), color: "#db2777" },
  ], v => fmtPct(v), v => v + "%");
  mk(blkId + "_base", [
    { label: "Активная база", data: val("akb"), color: "#16a34a" },
    { label: "Потерянные", data: val("lost"), color: "#dc2626" },
  ], v => fmtNum(v) + " чел.");
}

function dynamicsRow(dyn, key) {
  return dyn && Array.isArray(dyn.rows) ? dyn.rows.find(row => row.key === key) : null;
}

function dynamicsChanged(row, improving) {
  return Boolean(row && row.cur != null && row.delta != null && row.improving === improving && Math.abs(row.delta) >= 5);
}

function dynamicsMetricComment(row) {
  if (!row || row.cur == null) return "";
  const details = [];
  if (row.delta != null && Math.abs(row.delta) >= 0.05) details.push(`${row.delta > 0 ? "рост" : "снижение"} на ${fmtNum(Math.abs(row.delta), 1)}% к прошлому месяцу`);
  if (row.belowTarget && row.target != null) details.push(`${row.lower ? "выше допустимого уровня" : "ниже цели"} ${row.fmt(row.target)}`);
  return `${row.name}: ${row.fmt(row.cur)}${details.length ? ` (${details.join("; ")})` : ""}`;
}

function joinCommentParts(items) {
  const values = items.filter(Boolean);
  if (values.length < 2) return values[0] || "";
  return values.slice(0, -1).join(", ") + " и " + values[values.length - 1];
}

function dynamicsRelationshipInsights(dyn) {
  const row = key => dynamicsRow(dyn, key);
  const better = key => dynamicsChanged(row(key), true);
  const worse = key => dynamicsChanged(row(key), false);
  const insights = [];

  if (worse("sales") && (worse("patients") || worse("visits"))) {
    insights.push("снижение выручки, вероятно, связано со снижением потока пациентов и визитов");
  } else if (worse("sales") && better("avgClient")) {
    insights.push("средний чек растёт, но пока не компенсирует снижение выручки");
  } else if (better("sales") && better("avgClient")) {
    insights.push("рост выручки поддержан увеличением среднего чека");
  } else if (better("sales") && (better("patients") || better("visits"))) {
    insights.push("рост выручки поддержан увеличением пациентопотока");
  }

  if (worse("withRef") && (worse("nazConv") || worse("cross"))) {
    insights.push("снижение выручки с перенаправлениями может быть связано с ухудшением конверсии назначений или доли перенаправлений");
  } else if (better("withRef") && (better("nazConv") || better("cross"))) {
    insights.push("рост выручки с перенаправлениями поддержан улучшением работы с назначениями");
  }

  if (worse("sched") && worse("visits")) insights.push("снижение загрузки расписания сопровождается сокращением числа визитов");
  if (better("akb") && better("lost")) insights.push("клиентская база укрепляется: активных пациентов стало больше, а потерянных — меньше");
  if (worse("akb") || worse("lost")) insights.push("динамика активной и потерянной базы указывает на риск ухудшения удержания пациентов");
  if (worse("perv") && worse("return12")) insights.push("снижение возврата первичных пациентов уже отражается на общей частоте возвращаемости");
  return [...new Set(insights)].slice(0, 2);
}

function dynamicsActionComment(risk) {
  const keys = new Set((risk || []).map(row => row.key));
  if (["nazConv", "cross", "withRef"].some(key => keys.has(key))) return "разобрать цепочку «назначение → запись → выполнение» и причины невыполненных перенаправлений";
  if (["patients", "visits", "sched"].some(key => keys.has(key))) return "проверить свободные окна, отмены, переносы и источники первичных записей";
  if (["perv", "return12", "course", "akb", "lost"].some(key => keys.has(key))) return "сформировать список пациентов для возврата и проверить повторную запись после приёма";
  if (keys.has("ownRec")) return "проверить, насколько регулярно врач создаёт следующую запись в 1С до ухода пациента";
  if (["sales", "avgClient"].some(key => keys.has(key))) return "разложить выручку на пациентопоток, средний чек и структуру оказанных услуг";
  return "проверить причины отклонений по первичным данным и зафиксировать одно корректирующее действие на следующий месяц";
}

function buildDynamicsCommentary(dyn) {
  const currentMonth = dyn && dyn.months && dyn.months.length ? monthLabel(dyn.months[dyn.months.length - 1]) : "текущий период";
  if (!dyn || !dyn.months || dyn.months.length < 2) {
    return `За ${currentMonth} пока недостаточно истории для обоснованного вывода: нужен ещё хотя бы один месяц. Здесь можно оставить собственный комментарий.`;
  }
  const growth = (dyn.growth || []).slice(0, 3);
  const risk = (dyn.risk || []).slice(0, 3);
  const praise = growth.length
    ? `Хорошая работа: ${joinCommentParts(growth.map(dynamicsMetricComment))}.`
    : "Показатели в целом стабильны, но выраженных улучшений относительно прошлого месяца пока нет.";
  const warning = risk.length
    ? `Обратите внимание: ${joinCommentParts(risk.map(dynamicsMetricComment))}.`
    : "Критических ухудшений и сильных отклонений от целей не выявлено.";
  const relationships = dynamicsRelationshipInsights(dyn);
  const relationshipText = relationships.length ? `Вероятная связь показателей: ${joinCommentParts(relationships)}.` : "";
  const action = risk.length
    ? `Что сделать: ${dynamicsActionComment(risk)}.`
    : "Что сделать: сохранить текущий подход и проверить, закрепляется ли результат в следующем месяце.";
  return `Комментарий за ${currentMonth}.\n\n${praise}\n\n${warning}${relationshipText ? `\n\n${relationshipText}` : ""}\n\n${action}`;
}

function dynamicNarrativeValue(noteKey, dyn) {
  const suggested = buildDynamicsCommentary(dyn);
  const notes = DB.dynamicNotes && typeof DB.dynamicNotes === "object" ? DB.dynamicNotes : {};
  const manual = Object.prototype.hasOwnProperty.call(notes, noteKey);
  return { suggested, text: manual ? notes[noteKey] : suggested, manual };
}

function saveDynamicNarrative(blkId) {
  const el = document.getElementById(blkId + "_narrative");
  if (!el) return;
  if (!DB.dynamicNotes || typeof DB.dynamicNotes !== "object") DB.dynamicNotes = {};
  DB.dynamicNotes[el.dataset.noteKey] = el.value.trim();
  el.value = DB.dynamicNotes[el.dataset.noteKey];
  const badge = document.getElementById(blkId + "_narrative_status");
  if (badge) { badge.textContent = "сохранено вручную"; badge.className = "badge good"; }
  saveLocal();
  toast("Комментарий сохранён");
}

function resetDynamicNarrative(blkId) {
  const el = document.getElementById(blkId + "_narrative");
  if (!el) return;
  if (DB.dynamicNotes && typeof DB.dynamicNotes === "object") delete DB.dynamicNotes[el.dataset.noteKey];
  try { el.value = decodeURIComponent(el.dataset.suggestedNote || ""); } catch (_) { el.value = ""; }
  const badge = document.getElementById(blkId + "_narrative_status");
  if (badge) { badge.textContent = "черновик по показателям"; badge.className = "badge"; }
  saveLocal();
  toast("Комментарий обновлён по текущим показателям");
}

function dynamicsHtml(dyn, blkId, title, subtitle, noteKey) {
  if (!dyn || dyn.months.length < 1) return "";
  const single = dyn.months.length < 2;
  const narrative = dynamicNarrativeValue(noteKey || `${blkId}|${dyn.months[dyn.months.length - 1]}`, dyn);
  let html = `<div class="card" id="${blkId}"><div class="vhead"><h3 class="mt0">📈 ${title}</h3><span>${blockBtn(blkId)}</span></div>
    <p class="small muted" style="margin-top:0">${subtitle}${single ? " Пока загружен один месяц — тренды появятся после загрузки следующего." : ""}</p>`;
  // точки роста и риска
  if (!single) {
    html += `<div class="grid cols-2" style="margin-bottom:12px">
      <div style="border-left:3px solid var(--good);padding-left:12px"><h3 class="mt0" style="color:var(--good)">Точки роста</h3>
        ${dyn.growth.length ? dyn.growth.slice(0, 6).map(x => `<div class="metric-row"><span class="mname">${esc(x.name)}</span><span class="mval">${x.fmt(x.cur)} ${deltaCell(x)}</span></div>`).join("") : '<p class="muted small">нет метрик с улучшением ≥ 5% к прошлому месяцу</p>'}
      </div>
      <div style="border-left:3px solid var(--bad);padding-left:12px"><h3 class="mt0" style="color:var(--bad)">Точки риска</h3>
        ${dyn.risk.length ? dyn.risk.slice(0, 6).map(x => `<div class="metric-row"><span class="mname">${esc(x.name)}${x.belowTarget ? ' <span class="badge bad">ниже цели</span>' : ""}</span><span class="mval">${x.fmt(x.cur)} ${deltaCell(x)}</span></div>`).join("") : '<p class="muted small">нет ухудшений ≥ 5% и провалов по целям — отлично!</p>'}
      </div></div>`;
  }
  html += `<div class="dyn-narrative">
    <div class="vhead"><h3 class="mt0" style="margin-bottom:6px">Выводы и комментарии <span id="${blkId}_narrative_status" class="badge${narrative.manual ? " good" : ""}">${narrative.manual ? "сохранено вручную" : "черновик по показателям"}</span></h3><span class="small muted">можно отредактировать или полностью заменить своим текстом</span></div>
    <textarea id="${blkId}_narrative" data-note-key="${esc(noteKey || `${blkId}|${dyn.months[dyn.months.length - 1]}`)}" data-suggested-note="${esc(encodeURIComponent(narrative.suggested))}">${esc(narrative.text)}</textarea>
    <div class="toolbar"><button class="btn primary mini" onclick="saveDynamicNarrative('${blkId}')">💾 Сохранить комментарий</button><button class="btn mini" onclick="resetDynamicNarrative('${blkId}')">↺ Обновить выводы по показателям</button></div>
  </div>`;
  // панель графиков динамики (деньги / трафик / проценты / база)
  if (!single) {
    html += `<div class="grid cols-2" style="margin-bottom:12px">
      <div><h3 class="small muted" style="margin:0 0 4px">ДЕНЬГИ ${copyBtn("copyChart", blkId + "_money", "PNG")}</h3><div class="chart-box"><canvas id="${blkId}_money"></canvas></div></div>
      <div><h3 class="small muted" style="margin:0 0 4px">ТРАФИК ${copyBtn("copyChart", blkId + "_traffic", "PNG")}</h3><div class="chart-box"><canvas id="${blkId}_traffic"></canvas></div></div>
      <div><h3 class="small muted" style="margin:0 0 4px">УДЕРЖАНИЕ И КОМАНДА, % ${copyBtn("copyChart", blkId + "_pct", "PNG")}</h3><div class="chart-box"><canvas id="${blkId}_pct"></canvas></div></div>
      <div><h3 class="small muted" style="margin:0 0 4px">КЛИЕНТСКАЯ БАЗА ${copyBtn("copyChart", blkId + "_base", "PNG")}</h3><div class="chart-box"><canvas id="${blkId}_base"></canvas></div></div>
    </div>`;
  }
  // таблица по месяцам: жирным зелёным — лучший месяц метрики, красным — худший
  const tblId = blkId + "_tbl";
  html += `<h3 class="small muted" style="margin:0 0 6px">ПОКАЗАТЕЛИ ПО МЕСЯЦАМ ${copyBtn("copyTable", tblId)}</h3>
    <p class="small muted" style="margin:0 0 6px">Ячейки: зелёным — лучший месяц, красным — худший. Мини-график: зелёный — последний месяц лучше среднего предыдущих месяцев, красный — хуже, серый — без изменений или нет данных.</p>
    <table class="data" id="${tblId}"><tr><th>Метрика</th><th title="Цвет сравнивает последний месяц со средним предыдущих месяцев">Тренд</th>${dyn.months.map(k => `<th class="num">${monthLabel(k)}</th>`).join("")}<th class="num">Δ к прошл. мес.</th><th class="num" title="Среднее всех показанных месяцев без последнего">Δ к среднему прошлых мес.</th></tr>`;
  for (const row of dyn.rows) {
    const nn = row.values.filter(v => v != null);
    const distinct = new Set(nn).size > 1;
    const bestV = distinct ? (row.lower ? Math.min(...nn) : Math.max(...nn)) : null;
    const worstV = distinct ? (row.lower ? Math.max(...nn) : Math.min(...nn)) : null;
    html += `<tr><td class="mname">${esc(row.name)}${row.belowTarget ? ' <span class="badge bad" title="цель: ' + row.fmt(row.target) + (row.lower ? " и ниже" : "") + '">ниже цели</span>' : ""}</td>
      <td>${sparkSvg(row)}</td>
      ${row.values.map((v, i) => {
        let st = i === row.values.length - 1 ? "font-weight:700;" : "";
        if (v != null && bestV != null && v === bestV) st += "font-weight:700;color:var(--good);";
        else if (v != null && worstV != null && v === worstV) st += "font-weight:700;color:var(--bad);";
        return `<td class="num" style="${st}">${v != null ? row.fmt(v) : '<span class="muted">·</span>'}</td>`;
      }).join("")}
      <td class="num">${deltaCell(row)}</td>
      <td class="num">${deltaCell(row, "avg")}<div class="small muted">${row.prevAvg != null ? `ср.: ${row.fmt(row.prevAvg)}` : "ср.: —"}</div></td></tr>`;
  }
  html += "</table>";
  return html; // карточку закрывает вызывающий (может добавить график)
}

/* Адаптивная шкала графика баллов: показывает различия, не обрезая крайние значения. */
function scoreAxisBounds(datasets) {
  const values = datasets
    .flatMap(ds => ds.data || [])
    .filter(v => v != null && Number.isFinite(Number(v)))
    .map(Number);
  if (!values.length) return { min: 0, max: 105, stepSize: 25 };

  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const pad = Math.max(4, (rawMax - rawMin) * 0.08);
  let min = Math.max(0, Math.floor((rawMin - pad) / 5) * 5);
  let max = Math.ceil((rawMax + pad) / 5) * 5;

  if (max - min < 20) {
    const mid = (min + max) / 2;
    min = Math.max(0, Math.floor((mid - 10) / 5) * 5);
    max = Math.ceil((mid + 10) / 5) * 5;
  }
  return { min, max, stepSize: max - min <= 35 ? 5 : 10 };
}

const SCORE_CHART_OPTIONS = [
  { value: "all", label: "Все", title: "Все векторы и общий балл" },
  { value: "total", label: "Общий балл", title: "Только общий балл" },
  { value: "v1", label: "В1 Экономика", title: VECTOR_META.v1.name },
  { value: "v2", label: "В2 Экспертность", title: VECTOR_META.v2.name },
  { value: "v3", label: "В3 Перенаправления", title: VECTOR_META.v3.name },
  { value: "v4", label: "В4 База", title: VECTOR_META.v4.name },
  { value: "v5", label: "В5 Лояльность", title: VECTOR_META.v5.name },
  { value: "v6", label: "В6 Репутация", title: VECTOR_META.v6.name },
];

function scoreChartPicker(canvasId) {
  const current = UI.scoreChartModes[canvasId] || "all";
  return `<div class="score-chart-controls" id="${canvasId}_score_picker"><span class="small muted">Показать график:</span>${SCORE_CHART_OPTIONS.map(option =>
    `<button type="button" class="btn mini score-chart-choice${current === option.value ? " active" : ""}" data-score-mode="${option.value}" aria-pressed="${current === option.value ? "true" : "false"}" title="${esc(option.title)}" onclick="setScoreChartMode('${canvasId}','${option.value}')">${esc(option.label)}</button>`
  ).join("")}</div>`;
}

function syncScoreChartPicker(canvasId, current, available) {
  const picker = document.getElementById(canvasId + "_score_picker");
  if (!picker) return;
  picker.querySelectorAll("button[data-score-mode]").forEach(button => {
    const mode = button.dataset.scoreMode;
    const active = mode === current;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.disabled = mode !== "all" && !available.has(mode);
  });
}

function setScoreChartMode(canvasId, mode) {
  if (!SCORE_CHART_OPTIONS.some(option => option.value === mode)) return;
  const source = UI.scoreChartSources[canvasId];
  if (!source) return;
  UI.scoreChartModes[canvasId] = mode;
  renderScoresChart(canvasId, source.months, source.vecGetter, source.totalGetter);
}

/* График баллов векторов по месяцам: общий вид или выбранная отдельная серия. */
function renderScoresChart(canvasId, months, vecGetter, totalGetter) {
  UI.scoreChartSources[canvasId] = { months, vecGetter, totalGetter };
  const allDatasets = [];
  const available = new Set();
  for (const vk of ["v1", "v2", "v3", "v4", "v5", "v6"]) {
    const data = months.map(k => vecGetter(k, vk));
    if (!data.some(v => v != null)) continue;
    available.add(vk);
    allDatasets.push({
      scoreMode: vk,
      label: "В" + vk[1] + " " + VECTOR_META[vk].name.split(" ")[0],
      data, borderColor: VEC_LINE_COLORS[vk], backgroundColor: VEC_LINE_COLORS[vk],
      borderWidth: 2.2, pointRadius: 3.5, spanGaps: true, tension: 0.25,
    });
  }
  const totalData = months.map(totalGetter);
  if (totalData.some(v => v != null)) {
    available.add("total");
    allDatasets.push({
      scoreMode: "total",
      label: "Общий балл", data: totalData,
      borderColor: "#1c2333", backgroundColor: "#1c2333",
      borderWidth: 3.5, pointRadius: 4, spanGaps: true, tension: 0.25,
    });
  }
  if (!allDatasets.length) return false;
  let mode = UI.scoreChartModes[canvasId] || "all";
  if (mode !== "all" && !available.has(mode)) mode = "all";
  UI.scoreChartModes[canvasId] = mode;
  const datasets = mode === "all" ? allDatasets : allDatasets.filter(dataset => dataset.scoreMode === mode);
  syncScoreChartPicker(canvasId, mode, available);
  const axis = scoreAxisBounds(datasets);
  chart(canvasId, {
    type: "line",
    data: { labels: months.map(monthLabel), datasets },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      layout: { padding: { top: 12, bottom: 8 } },
      plugins: {
        legend: { position: "bottom" },
        tooltip: { mode: "index", intersect: false },
        datalabels: {
          display: ctx => UI.showLabels && (mode !== "all" || ctx.dataset.label === "Общий балл"),
          align: ctx => ctx.dataIndex % 2 ? "bottom" : "top",
          offset: 6, clamp: true,
          color: ctx => ctx.dataset.borderColor || "#1c2333", font: { size: 11, weight: "700" },
          formatter: v => v != null ? fmtNum(v, 0) : "",
        },
      },
      scales: {
        y: {
          min: axis.min,
          max: axis.max,
          ticks: { stepSize: axis.stepSize },
          title: { display: true, text: "Баллы" },
        },
      },
    },
  });
  return true;
}

/* сворачивание подкатегорий в расшифровке В2 */
function toggleGroup(g) {
  UI.openGroups[g] = !UI.openGroups[g];
  document.querySelectorAll(".grp-sub." + g).forEach(tr => { tr.style.display = UI.openGroups[g] ? "" : "none"; });
  const tri = document.getElementById("tri_" + g);
  if (tri) tri.textContent = UI.openGroups[g] ? "▾" : "▸";
}
function expandGroups(open) {
  document.querySelectorAll("#tblGroups .grp-head").forEach(tr => {
    const g = tr.dataset.g;
    if (!!UI.openGroups[g] !== open) toggleGroup(g);
  });
}

function metricRow(name, valueStr, note) {
  return `<div class="metric-row"><span class="mname">${esc(name)}${note ? ` <span class="small">(${esc(note)})</span>` : ""}</span><span class="mval">${valueStr}</span></div>`;
}
function dyn(pct) {
  if (pct == null || isNaN(pct)) return '<span class="muted small">н/д</span>';
  const up = pct >= 0;
  return `<span class="delta ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${fmtNum(Math.abs(pct), 1)}%</span>`;
}

/* Динамика клиентской базы для выбранного окна (12/36 мес.).
   Среднее с начала года считается только по месяцам, где загружено это же окно. */
function clientBaseDynamics(docId, endMk, windowMonths) {
  const prevKey = prevMonthKey(endMk, 1);
  const prev = kbSummary(docId, prevKey, windowMonths);
  const year = endMk.slice(0, 4);
  const ytd = monthKeysSorted()
    .filter(k => k.startsWith(year + "-") && k <= endMk)
    .map(k => kbSummary(docId, k, windowMonths))
    .filter(Boolean);
  const mean = values => {
    const xs = values.filter(v => v != null && !isNaN(v));
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  return {
    prevKey, prev, year, ytdCount: ytd.length,
    avgTotal: mean(ytd.map(x => x.total)),
    avgLostPct: mean(ytd.map(x => x.lostPct)),
  };
}

/* Стрелка показывает фактическое направление. Цвет показывает качество:
   рост базы и снижение доли потерь — зелёные. */
function kbTrendMarkup(current, baseline, lowerBetter, mode) {
  if (current == null || isNaN(current) || baseline == null || isNaN(baseline)) return '<span class="kb-trend na">н/д</span>';
  let delta;
  if (mode === "relative") {
    if (Number(baseline) === 0) return '<span class="kb-trend na">н/д</span>';
    delta = (Number(current) - Number(baseline)) / Math.abs(Number(baseline)) * 100;
  } else {
    delta = Number(current) - Number(baseline);
  }
  if (Math.abs(delta) < 0.0001) return '<span class="kb-trend flat">• без изменений</span>';
  const improved = lowerBetter ? delta < 0 : delta > 0;
  const arrow = delta > 0 ? "▲" : "▼";
  const value = mode === "relative" ? fmtNum(Math.abs(delta), 1) + "%" : fmtNum(Math.abs(delta), 1) + " п.п.";
  return `<span class="kb-trend ${improved ? "good" : "bad"}">${arrow} ${value}</span>`;
}

/* Универсальная история метрики врача: предыдущий календарный месяц и
   среднее по доступным месяцам с января по выбранный месяц включительно. */
function doctorMetricDynamics(docId, endMk, getValue) {
  const prevKey = prevMonthKey(endMk, 1);
  const valueAt = key => {
    const rr = computeMetrics(docId, key);
    if (!rr) return null;
    const value = getValue(rr);
    return value == null || isNaN(value) ? null : Number(value);
  };
  const prev = valueAt(prevKey);
  const year = endMk.slice(0, 4);
  const values = monthKeysSorted()
    .filter(k => k.startsWith(year + "-") && k <= endMk)
    .map(valueAt)
    .filter(v => v != null);
  return {
    prevKey, prev, year, count: values.length,
    avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
  };
}

function metricTrendMarkup(current, baseline, lowerBetter, mode, unit, digits) {
  if (current == null || isNaN(current) || baseline == null || isNaN(baseline)) return '<span class="kb-trend na">н/д</span>';
  let delta;
  if (mode === "relative") {
    if (Number(baseline) === 0) return '<span class="kb-trend na">н/д</span>';
    delta = (Number(current) - Number(baseline)) / Math.abs(Number(baseline)) * 100;
  } else {
    delta = Number(current) - Number(baseline);
  }
  if (Math.abs(delta) < 0.0001) return '<span class="kb-trend flat">• без изменений</span>';
  const improved = lowerBetter ? delta < 0 : delta > 0;
  const arrow = delta > 0 ? "▲" : "▼";
  const suffix = mode === "relative" ? "%" : (mode === "pp" ? " п.п." : (unit || ""));
  return `<span class="kb-trend ${improved ? "good" : "bad"}">${arrow} ${fmtNum(Math.abs(delta), digits == null ? 1 : digits)}${suffix}</span>`;
}

function metricHistoryMarkup(current, history, mode, unit, digits, formatter, lowerBetter) {
  const fmt = formatter || (v => fmtNum(v, digits == null ? 1 : digits));
  return `<div class="metric-history">
    ${current == null || isNaN(current) ? '<div class="metric-history-note">За выбранный месяц текущего значения нет. Ниже показана только история других месяцев.</div>' : ""}
    <div class="metric-history-row"><span>К прошлому месяцу</span><div class="metric-history-result">${metricTrendMarkup(current, history.prev, !!lowerBetter, mode, unit, digits)}<div class="metric-history-meta">${history.prev != null ? `${monthLabel(history.prevKey)}: ${fmt(history.prev)}` : `нет данных за ${monthLabel(history.prevKey)}`}</div></div></div>
    <div class="metric-history-row"><span>К среднему с начала ${history.year} года</span><div class="metric-history-result">${metricTrendMarkup(current, history.avg, !!lowerBetter, mode, unit, digits)}<div class="metric-history-meta">${history.avg != null ? `среднее за ${history.count} мес.: ${fmt(history.avg)}` : "нет данных"}</div></div></div>
  </div>`;
}

function metricGoalText(target, formatter) {
  if (target == null || target === "" || isNaN(target) || Number(target) <= 0) return "цель не установлена";
  return "цель ≥ " + formatter(Number(target));
}

function doctorGoalsSource(docId) {
  const doctor = DB.doctors[docId];
  if (doctor && doctor.metricSettings) return "индивидуальные цели";
  const specializationName = resolvedSpecializationName(docId);
  const departmentName = resolvedDepartmentName(docId);
  const specialization = specializationName && DB.settings.depts ? DB.settings.depts[specializationName] : null;
  if (specializationName && !(specialization && specialization.inheritGoals === true)) return `специализация «${specializationName}»`;
  return `отделение «${departmentName}»`;
}

function doctorGoalValue(key, value) {
  if (["revenue", "avgCheck"].includes(key)) return fmtMoney(value);
  if (key === "rating") return fmtNum(value, 2) + " / 5";
  if (key === "reviews") return fmtNum(value) + " шт.";
  return fmtPct(value);
}

function doctorGoalsSummaryHtml(docId, profile, standalone = true) {
  const benchmarks = profile && profile.scoring ? profile.scoring.benchmarks : {};
  const lowerGoals = new Set(["riskShare", "churn"]);
  const goals = scoringBenchmarkDefs(profile).map(([key, label]) => ({
    key,
    label,
    value: benchmarks[key],
  })).filter(goal => goal.value != null && goal.value !== "" && !isNaN(goal.value) && Number(goal.value) > 0);
  const body = goals.length
    ? `<div class="doctor-goals-grid">${goals.map(goal => `<div class="doctor-goal-item"><span>${esc(goal.label)}</span><b>${lowerGoals.has(goal.key) ? "≤" : "≥"} ${doctorGoalValue(goal.key, Number(goal.value))}</b></div>`).join("")}</div>`
    : '<p class="small muted" style="margin:0">Для врача цели пока не установлены.</p>';
  return `<div class="${standalone ? "card " : ""}doctor-goals-summary">
    <div class="doctor-goals-head"><h3>🎯 Цели врача</h3><span class="badge info">${esc(doctorGoalsSource(docId))}</span></div>
    ${body}
  </div>`;
}

function metricHighlight(title, valueHtml, sub, state, goalText, historyHtml) {
  return `<div class="metric-highlight ${state || "goal-plain"}">
    <div class="metric-title">${esc(title)}</div>
    <div class="metric-main">${valueHtml}</div>
    <div class="metric-sub">${esc(sub || "")}</div>
    <div class="metric-goal">${esc(goalText || "")}</div>
    ${historyHtml || ""}
  </div>`;
}

function renderDoctor() {
  const months = monthKeysSorted();
  const body = document.getElementById("doctorBody");
  setControlsDisabled(["docMonth", "docSelect"], !months.length);
  if (!months.length) {
    body.innerHTML = '<div class="card"><p class="muted">Загрузите данные на вкладке «Данные».</p></div>';
    document.getElementById("docMonth").innerHTML = "";
    document.getElementById("docSelect").innerHTML = "";
    return;
  }
  if (!UI.docMonth || !DB.months[UI.docMonth]) UI.docMonth = months[months.length - 1];
  const mk = UI.docMonth;
  const ids = doctorsInMonth(mk);
  const core = coreDoctorsInMonth(mk);
  const list = core.length ? core : ids;
  setControlsDisabled(["docSelect"], !list.length);
  if (!UI.docId || !list.includes(UI.docId)) UI.docId = list[0] || null;

  document.getElementById("docMonth").innerHTML = months.map(k => `<option value="${k}" ${k === mk ? "selected" : ""}>${monthLabel(k)}</option>`).join("");
  document.getElementById("docSelect").innerHTML = list.map(id => `<option value="${id}" ${id === UI.docId ? "selected" : ""}>${esc(doctorName(id))}</option>`).join("");
  if (!UI.docId) { body.innerHTML = '<div class="card"><p class="muted">Нет специалистов с данными за этот месяц.</p></div>'; return; }
  const r = computeMetrics(UI.docId, mk);
  if (!r) { body.innerHTML = '<div class="card"><p class="muted">Нет данных по специалисту за этот месяц.</p></div>'; return; }

  let html = "";
  const docProfile = profileForDoctor(UI.docId);
  const scoreNazSlice = r.cross.naz[UI.nazSlice] ? UI.nazSlice : (r.cross.nazSlices[0] || null);
  const shownVecScores = r.scores ? { ...r.scores.vec } : null;
  if (shownVecScores && scoreNazSlice != null && r.scores.v3ByNaz && r.scores.v3ByNaz[scoreNazSlice] != null) {
    shownVecScores.v3 = r.scores.v3ByNaz[scoreNazSlice];
  }

  /* ---- Шапка: общий балл + ключевые показатели пациентов ---- */
  const showSc = DB.settings.showScores && r.scores;
  const totalScore = showSc && scoreNazSlice != null && r.scores.totalByNaz && r.scores.totalByNaz[scoreNazSlice] != null
    ? r.scores.totalByNaz[scoreNazSlice]
    : (showSc ? r.scores.total : null);
  const circ = 2 * Math.PI * 54;
  const scColor = totalScore == null ? "var(--line)" : totalScore >= 70 ? "var(--good)" : totalScore >= 40 ? "var(--warn)" : "var(--bad)";
  const scoreEligible = !r.scores || r.scores.rankEligible;
  const activeBase = selectedClientBaseSummary(r, docProfile);
  const activeBaseWin = activeBase ? activeBase.window : null;
  const activeBaseValue = activeBase ? activeBase.activeBasePct : null;
  const activeBaseDyn = doctorMetricDynamics(UI.docId, mk, rr => (
    selectedClientBaseSummary(rr, docProfile) ? selectedClientBaseSummary(rr, docProfile).activeBasePct : null
  ));
  html += `<div class="card" id="blkHead">
    <div class="flex" style="justify-content:space-between">
      <h2 class="mt0" style="margin-bottom:4px">${esc(doctorName(UI.docId))} <span class="muted small">· ${monthLabel(mk)} · ${esc(doctorStructureLabel(UI.docId))}</span>
        ${DB.doctors[UI.docId].metricSettings ? ' <span class="badge info" title="Цели настроены персонально для этого врача">индивидуальные цели</span>' : ""}
        ${r.partial ? ` <span class="badge warn" title="${esc(r.missing.join(", "))}">не все отчёты</span>` : ""}
        ${showSc && !scoreEligible ? ` <span class="badge warn" title="В рейтинг врач попадёт при полноте от 80%">балл предварительный · полнота ${fmtPct(r.scores.coveragePct)}</span>` : ""}</h2>
      <span class="no-print" style="white-space:nowrap"><label class="small"><input type="checkbox" ${UI.showLabels ? "checked" : ""} onchange="toggleLabels()"> цифры на графиках</label> ${blockBtn("blkHead")}</span>
    </div>
    ${r.partial ? `<p class="small muted" style="margin:0 0 10px">Не загружено: ${esc(r.missing.join(", "))}.</p>` : ""}
    <div class="gauge-wrap">
      ${showSc ? `<div class="dpi-ring" style="width:130px;height:130px" title="Средневзвешенный балл выполнения нормативов по векторам. Веса задаются специализации; цели — отделению, специализации или врачу">
        <svg width="130" height="130"><circle cx="65" cy="65" r="54" fill="none" stroke="var(--line)" stroke-width="12"/>
        <circle cx="65" cy="65" r="54" fill="none" stroke="${scColor}" stroke-width="12" stroke-linecap="round"
          stroke-dasharray="${(circ * (totalScore || 0) / 100).toFixed(1)} ${circ.toFixed(1)}"/></svg>
        <div class="num"><b style="font-size:28px">${totalScore != null ? fmtNum(totalScore, 0) : "—"}</b><i>${scoreEligible ? "общий балл" : "предварительный"}</i></div>
      </div>` : ""}
      <div style="flex:1;min-width:280px"><div class="grid cols-3">
        <div class="kpi"><div class="lbl">🧍 Пациентов за месяц</div><div class="val">${fmtNum(r.traffic.patients)}</div><div class="sub">уникальные пациенты</div></div>
        <div class="kpi"><div class="lbl">📅 Количество визитов за месяц</div><div class="val">${fmtNum(r.traffic.visits)}</div><div class="sub">${esc(r.traffic.src)}</div></div>
        <div class="kpi"><div class="lbl">🟢 Объём активной клиентской базы</div><div class="val">${fmtPct(activeBaseValue)}</div>
          <div class="sub">${activeBase ? `${fmtNum(activeBase.seg.active)} активных из ${fmtNum(activeBase.total)} · окно ${activeBaseWin} мес.` : "нет подходящей выгрузки клиентской базы"}</div>
          ${metricHistoryMarkup(activeBaseValue, activeBaseDyn, "pp", "", 1, fmtPct)}
        </div>
      </div></div>
    </div>
    ${showSc ? `<div class="vec-scores">${["v1", "v2", "v3", "v4", "v5", "v6"].map(vk => {
      const sv = shownVecScores[vk];
      const en = docProfile.scoring.enabled[vk];
      const cls = sv == null ? "mut" : sv >= 70 ? "ok" : sv >= 40 ? "warn" : "bad";
      return `<div class="vec-score-chip ${cls}" title="${esc(VECTOR_META[vk].name)}${en ? "" : " · не в общем балле"}">
        <b>${sv != null ? fmtNum(sv, 0) : "—"}</b><span>В${vk[1]}${en ? "" : "*"} · ${esc(VECTOR_META[vk].name.split(" ")[0])}</span></div>`;
    }).join("")}</div>` : ""}
  </div>`;

  html += doctorGoalsSummaryHtml(UI.docId, docProfile);

  /* ---- В1 Экономика ---- */
  const e = r.econ;
  html += `<div class="card vector-card" id="blkV1" style="border-top-color:${VECTOR_META.v1.color}">
    <div class="vhead"><h3 class="mt0">Вектор 1. Экономическая результативность <span class="badge ${VECTOR_META.v1.cls}">${VECTOR_META.v1.tag}</span></h3><span>${vecBadge("v1", r, docProfile)} ${blockBtn("blkV1")}</span></div>
    <div class="grid cols-2"><div>
      ${metricRow("Выручка", `<b>${fmtMoney(e.sales)}</b>`)}
      ${e.assistSum ? metricRow("… участие ассистентом", fmtMoney(e.assistSum), "не входит в выручку") : ""}
      ${metricRow("Выручка от перенаправлений", fmtMoney(e.refRevenue))}
      ${metricRow("Выручка с перенаправлениями", `<b>${fmtMoney(e.revenueWithRef)}</b>`)}
    </div><div>
      ${metricRow("Средний чек на пациента", `<b>${fmtMoney(e.avgClient)}</b>`, "выручка / пациенты")}
      ${metricRow("Средний чек посещения", fmtMoney(e.avgVisit), "выручка / визиты")}
      ${metricRow("Средний чек с перенаправлениями", fmtMoney(e.avgClientRef), "на пациента")}
    </div></div>
    <div class="grid cols-3" style="margin-top:10px">
      <div class="kpi"><div class="lbl">Чек к прошлому месяцу</div><div class="val" style="font-size:16px">${dyn(e.dynPrev)}</div><div class="sub">было ${fmtMoney(e.prev1)}</div></div>
      <div class="kpi"><div class="lbl">Чек к среднему за квартал</div><div class="val" style="font-size:16px">${dyn(e.dynQ)}</div><div class="sub">среднее 3 мес: ${fmtMoney(e.prevQ)}</div></div>
      <div class="kpi"><div class="lbl">Чек к среднему прошлого года</div><div class="val" style="font-size:16px">${dyn(e.dynY)}</div><div class="sub">среднее: ${fmtMoney(e.prevY)}</div></div>
    </div></div>`;

  /* ---- В2 Экспертность (аппараты или услуги — по профилю отделения) ---- */
  const p = r.product;
  const exMode = docProfile.expertise.mode;
  const exTitle = docProfile.expertise.title || "Экспертность";
  const exUnit = "позиций";
  html += `<div class="card vector-card" id="blkV2" style="border-top-color:${VECTOR_META.v2.color}">
    <div class="vhead"><h3 class="mt0">Вектор 2. Экспертность и продукт <span class="badge ${VECTOR_META.v2.cls}">${VECTOR_META.v2.tag}</span></h3>
    <span>${vecBadge("v2", r, docProfile)} ${blockBtn("blkV2")} ${p && exMode !== "none" ? `<span class="vscore">${p.devicesUsed}<span class="small muted"> из ${p.park} ${exUnit}</span></span>` : ""}</span></div>`;
  if (!p) {
    html += '<p class="muted small">Нет выработки за месяц.</p></div>';
  } else {
    const candCnt = Object.keys(p.devCandidates).length;
    if (exMode !== "none" && candCnt) {
      html += `<div class="notice" style="margin-bottom:10px">⚠ ${candCnt} процедур похожи на «${esc(exTitle)}», но не привязаны (${fmtMoney(Object.values(p.devCandidates).reduce((a, x) => a + x.s, 0))}) — <a href="#" onclick="switchTab('settings');return false">привяжите в Настройках</a>.</div>`;
    }
    if (exMode === "none") {
      html += `<p class="small muted" style="margin-top:0">У профиля «${esc(resolvedDeptName(UI.docId))}» блок экспертности отключён — оценивается структура выручки, балл вектора не считается (вес перераспределён).</p>`;
    }
    html += `<div class="grid cols-2">
      <div><h3 class="small muted" style="margin-bottom:6px">ДОЛЕВОЕ РАСПРЕДЕЛЕНИЕ ВЫРУЧКИ ${copyBtn("copyChart", "chRevStruct", "PNG")}</h3>
        <div class="chart-box tall"><canvas id="chRevStruct"></canvas></div></div>
      <div><details ${collapsibleListAttrs("revenueBreakdown")}><summary class="collapsible-list-summary"><span>РАСШИФРОВКА ВЫРУЧКИ <span class="section-detail">· ▸ у категории — подкатегории</span></span><span class="collapse-hint"></span></summary>
        <div class="collapsible-list-body">
        <div class="toolbar no-print" style="margin:4px 0 6px">
          <button class="btn mini" onclick="expandGroups(true)">развернуть все подкатегории</button>
          <button class="btn mini" onclick="expandGroups(false)">свернуть</button>
          ${copyBtn("copyTable", "tblGroups")}
        </div>
        <table class="data" id="tblGroups"><tr><th>Категория</th><th class="num">Кол-во</th><th class="num">Сумма</th><th class="num">Доля</th></tr>`;
    const totalOwn = r.extras.vy.ownSum || 1;
    let gIdx = 0;
    // группы из таксономии + «сиротские» (появившиеся из правил, но не в списке) в конце
    const groupOrder = [...Object.keys(docProfile.groups)];
    for (const g of Object.keys(p.byGroup)) if (!groupOrder.includes(g)) groupOrder.push(g);
    for (const g of groupOrder) {
      const gd = p.byGroup[g];
      if (!gd || (!gd.s && !gd.q)) continue;
      const subs = Object.entries(gd.subs).filter(([k, v]) => v.s > 0 || v.q > 0).sort((a, b) => b[1].s - a[1].s);
      const hasSubs = subs.length > 1 || (subs.length === 1 && subs[0][0] !== "—");
      const gKey = "g" + gIdx++;
      const open = !!UI.openGroups[gKey];
      html += `<tr class="grp-head" data-g="${gKey}" ${hasSubs ? `onclick="toggleGroup('${gKey}')" style="cursor:pointer"` : ""}>
        <td><span id="tri_${gKey}" class="muted">${hasSubs ? (open ? "▾" : "▸") : "·"}</span> <b>${g}</b></td>
        <td class="num"><b>${fmtNum(gd.q)}</b></td><td class="num"><b>${fmtMoney(gd.s)}</b></td><td class="num"><b>${fmtPct(gd.s / totalOwn * 100)}</b></td></tr>`;
      if (hasSubs) {
        for (const [sub, sd] of subs) {
          html += `<tr class="grp-sub ${gKey}" ${open ? "" : 'style="display:none"'}><td class="small muted" style="padding-left:26px">${esc(sub)}</td><td class="num small muted">${fmtNum(sd.q)}</td><td class="num small muted">${fmtMoney(sd.s)}</td><td class="num small muted">${fmtPct(sd.s / totalOwn * 100)}</td></tr>`;
        }
      }
    }
    html += `<tr><td><b>Итого выручка</b></td><td class="num"><b>${fmtNum(r.extras.vy.ownQty)}</b></td><td class="num"><b>${fmtMoney(totalOwn)}</b></td><td class="num"><b>100%</b></td></tr></table></div></details></div></div>`;

    // экспертные позиции: две круговые (штуки и деньги) + таблица
    if (exMode !== "none") {
      const exOrder = docProfile.expertise.items.map(d => d.name);
      for (const nm of Object.keys(p.expert)) if (!exOrder.includes(nm)) exOrder.push(nm);
      const devEntries = exOrder.filter(nm => p.expert[nm]);
      const upTitle = esc(exTitle.toUpperCase());
      html += `<div class="grid cols-3" style="margin-top:12px">
      <div><h3 class="small muted" style="margin-bottom:6px">${upTitle}: ШТУКИ ${copyBtn("copyChart", "chDevices", "PNG")}</h3><div class="chart-box"><canvas id="chDevices"></canvas></div></div>
      <div><h3 class="small muted" style="margin-bottom:6px">${upTitle}: ВЫРУЧКА, ₽ ${copyBtn("copyChart", "chDevicesMoney", "PNG")}</h3><div class="chart-box"><canvas id="chDevicesMoney"></canvas></div></div>
      <div><details ${collapsibleListAttrs("expertPositions")}><summary class="collapsible-list-summary"><span>${upTitle}: СПИСОК</span><span class="collapse-hint"></span></summary>
      <div class="collapsible-list-body"><div class="toolbar no-print">${copyBtn("copyTable", "tblDevices")}</div>
      <table class="data" id="tblDevices"><tr><th>Позиция</th><th class="num">Штук</th><th class="num">Выручка</th></tr>`;
      const coreSet = new Set(docProfile.expertise.items.filter(d => d.core !== false).map(d => d.name));
      for (const nm of devEntries) {
        html += `<tr><td>${esc(nm)}${coreSet.has(nm) ? "" : ' <span class="small muted">(вне парка)</span>'}</td><td class="num">${fmtNum(p.expert[nm].q)}</td><td class="num">${fmtMoney(p.expert[nm].s)}</td></tr>`;
      }
      const unusedDevs = [...coreSet].filter(nm => !p.expert[nm]);
      if (unusedDevs.length) html += `<tr><td class="small muted" colspan="3">Не задействованы: ${unusedDevs.map(esc).join(", ")}</td></tr>`;
      html += `</table></div></details></div></div>`;
    }
    html += `</div>`;
  }

  /* ---- В3 Междисциплинарный ---- */
  const nazCur = scoreNazSlice;
  const nz = nazCur != null ? r.cross.naz[nazCur] : null;
  const refWorkTotal = r.cross.refByType
    ? Object.values(r.cross.refByType).reduce((sum, item) => sum + (item && item.s ? item.s : 0), 0)
    : null;
  const shownV3Score = shownVecScores ? shownVecScores.v3 : undefined;
  html += `<div class="card vector-card" id="blkV3" style="border-top-color:${VECTOR_META.v3.color}">
    <div class="vhead"><h3 class="mt0">Вектор 3. Междисциплинарный подход <span class="badge ${VECTOR_META.v3.cls}">${VECTOR_META.v3.tag}</span></h3>
    <span>${vecBadge("v3", r, docProfile, shownV3Score)} ${blockBtn("blkV3")} ${nz && nz.focus && nz.focus.park ? `<span class="vscore">${nz.focus.used}<span class="small muted"> из ${nz.focus.park} фокусов</span></span>` : ""} ${r.cross.nazSlices.length ? segToggle("nazSeg", r.cross.nazSlices.map(s => ({ v: s, label: "назначения " + s + " мес" })), nazCur, "setNazSlice") : ""}</span></div>
    ${metricRow("Доля выручки от перенаправлений", `<b>${fmtPct(r.cross.crossShare)}</b>`, "перенаправления / выручка с перенаправлениями")}`;
  if (nz) {
    const convTarget = docProfile.scoring && docProfile.scoring.benchmarks ? docProfile.scoring.benchmarks.nazConv : null;
    const convState = trackedMetricState(nz.totals.conv, convTarget);
    const hasConvTarget = convTarget != null && convTarget !== "" && !isNaN(convTarget) && Number(convTarget) > 0;
    html += `<h3 class="section-title" style="margin:12px 0 6px">КОНВЕРСИЯ НАЗНАЧЕНИЙ <span class="section-detail">· окно ${nazCur} мес. · источник: отчёт «Назначения» · ▸ у типа — раскрыть состав</span> ${copyBtn("copyTable", "tblNaz")}</h3>
      ${nz.totals.valid === false ? `<div class="notice bad"><b>Конверсия не рассчитана:</b> ${esc(nz.totals.issue)}. Проверьте состав исходной выгрузки.</div>` : ""}
      <div class="tracked-metric ${convState}">
        <div><div class="tracked-title">Конверсия за ${nazCur} мес.</div><div class="tracked-note">Выполнено + продано / назначено · ${fmtNum(nz.totals.done + nz.totals.soldQ)} из ${fmtNum(nz.totals.assigned)}</div></div>
        <div class="tracked-side"><div class="tracked-value">${nz.totals.conv != null ? fmtPct(nz.totals.conv) : "—"}</div><div class="tracked-goal">${hasConvTarget ? `цель ≥ ${fmtPct(Number(convTarget))}` : "цель не установлена"}</div></div>
      </div>
      <details ${collapsibleListAttrs("appointmentDetails")}><summary class="collapsible-list-summary"><span>ДЕТАЛИ НАЗНАЧЕНИЙ</span><span class="collapse-hint"></span></summary>
      <div class="collapsible-list-body"><table class="data" id="tblNaz"><tr><th>Тип направления</th><th class="num">Назначено, шт</th><th class="num">Выполнено, шт</th><th class="num">Продано, шт</th><th class="num">Выручка по отчёту «Назначения», ₽</th><th class="num">Конверсия</th></tr>`;
    let ntIdx = 0;
    for (const t of REF_TYPES) {
      const b = nz.byType[t];
      if (!b || (b.assigned === 0 && b.done === 0 && b.soldQ === 0)) continue;
      const itEntries = Object.entries(b.items || {}).filter(([n, v]) => v.assigned || v.done || v.soldQ).sort((a, bb) => (bb[1].soldSum + bb[1].assigned) - (a[1].soldSum + a[1].assigned));
      const gKey = "nt" + ntIdx++;
      const open = !!UI.openGroups[gKey];
      html += `<tr class="grp-head" data-g="${gKey}" ${itEntries.length ? `onclick="toggleGroup('${gKey}')" style="cursor:pointer"` : ""}>
        <td><span id="tri_${gKey}" class="muted">${itEntries.length ? (open ? "▾" : "▸") : "·"}</span> <b>${esc(t)}</b></td>
        <td class="num"><b>${fmtNum(b.assigned)}</b></td><td class="num"><b>${fmtNum(b.done)}</b></td><td class="num"><b>${fmtNum(b.soldQ)}</b></td><td class="num"><b>${fmtMoney(b.soldSum)}</b></td><td class="num"><b>${b.conv != null ? fmtPct(b.conv) : "—"}</b></td></tr>`;
      for (const [n, v] of itEntries.slice(0, 40)) {
        html += `<tr class="grp-sub ${gKey}" ${open ? "" : 'style="display:none"'}><td class="small muted" style="padding-left:26px">${esc(n.length > 70 ? n.slice(0, 70) + "…" : n)}</td>
          <td class="num small muted">${fmtNum(v.assigned)}</td><td class="num small muted">${fmtNum(v.done)}</td><td class="num small muted">${fmtNum(v.soldQ)}</td><td class="num small muted">${fmtMoney(v.soldSum)}</td><td class="num small muted"></td></tr>`;
      }
    }
    html += `<tr><td><b>Итого</b></td><td class="num"><b>${fmtNum(nz.totals.assigned)}</b></td><td class="num"><b>${fmtNum(nz.totals.done)}</b></td><td class="num"><b>${fmtNum(nz.totals.soldQ)}</b></td><td class="num"><b>${fmtMoney(nz.totals.soldSum)}</b></td><td class="num"><b>${nz.totals.conv != null ? fmtPct(nz.totals.conv) : "—"}</b></td></tr></table></div></details>`;
    if (nz.focus) {
      const focusOrder = (docProfile.crossFocus.items || []).map(item => item.name);
      for (const name of Object.keys(nz.focus.items)) if (!focusOrder.includes(name)) focusOrder.push(name);
      const focusEntries = focusOrder.filter(name => nz.focus.items[name]);
      const focusQtyEntries = focusEntries.filter(name => nz.focus.items[name].soldQ > 0);
      const focusMoneyEntries = focusEntries.filter(name => nz.focus.items[name].soldSum > 0);
      const focusCore = new Set((docProfile.crossFocus.items || []).filter(item => item.core !== false).map(item => item.name));
      const focusUnused = [...focusCore].filter(name => !nz.focus.items[name] || nz.focus.items[name].soldQ <= 0);
      const focusTitle = esc((nz.focus.title || "Фокусы междисциплинарного подхода").toUpperCase());
      const focusTarget = docProfile.scoring && docProfile.scoring.benchmarks ? docProfile.scoring.benchmarks.nazFocusShare : null;
      const focusState = trackedMetricState(nz.focus.revenueShare, focusTarget);
      const hasFocusTarget = focusTarget != null && focusTarget !== "" && !isNaN(focusTarget) && Number(focusTarget) > 0;
      html += `<h3 class="section-title" style="margin:14px 0 6px">${focusTitle} <span class="section-detail">· проданные позиции и выручка из отчёта «Назначения»</span></h3>
        <div class="tracked-metric ${focusState}">
          <div><div class="tracked-title">Доля выручки фокусов</div><div class="tracked-note">${fmtMoney(nz.focus.soldSum)} из ${fmtMoney(nz.totals.soldSum)} · задействовано ${nz.focus.used} из ${nz.focus.park} фокусов</div></div>
          <div class="tracked-side"><div class="tracked-value">${fmtPct(nz.focus.revenueShare)}</div><div class="tracked-goal">${hasFocusTarget ? `цель ≥ ${fmtPct(Number(focusTarget))}` : "цель не установлена"}</div></div>
        </div>
        <div class="grid cols-3" style="margin-top:12px">
          <div>${focusQtyEntries.length ? `<h3 class="small muted" style="margin-bottom:6px">${focusTitle}: ШТУКИ ${copyBtn("copyChart", "chNazFocusQty", "PNG")}</h3><div class="chart-box"><canvas id="chNazFocusQty"></canvas></div>` : '<p class="muted small">По фокусам пока нет проданных позиций.</p>'}</div>
          <div>${focusMoneyEntries.length ? `<h3 class="small muted" style="margin-bottom:6px">${focusTitle}: ВЫРУЧКА ${copyBtn("copyChart", "chNazFocusMoney", "PNG")}</h3><div class="chart-box"><canvas id="chNazFocusMoney"></canvas></div>` : '<p class="muted small">По фокусам пока нет выручки.</p>'}</div>
          <div><details ${collapsibleListAttrs("interdisciplinaryFocusPositions")}><summary class="collapsible-list-summary"><span>${focusTitle}: СПИСОК</span><span class="collapse-hint"></span></summary>
            <div class="collapsible-list-body"><div class="toolbar no-print">${copyBtn("copyTable", "tblNazFocus")}</div><table class="data" id="tblNazFocus"><tr><th>Фокус</th><th class="num">Продано, шт</th><th class="num">Выручка</th></tr>
            ${focusEntries.map(name => `<tr><td>${esc(name)}${focusCore.has(name) ? "" : ' <span class="small muted">(вне набора)</span>'}</td><td class="num">${fmtNum(nz.focus.items[name].soldQ)}</td><td class="num">${fmtMoney(nz.focus.items[name].soldSum)}</td></tr>`).join("")}
            ${focusUnused.length ? `<tr><td class="small muted" colspan="3">Не задействованы: ${focusUnused.map(esc).join(", ")}</td></tr>` : ""}
            </table></div></details></div>
        </div>`;
    }
  } else {
    html += '<p class="muted small" style="margin-top:8px">Нет выгрузки «Назначения» за этот месяц — конверсии недоступны.</p>';
  }
  if (r.cross.refByType && Object.keys(r.cross.refByType).length) {
    if (nz && refWorkTotal != null) {
      const sourceDiff = nz.totals.soldSum - refWorkTotal;
      const sourceMatch = Math.abs(sourceDiff) < 0.5;
      html += `<div class="source-compare ${sourceMatch ? "match" : ""}"><b>Сверка двух источников:</b> отчёт «Назначения» — ${fmtMoney(nz.totals.soldSum)}, отчёт «Выработка» — ${fmtMoney(refWorkTotal)}${sourceMatch ? ". Суммы совпадают." : `, разница — ${fmtMoney(Math.abs(sourceDiff))}. Это отдельные выгрузки; расхождение теперь показано явно и не скрывается одной итоговой цифрой.`}</div>`;
    }
    html += `<div class="grid cols-2" style="margin-top:12px"><div>
      <details ${collapsibleListAttrs("completedReferralDetails")}><summary class="collapsible-list-summary"><span>ВЫПОЛНЕНИЕ НАПРАВЛЕНИЙ <span class="section-detail">· источник: «Выработка»</span></span><span class="collapse-hint"></span></summary>
      <div class="collapsible-list-body"><div class="toolbar no-print">${copyBtn("copyTable", "tblRef")}</div>
      <table class="data" id="tblRef"><tr><th>Тип</th><th class="num">Штук</th><th class="num">Сумма по отчёту «Выработка»</th></tr>`;
    let rtIdx = 0;
    for (const t of REF_TYPES) {
      const b = r.cross.refByType[t];
      if (!b) continue;
      const itEntries = Object.entries(b.items || {}).sort((a, bb) => bb[1].s - a[1].s);
      const gKey = "rt" + rtIdx++;
      const open = !!UI.openGroups[gKey];
      html += `<tr class="grp-head" data-g="${gKey}" ${itEntries.length ? `onclick="toggleGroup('${gKey}')" style="cursor:pointer"` : ""}>
        <td><span id="tri_${gKey}" class="muted">${itEntries.length ? (open ? "▾" : "▸") : "·"}</span> <b>${esc(t)}</b></td>
        <td class="num"><b>${fmtNum(b.q)}</b></td><td class="num"><b>${fmtMoney(b.s)}</b></td></tr>`;
      for (const [n, v] of itEntries.slice(0, 40)) {
        html += `<tr class="grp-sub ${gKey}" ${open ? "" : 'style="display:none"'}><td class="small muted" style="padding-left:26px">${esc(n.length > 60 ? n.slice(0, 60) + "…" : n)}</td>
          <td class="num small muted">${fmtNum(v.q)}</td><td class="num small muted">${fmtMoney(v.s)}</td></tr>`;
      }
    }
    html += `<tr><td><b>Итого</b></td><td class="num"></td><td class="num"><b>${fmtMoney(refWorkTotal)}</b></td></tr></table></div></details></div>
      <div><h3 class="section-title" style="margin:0 0 6px">СТРУКТУРА НАПРАВЛЕНИЙ ПО ДЕНЬГАМ ${copyBtn("copyChart", "chNazStruct", "PNG")}</h3>
      <div class="chart-box"><canvas id="chNazStruct"></canvas></div></div></div>`;
  }
  html += "</div>";

  /* ---- В4 Клиентская база ---- */
  const kbAvail = r.akb.availableWins;
  const requestedKbWin = Object.prototype.hasOwnProperty.call(UI.kbWinByDoctor, UI.docId)
    ? UI.kbWinByDoctor[UI.docId]
    : null;
  const kbWinCur = recommendedClientBaseWindow(kbAvail, docProfile, requestedKbWin);
  if (kbWinCur != null) UI.kbWin = kbWinCur;
  const kb = kbWinCur != null ? r.akb.wins[kbWinCur] : null;
  const hasSufficientKbWindow = kbAvail.some(win => clientBaseWindowSufficient(win, docProfile));
  const largestKbWindow = kbAvail.length ? kbAvail[kbAvail.length - 1] : null;
  const kbWindowOptions = kbAvail.map(win => {
    const sufficient = clientBaseWindowSufficient(win, docProfile);
    return {
      v: win,
      label: win >= 24 ? Math.round(win / 12) + " года" : win + " мес",
      disabled: !sufficient && (hasSufficientKbWindow || win !== largestKbWindow),
      title: sufficient
        ? `Окно достаточно для порога потери после ${docProfile.riskM} мес.`
        : `Недостаточно: для потери после ${docProfile.riskM} мес. нужна выгрузка минимум за ${clientBaseRequiredWindow(docProfile)} мес.`,
    };
  });
  html += `<div class="card vector-card" id="blkV4" style="border-top-color:${VECTOR_META.v4.color}">
    <div class="vhead"><h3 class="mt0">Вектор 4. Работа с клиентской базой <span class="badge ${VECTOR_META.v4.cls}">${VECTOR_META.v4.tag}</span></h3>
    <span>${vecBadge("v4", r, docProfile)} ${blockBtn("blkV4")} ${kbAvail.length ? segToggle("kbWinSeg", kbWindowOptions, kbWinCur, "setKbWin") : ""}</span></div>`;
  if (!kb) {
    html += '<p class="muted small">Нет выгрузок «Давность посещений» с окном от 6 месяцев.</p></div>';
  } else {
    const pr = kb.params;
    const riskUntilM = kb.thresholds ? kb.thresholds.riskM : (pr.activeM + pr.riskM) / 2;
    const specializationName = resolvedSpecializationName(UI.docId);
    const settingsScope = specializationName
      ? `специализации «${specializationName}»`
      : `отделения «${resolvedDepartmentName(UI.docId)}»`;
    const lostFromDay = kb.thresholds.lostDays + 1;
    const segmentOptions = [
      { v: "active", label: `Активная · ${kb.seg.active}` },
      { v: "risk", label: `Риск · ${kb.seg.risk}` },
      { v: "sleep", label: `Спящая · ${kb.seg.sleep}` },
      { v: "lost", label: `Потерянная · ${kb.seg.lost}` },
    ];
    if (kb.seg.unknown) segmentOptions.push({ v: "unknown", label: `Без давности · ${kb.seg.unknown}` });
    if (!segmentOptions.some(x => x.v === UI.clientSegment)) UI.clientSegment = "risk";
    const selectedClients = clientRowsForSegment(kb, UI.clientSegment);
    const kbDyn = clientBaseDynamics(UI.docId, mk, kbWinCur);
    html += `<p class="small muted" style="margin-top:0">Источник: выгрузка «Давность посещений» за ${kb.window} мес (период ${periodStr(kb.period)}) — ${fmtNum(kb.total)} клиентов, ${fmtNum(kb.visits)} визитов.</p>
    <div class="notice ${kb.sourceWindowComplete ? "blue" : "warn"}" style="margin:0 0 12px">
      <b>Применены индивидуальные настройки ${esc(settingsScope)}:</b>
      активная база ≤${pr.activeM} мес.; риск ${pr.activeM}–${fmtNum(riskUntilM, 1)} мес.; спящая ${fmtNum(riskUntilM, 1)}–${pr.riskM} мес.; потерянная &gt;${pr.riskM} мес. (с ${fmtNum(lostFromDay)}-го дня); лояльный — от ${pr.minVisits} визитов.
      ${kb.sourceWindowComplete
        ? `Приложение автоматически выбрало окно ${kb.window} мес., потому что оно длиннее срока потери.`
        : `Текущая выгрузка неполная для расчёта потерянной базы: нужна минимум за ${kb.requiredWindowM} мес. Количество потерянных ниже показано только как известный минимум, доля не рассчитывается.`}
      <a href="#" onclick="switchTab('settings');return false">Изменить настройки</a>.
    </div>
    <div class="kb-dynamics">
      <div class="kb-dyn-card">
        <div class="kb-dyn-title">Динамика клиентской базы</div>
        <div class="kb-dyn-current">${fmtNum(kb.total)} чел.</div>
        <div class="kb-dyn-row"><span>К прошлому месяцу</span><div class="kb-dyn-result">${kbTrendMarkup(kb.total, kbDyn.prev ? kbDyn.prev.total : null, false, "relative")}<div class="kb-dyn-meta">${kbDyn.prev ? `${monthLabel(kbDyn.prevKey)}: ${fmtNum(kbDyn.prev.total)} чел.` : `нет данных за ${monthLabel(kbDyn.prevKey)}`}</div></div></div>
        <div class="kb-dyn-row"><span>К среднему с начала ${kbDyn.year} года</span><div class="kb-dyn-result">${kbTrendMarkup(kb.total, kbDyn.avgTotal, false, "relative")}<div class="kb-dyn-meta">${kbDyn.avgTotal != null ? `среднее за ${kbDyn.ytdCount} мес.: ${fmtNum(kbDyn.avgTotal, 1)} чел.` : "нет данных"}</div></div></div>
      </div>
      <div class="kb-dyn-card">
        <div class="kb-dyn-title">Динамика снижения потерь</div>
        <div class="kb-dyn-current">${fmtPct(kb.lostPct)}</div>
        <div class="kb-dyn-row"><span>К прошлому месяцу</span><div class="kb-dyn-result">${kbTrendMarkup(kb.lostPct, kbDyn.prev ? kbDyn.prev.lostPct : null, true, "pp")}<div class="kb-dyn-meta">${kbDyn.prev ? `${monthLabel(kbDyn.prevKey)}: ${fmtPct(kbDyn.prev.lostPct)}` : `нет данных за ${monthLabel(kbDyn.prevKey)}`}</div></div></div>
        <div class="kb-dyn-row"><span>К среднему с начала ${kbDyn.year} года</span><div class="kb-dyn-result">${kbTrendMarkup(kb.lostPct, kbDyn.avgLostPct, true, "pp")}<div class="kb-dyn-meta">${kbDyn.avgLostPct != null ? `среднее за ${kbDyn.ytdCount} мес.: ${fmtPct(kbDyn.avgLostPct)}` : "нет данных"}</div></div></div>
      </div>
    </div>
    <div class="grid cols-2"><div>
      ${metricRow("База за окно, всего", `<b>${fmtNum(kb.total)} чел.</b>`, fmtNum(kb.visits) + " визитов за " + kb.window + " мес")}
      ${metricRow(`Активная: были ≤${pr.activeM} мес. назад`, `<b>${fmtNum(kb.seg.active)} чел. · ${fmtPct(kb.activeBasePct)}</b>`)}
      ${metricRow(`В группе риска: не были ${pr.activeM}–${fmtNum(riskUntilM, 1)} мес.`, `<b style="color:var(--warn)">${fmtNum(kb.seg.risk)} чел.</b>`)}
      ${metricRow(`Спящая: не были ${fmtNum(riskUntilM, 1)}–${pr.riskM} мес.`, fmtNum(kb.seg.sleep) + " чел.")}
      ${metricRow(`Потерянная: не были >${pr.riskM} мес.`, `<b style="color:var(--bad)">${fmtNum(kb.seg.lost)} чел.${kb.sourceWindowComplete ? ` · ${fmtPct(kb.lostPct)}` : " минимум · доля н/д"}</b>`, `порог начинается с ${fmtNum(lostFromDay)}-го дня; ${kb.sourceWindowComplete ? `использовано достаточное окно ${kb.window} мес.` : `нужна выгрузка минимум за ${kb.requiredWindowM} мес.`}`)}
      ${metricRow(`Лояльные: ≥${pr.minVisits} визитов`, `${fmtNum(kb.loyalCount)} чел. · ${fmtPct(kb.loyalPct)}`, "отдельный признак, не определяет статус активности")}
      ${kb.seg.unknown ? metricRow("Без данных о давности", `${fmtNum(kb.seg.unknown)} чел.`, "не включены искусственно в активную базу") : ""}
      ${metricRow("Выручка под риском возврата", `<b>${fmtMoney(kb.revenueAtRisk)}</b>`, "исторические покупки пациентов в группах риска, спящей и потерянной")}
      ${metricRow("База для реактивации", `<b>${fmtNum(kb.reactivationCandidates)} чел. · ${fmtMoney(kb.reactivationSum)}</b>`, "группы риска и спящая; приоритетный список для регистратуры")}
      ${metricRow("Выручка от потерянных", fmtMoney(kb.lostSum), `сумма покупок этих ${fmtNum(kb.seg.lost)} чел. за ${kb.window} мес`)}
      ${metricRow(`Ядро базы: пациенты, давшие ${pr.corePct}% выручки (ABC)`, fmtNum(kb.core) + " чел.")}
      ${r.akb.churn36 != null ? metricRow(`Отток: потерянные от всей базы за 3 года`, fmtPct(r.akb.churn36)) : ""}
    </div>
    <div><h3 class="small muted" style="margin-bottom:6px">СЕГМЕНТЫ БАЗЫ ${copyBtn("copyChart", "chSegments", "PNG")}</h3>
      <div class="chart-box tall"><canvas id="chSegments"></canvas></div></div>
    </div>
    <div class="no-print" style="margin-top:14px"><details id="clientSegmentPatients" ${collapsibleListAttrs("clientSegmentPatients")}><summary class="collapsible-list-summary"><span>ПАЦИЕНТЫ ПО СЕГМЕНТУ <span class="badge mut" id="clientSegmentPatientCount">${fmtNum(selectedClients.length)}</span></span><span class="collapse-hint"></span></summary>
      <div class="collapsible-list-body"><div class="vhead"><span class="small muted">Выберите сегмент базы</span>${segToggle("clientSegmentSeg", segmentOptions, UI.clientSegment, "setClientSegment")}</div>
      <div style="overflow-x:auto;margin-top:8px"><table class="data" id="tblClientSegment"><thead><tr><th>Пациент</th><th>Признак</th><th class="num">Визитов</th><th class="num">Дней с визита</th><th class="num">Историческая выручка</th></tr></thead><tbody id="clientSegmentRows">${clientSegmentRowsMarkup(selectedClients)}</tbody>
      </table><p class="small muted" id="clientSegmentLimitNote" ${selectedClients.length > 250 ? "" : "hidden"}>${clientSegmentLimitMarkup(selectedClients)}</p></div></div></details></div>
    </div>`;
  }

  /* ---- В5 Лояльность ---- */
  const L = r.loyalty;
  const pvCur = L.pvSlices[UI.pvSlice] ? UI.pvSlice : (L.slices.find(s => L.pvSlices[s]) || null);
  const pv = pvCur != null ? L.pvSlices[pvCur] : null;
  const B5 = docProfile.scoring.benchmarks;
  const schedValue = L.sched ? L.sched.pct : null;
  const ownRecValue = L.ownRec ? L.ownRec.pct : null;
  const courseValue = L.courseIdx;
  const freqValue = L.freq12;
  const pvValue = pv ? pv.pct : null;
  const schedDyn = doctorMetricDynamics(UI.docId, mk, rr => rr.loyalty.sched ? rr.loyalty.sched.pct : null);
  const ownRecDyn = doctorMetricDynamics(UI.docId, mk, rr => rr.loyalty.ownRec ? rr.loyalty.ownRec.pct : null);
  const courseDyn = doctorMetricDynamics(UI.docId, mk, rr => rr.loyalty.courseWin === L.courseWin ? rr.loyalty.courseIdx : null);
  const freqDyn = doctorMetricDynamics(UI.docId, mk, rr => rr.loyalty.freq12);
  const pvDyn = doctorMetricDynamics(UI.docId, mk, rr => pvCur != null && rr.loyalty.pvSlices[pvCur] ? rr.loyalty.pvSlices[pvCur].pct : null);
  html += `<div class="card vector-card" id="blkV5" style="border-top-color:${VECTOR_META.v5.color}">
    <div class="vhead"><h3 class="mt0">Вектор 5. Лояльность и удержание <span class="badge ${VECTOR_META.v5.cls}">${VECTOR_META.v5.tag}</span></h3>
    <span>${vecBadge("v5", r, docProfile)} ${blockBtn("blkV5")} ${L.slices.length ? segToggle("pvSeg", L.slices.map(s => ({ v: s, label: "первичка " + s + " мес" })), pvCur, "setPvSlice") : ""}</span></div>
    <div class="metric-highlights">
      ${metricHighlight("Загрузка расписания", fmtPct(schedValue), L.sched ? `записано ${minToHours(L.sched.busyMin)} из ${minToHours(L.sched.normaMin)} по графику` : "нет выгрузки «Загрузка расписания»", trackedMetricState(schedValue, B5.schedLoad), metricGoalText(B5.schedLoad, fmtPct), metricHistoryMarkup(schedValue, schedDyn, "pp", "", 1, fmtPct))}
      ${metricHighlight("Собственная запись в 1С", fmtPct(ownRecValue), L.ownRec ? (r.traffic.visits ? `${fmtNum(L.ownRec.count)} собственных записей / ${fmtNum(r.traffic.visits)} всех визитов за месяц × 100%` : "выгрузка записей есть, но нет общего количества визитов за месяц") : `нет выгрузки «Записи в 1С» за ${monthLabel(mk)}; значения ниже относятся к другим месяцам`, trackedMetricState(ownRecValue, B5.ownRecords), metricGoalText(B5.ownRecords, fmtPct), metricHistoryMarkup(ownRecValue, ownRecDyn, "pp", "", 1, fmtPct))}
      ${metricHighlight(`Курсовое лечение: ≥${L.courseX} виз. за ${L.courseM} мес.`, fmtPct(courseValue), courseValue != null ? `${fmtNum(L.courseCnt)} чел. · точное окно ${L.courseM} мес.` : `нужна выгрузка «Давности» ровно за ${L.courseM} мес.`, trackedMetricState(courseValue, B5.courseIdx), metricGoalText(B5.courseIdx, fmtPct), metricHistoryMarkup(courseValue, courseDyn, "pp", "", 1, fmtPct))}
      ${metricHighlight("Индекс возвращаемости за 12 мес.", freqValue != null ? fmtNum(freqValue, 2) : "—", "визитов на пациента", trackedMetricState(freqValue, null), metricGoalText(null, fmtNum), metricHistoryMarkup(freqValue, freqDyn, "absolute", "", 2, v => fmtNum(v, 2)))}
      ${metricHighlight(`Возвращаемость первички (${pvCur != null ? pvCur : "—"} мес.)`, fmtPct(pvValue), pv ? (pv.valid === false ? `ошибка данных: ${pv.issue}` : `первичных: ${fmtNum(pv.first)}, вернулось: ${fmtNum(pv.ret)}, не вернулось: ${fmtNum(pv.notRet)}`) : "нет выгрузки первички", trackedMetricState(pvValue, B5.pervichka), metricGoalText(B5.pervichka, fmtPct), metricHistoryMarkup(pvValue, pvDyn, "pp", "", 1, fmtPct))}
    </div></div>`;

  /* ---- В6 Репутация ---- */
  const man6 = r.extras.man6 || {};
  const B6 = docProfile.scoring.benchmarks;
  const ratingValue = r.rep ? r.rep.avgRating : null;
  const npsValue = r.rep ? r.rep.nps : null;
  const reviewsValue = r.rep ? r.rep.reviews : null;
  const ratingDyn = doctorMetricDynamics(UI.docId, mk, rr => rr.rep ? rr.rep.avgRating : null);
  const npsDyn = doctorMetricDynamics(UI.docId, mk, rr => rr.rep ? rr.rep.nps : null);
  const reviewsDyn = doctorMetricDynamics(UI.docId, mk, rr => rr.rep ? rr.rep.reviews : null);
  const inp = (id, val, step, max, min = 0) => `<input type="number" id="m6_${id}" value="${val != null ? val : ""}" min="${min}" ${max != null ? `max="${max}"` : ""} step="${step}" style="width:90px">`;
  html += `<div class="card vector-card" id="blkV6" style="border-top-color:${VECTOR_META.v6.color}">
    <div class="vhead"><h3 class="mt0">Вектор 6. Репутация и NPS <span class="badge ${VECTOR_META.v6.cls}">${VECTOR_META.v6.tag}</span></h3>
    <span>${vecBadge("v6", r, docProfile)} ${blockBtn("blkV6")} ${r.rep && r.rep.avgRating != null ? `<span class="vscore">${fmtNum(r.rep.avgRating, 2)} ★</span>` : ""}</span></div>
    <div class="metric-highlights">
      ${metricHighlight("Средний рейтинг площадок", ratingValue != null ? fmtNum(ratingValue, 2) + " ★" : "—", "среднее по заполненным площадкам", trackedMetricState(ratingValue, B6.rating), metricGoalText(B6.rating, v => fmtNum(v, 2) + " ★"), metricHistoryMarkup(ratingValue, ratingDyn, "absolute", " балла", 2, v => fmtNum(v, 2) + " ★"))}
      ${metricHighlight("NPS", fmtPct(npsValue), "индекс готовности рекомендовать", trackedMetricState(npsValue, B6.nps), metricGoalText(B6.nps, fmtPct), metricHistoryMarkup(npsValue, npsDyn, "pp", "", 1, fmtPct))}
      ${metricHighlight("Новые отзывы", reviewsValue != null ? fmtNum(reviewsValue) + " шт." : "—", "новые отзывы за выбранный месяц", trackedMetricState(reviewsValue, B6.reviews), metricGoalText(B6.reviews, v => fmtNum(v) + " шт."), metricHistoryMarkup(reviewsValue, reviewsDyn, "absolute", " шт.", 0, v => fmtNum(v) + " шт."))}
    </div>
    <h3 class="section-title no-print" style="margin:4px 0 8px">РУЧНОЙ ВВОД ПО ПЛОЩАДКАМ</h3>
    <div class="flex no-print" style="margin-top:8px">
      <label class="fld"><span>ПроДокторов (0–5)</span>${inp("prodoctorov", man6.prodoctorov, "0.1", 5)}</label>
      <label class="fld"><span>НаПоправку (0–5)</span>${inp("napopravku", man6.napopravku, "0.1", 5)}</label>
      <label class="fld"><span>DocTu (0–5)</span>${inp("doctu", man6.doctu, "0.1", 5)}</label>
      <label class="fld"><span>СберЗдоровье (0–5)</span>${inp("sberhealth", man6.sberhealth, "0.1", 5)}</label>
      <label class="fld"><span>NPS (−100…100)</span>${inp("nps", man6.nps, "1", 100, -100)}</label>
      <label class="fld"><span>Новых отзывов</span>${inp("reviews", man6.reviews, "1")}</label>
      <button class="btn primary" onclick="saveManual6()">Сохранить</button>
    </div></div>`;

  /* ---- выручка по месяцам: горизонтальная стековая ---- */
  html += `<div class="card" id="blkStack"><div class="vhead"><h3 class="mt0">Собственная выручка по категориям и выручка от перенаправлений</h3><span>${copyBtn("copyChart", "chStack", "PNG")} ${blockBtn("blkStack")}</span></div><div class="chart-box" style="height:${Math.max(200, 60 + monthKeysSorted().length * 44)}px"><canvas id="chStack"></canvas></div></div>`;

  /* ---- динамика: тренды, точки роста и риска ---- */
  const docDyn = computeDoctorDynamics(UI.docId, mk);
  if (docDyn && docDyn.months.length) {
    html += dynamicsHtml(docDyn, "blkDyn", "Динамика: точки роста и риска",
      `Последние ${docDyn.months.length} мес. по ${monthLabel(mk)}: последний месяц сравнивается с прошлым и со средним предыдущих месяцев; жирным — текущий месяц.`,
      `doctor|${mk}|${UI.docId}`);
    if (DB.settings.showScores && docDyn.months.length >= 2) {
      html += `<div id="chScoresWrap"><h3 class="small muted" style="margin:14px 0 6px">БАЛЛЫ ПО ВЕКТОРАМ ПО МЕСЯЦАМ ${copyBtn("copyChart", "chScores", "PNG")}</h3>
        ${scoreChartPicker("chScores")}
        <div class="chart-box score-chart"><canvas id="chScores"></canvas></div></div>`;
    }
    html += "</div>"; // закрываем карточку динамики
  }

  body.innerHTML = html;

  /* -------- графики -------- */
  const vy = r.extras.vy;
  if (vy && vy.ownSum > 0 && r.product) {
    const chartGroups = [...Object.keys(docProfile.groups)];
    for (const g of Object.keys(r.product.byGroup)) if (!chartGroups.includes(g)) chartGroups.push(g);
    const entries = chartGroups.map(g => [g, r.product.byGroup[g] ? r.product.byGroup[g].s : 0]).filter(x => x[1] > 0);
    chart("chRevStruct", {
      type: "doughnut",
      data: { labels: entries.map(x => x[0]), datasets: [{ data: entries.map(x => x[1]), backgroundColor: entries.map(x => groupColor(docProfile, x[0])) }] },
      options: {
        plugins: {
          legend: { position: "right" },
          datalabels: dlDoughnut(() => vy.ownSum),
          tooltip: { callbacks: { label: c => c.label + ": " + fmtMoney(c.raw) + " (" + fmtPct(c.raw / vy.ownSum * 100) + ")" } },
        },
        maintainAspectRatio: false,
      },
    });
    const exOrderAll = docProfile.expertise.items.map(d => d.name);
    for (const nm of Object.keys(r.product.expert || {})) if (!exOrderAll.includes(nm)) exOrderAll.push(nm);
    const devNames = exOrderAll.filter(nm => r.product.expert[nm]);
    if (devNames.length && docProfile.expertise.mode !== "none") {
      const devCols = devNames.map(nm => deviceColor(docProfile, nm)); // цвет закреплён за позицией на обеих диаграммах
      // штуки на графике — только у позиций с включённым «шт+₽» (редактор номенклатуры)
      const qtyNames = devNames.filter(nm => r.product.expert[nm].qShow > 0);
      chart("chDevices", {
        type: "doughnut",
        data: { labels: qtyNames, datasets: [{ data: qtyNames.map(nm => r.product.expert[nm].qShow), backgroundColor: qtyNames.map(nm => deviceColor(docProfile, nm)) }] },
        options: {
          plugins: {
            legend: { position: "right" },
            datalabels: {
              display: () => UI.showLabels,
              color: "#fff", font: { size: 11, weight: "700" },
              formatter: v => fmtNum(v),
            },
          },
          maintainAspectRatio: false,
        },
      });
      const devMoneyTotal = devNames.reduce((a, nm) => a + r.product.expert[nm].s, 0);
      chart("chDevicesMoney", {
        type: "doughnut",
        data: { labels: devNames, datasets: [{ data: devNames.map(nm => r.product.expert[nm].s), backgroundColor: devCols }] },
        options: {
          plugins: {
            legend: { position: "right" },
            datalabels: dlDoughnut(() => devMoneyTotal),
            tooltip: { callbacks: { label: c => c.label + ": " + fmtMoney(c.raw) + " (" + fmtPct(c.raw / (devMoneyTotal || 1) * 100) + ")" } },
          },
          maintainAspectRatio: false,
        },
      });
    }
  }
  // круговая структуры направлений (В5)
  if (r.cross.refByType && Object.keys(r.cross.refByType).length) {
    const refEntries = REF_TYPES.map(t => [t, r.cross.refByType[t] ? r.cross.refByType[t].s : 0]).filter(x => x[1] > 0);
    const refColors = { "Товары": "#db2777", "Приемы": "#d97706", "Анализы": "#0d9488", "Профильные услуги": "#2563eb", "Другие услуги клиники": "#94a3b8" };
    const refTotal = refEntries.reduce((a, x) => a + x[1], 0);
    chart("chNazStruct", {
      type: "doughnut",
      data: { labels: refEntries.map(x => x[0]), datasets: [{ data: refEntries.map(x => x[1]), backgroundColor: refEntries.map(x => refColors[x[0]]) }] },
      options: {
        plugins: {
          legend: { position: "right" },
          datalabels: dlDoughnut(() => refTotal),
          tooltip: { callbacks: { label: c => c.label + ": " + fmtMoney(c.raw) + " (" + fmtPct(c.raw / refTotal * 100) + ")" } },
        },
        maintainAspectRatio: false,
      },
    });
  }
  if (nz && nz.focus) {
    const focusOrder = (docProfile.crossFocus.items || []).map(item => item.name);
    for (const name of Object.keys(nz.focus.items)) if (!focusOrder.includes(name)) focusOrder.push(name);
    const focusQtyNames = focusOrder.filter(name => nz.focus.items[name] && nz.focus.items[name].soldQ > 0);
    const focusMoneyNames = focusOrder.filter(name => nz.focus.items[name] && nz.focus.items[name].soldSum > 0);
    if (focusQtyNames.length) {
      chart("chNazFocusQty", {
        type: "doughnut",
        data: { labels: focusQtyNames, datasets: [{ data: focusQtyNames.map(name => nz.focus.items[name].soldQ), backgroundColor: focusQtyNames.map(name => crossFocusColor(docProfile, name)) }] },
        options: {
          plugins: {
            legend: { position: "right" },
            datalabels: { display: () => UI.showLabels, color: "#fff", font: { size: 11, weight: "700" }, formatter: value => fmtNum(value) },
          },
          maintainAspectRatio: false,
        },
      });
    }
    if (focusMoneyNames.length) {
      chart("chNazFocusMoney", {
        type: "doughnut",
        data: { labels: focusMoneyNames, datasets: [{ data: focusMoneyNames.map(name => nz.focus.items[name].soldSum), backgroundColor: focusMoneyNames.map(name => crossFocusColor(docProfile, name)) }] },
        options: {
          plugins: {
            legend: { position: "right" },
            datalabels: dlDoughnut(() => nz.focus.soldSum),
            tooltip: { callbacks: { label: context => context.label + ": " + fmtMoney(context.raw) + " (" + fmtPct(context.raw / (nz.focus.soldSum || 1) * 100) + ")" } },
          },
          maintainAspectRatio: false,
        },
      });
    }
  }
  if (kb) {
    const segData = [
      ["Активная", kb.seg.active, "#16a34a"],
      ["В группе риска", kb.seg.risk, "#d97706"],
      ["Спящая", kb.seg.sleep, "#94a3b8"],
      [kb.sourceWindowComplete ? "Потерянная" : "Потерянная (минимум)", kb.seg.lost, "#dc2626"],
      ["Без давности", kb.seg.unknown, "#64748b"],
    ].filter(x => x[1] > 0);
    chart("chSegments", {
      type: "doughnut",
      data: { labels: segData.map(x => x[0]), datasets: [{ data: segData.map(x => x[1]), backgroundColor: segData.map(x => x[2]) }] },
      options: {
        plugins: {
          legend: { position: "right" },
          datalabels: dlDoughnut(() => kb.total),
        },
        maintainAspectRatio: false,
      },
    });
  }
  // стековая по месяцам (группы — из профиля отделения врача + сиротские)
  const keys = monthKeysSorted();
  const docGroups = [...Object.keys(docProfile.groups)];
  if (r.product) for (const g of Object.keys(r.product.byGroup)) if (!docGroups.includes(g)) docGroups.push(g);
  const dsMap = {};
  const refRevenueByMonth = [];
  for (const g of docGroups) dsMap[g] = [];
  for (const k of keys) {
    const vv = vyrabotkaSummary(UI.docId, k);
    refRevenueByMonth.push(vv && vv.refSum ? vv.refSum : 0);
    for (const g of docGroups) {
      dsMap[g].push(vv && vv.byGroup[g] ? vv.byGroup[g].s : 0);
    }
  }
  const monthTotals = keys.map((k, i) => docGroups.reduce((a, g) => a + (dsMap[g][i] || 0), 0));
  const maxTotal = Math.max(0, ...monthTotals);
  const maxRefRevenue = Math.max(0, ...refRevenueByMonth);
  const hasRefRevenue = refRevenueByMonth.some(v => v > 0);
  const refRevenueColor = "#334155";
  const revenueDatasets = docGroups.filter(g => dsMap[g].some(v => v > 0)).map(g => ({
    label: g, data: dsMap[g], backgroundColor: groupColor(docProfile, g), stack: "s", order: 1,
    borderColor: "#ffffff", borderWidth: 1, // разделители сегментов
  }));
  if (hasRefRevenue) revenueDatasets.push({
    type: "line",
    label: "Выручка от перенаправлений",
    data: refRevenueByMonth,
    xAxisID: "xRef",
    yAxisID: "y",
    borderColor: refRevenueColor,
    backgroundColor: refRevenueColor,
    pointBackgroundColor: "#ffffff",
    pointBorderColor: refRevenueColor,
    pointBorderWidth: 3,
    pointRadius: 5,
    pointHoverRadius: 7,
    borderWidth: 3,
    borderDash: [7, 4],
    tension: 0.25,
    fill: false,
    order: -10,
  });
  chart("chStack", {
    type: "bar",
    plugins: [stackTotalsPlugin],
    data: {
      labels: keys.map(monthLabel),
      datasets: revenueDatasets,
    },
    options: {
      indexAxis: "y",
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom" },
        datalabels: {
          display: ctx => {
            if (!UI.showLabels || ctx.dataset.data[ctx.dataIndex] <= 0) return false;
            if (ctx.dataset.type === "line") return true;
            const ownTotal = ctx.chart.data.datasets.filter(d => d.stack === "s").reduce((a, d) => a + (d.data[ctx.dataIndex] || 0), 0);
            return ctx.dataset.data[ctx.dataIndex] / (ownTotal || 1) > 0.055;
          },
          color: ctx => ctx.dataset.type === "line" ? refRevenueColor : "#fff",
          anchor: ctx => ctx.dataset.type === "line" ? "end" : "center",
          align: ctx => ctx.dataset.type === "line" ? "right" : "center",
          offset: ctx => ctx.dataset.type === "line" ? 5 : 0,
          font: { size: 11, weight: "700" },
          formatter: v => (v >= 1000000 ? (v / 1000000).toFixed(1) + " млн" : Math.round(v / 1000) + " т."),
        },
        tooltip: { callbacks: { label: c => c.dataset.label + ": " + fmtMoney(c.raw) } },
      },
      scales: {
        x: { stacked: true, suggestedMax: maxTotal * 1.18, ticks: { callback: v => (v / 1000000).toFixed(1) + " млн" }, title: { display: true, text: "Собственная выручка" } },
        ...(hasRefRevenue ? { xRef: { position: "top", beginAtZero: true, suggestedMax: maxRefRevenue * 1.18, grid: { drawOnChartArea: false }, ticks: { color: refRevenueColor, callback: v => (v / 1000000).toFixed(1) + " млн" }, title: { display: true, text: "Выручка от перенаправлений · отдельная шкала", color: refRevenueColor } } } : {}),
        y: { stacked: true },
      },
    },
  });
  // графики динамики + баллы по векторам
  if (docDyn.months.length >= 2) {
    renderDynCharts(docDyn, "blkDyn");
    if (DB.settings.showScores) {
      const rendered = renderScoresChart("chScores", docDyn.months,
        (k, vk) => { const rr = docDyn.results[k]; return rr && rr.scores ? rr.scores.vec[vk] : null; },
        k => { const rr = docDyn.results[k]; return rr && rr.scores ? rr.scores.total : null; });
      if (!rendered) document.getElementById("chScoresWrap")?.remove();
    }
  }
}

function saveManual6() {
  const mk = UI.docMonth, id = UI.docId;
  if (!mk || !id) return;
  const val = k => {
    const el = document.getElementById("m6_" + k);
    const v = parseFloat(el.value);
    return isNaN(v) ? null : v;
  };
  const rec = { prodoctorov: val("prodoctorov"), napopravku: val("napopravku"), doctu: val("doctu"), sberhealth: val("sberhealth"), nps: val("nps"), reviews: val("reviews") };
  const ratings = [rec.prodoctorov, rec.napopravku, rec.doctu, rec.sberhealth].filter(v => v != null);
  if (ratings.some(v => v < 0 || v > 5) || (rec.nps != null && (rec.nps < -100 || rec.nps > 100)) || (rec.reviews != null && rec.reviews < 0)) {
    toast("Проверьте диапазоны: рейтинги 0–5, NPS −100…100, отзывы ≥ 0", true);
    return;
  }
  const empty = Object.values(rec).every(v => v == null);
  ensureMonth(mk);
  if (empty) delete DB.months[mk].manual6[id];
  else DB.months[mk].manual6[id] = rec;
  saveLocal();
  toast(empty ? "Данные репутации очищены" : "Репутация сохранена");
  renderDoctor();
}

/* ================= СТРАНИЦА: ОТЧЁТ ================= */

function renderReport() {
  const months = monthKeysSorted();
  const mSel = document.getElementById("repMonth");
  const sSel = document.getElementById("repScope");
  const body = document.getElementById("reportBody");
  setControlsDisabled(["repMonth", "repScope", "btnExportAllPdf", "btnPrint"], !months.length);
  if (!months.length) {
    body.innerHTML = '<div class="card"><p class="muted">Загрузите данные на вкладке «Данные».</p></div>';
    mSel.innerHTML = ""; sSel.innerHTML = "";
    return;
  }
  if (!UI.repMonth || !DB.months[UI.repMonth]) UI.repMonth = months[months.length - 1];
  const mk = UI.repMonth;
  mSel.innerHTML = months.map(k => `<option value="${k}" ${k === mk ? "selected" : ""}>${monthLabel(k)}</option>`).join("");
  const core = coreDoctorsInMonth(mk).length ? coreDoctorsInMonth(mk) : doctorsInMonth(mk);
  sSel.innerHTML = `<option value="dept" ${UI.repScope === "dept" ? "selected" : ""}>Специализация целиком</option>` +
    core.map(id => `<option value="doc:${id}" ${UI.repScope === "doc:" + id ? "selected" : ""}>${esc(doctorName(id))}</option>`).join("");
  if (UI.repScope.startsWith("doc:") && !core.includes(UI.repScope.slice(4))) UI.repScope = "dept";
  body.innerHTML = UI.repScope === "dept" ? buildDeptReport(mk) : buildDoctorReport(UI.repScope.slice(4), mk);
}

function reportHeader(title, subtitle) {
  return `<div style="border-bottom:3px solid var(--accent);padding-bottom:10px;margin-bottom:14px">
    <h1 style="margin:0;font-size:22px">${title}</h1>
    <div class="muted">${subtitle} · отчёт сформирован ${new Date().toLocaleDateString("ru-RU")}</div></div>`;
}

function buildDeptReport(mk, deptFilter = UI.deptFilter, subFilter = UI.subFilter) {
  const { rows } = deptRows(mk, deptFilter, subFilter);
  if (!rows.length) return '<div class="card"><p class="muted">Нет данных за месяц.</p></div>';
  const showSc = DB.settings.showScores;
  const totalSales = rows.reduce((a, x) => a + (x.r.econ.sales || 0), 0);
  const totalRef = rows.reduce((a, x) => a + (x.r.econ.refRevenue || 0), 0);
  const scAvgArr = rows.map(x => x.r.scores && x.r.scores.rankEligible ? x.r.scores.total : null).filter(v => v != null);
  const scAvg = scAvgArr.length ? scAvgArr.reduce((a, b) => a + b, 0) / scAvgArr.length : null;
  const sub = monthLabel(mk) + (deptFilter !== "all" ? " · " + esc(deptFilter) : "");

  /* Слайд 1: итоги + сводная */
  let html = `<div class="card slide">${reportHeader("Отчёт по специализации", sub)}
    <div class="grid cols-4">
      <div class="kpi"><div class="lbl">Специалистов</div><div class="val">${rows.length}</div></div>
      ${showSc && scAvg != null ? `<div class="kpi"><div class="lbl">Средний балл</div><div class="val">${fmtNum(scAvg, 1)} / 100</div></div>` : ""}
      <div class="kpi"><div class="lbl">Выручка</div><div class="val" style="font-size:18px">${fmtMoney(totalSales)}</div></div>
      <div class="kpi"><div class="lbl">Выручка от перенаправлений</div><div class="val" style="font-size:18px">${fmtMoney(totalRef)}</div></div>
    </div>
    <table class="data" style="margin-top:12px"><tr><th>#</th><th>Специалист</th>${showSc ? '<th class="num">Балл</th>' : ""}<th class="num">Выручка</th><th class="num">С перенаправл.</th><th class="num">Ср. чек пациента</th><th class="num">Загрузка расписания</th><th class="num">Возвращаемость первички (${UI.pvSlice} мес.)</th><th class="num">Доля выручки от перенаправлений</th></tr>`;
  rows.forEach((x, i) => {
    const pv = x.r.loyalty.pvSlices[UI.pvSlice];
    html += `<tr><td class="muted">${i + 1}</td><td>${esc(doctorName(x.id))}</td>
      ${showSc ? `<td class="num">${x.r.scores && x.r.scores.total != null ? (x.r.scores.rankEligible ? fmtNum(x.r.scores.total, 0) : `${fmtNum(x.r.scores.total, 0)} · предв.`) : "—"}</td>` : ""}
      <td class="num">${fmtMoney(x.r.econ.sales)}</td><td class="num">${fmtMoney(x.r.econ.revenueWithRef)}</td><td class="num">${fmtMoney(x.r.econ.avgClient)}</td>
      <td class="num">${x.r.loyalty.sched ? fmtPct(x.r.loyalty.sched.pct) : "—"}</td>
      <td class="num">${pv ? fmtPct(pv.pct) : "—"}</td><td class="num">${fmtPct(x.r.cross.crossShare)}</td></tr>`;
  });
  html += "</table></div>";

  /* Слайд 2: баллы по векторам */
  if (showSc) {
    html += `<div class="card slide"><h2>Баллы по векторам · ${sub}</h2>
      <table class="data"><tr><th>Специалист</th>${["v1", "v2", "v3", "v4", "v5", "v6"].map(vk => `<th class="num" title="${VECTOR_META[vk].name}">В${vk[1]}</th>`).join("")}<th class="num">Общий</th></tr>`;
    for (const x of rows) {
      html += `<tr><td>${esc(doctorName(x.id))}</td>${["v1", "v2", "v3", "v4", "v5", "v6"].map(vk => `<td class="num">${x.r.scores && x.r.scores.vec[vk] != null ? fmtNum(x.r.scores.vec[vk], 0) : '<span class="muted">·</span>'}</td>`).join("")}<td class="num"><b>${x.r.scores && x.r.scores.total != null ? (x.r.scores.rankEligible ? fmtNum(x.r.scores.total, 0) : `${fmtNum(x.r.scores.total, 0)} · предв. (${fmtPct(x.r.scores.coveragePct)})`) : "—"}</b></td></tr>`;
    }
    html += `</table><p class="small muted">В1 Экономика · В2 Продукт · В3 Междисциплинарный · В4 База · В5 Лояльность · В6 Репутация. «·» — нет данных.</p></div>`;
  }

  /* Слайд 3: экономика и трафик */
  html += `<div class="card slide"><h2>Экономика и трафик · ${sub}</h2>
    <table class="data"><tr><th>Специалист</th><th class="num">Выручка</th><th class="num">От перенаправлений</th><th class="num">Чек пациента</th><th class="num">Чек посещения</th><th class="num">Визиты</th><th class="num">Пациенты</th><th class="num">Частота</th></tr>`;
  for (const x of rows) {
    html += `<tr><td>${esc(doctorName(x.id))}</td><td class="num">${fmtMoney(x.r.econ.sales)}</td><td class="num">${fmtMoney(x.r.econ.refRevenue)}</td>
      <td class="num">${fmtMoney(x.r.econ.avgClient)}</td><td class="num">${fmtMoney(x.r.econ.avgVisit)}</td>
      <td class="num">${fmtNum(x.r.traffic.visits)}</td><td class="num">${fmtNum(x.r.traffic.patients)}</td><td class="num">${x.r.traffic.freq != null ? fmtNum(x.r.traffic.freq, 2) : "—"}</td></tr>`;
  }
  html += "</table></div>";

  /* Слайд 4: продукт — аппараты */
  const withVy = rows.filter(x => x.r.product);
  if (withVy.length && deptFilter !== "all") {
    const fProfile = deptProfile(deptFilter);
    const devs = (fProfile.expertise.items || []).map(d => d.name);
    if (devs.length && fProfile.expertise.mode !== "none") {
      html += `<div class="card slide"><h2>${esc(fProfile.expertise.title)} (за месяц, шт) · ${sub}</h2>
        <table class="data"><tr><th>Специалист</th>${devs.map(d => `<th class="num">${esc(d)}</th>`).join("")}<th class="num">Широта</th><th class="num">Доля эксп. услуг</th></tr>`;
      for (const x of withVy) {
        html += `<tr><td>${esc(doctorName(x.id))}</td>${devs.map(dv => `<td class="num">${x.r.product.expert[dv] ? fmtNum(x.r.product.expert[dv].q) : "·"}</td>`).join("")}
          <td class="num">${x.r.product.devicesUsed} из ${x.r.product.park}</td><td class="num">${fmtPct(x.r.product.expertShare)}</td></tr>`;
      }
      html += "</table></div>";
    }
  } else if (withVy.length) {
    html += `<div class="card slide"><h2>Экспертность · ${sub}</h2>
      <table class="data"><tr><th>Специалист</th><th>Специализация</th><th class="num">Задействовано позиций</th><th class="num">Доля экспертных услуг</th></tr>`;
    for (const x of withVy) {
      html += `<tr><td>${esc(doctorName(x.id))}</td><td>${esc(doctorDept(x.id))}</td><td class="num">${x.r.product.park ? x.r.product.devicesUsed + " из " + x.r.product.park : "—"}</td><td class="num">${fmtPct(x.r.product.expertShare)}</td></tr>`;
    }
    html += "</table></div>";
  }

  /* Слайд 5: междисциплинарный */
  const withNaz = rows.filter(x => x.r.cross.naz[1] || x.r.cross.naz[3]);
  if (withNaz.length) {
    html += `<div class="card slide"><h2>Междисциплинарный подход · ${sub}</h2>
      <table class="data"><tr><th>Специалист</th><th class="num">Назначено</th><th class="num">Выполнено</th><th class="num">Продано</th><th class="num">Конверсия</th><th class="num">Фокусы</th><th class="num">Доля выручки фокусов</th><th class="num">Выручка от перенаправлений</th><th class="num">Доля выручки от перенаправлений</th></tr>`;
    for (const x of withNaz) {
      const nz = x.r.cross.naz[1] || x.r.cross.naz[3];
      html += `<tr><td>${esc(doctorName(x.id))} <span class="small muted">(${nz.slice} мес)</span></td>
        <td class="num">${fmtNum(nz.totals.assigned)}</td><td class="num">${fmtNum(nz.totals.done)}</td><td class="num">${fmtNum(nz.totals.soldQ)}</td>
        <td class="num"><b>${nz.totals.conv != null ? fmtPct(nz.totals.conv) : "—"}</b></td><td class="num">${nz.focus ? `${nz.focus.used} из ${nz.focus.park}` : "—"}</td><td class="num">${nz.focus ? fmtPct(nz.focus.revenueShare) : "—"}</td>
        <td class="num">${fmtMoney(x.r.econ.refRevenue)}</td><td class="num">${fmtPct(x.r.cross.crossShare)}</td></tr>`;
    }
    html += "</table></div>";
  }

  /* Слайд 6: клиентская база */
  const withKb = rows.map(x => ({ ...x, kb: selectedClientBaseSummary(x.r, profileForDoctor(x.id)), baseProfile: profileForDoctor(x.id) })).filter(x => x.kb);
  if (withKb.length) {
    html += `<div class="card slide"><h2>Клиентская база по настройкам специализаций · ${sub}</h2><table class="data"><tr><th>Специалист</th><th>Порог / окно</th><th class="num">База</th><th class="num">Активная база</th><th class="num">Риск</th><th class="num">Спящая</th><th class="num">Потерянные</th><th class="num">Выручка под риском</th><th class="num">Ядро</th><th class="num">Отток (3 г.)</th></tr>`;
    for (const x of withKb) {
      const kb = x.kb, p = x.baseProfile;
      html += `<tr><td>${esc(doctorName(x.id))}</td><td class="small">&gt;${fmtNum(p.riskM, 1)} мес. / ${fmtNum(kb.window)} мес.${kb.sourceWindowComplete ? "" : " (неполное)"}</td><td class="num">${fmtNum(kb.total)}</td>
        <td class="num">${fmtNum(kb.seg.active)} (${fmtPct(kb.activeBasePct)})</td>
        <td class="num">${fmtNum(kb.seg.risk)}</td>
        <td class="num">${fmtNum(kb.seg.sleep)}</td><td class="num">${kb.sourceWindowComplete ? "" : "≥"}${fmtNum(kb.seg.lost)}</td><td class="num">${fmtMoney(kb.revenueAtRisk)}</td>
        <td class="num">${fmtNum(kb.core)}</td><td class="num">${x.r.akb.churn36 != null ? fmtPct(x.r.akb.churn36) : "—"}</td></tr>`;
    }
    html += "</table></div>";
  }

  /* Слайд 7: лояльность */
  html += `<div class="card slide"><h2>Лояльность и удержание · ${sub}</h2>
    <table class="data"><tr><th>Специалист</th><th class="num">Загрузка расписания</th><th class="num">Часы (записано / график)</th><th class="num">Возвращаемость первички (${UI.pvSlice} мес.)</th><th class="num">Собственная запись в 1С</th><th class="num">Курсовое</th></tr>`;
  for (const x of rows) {
    const s = x.r.loyalty.sched, pv = x.r.loyalty.pvSlices[UI.pvSlice], or = x.r.loyalty.ownRec;
    html += `<tr><td>${esc(doctorName(x.id))}</td><td class="num">${s ? fmtPct(s.pct) : "—"}</td>
      <td class="num">${s && s.busyMin != null ? minToHours(s.busyMin) + " / " + minToHours(s.normaMin) : "—"}</td>
      <td class="num">${pv ? fmtPct(pv.pct) : "—"}</td>
      <td class="num">${or && or.pct != null ? fmtPct(or.pct) : "—"}</td>
      <td class="num">${fmtPct(x.r.loyalty.courseIdx)}</td></tr>`;
  }
  html += "</table></div>";

  /* Слайд 8: динамика отделения */
  const dyn = computeDeptDynamics(mk, deptFilter, subFilter);
  if (dyn && dyn.months.length >= 2) {
    html += `<div class="card slide"><h2>Динамика: точки роста и риска · ${sub}</h2>
      <div class="grid cols-2" style="margin-bottom:12px">
        <div style="border-left:3px solid var(--good);padding-left:12px"><h3 style="color:var(--good)">Точки роста</h3>
          ${dyn.growth.length ? dyn.growth.slice(0, 8).map(x => `<div class="metric-row"><span class="mname">${esc(x.name)}</span><span class="mval">${x.fmt(x.cur)} ${deltaCell(x)}</span></div>`).join("") : '<p class="muted small">нет улучшений ≥ 5%</p>'}
        </div>
        <div style="border-left:3px solid var(--bad);padding-left:12px"><h3 style="color:var(--bad)">Точки риска</h3>
          ${dyn.risk.length ? dyn.risk.slice(0, 8).map(x => `<div class="metric-row"><span class="mname">${esc(x.name)}${x.belowTarget ? ' <span class="badge bad">ниже цели</span>' : ""}</span><span class="mval">${x.fmt(x.cur)} ${deltaCell(x)}</span></div>`).join("") : '<p class="muted small">нет ухудшений ≥ 5% — отлично!</p>'}
        </div>
      </div>
      <table class="data"><tr><th>Метрика</th>${dyn.months.map(k => `<th class="num">${monthLabel(k)}</th>`).join("")}<th class="num">Δ</th></tr>`;
    for (const row of dyn.rows) {
      html += `<tr><td>${esc(row.name)}</td>${row.values.map((v, i) => `<td class="num${i === row.values.length - 1 ? '" style="font-weight:700' : ""}">${v != null ? row.fmt(v) : "·"}</td>`).join("")}<td class="num">${deltaCell(row)}</td></tr>`;
    }
    html += "</table></div>";
  }
  return html;
}

function buildDoctorReport(docId, mk) {
  const r = computeMetrics(docId, mk);
  if (!r) return '<div class="card"><p class="muted">Нет данных.</p></div>';
  const e = r.econ;
  const reportProfile = profileForDoctor(docId);
  const reportNaz = r.cross.naz[UI.nazSlice] || r.cross.naz[1] || r.cross.naz[3];
  let html = `<div class="card slide">${reportHeader(esc(doctorName(docId)), monthLabel(mk) + " · " + esc(doctorStructureLabel(docId)))}
    <div class="grid cols-4">
      ${DB.settings.showScores && r.scores && r.scores.total != null ? `<div class="kpi"><div class="lbl">${r.scores.rankEligible ? "Общий балл" : "Предварительный балл"}</div><div class="val" style="font-size:17px">${fmtNum(r.scores.total, 0)} / 100</div><div class="sub">полнота ${fmtPct(r.scores.coveragePct)}</div></div>` : ""}
      <div class="kpi"><div class="lbl">Выручка</div><div class="val" style="font-size:17px">${fmtMoney(e.sales)}</div></div>
      <div class="kpi"><div class="lbl">С перенаправлениями</div><div class="val" style="font-size:17px">${fmtMoney(e.revenueWithRef)}</div></div>
      <div class="kpi"><div class="lbl">Ср. чек пациента</div><div class="val" style="font-size:17px">${fmtMoney(e.avgClient)}</div></div>
      <div class="kpi"><div class="lbl">Визиты / пациенты</div><div class="val" style="font-size:17px">${fmtNum(r.traffic.visits)} / ${fmtNum(r.traffic.patients)}</div></div>
    </div>
    ${doctorGoalsSummaryHtml(docId, reportProfile, false)}
    <div class="grid cols-2" style="margin-top:12px"><div>
      ${metricRow("Загрузка расписания", r.loyalty.sched ? fmtPct(r.loyalty.sched.pct) : "—")}
      ${metricRow("Средний чек посещения", fmtMoney(e.avgVisit))}
      ${metricRow("Чек к прошлому месяцу", e.dynPrev != null ? fmtNum(e.dynPrev, 1) + "%" : "—")}
      ${metricRow("Собственная запись в 1С", r.loyalty.ownRec && r.loyalty.ownRec.pct != null ? fmtPct(r.loyalty.ownRec.pct) : "—")}
      ${metricRow("Курсовое лечение", fmtPct(r.loyalty.courseIdx))}
    </div><div>`;
  for (const s of r.loyalty.slices) {
    const d = r.loyalty.pvSlices[s];
    if (d) html += metricRow(`Первичка, срез ${s} мес`, fmtPct(d.pct), `${fmtNum(d.ret)} из ${fmtNum(d.first)}`);
  }
  html += `${metricRow("Доля выручки от перенаправлений", fmtPct(r.cross.crossShare))}
    ${r.cross.naz[1] ? metricRow("Конверсия назначений (1 мес)", fmtPct(r.cross.naz[1].totals.conv)) : ""}
    ${r.cross.naz[3] ? metricRow("Конверсия назначений (3 мес)", fmtPct(r.cross.naz[3].totals.conv)) : ""}
    ${reportNaz && reportNaz.focus ? metricRow("Фокусы назначений", `${reportNaz.focus.used} из ${reportNaz.focus.park}`, `доля выручки ${fmtPct(reportNaz.focus.revenueShare)}`) : ""}
    </div></div>
    ${r.partial ? `<p class="small muted" style="margin-top:10px">⚠ Не загружено: ${esc(r.missing.join(", "))}.</p>` : ""}</div>`;

  // категории выручки
  if (r.product) {
    const totalOwn = r.extras.vy.ownSum || 1;
    const repProfile = reportProfile;
    html += `<div class="card slide"><h2>Структура выручки · ${esc(doctorName(docId))} · ${monthLabel(mk)}</h2>
      <table class="data"><tr><th>Категория</th><th class="num">Кол-во</th><th class="num">Сумма</th><th class="num">Доля</th></tr>`;
    for (const g of Object.keys(repProfile.groups)) {
      const gd = r.product.byGroup[g];
      if (!gd || (!gd.s && !gd.q)) continue;
      html += `<tr><td><b>${g}</b></td><td class="num">${fmtNum(gd.q)}</td><td class="num">${fmtMoney(gd.s)}</td><td class="num">${fmtPct(gd.s / totalOwn * 100)}</td></tr>`;
      for (const [sub, sd] of Object.entries(gd.subs).sort((a, b) => b[1].s - a[1].s)) {
        if (sub === "—" || (!sd.s && !sd.q)) continue;
        html += `<tr><td class="small muted" style="padding-left:22px">${esc(sub)}</td><td class="num small muted">${fmtNum(sd.q)}</td><td class="num small muted">${fmtMoney(sd.s)}</td><td class="num small muted">${fmtPct(sd.s / totalOwn * 100)}</td></tr>`;
      }
    }
    html += `</table></div>`;
  }
  // назначения
  const nz = r.cross.naz[UI.nazSlice] || r.cross.naz[1] || r.cross.naz[3];
  if (nz) {
    html += `<div class="card slide"><h2>Назначения и направления (${nz.slice} мес) · ${monthLabel(mk)}</h2>
      <table class="data"><tr><th>Тип</th><th class="num">Назначено</th><th class="num">Выполнено</th><th class="num">Продано</th><th class="num">Выручка</th><th class="num">Конверсия</th></tr>`;
    for (const t of REF_TYPES) {
      const b = nz.byType[t];
      if (!b || (b.assigned === 0 && b.done === 0 && b.soldQ === 0)) continue;
      html += `<tr><td>${esc(t)}</td><td class="num">${fmtNum(b.assigned)}</td><td class="num">${fmtNum(b.done)}</td><td class="num">${fmtNum(b.soldQ)}</td><td class="num">${fmtMoney(b.soldSum)}</td><td class="num">${b.conv != null ? fmtPct(b.conv) : "—"}</td></tr>`;
    }
    html += `<tr><td><b>Итого</b></td><td class="num"><b>${fmtNum(nz.totals.assigned)}</b></td><td class="num"><b>${fmtNum(nz.totals.done)}</b></td><td class="num"><b>${fmtNum(nz.totals.soldQ)}</b></td><td class="num"><b>${fmtMoney(nz.totals.soldSum)}</b></td><td class="num"><b>${nz.totals.conv != null ? fmtPct(nz.totals.conv) : "—"}</b></td></tr></table>`;
    if (nz.focus) {
      const focusNames = (reportProfile.crossFocus.items || []).map(item => item.name).filter(name => nz.focus.items[name]);
      html += `<h3 style="margin-top:14px">${esc(nz.focus.title)} · проданные позиции</h3><table class="data"><tr><th>Фокус</th><th class="num">Штук</th><th class="num">Выручка</th></tr>
        ${focusNames.map(name => `<tr><td>${esc(name)}</td><td class="num">${fmtNum(nz.focus.items[name].soldQ)}</td><td class="num">${fmtMoney(nz.focus.items[name].soldSum)}</td></tr>`).join("")}
        <tr><td><b>Итого · ${nz.focus.used} из ${nz.focus.park} фокусов</b></td><td class="num"><b>${fmtNum(nz.focus.soldQ)}</b></td><td class="num"><b>${fmtMoney(nz.focus.soldSum)} · ${fmtPct(nz.focus.revenueShare)}</b></td></tr></table>`;
    }
    html += `</div>`;
  }
  // динамика: точки роста и риска
  const repDyn = computeDoctorDynamics(docId, mk);
  if (repDyn && repDyn.months.length >= 2) {
    html += `<div class="card slide"><h2>Динамика: точки роста и риска · ${esc(doctorName(docId))}</h2>
      <div class="grid cols-2" style="margin-bottom:12px">
        <div style="border-left:3px solid var(--good);padding-left:12px"><h3 style="color:var(--good)">Точки роста</h3>
          ${repDyn.growth.length ? repDyn.growth.slice(0, 8).map(x => `<div class="metric-row"><span class="mname">${esc(x.name)}</span><span class="mval">${x.fmt(x.cur)} ${deltaCell(x)}</span></div>`).join("") : '<p class="muted small">нет улучшений ≥ 5%</p>'}
        </div>
        <div style="border-left:3px solid var(--bad);padding-left:12px"><h3 style="color:var(--bad)">Точки риска</h3>
          ${repDyn.risk.length ? repDyn.risk.slice(0, 8).map(x => `<div class="metric-row"><span class="mname">${esc(x.name)}${x.belowTarget ? ' <span class="badge bad">ниже цели</span>' : ""}</span><span class="mval">${x.fmt(x.cur)} ${deltaCell(x)}</span></div>`).join("") : '<p class="muted small">нет ухудшений ≥ 5% — отлично!</p>'}
        </div>
      </div>
      <table class="data"><tr><th>Метрика</th>${repDyn.months.map(k => `<th class="num">${monthLabel(k)}</th>`).join("")}<th class="num">Δ</th></tr>`;
    for (const row of repDyn.rows) {
      html += `<tr><td>${esc(row.name)}</td>${row.values.map((v, i) => `<td class="num${i === row.values.length - 1 ? '" style="font-weight:700' : ""}">${v != null ? row.fmt(v) : "·"}</td>`).join("")}<td class="num">${deltaCell(row)}</td></tr>`;
    }
    html += "</table></div>";
  }
  return html;
}

/* ================= СТРАНИЦА: НАСТРОЙКИ ================= */

function curSetDepartment() {
  const groups = departmentGroups();
  const names = Object.keys(groups);
  if (!UI.setDepartment || !groups[UI.setDepartment]) {
    const withData = new Set();
    for (const m of Object.values(DB.months)) {
      for (const id of Object.keys(m.vyrabotka || {})) withData.add(resolvedDepartmentName(id));
    }
    UI.setDepartment = names.find(name => withData.has(name)) || names[0];
    UI.setSpecialization = "";
  }
  return UI.setDepartment;
}

function curSetSpecialization() {
  const departmentName = curSetDepartment();
  if (!departmentUsesSpecializations(departmentName)) return "";
  const specs = departmentGroups()[departmentName] || [];
  if (UI.setSpecialization && !specs.includes(UI.setSpecialization)) UI.setSpecialization = "";
  return UI.setSpecialization || "";
}

/* Историческое имя: ключ текущего настраиваемого профиля. */
function curSetDept() {
  return curSetSpecialization() || curSetDepartment();
}

function curSetProfile() {
  const specializationName = curSetSpecialization();
  if (specializationName) return DB.settings.depts[specializationName];
  return DB.settings.departmentProfiles[curSetDepartment()];
}

function curSetProfileKind() {
  return curSetSpecialization() ? "специализации" : "отделения";
}

function selectSettingsStructure(departmentName, specializationName = "") {
  UI.setDepartment = departmentName;
  UI.setSpecialization = specializationName;
  renderSettings();
}

function doctorStructureDragCard(doctorId) {
  const personalGoal = DB.doctors[doctorId] && DB.doctors[doctorId].metricSettings ? " 🎯" : "";
  return `<span class="doctor-drag-card" draggable="true"
    ondragstart="startDoctorStructureDrag(event, ${esc(JSON.stringify(doctorId))})"
    ondragend="finishDoctorStructureDrag(event)"
    title="Перетащите врача в нужную специализацию">⠿ ${esc(doctorName(doctorId))}${personalGoal}</span>`;
}

function doctorStructureDragList(doctorIds, emptyText = "Перетащите врача сюда") {
  return `<div class="clinic-tree-doctors ${doctorIds.length ? "" : "empty"}">${doctorIds.length
    ? doctorIds.map(doctorStructureDragCard).join("")
    : `<span class="clinic-drop-hint">${esc(emptyText)}</span>`}</div>`;
}

function startDoctorStructureDrag(event, doctorId) {
  if (!DB.doctors[doctorId]) return;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", doctorId);
  event.currentTarget.classList.add("dragging");
  document.body.classList.add("doctor-structure-dragging");
}

function finishDoctorStructureDrag(event) {
  if (event && event.currentTarget) event.currentTarget.classList.remove("dragging");
  document.body.classList.remove("doctor-structure-dragging");
  document.querySelectorAll(".clinic-drop-zone.drag-over").forEach(el => el.classList.remove("drag-over"));
}

function allowDoctorStructureDrop(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  event.currentTarget.classList.add("drag-over");
}

function leaveDoctorStructureDrop(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.classList.remove("drag-over");
}

function dropDoctorOnStructure(event, departmentName, specializationName = "") {
  event.preventDefault();
  event.stopPropagation();
  const doctorId = event.dataTransfer.getData("text/plain");
  const groups = departmentGroups();
  const targetSpecializations = groups[departmentName] || [];
  if (!DB.doctors[doctorId] || !groups[departmentName]) { finishDoctorStructureDrag(); return; }
  if (specializationName && (!departmentUsesSpecializations(departmentName) || !targetSpecializations.includes(specializationName))) {
    finishDoctorStructureDrag();
    toast("Эта специализация недоступна", true);
    return;
  }
  const doctor = DB.doctors[doctorId];
  doctor.department = departmentName;
  doctor.specialization = specializationName || null;
  doctor.structureManual = true;
  doctor.dept = null;
  const targetProfile = specializationName ? DB.settings.depts[specializationName] : departmentProfile(departmentName);
  if (!(targetProfile.subdivisions || []).includes(doctor.subdept)) doctor.subdept = null;
  UI.setDepartment = departmentName;
  UI.setSpecialization = specializationName || "";
  UI.setDoctor = doctorId;
  finishDoctorStructureDrag();
  saveLocal();
  toast(specializationName
    ? `${doctorName(doctorId)} → ${departmentName} / ${specializationName}`
    : `${doctorName(doctorId)} → ${departmentName} / Без специализации`);
  renderAll();
}

function openDoctorGoalSettings(doctorId) {
  if (!doctorId || !DB.doctors[doctorId]) return;
  UI.setDoctor = doctorId;
  if (!UI.setOpen) UI.setOpen = {};
  UI.setOpen.doctor = true;
  renderSettings();
  requestAnimationFrame(() => {
    const card = document.getElementById("doctorMetricSettingsCard");
    if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

/* блок «Пример заполнения» под структурным полем */
function fmtEx(example) {
  return `<div class="fmt-ex"><b>Пример заполнения:</b><pre>${esc(example)}</pre></div>`;
}

function scoringBenchmarkDefs(profile) {
  const title = profile.expertise && profile.expertise.title ? profile.expertise.title : "экспертных услуг";
  return [
    ["revenue", "Выручка, ₽/мес"], ["avgCheck", "Средний чек на пациента, ₽"],
    ["hwShare", `Доля «${title}», %`], ["crossShare", "Доля выручки от перенаправлений, %"],
    ["nazConv", "Конверсия назначений, %"],
    ...((profile.crossFocus && profile.crossFocus.items && profile.crossFocus.items.length) ? [["nazFocusShare", "Доля выручки фокусов назначений, %"]] : []),
    ["akbShare", "Активная база, %"],
    ["riskShare", "В зоне риска, % (ниже—лучше)"], ["churn", "Потерянные за 3 года, % (ниже—лучше)"],
    ["schedLoad", "Загрузка расписания, %"], ["pervichka", `Первичка ${profile.pervichkaM || 3} мес, %`],
    ["ownRecords", "Собственная запись в 1С, %"], ["courseIdx", "Курсовое лечение, %"],
    ["rating", "Рейтинг площадок (из 5)"], ["nps", "NPS, %"], ["reviews", "Отзывов в месяц, шт"],
  ];
}

function renderSettings() {
  const s = DB.settings;
  const departmentName = curSetDepartment();
  const specializationNames = departmentGroups()[departmentName] || [];
  const usesSpecializations = departmentUsesSpecializations(departmentName);
  const specializationName = curSetSpecialization();
  const dn = curSetDept();
  const p = curSetProfile();
  const profileCaption = specializationName
    ? `специализация «${specializationName}» внутри отделения «${departmentName}»`
    : `отделение «${departmentName}»`;
  const departmentNames = Object.keys(departmentGroups());
  const allDoctorIds = Object.keys(DB.doctors).sort((a, b) => doctorName(a).localeCompare(doctorName(b), "ru"));
  if (!UI.setDoctor || !DB.doctors[UI.setDoctor]) UI.setDoctor = allDoctorIds[0] || null;
  const movableSpecializations = Object.keys(s.depts).filter(name => name !== "По умолчанию" && !specializationNames.includes(name));
  let structureTree = departmentNames.map(depName => {
    const specs = departmentGroups()[depName] || [];
    const depDoctors = allDoctorIds.filter(id => resolvedDepartmentName(id) === depName);
    const directDoctors = depDoctors.filter(id => !resolvedSpecializationName(id));
    const specRows = specs.map(specName => {
      const doctors = depDoctors.filter(id => resolvedSpecializationName(id) === specName);
      const selected = depName === departmentName && specName === specializationName;
      return `<div class="clinic-tree-spec clinic-drop-zone ${selected ? "selected" : ""}"
        ondragover="allowDoctorStructureDrop(event)" ondragleave="leaveDoctorStructureDrop(event)"
        ondrop="dropDoctorOnStructure(event, ${esc(JSON.stringify(depName))}, ${esc(JSON.stringify(specName))})">
        <div class="clinic-tree-spec-content"><b>↳ ${esc(specName)}</b><span class="badge mut">${doctors.length}</span>${doctorStructureDragList(doctors)}</div>
        <button class="btn mini" onclick="selectSettingsStructure(${esc(JSON.stringify(depName))}, ${esc(JSON.stringify(specName))})">Настроить</button>
      </div>`;
    }).join("");
    const directRow = `<div class="clinic-tree-spec clinic-drop-zone clinic-tree-direct"
      ondragover="allowDoctorStructureDrop(event)" ondragleave="leaveDoctorStructureDrop(event)"
      ondrop="dropDoctorOnStructure(event, ${esc(JSON.stringify(depName))}, &quot;&quot;)">
      <div class="clinic-tree-spec-content"><b>↳ Без специализации</b><span class="badge ${directDoctors.length ? "warn" : "mut"}">${directDoctors.length}</span>${doctorStructureDragList(directDoctors)}</div>
    </div>`;
    return `<div class="clinic-tree-department ${depName === departmentName && !specializationName ? "selected" : ""}">
      <div class="clinic-tree-head"><div><b>${esc(depName)}</b><span class="badge info">${depDoctors.length} врачей</span></div><button class="btn mini" onclick="selectSettingsStructure(${esc(JSON.stringify(depName))}, &quot;&quot;)">Настроить отделение</button></div>
      ${specRows}${directRow}
    </div>`;
  }).join("");
  const unassignedDoctors = allDoctorIds.filter(id => !departmentGroups()[resolvedDepartmentName(id)]);
  if (unassignedDoctors.length) {
    structureTree += `<div class="clinic-tree-department clinic-tree-unassigned"><div class="clinic-tree-head"><div><b>Не распределено</b><span class="badge warn">${unassignedDoctors.length}</span>${doctorStructureDragList(unassignedDoctors, "Нет врачей")}</div></div></div>`;
  }
  let html = "";
  // состояние «свёрнуто/развёрнуто» секций настроек — переживает перерисовку
  if (!UI.setOpen) UI.setOpen = { norm: false, expert: false, nom: false, score: false, doctor: true, rules: false };
  // атрибуты для схлопывающейся секции: data-ключ + запоминание при переключении
  const det = key => `data-sk="${key}" ${UI.setOpen[key] ? "open" : ""} ontoggle="UI.setOpen['${key}']=this.open"`;

  /* --- иерархия отделение -> опциональные специализации --- */
  html += `<div class="card"><div class="vhead"><h2 class="mt0">🏥 Структура клиники</h2>
      <label class="small"><input type="checkbox" id="showScoresChk" onchange="DB.settings.showScores=this.checked;saveLocal();renderAll()" ${s.showScores ? "checked" : ""}> показывать баллы</label></div>
    <p class="small muted">Иерархия: клиника → отделение → специализация → врач. <b>Перетащите карточку врача</b> в нужную специализацию или в «Без специализации». Нормативы и веса задаются специализации; цели можно задать отделению, специализации или врачу.</p>
    <div class="toolbar">
      <label>Отделение: <select id="setDepartmentSel" onchange="UI.setDepartment=this.value;UI.setSpecialization='';renderSettings()">${departmentNames.map(n => `<option value="${esc(n)}" ${n === departmentName ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
      <input type="text" id="newDepartmentName" placeholder="новое отделение…" style="min-width:190px">
      <button class="btn" onclick="addDepartmentV4()">+ Добавить отделение</button>
      ${departmentNames.length > 1 ? `<button class="btn danger" onclick="removeDepartmentV4()">Удалить отделение</button>` : ""}
      <span class="spacer"></span>
      <button class="btn ${usesSpecializations ? "primary" : ""}" onclick="toggleDepartmentSpecializations()">${usesSpecializations ? "✓ Нужны специализации" : "Нужны специализации"}</button>
    </div>
    ${usesSpecializations ? `<div class="toolbar" style="margin-top:10px">
      <label>Настраивать: <select id="setSpecializationSel" onchange="UI.setSpecialization=this.value;renderSettings()">
        <option value="" ${!specializationName ? "selected" : ""}>отделение целиком (базовые настройки)</option>
        ${specializationNames.map(n => `<option value="${esc(n)}" ${n === specializationName ? "selected" : ""}>специализация: ${esc(n)}</option>`).join("")}
      </select></label>
      <input type="text" id="newSpecializationName" placeholder="новая специализация…" style="min-width:190px">
      <button class="btn" onclick="addSpecializationV4()">+ Добавить специализацию</button>
      ${specializationName ? `<button class="btn danger" onclick="removeSpecializationV4()">Удалить «${esc(specializationName)}»</button>` : ""}
      ${movableSpecializations.length ? `<span class="spacer"></span><label>Перенести существующую: <select id="moveSpecializationSel">${movableSpecializations.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("")}</select></label><button class="btn" onclick="moveSpecializationV4()">Перенести сюда</button>` : ""}
    </div>` : `<div class="notice blue" style="margin-top:10px">Специализации выключены: врачи временно используют резервный профиль отделения. Чтобы настраивать нормативы и веса, включите специализации.</div>`}
    <p class="small muted">Сейчас настраивается: <b>${esc(profileCaption)}</b>. Новая специализация получает стартовые нормативы и веса, а цели сначала наследует от отделения.</p>
    ${allDoctorIds.length ? `<div class="toolbar" style="margin-top:10px">
      <label>Врач: <select id="structureDoctorSel" onchange="UI.setDoctor=this.value">${allDoctorIds.map(id => `<option value="${esc(id)}" ${id === UI.setDoctor ? "selected" : ""}>${esc(doctorName(id))}</option>`).join("")}</select></label>
      <button class="btn" onclick="openDoctorGoalSettings(document.getElementById('structureDoctorSel').value)">Настроить цели врача</button>
    </div>` : ""}
    <div class="clinic-tree">${structureTree}</div>
  </div>`;

  /* --- 1. Нормативы и подразделения --- */
  if (specializationName) {
    html += `<details class="card" style="display:block" ${det("norm")}><summary style="cursor:pointer"><b>📐 Нормативы специализации: сегментация, курсовое, первичка — «${esc(specializationName)}»</b></summary>
    <table class="data wtable" style="margin-top:10px"><tr>
      <th class="num" title="Отдельный признак лояльности, не меняет статус активности">Лояльный: от, виз.</th>
      <th class="num" title="Ожидаемый срок возврата T: был не позднее — активный">Ожидаемый возврат T, мес.</th>
      <th class="num" title="После этого срока пациент считается потерянным; граница риска и сна рассчитывается посередине">Потерян после, мес.</th>
      <th class="num" title="Курсовое лечение: минимум визитов…">Курсовое: от, виз.</th>
      <th class="num" title="…за последние сколько месяцев">Курсовое: за, мес</th>
      <th class="num" title="Ядро базы: пациенты, дающие этот % выручки">Ядро: %</th>
      <th class="num" title="Какой срез первички идёт в балл и динамику (3/6/12)">Первичка: срез, мес</th></tr>
    <tr>
      <td class="num"><input type="number" id="np_minVisits" value="${p.minVisits}" min="2" max="20"></td>
      <td class="num"><input type="number" id="np_activeM" value="${p.activeM}" min="1" max="24"></td>
      <td class="num"><input type="number" id="np_riskM" value="${p.riskM}" min="2" max="36"></td>
      <td class="num"><input type="number" id="np_courseX" value="${p.courseX}" min="2" max="20"></td>
      <td class="num"><input type="number" id="np_courseM" value="${p.courseM}" min="1" max="36"></td>
      <td class="num"><input type="number" id="np_corePct" value="${p.corePct}" min="50" max="95"></td>
      <td class="num"><input type="number" id="np_pervichkaM" value="${p.pervichkaM || 3}" min="1" max="12"></td></tr></table>
    <p class="small muted">Статусы считаются по давности: активная ≤ T; риск — от T до середины между T и сроком потери; спящая — от середины до срока потери; потерянная — позже срока потери. Количество визитов определяет лояльность отдельно.</p>
    <div class="notice blue" style="margin:8px 0 10px"><b>Выгрузка базы подстраивается под эту специализацию:</b> окно «Давности посещений» должно быть длиннее срока потери. При текущем пороге &gt;${p.riskM} мес. приложение требует минимум ${clientBaseRequiredWindow(p)} мес. и автоматически выбирает самое короткое подходящее из загруженных окон${p.riskM >= 12 ? " (из стандартных 12 мес./3 года — 3 года)" : ""}.</div>
    <div class="grid cols-2" style="margin-top:10px">
      <label class="fld"><span>Дополнительные группы внутри текущего профиля (по одной в строке) — назначаются врачам в «Сотрудниках»</span>
        <textarea id="np_subdivisions" placeholder="по одному в строке" style="min-height:70px">${esc((p.subdivisions || []).join("\n"))}</textarea>
        ${fmtEx("УЗИ\nМаммологи\nОнкодерматологи")}</label>
      <label class="fld"><span>Слова-определители: врач автоматически попадает в этот профиль, если его должность содержит одно из слов (через запятую)</span>
        <textarea id="np_matchers" placeholder="через запятую" style="min-height:70px">${esc((p.matchers || []).join(", "))}</textarea>
        ${fmtEx("гинеколог, акушер")}</label>
    </div>
    <button class="btn primary" onclick="saveDeptBasics()">💾 Сохранить нормативы</button>
  </details>`;
  } else {
    html += `<details class="card" style="display:block" ${det("norm")}><summary style="cursor:pointer"><b>📐 Нормативы специализации</b></summary>
      <div class="notice blue" style="margin-top:10px">Нормативы настраиваются только на уровне специализации. Выберите специализацию в дереве клиники.</div>
    </details>`;
  }

  /* --- 2. Экспертность (Вектор 2): аппараты ИЛИ услуги --- */
  const exp = p.expertise;
  const cands = collectDeviceCandidates(dn);
  html += `<details class="card" style="display:block" ${det("expert")}><summary style="cursor:pointer"><b>⭐ Экспертность (Вектор 2) — «${esc(dn)}»</b></summary>
    <p class="small muted" style="margin-top:8px">Что отслеживаем у врачей этого профиля: аппараты или услуги. Название блока задаёте сами — так он будет называться в профайле врача и отчётах.</p>
    <div class="toolbar">
      <label>Название блока: <input type="text" id="ex_title" value="${esc(exp.title || "")}" style="min-width:220px"></label>
      <label>Тип: <select id="ex_mode">
        <option value="devices" ${exp.mode === "devices" ? "selected" : ""}>аппараты</option>
        <option value="services" ${exp.mode === "services" ? "selected" : ""}>услуги</option>
        <option value="none" ${exp.mode === "none" ? "selected" : ""}>не отслеживаем (вектор без балла)</option>
      </select></label>
      <label>Группа-доля: <select id="ex_group" title="Доля какой категории выручки считается «долей экспертных услуг» (пусто — сумма привязанных позиций)">
        <option value="">— сумма привязанных —</option>
        ${Object.keys(p.groups).map(g => `<option value="${esc(g)}" ${exp.group === g ? "selected" : ""}>${esc(g)}</option>`).join("")}
      </select></label>
    </div>
    <p class="small muted">Отслеживаемые позиции — по одной в строке: <code>Название = синоним1, синоним2</code>. Звёздочка в начале строки — «вне парка» (не входит в широту). Синонимы ищутся в названиях процедур.</p>
    <textarea id="ex_items" placeholder="Название = синоним1, синоним2" style="min-height:150px">${esc((exp.items || []).map(d => (d.core === false ? "* " : "") + d.name + " = " + (d.syn || []).join(", ")).join("\n"))}</textarea>
    ${fmtEx("Ultra Femme = ultra femme, ультра фемм\nКольпоскопия = кольпоскоп\n* НИЛИ = нили          ← звёздочка: вне парка")}
    <div class="toolbar"><button class="btn primary" onclick="saveDeptExpertise()">💾 Сохранить экспертность</button></div>`;
  if (exp.mode !== "none" && cands.length) {
    window._devCands = cands;
    html += `<h3>Нераспознанные позиции экспертности (${cands.length})</h3>
      <p class="small muted">Похожи на «${esc(exp.title)}», но не привязаны. Выберите позицию — правило запомнится.</p>
      <div class="scroll-y"><table class="data"><tr><th>Процедура</th><th>Категория 1С</th><th class="num">Шт</th><th class="num">Сумма</th><th>Привязать к</th></tr>`;
    cands.slice(0, 150).forEach((u, i) => {
      html += `<tr><td class="small">${esc(u.n)}</td><td class="small muted">${esc(u.cat)}</td><td class="num">${fmtNum(u.q)}</td><td class="num">${fmtMoney(u.s)}</td>
        <td><select onchange="bindCandidate(${i}, this.value)"><option value="">— выберите —</option>${(exp.items || []).map(d => `<option>${esc(d.name)}</option>`).join("")}<option value="__none__">это не «${esc(exp.title)}»</option></select></td></tr>`;
    });
    html += "</table></div>";
  }
  html += `</details>`;

  /* --- 3. Фокусы междисциплинарного подхода (Вектор 3) --- */
  const crossFocus = p.crossFocus || { title: "Фокусы междисциплинарного подхода", items: [] };
  html += `<details class="card" style="display:block" ${det("crossFocus")}><summary style="cursor:pointer"><b>🤝 Фокусы междисциплинарного подхода (Вектор 3) — «${esc(dn)}»</b></summary>
    <p class="small muted" style="margin-top:8px">Настройте назначения, которые считаются фокусами этого профиля. Они ищутся непосредственно в названиях позиций отчёта «Назначения» и не зависят от категорий выручки.</p>
    <div class="toolbar"><label>Название блока: <input type="text" id="cf_title" value="${esc(crossFocus.title || "")}" style="min-width:280px"></label></div>
    <p class="small muted">Фокусы — по одному в строке: <code>Название = синоним1, синоним2</code>. Звёздочка в начале строки — отслеживать, но не учитывать в широте фокусов. Штуки и выручка берутся из проданных назначений.</p>
    <textarea id="cf_items" placeholder="Название = синоним1, синоним2" style="min-height:150px">${esc((crossFocus.items || []).map(item => (item.core === false ? "* " : "") + item.name + " = " + (item.syn || []).join(", ")).join("\n"))}</textarea>
    ${fmtEx("УЗИ сердца = эхокардиография, эхо-кг\nХолтер = холтер, суточное мониторирование\n* Анализы = лабораторные исследования")}
    <p class="small muted">В балл Вектора 3 добавляются широта фокусов и доля их выручки. Цель по доле выручки задаётся ниже в блоке «Баллы и веса».</p>
    <div class="toolbar"><button class="btn primary" onclick="saveCrossFocusSettings()">💾 Сохранить фокусы Вектора 3</button></div>
  </details>`;

  /* --- 4. Номенклатура отделения: мама распихивает сама --- */
  const nomAll = collectDeptItems(dn);
  const nf = (UI.nomFilter || "").toLowerCase();
  const showUnmappedOnly = !!UI.nomUnmappedOnly;
  let nomItems = nomAll;
  if (showUnmappedOnly) nomItems = nomItems.filter(e => e.cls.unmapped || e.cls.devCandidate);
  if (nf) nomItems = nomItems.filter(e => e.n.toLowerCase().includes(nf) || (e.cat || "").toLowerCase().includes(nf));
  window._nomItems = nomItems;
  const unmappedCnt = nomAll.filter(e => e.cls.unmapped).length;
  const groupSelOptions = sel => {
    let o = `<option value="">— авто (по правилам) —</option>`;
    for (const g of Object.keys(p.groups)) {
      const subs = p.groups[g];
      if (!subs.length) o += `<option value="${esc(g)}||" ${sel === g + "||" ? "selected" : ""}>${esc(g)}</option>`;
      else {
        o += `<option value="${esc(g)}||" ${sel === g + "||" ? "selected" : ""}>${esc(g)}</option>`;
        for (const sub of subs) o += `<option value="${esc(g)}||${esc(sub)}" ${sel === g + "||" + sub ? "selected" : ""}>&nbsp;&nbsp;${esc(g)} → ${esc(sub)}</option>`;
      }
    }
    return o;
  };
  html += `<details class="card" style="display:block" ${det("nom")}><summary style="cursor:pointer"><b>🧩 Номенклатура — «${esc(dn)}»</b> <span class="small muted">(${nomAll.length} позиций, неразобрано: ${unmappedCnt})</span></summary>
    <p class="small muted" style="margin-top:8px">Скрипт разложил всё автоматически — здесь можно поправить руками: вид позиции, категорию, привязку к «${esc(exp.title)}» и показывать ли ШТУКИ на графиках (деньги показываются всегда). Ручная правка помечается ✋ и применяется ко всем месяцам.</p>
    <div class="toolbar">
      <input type="text" id="nomFilter" placeholder="поиск по названию…" value="${esc(UI.nomFilter || "")}">
      <label class="small"><input type="checkbox" id="nomUnm" ${showUnmappedOnly ? "checked" : ""} onchange="UI.nomUnmappedOnly=this.checked;renderSettings()"> только неразобранные</label>
    </div>
    <div class="scroll-y" id="nomScroll" style="max-height:520px"><table class="data"><tr><th>Позиция</th><th class="num">Шт / Сумма</th><th>Вид</th><th>Категория</th><th title="Привязка к отслеживаемой позиции экспертности">${esc(exp.title)}</th><th title="Показывать штуки на графиках экспертности">шт+₽</th><th></th></tr>`;
  nomItems.slice(0, 300).forEach((u, i) => {
    const ov = u.override || {};
    const autoKind = u.goods ? "товар" : "услуга";
    const kindSel = ov.type || "";
    const catSel = ov.group ? ov.group + "||" + (ov.sub || "") : "";
    const exSel = "expertItem" in ov ? (ov.expertItem || "__none__") : "";
    const qtyChecked = ov.showQty != null ? ov.showQty : u.cls.showQty;
    html += `<tr>
      <td class="small">${esc(u.n.length > 60 ? u.n.slice(0, 60) + "…" : u.n)}${Object.keys(ov).length ? ' <span title="есть ручные правки">✋</span>' : ""}<br><span class="muted">${esc(u.cat || "")}</span></td>
      <td class="num small">${fmtNum(u.q)} / ${fmtMoney(u.s)}</td>
      <td><select onchange="nomSetType(${i}, this.value)">
        <option value="" ${!kindSel ? "selected" : ""}>авто: ${autoKind}</option>
        <option value="услуга" ${kindSel === "услуга" ? "selected" : ""}>услуга</option>
        <option value="товар" ${kindSel === "товар" ? "selected" : ""}>товар</option>
        <option value="__custom__">другое…</option>
        ${kindSel && !["услуга", "товар"].includes(kindSel) ? `<option value="${esc(kindSel)}" selected>${esc(kindSel)}</option>` : ""}
      </select></td>
      <td><select onchange="nomSetCat(${i}, this.value)">${groupSelOptions(catSel)}</select>
        <div class="small muted">сейчас: ${esc(u.cls.group)}${u.cls.sub ? " → " + esc(u.cls.sub) : ""}${u.cls.unmapped ? ' <span class="badge bad">неразобрано</span>' : ""}</div></td>
      <td><select onchange="nomSetExpert(${i}, this.value)">
        <option value="" ${!exSel ? "selected" : ""}>авто${u.cls.expertItem ? ": " + esc(u.cls.expertItem) : ": —"}</option>
        ${(exp.items || []).map(d => `<option value="${esc(d.name)}" ${exSel === d.name ? "selected" : ""}>${esc(d.name)}</option>`).join("")}
        <option value="__none__" ${exSel === "__none__" ? "selected" : ""}>не привязывать</option>
      </select></td>
      <td style="text-align:center"><input type="checkbox" ${qtyChecked ? "checked" : ""} onchange="nomSetQty(${i}, this.checked)"></td>
      <td>${Object.keys(ov).length ? `<button class="btn mini" onclick="nomReset(${i})" title="убрать ручные правки">↺</button>` : ""}</td></tr>`;
  });
  if (nomItems.length > 300) html += `<tr><td colspan="7" class="small muted">Показаны первые 300 — уточните поиск.</td></tr>`;
  html += `</table></div>
    <details style="margin-top:10px" ${det("rules")}><summary class="small muted" style="cursor:pointer">Расширенное: правила по подстрокам (${(p.rules || []).length})</summary>
      <p class="small muted">Формат строки: <code>подстрока = Группа / Подгруппа / вид</code>. Подгруппу и вид (<i>услуга</i> или <i>товар</i>) можно не писать. Правила проверяются по порядку; ручные правки номенклатуры выше сильнее правил.</p>
      <textarea id="rulesTa" placeholder="подстрока = Группа / Подгруппа / вид" style="min-height:180px">${esc((p.rules || []).map(rl => rl[0] + " = " + rl[1] + (rl[2] ? " / " + rl[2] : "") + (rl[3] ? " / " + rl[3] : "")).join("\n"))}</textarea>
      ${fmtEx("узи = Узи\nкольпоскоп = Гинекологические процедуры / Кольпоскопия\nбад = Товары / БАДы / товар")}
      <label class="fld" style="margin-top:8px"><span>Группы и подгруппы категорий — по одной группе в строке: <code>Группа: подгруппа1, подгруппа2</code> (подгруппы можно не писать)</span>
      <textarea id="groupsTa" placeholder="Группа: подгруппа1, подгруппа2" style="min-height:110px">${esc(Object.entries(p.groups).map(([g, subs]) => g + (subs.length ? ": " + subs.join(", ") : "")).join("\n"))}</textarea></label>
      ${fmtEx("Приемы\nАппараты: Дека, Ultra Femme\nГинекологические процедуры: Кольпоскопия, Пайпель, Прочие\nТовары: Аптека, Косметика, БАДы")}
      <button class="btn" onclick="saveDeptTaxonomy()">Сохранить правила и группы</button></details>
  </details>`;

  /* --- 4. Веса специализации и цели трёх уровней --- */
  const sc = p.scoring;
  const inheritsDepartmentGoals = Boolean(specializationName && p.inheritGoals === true);
  const goalProfile = inheritsDepartmentGoals ? departmentProfile(departmentName) : p;
  const goalBenchmarks = goalProfile.scoring.benchmarks;
  const bmDefs = scoringBenchmarkDefs(specializationName ? p : goalProfile);
  const goalInputs = bmDefs.map(([k, n]) => `<tr><td>${n}</td><td class="num"><input type="number" id="sc_bm_${k}" value="${goalBenchmarks[k] != null && goalBenchmarks[k] !== "" ? goalBenchmarks[k] : ""}" step="any" style="width:110px" placeholder="—" ${inheritsDepartmentGoals ? "disabled" : ""}></td></tr>`).join("");
  html += `<details class="card" style="display:block" ${det("score")}><summary style="cursor:pointer"><b>🎯 ${specializationName ? `Векторы, веса и цели специализации «${esc(specializationName)}»` : `Цели отделения «${esc(departmentName)}»`}</b></summary>
    <p class="small muted" style="margin-top:8px"><b>Пустая цель = метрика не оценивается.</b> Цели врача имеют приоритет над целями специализации, а цели специализации — над целями отделения.</p>
    ${specializationName ? `<div class="grid cols-2">
      <div><h3>Векторы и веса специализации</h3>
        <table class="data wtable"><tr><th>Учитывать</th><th>Вектор</th><th class="num">Вес</th></tr>
        ${["v1", "v2", "v3", "v4", "v5", "v6"].map(vk => `
          <tr><td><input type="checkbox" id="sc_en_${vk}" ${sc.enabled[vk] ? "checked" : ""}></td>
          <td>В${vk[1]}. ${VECTOR_META[vk].name}</td>
          <td class="num"><input type="number" id="sc_w_${vk}" value="${sc.weights[vk]}" min="0" max="100" style="width:70px"> %</td></tr>`).join("")}
        </table></div>
      <div><h3>Цели специализации</h3>
        ${inheritsDepartmentGoals
          ? `<div class="notice blue">Сейчас используются цели отделения «${esc(departmentName)}».</div>`
          : `<div class="notice">Для этой специализации заданы отдельные цели.</div>`}
        <table class="data" style="width:100%"><tr><th>Метрика</th><th class="num">Цель</th></tr>${goalInputs}</table>
        <div class="toolbar">${inheritsDepartmentGoals
          ? `<button class="btn" onclick="enableSpecializationGoals()">Задать отдельные цели</button>`
          : `<button class="btn" onclick="resetSpecializationGoals()">↺ Использовать цели отделения</button>`}</div>
      </div>
    </div>` : `<h3>Цели отделения</h3><table class="data" style="width:100%"><tr><th>Метрика</th><th class="num">Цель</th></tr>${goalInputs}</table>`}
    <div class="toolbar"><button class="btn primary" onclick="saveDeptScoring()">💾 ${specializationName ? "Сохранить веса и цели специализации" : "Сохранить цели отделения"}</button></div>
  </details>`;

  /* --- 5. Персональные цели врача --- */
  const ids = allDoctorIds;
  if (UI.setDoctor) {
    const doctorId = UI.setDoctor;
    const doctor = DB.doctors[doctorId];
    const hasOwn = Boolean(doctor.metricSettings && typeof doctor.metricSettings === "object");
    const doctorProfile = profileForDoctor(doctorId);
    const doctorSc = doctorProfile.scoring;
    const doctorBmDefs = scoringBenchmarkDefs(doctorProfile);
    const disabled = hasOwn ? "" : "disabled";
    const effectiveSpecializationName = resolvedSpecializationName(doctorId);
    const structureName = doctorStructureLabel(doctorId);
    html += `<details class="card" id="doctorMetricSettingsCard" style="display:block" ${det("doctor")}><summary style="cursor:pointer"><b>👤 Индивидуальные цели врача</b></summary>
      <div class="toolbar" style="margin-top:10px">
        <label>Врач: <select id="setDoctorSel" onchange="UI.setDoctor=this.value;renderSettings()">${ids.map(id => `<option value="${esc(id)}" ${id === doctorId ? "selected" : ""}>${esc(doctorName(id))}</option>`).join("")}</select></label>
        <span class="badge ${hasOwn ? "ok" : ""}">${hasOwn ? "индивидуальные цели" : "наследует цели"}</span>
        <span class="small muted">Структура: ${esc(structureName)}</span><span class="spacer"></span>
        ${hasOwn
          ? `<button class="btn danger" onclick="resetDoctorMetricSettings()">↺ Сбросить цели к специализации</button>`
          : `<button class="btn primary" onclick="enableDoctorMetricSettings()">Включить индивидуальные цели</button>`}
      </div>
      <p class="small muted">${effectiveSpecializationName
        ? `Нормативы и веса врач всегда получает от специализации «${esc(effectiveSpecializationName)}». Здесь можно изменить только его цели.`
        : `<span class="badge warn">специализация не назначена</span> Назначьте специализацию врачу; до этого используется резервный профиль отделения. Здесь можно изменить только цели.`}</p>
      <h3>Цели врача</h3><table class="data" style="width:100%"><tr><th>Метрика</th><th class="num">Цель</th></tr>
          ${doctorBmDefs.map(([k, n]) => `<tr><td>${n}</td><td class="num"><input type="number" id="dm_bm_${k}" value="${doctorSc.benchmarks[k] != null && doctorSc.benchmarks[k] !== "" ? doctorSc.benchmarks[k] : ""}" step="any" style="width:110px" placeholder="—" ${disabled}></td></tr>`).join("")}
      </table>
      <div class="toolbar"><button class="btn primary" onclick="saveDoctorMetricSettings()" ${disabled}>💾 Сохранить цели врача</button></div>
    </details>`;
  } else {
    html += '<div class="card"><h2>👤 Персональные цели врача</h2><p class="muted">В базе пока нет врачей. Они появятся после загрузки отчётов.</p></div>';
  }

  /* --- Сотрудники --- */
  const filter = UI.staffFilter.toLowerCase();
  const visible = ids.filter(id => !filter || doctorName(id).toLowerCase().includes(filter));
  html += `<div class="card"><h2>👥 Сотрудники (${ids.length})</h2>
    <p class="small muted"><b>Отделение</b> объединяет специализации. <b>Специализация</b> задаёт нормативы и веса врачей. Для врача при необходимости настраиваются только индивидуальные цели. «Авто» определяется по должности и словам-определителям.</p>
    <div class="toolbar">
      <input type="text" id="staffFilter" placeholder="поиск по фамилии…" value="${esc(UI.staffFilter)}">
      <input type="text" id="newDoctorName" placeholder="ФИО нового врача…" style="min-width:210px">
      <button class="btn" onclick="addDoctorV4()">+ Добавить врача</button>
      <button class="btn" onclick="mergeSelected()">🔗 Склеить выбранных</button>
    </div>
    <div class="scroll-y"><table class="data"><tr><th></th><th>Сотрудник</th><th>Должность</th><th>Отделение</th><th>Специализация</th><th>Группа</th><th>Цели</th><th>Другие написания</th></tr>`;
  for (const id of visible) {
    const d = DB.doctors[id];
    const effectiveDepartment = resolvedDepartmentName(id);
    const effectiveSpecialization = resolvedSpecializationName(id);
    const doctorSpecializations = departmentGroups()[effectiveDepartment] || [];
    const needsSpecializations = departmentUsesSpecializations(effectiveDepartment);
    const subs = (profileForDoctor(id).subdivisions || []);
    html += `<tr><td><input type="checkbox" class="mergeChk" value="${id}"></td>
      <td><b>${esc(d.name)}</b></td>
      <td><input type="text" value="${esc(d.spec || "")}" placeholder="напр. гинеколог" onchange="setSpec('${id}', this.value)" style="width:170px"></td>
      <td><select onchange="setDoctorDepartment('${id}', this.value)">
        <option value="" ${!d.department ? "selected" : ""}>авто: ${esc(effectiveDepartment)}</option>
        ${departmentNames.map(n => `<option value="${esc(n)}" ${d.department === n ? "selected" : ""}>${esc(n)}</option>`).join("")}
      </select></td>
      <td>${needsSpecializations ? `<select onchange="setDoctorSpecialization('${id}', this.value)">
        <option value="" ${!d.specialization ? "selected" : ""}>авто: ${esc(effectiveSpecialization || "не определена")}</option>
        ${doctorSpecializations.map(n => `<option value="${esc(n)}" ${d.specialization === n ? "selected" : ""}>${esc(n)}</option>`).join("")}
      </select>` : '<span class="small muted">не нужны</span>'}</td>
      <td>${subs.length ? `<select onchange="setSubdept('${id}', this.value)"><option value="">—</option>${subs.map(sd => `<option value="${esc(sd)}" ${d.subdept === sd ? "selected" : ""}>${esc(sd)}</option>`).join("")}</select>` : '<span class="small muted">—</span>'}</td>
      <td><button class="btn mini" onclick="openDoctorGoalSettings('${id}')">Настроить</button></td>
      <td class="small muted">${d.aliases.length ? esc(d.aliases.join("; ")) : "—"}</td></tr>`;
  }
  html += `</table></div></div>`;

  const nomScrollTop = document.getElementById("nomScroll") ? document.getElementById("nomScroll").scrollTop : 0;
  document.getElementById("settingsBody").innerHTML = html;
  const nomScrollEl = document.getElementById("nomScroll");
  if (nomScrollEl && nomScrollTop) nomScrollEl.scrollTop = nomScrollTop; // не прыгать вверх при правках
  const sf = document.getElementById("staffFilter");
  sf.addEventListener("input", () => {
    UI.staffFilter = sf.value;
    renderSettings();
    const el = document.getElementById("staffFilter");
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
  const nfEl = document.getElementById("nomFilter");
  nfEl.addEventListener("input", () => {
    UI.nomFilter = nfEl.value;
    renderSettings();
    const el = document.getElementById("nomFilter");
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
}

/* --- отделения и специализации --- */
function addDepartmentV4() {
  const el = document.getElementById("newDepartmentName");
  const name = el ? el.value.trim() : "";
  if (!name) { toast("Введите название отделения", true); return; }
  if (departmentGroups()[name] || DB.settings.depts[name]) { toast("Такое название уже используется", true); return; }
  DB.settings.departments[name] = [];
  DB.settings.departmentProfiles[name] = JSON.parse(JSON.stringify(deptProfile("По умолчанию")));
  DB.settings.departmentUsesSpecializations[name] = false;
  UI.setDepartment = name;
  UI.setSpecialization = "";
  saveLocal();
  toast(`Отделение «${name}» создано — настройте его нормативы ниже`);
  renderSettings();
}

function removeDepartmentV4() {
  const name = curSetDepartment();
  const specs = (departmentGroups()[name] || []).slice();
  const detail = specs.length ? ` Вместе с ним будут удалены специализации: ${specs.join(", ")}.` : "";
  if (!confirm(`Удалить отделение «${name}»?${detail} Врачи вернутся к автоматическому распределению.`)) return;
  delete DB.settings.departments[name];
  delete DB.settings.departmentProfiles[name];
  delete DB.settings.departmentUsesSpecializations[name];
  for (const spec of specs) delete DB.settings.depts[spec];
  for (const doctor of Object.values(DB.doctors)) {
    if (doctor.department === name) doctor.department = null;
    if (specs.includes(doctor.specialization)) doctor.specialization = null;
    if (specs.includes(doctor.dept) || doctor.dept === name) doctor.dept = null;
  }
  UI.setDepartment = null;
  UI.setSpecialization = "";
  normalizeProfiles();
  saveLocal();
  toast(`Отделение «${name}» удалено`);
  renderSettings();
}

function toggleDepartmentSpecializations() {
  const name = curSetDepartment();
  const enabled = !departmentUsesSpecializations(name);
  DB.settings.departmentUsesSpecializations[name] = enabled;
  if (!enabled) UI.setSpecialization = "";
  saveLocal();
  toast(enabled ? "Специализации включены — добавьте или выберите их ниже" : "Специализации выключены — врачи используют настройки отделения");
  renderAll();
}

function addSpecializationV4() {
  const el = document.getElementById("newSpecializationName");
  const name = el ? el.value.trim() : "";
  const departmentName = curSetDepartment();
  if (!name) { toast("Введите название специализации", true); return; }
  if (DB.settings.depts[name] || (departmentGroups()[name] && name !== departmentName)) { toast("Такое название уже используется", true); return; }
  DB.settings.depts[name] = JSON.parse(JSON.stringify(departmentProfile(departmentName)));
  DB.settings.depts[name].inheritGoals = true;
  if (!Array.isArray(DB.settings.departments[departmentName])) DB.settings.departments[departmentName] = [];
  DB.settings.departments[departmentName].push(name);
  DB.settings.departmentUsesSpecializations[departmentName] = true;
  UI.setSpecialization = name;
  saveLocal();
  toast(`Специализация «${name}» создана внутри отделения «${departmentName}»`);
  renderSettings();
}

function moveSpecializationV4() {
  const el = document.getElementById("moveSpecializationSel");
  const name = el ? el.value : "";
  const departmentName = curSetDepartment();
  if (!name || !DB.settings.depts[name]) return;
  const oldDepartment = departmentForSpecialization(name);
  if (oldDepartment && oldDepartment !== departmentName) {
    DB.settings.departments[oldDepartment] = (DB.settings.departments[oldDepartment] || []).filter(spec => spec !== name);
  }
  if (!Array.isArray(DB.settings.departments[departmentName])) DB.settings.departments[departmentName] = [];
  if (!DB.settings.departments[departmentName].includes(name)) DB.settings.departments[departmentName].push(name);
  DB.settings.departmentUsesSpecializations[departmentName] = true;
  for (const doctor of Object.values(DB.doctors)) {
    if (doctor.specialization === name || doctor.dept === name) doctor.department = departmentName;
  }
  UI.setSpecialization = name;
  saveLocal();
  toast(`Специализация «${name}» перенесена в отделение «${departmentName}» без потери настроек`);
  renderSettings();
}

function removeSpecializationV4() {
  const departmentName = curSetDepartment();
  const name = curSetSpecialization();
  if (!name) return;
  if (!confirm(`Удалить специализацию «${name}»? Её врачи будут использовать базовые настройки отделения «${departmentName}».`)) return;
  DB.settings.departments[departmentName] = (DB.settings.departments[departmentName] || []).filter(spec => spec !== name);
  delete DB.settings.depts[name];
  for (const doctor of Object.values(DB.doctors)) {
    if (doctor.specialization === name) doctor.specialization = null;
    if (doctor.dept === name) doctor.dept = null;
  }
  UI.setSpecialization = "";
  saveLocal();
  toast(`Специализация «${name}» удалена`);
  renderSettings();
}
function saveDeptBasics() {
  if (!curSetSpecialization()) {
    toast("Нормативы настраиваются на уровне специализации", true);
    return;
  }
  const p = curSetProfile();
  const values = {};
  for (const k of ["minVisits", "activeM", "riskM", "courseX", "courseM", "corePct", "pervichkaM"]) {
    const el = document.getElementById("np_" + k);
    if (el) {
      const v = parseInt(el.value);
      if (!isNaN(v)) values[k] = v;
    }
  }
  if (!(values.activeM > 0) || !(values.riskM > values.activeM)) {
    toast("Срок потери должен быть больше ожидаемого срока возврата T", true);
    return;
  }
  Object.assign(p, values);
  p.subdivisions = document.getElementById("np_subdivisions").value.split("\n").map(x => x.trim()).filter(Boolean);
  p.matchers = document.getElementById("np_matchers").value.split(",").map(x => x.trim()).filter(Boolean);
  saveLocal();
  toast(`Нормативы ${curSetProfileKind()} сохранены`);
  renderAll();
}
function saveDeptExpertise() {
  const p = curSetProfile();
  const items = [];
  for (const line of document.getElementById("ex_items").value.split("\n").map(x => x.trim()).filter(Boolean)) {
    const core = !line.startsWith("*");
    const clean = line.replace(/^\*\s*/, "");
    const [name, synStr] = clean.split("=").map(x => x.trim());
    if (!name) continue;
    const syn = (synStr || name).split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
    items.push({ name, syn: syn.length ? syn : [name.toLowerCase()], core });
  }
  p.expertise = Object.assign({}, p.expertise, {
    title: document.getElementById("ex_title").value.trim() || "Экспертность",
    mode: document.getElementById("ex_mode").value,
    group: document.getElementById("ex_group").value,
    items,
  });
  saveLocal();
  toast("Экспертность сохранена: " + items.length + " позиций");
  renderAll();
}
function saveCrossFocusSettings() {
  const p = curSetProfile();
  const items = [];
  for (const line of document.getElementById("cf_items").value.split("\n").map(value => value.trim()).filter(Boolean)) {
    const core = !line.startsWith("*");
    const clean = line.replace(/^\*\s*/, "");
    const [name, synonymString] = clean.split("=").map(value => value.trim());
    if (!name) continue;
    const synonyms = (synonymString || name).split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
    items.push({ name, syn: synonyms.length ? synonyms : [name.toLowerCase()], core });
  }
  p.crossFocus = Object.assign({}, p.crossFocus, {
    title: document.getElementById("cf_title").value.trim() || "Фокусы междисциплинарного подхода",
    items,
  });
  clearMetricsCache();
  saveLocal();
  toast("Фокусы Вектора 3 сохранены: " + items.length + " позиций");
  renderAll();
}
function bindCandidate(i, val) {
  if (!val || !window._devCands || !window._devCands[i]) return;
  const p = curSetProfile();
  const u = window._devCands[i];
  if (!p.overrides) p.overrides = {};
  if (val === "__none__") {
    p.overrides[u.n.toLowerCase()] = Object.assign({}, p.overrides[u.n.toLowerCase()], { expertItem: null });
    toast("Помечено как не-экспертное — уточните категорию в «Номенклатуре»");
  } else {
    if (!p.expertise.rules) p.expertise.rules = [];
    p.expertise.rules.push([u.n.toLowerCase(), val]);
    toast(`«${u.n.slice(0, 45)}…» → ${val}`);
  }
  saveLocal();
  renderSettings();
}
/* --- редактор номенклатуры --- */
function nomOv(i) {
  const p = curSetProfile();
  if (!p.overrides) p.overrides = {};
  const u = window._nomItems[i];
  const key = u.n.toLowerCase();
  if (!p.overrides[key]) p.overrides[key] = {};
  return { p, key, ov: p.overrides[key] };
}
function nomSetType(i, val) {
  if (val === "__custom__") {
    const t = prompt("Введите свой вид позиции (например «аренда», «сертификат»):");
    if (!t) { renderSettings(); return; }
    val = t.trim();
  }
  const { p, key, ov } = nomOv(i);
  if (val) ov.type = val; else delete ov.type;
  if (!Object.keys(ov).length) delete p.overrides[key];
  saveLocal();
  renderSettings();
}
function nomSetCat(i, val) {
  const { p, key, ov } = nomOv(i);
  if (val) {
    const [g, sub] = val.split("||");
    ov.group = g;
    ov.sub = sub || "";
  } else {
    delete ov.group;
    delete ov.sub;
  }
  if (!Object.keys(ov).length) delete p.overrides[key];
  saveLocal();
  renderSettings();
}
function nomSetExpert(i, val) {
  const { p, key, ov } = nomOv(i);
  if (val === "") delete ov.expertItem;
  else ov.expertItem = val === "__none__" ? null : val;
  if (!Object.keys(ov).length) delete p.overrides[key];
  saveLocal();
  renderSettings();
}
function nomSetQty(i, checked) {
  const { ov } = nomOv(i);
  ov.showQty = checked;
  saveLocal();
  renderSettings();
}
function nomReset(i) {
  const { p, key } = nomOv(i);
  delete p.overrides[key];
  saveLocal();
  toast("Ручные правки позиции убраны — снова действуют правила");
  renderSettings();
}
function saveDeptTaxonomy() {
  const p = curSetProfile();
  const rules = [];
  for (const line of document.getElementById("rulesTa").value.split("\n").map(x => x.trim()).filter(Boolean)) {
    const [sub, rest] = line.split("=").map(x => x.trim());
    if (!sub || !rest) continue;
    const parts = rest.split("/").map(x => x.trim());
    rules.push([sub, parts[0] || "Другие услуги", parts[1] || "", parts[2] || ""]);
  }
  p.rules = rules;
  const groups = {};
  for (const line of document.getElementById("groupsTa").value.split("\n").map(x => x.trim()).filter(Boolean)) {
    const [g, subsStr] = line.split(":").map(x => x.trim());
    if (!g) continue;
    groups[g] = subsStr ? subsStr.split(",").map(x => x.trim()).filter(Boolean) : [];
  }
  if (Object.keys(groups).length) p.groups = groups;
  saveLocal();
  toast(`Сохранено: правил — ${rules.length}, групп — ${Object.keys(p.groups).length}`);
  renderAll();
}
/* --- веса специализации и цели отделения/специализации --- */
function enableSpecializationGoals() {
  const specializationName = curSetSpecialization();
  if (!specializationName) return;
  const p = curSetProfile();
  const departmentGoals = departmentProfile(curSetDepartment()).scoring.benchmarks;
  p.scoring.benchmarks = Object.assign({}, departmentGoals);
  p.inheritGoals = false;
  saveLocal();
  toast(`Для специализации «${specializationName}» включены отдельные цели`);
  renderSettings();
}

function resetSpecializationGoals() {
  const specializationName = curSetSpecialization();
  if (!specializationName) return;
  const p = curSetProfile();
  if (!confirm(`Использовать для специализации «${specializationName}» цели отделения «${curSetDepartment()}»?`)) return;
  p.inheritGoals = true;
  saveLocal();
  toast(`Специализация «${specializationName}» снова наследует цели отделения`);
  renderAll();
}

function saveDeptScoring() {
  const p = curSetProfile();
  const specializationName = curSetSpecialization();
  if (!p.scoring) p.scoring = defaultScoring();
  if (specializationName) {
    for (const vk of ["v1", "v2", "v3", "v4", "v5", "v6"]) {
      const enabledEl = document.getElementById("sc_en_" + vk);
      const weightEl = document.getElementById("sc_w_" + vk);
      if (enabledEl) p.scoring.enabled[vk] = enabledEl.checked;
      if (weightEl) p.scoring.weights[vk] = parseFloat(weightEl.value) || 0;
    }
  }
  const canSaveGoals = !specializationName || p.inheritGoals !== true;
  for (const k of Object.keys(defaultBenchmarks())) {
    const el = document.getElementById("sc_bm_" + k);
    if (!el || !canSaveGoals) continue;
    const raw = el.value.trim();
    const value = raw === "" ? "" : parseFloat(raw);
    if (value !== "" && (!isFinite(value) || value <= 0)) {
      toast("Цели должны быть положительными числами или пустыми", true);
      return;
    }
    if (value !== "" && k === "rating" && value > 5) {
      toast("Цель рейтинга должна быть в диапазоне 0–5", true);
      return;
    }
    if (value !== "" && ["schedLoad", "pervichka", "ownRecords", "courseIdx", "akbShare", "riskShare", "churn", "hwShare", "crossShare", "nazConv", "nazFocusShare", "nps"].includes(k) && value > 100) {
      toast("Процентные цели и записи на 100 визитов не могут быть больше 100", true);
      return;
    }
    p.scoring.benchmarks[k] = value;
  }
  saveLocal();
  toast(specializationName
    ? (p.inheritGoals === true ? `Веса специализации «${specializationName}» сохранены` : `Веса и цели специализации «${specializationName}» сохранены`)
    : `Цели отделения «${curSetDepartment()}» сохранены`);
  renderAll();
}
/* --- персональные цели врача --- */
function enableDoctorMetricSettings() {
  const id = UI.setDoctor;
  if (!id || !DB.doctors[id]) return;
  DB.doctors[id].metricSettings = doctorMetricSettingsFromProfile(profileForDoctor(id));
  saveLocal();
  toast(`Индивидуальные цели включены для ${doctorName(id)}`);
  renderSettings();
}
function resetDoctorMetricSettings() {
  const id = UI.setDoctor;
  if (!id || !DB.doctors[id] || !DB.doctors[id].metricSettings) return;
  if (!confirm(`Сбросить индивидуальные цели врача «${doctorName(id)}» и снова использовать настройки его отделения/специализации?`)) return;
  delete DB.doctors[id].metricSettings;
  saveLocal();
  toast(`${doctorName(id)} снова наследует цели специализации`);
  renderSettings();
}
function saveDoctorMetricSettings() {
  const id = UI.setDoctor;
  const doctor = id && DB.doctors[id];
  if (!doctor || !doctor.metricSettings) {
    toast("Сначала включите индивидуальные цели врача", true);
    return;
  }
  const settings = doctor.metricSettings;
  if (!settings.scoring) settings.scoring = doctorMetricSettingsFromProfile(profileForDoctor(id)).scoring;
  for (const key of Object.keys(defaultBenchmarks())) {
    const el = document.getElementById("dm_bm_" + key);
    if (!el) continue;
    const raw = el.value.trim();
    const value = raw === "" ? "" : parseFloat(raw);
    if (value !== "" && (!isFinite(value) || value <= 0)) {
      toast("Цели врача должны быть положительными числами или пустыми", true);
      return;
    }
    if (value !== "" && key === "rating" && value > 5) {
      toast("Цель рейтинга должна быть в диапазоне 0–5", true);
      return;
    }
    if (value !== "" && ["schedLoad", "pervichka", "ownRecords", "courseIdx", "akbShare", "riskShare", "churn", "hwShare", "crossShare", "nazConv", "nazFocusShare", "nps"].includes(key) && value > 100) {
      toast("Процентные цели и записи на 100 визитов не могут быть больше 100", true);
      return;
    }
    settings.scoring.benchmarks[key] = value;
  }
  saveLocal();
  toast(`Цели врача «${doctorName(id)}» сохранены`);
  renderAll();
}
/* --- сотрудники --- */
function setDoctorDepartment(id, val) {
  if (!DB.doctors[id]) return;
  const doctor = DB.doctors[id];
  doctor.department = val || null;
  doctor.structureManual = Boolean(val);
  doctor.dept = null; // старое поле больше не должно переопределять новую иерархию
  if (!val || !(departmentGroups()[val] || []).includes(doctor.specialization)) doctor.specialization = null;
  saveLocal();
  renderSettings();
}
function addDoctorV4() {
  const el = document.getElementById("newDoctorName");
  const name = el ? cleanupFioDisplay(el.value) : "";
  if (!normFio(name)) { toast("Введите фамилию или ФИО врача", true); return; }
  const duplicate = Object.entries(DB.doctors).find(([, doctor]) => [doctor.name, ...(doctor.aliases || [])].some(alias => fioScore(alias, name) >= 0.85));
  if (duplicate) { toast(`Врач уже есть в списке: ${doctorName(duplicate[0])}`, true); return; }
  const base = "manual_" + normFio(name).split(" ")[0];
  let id = base, suffix = 2;
  while (DB.doctors[id]) id = `${base}_${suffix++}`;
  DB.doctors[id] = { name, aliases: [], structureManual: false };
  UI.setDoctor = id;
  saveLocal();
  toast(`Врач «${name}» добавлен — назначьте отделение и специализацию`);
  renderSettings();
}
function setDoctorSpecialization(id, val) {
  if (!DB.doctors[id]) return;
  const doctor = DB.doctors[id];
  const departmentName = resolvedDepartmentName(id);
  doctor.specialization = val && (departmentGroups()[departmentName] || []).includes(val) ? val : null;
  doctor.structureManual = Boolean(doctor.department || doctor.specialization);
  doctor.dept = null;
  saveLocal();
  renderSettings();
}
function setSubdept(id, val) {
  if (!DB.doctors[id]) return;
  DB.doctors[id].subdept = val || null;
  saveLocal();
}
function setSpec(id, val) {
  if (!DB.doctors[id]) return;
  DB.doctors[id].spec = val.trim() || null;
  saveLocal();
  renderSettings(); // должность влияет на «авто»-отделение
}
async function mergeSelected() {
  const ids = [...document.querySelectorAll(".mergeChk:checked")].map(c => c.value);
  if (ids.length < 2) { toast("Отметьте галочками минимум две карточки одного человека", true); return; }
  const names = ids.map(id => doctorName(id)).join(" + ");
  if (!confirm("Склеить в одну карточку:\n" + names + "\n\nДанные будут объединены. Отменить можно только загрузкой сохранённой базы.")) return;
  if (DESKTOP_API) {
    try {
      await DESKTOP_API.createBackup();
    } catch (error) {
      toast("Объединение отменено: не удалось создать резервную копию — " + error.message, true);
      return;
    }
  }
  const target = mergeDoctors(ids);
  await saveLocal();
  toast("Склеено: " + doctorName(target));
  renderSettings();
}

/* ================= ОБЩЕЕ ================= */

function renderAll() {
  updateHeaderStatus();
  if (UI.tab === "data") renderData();
  if (UI.tab === "department") renderDepartment();
  if (UI.tab === "dept") renderDept();
  if (UI.tab === "doctor") renderDoctor();
  if (UI.tab === "report") renderReport();
  if (UI.tab === "settings") renderSettings();
}

async function initApp() {
  if (typeof ChartDataLabels !== "undefined") Chart.register(ChartDataLabels);
  Chart.defaults.set("plugins.datalabels", { display: false });
  if (DESKTOP_API) {
    await loadDesktopDatabase();
    renderDesktopWorkspace();
  } else {
    loadLocal();
    restoreAutosave().then(() => { if (UI.tab === "data") renderData(); });
  }
  document.querySelectorAll("nav.tabs button").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  const dz = document.getElementById("dropzone");
  const fi = document.getElementById("fileInput");
  const di = document.getElementById("dirInput");
  dz.addEventListener("click", e => {
    if (e.target.tagName !== "BUTTON") {
      if (DESKTOP_API) desktopPickInputFiles(); else fi.click();
    }
  });
  document.getElementById("btnPickFiles").addEventListener("click", () => DESKTOP_API ? desktopPickInputFiles() : fi.click());
  document.getElementById("btnPickDir").addEventListener("click", async () => {
    if (!DESKTOP_API) { di.click(); return; }
    if (await desktopChooseFolder("input")) await desktopScanInput();
  });
  fi.addEventListener("change", () => { handleFiles(fi.files); fi.value = ""; });
  di.addEventListener("change", () => { handleFiles(di.files); di.value = ""; });
  ["dragover", "dragenter"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove("dragover"); }));
  dz.addEventListener("drop", e => {
    filesFromDataTransfer(e.dataTransfer)
      .then(files => handleFiles(files))
      .catch(error => toast("Не удалось прочитать перетащенные файлы: " + error.message, true));
  });
  document.getElementById("departmentMonth").addEventListener("change", e => { UI.departmentMonth = e.target.value; renderDepartment(); });
  document.getElementById("departmentFilter").addEventListener("change", e => { UI.departmentFilter = e.target.value; renderDepartment(); });
  document.getElementById("deptMonth").addEventListener("change", e => { UI.deptMonth = e.target.value; renderDept(); });
  document.getElementById("deptFilter").addEventListener("change", e => { UI.deptFilter = e.target.value; UI.subFilter = "all"; renderDept(); });
  document.getElementById("subFilter").addEventListener("change", e => { UI.subFilter = e.target.value; renderDept(); });
  document.getElementById("btnXlsx").addEventListener("click", exportDeptXlsx);
  document.getElementById("docMonth").addEventListener("change", e => { UI.docMonth = e.target.value; renderDoctor(); });
  document.getElementById("docSelect").addEventListener("change", e => { UI.docId = e.target.value; renderDoctor(); });
  document.getElementById("repMonth").addEventListener("change", e => { UI.repMonth = e.target.value; renderReport(); });
  document.getElementById("repScope").addEventListener("change", e => { UI.repScope = e.target.value; renderReport(); });
  document.getElementById("btnPrint").addEventListener("click", () => window.print());
  document.getElementById("btnExportAllPdf").addEventListener("click", exportAllReportsToFolder);
  document.getElementById("btnSaveSession").addEventListener("click", saveSessionState);
  document.getElementById("btnExport").addEventListener("click", exportDB);
  document.getElementById("btnImport").addEventListener("click", () => document.getElementById("importInput").click());
  document.getElementById("importInput").addEventListener("change", e => { if (e.target.files[0]) importDBFile(e.target.files[0]); e.target.value = ""; });
  document.getElementById("btnClear").addEventListener("click", clearDB);
  document.getElementById("btnAutosave").addEventListener("click", connectAutosave);
  if (DESKTOP_API) {
    document.getElementById("btnScanInput").addEventListener("click", desktopScanInput);
    document.getElementById("btnOpenOutput").addEventListener("click", () => DESKTOP_API.openPath("output").catch(error => toast(error.message, true)));
    document.getElementById("btnChooseWorkspace").addEventListener("click", desktopChooseWorkspace);
    document.querySelectorAll("[data-choose-folder]").forEach(button => button.addEventListener("click", () => desktopChooseFolder(button.dataset.chooseFolder)));
    document.querySelectorAll("[data-open-path]").forEach(button => button.addEventListener("click", () => DESKTOP_API.openPath(button.dataset.openPath).catch(error => toast(error.message, true))));
    document.getElementById("btnBackupNow").addEventListener("click", () => desktopBackupNow(false));
    document.getElementById("btnExportBackup").addEventListener("click", () => desktopBackupNow(true));
    document.getElementById("btnRestoreBackup").addEventListener("click", desktopRestoreBackup);
    document.getElementById("btnCheckUpdates").addEventListener("click", desktopCheckUpdates);
    document.getElementById("btnInstallUpdate").addEventListener("click", () => DESKTOP_API.installUpdateFile().catch(error => toast("Не удалось запустить обновление: " + error.message, true)));
    DESKTOP_API.onUpdateStatus(status => {
      DESKTOP_STATE.update = status;
      renderUpdateStatus(status);
    });
  }
  switchTab("data");
}

document.addEventListener("DOMContentLoaded", () => {
  initApp().catch(error => {
    console.error("application init failed", error);
    toast("Не удалось запустить приложение: " + error.message, true);
  });
});
