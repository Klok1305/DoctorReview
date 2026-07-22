"use strict";
/* ============================================================
 * ПАРСЕРЫ выгрузок 1С
 * Колонки и уровни группировок определяются по шапке файла,
 * поэтому переживают смену настройки отчёта в 1С.
 * ============================================================ */

function sheetToRows(ws) {
  return fixMojibake(XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }));
}

/* 1С иногда пишет .xls с неверной кодовой страницей: кириллица cp1251
   прочитывается как латиница-1 («Ïàðàìåòðû»). Определяем и чиним. */
function fixMojibake(rows) {
  let latinExt = 0, cyr = 0;
  for (const row of rows.slice(0, 40)) {
    for (const v of row || []) {
      if (typeof v !== "string") continue;
      for (let i = 0; i < v.length; i++) {
        const c = v.charCodeAt(i);
        if (c >= 0x0400 && c <= 0x04FF) cyr++;
        else if (c >= 0xC0 && c <= 0xFF) latinExt++;
      }
    }
  }
  if (latinExt < 20 || cyr > latinExt) return rows;
  const dec = new TextDecoder("windows-1251");
  const fix = s => {
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0xFF) return s; // не latin1 — не трогаем
    return dec.decode(Uint8Array.from(s, ch => ch.charCodeAt(0)));
  };
  return rows.map(row => (row || []).map(v => (typeof v === "string" ? fix(v) : v)));
}
function cellStr(v) {
  return v == null ? "" : String(v).trim();
}
function rowText(row) {
  return (row || []).map(cellStr).join(" | ");
}
function getRowLevels(ws) {
  if (!ws["!rows"]) return null;
  const has = ws["!rows"].some(r => r && r.level != null && r.level > 0);
  return has ? ws["!rows"].map(r => (r ? (r.level || 0) : 0)) : null;
}

function detectReportType(rows) {
  const head = rows.slice(0, 60).map(rowText).join("\n").toLowerCase();
  if (head.includes("посещение и возвращаемость")) return "pervichka";
  if (head.includes("направивший врач") && head.includes("количество назначено")) return "naznach";
  if (head.includes("форма участия")) return "vyrabotka";
  if (head.includes("давность посещения")) return "kb";
  if (head.includes("продолжительность по графику")) return "prostoy";
  if (head.includes("записи на прием") && head.includes("прочие события")) return "zapis";
  return null;
}

function extractHeaderInfo(rows) {
  let period = null, otborName = null;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const t = rowText(rows[i]);
    if (!period) {
      const p = extractPeriod(t);
      if (p) period = p;
    }
    if (/Отбор/i.test(t)) {
      const q = t.match(/"([^"]+)"/) || t.match(/«([^»]+)»/);
      if (q) otborName = q[1];
    }
    // июньская выработка: «Сотрудник: Пудовкина Юлия Геннадьевна»
    if (!otborName) {
      const m = t.match(/Сотрудник:\s*([А-ЯЁа-яё][^|]{5,60})/);
      if (m) otborName = m[1].trim();
    }
  }
  return { period, otborName };
}

function findRowIdx(rows, pred, from = 0, to = 80) {
  for (let i = from; i < Math.min(rows.length, to); i++) {
    if (pred(rows[i] || [])) return i;
  }
  return -1;
}

/* ============================================================
 * ВЫРАБОТКА — гибкий парсер (форматы «апрель» и «июнь»)
 *
 * Апрель: уровни [Форма участия > Сотрудник > Товар/Услуги > Категория],
 *   позиции в колонке «Номенклатура», колонки: Количество, Сумма.
 * Июнь:   уровни [Сотрудник > Филиал > Форма участия > Категория выработки],
 *   позиции в колонке A, колонки: Количество, Сумма услуги, Сумма товары,
 *   Сумма услуги/товары «прочее участие» (= выполненные направления врача).
 *
 * Итог: items [{form, sourceForm, cat, n, q, sOwn, sRef, goods}], где
 *   form  — форма участия ('' = врач выполнил сам, включая «По направлению»;
 *           'Ассистент' и т.п. = прочее участие),
 *   sourceForm — исходный блок 1С: «Сотрудник», «Направление» или
 *                «По направлению»; нужен и для строк с нулевой суммой,
 *   sOwn/sRef — суммы из основных колонок и колонок «прочее участие».
 *   Бизнес-разнос выполняется по sourceForm: «Сотрудник» и
 *   «По направлению» относятся к В2, «Направление» — к В3,
 *   goods — товарная позиция (для классификации).
 * ============================================================ */

function isVyrabotkaReferralForm(form) {
  return cellStr(form).toLowerCase() === "направление";
}

function isVyrabotkaOwnReferralForm(form) {
  return cellStr(form).toLowerCase() === "по направлению";
}

function normalizeVyrabotkaOwnForm(form) {
  return isVyrabotkaOwnReferralForm(form) ? "" : cellStr(form);
}

function vyrabotkaSourceForm(form) {
  const value = cellStr(form);
  if (isVyrabotkaReferralForm(value)) return "Направление";
  if (isVyrabotkaOwnReferralForm(value)) return "По направлению";
  return value || "Сотрудник";
}

function parseVyrabotka(rows, info, ws) {
  // --- шапка: строка с «Номенклатура» и колонки по названиям ---
  let hIdx = -1, nomenCol = -1;
  outer:
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const r = rows[i] || [];
    for (let c = 0; c < r.length; c++) {
      if (cellStr(r[c]) === "Номенклатура") { hIdx = i; nomenCol = c; break outer; }
    }
  }
  if (hIdx < 0) throw new Error("не найдена шапка с колонкой «Номенклатура»");
  const cols = { qty: -1, sum: -1, sUsl: -1, sTov: -1, sUslRef: -1, sTovRef: -1 };
  const hnorm = v => cellStr(v).replace(/\s+/g, " "); // переносы строк в шапке → пробел
  for (let i = Math.max(0, hIdx - 5); i <= hIdx + 1; i++) {
    const r = rows[i] || [];
    for (let c = 0; c < r.length; c++) {
      const v = hnorm(r[c]);
      if (v === "Количество") cols.qty = c;
      else if (v === "Сумма") cols.sum = c;
      else if (v === "Сумма услуги") cols.sUsl = c;
      else if (v === "Сумма товары") cols.sTov = c;
      else if (v === "Сумма услуги прочее участие") cols.sUslRef = c;
      else if (v === "Сумма товары прочее участие") cols.sTovRef = c;
    }
  }
  if (cols.qty < 0) throw new Error("не найдена колонка «Количество»");
  const juneFmt = cols.sUsl >= 0; // формат с раздельными суммами
  if (!juneFmt && cols.sum < 0) throw new Error("не найдена колонка «Сумма»");
  const leafByNomenCol = nomenCol > 0; // апрельский формат: номенклатура в отдельной колонке

  // --- строки данных до «Итого» ---
  const data = [];
  let itogo = null;
  for (let i = hIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const a = cellStr(r[0]);
    if (a === "Итого") {
      itogo = { q: parseRuNumber(r[cols.qty]), s: juneFmt ? (parseRuNumber(r[cols.sUsl]) || 0) + (parseRuNumber(r[cols.sTov]) || 0) : parseRuNumber(r[cols.sum]) };
      break;
    }
    if (a === "Сотрудник" || a === "Специализация") continue; // повторы шапки
    data.push({ i, r, a });
  }
  if (!data.length) throw new Error("нет данных после шапки");

  const readSums = r => {
    if (juneFmt) {
      return {
        sOwn: (parseRuNumber(r[cols.sUsl]) || 0) + (parseRuNumber(r[cols.sTov]) || 0),
        sRef: (parseRuNumber(r[cols.sUslRef]) || 0) + (parseRuNumber(r[cols.sTovRef]) || 0),
        goods: (parseRuNumber(r[cols.sTov]) || 0) > 0 || (parseRuNumber(r[cols.sTovRef]) || 0) > 0,
      };
    }
    return { sOwn: parseRuNumber(r[cols.sum]) || 0, sRef: 0, goods: false };
  };

  let result = null, checked = false;

  if (leafByNomenCol) {
    // апрельский формат: лист = заполненная колонка «Номенклатура»
    const r0 = buildItemsApril(data, cols, nomenCol, info, readSums);
    result = r0;
    checked = validateVy(r0.items, itogo);
  } else {
    // июньский формат: уровни группировок
    const levels = getRowLevels(ws);
    const candidates = [];
    if (levels) {
      for (const shift of [0, 1]) {
        candidates.push(() => buildItemsJune(data, cols, readSums, info,
          row => (levels[row.i + shift] || 0)));
      }
    }
    // резерв: лист = строка с кодом номенклатуры в скобках на конце
    candidates.push(() => buildItemsJune(data, cols, readSums, info, null));
    for (const make of candidates) {
      const r0 = make();
      if (r0.items.length && validateVy(r0.items, itogo)) { result = r0; checked = true; break; }
      if (!result && r0.items.length) result = r0;
    }
  }
  if (!result || !result.items.length) throw new Error("не удалось выделить позиции");
  if (!result.doctorRaw) throw new Error("не удалось определить сотрудника (нет «Отбор»/«Сотрудник:» в шапке)");
  return { doctorRaw: result.doctorRaw, items: result.items, checked };
}

function validateVy(items, itogo) {
  if (!itogo || itogo.q == null) return false;
  const q = items.reduce((a, it) => a + (it.q || 0), 0);
  const s = items.reduce((a, it) => a + (it.sOwn || 0) + (it.sRef || 0), 0);
  const sRef = items.reduce((a, it) => a + (it.sRef || 0), 0);
  const okQ = Math.abs(q - itogo.q) < 0.5;
  // в апрельском формате «Итого» включает направления в той же колонке суммы;
  // в июньском — own-суммы отдельно. Допускаем оба варианта.
  const okS = itogo.s == null || Math.abs(s - itogo.s) < 1 || Math.abs((s - sRef) - itogo.s) < 1;
  return okQ && okS;
}

/* Апрельский формат: иерархия Форма участия > Сотрудник > Товар/Услуги > Категория, лист по колонке номенклатуры */
function buildItemsApril(data, cols, nomenCol, info, readSums) {
  const items = [];
  let form = "", sectionGoods = false, doctorRaw = info.otborName || null;
  for (const { r, a } of data) {
    const nomen = cellStr(r[nomenCol]);
    const q = parseRuNumber(r[cols.qty]);
    if (nomen) {
      const sums = readSums(r);
      const isRefForm = isVyrabotkaReferralForm(form);
      items.push({
        form: isRefForm ? "" : normalizeVyrabotkaOwnForm(form),
        sourceForm: vyrabotkaSourceForm(form),
        cat: a || "",
        n: nomen, q: q || 0,
        sOwn: isRefForm ? 0 : sums.sOwn,
        sRef: (isRefForm ? sums.sOwn : 0) + sums.sRef,
        goods: sums.goods || sectionGoods,
      });
      continue;
    }
    if (!a) { form = form || ""; continue; } // пустая строка формы участия = основной исполнитель
    if (isVyrabotkaReferralForm(a)) { form = "Направление"; continue; }
    if (isVyrabotkaOwnReferralForm(a)) { form = "По направлению"; continue; }
    if (a === "Товар") { sectionGoods = true; continue; }
    if (a === "Услуги") { sectionGoods = false; continue; }
    if (doctorRaw && fioScore(a, doctorRaw) >= 0.85) { doctorRaw = a; continue; }
    if (!doctorRaw && fioTokens(a).length >= 2 && fioTokens(a).length <= 4 && q != null) { doctorRaw = a; continue; }
    // иначе категория — позиции берут её из своей колонки A
  }
  return { items, doctorRaw };
}

/* Июньский формат: Сотрудник > Филиал > Форма участия > Категория выработки, лист в колонке A.
   getLv — уровень группировки строки (или null: резервная эвристика по коду в скобках). */
function buildItemsJune(data, cols, readSums, info, getLv) {
  const items = [];
  let doctorRaw = info.otborName || null;
  const looksLeaf = a => /\([^()]*\d[^()]*\)\s*$/.test(a); // «… (СЛ000014161)», «… (343)», «… (291/4)»
  const looksFilial = a => /^(ооо|ип|ао|зао)\s/i.test(a) || /^«.*»/.test(a);

  if (getLv) {
    // определяем максимальный уровень (листья) по строкам с именем и количеством
    let maxLv = 0;
    for (const row of data) {
      if (row.a && parseRuNumber(row.r[cols.qty]) != null) maxLv = Math.max(maxLv, getLv(row));
    }
    if (maxLv === 0) return { items: [], doctorRaw };
    const stack = {};
    for (const row of data) {
      const lv = getLv(row);
      const q = parseRuNumber(row.r[cols.qty]);
      if (lv >= maxLv && row.a) {
        // лист
        const sums = readSums(row.r);
        const form = stack[maxLv - 2] != null ? stack[maxLv - 2] : "";
        const isRefForm = isVyrabotkaReferralForm(form);
        items.push({
          form: isRefForm ? "" : normalizeVyrabotkaOwnForm(form),
          sourceForm: vyrabotkaSourceForm(form),
          cat: stack[maxLv - 1] || "",
          n: row.a, q: q || 0,
          sOwn: isRefForm ? 0 : sums.sOwn,
          sRef: (isRefForm ? sums.sOwn : 0) + sums.sRef,
          goods: sums.goods,
        });
      } else if (lv < maxLv) {
        stack[lv] = row.a; // может быть пустым (форма участия = основной исполнитель)
        for (let d = lv + 1; d < maxLv; d++) delete stack[d];
        if (row.a && doctorRaw && fioScore(row.a, doctorRaw) >= 0.85) doctorRaw = row.a;
        else if (row.a && !doctorRaw && !looksFilial(row.a) && fioTokens(row.a).length >= 2 && fioTokens(row.a).length <= 4) doctorRaw = row.a;
      }
    }
    return { items, doctorRaw };
  }

  // резерв без уровней: лист — по коду в скобках; группы — стек по эвристике
  let form = "", cat = "";
  for (const row of data) {
    const { r, a } = row;
    const q = parseRuNumber(r[cols.qty]);
    if (a && looksLeaf(a)) {
      const sums = readSums(r);
      const isRefForm = isVyrabotkaReferralForm(form);
      items.push({
        form: isRefForm ? "" : normalizeVyrabotkaOwnForm(form),
        sourceForm: vyrabotkaSourceForm(form),
        cat, n: a, q: q || 0,
        sOwn: isRefForm ? 0 : sums.sOwn,
        sRef: (isRefForm ? sums.sOwn : 0) + sums.sRef,
        goods: sums.goods,
      });
      continue;
    }
    if (!a) { if (q != null) form = ""; continue; } // безымянная форма участия
    if (isVyrabotkaReferralForm(a)) { form = "Направление"; continue; }
    if (isVyrabotkaOwnReferralForm(a)) { form = "По направлению"; continue; }
    if (doctorRaw && fioScore(a, doctorRaw) >= 0.85) { doctorRaw = a; continue; }
    if (looksFilial(a)) { form = ""; continue; }
    if (["Ассистент", "Направил", "Прочее участие"].includes(a)) { form = a; continue; }
    cat = a; // категория выработки
  }
  return { items, doctorRaw };
}

/* ============================================================
 * НАЗНАЧЕНИЯ (по врачу, за 1 или 3 месяца)
 * Иерархия: Направивший врач > [необязательные группы] > Номенклатура > документы.
 * Колонки: Количество назначено | Количество выполнено | Продажи (Кол-во, Сумма)
 * ============================================================ */
function naznachTotalsMatch(items, totals) {
  if (!totals) return false;
  const sums = items.reduce((acc, item) => {
    acc.assigned += item.a;
    acc.done += item.d;
    acc.soldQ += item.sq;
    acc.soldSum += item.ss;
    return acc;
  }, { assigned: 0, done: 0, soldQ: 0, soldSum: 0 });
  return Math.abs(sums.assigned - totals.assigned) < 0.5
    && Math.abs(sums.done - totals.done) < 0.5
    && Math.abs(sums.soldQ - totals.soldQ) < 0.5
    && Math.abs(sums.soldSum - totals.soldSum) < 1;
}

function selectNaznachItems(candidates, detailItems, ws, totals) {
  const variants = [];
  const fromDetails = [...detailItems.values()];
  if (fromDetails.length) variants.push(fromDetails);

  const levels = ws ? getRowLevels(ws) : null;
  let deepest = null;
  if (levels) {
    for (const shift of [0, 1]) {
      const byLevel = new Map();
      for (const row of candidates) {
        const level = levels[row.i + shift] || 0;
        if (!byLevel.has(level)) byLevel.set(level, []);
        byLevel.get(level).push(row.item);
      }
      const orderedLevels = [...byLevel.keys()].sort((a, b) => b - a);
      for (const level of orderedLevels) {
        const items = byLevel.get(level);
        if (!deepest && items.length) deepest = items;
        variants.push(items);
      }
    }
  }

  const all = candidates.map(row => row.item);
  variants.push(all);
  return variants.find(items => naznachTotalsMatch(items, totals))
    || fromDetails
    || deepest
    || all;
}

function isNaznachGoodsGroup(value) {
  return /^товары(?:\s|\(|$)/i.test(cellStr(value));
}

function parseNaznacheniya(rows, info, ws) {
  const hIdx = findRowIdx(rows, r => rowText(r).includes("Количество назначено"));
  if (hIdx < 0) throw new Error("не найдена шапка «Количество назначено»");
  const hr = (rows[hIdx] || []).map(cellStr);
  const cA = hr.findIndex(v => v === "Количество назначено");
  const cD = hr.findIndex(v => v === "Количество выполнено");
  const cP = hr.findIndex(v => v === "Продажи");
  if (cA < 0 || cD < 0) throw new Error("не найдены колонки назначено/выполнено");
  // «Продажи» — объединённая: ниже строка «Количество | Сумма»
  let cPQ = cP, cPS = cP + 1;
  const sub = (rows[hIdx + 1] || []).map(cellStr);
  const subQ = sub.findIndex((v, i) => i >= cP && v === "Количество");
  if (subQ >= 0) { cPQ = subQ; cPS = sub.findIndex((v, i) => i > subQ && v === "Сумма"); if (cPS < 0) cPS = subQ + 1; }
  let cDetailNomen = -1;
  for (let i = hIdx; i <= Math.min(hIdx + 3, rows.length - 1) && cDetailNomen < 0; i++) {
    cDetailNomen = (rows[i] || []).map(cellStr).findIndex(v => v === "Номенклатура");
  }

  const detailRe = /^(Прием|Оказание услуг|Заявка|Событие|Документ|Обращение|Чек|Счет|Лист)\s/;
  let doctorRaw = info.otborName || null;
  let docTotals = null;
  const candidates = [];
  // В новых вариантах отчёта промежуточные группы тоже содержат итоги.
  // Строки документов хранят фактическую номенклатуру — агрегируем их в первую очередь.
  const detailItems = new Map();
  const levels = ws ? getRowLevels(ws) : null;
  const hierarchy = {};
  const rememberHierarchy = (rowIndex, label) => {
    const level = levels ? (levels[rowIndex] || 0) : 0;
    for (const key of Object.keys(hierarchy)) {
      if (Number(key) >= level) delete hierarchy[key];
    }
    hierarchy[level] = label;
  };
  const inGoodsGroup = () => Object.values(hierarchy).some(isNaznachGoodsGroup);
  const sourceGroupPath = nomenclature => Object.entries(hierarchy)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, label]) => cellStr(label))
    .filter(label => label
      && label !== nomenclature
      && !(doctorRaw && fioScore(label, doctorRaw) >= 0.85));
  for (let i = hIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const a = cellStr(r[0]);
    if (!a) continue;
    if (a === "Итого") break;
    if (a === "Номенклатура/Специализация" || a === "Документ" || a === "Направивший врач") continue;
    const detailNomen = cDetailNomen >= 0 ? cellStr(r[cDetailNomen]) : "";
    if (detailNomen) {
      const goods = inGoodsGroup();
      const groupPath = sourceGroupPath(detailNomen);
      const detailKey = `${goods ? "goods" : "service"}\u0000${groupPath.join("\u0001")}\u0000${detailNomen}`;
      let item = detailItems.get(detailKey);
      if (!item) {
        item = { n: detailNomen, a: 0, d: 0, sq: 0, ss: 0, goods, groupPath };
        detailItems.set(detailKey, item);
      }
      item.a += parseRuNumber(r[cA]) || 0;
      item.d += parseRuNumber(r[cD]) || 0;
      item.sq += parseRuNumber(r[cPQ]) || 0;
      item.ss += parseRuNumber(r[cPS]) || 0;
      continue;
    }
    if (detailRe.test(a)) continue;
    rememberHierarchy(i, a);
    const assigned = parseRuNumber(r[cA]) || 0;
    const done = parseRuNumber(r[cD]) || 0;
    const soldQ = parseRuNumber(r[cPQ]) || 0;
    const soldSum = parseRuNumber(r[cPS]) || 0;
    // строка врача
    if ((doctorRaw && fioScore(a, doctorRaw) >= 0.85) || (!doctorRaw && !docTotals && fioTokens(a).length >= 2 && fioTokens(a).length <= 4 && assigned > 0)) {
      doctorRaw = a;
      docTotals = { assigned, done, soldQ, soldSum };
      continue;
    }
    if (assigned === 0 && done === 0 && soldQ === 0 && soldSum === 0) continue;
    const candidate = { i, item: { n: a, a: assigned, d: done, sq: soldQ, ss: soldSum, goods: inGoodsGroup(), groupPath: sourceGroupPath(a) } };
    candidates.push(candidate);
  }
  if (!doctorRaw) throw new Error("не удалось определить направившего врача");
  const items = selectNaznachItems(candidates, detailItems, ws, docTotals);
  if (!items.length) throw new Error("не найдено ни одной позиции назначений");
  const checked = naznachTotalsMatch(items, docTotals);
  return { doctorRaw, items, totals: docTotals, checked };
}

/* ---------- КЛИЕНТСКАЯ БАЗА / ДАВНОСТЬ ПОСЕЩЕНИЙ (по врачу, любое окно) ---------- */
function parseKB(rows, info) {
  const hIdx = findRowIdx(rows, r => cellStr(r[0]).replace(/\s/g, "") === "№п/п");
  if (hIdx < 0) throw new Error("не найдена шапка «№ п/п»");
  const hr = (rows[hIdx] || []).map(cellStr);
  const cSum = hr.findIndex(v => v === "Сумма");
  const cVis = hr.findIndex(v => v.includes("Количество посещений"));
  const cRec = hr.findIndex(v => v.includes("Давность"));
  const cName = hr.findIndex(v => /^(Клиент|Пациент|ФИО)$/i.test(v));
  const cId = hr.findIndex(v => /^(ID|Идентификатор|Код клиента|Код пациента|GUID)$/i.test(v));
  const clients = [];
  for (let i = hIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const num = parseRuNumber(r[0]);
    const name = cellStr(r[cName >= 0 ? cName : 1]);
    if (num == null || !name) {
      if (cellStr(r[0]) === "Итого" || rowText(r).trim() === "") continue;
      if (clients.length) break;
      continue;
    }
    clients.push({
      name,
      patientId: cId >= 0 ? (cellStr(r[cId]) || null) : null,
      s: parseRuNumber(r[cSum >= 0 ? cSum : 4]) || 0,
      v: parseRuNumber(r[cVis >= 0 ? cVis : 5]) || 0,
      r: parseRuNumber(r[cRec >= 0 ? cRec : 8]),
    });
  }
  if (!info.otborName) throw new Error("не удалось определить сотрудника (нет строки «Отбор»)");
  if (!clients.length) throw new Error("не найдено ни одного клиента");
  return { doctorRaw: info.otborName, clients };
}

/* ---------- ВОЗВРАЩАЕМОСТЬ ПЕРВИЧКИ (общая, окно 1/3/6/12 мес) ---------- */
function parsePervichka(rows, info, ws) {
  const hIdx = findRowIdx(rows, r => cellStr(r[0]) === "Врач");
  if (hIdx < 0) throw new Error("не найдена шапка «Врач»");
  const C = { visits: 6, first: 9, ret: 11, notRet: 12 };
  const levels = getRowLevels(ws);
  const dataRows = [];
  let itogoFirst = null;
  for (let i = hIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const name = cellStr(r[0]);
    if (!name) continue;
    if (name === "Клиент") continue;
    const row = { i, raw: name, visits: parseRuNumber(r[C.visits]) || 0, first: parseRuNumber(r[C.first]) || 0, ret: parseRuNumber(r[C.ret]) || 0, notRet: parseRuNumber(r[C.notRet]) || 0 };
    if (name === "Итого") { if (itogoFirst == null) itogoFirst = row.first; continue; }
    dataRows.push(row);
  }
  const body = dataRows;
  if (!body.length) throw new Error("нет данных после шапки");
  const candidates = [];
  if (levels) {
    for (const shift of [0, 1]) {
      const lv = d => levels[d.i + shift] || 0;
      const minLv = Math.min(...body.map(lv));
      candidates.push(body.filter(d => lv(d) === minLv));
    }
  }
  {
    const greedy = [];
    let k = 0;
    while (k < body.length) {
      const doc = body[k];
      greedy.push(doc);
      k++;
      let acc = 0;
      while (k < body.length && acc < doc.first) {
        acc += body[k].first;
        k++;
      }
    }
    candidates.push(greedy);
  }
  let perDoc = null;
  if (itogoFirst != null) {
    perDoc = candidates.find(c => c.length && c.length < body.length && Math.abs(c.reduce((a, d) => a + d.first, 0) - itogoFirst) < 0.5);
  }
  if (!perDoc) perDoc = candidates.find(c => c.length && c.length < body.length) || candidates[candidates.length - 1];
  if (!perDoc || !perDoc.length) throw new Error("не удалось выделить строки врачей");
  return { perDoc, checked: itogoFirst != null };
}

/* ---------- ПРОСТОЙ / ЗАГРУЗКА РАСПИСАНИЯ (общая, за месяц) ---------- */
function parseProstoy(rows) {
  const hIdx = findRowIdx(rows, r => cellStr(r[0]) === "Сотрудник" && rowText(r).includes("Продолжительность по графику"));
  if (hIdx < 0) throw new Error("не найдена шапка «Сотрудник … Продолжительность по графику»");
  // колонки по объединённой шапке (две строки)
  const hr1 = (rows[hIdx] || []).map(cellStr);
  const hr2 = (rows[hIdx + 1] || []).map(cellStr);
  const cGraf = hr1.findIndex(v => v.includes("Продолжительность по графику"));
  const cFact = hr1.findIndex(v => v.includes("Время работы с пациентом"));
  const cJournal = hr1.findIndex(v => v.includes("Загруженность по журналу"));
  let cZayavki = -1, cSched = -1, cZayavkiNv = -1, cSchedNv = -1;
  for (let c = 0; c < hr2.length; c++) {
    const v = hr2[c];
    if (v === "Занято заявками" && cZayavki < 0 && (cJournal < 0 || c >= cJournal)) cZayavki = c;
    else if (v.startsWith("Занятость расписания") && !v.includes("не выполненные") && cSched < 0) cSched = c;
    else if (v.startsWith("Занято заявками, вкл")) cZayavkiNv = c;
    else if (v.includes("вкл. не выполненные, %") || (v.startsWith("Занятость расписания, вкл"))) cSchedNv = c;
  }
  const perDoc = [];
  for (let i = hIdx + 2; i < rows.length; i++) {
    const r = rows[i] || [];
    const name = cellStr(r[0]);
    if (!name || name === "Итого") continue;
    const norma = parseHoursMin(r[cGraf >= 0 ? cGraf : 5]);
    const fact = parseHoursMin(r[cFact >= 0 ? cFact : 6]);
    const zayavki = parseHoursMin(r[cZayavki >= 0 ? cZayavki : 11]);
    const schedPct = parseRuNumber(r[cSched >= 0 ? cSched : 12]);
    const zayavkiNv = parseHoursMin(r[cZayavkiNv >= 0 ? cZayavkiNv : 13]);
    const schedNvPct = parseRuNumber(r[cSchedNv >= 0 ? cSchedNv : 14]);
    if (norma == null && fact == null && zayavki == null && schedPct == null) continue;
    perDoc.push({ raw: name, spec: cellStr(r[3]), normaMin: norma, factMin: fact, zayavkiMin: zayavki, schedPct, zayavkiNvMin: zayavkiNv, schedNvPct });
  }
  if (!perDoc.length) throw new Error("не найдено строк с данными");
  return { perDoc };
}

/* ---------- СОБСТВЕННАЯ ЗАПИСЬ В 1С (общая, за месяц) ---------- */
function parseZapis(rows) {
  const hIdx = findRowIdx(rows, r => cellStr(r[0]) === "Сотрудник" && rowText(r).includes("Записи на прием"));
  if (hIdx < 0) throw new Error("не найдена шапка «Сотрудник … Записи на прием»");
  const hr = rows[hIdx].map(cellStr);
  const col = name => hr.findIndex(v => v === name);
  const cCreated = col("Созданные клиенты"), cZapis = col("Записи на прием"), cOkaz = col("Оказания услуг"), cOther = col("Прочие события"), cTotal = col("Итого");
  if (cZapis < 0) throw new Error("не найдена колонка «Записи на прием»");
  let cDate = (rows[hIdx + 1] || []).map(cellStr).findIndex(v => v === "Дата выполнения");
  if (cDate < 0) cDate = 9;
  const perDoc = [];
  for (let i = hIdx + 2; i < rows.length; i++) {
    const r = rows[i] || [];
    const name = cellStr(r[0]);
    if (!name) continue;
    if (cellStr(r[cDate])) continue;
    if (name === "Итого") break;
    if (name === "Сотрудник не заполнен") continue;
    const total = parseRuNumber(r[cTotal]);
    if (total == null) continue;
    if (/^(Заявка|Событие|Документ|Обращение|Лист|Чек)/.test(name)) continue;
    perDoc.push({
      raw: name,
      created: parseRuNumber(r[cCreated]) || 0,
      zapis: parseRuNumber(r[cZapis]) || 0,
      okaz: parseRuNumber(r[cOkaz]) || 0,
      other: parseRuNumber(r[cOther]) || 0,
      total: total || 0,
    });
  }
  if (!perDoc.length) throw new Error("не найдено строк сотрудников");
  return { perDoc };
}

/* ---------- обработка файла ---------- */

function acceptSlotReplacement(label, existing, nextValue, log) {
  if (existing == null) return true;
  try {
    if (JSON.stringify(existing) === JSON.stringify(nextValue)) {
      log.status = "пропущено";
      log.skipReason = "identical";
      log.note = `${label}: в базе уже есть идентичные данные`;
      return false;
    }
  } catch (_) { /* comparison is only an optimization */ }
  if (!confirm(`${label}: за этот период данные уже загружены.\n\nЗаменить их новой версией? Предыдущее состояние останется в резервной копии перед импортом.`)) {
    log.status = "пропущено";
    log.skipReason = "kept-existing";
    log.note = `${label}: пользователь оставил предыдущую версию`;
    return false;
  }
  log.replaced = true;
  return true;
}

function finalizeFileLog(log) {
  DB.fileLog.unshift(Object.assign({ ts: Date.now() }, log));
  if (DB.fileLog.length > 300) DB.fileLog.length = 300;
  return log;
}

async function processFile(file) {
  const log = { name: file.name, type: null, doctor: null, period: null, month: null, status: "ошибка", note: "" };
  try {
    const buf = await file.arrayBuffer();
    loadBundledLibrary("lib-xlsx", "XLSX");
    const wb = XLSX.read(buf, { type: "array", cellStyles: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = sheetToRows(ws);
    const type = detectReportType(rows);
    if (!type) throw new Error("не удалось распознать тип отчёта 1С");
    log.type = type;
    const info = extractHeaderInfo(rows);
    if (!info.period) throw new Error("не найдена строка «Период: …»");
    if (!isFullMonthPeriod(info.period)) {
      throw new Error(`период ${periodStr(info.period)} неполный: расчёты принимают только целые календарные месяцы`);
    }
    log.period = periodStr(info.period);
    const nMonths = periodMonths(info.period);
    const monthKey = periodMonthKey(info.period);
    log.month = monthKey;

    if (type === "vyrabotka") {
      const res = parseVyrabotka(rows, info, ws);
      const docId = resolveDoctor(res.doctorRaw);
      log.doctor = doctorName(docId);
      const m = ensureMonth(monthKey);
      const nextValue = { items: res.items, period: info.period };
      if (!acceptSlotReplacement(`Выработка · ${log.doctor} · ${monthKey}`, m.vyrabotka[docId], nextValue, log)) return finalizeFileLog(log);
      m.vyrabotka[docId] = nextValue;
      log.slot = { t: "vyrabotka", mk: monthKey, doc: docId };
      log.status = "загружено";
      log.note = `позиций: ${res.items.length}` + (res.checked ? " ✓ сверено с «Итого»" : " ⚠ не сошлось с «Итого» — проверьте");
    } else if (type === "naznach") {
      const res = parseNaznacheniya(rows, info, ws);
      const docId = resolveDoctor(res.doctorRaw);
      log.doctor = doctorName(docId);
      const slice = String(nMonths);
      const m = ensureMonth(monthKey);
      if (!m.naznach[docId]) m.naznach[docId] = {};
      const nextValue = { period: info.period, items: res.items, totals: res.totals };
      if (!acceptSlotReplacement(`Назначения · ${log.doctor} · ${monthKey} · ${slice} мес.`, m.naznach[docId][slice], nextValue, log)) return finalizeFileLog(log);
      m.naznach[docId][slice] = nextValue;
      log.slot = { t: "naznach", mk: monthKey, doc: docId, sl: slice };
      log.status = "загружено";
      log.note = `назначения за ${slice} мес., позиций: ${res.items.length}` + (res.checked ? " ✓ сверено" : "");
    } else if (type === "kb") {
      const res = parseKB(rows, info);
      const docId = resolveDoctor(res.doctorRaw);
      log.doctor = doctorName(docId);
      const m = ensureMonth(monthKey);
      if (!m.kb[docId]) m.kb[docId] = {};
      const nextValue = { clients: res.clients, period: info.period };
      if (!acceptSlotReplacement(`Давность посещений · ${log.doctor} · ${monthKey} · ${nMonths} мес.`, m.kb[docId][String(nMonths)], nextValue, log)) return finalizeFileLog(log);
      m.kb[docId][String(nMonths)] = nextValue;
      log.slot = { t: "kb", mk: monthKey, doc: docId, sl: String(nMonths) };
      log.status = "загружено";
      log.note = `клиентов: ${res.clients.length}, окно ${nMonths} мес.`;
    } else if (type === "pervichka") {
      const res = parsePervichka(rows, info, ws);
      const slice = String(nMonths);
      const perDoc = {};
      for (const d of res.perDoc) {
        const id = resolveDoctor(d.raw);
        if (id) perDoc[id] = { visits: d.visits, first: d.first, ret: d.ret, notRet: d.notRet };
      }
      const m = ensureMonth(monthKey);
      const nextValue = { period: info.period, perDoc };
      if (!acceptSlotReplacement(`Возвращаемость первички · ${monthKey} · ${slice} мес.`, m.pervichka[slice], nextValue, log)) return finalizeFileLog(log);
      m.pervichka[slice] = nextValue;
      log.slot = { t: "pervichka", mk: monthKey, sl: slice };
      log.status = "загружено";
      log.doctor = "все (" + res.perDoc.length + ")";
      log.note = `срез ${slice} мес.` + (res.checked ? " ✓ сверено с «Итого»" : "");
    } else if (type === "prostoy") {
      const res = parseProstoy(rows);
      const m = ensureMonth(monthKey);
      if (Object.keys(m.prostoy).length && !acceptSlotReplacement(`Загрузка расписания · ${monthKey}`, m.prostoy, res.perDoc, log)) return finalizeFileLog(log);
      m.prostoy = {};
      for (const d of res.perDoc) {
        const id = resolveDoctor(d.raw);
        m.prostoy[id] = { spec: d.spec, normaMin: d.normaMin, factMin: d.factMin, zayavkiMin: d.zayavkiMin, schedPct: d.schedPct, zayavkiNvMin: d.zayavkiNvMin, schedNvPct: d.schedNvPct };
        if (d.spec && DB.doctors[id] && !DB.doctors[id].spec) DB.doctors[id].spec = d.spec;
      }
      log.slot = { t: "prostoy", mk: monthKey };
      log.status = "загружено";
      log.doctor = "все (" + res.perDoc.length + ")";
    } else if (type === "zapis") {
      const res = parseZapis(rows);
      const m = ensureMonth(monthKey);
      if (Object.keys(m.zapis).length && !acceptSlotReplacement(`Собственная запись в 1С · ${monthKey}`, m.zapis, res.perDoc, log)) return finalizeFileLog(log);
      m.zapis = {};
      for (const d of res.perDoc) {
        const id = resolveDoctor(d.raw);
        m.zapis[id] = { created: d.created, zapis: d.zapis, okaz: d.okaz, other: d.other, total: d.total };
      }
      log.slot = { t: "zapis", mk: monthKey };
      log.status = "загружено";
      log.doctor = "все (" + res.perDoc.length + ")";
    }
  } catch (e) {
    log.note = e.message;
    console.error("processFile", file.name, e);
  }
  return finalizeFileLog(log);
}

/* ---------- ZIP и папки ---------- */
async function expandZips(fileList) {
  const out = [];
  for (const f of [...fileList]) {
    if (/\.zip$/i.test(f.name)) {
      try {
        loadBundledLibrary("lib-jszip", "JSZip");
        if (DESKTOP_API) await ensureDesktopFileSource(f);
        const zip = await JSZip.loadAsync(await f.arrayBuffer());
        for (const [path, entry] of Object.entries(zip.files)) {
          if (entry.dir) continue;
          if (!/\.(xls|xlsx|json)$/i.test(path)) continue;
          const blob = await entry.async("blob");
          const extracted = new File([blob], path.split("/").pop());
          if (DESKTOP_API) {
            const sha256 = await sha256Blob(blob);
            Object.defineProperty(extracted, "__source", {
              value: {
                path: `${f.__source && f.__source.path ? f.__source.path : f.name}::${path}`,
                name: extracted.name,
                size: blob.size,
                modifiedAt: f.__source && f.__source.modifiedAt,
                sha256,
                container: f.__source || null,
              },
              configurable: true,
            });
          }
          out.push(extracted);
        }
      } catch (e) {
        toast("Не удалось открыть архив " + f.name + ": " + e.message, true);
      }
    } else {
      out.push(f);
    }
  }
  return out;
}

async function sha256Blob(blob) {
  const data = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function ensureDesktopFileSource(file) {
  if (!DESKTOP_API) return null;
  if (file.__source && file.__source.sha256) return file.__source;
  const source = {
    path: null,
    name: file.name,
    size: file.size,
    modifiedAt: file.lastModified ? new Date(file.lastModified).toISOString() : null,
    sha256: await sha256Blob(file),
  };
  Object.defineProperty(file, "__source", { value: source, configurable: true });
  return source;
}

function filesFromDataTransfer(dt) {
  const entries = [];
  if (dt.items) {
    for (const it of dt.items) {
      const e = it.webkitGetAsEntry && it.webkitGetAsEntry();
      if (e) entries.push(e);
    }
  }
  if (!entries.length) return Promise.resolve([...(dt.files || [])]);
  const out = [];
  const walk = async entry => {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej));
      out.push(f);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e);
      } while (batch.length);
    }
  };
  return (async () => {
    for (const e of entries) await walk(e);
    return out;
  })();
}

let fileImportInProgress = false;

async function handleFiles(fileList) {
  if (fileImportInProgress) {
    toast("Импорт уже выполняется — дождитесь его завершения");
    return null;
  }
  fileImportInProgress = true;
  const controlIds = ["btnPickFiles", "btnPickDir", "btnScanInput"];
  const controls = controlIds.map(id => document.getElementById(id)).filter(Boolean);
  const previousDisabled = controls.map(control => control.disabled);
  controls.forEach(control => { control.disabled = true; });
  const dropzone = document.getElementById("dropzone");
  if (dropzone) dropzone.setAttribute("aria-busy", "true");
  try {
    return await handleFilesBatch(fileList);
  } catch (error) {
    console.error("file import failed", error);
    toast("Импорт не завершён: " + error.message, true);
    return null;
  } finally {
    controls.forEach((control, index) => { control.disabled = previousDisabled[index]; });
    if (dropzone) dropzone.removeAttribute("aria-busy");
    fileImportInProgress = false;
  }
}

async function handleFilesBatch(fileList) {
  const expanded = await expandZips(fileList);
  let files = expanded.filter(f => /\.(xls|xlsx)$/i.test(f.name));
  const jsons = expanded.filter(f => /\.json$/i.test(f.name));
  if (jsons.length === 1 && !files.length) { importDBFile(jsons[0]); return; }
  if (!files.length) { toast("Не найдено файлов .xls/.xlsx (в папках и архивах — тоже)", true); return; }
  let duplicateSkipped = 0;
  if (DESKTOP_API) {
    const unique = [];
    for (const file of files) {
      const source = await ensureDesktopFileSource(file);
      if (!file.__forceReimport && (source.imported || await DESKTOP_API.hasImportedSource(source.sha256))) duplicateSkipped++;
      else unique.push(file);
    }
    files = unique;
  }
  if (!files.length) {
    toast(`Новых файлов нет. Уже обработано ранее: ${duplicateSkipped}`);
    return;
  }
  let ok = 0, err = 0, skipped = duplicateSkipped;
  let lastSave = Promise.resolve(false);
  let batchId = null;
  if (DESKTOP_API) {
    const batch = await DESKTOP_API.beginImport({ totalFiles: files.length });
    batchId = batch.batchId;
    toast("Перед импортом создана резервная копия");
  }
  const processed = [];
  for (const f of files) {
    const log = await processFile(f);
    processed.push({ file: f, log });
    if (log.status === "загружено") ok++;
    else if (log.status === "пропущено") skipped++;
    else err++;
    if (DESKTOP_API) {
      try {
        await DESKTOP_API.recordImport({ batchId, source: await ensureDesktopFileSource(f), log });
      } catch (error) {
        console.error("import history write failed", error);
        err++;
      }
    }
    // Не ждём окончания всей пачки: каждый обработанный файл сразу фиксируется локально
    // и ставится в очередь записи в файл автосохранения.
    lastSave = saveLocal();
  }
  await lastSave;
  if (DESKTOP_API) {
    const containers = new Map();
    for (const item of processed) {
      const container = item.file.__source && item.file.__source.container;
      if (!container || !container.sha256) continue;
      const state = containers.get(container.sha256) || { source: container, failed: false };
      if (item.log.status !== 'загружено' && item.log.skipReason !== 'identical') state.failed = true;
      containers.set(container.sha256, state);
    }
    for (const state of containers.values()) {
      if (!state.failed) {
        await DESKTOP_API.recordImport({
          batchId,
          source: state.source,
          log: { name: state.source.name, status: "архив обработан", note: "Все поддерживаемые файлы архива обработаны" },
        });
      }
    }
    await DESKTOP_API.finishImport({ batchId, counts: { loaded: ok, errors: err, skipped } });
  }
  renderAll();
  toast(`Обработано файлов: ${files.length}. Загружено: ${ok}` + (skipped ? `, пропущено: ${skipped}` : "") + (err ? `, с ошибками: ${err}` : ""), err > 0);
}
