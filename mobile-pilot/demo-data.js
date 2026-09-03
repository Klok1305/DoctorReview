/* Synthetic demo data only. Never replace this file with a clinic export. */
(() => {
  "use strict";

  const formatInt = (value) => String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const formatPct = (value) => `${Number(value).toFixed(value % 1 ? 1 : 0)}%`;
  const countByShare = (total, share) => formatInt(total * share / 100);

  const vectorMeta = [
    ["v1", 1, "Экономическая результативность"],
    ["v2", 2, "Экспертность и продукт"],
    ["v3", 3, "Междисциплинарный подход"],
    ["v4", 4, "Работа с клиентской базой"],
    ["v5", 5, "Лояльность и удержание"],
    ["v6", 6, "Репутация и NPS"],
  ];

  function clientBaseWindows(config) {
    const shapes = [
      { id: "12", label: "12 мес.", total: config.total, visits: config.visits, shares: [46, config.activeShare, 12, 10, 11] },
      { id: "24", label: "24 мес.", total: Math.round(config.total * 1.39), visits: Math.round(config.visits * 1.78), shares: [51, config.activeShare - 4, 10, 14, 13] },
      { id: "36", label: "3 года", total: Math.round(config.total * 1.7), visits: Math.round(config.visits * 2.55), shares: [55, config.activeShare - 8, 8, 16, 16] },
    ];
    const labels = ["Лояльные", "Активные", "Новые, риск", "Лояльные, спящие", "Потерянные"];
    const rules = [
      "≥3 визитов; последний визит ≤12 мес. назад",
      "≥3 визитов за последние 6 мес.",
      "1–2 визита; последний визит >6 мес. назад",
      "≥3 визитов; последний визит >6 мес. назад",
      "1–2 визита; последний визит >12 мес. назад",
    ];

    return shapes.map((window) => ({
      id: window.id,
      label: window.label,
      period: `${config.periods[window.id]} · точное окно ${window.label}`,
      sections: [
        {
          title: "Объём базы",
          note: "Агрегаты без фамилий и персонального списка. Группы могут пересекаться.",
          metrics: [
            { label: "Общая база", value: `${formatInt(window.total)} чел.`, note: "уникальные пациенты", state: "neutral" },
            { label: "Визиты", value: formatInt(window.visits), note: "за окно анализа", state: "neutral" },
            { label: "Активная база", value: formatPct(window.shares[1]), note: `${countByShare(window.total, window.shares[1])} чел.`, target: "ключевой показатель", state: "good" },
            { label: "Потерянные", value: formatPct(window.shares[4]), note: `${countByShare(window.total, window.shares[4])} чел.`, target: "чем ниже, тем лучше", state: "warn" },
          ],
        },
        {
          title: "Группы клиентской базы",
          note: "Процент каждой группы считается от общей базы выбранного окна.",
          columns: ["Группа", "Пациенты", "Доля", "Условие"],
          rows: labels.map((label, index) => [label, `${countByShare(window.total, window.shares[index])} чел.`, formatPct(window.shares[index]), rules[index]]),
        },
      ],
    }));
  }

  function makePeriod(config) {
    const h = config.headline;
    const e = config.economics;
    const p = config.product;
    const c = config.cross;
    const l = config.loyalty;
    const r = config.reputation;
    const base = vectorMeta.map(([id, number, title]) => ({
      id,
      number,
      title,
      score: config.scores[id],
      delta: config.deltas[id],
      detail: config.details[id],
    }));

    base[0].sections = [
      {
        title: "Выручка",
        metrics: [
          { label: "Собственная выручка", value: e.sales, state: "good" },
          { label: "Участие ассистентом", value: e.assistant, note: "не входит в собственную выручку", state: "neutral" },
          { label: "Выручка от перенаправлений", value: e.referralRevenue, state: "neutral" },
          { label: "Выручка с перенаправлениями", value: e.withReferrals, state: "good" },
        ],
      },
      {
        title: "Средний чек",
        metrics: [
          { label: "На пациента", value: e.avgPatient, note: "выручка / пациенты", state: "good" },
          { label: "На посещение", value: e.avgVisit, note: "выручка / визиты", state: "neutral" },
          { label: "С перенаправлениями", value: e.avgPatientReferral, note: "на пациента", state: "neutral" },
        ],
      },
      {
        title: "Динамика среднего чека",
        columns: ["Сравнение", "База", "Изменение"],
        rows: e.dynamics,
      },
    ];

    base[1].sections = [
      {
        title: "Экспертный профиль",
        metrics: [
          { label: "Использовано позиций", value: `${p.used} из ${p.park}`, note: p.title, target: p.goal, state: p.used >= p.park - 1 ? "good" : "warn" },
          { label: "Итого услуг", value: p.totalQty, note: "по собственной выработке", state: "neutral" },
          { label: "Итого выручка", value: p.totalRevenue, note: "100% структуры", state: "good" },
          { label: "Не задействовано", value: p.unused, note: "из настроенного парка", state: p.unused === "нет" ? "good" : "warn" },
        ],
      },
      {
        title: "Распределение выручки",
        columns: ["Категория", "Кол-во", "Сумма", "Доля"],
        rows: p.categories,
      },
      {
        title: `${p.title}: позиции`,
        columns: ["Позиция", "Штук", "Выручка"],
        rows: p.positions,
      },
    ];

    base[2].sections = [
      {
        title: `Конверсия назначений · ${c.window}`,
        metrics: [
          { label: "Назначено", value: c.assigned, state: "neutral" },
          { label: "Выполнено", value: c.done, state: "neutral" },
          { label: "Продано", value: c.sold, state: "neutral" },
          { label: "Результат", value: c.result, note: "выполнено + продано", state: "good" },
          { label: "Конверсия", value: c.conversion, target: c.conversionGoal, state: c.conversionState },
        ],
      },
      {
        title: "Детали назначений",
        columns: ["Группа", "Назначено", "Выполнено", "Продано", "Конверсия"],
        rows: c.appointments,
      },
      {
        title: "Фокусы междисциплинарного подхода",
        columns: ["Фокус", "Назначено", "Выполнено + продано"],
        rows: c.focuses,
      },
      {
        title: "Выполненные направления",
        note: c.sourceNote,
        metrics: [
          { label: "Выполнено по выработке", value: c.referralWork, state: "neutral" },
          { label: "Учтено в перенаправлениях", value: c.referralCredited, state: "good" },
          { label: "Выручка с перенаправлениями", value: e.withReferrals, state: "good" },
          { label: "Доля выручки", value: c.revenueShare, target: c.revenueGoal, state: c.revenueState },
        ],
        columns: ["Тип", "Штук", "Выполнено", "Учтено"],
        rows: c.referrals,
      },
    ];

    base[3].windows = clientBaseWindows(config.clientBase);

    base[4].sections = [
      {
        title: "Лояльность и удержание",
        metrics: [
          { label: "Загрузка расписания", value: l.schedule, note: l.scheduleNote, target: l.scheduleGoal, state: "good" },
          { label: "Собственная запись в 1С", value: l.ownRecords, note: l.ownRecordsNote, target: l.ownRecordsGoal, state: l.ownRecordsState },
          { label: l.courseTitle, value: l.course, note: l.courseNote, target: l.courseGoal, state: l.courseState },
          { label: "Индекс возвращаемости за 12 мес.", value: l.frequency, note: "визитов на пациента", state: "neutral" },
          { label: l.primaryTitle, value: l.primaryReturn, note: l.primaryNote, target: l.primaryGoal, state: l.primaryState },
        ],
      },
    ];

    base[5].sections = [
      {
        title: "Репутация",
        metrics: [
          { label: "Средний рейтинг площадок", value: `${r.average} ★`, note: "среднее по заполненным площадкам", target: r.ratingGoal, state: "good" },
          { label: "NPS", value: r.nps, note: "индекс готовности рекомендовать", target: r.npsGoal, state: "good" },
          { label: "Новые отзывы", value: r.reviews, note: "за выбранный месяц", target: r.reviewsGoal, state: r.reviewsState },
        ],
      },
      {
        title: "Рейтинги по площадкам",
        columns: ["Площадка", "Рейтинг"],
        rows: r.platforms,
      },
    ];

    return {
      id: config.id,
      label: config.label,
      shortLabel: config.shortLabel,
      overall: config.overall,
      overallDelta: config.overallDelta,
      assessment: config.assessment,
      summary: config.summary,
      updatedAt: config.updatedAt,
      comment: config.comment,
      headlineMetrics: [
        { label: "Пациентов за месяц", value: h.patients, note: "уникальные пациенты", delta: h.patientDelta },
        { label: "Загрузка расписания", value: h.schedule, note: h.scheduleNote, delta: h.scheduleDelta },
        { label: "Визитов на пациента за месяц", value: h.monthFrequency, note: h.monthFrequencyNote, delta: h.monthFrequencyDelta },
        { label: "Визитов на пациента за 12 мес.", value: h.yearFrequency, note: "визиты / уникальные пациенты", delta: h.yearFrequencyDelta },
        { label: "Активная клиентская база", value: h.activeBase, note: h.activeBaseNote, delta: h.activeBaseDelta },
      ],
      vectors: base,
      goals: config.goals,
    };
  }

  const commonDetails = {
    v1: "Выручка, средние чеки и сравнение с предыдущими периодами.",
    v2: "Структура выручки и использование экспертных позиций.",
    v3: "Назначения, междисциплинарные фокусы и выполненные направления.",
    v4: "Сегменты клиентской базы в точных окнах 12, 24 и 36 месяцев — без списка пациентов.",
    v5: "Расписание, собственная запись, курсовое лечение и возвращаемость.",
    v6: "Средний рейтинг, NPS, новые отзывы и площадки.",
  };

  const periods = [
    makePeriod({
      id: "2026-07", label: "Июль 2026", shortLabel: "Июль", overall: 86, overallDelta: 3,
      assessment: "Уверенная динамика", summary: "Четыре вектора выросли, один стабилен, один требует внимания.",
      updatedAt: "15 августа 2026", comment: "Сохраняйте темп по клиентской базе. На следующий период сфокусируйтесь на междисциплинарных назначениях.",
      scores: { v1: 88, v2: 82, v3: 74, v4: 91, v5: 84, v6: 96 },
      deltas: { v1: 4, v2: 2, v3: -1, v4: 5, v5: 3, v6: 1 }, details: commonDetails,
      headline: { patients: "128", patientDelta: "+6", schedule: "91%", scheduleNote: "164 из 180 ч по графику", scheduleDelta: "+3 п.п.", monthFrequency: "1,48", monthFrequencyNote: "189 визитов / 128 пациентов", monthFrequencyDelta: "+0,06", yearFrequency: "3,16", yearFrequencyDelta: "+0,12", activeBase: "68%", activeBaseNote: "512 из 753 · окно 12 мес.", activeBaseDelta: "+4 п.п." },
      economics: { sales: "4 820 000 ₽", assistant: "146 000 ₽", referralRevenue: "590 000 ₽", withReferrals: "5 410 000 ₽", avgPatient: "37 656 ₽", avgVisit: "25 503 ₽", avgPatientReferral: "42 266 ₽", dynamics: [["К прошлому месяцу", "35 460 ₽", "+6,2%"], ["К среднему за квартал", "34 510 ₽", "+9,1%"], ["К среднему прошлого года", "33 500 ₽", "+12,4%"]] },
      product: { title: "Экспертные услуги", used: 4, park: 5, goal: "цель ≥4 позиций", totalQty: "264", totalRevenue: "4 820 000 ₽", unused: "1 позиция", categories: [["Консультации", "58", "1 100 000 ₽", "22,8%"], ["Диагностика", "73", "1 420 000 ₽", "29,5%"], ["Процедуры", "133", "2 300 000 ₽", "47,7%"]], positions: [["Комплексная диагностика", "42", "920 000 ₽"], ["Экспертная консультация", "36", "810 000 ₽"], ["Лечебная программа", "31", "760 000 ₽"], ["Контрольное исследование", "24", "510 000 ₽"], ["Расширенная программа · не задействована", "0", "0 ₽"]] },
      cross: { window: "6 мес.", assigned: "86", done: "49", sold: "15", result: "64", conversion: "74,4%", conversionGoal: "цель ≥75%", conversionState: "warn", appointments: [["Диагностика", "31", "19", "6", "80,6%"], ["Смежные специалисты", "28", "15", "5", "71,4%"], ["Лечебные программы", "27", "15", "4", "70,4%"]], focuses: [["Диагностика", "31", "25"], ["Кардиология", "22", "16"], ["Реабилитация", "18", "13"], ["Профилактика", "15", "10"]], sourceNote: "Назначения: 612 000 ₽; выработка: 620 000 ₽. Разница двух исходных отчётов показана отдельно.", referralWork: "620 000 ₽", referralCredited: "590 000 ₽", revenueShare: "10,9%", revenueGoal: "цель ≥10%", revenueState: "good", referrals: [["Диагностика", "19", "270 000 ₽", "270 000 ₽"], ["Смежные специалисты", "14", "220 000 ₽", "205 000 ₽"], ["Лечебные программы", "8", "130 000 ₽", "115 000 ₽"]] },
      clientBase: { total: 753, visits: 2379, activeShare: 68, periods: { "12": "01.08.2025–31.07.2026", "24": "01.08.2024–31.07.2026", "36": "01.08.2023–31.07.2026" } },
      loyalty: { schedule: "91%", scheduleNote: "164 из 180 ч по графику", scheduleGoal: "цель ≥85%", ownRecords: "70,4%", ownRecordsNote: "133 собственных записей / 189 визитов", ownRecordsGoal: "цель ≥70%", ownRecordsState: "good", courseTitle: "Курсовое лечение: ≥3 виз. за 6 мес.", course: "47,7%", courseNote: "61 чел. · точное окно 6 мес.", courseGoal: "цель ≥45%", courseState: "good", frequency: "3,16", primaryTitle: "Возвращаемость первички · 6 мес.", primaryReturn: "73,1%", primaryNote: "первичных 52 · вернулось 38 · не вернулось 14", primaryGoal: "цель ≥70%", primaryState: "good" },
      reputation: { average: "4,85", nps: "+76%", reviews: "18 шт.", ratingGoal: "цель ≥4,7 ★", npsGoal: "цель ≥70%", reviewsGoal: "цель ≥15 шт.", reviewsState: "good", platforms: [["ПроДокторов", "4,9 ★"], ["НаПоправку", "4,8 ★"], ["DocTu", "4,7 ★"], ["СберЗдоровье", "5,0 ★"]] },
      goals: [{ title: "Междисциплинарные назначения", description: "Достичь целевой конверсии 75%", progress: 74 }, { title: "Повторные визиты", description: "Сохранить долю активной клиентской базы", progress: 91 }, { title: "Экспертный профиль", description: "Задействовать пятую целевую позицию", progress: 82 }],
    }),
    makePeriod({
      id: "2026-06", label: "Июнь 2026", shortLabel: "Июнь", overall: 83, overallDelta: 2,
      assessment: "Положительная динамика", summary: "Общий результат вырос благодаря клиентской базе и удержанию.",
      updatedAt: "15 июля 2026", comment: "Хорошая динамика по клиентской базе. Следующий шаг — закрепить экспертный профиль.",
      scores: { v1: 84, v2: 80, v3: 75, v4: 86, v5: 81, v6: 95 },
      deltas: { v1: 2, v2: 1, v3: 2, v4: 4, v5: 3, v6: 0 }, details: commonDetails,
      headline: { patients: "122", patientDelta: "+4", schedule: "88%", scheduleNote: "158 из 180 ч по графику", scheduleDelta: "+2 п.п.", monthFrequency: "1,42", monthFrequencyNote: "173 визита / 122 пациента", monthFrequencyDelta: "+0,04", yearFrequency: "3,04", yearFrequencyDelta: "+0,08", activeBase: "64%", activeBaseNote: "462 из 722 · окно 12 мес.", activeBaseDelta: "+3 п.п." },
      economics: { sales: "4 326 000 ₽", assistant: "128 000 ₽", referralRevenue: "502 000 ₽", withReferrals: "4 828 000 ₽", avgPatient: "35 459 ₽", avgVisit: "25 006 ₽", avgPatientReferral: "39 574 ₽", dynamics: [["К прошлому месяцу", "34 210 ₽", "+3,7%"], ["К среднему за квартал", "33 840 ₽", "+4,8%"], ["К среднему прошлого года", "32 900 ₽", "+7,8%"]] },
      product: { title: "Экспертные услуги", used: 4, park: 5, goal: "цель ≥4 позиций", totalQty: "247", totalRevenue: "4 326 000 ₽", unused: "1 позиция", categories: [["Консультации", "56", "1 040 000 ₽", "24,0%"], ["Диагностика", "67", "1 246 000 ₽", "28,8%"], ["Процедуры", "124", "2 040 000 ₽", "47,2%"]], positions: [["Комплексная диагностика", "39", "840 000 ₽"], ["Экспертная консультация", "34", "750 000 ₽"], ["Лечебная программа", "28", "680 000 ₽"], ["Контрольное исследование", "21", "450 000 ₽"], ["Расширенная программа · не задействована", "0", "0 ₽"]] },
      cross: { window: "6 мес.", assigned: "81", done: "47", sold: "14", result: "61", conversion: "75,3%", conversionGoal: "цель ≥75%", conversionState: "good", appointments: [["Диагностика", "29", "18", "6", "82,8%"], ["Смежные специалисты", "27", "15", "4", "70,4%"], ["Лечебные программы", "25", "14", "4", "72,0%"]], focuses: [["Диагностика", "29", "24"], ["Кардиология", "21", "16"], ["Реабилитация", "17", "12"], ["Профилактика", "14", "9"]], sourceNote: "Назначения: 514 000 ₽; выработка: 526 000 ₽. Разница двух исходных отчётов показана отдельно.", referralWork: "526 000 ₽", referralCredited: "502 000 ₽", revenueShare: "10,4%", revenueGoal: "цель ≥10%", revenueState: "good", referrals: [["Диагностика", "17", "228 000 ₽", "228 000 ₽"], ["Смежные специалисты", "12", "184 000 ₽", "172 000 ₽"], ["Лечебные программы", "7", "114 000 ₽", "102 000 ₽"]] },
      clientBase: { total: 722, visits: 2198, activeShare: 64, periods: { "12": "01.07.2025–30.06.2026", "24": "01.07.2024–30.06.2026", "36": "01.07.2023–30.06.2026" } },
      loyalty: { schedule: "88%", scheduleNote: "158 из 180 ч по графику", scheduleGoal: "цель ≥85%", ownRecords: "68,2%", ownRecordsNote: "118 собственных записей / 173 визита", ownRecordsGoal: "цель ≥70%", ownRecordsState: "warn", courseTitle: "Курсовое лечение: ≥3 виз. за 6 мес.", course: "44,8%", courseNote: "55 чел. · точное окно 6 мес.", courseGoal: "цель ≥45%", courseState: "warn", frequency: "3,04", primaryTitle: "Возвращаемость первички · 6 мес.", primaryReturn: "70,6%", primaryNote: "первичных 51 · вернулось 36 · не вернулось 15", primaryGoal: "цель ≥70%", primaryState: "good" },
      reputation: { average: "4,78", nps: "+74%", reviews: "16 шт.", ratingGoal: "цель ≥4,7 ★", npsGoal: "цель ≥70%", reviewsGoal: "цель ≥15 шт.", reviewsState: "good", platforms: [["ПроДокторов", "4,8 ★"], ["НаПоправку", "4,7 ★"], ["DocTu", "4,7 ★"], ["СберЗдоровье", "4,9 ★"]] },
      goals: [{ title: "Экспертный профиль", description: "Задействовать пятую целевую позицию", progress: 80 }, { title: "Клиентская база", description: "Продолжить работу с возвратом клиентов", progress: 86 }],
    }),
    makePeriod({
      id: "2026-05", label: "Май 2026", shortLabel: "Май", overall: 81, overallDelta: 1,
      assessment: "Стабильный результат", summary: "Основные показатели находятся в рабочем диапазоне.",
      updatedAt: "15 июня 2026", comment: "Базовый уровень устойчивый. Рекомендуется усилить работу с возвратом клиентов.",
      scores: { v1: 82, v2: 79, v3: 73, v4: 82, v5: 78, v6: 95 },
      deltas: { v1: 1, v2: 1, v3: 0, v4: 2, v5: 1, v6: 2 }, details: commonDetails,
      headline: { patients: "118", patientDelta: "+2", schedule: "86%", scheduleNote: "155 из 180 ч по графику", scheduleDelta: "+1 п.п.", monthFrequency: "1,38", monthFrequencyNote: "163 визита / 118 пациентов", monthFrequencyDelta: "+0,02", yearFrequency: "2,96", yearFrequencyDelta: "+0,04", activeBase: "61%", activeBaseNote: "427 из 700 · окно 12 мес.", activeBaseDelta: "+2 п.п." },
      economics: { sales: "4 037 000 ₽", assistant: "119 000 ₽", referralRevenue: "448 000 ₽", withReferrals: "4 485 000 ₽", avgPatient: "34 212 ₽", avgVisit: "24 767 ₽", avgPatientReferral: "38 008 ₽", dynamics: [["К прошлому месяцу", "33 780 ₽", "+1,3%"], ["К среднему за квартал", "33 210 ₽", "+3,0%"], ["К среднему прошлого года", "32 500 ₽", "+5,3%"]] },
      product: { title: "Экспертные услуги", used: 3, park: 5, goal: "цель ≥4 позиций", totalQty: "231", totalRevenue: "4 037 000 ₽", unused: "2 позиции", categories: [["Консультации", "53", "990 000 ₽", "24,5%"], ["Диагностика", "63", "1 157 000 ₽", "28,7%"], ["Процедуры", "115", "1 890 000 ₽", "46,8%"]], positions: [["Комплексная диагностика", "37", "790 000 ₽"], ["Экспертная консультация", "32", "690 000 ₽"], ["Лечебная программа", "25", "610 000 ₽"], ["Контрольное исследование · не задействовано", "0", "0 ₽"], ["Расширенная программа · не задействована", "0", "0 ₽"]] },
      cross: { window: "6 мес.", assigned: "78", done: "43", sold: "14", result: "57", conversion: "73,1%", conversionGoal: "цель ≥75%", conversionState: "warn", appointments: [["Диагностика", "28", "17", "5", "78,6%"], ["Смежные специалисты", "26", "14", "5", "73,1%"], ["Лечебные программы", "24", "12", "4", "66,7%"]], focuses: [["Диагностика", "28", "22"], ["Кардиология", "20", "14"], ["Реабилитация", "16", "11"], ["Профилактика", "14", "10"]], sourceNote: "Назначения: 451 000 ₽; выработка: 470 000 ₽. Разница двух исходных отчётов показана отдельно.", referralWork: "470 000 ₽", referralCredited: "448 000 ₽", revenueShare: "10,0%", revenueGoal: "цель ≥10%", revenueState: "good", referrals: [["Диагностика", "16", "204 000 ₽", "204 000 ₽"], ["Смежные специалисты", "11", "166 000 ₽", "155 000 ₽"], ["Лечебные программы", "6", "100 000 ₽", "89 000 ₽"]] },
      clientBase: { total: 700, visits: 2065, activeShare: 61, periods: { "12": "01.06.2025–31.05.2026", "24": "01.06.2024–31.05.2026", "36": "01.06.2023–31.05.2026" } },
      loyalty: { schedule: "86%", scheduleNote: "155 из 180 ч по графику", scheduleGoal: "цель ≥85%", ownRecords: "65,6%", ownRecordsNote: "107 собственных записей / 163 визита", ownRecordsGoal: "цель ≥70%", ownRecordsState: "warn", courseTitle: "Курсовое лечение: ≥3 виз. за 6 мес.", course: "42,1%", courseNote: "50 чел. · точное окно 6 мес.", courseGoal: "цель ≥45%", courseState: "warn", frequency: "2,96", primaryTitle: "Возвращаемость первички · 6 мес.", primaryReturn: "67,3%", primaryNote: "первичных 49 · вернулось 33 · не вернулось 16", primaryGoal: "цель ≥70%", primaryState: "warn" },
      reputation: { average: "4,75", nps: "+72%", reviews: "14 шт.", ratingGoal: "цель ≥4,7 ★", npsGoal: "цель ≥70%", reviewsGoal: "цель ≥15 шт.", reviewsState: "warn", platforms: [["ПроДокторов", "4,8 ★"], ["НаПоправку", "4,7 ★"], ["DocTu", "4,6 ★"], ["СберЗдоровье", "4,9 ★"]] },
      goals: [{ title: "Клиентская база", description: "Увеличить долю активных пациентов", progress: 82 }, { title: "Междисциплинарный подход", description: "Достичь конверсии назначений 75%", progress: 73 }],
    }),
  ];

  periods.forEach((period, index) => {
    const chronological = periods.slice(index).reverse();
    period.goalsSource = "Индивидуальные цели врача";
    period.goals = period.goals.map((goal, goalIndex) => ({
      ...goal,
      key: `demo-goal-${goalIndex + 1}`,
      vector: `v${Math.min(6, goalIndex + 1)}`,
      target: goal.description,
      fact: `${goal.progress}%`,
      state: goal.progress >= 85 ? "good" : goal.progress >= 70 ? "warn" : "bad",
    }));
    period.comments = [{
      blockKey: "doctor.dynamics",
      title: "Динамика, точки роста и риска",
      text: period.comment,
      author: "Администратор",
      updatedAt: "",
    }];
    period.dynamics = {
      columns: chronological.map((item) => item.label),
      rows: [
        { key: "score", label: "Общий балл", values: chronological.map((item) => String(item.overall)), delta: period.overallDelta > 0 ? `+${period.overallDelta}%` : `${period.overallDelta}%`, averageDelta: "—", target: "≥ 80", state: period.overallDelta >= 0 ? "good" : "bad" },
        { key: "patients", label: "Пациенты", values: chronological.map((item) => item.headlineMetrics[0].value), delta: period.headlineMetrics[0].delta, averageDelta: "—", target: "", state: "good" },
        { key: "schedule", label: "Загрузка расписания", values: chronological.map((item) => item.headlineMetrics[1].value), delta: period.headlineMetrics[1].delta, averageDelta: "—", target: "≥ 85%", state: "good" },
        { key: "active-base", label: "Активная клиентская база", values: chronological.map((item) => item.headlineMetrics[4].value), delta: period.headlineMetrics[4].delta, averageDelta: "—", target: "≥ 65%", state: period.headlineMetrics[4].delta.startsWith("-") ? "bad" : "good" },
      ],
      growth: ["Улучшилась загрузка расписания", "Вырос объём активной клиентской базы"],
      risk: index === 0 ? ["Конверсия междисциплинарных назначений требует внимания"] : [],
      conclusion: period.comment,
      conclusionManual: true,
    };
    // UI fixtures only: production charts arrive as numeric aggregates from Admin.
    const number = value => Number(String(value).replace(/[^\d,.-]/g, "").replace(",", "."));
    const colors = ["#2563eb", "#7c3aed", "#16a34a", "#d97706", "#db2777", "#0891b2", "#64748b"];
    const pie = (id, title, rows, column, unit) => ({ id, title, type: "donut", unit,
      labels: rows.map(row => row[0]), series: [{ label: title, values: rows.map(row => number(row[column])), colors: rows.map((_, i) => colors[i % colors.length]) }] });
    const product = period.vectors[1].sections;
    product[1].tree = product[1].rows.map(row => ({ label: row[0], values: row.slice(1),
      children: [{ label: `Подгруппа: ${row[0]}`, values: row.slice(1) }] }));
    product[1].charts = [pie("revenue", "Долевое распределение выручки", product[1].rows, 2, "₽")];
    product[2].charts = [pie("expert-quantity", "Экспертные позиции: штуки", product[2].rows, 1, "шт."), pie("expert-revenue", "Экспертные позиции: выручка", product[2].rows, 2, "₽")];
    const cross = period.vectors[2].sections;
    cross[1].tree = cross[1].rows.map(row => ({ label: row[0], values: row.slice(1), children: [{ label: "Группа услуг", values: row.slice(1),
      children: [{ label: `Тестовая услуга — ${row[0]}`, values: row.slice(1) }] }] }));
    cross[2].charts = [pie("focus-assigned", "Назначено по фокусам", cross[2].rows, 1, "шт."), pie("focus-result", "Выполнено + продано по фокусам", cross[2].rows, 2, "шт.")];
    cross[3].charts = [pie("referrals", "Структура выполненных направлений", cross[3].rows, 2, "₽")];
    period.vectors[3].windows.forEach(window => {
      const section = window.sections[1];
      section.charts = [{ ...pie("segments", "Группы клиентской базы", [["Общая база", window.sections[0].metrics[0].value], ...section.rows], 1, "чел."), type: "bar" }];
    });
    const line = (id, title, definitions, unit) => ({ id, title, type: "line", unit, labels: chronological.map(item => item.shortLabel),
      series: definitions.map(([label, get], i) => ({ label, color: colors[i], values: chronological.map(get) })) });
    const own = item => number(item.vectors[0].sections[0].metrics[0].value);
    const ref = item => number(item.vectors[0].sections[0].metrics[2].value);
    period.dynamics.charts = [
      line("money", "Выручка по месяцам", [["Собственная выручка", own], ["С перенаправлениями", item => own(item) + ref(item)]], "₽"),
      line("traffic", "Пациенты по месяцам", [["Пациенты", item => number(item.headlineMetrics[0].value)]], "чел."),
      line("rates", "Загрузка и конверсии", [["Загрузка", item => number(item.headlineMetrics[1].value)], ["Конверсия назначений", item => number(item.vectors[2].sections[0].metrics[4].value)]], "%"),
      line("base", "Клиентская база по месяцам", [["Общая база", item => number(item.vectors[3].windows[0].sections[0].metrics[0].value)]], "чел."),
      line("scores", "Баллы по векторам", [["Общий балл", item => item.overall], ...vectorMeta.map(([id, n, title]) => [`В${n} ${title}`, item => item.vectors.find(v => v.id === id).score])], "баллов"),
      { id: "revenue-structure", title: "Структура выручки по месяцам", type: "mirror", unit: "₽", labels: chronological.map(item => item.shortLabel),
        series: [...product[1].rows.map((row, i) => ({ label: row[0], side: "own", color: colors[i], values: chronological.map(item => number(item.vectors[1].sections[1].rows[i][2])) })),
          { label: "Выручка от перенаправлений", side: "ref", color: "#334155", values: chronological.map(ref) }] },
    ];
  });

  window.KLINVEKT_MOBILE_DEMO = Object.freeze({
    demo: true,
    doctor: { name: "Тестовый врач", department: "Демонстрационное отделение" },
    periods,
  });
})();
