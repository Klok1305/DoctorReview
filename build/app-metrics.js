"use strict";
/* ============================================================
 * МЕТРИКИ: векторы развития врача (по шаблону заведующей и ТЗ)
 * Нумерация векторов: 1 Экономика · 2 Экспертность и продукт ·
 * 3 Клиентская база · 4 Лояльность · 5 Междисциплинарный · 6 Репутация
 * ============================================================ */

/* Нумерация по порядку мамы: 1 Экономика · 2 Продукт · 3 Междисциплинарный ·
   4 Клиентская база · 5 Лояльность · 6 Репутация */
const VECTOR_META = {
  v1: { name: "Экономическая результативность", tag: "итоговый результат", cls: "mut", color: "#64748b" },
  v2: { name: "Экспертность и продукт", tag: "врач влияет напрямую", cls: "ok", color: "#16a34a" },
  v3: { name: "Междисциплинарный подход", tag: "врач влияет напрямую", cls: "ok", color: "#16a34a" },
  v4: { name: "Работа с клиентской базой", tag: "итоговый результат", cls: "mut", color: "#64748b" },
  v5: { name: "Лояльность и удержание", tag: "влияет частично", cls: "warn", color: "#d97706" },
  v6: { name: "Репутация и NPS", tag: "итоговый результат", cls: "mut", color: "#64748b" },
};

const REF_TYPES = ["Товары", "Приемы", "Анализы", "Профильные услуги", "Другие услуги клиники"];

/* Эффективный расчетный профиль врача: специализация либо отделение. */
function doctorDept(id) {
  return resolvedDeptName(id);
}
function deptParams(docId) {
  return profileForDoctor(docId); // профиль содержит плоские нормативы (minVisits, activeM, …)
}

/* ---------- классификация позиции по ПРОФИЛЮ отделения ---------- */
function classifyItem(profile, cat, n, goods) {
  const c = (cat || "").toLowerCase();
  const nl = (n || "").toLowerCase();
  const hay = c + " || " + nl;
  const ex = profile.expertise || { mode: "none", items: [], rules: [], hints: [] };

  // 0. ручное переопределение (редактор номенклатуры)
  const ov = profile.overrides ? profile.overrides[nl] : null;
  if (ov && ov.type) goods = ov.type === "товар" ? true : ov.type === "услуга" ? false : goods;

  // 1. привязка к экспертной позиции (фокус отделения) — только пометка,
  //    сама по себе НЕ определяет категорию выручки
  let expertItem = null, expertSyns = [];
  if (ov && "expertItem" in ov) expertItem = ov.expertItem || null;
  else if (ex.mode !== "none") {
    for (const [sub, itName] of ex.rules || []) {
      if (hay.includes(sub.toLowerCase())) { expertItem = itName; break; }
    }
    if (!expertItem) {
      outer:
      for (const src of [nl, c]) { // сначала номенклатура, затем категория 1С
        for (const it of ex.items || []) {
          for (const syn of it.syn || []) {
            if (src.includes(syn.toLowerCase())) { expertItem = it.name; break outer; }
          }
        }
      }
    }
  }
  if (expertItem) {
    const it = (ex.items || []).find(d => d.name === expertItem);
    expertSyns = it ? (it.syn || []).map(s => s.toLowerCase()) : [];
    expertSyns.push(expertItem.toLowerCase());
  }

  // приводит имя группы/подгруппы к каноническому ключу таксономии (без учёта регистра),
  // чтобы правило «узи = УЗИ» попало в группу «Узи» из списка категорий
  const canonGroup = g => {
    if (!g) return g;
    const keys = Object.keys(profile.groups);
    if (profile.groups[g] !== undefined) return g;
    const hit = keys.find(k => k.toLowerCase() === g.toLowerCase());
    return hit || g;
  };
  const canonSub = (g, sg) => {
    if (!sg) return sg;
    const subs = profile.groups[g] || [];
    if (subs.includes(sg)) return sg;
    const hit = subs.find(s => s.toLowerCase() === sg.toLowerCase());
    return hit || sg;
  };

  // 2. группа/подгруппа
  let group = ov && ov.group ? ov.group : null;
  let sub = ov && ov.group ? (ov.sub || "") : null;
  let devCandidate = false, unmapped = false;
  if (!group) {
    const tryRules = txt => {
      for (const rule of profile.rules || []) {
        const [substr, g, sg, kind] = rule;
        if (kind === "товар" && !goods) continue;
        if (kind === "услуга" && goods) continue;
        if (txt.includes(substr.toLowerCase())) return { g, sg: sg || "", substr: substr.toLowerCase() };
      }
      return null;
    };
    const res = tryRules(c) || tryRules(nl);
    // Приоритет: правило категории побеждает фокус-группу ТОЛЬКО если это осознанная
    // перекатегоризация именно этой позиции (подстрока правила входит в синоним фокуса).
    // Иначе (напр. «Кутера ... чистка» — «чистка» случайна) побеждает аппарат/фокус.
    const ruleIsSpecific = res && expertSyns.some(s => s.includes(res.substr));
    if (expertItem && ex.mode === "devices" && ex.group && !(res && ruleIsSpecific)) {
      group = ex.group; sub = expertItem;
    } else if (res) {
      group = res.g; sub = res.sg;
    } else if (expertItem && ex.group) {
      group = ex.group; sub = expertItem;
    } else {
      let hinted = false;
      for (const hint of ex.hints || []) {
        if (hay.includes(hint.toLowerCase())) { hinted = true; break; }
      }
      if (hinted && ex.mode !== "none" && ex.group) {
        group = ex.group; sub = "Без привязки"; devCandidate = true;
      } else if (goods) {
        group = profile.groups["Товары"] !== undefined ? "Товары" : Object.keys(profile.groups).pop();
        sub = (profile.groups["Товары"] || [])[0] || "";
        unmapped = true;
      } else {
        group = profile.groups["Другие услуги"] !== undefined ? "Другие услуги" : Object.keys(profile.groups).pop();
        sub = "Прочие"; unmapped = true;
      }
    }
  }
  group = canonGroup(group);
  sub = canonSub(group, sub);
  return { group, sub: sub || "", expertItem, devCandidate, unmapped };
}

/* Тип направления/назначения (Вектор 3 — междисциплинарный) */
function refTypeOf(cls) {
  if (cls.group === "Товары") return "Товары";
  if (cls.group === "Приемы") return "Приемы";
  if (cls.group === "Анализы") return "Анализы";
  if (cls.sub === "Прочие" || cls.group === "Другие услуги") return "Другие услуги клиники";
  return "Профильные услуги";
}

/* ---------- сводка по выработке (по профилю отделения врача) ---------- */
function vyrabotkaSummary(docId, monthKey) {
  const m = DB.months[monthKey];
  const v = m && m.vyrabotka[docId];
  if (!v) return null;
  const profile = profileForDoctor(docId);
  const out = {
    profile,
    ownSum: 0, ownQty: 0, assistSum: 0, assistQty: 0, refSum: 0, refQty: 0,
    byGroup: {},        // собственная выручка: группа -> {s, q, subs}
    expert: { items: {}, sum: 0 },  // экспертные позиции: имя -> {q, s}
    devCandidates: {},  // «похоже на экспертное, но не привязано»
    unmapped: {},       // нераспознанное: n -> {cat, q, s, goods}
    refByType: {},      // направления по типам -> {s, q, items: {n: {s, q}}}
  };
  const items = v.items || [];
  // В старых сохранённых импортах sourceForm ещё отсутствует. Положительные
  // позиции «Направления» уже отмечены через sRef; нулевые строки между ними
  // относятся к тому же непрерывному блоку и не должны попадать в В2.
  const legacyReferralIndexes = items
    .map((item, index) => (!item.sourceForm
      && !isVyrabotkaOwnReferralForm(item.form)
      && (item.sRef || 0) > 0
      && !(item.sOwn || 0) ? index : -1))
    .filter(index => index >= 0);
  const legacyReferralStart = legacyReferralIndexes.length ? legacyReferralIndexes[0] : -1;
  const legacyReferralEnd = legacyReferralIndexes.length ? legacyReferralIndexes[legacyReferralIndexes.length - 1] : -1;
  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const it = items[itemIndex];
    const cls = classifyItem(profile, it.cat, it.n, it.goods);
    const explicitSourceForm = cellStr(it.sourceForm).toLowerCase();
    const legacyForm = cellStr(it.form).toLowerCase();
    // В старом формате блок «По направлению» сохранялся в form, а его сумма —
    // ошибочно в sRef. Восстанавливаем исходный блок до расчёта метрик.
    const sourceForm = explicitSourceForm
      || (isVyrabotkaOwnReferralForm(legacyForm) ? "по направлению" : "");
    const rawOwn = it.sOwn || 0;
    const rawRef = it.sRef || 0;
    const legacyZeroReferral = !sourceForm
      && !rawOwn && !rawRef
      && itemIndex >= legacyReferralStart && itemIndex <= legacyReferralEnd;
    const fromReferralBlock = sourceForm === "направление" || legacyZeroReferral;
    const fromOwnBlock = sourceForm === "сотрудник" || sourceForm === "по направлению";
    let own = 0, ref = 0, assist = 0;
    if (fromReferralBlock) {
      // В3: врач направил пациента коллеге.
      ref = rawOwn + rawRef;
    } else if (fromOwnBlock) {
      // В2: собственная выработка врача. Сюда входят как основной блок
      // «Сотрудник», так и выполненные им услуги «По направлению».
      own = rawOwn + rawRef;
    } else if (!sourceForm && legacyForm === "") {
      // Старый импорт без sourceForm: поля сумм уже разделяли собственную
      // выработку и блок «Направление».
      own = rawOwn;
      ref = rawRef;
    } else {
      assist = rawOwn;
      ref = rawRef;
    }
    const quantity = it.q || 0;
    const qRef = fromReferralBlock
      ? quantity
      : (ref > 0 && own <= 0 ? quantity : 0);
    const qOwn = fromOwnBlock
      ? quantity
      : (fromReferralBlock ? 0 : (own > 0 || (!assist && !ref) ? quantity : 0));
    out.ownSum += own;
    out.assistSum += assist;
    out.refSum += ref;
    out.ownQty += qOwn;
    out.refQty += qRef;
    if (assist > 0) out.assistQty += quantity;
    if (own > 0 || (qOwn > 0 && !ref && !assist)) {
      if (!out.byGroup[cls.group]) out.byGroup[cls.group] = { s: 0, q: 0, subs: {} };
      const g = out.byGroup[cls.group];
      g.s += own;
      g.q += qOwn;
      const sub = cls.sub || "—";
      if (!g.subs[sub]) g.subs[sub] = { s: 0, q: 0 };
      g.subs[sub].s += own;
      g.subs[sub].q += qOwn;
      if (cls.expertItem) {
        if (!out.expert.items[cls.expertItem]) out.expert.items[cls.expertItem] = { q: 0, s: 0 };
        const e = out.expert.items[cls.expertItem];
        e.q += qOwn;
        e.s += own;
        out.expert.sum += own;
      }
      if (cls.devCandidate) {
        if (!out.devCandidates[it.n]) out.devCandidates[it.n] = { cat: it.cat, q: 0, s: 0 };
        out.devCandidates[it.n].q += qOwn;
        out.devCandidates[it.n].s += own;
      }
      if (cls.unmapped) {
        if (!out.unmapped[it.n]) out.unmapped[it.n] = { cat: it.cat, q: 0, s: 0, goods: it.goods };
        out.unmapped[it.n].q += qOwn;
        out.unmapped[it.n].s += own;
      }
    }
    if (ref > 0) {
      const t = refTypeOf(cls);
      if (!out.refByType[t]) out.refByType[t] = { s: 0, q: 0, items: {} };
      const bt = out.refByType[t];
      bt.s += ref;
      bt.q += qRef;
      if (!bt.items[it.n]) bt.items[it.n] = { s: 0, q: 0 };
      bt.items[it.n].s += ref;
      bt.items[it.n].q += qRef;
    }
  }
  // доля «экспертной» выручки = сумма фокусных позиций (широта × деньги),
  // независимо от того, в какие категории они разложены
  out.expertShareSum = out.expert.sum;
  return out;
}

/* ---------- сводка по назначениям (Вектор 3) ---------- */
function naznachSummary(docId, monthKey, slice) {
  const m = DB.months[monthKey];
  const nz = m && m.naznach && m.naznach[docId] && m.naznach[docId][String(slice)];
  if (!nz) return null;
  const profile = profileForDoctor(docId);
  const focusConfig = profile.crossFocus || { title: "Фокусы междисциплинарного подхода", items: [], rules: [] };
  const focusItems = focusConfig.items || [];
  const coreFocusNames = focusItems.filter(item => item.core !== false).map(item => item.name);
  const matchFocus = name => {
    const hay = String(name || "").toLowerCase();
    for (const [fragment, focusName] of focusConfig.rules || []) {
      if (fragment && hay.includes(String(fragment).toLowerCase())) return focusName;
    }
    for (const focus of focusItems) {
      const synonyms = (focus.syn && focus.syn.length ? focus.syn : [focus.name]).map(value => String(value).toLowerCase());
      if (synonyms.some(value => value && hay.includes(value))) return focus.name;
    }
    return null;
  };
  const out = {
    slice: Number(slice), period: nz.period,
    totals: { assigned: 0, done: 0, soldQ: 0, soldSum: 0, resultQ: 0 }, byType: {},
    sourceGroups: [],
    focus: focusItems.length ? {
      title: focusConfig.title || "Фокусы междисциплинарного подхода",
      items: {}, park: coreFocusNames.length, used: 0, usedNames: [],
      assigned: 0, done: 0, soldQ: 0, resultQ: 0,
    } : null,
  };
  const sourceGroupMap = new Map();
  let hasExplicitSourceGroups = false;
  for (const t of REF_TYPES) out.byType[t] = { assigned: 0, done: 0, soldQ: 0, soldSum: 0, resultQ: 0, items: {} };
  for (const it of nz.items) {
    const goods = Boolean(it.goods);
    const done = goods ? 0 : (it.d || 0);
    const soldQ = it.sq || 0;
    const resultQ = done + soldQ;
    const cls = classifyItem(profile, "", it.n, goods);
    const t = refTypeOf(cls);
    const b = out.byType[t];
    b.assigned += it.a; b.done += done; b.soldQ += soldQ; b.soldSum += it.ss; b.resultQ += resultQ;
    if (!b.items[it.n]) b.items[it.n] = { assigned: 0, done: 0, soldQ: 0, soldSum: 0, resultQ: 0, goods };
    const bi = b.items[it.n];
    bi.assigned += it.a; bi.done += done; bi.soldQ += soldQ; bi.soldSum += it.ss; bi.resultQ += resultQ;
    out.totals.assigned += it.a; out.totals.done += done; out.totals.soldQ += soldQ; out.totals.soldSum += it.ss; out.totals.resultQ += resultQ;
    const groupPath = Array.isArray(it.groupPath) ? it.groupPath.map(cellStr).filter(Boolean) : [];
    if (groupPath.length) hasExplicitSourceGroups = true;
    const groupKey = groupPath.length ? JSON.stringify(groupPath) : "__ungrouped__";
    if (!sourceGroupMap.has(groupKey)) {
      sourceGroupMap.set(groupKey, {
        path: groupPath.length ? groupPath : ["Без вида услуги / специализации в исходном отчёте"],
        assigned: 0, done: 0, soldQ: 0, soldSum: 0, resultQ: 0,
        items: {},
      });
    }
    const sourceGroup = sourceGroupMap.get(groupKey);
    sourceGroup.assigned += it.a;
    sourceGroup.done += done;
    sourceGroup.soldQ += soldQ;
    sourceGroup.soldSum += it.ss;
    sourceGroup.resultQ += resultQ;
    if (!sourceGroup.items[it.n]) sourceGroup.items[it.n] = { assigned: 0, done: 0, soldQ: 0, soldSum: 0, resultQ: 0, goods };
    const sourceItem = sourceGroup.items[it.n];
    sourceItem.assigned += it.a;
    sourceItem.done += done;
    sourceItem.soldQ += soldQ;
    sourceItem.soldSum += it.ss;
    sourceItem.resultQ += resultQ;
    if (out.focus) {
      const focusName = matchFocus(it.n);
      if (focusName) {
        if (!out.focus.items[focusName]) out.focus.items[focusName] = { assigned: 0, done: 0, soldQ: 0, resultQ: 0 };
        const fi = out.focus.items[focusName];
        fi.assigned += it.a; fi.done += done; fi.soldQ += soldQ; fi.resultQ += resultQ;
        out.focus.assigned += it.a;
        out.focus.done += done;
        out.focus.soldQ += soldQ;
        out.focus.resultQ += resultQ;
      }
    }
  }
  for (const t of REF_TYPES) {
    const b = out.byType[t];
    b.valid = b.assigned >= 0 && b.done >= 0 && b.soldQ >= 0 && b.resultQ <= b.assigned;
    b.issue = b.valid ? null : "выполнено + продано больше назначенного";
    b.conv = b.valid && b.assigned > 0 ? b.resultQ / b.assigned * 100 : null;
  }
  out.sourceGroups = hasExplicitSourceGroups ? [...sourceGroupMap.values()] : [];
  for (const group of out.sourceGroups) {
    group.valid = group.assigned >= 0 && group.done >= 0 && group.soldQ >= 0 && group.resultQ <= group.assigned;
    group.conv = group.valid && group.assigned > 0 ? group.resultQ / group.assigned * 100 : null;
  }
  out.totals.valid = out.totals.assigned >= 0 && out.totals.done >= 0 && out.totals.soldQ >= 0 && out.totals.resultQ <= out.totals.assigned;
  out.totals.issue = out.totals.valid ? null : "выполнено + продано больше назначенного";
  out.totals.conv = out.totals.valid && out.totals.assigned > 0 ? out.totals.resultQ / out.totals.assigned * 100 : null;
  if (out.focus) {
    out.focus.usedNames = coreFocusNames.filter(name => out.focus.items[name] && out.focus.items[name].resultQ > 0);
    out.focus.used = out.focus.usedNames.length;
  }
  return out;
}

/* ---------- клиентская база: окно + сегментация «визиты × давность» ---------- */
function kbWindow(docId, monthKey, win) {
  const m = DB.months[monthKey];
  const kb = m && m.kb[docId] && m.kb[docId][String(win)];
  return kb || null;
}
function kbAvailableWindows(docId, monthKey) {
  const m = DB.months[monthKey];
  if (!m || !m.kb[docId]) return [];
  return Object.keys(m.kb[docId]).map(Number).sort((a, b) => a - b);
}
function clientBaseThresholds(profile) {
  const p = profile || {};
  return {
    loyalVisits: Math.max(1, Number(p.loyalVisits) || Number(p.minVisits) || 3),
    loyalM: Math.max(1, Number(p.loyalM) || 12),
    activeVisits: Math.max(1, Number(p.activeVisits) || 3),
    activeM: Math.max(1, Number(p.activeM) || 6),
    newRiskVisits: Math.max(1, Number(p.newRiskVisits) || 2),
    newRiskM: Math.max(1, Number(p.newRiskM) || 6),
    sleepVisits: Math.max(1, Number(p.sleepVisits) || Number(p.loyalVisits) || Number(p.minVisits) || 3),
    sleepM: Math.max(1, Number(p.sleepM) || 6),
    lostVisits: Math.max(1, Number(p.lostVisits) || 2),
    lostM: Math.max(1, Number(p.lostM) || Number(p.riskM) || 12),
  };
}
function clientBaseRequiredWindow(profile) {
  const t = clientBaseThresholds(profile);
  return Math.max(t.loyalM, t.activeM, t.newRiskM, t.sleepM, t.lostM);
}
function clientBaseWindowSufficient(win, profile) {
  return Number(win) >= clientBaseRequiredWindow(profile);
}
function clientBaseGroupAvailability(win, profile) {
  const windowM = Number(win) || 0;
  const t = clientBaseThresholds(profile);
  return {
    loyal: windowM >= t.loyalM,
    active: windowM >= t.activeM,
    newRisk: windowM >= t.newRiskM,
    loyalSleep: windowM >= t.sleepM,
    lost: windowM >= t.lostM,
  };
}
function recommendedClientBaseWindow(availableWins, profile, requestedWin = null) {
  const wins = [...new Set((availableWins || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  if (!wins.length) return null;
  const requested = Number(requestedWin);
  if (wins.includes(requested)) return requested;
  // Переключение периода ручное: по умолчанию показываем 12 месяцев, а не подменяем его большим окном.
  return wins.includes(12) ? 12 : wins[0];
}
function selectedClientBaseSummary(result, profile, requestedWin = null) {
  if (!result || !result.akb) return null;
  if (requestedWin == null && result.akb.primary) return result.akb.primary;
  const win = recommendedClientBaseWindow(result.akb.availableWins, profile, requestedWin);
  return win == null ? null : (result.akb.wins[win] || null);
}
function kbSummary(docId, monthKey, win) {
  const kb = kbWindow(docId, monthKey, win);
  if (!kb) return null;
  const p = deptParams(docId);
  const t = clientBaseThresholds(p);
  const groupAvailable = clientBaseGroupAvailability(win, p);
  const sourceWindowComplete = clientBaseWindowSufficient(win, p);
  const requiredWindowM = clientBaseRequiredWindow(p);
  const dActive = Math.round(t.activeM * 30.44);
  const dLoyal = Math.round(t.loyalM * 30.44);
  const dNewRisk = Math.round(t.newRiskM * 30.44);
  const dSleep = Math.round(t.sleepM * 30.44);
  const dLost = Math.round(t.lostM * 30.44);
  const seg = {
    loyal: 0, active: 0, newRisk: 0, loyalSleep: 0, lost: 0, unknown: 0,
  };
  const groupSums = { loyal: 0, active: 0, newRisk: 0, loyalSleep: 0, lost: 0 };
  let totalSum = 0, totalVisits = 0, loyalCount = 0;
  const clientRows = kb.clients.map((c, index) => {
    const sum = Number(c.s) || 0;
    const visits = Number(c.v) || 0;
    totalSum += sum;
    totalVisits += visits;
    const recency = c.r == null || isNaN(c.r) ? null : Number(c.r);
    const loyal = groupAvailable.loyal && recency != null && visits >= t.loyalVisits && recency <= dLoyal;
    const groups = [];
    if (loyal) groups.push("loyal");
    if (groupAvailable.active && recency != null && visits >= t.activeVisits && recency <= dActive) groups.push("active");
    if (groupAvailable.newRisk && recency != null && visits >= 1 && visits <= t.newRiskVisits && recency > dNewRisk) groups.push("newRisk");
    if (groupAvailable.loyalSleep && recency != null && visits >= t.sleepVisits && recency > dSleep) groups.push("loyalSleep");
    if (groupAvailable.lost && recency != null && visits >= 1 && visits <= t.lostVisits && recency > dLost) groups.push("lost");
    if (recency == null) seg.unknown++;
    for (const group of groups) {
      seg[group]++;
      groupSums[group] += sum;
    }
    if (loyal) loyalCount++;
    const normalizedName = normFio(c.name || "");
    const normalizedId = String(c.patientId || "").trim().toLowerCase();
    return {
      key: normalizedId ? "id:" + normalizedId : (normalizedName ? "name:" + normalizedName : `doctor:${docId}:row:${index}`),
      patientId: c.patientId || null,
      name: c.name || `Пациент ${index + 1}`,
      s: sum, v: visits, r: recency,
      loyal, groups,
    };
  });
  for (const group of ["active", "newRisk", "loyalSleep", "lost"]) {
    if (!groupAvailable[group]) seg[group] = null;
  }
  // Старые имена оставлены как алиасы для совместимости остальных экранов.
  seg.risk = seg.newRisk;
  seg.sleep = seg.loyalSleep;
  const total = kb.clients.length;
  const sorted = [...kb.clients].sort((a, b) => b.s - a.s);
  const coreShare = (p.corePct || 80) / 100;
  let acc = 0, core = 0;
  for (const c of sorted) {
    if (acc >= totalSum * coreShare) break;
    acc += c.s; core++;
  }
  const courseCnt = kb.clients.filter(c => c.v >= p.courseX).length;
  const availableReactivationRows = clientRows.filter(c => c.groups.includes("newRisk") || c.groups.includes("loyalSleep"));
  const availableRiskRows = clientRows.filter(c => c.groups.includes("newRisk") || c.groups.includes("loyalSleep") || c.groups.includes("lost"));
  return {
    window: Number(win), period: kb.period, params: p, sourceWindowComplete, requiredWindowM, groupAvailable,
    thresholds: { ...t, loyalDays: dLoyal, activeDays: dActive, newRiskDays: dNewRisk, sleepDays: dSleep, lostDays: dLost },
    total, known: total - seg.unknown, seg, totalSum, totalVisits,
    activeSum: groupAvailable.active ? groupSums.active : null,
    riskSum: groupAvailable.newRisk ? groupSums.newRisk : null,
    sleepSum: groupAvailable.loyalSleep ? groupSums.loyalSleep : null,
    lostSum: groupAvailable.lost ? groupSums.lost : null,
    revenueAtRisk: availableRiskRows.reduce((sum, c) => sum + c.s, 0),
    reactivationCandidates: availableReactivationRows.length,
    reactivationSum: availableReactivationRows.reduce((sum, c) => sum + c.s, 0),
    clientRows,
    visits: totalVisits, patients: total,
    freq: total ? totalVisits / total : null,
    avgVisit: totalVisits ? totalSum / totalVisits : null,
    avgClient: total ? totalSum / total : null,
    one2: total - loyalCount,
    loyalCount,
    loyalPct: total ? loyalCount / total * 100 : null,
    activeBase: groupAvailable.active ? seg.active : null,
    activeBasePct: groupAvailable.active && total ? seg.active / total * 100 : null,
    newRiskPct: groupAvailable.newRisk && total ? seg.newRisk / total * 100 : null,
    loyalSleepPct: groupAvailable.loyalSleep && total ? seg.loyalSleep / total * 100 : null,
    lostPct: groupAvailable.lost && total ? seg.lost / total * 100 : null,
    riskShare: groupAvailable.newRisk && total ? seg.newRisk / total * 100 : null,
    sleepRiskShare: groupAvailable.newRisk && groupAvailable.loyalSleep && total
      ? clientRows.filter(c => c.groups.includes("newRisk") || c.groups.includes("loyalSleep")).length / total * 100
      : null,
    core,
    courseCnt,
    courseIdx: total ? courseCnt / total * 100 : null,
  };
}

/* ---------- главный расчёт ---------- */
/* Кэш расчётов: динамика и отделение зовут computeMetrics десятки раз.
   Сбрасывается при любом изменении данных/настроек (saveLocal). */
let _mcCache = new Map();
function clearMetricsCache() { _mcCache = new Map(); }

function computeMetrics(docId, monthKey) {
  const ck = docId + "|" + monthKey;
  if (_mcCache.has(ck)) return _mcCache.get(ck);
  const r = computeMetricsRaw(docId, monthKey);
  _mcCache.set(ck, r);
  return r;
}

function computeMetricsRaw(docId, monthKey) {
  const m = DB.months[monthKey];
  if (!m) return null;
  const vy = vyrabotkaSummary(docId, monthKey);
  const kbWins = kbAvailableWindows(docId, monthKey);
  const kb1 = kbSummary(docId, monthKey, 1);
  const kb12 = kbSummary(docId, monthKey, 12);
  const kb36 = kbSummary(docId, monthKey, 36);
  const naz1 = naznachSummary(docId, monthKey, 1);
  const naz3 = naznachSummary(docId, monthKey, 3);
  const prostoy = m.prostoy[docId];
  const zapis = m.zapis[docId];
  const man6 = (m.manual6 || {})[docId];
  const slices = Object.keys(m.pervichka).map(Number).sort((a, b) => a - b);
  const pvSlices = {};
  for (const s of slices) {
    const d = m.pervichka[String(s)].perDoc[docId];
    if (d) {
      const valid = d.first >= 0 && d.ret >= 0 && d.notRet >= 0 && d.ret <= d.first && Math.abs((d.ret + d.notRet) - d.first) < 0.5;
      pvSlices[s] = Object.assign({
        valid,
        issue: valid ? null : "вернулось + не вернулось должно равняться числу первичных",
        pct: valid && d.first > 0 ? d.ret / d.first * 100 : null,
      }, d);
    }
  }

  const hasAny = vy || kbWins.length || naz1 || naz3 || prostoy || zapis || man6 || Object.keys(pvSlices).length;
  if (!hasAny) return null;

  /* Трафик */
  const traffic = {
    visits: kb1 ? kb1.visits : null,
    patients: kb1 ? kb1.patients : null,
    freq: kb1 ? kb1.freq : null,
    freq12: kb12 ? kb12.freq : null,
    src: kb1 ? "из «Давности посещений» за месяц" : "нет выгрузки за месяц",
  };

  /* В1 Экономика */
  const sales = vy ? vy.ownSum : null;
  // Выручка от выполненных направлений берётся только из «Выработки».
  // «Назначения» остаются источником количества и конверсии, но не денег KPI.
  const refRevenue = vy ? vy.refSum : null;
  const revenueWithRef = sales != null ? sales + (refRevenue || 0) : null;
  const avgClient = (sales != null && traffic.patients) ? sales / traffic.patients : null;
  const avgVisit = (sales != null && traffic.visits) ? sales / traffic.visits : null;
  const avgClientRef = (revenueWithRef != null && traffic.patients) ? revenueWithRef / traffic.patients : null;

  // динамика среднего чека на пациента
  const avgClientAt = mk => {
    const mm = DB.months[mk];
    if (!mm) return null;
    const vv = vyrabotkaSummary(docId, mk);
    const k1 = kbSummary(docId, mk, 1);
    return (vv && k1 && k1.patients) ? vv.ownSum / k1.patients : null;
  };
  const prev1 = avgClientAt(prevMonthKey(monthKey, 1));
  const q = [1, 2, 3].map(b => avgClientAt(prevMonthKey(monthKey, b))).filter(v => v != null);
  const prevQ = q.length ? q.reduce((a, b) => a + b, 0) / q.length : null;
  const prevYearVals = [];
  const [yy] = monthKey.split("-").map(Number);
  for (let mm = 1; mm <= 12; mm++) {
    const v = avgClientAt((yy - 1) + "-" + String(mm).padStart(2, "0"));
    if (v != null) prevYearVals.push(v);
  }
  const prevY = prevYearVals.length ? prevYearVals.reduce((a, b) => a + b, 0) / prevYearVals.length : null;
  const deltaPct = (cur, base) => (cur != null && base) ? (cur - base) / base * 100 : null;

  const econ = {
    sales, assistSum: vy ? vy.assistSum : null,
    refRevenue, revenueWithRef,
    avgClient, avgVisit, avgClientRef,
    dynPrev: deltaPct(avgClient, prev1), dynQ: deltaPct(avgClient, prevQ), dynY: deltaPct(avgClient, prevY),
    prev1, prevQ, prevY,
  };

  /* В2 Экспертность: по профилю отделения (аппараты или услуги) */
  const profile = profileForDoctor(docId);
  const ex = profile.expertise;
  const coreNames = (ex.items || []).filter(d => d.core !== false).map(d => d.name);
  const usedNames = vy ? coreNames.filter(nm => vy.expert.items[nm] && vy.expert.items[nm].q > 0) : [];
  const product = vy ? {
    byGroup: vy.byGroup,
    mode: ex.mode,
    title: ex.title || "Экспертность",
    expert: vy.expert.items,          // имя -> {q, s}
    devicesUsed: usedNames.length,
    park: coreNames.length,
    expertShare: vy.ownSum > 0 ? vy.expertShareSum / vy.ownSum * 100 : null,
    devCandidates: vy.devCandidates,
    unmapped: vy.unmapped,
  } : null;

  /* В3 АКБ */
  const akb = { wins: {}, availableWins: kbWins.filter(w => [12, 24, 36].includes(w)) };
  for (const w of kbWins) akb.wins[w] = kbSummary(docId, monthKey, w);
  akb.primaryWin = recommendedClientBaseWindow(akb.availableWins, profile);
  akb.primary = akb.primaryWin == null ? null : (akb.wins[akb.primaryWin] || null);
  akb.churn36 = kb36 ? kb36.lostPct : null;

  /* В4 Лояльность */
  const sched = prostoy ? (() => {
    const norma = prostoy.normaMin;
    const busy = prostoy.zayavkiMin != null ? prostoy.zayavkiMin : null;
    const pct = (busy != null && norma) ? busy / norma * 100 : (prostoy.schedPct != null ? prostoy.schedPct : null);
    const factMin = prostoy.factMin;
    const factPct = (factMin != null && norma) ? factMin / norma * 100 : null;
    return {
      normaMin: norma, busyMin: busy, pct, factMin, factPct,
      gapMin: busy != null && factMin != null ? busy - factMin : null,
      gapPct: pct != null && factPct != null ? pct - factPct : null,
      nvPct: prostoy.schedNvPct,
    };
  })() : null;
  const ownRec = zapis ? {
    count: zapis.zapis,
    pct: traffic.visits ? zapis.zapis / traffic.visits * 100 : null,
  } : null;
  // Курсовое: только выгрузка с точным окном M месяцев.
  const pDept = deptParams(docId);
  const courseWin = kbWins.includes(pDept.courseM) ? pDept.courseM : null;
  const kbCourse = courseWin != null ? kbSummary(docId, monthKey, courseWin) : null;
  const loyalty = {
    sched, ownRec,
    pvSlices, slices,
    courseIdx: kbCourse ? kbCourse.courseIdx : null,
    courseCnt: kbCourse ? kbCourse.courseCnt : null,
    courseBase: kbCourse ? kbCourse.total : null,
    courseX: pDept.courseX,
    courseM: pDept.courseM,
    courseWin,
    freq12: traffic.freq12,
  };

  /* В5 Междисциплинарный */
  const cross = {
    naz: { 1: naz1, 3: naz3 },
    nazSlices: [naz1 ? 1 : null, naz3 ? 3 : null].filter(Boolean),
    refByType: vy ? vy.refByType : null,
    refSum: refRevenue,
    crossShare: (revenueWithRef && refRevenue != null) ? refRevenue / revenueWithRef * 100 : null,
  };

  /* В6 Репутация */
  let rep = null;
  if (man6) {
    const ratingKeys = ["prodoctorov", "napopravku", "doctu", "sberhealth"];
    const ratings = ratingKeys.map(k => man6[k]).filter(v => v != null && v >= 0 && v <= 5);
    const nps = man6.nps != null && man6.nps >= -100 && man6.nps <= 100 ? man6.nps : null;
    const reviews = man6.reviews != null && man6.reviews >= 0 ? man6.reviews : null;
    rep = {
      avgRating: ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null,
      nps,
      reviews,
      valid: ratings.length === ratingKeys.map(k => man6[k]).filter(v => v != null).length && (man6.nps == null || nps != null) && (man6.reviews == null || reviews != null),
      raw: man6,
    };
  }

  /* ---- Баллы: % выполнения нормативов ОТДЕЛЕНИЯ (профиль → «Баллы и веса»).
     Пустая цель = метрика не оценивается (пример: нет плана по выручке, но есть по чеку). ---- */
  const B = profile.scoring.benchmarks;
  const hasTarget = t => t != null && t !== "" && !isNaN(t) && Number(t) > 0;
  const achieve = (v, t, lower) => {
    if (v == null || isNaN(v) || !hasTarget(t)) return null;
    if (lower) return v <= 0 ? 1 : Math.min(t / v, 1);
    return Math.max(0, Math.min(v / t, 1));
  };
  const meanScore = arr => {
    const xs = arr.filter(x => x != null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length * 100 : null;
  };
  const expertSharePct = product ? product.expertShare : null;
  const nazBest = naz1 || naz3;
  const component = (value, target, lower = false, applicable = true) => ({
    expected: applicable && hasTarget(target),
    score: applicable && hasTarget(target) ? achieve(value, target, lower) : null,
  });
  const intrinsic = (score, applicable = true) => ({ expected: applicable, score: applicable ? score : null });
  const componentsScore = list => meanScore(list.filter(c => c.expected).map(c => c.score));
  const componentsCoverage = list => {
    const expected = list.filter(c => c.expected);
    return expected.length ? expected.filter(c => c.score != null).length / expected.length * 100 : null;
  };
  const v3ComponentsForNaz = nz => [
    component(cross.crossShare, B.crossShare),
    component(nz && nz.totals.valid !== false ? nz.totals.conv : null, B.nazConv),
  ];
  const v3ScoreForNaz = nz => componentsScore(v3ComponentsForNaz(nz));
  const v3ByNaz = {
    1: naz1 ? v3ScoreForNaz(naz1) : null,
    3: naz3 ? v3ScoreForNaz(naz3) : null,
  };
  const pvM = profile.pervichkaM || 3;
  const pvForScore = pvSlices[pvM] || null;
  const vectorComponents = {
    v1: [component(sales, B.revenue), component(avgClient, B.avgCheck)],
    // Широта набора — встроенный компонент В2, у неё нет отдельной цели.
    v2: ex.mode !== "none" ? [
      component(expertSharePct, B.hwShare),
      intrinsic(product && product.park ? product.devicesUsed / product.park : null, Boolean((ex.items || []).filter(d => d.core !== false).length)),
    ] : [],
    v3: v3ComponentsForNaz(nazBest),
    v4: [
      component(akb.primary ? akb.primary.activeBasePct : null, B.akbShare),
      component(akb.primary ? akb.primary.riskShare : null, B.riskShare, true),
      component(kb36 ? kb36.lostPct : null, B.churn, true),
    ],
    v5: [
      component(sched ? sched.pct : null, B.schedLoad),
      component(pvForScore && pvForScore.valid !== false ? pvForScore.pct : null, B.pervichka),
      component(ownRec ? ownRec.pct : null, B.ownRecords),
      component(loyalty.courseIdx, B.courseIdx),
    ],
    v6: [component(rep ? rep.avgRating : null, B.rating), component(rep ? rep.nps : null, B.nps), component(rep ? rep.reviews : null, B.reviews)],
  };
  const vecScores = {};
  const vectorCoverage = {};
  for (const [vk, components] of Object.entries(vectorComponents)) {
    vecScores[vk] = componentsScore(components);
    vectorCoverage[vk] = componentsCoverage(components);
  }
  const en = profile.scoring.enabled, W = profile.scoring.weights;
  const scoreTotalFor = vectors => {
    let weightSum = 0;
    for (const k of Object.keys(vectors)) {
      if (en[k] && vectors[k] != null) weightSum += W[k] || 0;
    }
    if (weightSum <= 0) return { total: null, wSum: 0 };
    let result = 0;
    for (const k of Object.keys(vectors)) {
      if (en[k] && vectors[k] != null) result += vectors[k] * ((W[k] || 0) / weightSum);
    }
    return { total: Math.round(result * 10) / 10, wSum: weightSum };
  };
  const baseTotal = scoreTotalFor(vecScores);
  let coverageWeight = 0, coveredWeight = 0;
  for (const vk of Object.keys(vecScores)) {
    if (!en[vk] || vectorCoverage[vk] == null || !(W[vk] > 0)) continue;
    coverageWeight += W[vk];
    coveredWeight += W[vk] * vectorCoverage[vk] / 100;
  }
  const coveragePct = coverageWeight ? Math.round(coveredWeight / coverageWeight * 1000) / 10 : null;
  const rankEligible = coveragePct != null && coveragePct >= 80;
  const totalByNaz = {};
  for (const slice of [1, 3]) {
    if (v3ByNaz[slice] == null) continue;
    totalByNaz[slice] = scoreTotalFor({ ...vecScores, v3: v3ByNaz[slice] }).total;
  }
  const scores = {
    vec: vecScores, total: baseTotal.total, wSum: baseTotal.wSum,
    vectorCoverage, coveragePct, rankEligible, preliminary: baseTotal.total != null && !rankEligible,
    v3ByNaz, totalByNaz,
  };

  /* полнота */
  const missing = [];
  if (!vy) missing.push("выработка");
  if (!kb1) missing.push("давность за месяц");
  if (!kb12) missing.push("давность ровно 12 мес для индекса возвращаемости");
  if (!akb.primary) missing.push("давность за 12, 24 или 36 мес для клиентской базы");
  if (!kb36) missing.push("давность 3 года");
  if (!naz1 && !naz3) missing.push("назначения");
  if (!prostoy) missing.push("загрузка расписания");
  if (!zapis) missing.push("запись в 1С");
  if (!pvForScore) missing.push(`первичка ровно ${pvM} мес`);
  if (courseWin == null) missing.push(`давность ровно ${pDept.courseM} мес для курсового`);

  return {
    traffic, econ, product, akb, loyalty, cross, rep, scores,
    missing, partial: missing.length > 0,
    extras: { vy, kb1, kb12, kb36, naz1, naz3, prostoy, zapis, man6, slices, pvSlices, revenue: sales, revenueWithRef },
  };
}

/* Врачи месяца */
function doctorsInMonth(monthKey) {
  const m = DB.months[monthKey];
  if (!m) return [];
  const set = new Set();
  for (const src of ["vyrabotka", "kb", "naznach", "prostoy", "zapis"]) {
    Object.keys(m[src] || {}).forEach(id => set.add(id));
  }
  for (const sl of Object.values(m.pervichka)) {
    Object.keys(sl.perDoc).forEach(id => set.add(id));
  }
  return [...set].sort((a, b) => doctorName(a).localeCompare(doctorName(b), "ru"));
}
function coreDoctorsInMonth(monthKey) {
  const m = DB.months[monthKey];
  if (!m) return [];
  const set = new Set([...Object.keys(m.vyrabotka), ...Object.keys(m.kb), ...Object.keys(m.naznach || {})]);
  return [...set].sort((a, b) => doctorName(a).localeCompare(doctorName(b), "ru"));
}
function monthKeysSorted() {
  return Object.keys(DB.months).sort();
}

/* Вся номенклатура ОТДЕЛЕНИЯ (по врачам этого отделения за все месяцы):
   основа редактора «распихать номенклатуру» и списков неразобранного */
function collectDeptItems(deptName) {
  const profile = deptProfile(deptName);
  const map = new Map();
  for (const m of Object.values(DB.months)) {
    for (const [docId, v] of Object.entries(m.vyrabotka)) {
      if (resolvedDeptName(docId) !== deptName) continue;
      for (const it of v.items) {
        const key = it.n.toLowerCase();
        if (!map.has(key)) map.set(key, { n: it.n, cat: it.cat, q: 0, s: 0, goods: !!it.goods });
        const e = map.get(key);
        e.q += it.q || 0;
        e.s += (it.sOwn || 0) + (it.sRef || 0);
        if (it.goods) e.goods = true;
      }
    }
  }
  const out = [...map.values()];
  for (const e of out) {
    e.cls = classifyItem(profile, e.cat, e.n, e.goods);
    e.override = profile.overrides ? profile.overrides[e.n.toLowerCase()] : null;
  }
  return out.sort((a, b) => b.s - a.s);
}
function collectDeviceCandidates(deptName) {
  return collectDeptItems(deptName).filter(e => e.cls.devCandidate);
}
function deptListForMonth(monthKey, ids) {
  const set = new Set();
  for (const id of ids) set.add(doctorDept(id));
  return [...set].sort((a, b) => a.localeCompare(b, "ru"));
}

/* ============================================================
 * ДИНАМИКА: изменение показателей по месяцам, точки роста и риска
 * ============================================================ */

/* Метрики динамики. getter(r) — из результата computeMetrics.
   Цели — из профиля отделения (для сводной по всем — «По умолчанию»). */
function dynMetricDefs(profile) {
  const B = (profile && profile.scoring && profile.scoring.benchmarks) || defaultBenchmarks();
  const pvM = (profile && profile.pervichkaM) || 3;
  const exTitle = (profile && profile.expertise && profile.expertise.title) || "экспертных услуг";
  const baseThresholds = clientBaseThresholds(profile);
  const base = r => selectedClientBaseSummary(r, profile);
  return [
    { key: "sales", name: "Выручка", fmt: fmtMoney, get: r => r.econ.sales, target: B.revenue },
    { key: "withRef", name: "Выручка с перенаправлениями", fmt: fmtMoney, get: r => r.econ.revenueWithRef },
    { key: "avgClient", name: "Средний чек на пациента", fmt: fmtMoney, get: r => r.econ.avgClient, target: B.avgCheck },
    { key: "visits", name: "Визиты", fmt: v => fmtNum(v), get: r => r.traffic.visits },
    { key: "patients", name: "Пациенты", fmt: v => fmtNum(v), get: r => r.traffic.patients },
    { key: "freq", name: "Частота за месяц (виз./пациента)", fmt: v => fmtNum(v, 2), get: r => r.traffic.freq },
    { key: "return12", name: "Индекс возвращаемости за год (виз./пациента)", fmt: v => fmtNum(v, 2), get: r => r.loyalty.freq12 },
    { key: "sched", name: "Загрузка расписания", fmt: fmtPct, get: r => r.loyalty.sched ? r.loyalty.sched.pct : null, target: B.schedLoad },
    { key: "perv", name: `Возвращаемость первички (${pvM} мес)`, fmt: fmtPct, get: r => r.loyalty.pvSlices[pvM] ? r.loyalty.pvSlices[pvM].pct : null, target: B.pervichka },
    { key: "ownRec", name: "Собственная запись в 1С", fmt: fmtPct, get: r => r.loyalty.ownRec ? r.loyalty.ownRec.pct : null, target: B.ownRecords },
    { key: "course", name: "Курсовое лечение", fmt: fmtPct, get: r => r.loyalty.courseIdx, target: B.courseIdx },
    { key: "hw", name: `Доля: ${exTitle}`, fmt: fmtPct, get: r => r.product ? r.product.expertShare : null, target: B.hwShare },
    { key: "cross", name: "Доля выручки от выполненных направлений", fmt: fmtPct, get: r => r.cross.crossShare, target: B.crossShare },
    { key: "nazConv", name: "Конверсия назначений (1 мес)", fmt: fmtPct, get: r => r.cross.naz[1] ? r.cross.naz[1].totals.conv : null, target: B.nazConv },
    { key: "nazFocusAssigned", name: "Назначено по фокусам (1 мес)", fmt: v => fmtNum(v) + " шт.", get: r => r.cross.naz[1] && r.cross.naz[1].focus ? r.cross.naz[1].focus.assigned : null },
    { key: "nazFocusResult", name: "Выполнено + продано по фокусам (1 мес)", fmt: v => fmtNum(v) + " шт.", get: r => r.cross.naz[1] && r.cross.naz[1].focus ? r.cross.naz[1].focus.resultQ : null },
    { key: "akb", name: `Активные (≥${fmtNum(baseThresholds.activeVisits)} виз. за ${fmtNum(baseThresholds.activeM)} мес.)`, fmt: v => fmtNum(v) + " чел.", get: r => { const kb = base(r); return kb && kb.groupAvailable.active ? kb.seg.active : null; } },
    { key: "lost", name: `Потерянные (1–2 виз., отсутствуют >${fmtNum(baseThresholds.lostM)} мес.)`, fmt: v => fmtNum(v) + " чел.", get: r => { const kb = base(r); return kb && kb.groupAvailable.lost ? kb.seg.lost : null; }, lower: true },
    { key: "score", name: "Общий балл", fmt: v => fmtNum(v, 0), get: r => DB.settings.showScores && r.scores ? r.scores.total : null },
  ];
}

/* Общая машинка: series[mk] -> r-подобный объект; строит строки динамики */
function buildDynamics(monthsAll, endMk, getResult, maxMonths, profile) {
  const months = monthsAll.filter(k => k <= endMk).slice(-(maxMonths || 6));
  const results = {};
  for (const k of months) results[k] = getResult(k);
  const defs = dynMetricDefs(profile);
  const rows = [];
  for (const d of defs) {
    const values = months.map(k => {
      const r = results[k];
      const v = r ? d.get(r) : null;
      return v == null || isNaN(v) ? null : v;
    });
    const nonNull = values.filter(v => v != null);
    if (!nonNull.length) continue;
    const cur = values[values.length - 1];
    // Сравниваем именно с предыдущим отображаемым месяцем, не перескакивая через пропуски.
    const prev = values.length >= 2 ? values[values.length - 2] : null;
    // Среднее прошедшего периода: все отображаемые месяцы до текущего, текущий не включаем.
    const priorValues = values.slice(0, -1).filter(v => v != null);
    const prevAvg = priorValues.length ? priorValues.reduce((a, b) => a + b, 0) / priorValues.length : null;
    const delta = (cur != null && prev != null && prev !== 0) ? (cur - prev) / Math.abs(prev) * 100 : null;
    const deltaAvg = (cur != null && prevAvg != null && prevAvg !== 0) ? (cur - prevAvg) / Math.abs(prevAvg) * 100 : null;
    const improving = delta == null || Math.abs(delta) < 0.0001 ? null : (d.lower ? delta < 0 : delta > 0);
    const improvingAvg = deltaAvg == null || Math.abs(deltaAvg) < 0.0001 ? null : (d.lower ? deltaAvg < 0 : deltaAvg > 0);
    const belowTarget = (cur != null && d.target) ? (d.lower ? cur > d.target : cur < d.target) : false;
    rows.push({
      key: d.key, name: d.name, fmt: d.fmt, lower: !!d.lower, target: d.target || null,
      values, cur, prev, prevAvg, delta, deltaAvg, improving, improvingAvg, belowTarget,
    });
  }
  // точки роста: улучшение ≥ 5%; точки риска: ухудшение ≥ 5% или сильное недовыполнение цели
  const growth = rows.filter(x => x.delta != null && x.improving && Math.abs(x.delta) >= 5)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const risk = rows.filter(x => (x.delta != null && x.improving === false && Math.abs(x.delta) >= 5) || (x.belowTarget && x.target && x.cur != null && (x.lower ? x.cur / x.target > 1.5 : x.cur / x.target < 0.6)))
    .sort((a, b) => Math.abs(b.delta || 0) - Math.abs(a.delta || 0));
  return { months, rows, growth, risk, results };
}

function computeDoctorDynamics(docId, endMk) {
  return buildDynamics(monthKeysSorted(), endMk, k => computeMetrics(docId, k), 6, profileForDoctor(docId));
}

/* Агрегат отделения за месяц — «виртуальный r» с теми же полями, что читают dynMetricDefs */
function aggregateDeptMonth(mk, deptFilter, subFilter = "all") {
  const core = coreDoctorsInMonth(mk);
  const requestedSpecs = Array.isArray(deptFilter)
    ? new Set(deptFilter)
    : (deptFilter instanceof Set ? deptFilter : null);
  const ids = (core.length ? core : doctorsInMonth(mk)).filter(id =>
    (deptFilter === "all" || (requestedSpecs ? requestedSpecs.has(doctorDept(id)) : doctorDept(id) === deptFilter)) &&
    (subFilter === "all" || (DB.doctors[id] && DB.doctors[id].subdept) === subFilter)
  );
  if (!ids.length) return null;
  const records = ids.map(id => ({ id, r: computeMetrics(id, mk) })).filter(x => Boolean(x.r));
  const rs = records.map(x => x.r);
  if (!rs.length) return null;
  const sum = get => { const xs = rs.map(get).filter(v => v != null && !isNaN(v)); return xs.length ? xs.reduce((a, b) => a + b, 0) : null; };
  const avg = get => { const xs = rs.map(get).filter(v => v != null && !isNaN(v)); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
  const uniqueClientBase = (baseRows, expectedCount = baseRows.length) => {
    const clients = new Map();
    for (const kb of baseRows) {
      for (const c of kb.clientRows) {
        const old = clients.get(c.key);
        if (!old) clients.set(c.key, { ...c, groups: [...(c.groups || [])] });
        else {
          old.v += c.v || 0;
          old.s += c.s || 0;
          if (c.r != null && (old.r == null || c.r < old.r)) old.r = c.r;
          old.loyal = old.loyal || c.loyal;
          old.groups = [...new Set([...(old.groups || []), ...(c.groups || [])])];
        }
      }
    }
    if (!baseRows.length) return null;
    const groupNames = ["loyal", "active", "newRisk", "loyalSleep", "lost"];
    const allDoctorsCovered = baseRows.length === expectedCount;
    const groupAvailable = Object.fromEntries(groupNames.map(group => [group, allDoctorsCovered && baseRows.every(kb => kb.groupAvailable && kb.groupAvailable[group])]));
    const seg = { loyal: 0, active: 0, newRisk: 0, loyalSleep: 0, lost: 0, unknown: 0 };
    let visits = 0, totalSum = 0, loyalCount = 0;
    for (const c of clients.values()) {
      for (const group of (c.groups || [])) if (Object.prototype.hasOwnProperty.call(seg, group)) seg[group]++;
      if (c.r == null) seg.unknown++;
      visits += c.v || 0;
      totalSum += c.s || 0;
      if (c.loyal) loyalCount++;
    }
    for (const group of groupNames) if (!groupAvailable[group]) seg[group] = null;
    seg.risk = seg.newRisk;
    seg.sleep = seg.loyalSleep;
    const total = clients.size;
    const sourceWindowComplete = allDoctorsCovered && baseRows.every(kb => kb.sourceWindowComplete);
    const windows = [...new Set(baseRows.map(kb => Number(kb.window)).filter(Number.isFinite))].sort((a, b) => a - b);
    const clientRows = [...clients.values()];
    const atRiskRows = clientRows.filter(c => (c.groups || []).some(group => ["newRisk", "loyalSleep", "lost"].includes(group)));
    return {
      total, seg, clientRows, visits, totalSum, loyalCount,
      loyalPct: groupAvailable.loyal && total ? loyalCount / total * 100 : null,
      activeBasePct: groupAvailable.active && total ? seg.active / total * 100 : null,
      newRiskPct: groupAvailable.newRisk && total ? seg.newRisk / total * 100 : null,
      loyalSleepPct: groupAvailable.loyalSleep && total ? seg.loyalSleep / total * 100 : null,
      riskShare: groupAvailable.newRisk && total ? seg.newRisk / total * 100 : null,
      lostPct: groupAvailable.lost && total ? seg.lost / total * 100 : null,
      revenueAtRisk: atRiskRows.reduce((sum, c) => sum + (c.s || 0), 0),
      sourceWindowComplete, groupAvailable,
      requiredWindowM: baseRows.reduce((max, kb) => Math.max(max, Number(kb.requiredWindowM) || 0), 0),
      windows,
      coveredDoctors: baseRows.length,
      expectedDoctors: expectedCount,
    };
  };
  const uniqueWindow = win => uniqueClientBase(records.map(({ r }) => r.akb.wins[win]).filter(Boolean), records.length);
  const unique1 = uniqueWindow(1);
  const unique12 = uniqueWindow(12);
  const primaryBase = uniqueClientBase(records.map(({ r }) => r.akb.primary).filter(Boolean), records.length);
  const sales = sum(r => r.econ.sales);
  const withRef = sum(r => r.econ.revenueWithRef);
  const refSum = sum(r => r.econ.refRevenue);
  const visits = sum(r => r.traffic.visits);
  const patients = unique1 ? unique1.total : sum(r => r.traffic.patients);
  const visits12 = unique12 ? unique12.visits : null;
  const patients12 = unique12 ? unique12.total : null;
  const expSum = sum(r => r.extras.vy ? r.extras.vy.expertShareSum : null);
  const ownSum = sum(r => r.extras.vy ? r.extras.vy.ownSum : null);
  const pvMonths = [...new Set([3, 6, 12, ...rs.flatMap(r => Object.keys(r.loyalty.pvSlices || {}).map(Number))])].sort((a, b) => a - b);
  const pvSlices = {};
  for (const pvM of pvMonths) {
    const first = sum(r => r.loyalty.pvSlices[pvM] && r.loyalty.pvSlices[pvM].valid !== false ? r.loyalty.pvSlices[pvM].first : null);
    const ret = sum(r => r.loyalty.pvSlices[pvM] && r.loyalty.pvSlices[pvM].valid !== false ? r.loyalty.pvSlices[pvM].ret : null);
    if (first != null && first > 0) pvSlices[pvM] = { pct: (ret || 0) / first * 100, first, ret: ret || 0 };
  }
  const schedNorm = sum(r => r.loyalty.sched ? r.loyalty.sched.normaMin : null);
  const schedBusy = sum(r => r.loyalty.sched ? r.loyalty.sched.busyMin : null);
  const schedFact = sum(r => r.loyalty.sched ? r.loyalty.sched.factMin : null);
  const schedAvg = avg(r => r.loyalty.sched ? r.loyalty.sched.pct : null);
  const nazA = sum(r => r.cross.naz[1] && r.cross.naz[1].totals.valid !== false ? r.cross.naz[1].totals.assigned : null);
  const nazD = sum(r => r.cross.naz[1] && r.cross.naz[1].totals.valid !== false ? r.cross.naz[1].totals.resultQ : null);
  const ownRecords = sum(r => r.loyalty.ownRec ? r.loyalty.ownRec.count : null);
  const courseCnt = sum(r => r.loyalty.courseCnt);
  const courseBase = sum(r => r.loyalty.courseBase);
  // «виртуальный r» отделения
  return {
    econ: { sales, refRevenue: refSum, revenueWithRef: withRef, avgClient: (sales != null && patients) ? sales / patients : null },
    traffic: { visits, patients, freq: (visits != null && patients) ? visits / patients : null },
    loyalty: {
      sched: schedNorm && schedBusy != null
        ? {
          pct: schedBusy / schedNorm * 100,
          factPct: schedFact != null ? schedFact / schedNorm * 100 : null,
          gapPct: schedFact != null ? (schedBusy - schedFact) / schedNorm * 100 : null,
          normaMin: schedNorm, busyMin: schedBusy, factMin: schedFact,
        }
        : (schedAvg != null ? { pct: schedAvg } : null),
      pvSlices,
      ownRec: ownRecords != null && visits ? { count: ownRecords, pct: ownRecords / visits * 100 } : null,
      courseIdx: courseCnt != null && courseBase ? courseCnt / courseBase * 100 : null,
      freq12: (visits12 != null && patients12) ? visits12 / patients12 : null,
    },
    cross: {
      crossShare: (withRef && refSum != null) ? refSum / withRef * 100 : null,
      naz: { 1: (nazA != null && nazA > 0) ? { totals: { conv: nazD / nazA * 100 } } : null },
    },
    akb: {
      primary: primaryBase,
      primaryWin: primaryBase && primaryBase.windows.length === 1 ? primaryBase.windows[0] : null,
      availableWins: [...new Set(rs.flatMap(r => r.akb.availableWins || []))].sort((a, b) => a - b),
      wins: { 12: unique12 },
    },
    product: (ownSum != null && ownSum > 0) ? { expertShare: (expSum || 0) / ownSum * 100 } : null,
    extras: { vy: (ownSum != null && ownSum > 0) ? { ownSum, expertShareSum: expSum || 0 } : null },
    scores: { total: avg(r => r.scores && r.scores.rankEligible ? r.scores.total : null) },
    vecAvg: (() => { const o = {}; for (const vk of ["v1","v2","v3","v4","v5","v6"]) o[vk] = avg(r => r.scores && r.scores.rankEligible ? r.scores.vec[vk] : null); return o; })(),
    doctors: rs.length,
  };
}

function computeDeptDynamics(endMk, deptFilter, subFilter = "all") {
  const profile = typeof deptFilter === "string" && deptFilter !== "all" ? deptProfile(deptFilter) : deptProfile("По умолчанию");
  return buildDynamics(monthKeysSorted(), endMk, k => aggregateDeptMonth(k, deptFilter || "all", subFilter), 6, profile);
}
