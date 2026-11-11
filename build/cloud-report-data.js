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

function cloudReportDynamics(monthKey, getResult, profile, noteKey, { includeScoreChart = true } = {}) {
  const dynamics = buildDynamics(calendarYearMonthKeys(monthKey), monthKey, getResult, 12, profile);
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
      includeScoreChart && mobilePublicationChart("scores", "Баллы по векторам", "line", dynamics.months.map(monthLabel), [
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
  const groups = ["active", "loyalSleep", "newRisk", "lost"];
  Object.assign(report.vectors[3], {
    methodologyId: "report-partition-v1", scoreMethodologyId: "legacy-overlap-v1",
    methodologyLabel: "Единые четыре непересекающиеся группы во всех отчётах. Балл В4 использует сохранённые нормативы.",
    detail: "Четыре группы рассчитываются по тем же правилам, что на графике динамики. По умолчанию выбрана база за 36 месяцев.",
    sections: [clientBaseDefinitionSection(profile), clientBasePartitionHistorySection(doctorId, monthKey)],
    windows: [36, 6, 12, 24].map(window => {
      const base = reportClientBaseSummary(doctorId, monthKey, window);
      const previous = reportClientBaseSummary(doctorId, prevMonthKey(monthKey), window);
      const series = adminClientBaseSeries(doctorId, monthKey, window);
      const visible = groups.filter(group => base?.groupAvailable[group]);
      return { id: String(window), label: `${window} мес.`, period: `Точное окно ${window} месяцев`, methodologyId: "report-partition-v1", sections: [{
        title: "Клиентская база", note: !base ? `Нет точной выгрузки за ${window} месяцев. Другой период не подставляется.`
          : "",
        metrics: [mobilePublicationMetric("Общая база", fmtNum(base?.total), previous && base ? mobilePublicationPercentChange(previous.total ? (base.total - previous.total) / previous.total * 100 : null) : "Нет данных за предыдущий месяц"),
          ...visible.map(group => mobilePublicationMetric(clientBaseGroupLabel(group), fmtPct(clientBaseGroupPct(base, group)), `${fmtNum(base.seg[group])} чел. · ${clientBaseShareMovement(clientBaseGroupPct(base, group), previous?.groupAvailable[group] ? clientBaseGroupPct(previous, group) : null)}`))],
        columns: ["Группа", "Пациенты", "Доля", "Условие"], rows: visible.map(group => [clientBaseGroupLabel(group), fmtNum(base.seg[group]), fmtPct(clientBaseGroupPct(base, group)), clientBaseGroupDescription(base, group)]),
        charts: [mobilePublicationChart("partition-shares", "Доли по месяцам", "line", series.months.map(monthLabel),
          groups.filter(group => series.bases.some(value => value?.groupAvailable[group])).map(group => ({ label: clientBaseGroupLabel(group), values: series.bases.map(value => value?.groupAvailable[group] ? clientBaseGroupPct(value, group) : null) })), "%")].filter(Boolean),
      }] };
    }),
  });
  const primary = doctorPrimaryPatients(doctorId, monthKey);
  const sources = doctorPrimarySources(primary);
  report.vectors[4].sections.push({ title: "Источники первичных пациентов",
    note: `Проценты — от всех первичных за соответствующий период. Неоднозначные и неизвестные источники не распределяются. ${!sources.year.complete || !sources.month.complete ? "Неполные данные: показаны первичные из загруженных отчётов." : ""}`,
    charts: [["year", `С начала ${monthKey.slice(0,4)} года — ${monthLabel(monthKey)}`], ["month", `За последний месяц · ${monthLabel(monthKey)}`]].map(([key, title]) => ({
      id: `primary-sources-${key}`, title, type: "donut", unit: "чел.", labels: globalThis.klinvektReportPresentation.primarySourceGroups.map(group => group.label),
      series: [{ label: "Первичные пациенты", values: sources[key].counts, colors: globalThis.klinvektReportPresentation.primarySourceGroups.map(group => group.color) }],
    })),
  });
  report.vectors[4].sections.push({ title: "Первичные пациенты врача",
    note: `Первичные у выбранного врача. Посещения — с первого месяца пациента; доли — от всех первичных за год. ${primary.incompletePrimaryMonths.length ? `Неполные данные: ${primary.incompletePrimaryMonths.map(monthLabel).join(", ")}.` : "Загружены все месяцы с начала года."} Списки пациентов — в Админ и защищённом Viewer.`,
    metrics: [mobilePublicationMetric("Первичных за месяц", fmtNum(primary.current?.count)),
      mobilePublicationMetric("Доля от всех пациентов месяца", fmtPct(primary.current?.share), primary.current ? `${fmtNum(primary.current.count)} из ${fmtNum(primary.current.total)} пациентов` : "Нет отчёта «Пациенты по врачам»"),
      mobilePublicationMetric(`Первичных за ${monthKey.slice(0, 4)} год`, fmtNum(primary.yearCount))],
    columns: ["Посещений с первого месяца", "Чел.", "Доля первичных за год"],
    rows: [...primary.buckets.map(bucket => [bucket.visits === 3 ? "3 и более" : String(bucket.visits), fmtNum(bucket.count), fmtPct(bucket.share)]),
      ...(primary.unknownVisits ? [["Неполные данные", fmtNum(primary.unknownVisits), fmtPct(primary.patients.length ? primary.unknownVisits / primary.patients.length * 100 : null)]] : [])],
  });
  report.dynamics = cloudReportDynamics(monthKey, key => doctorHasDashboardData(doctorId, key) ? doctorReportMetrics(doctorId, key) : null,
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
  report.numbers.metrics.push(...[
    ["primary.month.count", primary.current?.count, "count"], ["primary.month.share", primary.current?.share, "percent"],
    ["primary.year.count", primary.yearCount, "count"],
    ...primary.buckets.map(bucket => [`primary.year.visits${bucket.visits}`, bucket.count, "count"]),
  ].map(([id, value, unit]) => ({ id, value: Number.isFinite(value) ? value : null, unit, methodologyId: "doctor-primary-ytd-v1" })));
  for (const period of ["year", "month"]) for (let i = 0; i < 5; i++) {
    for (const [suffix, value, unit] of [["count", sources[period].counts[i], "count"], ["share", sources[period].shares[i], "percent"]]) {
      report.numbers.metrics.push({ id: `primary.sources.${period}.${i}.${suffix}`, value, unit, methodologyId: "doctor-primary-sources-v1" });
    }
  }
  return report;
}

const SPECIALIZATION_BASE_TITLE = "Динамика с начала года · база за 36 месяцев";
const SPECIALIZATION_DEVICE_TITLE = "Загрузка аппаратов";
const SPECIALIZATION_DEVICE_NOTE = "Доля рассчитана от собственной выручки. Аппараты берутся из настроек специализации.";
const SPECIALIZATION_PRIMARY_NOTE = "Из отчёта «Пациенты по врачам». В итоге пациент учитывается один раз по ФИО.";

function specializationActivityView(month, profile, filter, subFilter = "all", ids = null) {
  const names = specializationDeviceNames(profile);
  const months = calendarYearMonthKeys(month);
  const history = months.map(key => specializationActivityMonth(key, filter, subFilter, ids, names));
  const current = history.at(-1);
  const labels = months.map(monthLabel);
  const deviceSeries = names.map((name, index) => ({
    label: name, color: deviceColor(profile, name),
    values: history.map(entry => entry?.devices?.items[index].s ?? null),
    pointNotes: history.map(entry => entry?.devices ? `${fmtNum(entry.devices.items[index].q)} шт.` : ""),
  }));
  const deviceCharts = [];
  for (let i = 0; i < deviceSeries.length && deviceCharts.length < 12; i += 30) {
    const chart = mobilePublicationChart(`specialization-devices-${i}`, "Выручка по аппаратам", "line", labels, deviceSeries.slice(i, i + 30), "₽");
    if (chart) deviceCharts.push(chart);
  }
  const primaryChart = mobilePublicationChart("specialization-primary", "Первичные пациенты по месяцам", "line", labels, [
    { label: "Первичные пациенты", color: "#2563eb", values: history.map(entry => entry?.primary.total ?? null) },
  ], "чел.");
  return { names, months, history, current, deviceCharts, primaryChart };
}

function specializationDeviceCards({ current, names }) {
  const devices = current?.devices;
  return devices ? names.map((name, index) => ({ name, ...devices.items[index],
    doctors: current.ids.filter(id => devices.byDoctor[id]).map(id => ({ name: doctorName(id), ...devices.byDoctor[id][index] })),
  })) : [];
}

function cloudSpecializationActivitySections(activity) {
  const { current, deviceCharts, primaryChart } = activity;
  if (!current) return { deviceSections: [], primarySections: [] };
  const { primary, ids } = current;
  const cards = specializationDeviceCards(activity);
  const deviceSections = cards.length ? [{
    title: "Аппараты за месяц",
    columns: ["Аппарат", "Процедуры, шт.", "Выручка"],
    rows: cards.map(({ name, q, s }) => [name, fmtNum(q), fmtMoney(s)]),
  }] : [];
  const doctorRows = cards.flatMap(card => card.doctors.map(({ name, q, s }) => [name, card.name, fmtNum(q), fmtMoney(s)]));
  for (let i = 0; i < doctorRows.length; i += 500) {
    deviceSections.push({ title: "Аппаратные методики по врачам", columns: ["Врач", "Аппарат", "Процедуры, шт.", "Выручка"], rows: doctorRows.slice(i, i + 500) });
  }
  if (deviceCharts.length) deviceSections.push({ title: SPECIALIZATION_DEVICE_TITLE, charts: deviceCharts });
  const sourceGroups = globalThis.klinvektReportPresentation.primarySourceGroups;
  const primarySections = [{
    title: "Первичные пациенты", note: SPECIALIZATION_PRIMARY_NOTE,
    columns: ["Врач", "Первичных за месяц"],
    rows: [...ids.map(id => [doctorName(id), fmtNum(primary.byDoctor[id])]), ["Итого по специализации", fmtNum(primary.total)]],
    metrics: [mobilePublicationMetric("Врачи с данными", `${primary.covered} из ${ids.length}`)],
    charts: [...(primaryChart ? [primaryChart] : []), {
      id: "specialization-primary-sources", title: "Источники первичных пациентов", type: "donut", unit: "чел.",
      labels: sourceGroups.map(group => group.label),
      series: [{ label: "Первичные пациенты", values: primary.sourceCounts, colors: sourceGroups.map(group => group.color) }],
    }],
  }];
  return { deviceSections, primarySections };
}

function cloudGroupReport(item, monthKey, comments, doctors) {
  const ids = doctors.filter(doctor => item.kind === "clinic" || (item.kind === "department" ? doctor.department === item.department : doctor.specialization === item.specialization)).map(doctor => doctor.doctorId);
  const getResult = key => aggregateDeptMonth(key, "all", "all", ids);
  const result = getResult(monthKey);
  if (!result) throw new Error("Нет показателей сводного отчёта");
  const profile = item.kind === "specialization" ? deptProfile(item.specialization) : departmentProfile(item.department);
  const specialization = item.kind === "specialization";
  const activity = specialization ? cloudSpecializationActivitySections(specializationActivityView(monthKey, profile, "all", "all", ids))
    : { deviceSections: [], primarySections: [] };
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
  const groups = ["active", "loyalSleep", "newRisk", "lost"];
  const missing = Object.entries(result.coverage).filter(([, value]) => !value.complete).map(([key, value]) => `${key}: данные ${value.coveredDoctors} из ${value.expectedDoctors} врачей`);
  const monthlyTrafficRow = (label, { traffic }) => [label, fmtNum(traffic.visits), fmtNum(traffic.patients), fmtNum(traffic.freq, 2)];
  const vectorSections = [
    [section("Экономика", [metric("Собственная выручка", result.econ.sales, fmtMoney), metric("С перенаправлениями", result.econ.revenueWithRef, fmtMoney),
      metric("На пациента", result.econ.avgClient, fmtMoney), metric("На посещение", result.econ.avgVisit, fmtMoney)]),
      ...(item.kind === "specialization" ? [section("Профайлы специалистов · визиты за месяц", [], {
        columns: ["Врач", "Визиты за месяц", "Пациенты за месяц", "Визитов на пациента"],
        rows: [monthlyTrafficRow("Итог специализации", result), ...records.map(row => monthlyTrafficRow(doctorName(row.id), row.result))],
      })] : [])],
    [section("Экспертный профиль", [metric("Использовано позиций", result.product?.devicesUsed), metric("Доля экспертных услуг", result.product?.expertShare, fmtPct)], {
      columns: ["Категория", "Количество", "Выручка"], rows: [...revenueGroups].map(([name, group]) => [name, fmtNum(group.q), fmtMoney(group.s)]),
      charts: [mobilePublicationPie("revenue", "Структура выручки", [...revenueGroups].map(([name, group], index) => [name, group.s, ["#2563eb", "#7c3aed", "#16a34a", "#d97706"][index % 4]]), "₽")].filter(Boolean),
    }), ...activity.deviceSections],
    [section("Направления", [metric("Выручка от направлений", result.econ.refRevenue, fmtMoney), metric("Доля направлений", result.cross.crossShare, fmtPct)]),
      ...[1, 3].map(window => section(`Назначения · ${window} мес.`, [metric("Назначено", result.cross.naz[window]?.totals.assigned),
        metric("Выполнено + продано", result.cross.naz[window]?.totals.resultQ), metric("Конверсия", result.cross.naz[window]?.totals.conv, fmtPct)]))],
    [section("Клиентская база", [metric("Общая база", base?.total), metric("Активная база", base?.activeBasePct, fmtPct), metric("Потерянные", base?.lostPct, fmtPct)], {
      note: "Четыре непересекающиеся группы. При неполном покрытии доли не рассчитываются.",
      columns: ["Группа", "Пациенты"], rows: groups.map(group => [clientBaseGroupLabel(group), fmtNum(base?.seg[group])]),
    })],
    [section("Лояльность", [metric("Расписание", result.loyalty.sched?.pct, fmtPct), metric("Собственная запись", result.loyalty.ownRec?.pct, fmtPct),
      metric("Курсовое лечение", result.loyalty.courseIdx, fmtPct), metric("Частота за 12 мес.", result.loyalty.freq12, value => fmtNum(value, 2))], {
      columns: ["Первичка", "Первичных", "Вернулось", "Возвращаемость"], rows: [3, 6, 12].map(window => [`${window} мес.`, fmtNum(result.loyalty.pvSlices[window]?.first), fmtNum(result.loyalty.pvSlices[window]?.ret), fmtPct(result.loyalty.pvSlices[window]?.pct)]),
    }), ...activity.primarySections],
    [section("Репутация", [metric("Средний рейтинг", result.rep.avgRating, value => fmtNum(value, 2)), metric("NPS", result.rep.nps, fmtPct),
      metric("Новые отзывы", result.rep.reviews), metric("Всего отзывов", result.rep.totalReviews)], {
      columns: ["Врач", "Балл", "Полнота", "Отзывы"], rows: [...records].sort((a, b) => (b.result.rep?.totalReviews ?? -1) - (a.result.rep?.totalReviews ?? -1)
        || doctorName(a.id).localeCompare(doctorName(b.id), "ru") || String(a.id).localeCompare(String(b.id)))
        .map(({ id, result: row }) => [doctorName(id), fmtNum(row.scores?.total, 1) + (row.scores?.preliminary ? " · предв." : ""), fmtPct(row.scores?.coveragePct), fmtNum(row.rep?.totalReviews)]),
    })],
  ];
  const vectors = ["v1", "v2", "v3", "v4", "v5", "v6"].map((id, index) => ({ id, number: index + 1, title: VECTOR_META[id].name,
    score: Number.isFinite(result.vecAvg[id]) ? Math.round(result.vecAvg[id]) : null, delta: null, coverage: null, preliminary: false,
    detail: "Сводные показатели включённых врачей. Несопоставимые значения остаются незаданными.", sections: vectorSections[index] }));
  vectors[3].methodologyId = "report-partition-v1";
  vectors[3].sections = [clientBaseDefinitionsForDoctors(records.map(({ id }) => id))];
  if (specialization) {
    const history = specializationClientBaseHistory(monthKey, "all", "all", ids);
    const chart = mobilePublicationChart("specialization-base-history", SPECIALIZATION_BASE_TITLE, "line", history.months.map(monthLabel), history.series, "чел.");
    vectors[3].sections.push({ title: "Динамика клиентской базы", charts: chart ? [chart] : [],
      note: chart ? "" : "Неполные данные: нет сопоставимых выгрузок «Давность посещений» за 36 месяцев." });
  }
  vectors[3].windows = [36, 6, 12, 24].map(window => {
    const bases = records.map(({id}) => ({ id, base: reportClientBaseSummary(id, monthKey, window), previous: reportClientBaseSummary(id, prevMonthKey(monthKey), window) }));
    const visible = groups.filter(group => bases.some(row => row.base?.groupAvailable[group]));
    return { id: String(window), label: `${window} мес.`, period: `Точное окно ${window} месяцев`, sections: [{ title: "Клиентская база · сравнение врачей",
      note: "Те же четыре группы, что в личном В4 и на графике динамики. Каждый пациент входит ровно в одну группу.",
      columns: ["Врач", "Период", "Общая база", "Изменение базы", ...visible.map(clientBaseGroupLabel)],
      rows: bases.map(({id, base, previous}) => [doctorName(id), `${window} мес.`, fmtNum(base?.total), mobilePublicationPercentChange(base && previous?.total ? (base.total - previous.total) / previous.total * 100 : null),
        ...visible.map(group => base?.groupAvailable[group] ? `${fmtNum(base.seg[group])} · ${fmtPct(clientBaseGroupPct(base, group))}` : "—")]),
    }] };
  });
  const overall = Number.isFinite(result.scores.total) ? Math.round(result.scores.total) : null;
  const previous = getResult(prevMonthKey(monthKey))?.scores?.total;
  const report = { id: monthKey, label: monthLabel(monthKey), shortLabel: monthLabel(monthKey).split(/\s+/)[0], overall, coverage: null, preliminary: false, missing,
    overallDelta: overall != null && Number.isFinite(previous) ? overall - Math.round(previous) : null,
    assessment: overall == null ? "Нет полной оценки" : "Средний балл врачей с полной оценкой", summary: `${result.doctors} врачей. Предварительные оценки исключены из среднего балла.`,
    headlineMetrics: [metric("Пациентов за месяц", result.traffic.patients), metric("Загрузка расписания", result.loyalty.sched?.pct, fmtPct),
      metric("Визитов на пациента", result.traffic.freq, value => fmtNum(value, 2)), metric("Частота за 12 мес.", result.loyalty.freq12, value => fmtNum(value, 2)), metric("Активная база", base?.activeBasePct, fmtPct)],
    vectors, goals: [], comments: scopeComments,
    dynamics: cloudReportDynamics(monthKey, getResult, profile,
      `${item.kind === "specialization" ? "dept" : item.context.scopeType}|${monthKey}|${item.context.scopeId}|all`,
      { includeScoreChart: item.kind !== "specialization" }),
  };
  if (item.kind !== "clinic") report.goals = departmentMetricDefs().map(def => {
    const goal = departmentGoalInfo(def, result, profile);
    return goal ? { title: def.label, description: goal.text, progress: 0, state: goal.state.endsWith("good") ? "good" : "warn" } : null;
  }).filter(Boolean);
  report.numbers = cloudReportNumbers(result, report);
  return report;
}
