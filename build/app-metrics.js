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
        // Общие правила вроде «прием»/«узи» не должны перехватывать товар:
        // «раствор для приема внутрь» и «смузи» — реальные примеры из 1С.
        if (goods && kind !== "товар" && g !== "Товары") continue;
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
  return { group, sub: sub || "", expertItem, devCandidate, unmapped, goods: Boolean(goods) };
}

/* Тип направления/назначения (Вектор 3 — междисциплинарный) */
function refTypeOf(cls) {
  if (cls.group === "Товары") return "Товары";
  if (cls.group === "Приемы") return "Приемы";
  if (cls.group === "Анализы") return "Анализы";
  if (cls.sub === "Прочие" || cls.group === "Другие услуги") return "Другие услуги клиники";
  return "Профильные услуги";
}

function crossFocusMatch(profile, name) {
  const focusConfig = (profile && profile.crossFocus) || { items: [], rules: [] };
  const focusItems = Array.isArray(focusConfig.items) ? focusConfig.items : [];
  const hay = String(name || "").toLocaleLowerCase("ru-RU");
  const byName = focusName => {
    const key = interdisciplinaryServiceKey(focusName);
    return focusItems.find(item => interdisciplinaryServiceKey(item.name) === key)
      || (focusName ? { name: String(focusName) } : null);
  };
  for (const [fragment, focusName] of (focusConfig.rules || [])) {
    if (fragment && hay.includes(String(fragment).toLocaleLowerCase("ru-RU"))) return byName(focusName);
  }
  for (const focus of focusItems) {
    const synonyms = [...new Set([focus.name, ...((focus.syn && focus.syn.length) ? focus.syn : [])])]
      .map(value => String(value).toLocaleLowerCase("ru-RU"));
    if (synonyms.some(value => value && hay.includes(value))) return focus;
  }
  return null;
}

/* Точная привязка строки номенклатуры имеет приоритет над привязкой фокуса.
 * Приём остаётся приёмом, остальные домашние услуги становятся профильными;
 * услуги другого отделения уходят в общий междисциплинарный блок. */
function interdisciplinaryRefType(cls, focus, docId, nomenclatureName, groupPath = []) {
  const legacyType = refTypeOf(cls);
  // Домашнее подразделение распределяет только услуги, для которых нет
  // самостоятельной категории. Товары, приёмы и анализы не должны
  // превращаться в «Другие услуги клиники» из-за чужого подразделения.
  if (["Товары", "Приемы", "Анализы"].includes(legacyType)) return legacyType;
  const homeDepartment = resolvedInterdisciplinaryHomeDepartment(nomenclatureName, focus, groupPath);
  if (!homeDepartment) return legacyType;
  if (homeDepartment !== resolvedDepartmentName(docId)) return "Другие услуги клиники";
  return "Профильные услуги";
}

function referralRevenueDecision(profile, referralType, homeDepartment, nomenclatureName = "") {
  const override = profile && profile.overrides && profile.overrides[nomenclatureName.toLowerCase()];
  if (override && typeof override.referralIncluded === "boolean") {
    return { included: override.referralIncluded, reason: override.referralIncluded
      ? "учитывается: индивидуальная настройка номенклатуры"
      : "не учитывается: индивидуальная настройка номенклатуры" };
  }
  const policy = normalizeReferralRevenuePolicy(profile && profile.referralRevenuePolicy);
  if (policy.mode === "all") return { included: true, reason: "учитывается: все направления" };
  if (REFERRAL_REVENUE_FIXED_TYPES.includes(referralType)) {
    const included = policy.includeTypes[referralType] === true;
    return { included, reason: included ? `учитывается: ${referralType.toLocaleLowerCase("ru-RU")}` : `не учитывается: ${referralType.toLocaleLowerCase("ru-RU")}` };
  }
  if (!policy.includeExternalServices) return { included: false, reason: "не учитывается: услуги отключены настройкой" };
  if (!homeDepartment) {
    return {
      included: policy.includeUnassignedServices,
      reason: policy.includeUnassignedServices ? "учитывается: подразделение услуги не определено" : "не учитывается: подразделение услуги не определено",
    };
  }
  const excluded = policy.excludedServiceDepartments.includes(homeDepartment);
  return {
    included: !excluded,
    reason: excluded ? `не учитывается: услуга подразделения «${homeDepartment}»` : `учитывается: услуга подразделения «${homeDepartment}»`,
  };
}

function assignmentGroupPathIndex(docId, monthKey) {
  const month = DB.months[monthKey];
  const reports = month && month.naznach && month.naznach[docId];
  const index = new Map();
  if (!reports || typeof reports !== "object") return index;
  const remember = (key, path) => {
    if (!index.has(key)) { index.set(key, path); return; }
    const existing = index.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(path)) index.set(key, null);
  };
  for (const report of Object.values(reports)) {
    for (const item of (report && Array.isArray(report.items) ? report.items : [])) {
      const path = Array.isArray(item.groupPath) ? item.groupPath.map(cellStr).filter(Boolean) : [];
      if (!path.length) continue;
      for (const key of nomenclatureMatchKeys(item.n)) remember(key, path);
    }
  }
  return index;
}

function matchedAssignmentGroupPath(index, nomenclatureName) {
  for (const key of nomenclatureMatchKeys(nomenclatureName)) {
    const path = index.get(key);
    if (path) return [...path];
  }
  return [];
}

/* ---------- сводка по выработке (по профилю отделения врача) ---------- */
function vyrabotkaSummary(docId, monthKey) {
  const m = DB.months[monthKey];
  const v = m && m.vyrabotka[docId];
  if (!v) return null;
  const profile = profileForDoctor(docId);
  const referralGroupPaths = assignmentGroupPathIndex(docId, monthKey);
  const out = {
    profile,
    ownSum: 0, ownQty: 0, assistSum: 0, assistQty: 0, refSum: 0, refQty: 0,
    refIncludedSum: 0, refIncludedQty: 0, refExcludedSum: 0, refExcludedQty: 0,
    referralRevenuePolicy: normalizeReferralRevenuePolicy(profile.referralRevenuePolicy),
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
      const groupPath = matchedAssignmentGroupPath(referralGroupPaths, it.n);
      const focus = crossFocusMatch(profile, it.n);
      const homeDepartment = resolvedInterdisciplinaryHomeDepartment(it.n, focus, groupPath);
      const t = interdisciplinaryRefType(cls, focus, docId, it.n, groupPath);
      const decision = referralRevenueDecision(profile, t, homeDepartment, it.n);
      if (decision.included) {
        out.refIncludedSum += ref;
        out.refIncludedQty += qRef;
      } else {
        out.refExcludedSum += ref;
        out.refExcludedQty += qRef;
      }
      if (!out.refByType[t]) out.refByType[t] = { s: 0, q: 0, includedS: 0, includedQ: 0, excludedS: 0, excludedQ: 0, items: {} };
      const bt = out.refByType[t];
      bt.s += ref;
      bt.q += qRef;
      bt[decision.included ? "includedS" : "excludedS"] += ref;
      bt[decision.included ? "includedQ" : "excludedQ"] += qRef;
      if (!bt.items[it.n]) bt.items[it.n] = {
        s: 0, q: 0, includedS: 0, includedQ: 0, excludedS: 0, excludedQ: 0,
        homeDepartment, groupPath, inclusionReason: decision.reason,
      };
      bt.items[it.n].s += ref;
      bt.items[it.n].q += qRef;
      bt.items[it.n][decision.included ? "includedS" : "excludedS"] += ref;
      bt.items[it.n][decision.included ? "includedQ" : "excludedQ"] += qRef;
    }
  }
  // доля «экспертной» выручки = сумма фокусных позиций (широта × деньги),
  // независимо от того, в какие категории они разложены
  out.expertShareSum = out.expert.sum;
  return out;
}

/* ---------- сводка по назначениям (Вектор 3) ---------- */
function validNaznachCounts(summary) {
  return Boolean(summary) && ["assigned", "done", "soldQ", "resultQ"]
    .every(key => Number.isFinite(summary[key]) && summary[key] >= 0);
}

function naznachSummary(docId, monthKey, slice) {
  const m = DB.months[monthKey];
  const nz = m && m.naznach && m.naznach[docId] && m.naznach[docId][String(slice)];
  if (!nz) return null;
  const profile = profileForDoctor(docId);
  const focusConfig = profile.crossFocus || { title: "Фокусы междисциплинарного подхода", items: [], rules: [] };
  const focusItems = focusConfig.items || [];
  const coreFocusNames = focusItems.filter(item => item.core !== false).map(item => item.name);
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
    // Код номенклатуры восстанавливает тип и для уже сохранённых импортов,
    // созданных до появления товарной классификации плоского отчёта 1С.
    const sourceGoods = Boolean(it.goods) || isNaznachGoodsNomenclature(it.n, it.d);
    const cls = classifyItem(profile, "", it.n, sourceGoods);
    const goods = Boolean(cls.goods);
    const done = goods ? 0 : (it.d || 0);
    const soldQ = it.sq || 0;
    const resultQ = done + soldQ;
    const focus = crossFocusMatch(profile, it.n);
    const t = interdisciplinaryRefType(cls, focus, docId, it.n, it.groupPath || []);
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
    if (out.focus && focus) {
      const focusName = focus.name;
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
    b.valid = validNaznachCounts(b);
    b.issue = b.valid ? null : "в исходных данных есть отрицательные или некорректные количества";
    b.conv = b.valid && b.assigned > 0 ? b.resultQ / b.assigned * 100 : null;
  }
  out.sourceGroups = hasExplicitSourceGroups ? [...sourceGroupMap.values()] : [];
  for (const group of out.sourceGroups) {
    group.valid = validNaznachCounts(group);
    group.conv = group.valid && group.assigned > 0 ? group.resultQ / group.assigned * 100 : null;
  }
  out.totals.valid = validNaznachCounts(out.totals);
  out.totals.issue = out.totals.valid ? null : "в исходных данных есть отрицательные или некорректные количества";
  out.totals.conv = out.totals.valid && out.totals.assigned > 0 ? out.totals.resultQ / out.totals.assigned * 100 : null;
  if (out.focus) {
    out.focus.usedNames = coreFocusNames.filter(name => out.focus.items[name] && out.focus.items[name].resultQ > 0);
    out.focus.used = out.focus.usedNames.length;
  }
  return out;
}

function completedReferralSourceGrouping(refByType, nazSummary) {
  if (!refByType || !nazSummary || !Array.isArray(nazSummary.sourceGroups) || !nazSummary.sourceGroups.length) return null;
  const pathByNomenclature = new Map();
  const rememberPath = (key, path) => {
    if (!pathByNomenclature.has(key)) {
      pathByNomenclature.set(key, path);
      return;
    }
    const existing = pathByNomenclature.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(path)) pathByNomenclature.set(key, null);
  };
  for (const group of nazSummary.sourceGroups) {
    const path = Array.isArray(group.path) ? group.path.map(cellStr).filter(Boolean) : [];
    if (!path.length) continue;
    for (const name of Object.keys(group.items || {})) {
      for (const key of nomenclatureMatchKeys(name)) rememberPath(key, path);
    }
  }
  const grouped = new Map();
  let matchedItems = 0;
  let unmatchedItems = 0;
  for (const type of REF_TYPES) {
    const sourceType = refByType[type];
    if (!sourceType) continue;
    for (const [name, values] of Object.entries(sourceType.items || {})) {
      let path = Array.isArray(values.groupPath) && values.groupPath.length ? [...values.groupPath] : null;
      if (!path) {
        for (const key of nomenclatureMatchKeys(name)) {
          const candidate = pathByNomenclature.get(key);
          if (candidate) { path = candidate; break; }
        }
      }
      if (path) matchedItems++;
      else {
        unmatchedItems++;
        path = ["Не сопоставлено с группами 1С"];
      }
      const groupKey = `${type}\u0000${JSON.stringify(path)}`;
      if (!grouped.has(groupKey)) grouped.set(groupKey, {
        type, path: [...path], q: 0, s: 0, includedQ: 0, includedS: 0, excludedQ: 0, excludedS: 0, items: {},
      });
      const target = grouped.get(groupKey);
      target.q += values.q || 0;
      target.s += values.s || 0;
      target.includedQ += values.includedQ || 0;
      target.includedS += values.includedS || 0;
      target.excludedQ += values.excludedQ || 0;
      target.excludedS += values.excludedS || 0;
      if (!target.items[name]) target.items[name] = {
        q: 0, s: 0, includedQ: 0, includedS: 0, excludedQ: 0, excludedS: 0,
        homeDepartment: values.homeDepartment || "", inclusionReason: values.inclusionReason || "",
      };
      target.items[name].q += values.q || 0;
      target.items[name].s += values.s || 0;
      target.items[name].includedQ += values.includedQ || 0;
      target.items[name].includedS += values.includedS || 0;
      target.items[name].excludedQ += values.excludedQ || 0;
      target.items[name].excludedS += values.excludedS || 0;
    }
  }
  return { groups: [...grouped.values()], matchedItems, unmatchedItems };
}

/* ---------- клиентская база: окно + сегментация «визиты × давность» ---------- */
function kbWindow(docId, monthKey, win) {
  const m = DB.months[monthKey];
  const kb = m && m.kb[docId] && m.kb[docId][String(win)];
  return kb || null;
}

// Совпадение полных ФИО; инициалы и похожие фамилии не объединяются.
function primaryPatientNameKey(name) {
  return String(name || "").normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}
function primaryPatientMonth(docId, monthKey) {
  const source = DB.months[monthKey]?.primaryPatients;
  if (!source?.perDoc) return null;
  return source.perDoc[docId] || { patients: [], totals: {} };
}
function primaryPatientRows(rows) {
  const unique = new Map();
  for (const row of rows || []) {
    const key = primaryPatientNameKey(row.name);
    if (!key) continue;
    const old = unique.get(key);
    if (!old) unique.set(key, { ...row, key });
    else {
      for (const field of ["visits", "revenue"]) old[field] = old[field] != null && row[field] != null ? old[field] + row[field] : null;
      for (const field of ["primary", "primaryClinic"]) old[field] = old[field] != null && row[field] != null ? Math.max(old[field], row[field]) : null;
      if (old.source && row.source && primaryPatientNameKey(old.source) !== primaryPatientNameKey(row.source)) old.sourceConflict = true;
      if (!old.source) old.source = row.source;
    }
  }
  return [...unique.values()];
}
function primaryPatientReferrals(docId, monthKey, patientName) {
  // Окна 3/6/12 перекрываются и не определяют месяц назначения. Берём только 1 мес.
  const source = DB.months[monthKey]?.naznach?.[docId]?.["1"];
  const available = source?.patientDetailsAvailable === true && Array.isArray(source.patientAssignments);
  const nameKey = primaryPatientNameKey(patientName), doctorKey = primaryPatientNameKey(doctorName(docId));
  const matches = (source?.patientAssignments || []).filter(row => primaryPatientNameKey(row.name) === nameKey
    && !row.goods && (!row.executor || primaryPatientNameKey(row.executor) !== doctorKey));
  const assignments = [...new Map(matches.filter(row => row.assigned > 0).map(row =>
    [`${row.n}\u0000${row.executor}`, { n: row.n, executor: row.executor }])).values()];
  const complete = available && matches.every(row => Number.isFinite(row.assigned) && row.assigned >= 0);
  return { status: available && assignments.length ? true : complete ? false : null, assignments: available ? assignments : [] };
}
function doctorPrimaryPatients(docId, endMonth) {
  const cache = specializationCalculations?.primaryPatients;
  const key = JSON.stringify([String(docId), String(endMonth)]);
  if (cache?.has(key)) return cache.get(key);
  const result = computeDoctorPrimaryPatients(docId, endMonth);
  cache?.set(key, result);
  return result;
}
function computeDoctorPrimaryPatients(docId, endMonth) {
  const months = calendarYearMonthKeys(endMonth);
  const monthly = new Map(months.map(month => [month, primaryPatientMonth(docId, month)]));
  const rowsByMonth = new Map([...monthly].map(([month, data]) => [month, data ? primaryPatientRows(data.patients) : null]));
  const missingMonths = months.filter(month => !monthly.get(month));
  const currentRows = rowsByMonth.get(endMonth);
  const primaryValid = rows => rows != null && rows.every(row => Number.isSafeInteger(row.primary) && row.primary >= 0);
  const current = currentRows == null ? null : {
    total: currentRows.length, count: primaryValid(currentRows) ? currentRows.filter(row => row.primary > 0).length : null,
    patients: currentRows.filter(row => row.primary > 0).map(row => ({ ...row, referral: primaryPatientReferrals(docId, endMonth, row.name) })),
  };
  if (current) current.share = current.total && current.count != null ? current.count / current.total * 100 : null;
  const cohort = new Map();
  for (const month of months) for (const row of rowsByMonth.get(month) || []) {
    if (row.primary > 0 && !cohort.has(row.key)) cohort.set(row.key, { ...row, firstMonth: month });
  }
  const patients = [...cohort.values()].map(patient => {
    let observedVisits = 0, observedRevenue = 0, completeVisits = true, completeRevenue = true, referralsComplete = true;
    const assignments = new Map();
    for (const month of months.filter(key => key >= patient.firstMonth)) {
      const rows = rowsByMonth.get(month);
      if (!rows) { completeVisits = false; completeRevenue = false; }
      const row = rows?.find(row => row.key === patient.key);
      if (row) {
        if (!Number.isSafeInteger(row.visits) || row.visits < 0) completeVisits = false;
        else observedVisits += row.visits;
        if (!Number.isFinite(row.revenue)) completeRevenue = false;
        else observedRevenue += row.revenue;
      }
      const referral = primaryPatientReferrals(docId, month, patient.name);
      if (referral.status == null) referralsComplete = false;
      for (const item of referral.assignments) assignments.set(`${item.n}\u0000${item.executor}`, item);
    }
    return { name: patient.name, source: patient.source, sourceConflict: patient.sourceConflict, firstMonth: patient.firstMonth,
      visits: completeVisits ? observedVisits : null, revenue: completeRevenue ? observedRevenue : null,
      observedVisits, observedRevenue, referral: { status: assignments.size ? true : referralsComplete ? false : null, assignments: [...assignments.values()] } };
  }).sort((a, b) => a.firstMonth.localeCompare(b.firstMonth) || a.name.localeCompare(b.name, "ru"));
  const buckets = [1, 2, 3].map(min => {
    const count = patients.filter(patient => patient.visits != null && (min === 3 ? patient.visits >= 3 : patient.visits === min)).length;
    return { visits: min, count, share: patients.length ? count / patients.length * 100 : null };
  });
  const hasData = months.some(month => monthly.get(month) != null);
  if (!hasData) for (const bucket of buckets) bucket.count = null;
  return { months, missingMonths, current, patients, buckets, yearCount: hasData ? patients.length : null,
    incompletePrimaryMonths: months.filter(month => !primaryValid(rowsByMonth.get(month))),
    unknownVisits: patients.filter(patient => patient.visits == null || patient.visits < 1).length };
}
// Categories are explicit: unknown or conflicting labels keep their own denominator share.
function primarySourceCategory(patient) {
  if (patient.sourceConflict) return null;
  const source = primaryPatientNameKey(patient.source || "").replace(/(?:яндекс|yandex)[\s.\p{Pd}]+(?:дзен|zen)/gu, "дзен");
  const matches = [
    /рекоменд|сарафан|знаком|родствен|друз/.test(source),
    /интернет|сайт|поисков|google|гугл|яндекс|yandex|2гис|2gis/.test(source),
    /агрегатор|продоктор|prodoctor|напоправку|napopravku|сберздоров|сбер здоров|sberhealth|docdoc|докдок|doctu|докту|zoon|зун/.test(source),
    /соц[ ._-]*сет|социальн|instagram|инстаграм|вконтакте|\bvk\b|telegram|телеграм|facebook|фейсбук|youtube|ютуб|tiktok|тикток|одноклассник|(?:^|[^\p{L}])(?:сс|вк|дзен|dzen)(?!\p{L})/u.test(source),
  ];
  return matches.filter(Boolean).length === 1 ? matches.indexOf(true) : null;
}
function primarySourcesSummary(patients, available, complete = true) {
  const counts = [0, 0, 0, 0, 0], unresolved = new Map();
  for (const patient of patients) {
    const category = primarySourceCategory(patient);
    counts[category == null ? 4 : category]++;
    if (category == null) {
      const label = patient.sourceConflict ? "Противоречивые источники" : String(patient.source || "Не указан").trim();
      unresolved.set(label, (unresolved.get(label) || 0) + 1);
    }
  }
  const total = available ? patients.length : null;
  return { total, complete: available && complete, counts: available ? counts : counts.map(() => null),
    shares: counts.map(count => total ? count / total * 100 : null),
    unresolved: [...unresolved].map(([label, count]) => ({ label, count })) };
}
function doctorPrimarySources(summary) {
  return { year: primarySourcesSummary(summary.patients, summary.yearCount != null, !summary.incompletePrimaryMonths.length),
    month: primarySourcesSummary(summary.current?.patients || [], summary.current != null, summary.current?.count != null) };
}

function kbClientIdentity(client) {
  const id = String(client.patientId || "").trim().toLowerCase();
  const name = normFio(client.name || "");
  return id ? "id:" + id : name ? "name:" + name : null;
}
function clientBaseActiveVisits(docId, monthKey, windowMonths) {
  const source = kbWindow(docId, monthKey, windowMonths);
  if (!source || source.clients.some(client => !kbClientIdentity(client) || !Number.isSafeInteger(client.v) || client.v < 0)) return null;
  const visits = new Map();
  for (const client of source.clients) { const key = kbClientIdentity(client); visits.set(key, (visits.get(key) || 0) + client.v); }
  return visits;
}
function reportClientBaseSummary(docId, monthKey, windowMonths = 12) {
  const profile = deptParams(docId);
  const key = JSON.stringify([String(docId), String(monthKey), Number(windowMonths), "report-partition-v1", clientBasePartitionSettings(profile)]);
  const calculate = () => {
    const base = kbSummary(docId, monthKey, windowMonths);
    const summary = partitionClientBase(base, profile);
    if (summary) Object.defineProperty(summary, "clientRows", { configurable: true, enumerable: false,
      get() { return partitionClientBase(base, profile).clientRows; } });
    return summary;
  };
  if (specializationCalculations?.reportBase) {
    const bases = specializationCalculations.reportBase;
    if (!bases.has(key)) bases.set(key, calculate());
    return bases.get(key);
  }
  const cached = metricsCacheGet(_kbSummaryCache, key, "kbSummary");
  if (cached !== undefined) return cached;
  return metricsCacheSet(_kbSummaryCache, key, calculate(), METRICS_CACHE_LIMITS.kbSummary);
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
    newRiskM: Math.max(1, Number(p.newRiskM) || 6), newRiskWithin: p.newRiskWithin === true,
    sleepVisits: Math.max(1, Number(p.sleepVisits) || Number(p.loyalVisits) || Number(p.minVisits) || 3),
    sleepM: Math.max(1, Number(p.sleepM) || 6),
    lostVisits: Math.max(1, Number(p.lostVisits) || 2),
    lostM: Math.max(1, Number(p.lostM) || Number(p.riskM) || 12),
  };
}
function clientBasePartitionSettings(profile) {
  const p = profile || {};
  const t = clientBaseThresholds(p);
  const saved = p.clientBasePartition || {};
  const bound = (value, fallback, min, max) => Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max ? Number(value) : Math.max(min, Math.min(max, Math.round(fallback)));
  return {
    loyalVisits: bound(saved.loyalVisits, t.activeVisits, 2, 50),
    activeM: Math.min(bound(saved.activeM, t.activeM, 1, 36), saved.lostAnyVisits === true ? bound(saved.lostM, t.lostM, 1, 36) : 36),
    lostM: bound(saved.lostM, t.lostM, 1, 36),
    lostAnyVisits: saved.lostAnyVisits === true,
  };
}

// Полное разбиение, а не набор независимых фильтров: каждая строка имеет один сегмент.
function partitionClientBase(base, profile) {
  if (!base) return null;
  const t = clientBasePartitionSettings(profile);
  const seg = { active: 0, loyalSleep: 0, newRisk: 0, lost: 0 };
  const provisional = { active: 0, loyalSleep: 0, newRisk: 0, lost: 0 };
  const clientRows = base.clientRows.map(client => {
    const validVisits = Number.isSafeInteger(client.v) && client.v > 0;
    const validRecency = Number.isFinite(client.r) && client.r >= 0;
    const loyal = validVisits && client.v >= t.loyalVisits;
    let group;
    if (!validVisits || !validRecency) {
      // Не выдумываем активность или потерю: оставляем запись для проверки в рабочей группе.
      group = loyal ? "loyalSleep" : "newRisk";
      provisional[group]++;
    } else if (client.r > Math.round(t.lostM * 30.44) && (t.lostAnyVisits || !loyal)) {
      group = "lost";
    } else if (loyal) {
      group = client.r <= Math.round(t.activeM * 30.44) ? "active" : "loyalSleep";
    } else {
      group = "newRisk";
    }
    seg[group]++;
    return { ...client, loyal: group === "active" || group === "loyalSleep", groups: [group], partitioned: true, provisional: !validVisits || !validRecency };
  });
  const total = clientRows.length;
  const share = group => total ? seg[group] / total * 100 : null;
  const work = clientRows.filter(c => c.groups[0] === "newRisk" || c.groups[0] === "loyalSleep");
  const sum = group => clientRows.filter(c => c.groups[0] === group).reduce((value, c) => value + (c.s || 0), 0);
  return { ...base, methodologyId: "report-partition-v1", partition: t, seg, provisional, clientRows, total,
    sourceWindowComplete: true, requiredWindowM: Number(base.window) || 36,
    groupAvailable: { active: true, loyalSleep: true, newRisk: true, lost: true },
    activeBasePct: share("active"), loyalSleepPct: share("loyalSleep"), newRiskPct: share("newRisk"), lostPct: share("lost"),
    activeBase: seg.active, activeSum: sum("active"), sleepSum: sum("loyalSleep"), riskSum: sum("newRisk"), lostSum: sum("lost"),
    loyalCount: seg.active + seg.loyalSleep, loyalPct: total ? (seg.active + seg.loyalSleep) / total * 100 : null,
    riskShare: share("newRisk"), sleepRiskShare: total ? work.length / total * 100 : null,
    revenueAtRisk: sum("loyalSleep") + sum("newRisk") + sum("lost"),
    reactivationCandidates: work.length, reactivationSum: work.reduce((sum, c) => sum + (c.s || 0), 0) };
}

function adminClientBaseSummary(docId, monthKey) {
  // Короткое окно не содержит давно отсутствующих пациентов и не заменяет трёхлетнюю базу.
  const profile = deptParams(docId);
  const cacheKey = JSON.stringify([String(docId), String(monthKey), clientBasePartitionSettings(profile)]);
  const prepared = specializationCalculations?.adminBase;
  if (prepared) {
    if (!prepared.has(cacheKey)) prepared.set(cacheKey, partitionClientBase(kbSummary(docId, monthKey, 36), profile));
    return prepared.get(cacheKey);
  }
  const cached = metricsCacheGet(_adminBaseCache, cacheKey, "adminBase");
  if (cached !== undefined) return cached;
  return metricsCacheSet(_adminBaseCache, cacheKey,
    partitionClientBase(kbSummary(docId, monthKey, 36), profile), METRICS_CACHE_LIMITS.adminBase);
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
function classifyKbClient(client, profile, groupAvailable, thresholds, activeVisits = Number(client.v) || 0) {
  const visits = Number(client.v) || 0;
  const recency = client.r == null || isNaN(client.r) ? null : Number(client.r);
  const loyal = groupAvailable.loyal && recency != null && visits >= profile.loyalVisits && recency <= thresholds.loyalDays;
  const groups = [];
  if (loyal) groups.push("loyal");
  if (groupAvailable.active && recency != null && activeVisits >= profile.activeVisits && recency <= thresholds.activeDays) groups.push("active");
  if (groupAvailable.newRisk && recency != null && visits >= 1 && visits <= profile.newRiskVisits && (profile.newRiskWithin ? recency <= thresholds.newRiskDays : recency > thresholds.newRiskDays)) groups.push("newRisk");
  if (groupAvailable.loyalSleep && recency != null && visits >= profile.sleepVisits && recency > thresholds.sleepDays) groups.push("loyalSleep");
  if (groupAvailable.lost && recency != null && visits >= 1 && visits <= profile.lostVisits && recency > thresholds.lostDays) groups.push("lost");
  return { visits, recency, loyal, groups };
}

function kbClientRows(docId, monthKey, win, summary) {
  const cacheKey = JSON.stringify([String(docId), String(monthKey), Number(win), summary.thresholds, summary.activeWindow || null]);
  const cached = metricsCacheGet(_kbDetailsCache, cacheKey, "kbDetails");
  if (cached !== undefined) return cached;
  const kb = kbWindow(docId, monthKey, win);
  if (!kb) return [];
  const activeVisits = summary.groupAvailable.active && summary.activeWindow ? clientBaseActiveVisits(docId, monthKey, summary.activeWindow) : null;
  const rows = kb.clients.map((client, index) => {
    const classified = classifyKbClient(client, summary.thresholds, summary.groupAvailable, summary.thresholds,
      summary.activeWindow ? activeVisits?.get(kbClientIdentity(client)) || 0 : Number(client.v) || 0);
    const normalizedName = normFio(client.name || "");
    const normalizedId = String(client.patientId || "").trim().toLowerCase();
    return {
      key: normalizedId ? "id:" + normalizedId : (normalizedName ? "name:" + normalizedName : `doctor:${docId}:row:${index}`),
      patientId: client.patientId || null,
      name: client.name || `Пациент ${index + 1}`,
      s: Number(client.s) || 0,
      v: classified.visits,
      r: classified.recency,
      loyal: classified.loyal,
      groups: classified.groups,
    };
  });
  metricsCacheSet(_kbDetailsCache, cacheKey, rows, METRICS_CACHE_LIMITS.kbDetails);
  return rows;
}

function kbSummary(docId, monthKey, win) {
  const profile = deptParams(docId);
  const profileKey = {
    ...clientBaseThresholds(profile),
    corePct: Number(profile.corePct) || 0,
    courseX: Number(profile.courseX) || 0,
  };
  const cacheKey = JSON.stringify([String(docId), String(monthKey), Number(win), profileKey]);
  const prepared = specializationCalculations?.kbSummary;
  if (prepared) {
    if (!prepared.has(cacheKey)) prepared.set(cacheKey, computeKbSummary(docId, monthKey, win));
    return prepared.get(cacheKey);
  }
  const cached = metricsCacheGet(_kbSummaryCache, cacheKey, "kbSummary");
  if (cached !== undefined) return cached;
  const summary = computeKbSummary(docId, monthKey, win);
  metricsCacheSet(_kbSummaryCache, cacheKey, summary, METRICS_CACHE_LIMITS.kbSummary);
  return summary;
}

function computeKbSummary(docId, monthKey, win, reportProfile = null, strictActive = false) {
  const kb = kbWindow(docId, monthKey, win);
  if (!kb) return null;
  const p = reportProfile || deptParams(docId);
  const t = clientBaseThresholds(p);
  const groupAvailable = clientBaseGroupAvailability(win, p);
  const activeVisits = strictActive && groupAvailable.active ? clientBaseActiveVisits(docId, monthKey, t.activeM) : null;
  if (strictActive && !activeVisits) groupAvailable.active = false;
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
  const thresholds = { ...t, loyalDays: dLoyal, activeDays: dActive, newRiskDays: dNewRisk, sleepDays: dSleep, lostDays: dLost };
  let reactivationCandidates = 0, reactivationSum = 0, revenueAtRisk = 0, sleepRiskCount = 0;
  for (const c of kb.clients) {
    const sum = Number(c.s) || 0;
    const classified = classifyKbClient(c, t, groupAvailable, thresholds, strictActive ? activeVisits?.get(kbClientIdentity(c)) || 0 : Number(c.v) || 0);
    const { visits, recency, loyal, groups } = classified;
    totalSum += sum;
    totalVisits += visits;
    if (recency == null) seg.unknown++;
    for (const group of groups) {
      seg[group]++;
      groupSums[group] += sum;
    }
    if (loyal) loyalCount++;
    const reactivation = groups.includes("newRisk") || groups.includes("loyalSleep");
    const atRisk = reactivation || groups.includes("lost");
    if (reactivation) { reactivationCandidates++; reactivationSum += sum; }
    if (atRisk) revenueAtRisk += sum;
    if (reactivation) sleepRiskCount++;
  }
  for (const group of ["loyal", "active", "newRisk", "loyalSleep", "lost"]) {
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
  const summary = {
    window: Number(win), period: kb.period, params: p, sourceWindowComplete, requiredWindowM, groupAvailable,
    thresholds, ...(strictActive ? { activeWindow: t.activeM, methodologyId: "report-overlap-v1" } : {}),
    total, known: total - seg.unknown, seg, totalSum, totalVisits,
    activeSum: groupAvailable.active ? groupSums.active : null,
    riskSum: groupAvailable.newRisk ? groupSums.newRisk : null,
    sleepSum: groupAvailable.loyalSleep ? groupSums.loyalSleep : null,
    lostSum: groupAvailable.lost ? groupSums.lost : null,
    revenueAtRisk,
    reactivationCandidates,
    reactivationSum,
    visits: totalVisits, patients: total,
    freq: total ? totalVisits / total : null,
    avgVisit: totalVisits ? totalSum / totalVisits : null,
    avgClient: total ? totalSum / total : null,
    one2: total - loyalCount,
    loyalCount,
    loyalPct: groupAvailable.loyal && total ? loyalCount / total * 100 : null,
    activeBase: groupAvailable.active ? seg.active : null,
    activeBasePct: groupAvailable.active && total ? seg.active / total * 100 : null,
    newRiskPct: groupAvailable.newRisk && total ? seg.newRisk / total * 100 : null,
    loyalSleepPct: groupAvailable.loyalSleep && total ? seg.loyalSleep / total * 100 : null,
    lostPct: groupAvailable.lost && total ? seg.lost / total * 100 : null,
    riskShare: groupAvailable.newRisk && total ? seg.newRisk / total * 100 : null,
    sleepRiskShare: groupAvailable.newRisk && groupAvailable.loyalSleep && total
      ? sleepRiskCount / total * 100
      : null,
    core,
    courseCnt,
    courseIdx: total ? courseCnt / total * 100 : null,
  };
  // Персональные строки тяжелее скалярной сводки и создаются только при открытии списка пациентов.
  Object.defineProperty(summary, "clientRows", {
    configurable: true,
    enumerable: false,
    get() { return kbClientRows(docId, monthKey, win, summary); },
  });
  return summary;
}

const REPUTATION_PLATFORMS = [
  { key: "prodoctorov", name: "ПроДокторов" },
  { key: "napopravku", name: "НаПоправку" },
  { key: "doctu", name: "DocTu" },
  { key: "sberhealth", name: "СберЗдоровье" },
];

function reputationSummary(raw) {
  if (!raw) return null;
  const platforms = REPUTATION_PLATFORMS.map(({ key, name }) => ({
    key, name,
    rating: Number.isFinite(raw[key]) && raw[key] >= 0 && raw[key] <= 5 ? raw[key] : null,
    reviews: Number.isSafeInteger(raw[key + "Reviews"]) && raw[key + "Reviews"] >= 0 ? raw[key + "Reviews"] : null,
  }));
  const ratings = platforms.map(item => item.rating).filter(value => value != null);
  const counted = platforms.filter(item => item.reviews != null);
  const nps = Number.isFinite(raw.nps) && raw.nps >= -100 && raw.nps <= 100 ? raw.nps : null;
  const reviews = Number.isFinite(raw.reviews) && raw.reviews >= 0 ? raw.reviews : null;
  const knownReviews = counted.reduce((sum, item) => sum + item.reviews, 0);
  return {
    avgRating: ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null,
    nps, reviews, platforms,
    totalReviews: counted.length === platforms.length ? knownReviews : null,
    knownReviews: counted.length ? knownReviews : null,
    reviewCoverage: { covered: counted.length, expected: platforms.length, complete: counted.length === platforms.length },
    valid: platforms.every(item => (raw[item.key] == null || item.rating != null)
      && (raw[item.key + "Reviews"] == null || item.reviews != null))
      && (raw.nps == null || nps != null) && (raw.reviews == null || reviews != null),
    raw,
  };
}

/* ---------- главный расчёт ---------- */
/* Кэши ограничены LRU и инвалидируются только для затронутых данных. */
const METRICS_CACHE_LIMITS = Object.freeze({ metrics: 480, kbSummary: 720, kbDetails: 48, adminBase: 120, department: 180, specializationBase: 720 });
let _mcCache = new Map();
let metricsCalculationRevision = 0;
let preparedMetricsForRender = null;
let specializationCalculations = null;
let _kbSummaryCache = new Map();
let _kbDetailsCache = new Map();
let _adminBaseCache = new Map();
let _deptCache = new Map();
let _specializationBaseCache = new Map();
let _metricsCacheCounters = {};

function metricsCacheGet(cache, key, name) {
  if (!cache.has(key)) {
    const counter = _metricsCacheCounters[name] || (_metricsCacheCounters[name] = { hits: 0, misses: 0 });
    counter.misses++;
    return undefined;
  }
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  const counter = _metricsCacheCounters[name] || (_metricsCacheCounters[name] = { hits: 0, misses: 0 });
  counter.hits++;
  return value;
}

function metricsCacheSet(cache, key, value, limit) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value);
  return value;
}

function clearMetricsCache() {
  metricsCalculationRevision++;
  _mcCache = new Map();
  _kbSummaryCache = new Map();
  _kbDetailsCache = new Map();
  _adminBaseCache = new Map();
  _deptCache = new Map();
  _specializationBaseCache = new Map();
  _metricsCacheCounters = {};
}

function deleteCacheWhere(cache, predicate) {
  for (const key of cache.keys()) {
    let parts;
    try { parts = JSON.parse(key); } catch (_) { parts = []; }
    if (predicate(parts)) cache.delete(key);
  }
}

function invalidateMetricsCache(change = null) {
  if (!change || change.settings || change.full) {
    clearMetricsCache();
    return;
  }
  const months = new Set([...(change.months || []), ...(change.deleteMonths || [])].map(String));
  const doctors = change.doctors === true
    ? null
    : new Set([...(change.doctors || []), ...(change.deleteDoctors || [])].map(String));
  if (months.size || change.departmentScope || change.doctors === true || doctors.size) metricsCalculationRevision++;
  if (change.doctors === true) {
    _mcCache.clear();
    _kbSummaryCache.clear();
    _kbDetailsCache.clear();
    _adminBaseCache.clear();
  } else if (doctors.size || months.size) {
    const affected = parts => (doctors.size && doctors.has(String(parts[0]))) || (months.size && months.has(String(parts[1])));
    deleteCacheWhere(_mcCache, affected);
    deleteCacheWhere(_kbSummaryCache, affected);
    deleteCacheWhere(_kbDetailsCache, affected);
    deleteCacheWhere(_adminBaseCache, affected);
  }
  for (const cache of [_deptCache, _specializationBaseCache]) {
    if (change.departmentScope || change.doctors === true || doctors.size) cache.clear();
    else if (months.size) deleteCacheWhere(cache, parts => months.has(String(parts[0])));
  }
}

function metricsCacheStats() {
  return {
    sizes: { metrics: _mcCache.size, kbSummary: _kbSummaryCache.size, kbDetails: _kbDetailsCache.size,
      adminBase: _adminBaseCache.size, department: _deptCache.size, specializationBase: _specializationBaseCache.size },
    limits: { ...METRICS_CACHE_LIMITS },
    counters: JSON.parse(JSON.stringify(_metricsCacheCounters)),
  };
}

function computeMetrics(docId, monthKey) {
  const ck = JSON.stringify([String(docId), String(monthKey)]);
  if (preparedMetricsForRender?.has(ck)) return preparedMetricsForRender.get(ck);
  const cached = metricsCacheGet(_mcCache, ck, "metrics");
  if (cached !== undefined) return cached;
  const r = computeMetricsRaw(docId, monthKey);
  preparedMetricsForRender?.set(ck, r);
  return metricsCacheSet(_mcCache, ck, r, METRICS_CACHE_LIMITS.metrics);
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
  const zapisReportImported = monthReportImported(m, "zapis");
  const zapis = m.zapis[docId] || (zapisReportImported ? {
    created: 0, zapis: 0, okaz: 0, other: 0, total: 0, inferredZero: true,
  } : null);
  const man6 = (m.manual6 || {})[docId];
  const slices = Object.keys(m.pervichka).map(Number).sort((a, b) => a - b);
  const pvSlices = {};
  for (const s of slices) {
    const d = m.pervichka[String(s)].perDoc[docId];
    if (d) {
      const countsValid = [d.first, d.ret, d.notRet].every(value => Number.isSafeInteger(value) && value >= 0);
      const valid = countsValid && d.ret <= d.first && d.ret + d.notRet === d.first;
      pvSlices[s] = Object.assign({
        valid,
        issue: valid ? null : countsValid ? "вернулось + не вернулось должно равняться числу первичных"
          : "числа первичных, вернувшихся и не вернувшихся должны быть целыми и неотрицательными",
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
  const refRevenueAll = vy ? vy.refSum : null;
  const refRevenue = vy ? vy.refIncludedSum : null;
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
    refRevenue, refRevenueAll, revenueWithRef,
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
    refGroupsByNaz: vy ? {
      1: completedReferralSourceGrouping(vy.refByType, naz1),
      3: completedReferralSourceGrouping(vy.refByType, naz3),
    } : {},
    refSum: refRevenue,
    refSumAll: refRevenueAll,
    refExcludedSum: vy ? vy.refExcludedSum : null,
    referralRevenuePolicy: vy ? vy.referralRevenuePolicy : null,
    crossShare: (revenueWithRef && refRevenue != null) ? refRevenue / revenueWithRef * 100 : null,
  };

  /* В6 Репутация: накопленные отзывы не заменяют новые отзывы за месяц в балле. */
  const rep = reputationSummary(man6);

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
    methodology: { id: "score-v1", v4: "legacy-overlap-v1" },
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
  if (!zapisReportImported) missing.push("запись в 1С");
  if (!pvForScore) missing.push(`первичка ровно ${pvM} мес`);
  if (courseWin == null) missing.push(`давность ровно ${pDept.courseM} мес для курсового`);

  return {
    traffic, econ, product, akb, loyalty, cross, rep, scores,
    missing, partial: missing.length > 0,
    extras: { vy, kb1, kb12, kb36, naz1, naz3, prostoy, zapis, man6, slices, pvSlices, revenue: sales, revenueWithRef },
  };
}

/* В дашборды месяца попадают только врачи с загруженным персональным
   отчётом «Выработка». Общие отчёты не должны создавать врача в сводках. */
function doctorHasDashboardData(docId, monthKey) {
  const m = DB.months[monthKey];
  if (!m || !m.vyrabotka) return false;
  const id = String(docId);
  return Object.prototype.hasOwnProperty.call(m.vyrabotka, id)
    && Boolean(m.vyrabotka[id] && typeof m.vyrabotka[id] === "object");
}

/* Врачи месяца */
// Ограничение действует только при синхронном построении страницы Viewer.
let viewerReportDoctorScope = null;

function doctorsInMonth(monthKey) {
  const m = DB.months[monthKey];
  if (!m) return [];
  return Object.keys(m.vyrabotka || {})
    .filter(id => (!viewerReportDoctorScope || viewerReportDoctorScope.has(id)) && doctorHasDashboardData(id, monthKey))
    .sort((a, b) => doctorName(a).localeCompare(doctorName(b), "ru"));
}
function coreDoctorsInMonth(monthKey) {
  return doctorsInMonth(monthKey);
}
function doctorsForScopeInMonth(monthKey, scoped = false) {
  return doctorsInMonth(monthKey);
}
function monthKeysSorted() {
  return Object.keys(DB.months).sort();
}

function monthKeyOrdinal(monthKey) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(monthKey || ""));
  return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : null;
}

function monthKeyFromOrdinal(ordinal) {
  if (!Number.isInteger(ordinal) || ordinal < 0) return null;
  return `${Math.floor(ordinal / 12)}-${String(ordinal % 12 + 1).padStart(2, "0")}`;
}

function calendarMonthKeys(startMk, endMk) {
  const start = monthKeyOrdinal(startMk);
  const end = monthKeyOrdinal(endMk);
  if (start == null || end == null || start > end || end - start > 2400) return [];
  return Array.from({ length: end - start + 1 }, (_, index) => monthKeyFromOrdinal(start + index));
}

function calendarYearMonthKeys(endMk) {
  return calendarMonthKeys(`${String(endMk).slice(0, 4)}-01`, endMk);
}

function dynamicsMonthKeys(monthsAll, endMk, maxMonths = 6) {
  const end = monthKeyOrdinal(endMk);
  if (end == null) return [];
  const available = [...new Set((Array.isArray(monthsAll) ? monthsAll : [])
    .filter(key => monthKeyOrdinal(key) != null && monthKeyOrdinal(key) <= end))].sort();
  if (!available.length) return [];
  const windowStart = monthKeyFromOrdinal(Math.max(0, end - Math.max(1, Number(maxMonths) || 6) + 1));
  const start = available[0] > windowStart ? available[0] : windowStart;
  return calendarMonthKeys(start, endMk);
}

/* Вся номенклатура ОТДЕЛЕНИЯ (по врачам этого отделения за все месяцы):
   основа редактора «распихать номенклатуру» и списков неразобранного */
function collectDeptItems(deptName, profile = deptProfile(deptName)) {
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

function collectInterdisciplinaryGroupPaths(departmentName, specializationName = "") {
  const map = new Map();
  const inScope = docId => specializationName
    ? resolvedSpecializationName(docId) === specializationName
    : resolvedDepartmentName(docId) === departmentName;
  for (const month of Object.values(DB.months)) {
    for (const [docId, reports] of Object.entries(month.naznach || {})) {
      if (!inScope(docId)) continue;
      for (const report of Object.values(reports || {})) {
        for (const item of (report && Array.isArray(report.items) ? report.items : [])) {
          const path = Array.isArray(item.groupPath) ? item.groupPath.map(cellStr).filter(Boolean) : [];
          for (let length = 1; length <= path.length; length++) {
            const prefix = path.slice(0, length);
            const key = interdisciplinaryGroupKey(prefix);
            if (!key) continue;
            if (!map.has(key)) map.set(key, { key, path: prefix, positions: 0, assigned: 0 });
            const entry = map.get(key);
            entry.positions++;
            entry.assigned += item.a || 0;
          }
        }
      }
    }
  }
  return [...map.values()].sort((a, b) => a.path.join(" / ").localeCompare(b.path.join(" / "), "ru"));
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
  const baseThresholds = clientBasePartitionSettings(profile);
  const base = r => selectedClientBaseSummary(r, profile);
  return [
    { key: "sales", name: "Выручка", fmt: fmtMoney, get: r => r.econ.sales, target: B.revenue },
    { key: "withRef", name: "Выручка с перенаправлениями", fmt: fmtMoney, get: r => r.econ.revenueWithRef },
    { key: "avgClient", name: "Средний чек на пациента", fmt: fmtMoney, get: r => r.econ.avgClient, target: B.avgCheck },
    { key: "avgClientRef", name: "Средний чек пациента с перенаправлениями", fmt: fmtMoney, get: r => r.econ.avgClientRef },
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
    { key: "akb", name: "Активные лояльные", fmt: v => fmtNum(v) + " чел.", get: r => { const kb = base(r); return kb && kb.groupAvailable.active ? kb.seg.active : null; } },
    { key: "lost", name: `Потерянные (отсутствуют >${fmtNum(baseThresholds.lostM)} мес.)`, fmt: v => fmtNum(v) + " чел.", get: r => { const kb = base(r); return kb && kb.groupAvailable.lost ? kb.seg.lost : null; }, lower: true },
    { key: "score", name: "Общий балл", fmt: v => fmtNum(v, 0), get: r => DB.settings.showScores && r.scores ? r.scores.total : null },
  ];
}

/* Общая машинка: series[mk] -> r-подобный объект; строит строки динамики */
function buildDynamics(monthsAll, endMk, getResult, maxMonths, profile) {
  const months = dynamicsMonthKeys(monthsAll, endMk, maxMonths || 6);
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
    // Календарная шкала содержит пропуски, поэтому соседняя колонка всегда
    // является предыдущим календарным месяцем, а не предыдущим отчётом.
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
      values, cur, prev, prevKey: months.length >= 2 ? months[months.length - 2] : null,
      prevAvg, averageKeys: months.slice(0, -1).filter((_, index) => values[index] != null),
      delta, deltaAvg, improving, improvingAvg, belowTarget,
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
  return buildDynamics(
    calendarYearMonthKeys(endMk),
    endMk,
    k => doctorHasDashboardData(docId, k) ? doctorReportMetrics(docId, k) : null,
    12,
    profileForDoctor(docId)
  );
}

function doctorReportMetrics(docId, monthKey) {
  const result = computeMetrics(docId, monthKey);
  if (!result) return null;
  const primary = reportClientBaseSummary(docId, monthKey, 36);
  return { ...result, akb: { ...result.akb, primary, primaryWin: 36 } };
}

/* Агрегат отделения за месяц — «виртуальный r» с теми же полями, что читают dynMetricDefs */
function reportDoctorScope(doctorIds) {
  const ids = doctorIds ? [...doctorIds].map(String) : null;
  if (!viewerReportDoctorScope) return ids?.sort() ?? null;
  return (ids ? ids.filter(id => viewerReportDoctorScope.has(id)) : [...viewerReportDoctorScope]).sort();
}

function aggregateDeptCacheKey(mk, deptFilter, subFilter, doctorIds) {
  const normalizedFilter = Array.isArray(deptFilter)
    ? [...deptFilter].map(String).sort()
    : (deptFilter instanceof Set ? [...deptFilter].map(String).sort() : String(deptFilter));
  const normalizedDoctors = reportDoctorScope(doctorIds);
  return JSON.stringify([String(mk), normalizedFilter, String(subFilter), normalizedDoctors]);
}

function aggregateDeptMonth(mk, deptFilter, subFilter = "all", doctorIds = null) {
  const cacheKey = aggregateDeptCacheKey(mk, deptFilter, subFilter, doctorIds);
  if (specializationCalculations?.department) {
    if (!DB.months[mk]) return null;
    const totals = specializationCalculations.department;
    if (!totals.has(cacheKey)) totals.set(cacheKey, aggregateDeptMonthRaw(mk, deptFilter, subFilter, doctorIds));
    return totals.get(cacheKey);
  }
  const cached = metricsCacheGet(_deptCache, cacheKey, "department");
  if (cached !== undefined) return cached;
  return metricsCacheSet(_deptCache, cacheKey, aggregateDeptMonthRaw(mk, deptFilter, subFilter, doctorIds), METRICS_CACHE_LIMITS.department);
}

function mergeClientBaseSummaries(baseRows, expectedCount = baseRows.length) {
  const partitioned = baseRows.length > 0 && baseRows.every(base => base.partition || base.methodologyId === "report-partition-v1");
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
  const groupNames = partitioned ? ["active", "loyalSleep", "newRisk", "lost"] : ["loyal", "active", "newRisk", "loyalSleep", "lost"];
  const allDoctorsCovered = baseRows.length === expectedCount;
  const sameWindow = new Set(baseRows.map(kb => kb.window)).size === 1;
  const groupAvailable = Object.fromEntries(groupNames.map(group => [group, allDoctorsCovered && sameWindow && baseRows.every(kb => kb.groupAvailable && kb.groupAvailable[group])]));
  const seg = Object.fromEntries(groupNames.map(group => [group, 0]));
  if (!partitioned) seg.unknown = 0;
  let visits = 0, totalSum = 0, loyalCount = 0;
  for (const c of clients.values()) {
    // В сводке приоритет у текущих отношений: активный пациент одного врача
    // не становится потерянным из-за давнего визита к другому врачу.
    if (partitioned) c.groups = [groupNames.find(group => c.groups.includes(group)) || "newRisk"];
    for (const group of (c.groups || [])) if (Object.prototype.hasOwnProperty.call(seg, group)) seg[group]++;
    if (c.r == null && !partitioned) seg.unknown = (seg.unknown || 0) + 1;
    visits += c.v || 0;
    totalSum += c.s || 0;
    if (c.loyal) loyalCount++;
  }
  for (const group of groupNames) if (!groupAvailable[group]) seg[group] = null;
  if (!partitioned) { seg.risk = seg.newRisk; seg.sleep = seg.loyalSleep; }
  const total = clients.size;
  const sourceWindowComplete = allDoctorsCovered && sameWindow && baseRows.every(kb => kb.sourceWindowComplete);
  const windows = [...new Set(baseRows.map(kb => Number(kb.window)).filter(Number.isFinite))].sort((a, b) => a - b);
  const clientRows = [...clients.values()];
  const atRiskRows = clientRows.filter(c => (c.groups || []).some(group => ["newRisk", "loyalSleep", "lost"].includes(group)));
  return {
    ...(partitioned ? { methodologyId: "report-partition-v1" } : {}),
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
}

function scopeDoctorsInMonth(mk, deptFilter, subFilter = "all", doctorIds = null) {
  const requestedIds = doctorIds ? new Set(doctorIds) : null;
  const requestedSpecs = Array.isArray(deptFilter)
    ? new Set(deptFilter)
    : (deptFilter instanceof Set ? deptFilter : null);
  return doctorsForScopeInMonth(mk, deptFilter !== "all").filter(id =>
    (deptFilter === "all" || (requestedSpecs ? requestedSpecs.has(doctorDept(id)) : doctorDept(id) === deptFilter)) &&
    (subFilter === "all" || (DB.doctors[id] && DB.doctors[id].subdept) === subFilter) &&
    (!requestedIds || requestedIds.has(id))
  );
}

const SPECIALIZATION_BASE_WINDOW = 36;
function specializationClientBasePoint(month, deptFilter, subFilter, scope) {
  if (!DB.months[month]) return null;
  const key = JSON.stringify([month, SPECIALIZATION_BASE_WINDOW, deptFilter, subFilter, scope]);
  const prepared = specializationCalculations?.basePoints;
  if (prepared?.has(key)) return prepared.get(key);
  if (!prepared) {
    const cached = metricsCacheGet(_specializationBaseCache, key, "specializationBase");
    if (cached !== undefined) return cached;
  }
  const ids = scopeDoctorsInMonth(month, deptFilter, subFilter, scope);
  const bases = ids.map(id => reportClientBaseSummary(id, month, SPECIALIZATION_BASE_WINDOW));
  const base = bases.every(Boolean) ? mergeClientBaseSummaries(bases) : null;
  const point = base ? { active: base.seg.active, lost: base.seg.lost } : null;
  if (prepared) prepared.set(key, point);
  else metricsCacheSet(_specializationBaseCache, key, point, METRICS_CACHE_LIMITS.specializationBase);
  return point;
}

function specializationClientBaseHistory(endMk, deptFilter, subFilter = "all", doctorIds = null) {
  const months = calendarYearMonthKeys(endMk);
  const scope = reportDoctorScope(doctorIds);
  const points = months.map(month => specializationClientBasePoint(month, deptFilter, subFilter, scope));
  return { months, series: [
    { label: "Активная база", color: "#16a34a", values: points.map(point => point?.active ?? null) },
    { label: "Потерянные", color: "#dc2626", values: points.map(point => point?.lost ?? null) },
  ] };
}

function specializationActivityMonth(month, filter, subFilter, doctorIds, deviceNames) {
  if (!DB.months[month]) return null;
  const key = aggregateDeptCacheKey(month, filter, subFilter, doctorIds);
  const cache = specializationCalculations?.activity;
  if (cache?.has(key)) return cache.get(key);
  const ids = scopeDoctorsInMonth(month, filter, subFilter, doctorIds);
  if (!ids.length) return null;

  const source = DB.months[month].primaryPatients?.perDoc;
  const patients = new Map(), primaryByDoctor = {};
  const isCount = value => Number.isSafeInteger(value) && value >= 0;
  for (const id of ids) {
    const report = source?.[id];
    const rows = report ? primaryPatientRows(report.patients) : null;
    primaryByDoctor[id] = rows?.every(row => isCount(row.primary)) ? rows.filter(row => row.primary > 0).length : null;
    for (const row of rows || []) {
      const entry = patients.get(row.key) || { primary: false, visits: 0 };
      entry.primary ||= row.primary > 0;
      if (row.primary > 0 && (row.source || row.sourceConflict)) {
        const category = primarySourceCategory(row);
        entry.sourceCategory = entry.sourceCategory === undefined || entry.sourceCategory === category ? category : null;
      }
      entry.visits = entry.visits != null && isCount(row.visits) ? entry.visits + row.visits : null;
      patients.set(row.key, entry);
    }
  }
  const primary = [...patients.values()].filter(patient => patient.primary);
  const covered = ids.filter(id => primaryByDoctor[id] != null).length;
  const primaryTotal = covered === ids.length ? primary.length : null;
  const sourceCounts = Array(5).fill(primaryTotal == null ? null : 0);
  if (primaryTotal != null) for (const patient of primary) sourceCounts[patient.sourceCategory ?? 4]++;
  const frequent = primaryTotal != null && primary.every(patient => patient.visits != null)
    ? primary.filter(patient => patient.visits > 3).length : null;

  let devices = null;
  if (deviceNames.length) {
    const byDoctor = {};
    const items = deviceNames.map(() => ({ q: 0, s: 0 }));
    for (const id of ids) {
      const product = computeMetrics(id, month)?.product;
      if (!product) continue;
      const doctorItems = deviceNames.map(name => product.expert[name] || { q: 0, s: 0 });
      doctorItems.forEach(({ q, s }, index) => { items[index].q += q; items[index].s += s; });
      byDoctor[id] = doctorItems;
    }
    devices = { byDoctor, items };
  }
  const activity = { ids, devices, primary: { byDoctor: primaryByDoctor, total: primaryTotal, frequent, sourceCounts,
    share: frequent != null && primaryTotal > 0 ? frequent / primaryTotal * 100 : null, covered } };
  cache?.set(key, activity);
  return activity;
}

function specializationDeviceNames(profile) {
  return profile?.expertise?.mode === "devices" ? [...new Set(profile.expertise.items.map(item => item.name))] : [];
}

function aggregateDeptMonthRaw(mk, deptFilter, subFilter = "all", doctorIds = null) {
  const ids = scopeDoctorsInMonth(mk, deptFilter, subFilter, doctorIds);
  if (!ids.length) return null;
  const records = ids.map(id => ({ id, r: computeMetrics(id, mk) })).filter(x => Boolean(x.r));
  const rs = records.map(x => x.r);
  if (!rs.length) return null;
  const sum = get => { const xs = rs.map(get).filter(v => v != null && !isNaN(v)); return xs.length ? xs.reduce((a, b) => a + b, 0) : null; };
  const avg = get => { const xs = rs.map(get).filter(v => v != null && !isNaN(v)); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
  const coverage = {};
  const completeFor = (key, accepts) => {
    const missingDoctors = records.filter(({ r }) => !accepts(r)).map(({ id }) => id);
    coverage[key] = { coveredDoctors: records.length - missingDoctors.length, expectedDoctors: records.length, complete: !missingDoctors.length, missingDoctors };
    return coverage[key].complete;
  };
  const ratio = (key, numeratorFor, denominatorFor, numerator, denominator, scale = 1) => {
    const complete = completeFor(key, r => Number.isFinite(numeratorFor(r)) && Number.isFinite(denominatorFor(r)));
    return complete && numerator != null && denominator > 0 ? numerator / denominator * scale : null;
  };
  const uniqueWindow = win => mergeClientBaseSummaries(records.map(({ id }) => reportClientBaseSummary(id, mk, win)).filter(Boolean), records.length);
  const unique1 = uniqueWindow(1);
  const unique12 = uniqueWindow(12);
  const unique24 = uniqueWindow(24);
  const unique36 = uniqueWindow(36);
  const primaryBase = unique36;
  const sales = sum(r => r.econ.sales);
  const withRef = sum(r => r.econ.revenueWithRef);
  const refSum = sum(r => r.econ.refRevenue);
  const visits = completeFor("visits", r => Number.isFinite(r.traffic.visits)) ? sum(r => r.traffic.visits) : null;
  const patients = completeFor("patients", r => Number.isFinite(r.traffic.patients)) && unique1 ? unique1.total : null;
  const visits12 = unique12 ? unique12.visits : null;
  const patients12 = unique12 ? unique12.total : null;
  const expSum = sum(r => r.extras.vy ? r.extras.vy.expertShareSum : null);
  const ownSum = sum(r => r.extras.vy ? r.extras.vy.ownSum : null);
  const pvMonths = [...new Set([3, 6, 12, ...rs.flatMap(r => Object.keys(r.loyalty.pvSlices || {}).map(Number))])].sort((a, b) => a - b);
  const pvSlices = {};
  for (const pvM of pvMonths) {
    const first = sum(r => r.loyalty.pvSlices[pvM] && r.loyalty.pvSlices[pvM].valid !== false ? r.loyalty.pvSlices[pvM].first : null);
    const ret = sum(r => r.loyalty.pvSlices[pvM] && r.loyalty.pvSlices[pvM].valid !== false ? r.loyalty.pvSlices[pvM].ret : null);
    const complete = completeFor("pv" + pvM, r => {
      const pv = r.loyalty.pvSlices[pvM];
      return pv && pv.valid !== false && Number.isFinite(pv.first) && Number.isFinite(pv.ret);
    });
    if (first != null && first > 0) pvSlices[pvM] = { pct: complete && ret != null ? ret / first * 100 : null, first, ret };
  }
  const schedNorm = sum(r => r.loyalty.sched ? r.loyalty.sched.normaMin : null);
  const schedBusy = sum(r => r.loyalty.sched ? r.loyalty.sched.busyMin : null);
  const schedFact = sum(r => r.loyalty.sched ? r.loyalty.sched.factMin : null);
  const scheduleComplete = completeFor("schedLoad", r => r.loyalty.sched && Number.isFinite(r.loyalty.sched.normaMin) && Number.isFinite(r.loyalty.sched.busyMin));
  const scheduleFactComplete = completeFor("schedFact", r => r.loyalty.sched && Number.isFinite(r.loyalty.sched.normaMin) && Number.isFinite(r.loyalty.sched.factMin));
  const aggregateNazSlice = slice => {
    const values = rs.map(r => r.cross.naz[slice]).filter(nz => nz && nz.totals && nz.totals.valid !== false);
    if (!values.length) return null;
    const total = key => {
      const known = values.map(nz => nz.totals[key]).filter(v => v != null && !isNaN(v));
      return known.length ? known.reduce((a, b) => a + b, 0) : null;
    };
    const assigned = total("assigned");
    const done = total("done");
    const soldQ = total("soldQ");
    const soldSum = total("soldSum");
    const resultQ = total("resultQ");
    const conversionComplete = completeFor("naz" + slice, r => {
      const nz = r.cross.naz[slice];
      return nz && nz.totals && nz.totals.valid !== false && Number.isFinite(nz.totals.assigned) && Number.isFinite(nz.totals.resultQ);
    });
    const focusRows = values.map(nz => nz.focus).filter(Boolean);
    const focusSum = key => {
      const known = focusRows.map(focus => focus[key]).filter(v => v != null && !isNaN(v));
      return known.length ? known.reduce((a, b) => a + b, 0) : null;
    };
    return {
      slice,
      totals: {
        assigned, done, soldQ, soldSum, resultQ, valid: true,
        conv: conversionComplete && assigned > 0 && resultQ != null ? resultQ / assigned * 100 : null,
      },
      focus: conversionComplete && focusRows.length === rs.length && focusRows.every(row => Number.isFinite(row.assigned) && Number.isFinite(row.resultQ)) ? {
        title: focusRows[0].title,
        assigned: focusSum("assigned"),
        done: focusSum("done"),
        soldQ: focusSum("soldQ"),
        resultQ: focusSum("resultQ"),
      } : null,
    };
  };
  const naz1 = aggregateNazSlice(1);
  const naz3 = aggregateNazSlice(3);
  const ownRecords = sum(r => r.loyalty.ownRec ? r.loyalty.ownRec.count : null);
  const courseCnt = sum(r => r.loyalty.courseCnt);
  const courseBase = sum(r => r.loyalty.courseBase);
  const productRows = rs.map(r => r.product).filter(Boolean);
  const usedExpertNames = new Set();
  for (const product of productRows) {
    for (const [name, item] of Object.entries(product.expert || {})) {
      if (item && item.q > 0) usedExpertNames.add(name);
    }
  }
  const scoreTotal = avg(r => r.scores && r.scores.rankEligible ? r.scores.total : null);
  // «виртуальный r» отделения
  return {
    econ: {
      sales, refRevenue: refSum, revenueWithRef: withRef,
      avgClient: ratio("avgClient", r => r.econ.sales, r => r.traffic.patients, sales, patients),
      avgClientRef: ratio("avgClientRef", r => r.econ.revenueWithRef, r => r.traffic.patients, withRef, patients),
      avgVisit: ratio("avgVisit", r => r.econ.sales, r => r.traffic.visits, sales, visits),
    },
    traffic: { visits, patients, freq: ratio("freq", r => r.traffic.visits, r => r.traffic.patients, visits, patients) },
    loyalty: {
      sched: scheduleComplete && schedNorm > 0 && schedBusy != null
        ? {
          pct: schedBusy / schedNorm * 100,
          factPct: scheduleFactComplete && schedFact != null ? schedFact / schedNorm * 100 : null,
          gapPct: scheduleFactComplete && schedFact != null ? (schedBusy - schedFact) / schedNorm * 100 : null,
          normaMin: schedNorm, busyMin: schedBusy, factMin: schedFact,
        }
        : null,
      pvSlices,
      ownRec: (() => {
        const pct = ratio("ownRec", r => r.loyalty.ownRec ? r.loyalty.ownRec.count : null, r => r.traffic.visits, ownRecords, visits, 100);
        return pct != null ? { count: ownRecords, pct } : null;
      })(),
      courseIdx: ratio("courseIdx", r => r.loyalty.courseCnt, r => r.loyalty.courseWin === rs[0].loyalty.courseWin ? r.loyalty.courseBase : null, courseCnt, courseBase, 100),
      freq12: ratio("freq12", r => r.akb.wins[12] ? r.akb.wins[12].visits : null, r => r.akb.wins[12] ? r.akb.wins[12].total : null, visits12, patients12),
    },
    cross: {
      crossShare: ratio("crossShare", r => r.econ.refRevenue, r => r.econ.revenueWithRef, refSum, withRef, 100),
      naz: { 1: naz1, 3: naz3 },
    },
    akb: {
      primary: primaryBase,
      primaryWin: primaryBase && primaryBase.windows.length === 1 ? primaryBase.windows[0] : null,
      availableWins: [...new Set(rs.flatMap(r => r.akb.availableWins || []))].sort((a, b) => a - b),
      wins: { 12: unique12, 24: unique24, 36: unique36 },
      churn36: unique36 ? unique36.lostPct : null,
    },
    product: (ownSum != null && ownSum > 0) ? {
      expertShare: ratio("expertShare", r => r.extras.vy ? r.extras.vy.expertShareSum : null, r => r.extras.vy ? r.extras.vy.ownSum : null, expSum, ownSum, 100),
      devicesUsed: usedExpertNames.size,
      park: productRows.length ? Math.max(...productRows.map(product => Number(product.park) || 0)) : 0,
    } : null,
    rep: {
      avgRating: avg(r => r.rep ? r.rep.avgRating : null),
      nps: avg(r => r.rep ? r.rep.nps : null),
      reviews: sum(r => r.rep ? r.rep.reviews : null),
      totalReviews: completeFor("totalReviews", r => Number.isFinite(r.rep?.totalReviews)) ? sum(r => r.rep.totalReviews) : null,
    },
    extras: { vy: (ownSum != null && ownSum > 0) ? { ownSum, expertShareSum: expSum || 0 } : null },
    scores: { total: scoreTotal, rankEligible: scoreTotal != null },
    vecAvg: (() => { const o = {}; for (const vk of ["v1","v2","v3","v4","v5","v6"]) o[vk] = avg(r => r.scores && r.scores.rankEligible ? r.scores.vec[vk] : null); return o; })(),
    doctors: rs.length,
    coverage,
  };
}

function computeDeptDynamics(endMk, deptFilter, subFilter = "all") {
  const profile = typeof deptFilter === "string" && deptFilter !== "all" ? deptProfile(deptFilter) : deptProfile("По умолчанию");
  return buildDynamics(calendarYearMonthKeys(endMk), endMk, k => aggregateDeptMonth(k, deptFilter || "all", subFilter), 12, profile);
}
