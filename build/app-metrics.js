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

/* Отображаемое отделение врача и его профиль (см. app-core: resolvedDeptName/deptProfile) */
function doctorDept(id) {
  return resolvedDeptName(id);
}
function deptParams(docId) {
  return profileForDoctor(docId); // профиль содержит плоские нормативы (minVisits, activeM, …)
}

/* ---------- классификация позиции по ПРОФИЛЮ отделения ----------
   Возвращает { group, sub, expertItem, devCandidate, unmapped, showQty } */
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
  // 3. показывать ли штуки на графиках экспертности
  const showQty = ov && ov.showQty != null ? ov.showQty : (ex.mode === "devices");
  return { group, sub: sub || "", expertItem, devCandidate, unmapped, showQty };
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
    expert: { items: {}, sum: 0 },  // экспертные позиции: имя -> {q, s, qShow}
    devCandidates: {},  // «похоже на экспертное, но не привязано»
    unmapped: {},       // нераспознанное: n -> {cat, q, s, goods}
    refByType: {},      // направления по типам -> {s, q, items: {n: {s, q}}}
  };
  for (const it of v.items) {
    const cls = classifyItem(profile, it.cat, it.n, it.goods);
    const own = it.form === "" ? (it.sOwn || 0) : 0;
    const assist = it.form !== "" ? (it.sOwn || 0) : 0;
    const ref = it.sRef || 0;
    const qOwn = own > 0 || (!assist && !ref) ? (it.q || 0) : 0;
    out.ownSum += own;
    out.assistSum += assist;
    out.refSum += ref;
    out.ownQty += qOwn;
    if (ref > 0) out.refQty += (own > 0 ? 0 : (it.q || 0));
    if (assist > 0) out.assistQty += it.q || 0;
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
        if (!out.expert.items[cls.expertItem]) out.expert.items[cls.expertItem] = { q: 0, s: 0, qShow: 0 };
        const e = out.expert.items[cls.expertItem];
        e.q += qOwn;
        e.s += own;
        if (cls.showQty) e.qShow += qOwn;
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
      const qRef = own > 0 ? 0 : (it.q || 0);
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
  const out = { slice: Number(slice), period: nz.period, totals: { assigned: 0, done: 0, soldQ: 0, soldSum: 0 }, byType: {} };
  for (const t of REF_TYPES) out.byType[t] = { assigned: 0, done: 0, soldQ: 0, soldSum: 0, items: {} };
  for (const it of nz.items) {
    const cls = classifyItem(profile, "", it.n, false);
    const t = refTypeOf(cls);
    const b = out.byType[t];
    b.assigned += it.a; b.done += it.d; b.soldQ += it.sq; b.soldSum += it.ss;
    if (!b.items[it.n]) b.items[it.n] = { assigned: 0, done: 0, soldQ: 0, soldSum: 0 };
    const bi = b.items[it.n];
    bi.assigned += it.a; bi.done += it.d; bi.soldQ += it.sq; bi.soldSum += it.ss;
    out.totals.assigned += it.a; out.totals.done += it.d; out.totals.soldQ += it.sq; out.totals.soldSum += it.ss;
  }
  for (const t of REF_TYPES) {
    const b = out.byType[t];
    b.conv = b.assigned > 0 ? (b.done + b.soldQ) / b.assigned * 100 : null;
  }
  out.totals.conv = out.totals.assigned > 0 ? (out.totals.done + out.totals.soldQ) / out.totals.assigned * 100 : null;
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
function kbSummary(docId, monthKey, win) {
  const kb = kbWindow(docId, monthKey, win);
  if (!kb) return null;
  const p = deptParams(docId);
  const dActive = Math.round(p.activeM * 30.44);
  const dRisk = Math.round(p.riskM * 30.44);
  const seg = { loyalActive: 0, loyalRisk: 0, loyalSleep: 0, newActive: 0, newRisk: 0, lost: 0 };
  let totalSum = 0, totalVisits = 0, lostSum = 0;
  for (const c of kb.clients) {
    totalSum += c.s;
    totalVisits += c.v;
    const loyal = c.v >= p.minVisits;
    const r = c.r == null ? 0 : c.r;
    if (loyal) {
      if (r <= dActive) seg.loyalActive++;
      else if (r <= dRisk) seg.loyalRisk++;
      else seg.loyalSleep++;
    } else {
      if (r <= dActive) seg.newActive++;
      else if (r <= dRisk) seg.newRisk++;
      else { seg.lost++; lostSum += c.s; }
    }
  }
  const total = kb.clients.length;
  const sorted = [...kb.clients].sort((a, b) => b.s - a.s);
  const coreShare = (p.corePct || 80) / 100;
  let acc = 0, core = 0;
  for (const c of sorted) {
    if (acc >= totalSum * coreShare) break;
    acc += c.s; core++;
  }
  const courseCnt = kb.clients.filter(c => c.v >= p.courseX).length;
  return {
    window: Number(win), period: kb.period, params: p,
    total, seg, totalSum, totalVisits, lostSum,
    visits: totalVisits, patients: total,
    freq: total ? totalVisits / total : null,
    avgVisit: totalVisits ? totalSum / totalVisits : null,
    avgClient: total ? totalSum / total : null,
    one2: seg.newActive + seg.newRisk + seg.lost,
    activeBase: seg.loyalActive,
    activeBasePct: total ? seg.loyalActive / total * 100 : null,
    lostPct: total ? seg.lost / total * 100 : null,
    riskShare: total ? (seg.loyalRisk + seg.newRisk) / total * 100 : null,
    sleepRiskShare: total ? (seg.loyalRisk + seg.loyalSleep + seg.newRisk) / total * 100 : null,
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
  const kb36 = kbSummary(docId, monthKey, 36) || (kbWins.find(w => w >= 24) ? kbSummary(docId, monthKey, kbWins.find(w => w >= 24)) : null);
  const naz1 = naznachSummary(docId, monthKey, 1);
  const naz3 = naznachSummary(docId, monthKey, 3);
  const prostoy = m.prostoy[docId];
  const zapis = m.zapis[docId];
  const man6 = (m.manual6 || {})[docId];
  const slices = Object.keys(m.pervichka).map(Number).sort((a, b) => a - b);
  const pvSlices = {};
  for (const s of slices) {
    const d = m.pervichka[String(s)].perDoc[docId];
    if (d) pvSlices[s] = Object.assign({ pct: d.first > 0 ? d.ret / d.first * 100 : null }, d);
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
  const refRevenue = vy && vy.refSum > 0 ? vy.refSum : (naz1 ? naz1.totals.soldSum : (vy ? vy.refSum : null));
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
    expert: vy.expert.items,          // имя -> {q, s, qShow}
    devicesUsed: usedNames.length,
    park: coreNames.length,
    expertShare: vy.ownSum > 0 ? vy.expertShareSum / vy.ownSum * 100 : null,
    devCandidates: vy.devCandidates,
    unmapped: vy.unmapped,
  } : null;

  /* В3 АКБ */
  const akb = { wins: {}, availableWins: kbWins.filter(w => w >= 6) };
  for (const w of kbWins) akb.wins[w] = kbSummary(docId, monthKey, w);
  akb.churn36 = kb36 ? kb36.lostPct : null;

  /* В4 Лояльность */
  const sched = prostoy ? (() => {
    const norma = prostoy.normaMin;
    const busy = prostoy.zayavkiMin != null ? prostoy.zayavkiMin : null;
    const pct = (busy != null && norma) ? busy / norma * 100 : (prostoy.schedPct != null ? prostoy.schedPct : null);
    return { normaMin: norma, busyMin: busy, pct, factMin: prostoy.factMin, nvPct: prostoy.schedNvPct };
  })() : null;
  const ownRec = zapis ? {
    count: zapis.zapis,
    pct: traffic.visits ? zapis.zapis / traffic.visits * 100 : null,
  } : null;
  // курсовое: «≥X визитов за последние M месяцев» — считаем по КБ-окну ровно M мес,
  // иначе по ближайшему окну побольше (с пометкой)
  const pDept = deptParams(docId);
  let courseWin = null;
  if (kbWins.includes(pDept.courseM)) courseWin = pDept.courseM;
  else {
    const bigger = kbWins.filter(w => w >= pDept.courseM);
    courseWin = bigger.length ? bigger[0] : null;
  }
  const kbCourse = courseWin != null ? kbSummary(docId, monthKey, courseWin) : null;
  const loyalty = {
    sched, ownRec,
    pvSlices, slices,
    courseIdx: kbCourse ? kbCourse.courseIdx : null,
    courseCnt: kbCourse ? kbCourse.courseCnt : null,
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
    const ratings = ["prodoctorov", "napopravku", "doctu", "yandex"].map(k => man6[k]).filter(v => v != null && v > 0);
    rep = {
      avgRating: ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null,
      nps: man6.nps != null ? man6.nps : null,
      reviews: man6.reviews != null ? man6.reviews : null,
      raw: man6,
    };
  }

  /* ---- Баллы: % выполнения нормативов ОТДЕЛЕНИЯ (профиль → «Баллы и веса»).
     Пустая цель = метрика не оценивается (пример: нет плана по выручке, но есть по чеку). ---- */
  const B = profile.scoring.benchmarks;
  const achieve = (v, t, lower) => {
    if (v == null || isNaN(v) || t == null || t === "" || isNaN(t) || !t) return null;
    if (lower) return v <= 0 ? 1 : Math.min(t / v, 1);
    return Math.max(0, Math.min(v / t, 1));
  };
  const meanScore = arr => {
    const xs = arr.filter(x => x != null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length * 100 : null;
  };
  const expertSharePct = product ? product.expertShare : null;
  const nazBest = naz1 || naz3;
  const v3ScoreForNaz = nz => meanScore([
    achieve(cross.crossShare, B.crossShare),
    nz && nz.totals.conv != null ? achieve(nz.totals.conv, B.nazConv) : null,
  ]);
  const v3ByNaz = {
    1: naz1 ? v3ScoreForNaz(naz1) : null,
    3: naz3 ? v3ScoreForNaz(naz3) : null,
  };
  const kbForScore = kb12 || kb36;
  const pvM = profile.pervichkaM || 3;
  const pvForScore = pvSlices[pvM] || pvSlices[3] || pvSlices[slices.find(s => pvSlices[s])];
  const vecScores = {
    v1: meanScore([achieve(sales, B.revenue), achieve(avgClient, B.avgCheck)]),
    // если у отделения нет «экспертности» (mode none) — Вектор 2 не оценивается, вес уходит остальным
    v2: (vy && ex.mode !== "none") ? meanScore([achieve(expertSharePct, B.hwShare), (product && product.park) ? product.devicesUsed / product.park : null]) : null,
    v3: v3ScoreForNaz(nazBest),
    v4: kbForScore ? meanScore([
      achieve(kbForScore.activeBasePct, B.akbShare),
      achieve(kbForScore.riskShare, B.riskShare, true),
      achieve(kb36 ? kb36.lostPct : kbForScore.lostPct, B.churn, true),
    ]) : null,
    v5: meanScore([
      sched ? achieve(sched.pct, B.schedLoad) : null,
      pvForScore ? achieve(pvForScore.pct, B.pervichka) : null,
      ownRec && ownRec.pct != null ? achieve(ownRec.pct, B.ownRecords) : null,
      achieve(loyalty.courseIdx, B.courseIdx),
    ]),
    v6: rep ? meanScore([achieve(rep.avgRating, B.rating), achieve(rep.nps, B.nps), achieve(rep.reviews, B.reviews)]) : null,
  };
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
  const totalByNaz = {};
  for (const slice of [1, 3]) {
    if (v3ByNaz[slice] == null) continue;
    totalByNaz[slice] = scoreTotalFor({ ...vecScores, v3: v3ByNaz[slice] }).total;
  }
  const scores = { vec: vecScores, total: baseTotal.total, wSum: baseTotal.wSum, v3ByNaz, totalByNaz };

  /* полнота */
  const missing = [];
  if (!vy) missing.push("выработка");
  if (!kb1) missing.push("давность за месяц");
  if (!kb12) missing.push("давность 12 мес");
  if (!kb36) missing.push("давность 3 года");
  if (!naz1 && !naz3) missing.push("назначения");
  if (!prostoy) missing.push("загрузка расписания");
  if (!zapis) missing.push("запись в 1С");
  if (!Object.keys(pvSlices).length) missing.push("первичка");

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
/* Отделения, по которым есть выработки (для настроек) */
function deptsWithData() {
  const set = new Set();
  for (const m of Object.values(DB.months)) {
    for (const docId of Object.keys(m.vyrabotka)) set.add(resolvedDeptName(docId));
  }
  return [...set];
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
  return [
    { key: "sales", name: "Продажи", fmt: fmtMoney, get: r => r.econ.sales, target: B.revenue },
    { key: "withRef", name: "Выручка с перенаправлениями", fmt: fmtMoney, get: r => r.econ.revenueWithRef },
    { key: "avgClient", name: "Средний чек на пациента", fmt: fmtMoney, get: r => r.econ.avgClient, target: B.avgCheck },
    { key: "visits", name: "Визиты", fmt: v => fmtNum(v), get: r => r.traffic.visits },
    { key: "patients", name: "Пациенты", fmt: v => fmtNum(v), get: r => r.traffic.patients },
    { key: "freq", name: "Частота за месяц (виз./пациента)", fmt: v => fmtNum(v, 2), get: r => r.traffic.freq },
    { key: "return12", name: "Индекс возвращаемости за год (виз./пациента)", fmt: v => fmtNum(v, 2), get: r => r.loyalty.freq12 },
    { key: "sched", name: "Занятость расписания", fmt: fmtPct, get: r => r.loyalty.sched ? r.loyalty.sched.pct : null, target: B.schedLoad },
    { key: "perv", name: `Возвращаемость первички (${pvM} мес)`, fmt: fmtPct, get: r => r.loyalty.pvSlices[pvM] ? r.loyalty.pvSlices[pvM].pct : null, target: B.pervichka },
    { key: "ownRec", name: "Доля собственных записей", fmt: fmtPct, get: r => r.loyalty.ownRec ? r.loyalty.ownRec.pct : null, target: B.ownRecords },
    { key: "course", name: "Курсовое лечение", fmt: fmtPct, get: r => r.loyalty.courseIdx, target: B.courseIdx },
    { key: "hw", name: `Доля: ${exTitle}`, fmt: fmtPct, get: r => r.product ? r.product.expertShare : null, target: B.hwShare },
    { key: "cross", name: "Доля выручки от перенаправлений", fmt: fmtPct, get: r => r.cross.crossShare, target: B.crossShare },
    { key: "nazConv", name: "Конверсия назначений (1 мес)", fmt: fmtPct, get: r => r.cross.naz[1] ? r.cross.naz[1].totals.conv : null, target: B.nazConv },
    { key: "akb", name: "Активная база (12 мес)", fmt: v => fmtNum(v) + " чел.", get: r => r.akb.wins[12] ? r.akb.wins[12].seg.loyalActive : null },
    { key: "lost", name: "Потерянные (12 мес)", fmt: v => fmtNum(v) + " чел.", get: r => r.akb.wins[12] ? r.akb.wins[12].seg.lost : null, lower: true },
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
  const rs = ids.map(id => computeMetrics(id, mk)).filter(Boolean);
  if (!rs.length) return null;
  const sum = get => { const xs = rs.map(get).filter(v => v != null && !isNaN(v)); return xs.length ? xs.reduce((a, b) => a + b, 0) : null; };
  const avg = get => { const xs = rs.map(get).filter(v => v != null && !isNaN(v)); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
  const sales = sum(r => r.econ.sales);
  const withRef = sum(r => r.econ.revenueWithRef);
  const refSum = sum(r => r.econ.refRevenue);
  const visits = sum(r => r.traffic.visits);
  const patients = sum(r => r.traffic.patients);
  const visits12 = sum(r => r.akb.wins[12] ? r.akb.wins[12].visits : null);
  const patients12 = sum(r => r.akb.wins[12] ? r.akb.wins[12].total : null);
  const expSum = sum(r => r.extras.vy ? r.extras.vy.expertShareSum : null);
  const ownSum = sum(r => r.extras.vy ? r.extras.vy.ownSum : null);
  const pvMonths = [...new Set([3, 6, 12, ...rs.flatMap(r => Object.keys(r.loyalty.pvSlices || {}).map(Number))])].sort((a, b) => a - b);
  const pvSlices = {};
  for (const pvM of pvMonths) {
    const first = sum(r => r.loyalty.pvSlices[pvM] ? r.loyalty.pvSlices[pvM].first : null);
    const ret = sum(r => r.loyalty.pvSlices[pvM] ? r.loyalty.pvSlices[pvM].ret : null);
    if (first != null && first > 0) pvSlices[pvM] = { pct: (ret || 0) / first * 100, first, ret: ret || 0 };
  }
  const schedNorm = sum(r => r.loyalty.sched ? r.loyalty.sched.normaMin : null);
  const schedBusy = sum(r => r.loyalty.sched ? r.loyalty.sched.busyMin : null);
  const schedAvg = avg(r => r.loyalty.sched ? r.loyalty.sched.pct : null);
  const nazA = sum(r => r.cross.naz[1] ? r.cross.naz[1].totals.assigned : null);
  const nazD = sum(r => r.cross.naz[1] ? r.cross.naz[1].totals.done + r.cross.naz[1].totals.soldQ : null);
  // «виртуальный r» отделения
  return {
    econ: { sales, refRevenue: refSum, revenueWithRef: withRef, avgClient: (sales != null && patients) ? sales / patients : null },
    traffic: { visits, patients, freq: (visits != null && patients) ? visits / patients : null },
    loyalty: {
      sched: schedNorm && schedBusy != null
        ? { pct: schedBusy / schedNorm * 100, normaMin: schedNorm, busyMin: schedBusy }
        : (schedAvg != null ? { pct: schedAvg } : null),
      pvSlices,
      ownRec: avg(r => r.loyalty.ownRec ? r.loyalty.ownRec.pct : null) != null ? { pct: avg(r => r.loyalty.ownRec ? r.loyalty.ownRec.pct : null) } : null,
      courseIdx: avg(r => r.loyalty.courseIdx),
      freq12: (visits12 != null && patients12) ? visits12 / patients12 : null,
    },
    cross: {
      crossShare: (withRef && refSum != null) ? refSum / withRef * 100 : null,
      naz: { 1: (nazA != null && nazA > 0) ? { totals: { conv: nazD / nazA * 100 } } : null },
    },
    akb: { wins: { 12: (() => {
      const act = sum(r => r.akb.wins[12] ? r.akb.wins[12].seg.loyalActive : null);
      const lost = sum(r => r.akb.wins[12] ? r.akb.wins[12].seg.lost : null);
      const total = sum(r => r.akb.wins[12] ? r.akb.wins[12].total : null);
      return (act != null || lost != null || total != null) ? {
        total,
        activeBasePct: total ? (act || 0) / total * 100 : null,
        seg: { loyalActive: act, lost },
      } : null;
    })() } },
    product: (ownSum != null && ownSum > 0) ? { expertShare: (expSum || 0) / ownSum * 100 } : null,
    extras: { vy: (ownSum != null && ownSum > 0) ? { ownSum, expertShareSum: expSum || 0 } : null },
    scores: { total: avg(r => r.scores ? r.scores.total : null) },
    vecAvg: (() => { const o = {}; for (const vk of ["v1","v2","v3","v4","v5","v6"]) o[vk] = avg(r => r.scores ? r.scores.vec[vk] : null); return o; })(),
    doctors: rs.length,
  };
}

function computeDeptDynamics(endMk, deptFilter, subFilter = "all") {
  const profile = typeof deptFilter === "string" && deptFilter !== "all" ? deptProfile(deptFilter) : deptProfile("По умолчанию");
  return buildDynamics(monthKeysSorted(), endMk, k => aggregateDeptMonth(k, deptFilter || "all", subFilter), 6, profile);
}
