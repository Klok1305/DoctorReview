"use strict";

function cloudReportNumbers(result, report) {
  const definitions = [
    ["score.overall", report.overall, "score"], ["score.coverage", report.coverage, "percent"],
    ["traffic.patients", result.traffic.patients, "count"], ["traffic.visits", result.traffic.visits, "count"],
    ["traffic.frequencyMonth", result.traffic.freq, "ratio"], ["loyalty.frequency12", result.loyalty.freq12, "ratio"],
    ["economy.sales", result.econ.sales, "rub"], ["economy.withReferrals", result.econ.revenueWithRef, "rub"],
    ["economy.averageClient", result.econ.avgClient, "rub"], ["economy.averageVisit", result.econ.avgVisit, "rub"],
    ["loyalty.scheduleLoad", result.loyalty.sched?.pct, "percent"], ["loyalty.ownRecords", result.loyalty.ownRec?.pct, "percent"],
    ["loyalty.course", result.loyalty.courseIdx, "percent"], ["referrals.share", result.cross.crossShare, "percent"],
    ["reputation.rating", result.rep?.avgRating, "ratio"], ["reputation.nps", result.rep?.nps, "percent"],
    ["reputation.newReviews", result.rep?.reviews, "count"], ["reputation.totalReviews", result.rep?.totalReviews, "count"],
    ...[3, 6, 12].map(window => [`primary.return${window}`, result.loyalty.pvSlices[window]?.pct, "percent"]),
    ...[1, 3].map(window => [`appointments.conversion${window}`, result.cross.naz[window]?.totals.conv, "percent"]),
    ...report.vectors.map(vector => [`score.${vector.id}`, vector.score, "score"]),
  ];
  return { version: 1, metrics: definitions.map(([id, value, unit]) => ({ id, value: Number.isFinite(value) ? value : null, unit })) };
}

function cloudReportDynamics(monthKey, getResult, profile, noteKey) {
  const dynamics = buildDynamics(monthKeysSorted(), monthKey, getResult, Number(monthKey.slice(5)), profile);
  if (!dynamics.rows.length) return null;
  const notes = DB.dynamicNotes || {}, manual = Object.prototype.hasOwnProperty.call(notes, noteKey);
  const narrative = manual ? notes[noteKey] : buildDynamicsCommentary(dynamics);
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…" };
  const conclusion = typeof narrative === "string" ? narrative : narrative?.format === "rich-v1"
    ? String(narrative.html || "").replace(/<br\s*\/?\s*>|<\/(?:p|div)>/gi, "\n").replace(/<[^>]*>/g, "")
      .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
        if (!entity.startsWith("#")) return entities[entity.toLowerCase()] ?? match;
        const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }).trim() : "";
  const chart = (id, title, keys, unit) => mobilePublicationChart(id, title, "line", dynamics.months.map(monthLabel),
    keys.map(([key, label, color]) => ({ label, color,
      values: dynamics.rows.find(row => row.key === key)?.values || dynamics.months.map(() => null) })), unit);
  return {
    columns: dynamics.months.map(monthLabel),
    rows: dynamics.rows.map(row => ({ key: row.key, label: row.name,
      values: row.values.map(value => value == null ? "·" : row.fmt(value)),
      delta: mobilePublicationPercentChange(row.delta), averageDelta: mobilePublicationPercentChange(row.deltaAvg),
      target: row.target != null ? `${row.lower ? "≤" : "≥"} ${row.fmt(row.target)}` : "",
      state: row.improving === true ? "good" : row.improving === false ? "bad" : "neutral" })),
    growth: dynamics.growth.slice(0, 8).map(dynamicsMetricComment), risk: dynamics.risk.slice(0, 8).map(dynamicsMetricComment),
    conclusion, conclusionManual: manual,
    charts: [
      chart("money", "Выручка по месяцам", [["sales", "Собственная выручка", "#2563eb"], ["withRef", "С перенаправлениями", "#7c3aed"]], "₽"),
      chart("traffic", "Визиты и пациенты", [["visits", "Визиты", "#2563eb"], ["patients", "Пациенты", "#16a34a"]], "шт."),
      chart("rates", "Загрузка и конверсия", [["sched", "Расписание", "#d97706"], ["perv", "Первичка", "#2563eb"], ["nazConv", "Назначения", "#db2777"]], "%"),
      mobilePublicationChart("scores", "Баллы по векторам", "line", dynamics.months.map(monthLabel), [
        { label: "Общий балл", color: "#1c2333", values: dynamics.months.map(key => dynamics.results[key]?.scores?.total ?? null) },
        ...["v1", "v2", "v3", "v4", "v5", "v6"].map(key => ({ label: `В${key[1]} ${VECTOR_META[key].name}`, color: VEC_LINE_COLORS[key],
          values: dynamics.months.map(month => dynamics.results[month]?.scores?.vec?.[key] ?? dynamics.results[month]?.vecAvg?.[key] ?? null) })),
      ], "баллов"),
    ].filter(Boolean),
  };
}

function cloudDoctorReport(doctorId, monthKey, comments) {
  const result = computeMetrics(doctorId, monthKey), profile = profileForDoctor(doctorId);
  const report = buildMobilePublicationPeriod(doctorId, monthKey, result,
    doctorHasDashboardData(doctorId, prevMonthKey(monthKey)) ? computeMetrics(doctorId, prevMonthKey(monthKey)) : null, comments, { includeDynamics: false });
  const base = adminClientBaseSummary(doctorId, monthKey);
  const groups = ["active", "loyalSleep", "newRisk", "lost"];
  Object.assign(report.vectors[3], {
    methodologyId: "partition-v1-36m", scoreMethodologyId: "legacy-overlap-v1",
    methodologyLabel: "Четыре непересекающиеся группы за 36 месяцев, как в Admin и HTML. Балл В4 сохраняет прежнюю методику.",
    detail: "Клиентская база за три года: только количества и показатели.",
    windows: [{ id: "36", label: "3 года", period: "Точное окно 36 месяцев", methodologyId: "partition-v1-36m",
      sections: base ? [{ title: "Клиентская база", note: adminClientBaseQualityNote(base),
        metrics: [mobilePublicationMetric("Общая база", fmtNum(base.total)), mobilePublicationMetric("Активные лояльные", fmtNum(base.seg.active)),
          mobilePublicationMetric("Кандидаты на реактивацию", fmtNum(base.reactivationCandidates)), mobilePublicationMetric("Выручка кандидатов", fmtMoney(base.reactivationSum))],
        columns: ["Группа", "Пациенты", "Доля", "Условие"],
        rows: groups.map(group => [adminClientBaseGroupLabel(group), fmtNum(base.seg[group]), fmtPct(base.total ? base.seg[group] / base.total * 100 : null), adminClientBaseGroupDescription(base.partition, group)]),
        charts: [mobilePublicationChart("partition", "Группы клиентской базы", "donut", groups.map(adminClientBaseGroupLabel),
          [{ label: "Пациенты", values: groups.map(group => base.seg[group]), colors: ["#16a34a", "#94a3b8", "#d97706", "#dc2626"] }], "чел.")].filter(Boolean),
      }] : [{ title: "Клиентская база", metrics: [mobilePublicationMetric("Данные", "Нет точной выгрузки за 36 месяцев")] }] }],
  });
  report.dynamics = cloudReportDynamics(monthKey, key => doctorHasDashboardData(doctorId, key) ? computeMetrics(doctorId, key) : null,
    profile, `doctor|${monthKey}|${doctorId}`);
  const scoreChart = report.dynamics?.charts.find(chart => chart.id === "scores");
  for (const vector of report.vectors) {
    const charts = scoreChart ? [{ ...scoreChart, id: `score-${vector.id}`, title: `Динамика В${vector.number}`, series: [scoreChart.series.find(series => series.label.startsWith(`В${vector.number} `))].filter(Boolean) }] : [];
    if (!charts.length || !charts[0].series.length) continue;
    const section = { title: "Баллы по месяцам", charts };
    if (vector.windows) vector.windows.forEach(window => window.sections.push(section));
    else vector.sections.push(section);
  }
  report.numbers = cloudReportNumbers(result, report);
  return report;
}

function cloudGroupReport(item, monthKey, comments, doctors) {
  const ids = doctors.filter(doctor => item.kind === "clinic" || (item.kind === "department" ? doctor.department === item.department : doctor.specialization === item.specialization)).map(doctor => doctor.doctorId);
  const getResult = key => aggregateDeptMonth(key, "all", "all", ids);
  const result = getResult(monthKey);
  if (!result) throw new Error("Нет показателей сводного отчёта");
  const profile = item.kind === "specialization" ? deptProfile(item.specialization) : departmentProfile(item.department);
  const metric = (label, value, formatter = fmtNum, note = "") => mobilePublicationMetric(label, formatter(value), note);
  const section = (title, metrics, extra = {}) => ({ title, metrics, ...extra });
  const records = ids.filter(id => doctorHasDashboardData(id, monthKey)).map(id => ({ id, result: computeMetrics(id, monthKey) }));
  const scopeComments = comments.filter(comment => comment.scopeType === item.context.scopeType && String(comment.scopeId) === item.context.scopeId && comment.status !== "archived" && String(comment.bodyText || "").trim())
    .map(comment => ({ blockKey: comment.blockKey, title: "Комментарий администратора", text: comment.bodyText, author: comment.authorName || "Администратор", updatedAt: comment.updatedAt }));
  const revenueGroups = new Map();
  for (const { result: doctorResult } of records) for (const [name, group] of Object.entries(doctorResult.product?.byGroup || {})) {
    const total = revenueGroups.get(name) || { q: 0, s: 0 };
    total.q += group.q || 0; total.s += group.s || 0; revenueGroups.set(name, total);
  }
  const base = result.akb.primary;
  const groups = ["loyal", "active", "newRisk", "loyalSleep", "lost"];
  const missing = Object.entries(result.coverage).filter(([, value]) => !value.complete).map(([key, value]) => `${key}: данные ${value.coveredDoctors} из ${value.expectedDoctors} врачей`);
  const vectorSections = [
    [section("Экономика", [metric("Собственная выручка", result.econ.sales, fmtMoney), metric("С перенаправлениями", result.econ.revenueWithRef, fmtMoney),
      metric("На пациента", result.econ.avgClient, fmtMoney), metric("На посещение", result.econ.avgVisit, fmtMoney)])],
    [section("Экспертный профиль", [metric("Использовано позиций", result.product?.devicesUsed), metric("Доля экспертных услуг", result.product?.expertShare, fmtPct)], {
      columns: ["Категория", "Количество", "Выручка"], rows: [...revenueGroups].map(([name, group]) => [name, fmtNum(group.q), fmtMoney(group.s)]),
      charts: [mobilePublicationPie("revenue", "Структура выручки", [...revenueGroups].map(([name, group], index) => [name, group.s, ["#2563eb", "#7c3aed", "#16a34a", "#d97706"][index % 4]]), "₽")].filter(Boolean),
    })],
    [section("Направления", [metric("Выручка от направлений", result.econ.refRevenue, fmtMoney), metric("Доля направлений", result.cross.crossShare, fmtPct)]),
      ...[1, 3].map(window => section(`Назначения · ${window} мес.`, [metric("Назначено", result.cross.naz[window]?.totals.assigned),
        metric("Выполнено + продано", result.cross.naz[window]?.totals.resultQ), metric("Конверсия", result.cross.naz[window]?.totals.conv, fmtPct)]))],
    [section("Клиентская база", [metric("Общая база", base?.total), metric("Активная база", base?.activeBasePct, fmtPct), metric("Потерянные", base?.lostPct, fmtPct)], {
      note: "Сводная совместимая методика: группы могут пересекаться. При разных окнах или неполном покрытии доли не рассчитываются.",
      columns: ["Группа", "Пациенты"], rows: groups.map(group => [clientBaseGroupLabel(group), fmtNum(base?.seg[group])]),
    })],
    [section("Лояльность", [metric("Расписание", result.loyalty.sched?.pct, fmtPct), metric("Собственная запись", result.loyalty.ownRec?.pct, fmtPct),
      metric("Курсовое лечение", result.loyalty.courseIdx, fmtPct), metric("Частота за 12 мес.", result.loyalty.freq12, value => fmtNum(value, 2))], {
      columns: ["Первичка", "Первичных", "Вернулось", "Возвращаемость"], rows: [3, 6, 12].map(window => [`${window} мес.`, fmtNum(result.loyalty.pvSlices[window]?.first), fmtNum(result.loyalty.pvSlices[window]?.ret), fmtPct(result.loyalty.pvSlices[window]?.pct)]),
    })],
    [section("Репутация", [metric("Средний рейтинг", result.rep.avgRating, value => fmtNum(value, 2)), metric("NPS", result.rep.nps, fmtPct),
      metric("Новые отзывы", result.rep.reviews), metric("Всего отзывов", result.rep.totalReviews)], {
      columns: ["Врач", "Балл", "Полнота", "Отзывы"], rows: [...records].sort((a, b) => (b.result.scores?.rankEligible ? b.result.scores.total : -1) - (a.result.scores?.rankEligible ? a.result.scores.total : -1))
        .map(({ id, result: row }) => [doctorName(id), fmtNum(row.scores?.total, 1) + (row.scores?.preliminary ? " · предв." : ""), fmtPct(row.scores?.coveragePct), fmtNum(row.rep?.totalReviews)]),
    })],
  ];
  const vectors = ["v1", "v2", "v3", "v4", "v5", "v6"].map((id, index) => ({ id, number: index + 1, title: VECTOR_META[id].name,
    score: Number.isFinite(result.vecAvg[id]) ? Math.round(result.vecAvg[id]) : null, delta: null, coverage: null, preliminary: false,
    detail: "Сводные показатели включённых врачей. Несопоставимые значения остаются незаданными.", sections: vectorSections[index] }));
  const overall = Number.isFinite(result.scores.total) ? Math.round(result.scores.total) : null;
  const previous = getResult(prevMonthKey(monthKey))?.scores?.total;
  const report = { id: monthKey, label: monthLabel(monthKey), shortLabel: monthLabel(monthKey).split(/\s+/)[0], overall, coverage: null, preliminary: false, missing,
    overallDelta: overall != null && Number.isFinite(previous) ? overall - Math.round(previous) : null,
    assessment: overall == null ? "Нет полной оценки" : "Средний балл врачей с полной оценкой", summary: `${result.doctors} врачей. Предварительные оценки исключены из среднего балла.`,
    headlineMetrics: [metric("Пациентов за месяц", result.traffic.patients), metric("Загрузка расписания", result.loyalty.sched?.pct, fmtPct),
      metric("Визитов на пациента", result.traffic.freq, value => fmtNum(value, 2)), metric("Частота за 12 мес.", result.loyalty.freq12, value => fmtNum(value, 2)), metric("Активная база", base?.activeBasePct, fmtPct)],
    vectors, goals: [], comments: scopeComments,
    dynamics: cloudReportDynamics(monthKey, getResult, profile, `${item.kind === "specialization" ? "dept" : item.context.scopeType}|${monthKey}|${item.context.scopeId}|all`),
  };
  if (item.kind !== "clinic") report.goals = departmentMetricDefs().map(def => {
    const goal = departmentGoalInfo(def, result, profile);
    return goal ? { title: def.label, description: goal.text, progress: 0, state: goal.state.endsWith("good") ? "good" : "warn" } : null;
  }).filter(Boolean);
  report.numbers = cloudReportNumbers(result, report);
  return report;
}
