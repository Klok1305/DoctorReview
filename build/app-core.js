"use strict";
/* ============================================================
 * ЯДРО: состояние, хранилище, утилиты, сопоставление ФИО
 * ============================================================ */

const APP_VERSION = 3;
const LS_KEY = "dpi_app_db_v1"; // ключ не меняем — миграция по полю version
const DESKTOP_API = window.desktopAPI || null;
let DESKTOP_STATE = null;
let desktopPendingSnapshot = null;
let desktopPendingRevision = 0;
let desktopWrittenRevision = 0;
let desktopWriterPromise = null;

const MONTH_NAMES = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];

/* ============================================================
 * СХЕМА v3: у каждого отделения — свой ПРОФИЛЬ:
 *   нормативы сегментации · период первички · «экспертность»
 *   (аппараты ИЛИ услуги) · таксономия категорий · правила ·
 *   ручные переопределения номенклатуры · баллы и веса · подразделения.
 * Профиль наследует недостающие поля от «По умолчанию».
 * ============================================================ */

function defaultBenchmarks() {
  return {
    revenue: 3000000,   // ₽ продажи/мес (пусто = метрика не оценивается)
    avgCheck: 25000,    // ₽ средний чек на пациента
    schedLoad: 75,      // % занятость расписания
    pervichka: 40,      // % возвращаемость первички
    ownRecords: 10,     // % доля собственных записей
    courseIdx: 30,      // % курсовое лечение
    akbShare: 40,       // % активная база от всей базы
    riskShare: 25,      // % в зоне риска (МЕНЬШЕ = лучше)
    churn: 30,          // % потерянных от базы за 3 года (МЕНЬШЕ = лучше)
    hwShare: 35,        // % доля экспертной группы в выручке
    crossShare: 8,      // % доля выручки от перенаправлений
    nazConv: 30,        // % конверсия назначений
    rating: 4.8, nps: 70, reviews: 5,
  };
}
function defaultScoring() {
  return {
    weights: { v1: 15, v2: 25, v3: 25, v4: 10, v5: 20, v6: 5 },
    enabled: { v1: true, v2: true, v3: true, v4: true, v5: true, v6: false },
    benchmarks: defaultBenchmarks(),
  };
}

/* Базовый (наследуемый) профиль отделения */
function defaultProfile() {
  return {
    // нормативы сегментации базы и курсового
    minVisits: 3, activeM: 6, riskM: 12, courseX: 4, courseM: 6, corePct: 80,
    pervichkaM: 3, // период возвращаемости первички для балла и динамики (мес)
    // «Экспертность» (Вектор 2): mode: devices | services | none
    expertise: {
      title: "Отслеживаемые услуги",
      mode: "services",
      group: "",            // группа таксономии, чья доля = «доля экспертных услуг» (пусто = сумма привязанных позиций)
      items: [],            // [{name, syn:[...], core:true}]
      rules: [],            // ручные привязки: [подстрока номенклатуры, имя позиции]
      hints: [],            // маркеры «похоже на экспертное, но не привязано»
    },
    // таксономия категорий выручки: группа -> подгруппы
    groups: {
      "Приемы": [],
      "Процедуры": [],
      "Анализы": [],
      "Товары": ["Аптека и процедурка", "Косметика", "БАДы"],
      "Другие услуги": ["Прочие"],
    },
    // правила: [подстрока, группа, подгруппа, вид("товар"|"услуга"|"")]
    rules: [
      ["анализ", "Анализы", "", ""],
      ["взятие крови", "Анализы", "", ""],
      ["исследован", "Анализы", "", ""],
      ["прием", "Приемы", "", ""],
      ["консультац", "Приемы", "", ""],
      ["аптека", "Товары", "Аптека и процедурка", ""],
      ["введение препарата", "Товары", "Аптека и процедурка", ""],
      ["капельн", "Товары", "Аптека и процедурка", ""],
      ["косметика", "Товары", "Косметика", ""],
      ["бад", "Товары", "БАДы", "товар"],
      ["пищевая", "Товары", "БАДы", "товар"],
      ["процедур", "Процедуры", "", "услуга"],
    ],
    // ручные переопределения номенклатуры (редактор в настройках):
    // ключ = точное имя позиции (lower) -> {type, group, sub, expertItem, showQty}
    overrides: {},
    scoring: defaultScoring(),
    subdivisions: [],   // подразделения внутри отделения (УЗИ, Маммологи…)
    matchers: [],       // подстроки специализаций 1С, по которым врач попадает в отделение
  };
}

/* --- Готовые профили отделений (из шаблонов заведующей). ---
   Это стартовые настройки: всё редактируется в приложении. */
function profileCosmetology() {
  const p = defaultProfile();
  p.matchers = ["косметолог", "аппаратная косметология", "эстетист", "дермат"];
  p.expertise = {
    title: "Аппараты", mode: "devices", group: "Аппараты",
    items: [
      { name: "Альтера", syn: ["альтера", "ulthera"], core: true },
      { name: "Ультраформер", syn: ["ультраформер", "ультрафо", "ultraformer"], core: true },
      { name: "Хармони", syn: ["хармони", "harmony"], core: true },
      { name: "BBL", syn: ["bbl", "ббл"], core: true },
      { name: "Эксилис", syn: ["эксилис", "exilis", "cool flame"], core: true },
      { name: "Кутера", syn: ["кутера", "cutera"], core: true },
      { name: "Дека", syn: ["дека тач", "deka"], core: true },
      { name: "Пиксель/Эрайзер", syn: ["пиксель", "эрайзер", "pixel", "eraser"], core: false },
      { name: "Джет пил", syn: ["джет пил", "jet peel", "джетпил"], core: false },
      { name: "НИЛИ", syn: ["нили"], core: false },
      { name: "Микротоки", syn: ["микроток"], core: false },
    ],
    rules: [],
    hints: ["аппаратная косметология", "лазерн", "лазер ", "фракционн", "радиоволнов", "ультразвуков", "фотоомоложение", "ipl", "смас", "rf-лифтинг", "элос"],
  };
  p.groups = {
    "Аппараты": [],
    "Инъекции": ["Ботулинотерапия", "Контурная/биоревит./мезо", "Мелсмон", "Лаеннек", "Прочие инъекции"],
    "Накожные применения": [],
    "Приемы": [],
    "Анализы": [],
    "Товары": ["Аптека и процедурка", "Косметика", "Мелсмон (товар)", "БАДы"],
    "Другие услуги": ["Маски и пилинги", "Удаление", "Эпиляция", "Тело", "Прочие"],
  };
  p.rules = cosmetologyRules();
  return p;
}
function profileGynecology() {
  const p = defaultProfile();
  p.matchers = ["гинеколог"];
  p.expertise = {
    title: "Аппараты", mode: "devices", group: "Аппараты",
    items: [
      { name: "Ultra Femme", syn: ["ultra femme", "ультра фемм", "ultrafemme"], core: true },
      { name: "Дека", syn: ["дека", "deka"], core: true },
      { name: "Magic", syn: ["magic", "маджик"], core: true },
      { name: "НИЛИ", syn: ["нили"], core: true },
    ],
    rules: [],
    hints: ["лазерн", "радиоволнов", "аппаратн"],
  };
  p.groups = {
    "Приемы": [],
    "Аппараты": [],
    "Инъекции": ["Мелсмон", "Лаеннек", "Прочие инъекции"],
    "УЗИ": [],
    "Гинекологические процедуры": ["Кольпоскопия", "Пайпель", "Прочие"],
    "Анализы": ["Генетические", "Обычные"],
    "Товары": ["Аптека и процедурка", "Косметика", "БАДы"],
    "Другие услуги": ["Прочие"],
  };
  p.rules = [
    ["узи", "УЗИ", "", ""],
    ["кольпоскоп", "Гинекологические процедуры", "Кольпоскопия", ""],
    ["пайпель", "Гинекологические процедуры", "Пайпель", ""],
    ["гинеколог", "Гинекологические процедуры", "Прочие", "услуга"],
    ["генетич", "Анализы", "Генетические", ""],
    ["анализ", "Анализы", "Обычные", ""],
    ["взятие крови", "Анализы", "Обычные", ""],
    ["мэлсмон", "Инъекции", "Мелсмон", "услуга"],
    ["мелсмон", "Инъекции", "Мелсмон", "услуга"],
    ["лаеннек", "Инъекции", "Лаеннек", ""],
    ["лаенек", "Инъекции", "Лаеннек", ""],
    ["инъекц", "Инъекции", "Прочие инъекции", ""],
    ["введение препарата", "Инъекции", "Прочие инъекции", "услуга"],
    ["прием", "Приемы", "", ""],
    ["консультац", "Приемы", "", ""],
    ["аптека", "Товары", "Аптека и процедурка", ""],
    ["косметика", "Товары", "Косметика", ""],
    ["бад", "Товары", "БАДы", "товар"],
  ];
  return p;
}
function profileSurgery() {
  const p = defaultProfile();
  p.matchers = ["хирург", "флеболог", "маммолог", "онкодермат", "дермотоонко"];
  p.expertise = {
    title: "Аппаратные процедуры", mode: "services", group: "Аппаратные процедуры",
    items: [
      { name: "Кутера", syn: ["кутера", "cutera"], core: true },
      { name: "Склеротерапия", syn: ["склеротерап"], core: true },
      { name: "ВАБ", syn: ["ваб", "вакуумная аспирац"], core: true },
    ],
    rules: [],
    hints: [],
  };
  p.groups = {
    "Приемы": [],
    "Аппаратные процедуры": [],
    "Дерматологические процедуры": ["Дермотоонкология", "Косметология"],
    "УЗИ": [],
    "Маммология процедуры": [],
    "Процедурный": [],
    "Анализы": [],
    "Товары": ["Аптека и процедурка", "Косметика", "БАДы"],
    "Другие услуги": ["Прочие"],
  };
  p.rules = [
    ["дермотоонко", "Дерматологические процедуры", "Дермотоонкология", ""],
    ["косметология процедуры", "Дерматологические процедуры", "Косметология", ""],
    ["узи", "УЗИ", "", ""],
    ["маммолог", "Маммология процедуры", "", "услуга"],
    ["мэлсмон", "Процедурный", "", "услуга"],
    ["мелсмон", "Процедурный", "", "услуга"],
    ["введение препарата", "Процедурный", "", "услуга"],
    ["процедурный кабинет", "Процедурный", "", ""],
    ["капельн", "Процедурный", "", "услуга"],
    ["анализ", "Анализы", "", ""],
    ["взятие крови", "Анализы", "", ""],
    ["прием", "Приемы", "", ""],
    ["консультац", "Приемы", "", ""],
    ["аптека", "Товары", "Аптека и процедурка", ""],
    ["косметика", "Товары", "Косметика", ""],
    ["бад", "Товары", "БАДы", "товар"],
  ];
  return p;
}
function profileTherapy() {
  const p = defaultProfile();
  p.matchers = ["терап", "эндокрин", "кардио", "невролог", "гастро", "психиат", "уролог"];
  p.expertise = {
    title: "Диагностика и процедуры", mode: "services", group: "",
    items: [
      { name: "УЗИ", syn: ["узи"], core: true },
      { name: "ЭхоКГ", syn: ["эхокг", "эхо-кг", "эхокардиограф"], core: true },
      { name: "Велоэргометрия", syn: ["велоэргометр"], core: true },
      { name: "Биоимпеданс", syn: ["биоимпеданс"], core: true },
      { name: "Ботулинотерапия", syn: ["ботулин", "диспорт", "ксеомин", "миотокс"], core: true },
      { name: "Бруксизм", syn: ["бруксизм"], core: true },
    ],
    rules: [],
    hints: [],
  };
  p.groups = {
    "Приемы": [],
    "Функциональная диагностика": ["УЗИ", "ЭхоКГ", "Велоэргометрия", "Прочая ФД"],
    "Неврологические процедуры": ["Ботулинотерапия", "Бруксизм", "Прочие"],
    "Гинекологические процедуры": [],
    "Анализы": [],
    "Товары": ["Аптека и процедурка", "Косметика", "БАДы"],
    "Другие услуги": ["Прочие"],
  };
  p.rules = [
    ["эхокг", "Функциональная диагностика", "ЭхоКГ", ""],
    ["велоэргометр", "Функциональная диагностика", "Велоэргометрия", ""],
    ["узи", "Функциональная диагностика", "УЗИ", ""],
    ["экг", "Функциональная диагностика", "Прочая ФД", ""],
    ["холтер", "Функциональная диагностика", "Прочая ФД", ""],
    ["спирометр", "Функциональная диагностика", "Прочая ФД", ""],
    ["биоимпеданс", "Функциональная диагностика", "Прочая ФД", ""],
    ["бруксизм", "Неврологические процедуры", "Бруксизм", ""],
    ["ботулин", "Неврологические процедуры", "Ботулинотерапия", ""],
    ["гинеколог", "Гинекологические процедуры", "", "услуга"],
    ["анализ", "Анализы", "", ""],
    ["взятие крови", "Анализы", "", ""],
    ["прием", "Приемы", "", ""],
    ["консультац", "Приемы", "", ""],
    ["аптека", "Товары", "Аптека и процедурка", ""],
    ["введение препарата", "Товары", "Аптека и процедурка", "услуга"],
    ["капельн", "Товары", "Аптека и процедурка", ""],
    ["косметика", "Товары", "Косметика", ""],
    ["бад", "Товары", "БАДы", "товар"],
  ];
  return p;
}
function profilePhysiotherapy() {
  const p = defaultProfile();
  p.matchers = ["физио", "массаж", "остеопат", "реабилит", "мануальн"];
  p.expertise = {
    title: "Аппараты", mode: "devices", group: "Аппараты",
    items: [
      { name: "Айкун", syn: ["айкун", "icoone"], core: true },
      { name: "Эксилис", syn: ["эксилис", "exilis", "cool flame"], core: true },
      { name: "Вангвиш", syn: ["вангвиш", "vanquish"], core: true },
      { name: "УВТ", syn: ["увт", "ударно-волнов"], core: true },
      { name: "Эмскальпт", syn: ["эмскальпт", "emsculpt"], core: true },
      { name: "НИЛИ", syn: ["нили"], core: true },
      { name: "Прессотерапия", syn: ["прессотерап"], core: true },
      { name: "Сопрано", syn: ["сопрано", "soprano"], core: true },
    ],
    rules: [],
    hints: ["аппаратн", "лазерн"],
  };
  p.groups = {
    "Приемы": [],
    "Аппараты": [],
    "Ручные процедуры": ["Массаж", "Юмейхо", "Кинезиотейпирование", "Остеопатия", "Уходовые", "Прочие"],
    "Накожные применения": [],
    "Анализы": [],
    "Товары": ["Аптека и процедурка", "Косметика", "БАДы"],
    "Другие услуги": ["Прочие"],
  };
  p.rules = [
    ["массаж", "Ручные процедуры", "Массаж", ""],
    ["юмейхо", "Ручные процедуры", "Юмейхо", ""],
    ["кинезиотейп", "Ручные процедуры", "Кинезиотейпирование", ""],
    ["кинейзотейп", "Ручные процедуры", "Кинезиотейпирование", ""],
    ["остеопат", "Ручные процедуры", "Остеопатия", ""],
    ["уход", "Ручные процедуры", "Уходовые", "услуга"],
    ["пдрн", "Накожные применения", "", ""],
    ["накожн", "Накожные применения", "", ""],
    ["анализ", "Анализы", "", ""],
    ["прием", "Приемы", "", ""],
    ["консультац", "Приемы", "", ""],
    ["аптека", "Товары", "Аптека и процедурка", ""],
    ["косметика", "Товары", "Косметика", ""],
    ["бад", "Товары", "БАДы", "товар"],
  ];
  return p;
}

function defaultSettings() {
  return {
    showScores: true,
    weightsV: 4, // версия схемы (v3-профили)
    depts: {
      "По умолчанию": defaultProfile(),
      "Косметология": profileCosmetology(),
      "Гинекология": profileGynecology(),
      "Хирургия": profileSurgery(),
      "Терапия": profileTherapy(),
      "Физиотерапия": profilePhysiotherapy(),
    },
  };
}

/* Резолвер: полный профиль отделения с наследованием от «По умолчанию» */
function deptProfile(deptName) {
  const d = DB.settings.depts;
  const base = d["По умолчанию"] || defaultProfile();
  const own = deptName && d[deptName] ? d[deptName] : null;
  if (!own || own === base) return base;
  // неглубокое наследование по верхним ключам (профили самодостаточны после миграции)
  const merged = Object.assign({}, base, own);
  merged.expertise = Object.assign({}, base.expertise, own.expertise || {});
  merged.scoring = {
    weights: Object.assign({}, base.scoring.weights, (own.scoring || {}).weights || {}),
    enabled: Object.assign({}, base.scoring.enabled, (own.scoring || {}).enabled || {}),
    benchmarks: Object.assign({}, base.scoring.benchmarks, (own.scoring || {}).benchmarks || {}),
  };
  return merged;
}

/* Отделение врача: ручное поле → сопоставление специализации 1С → «По умолчанию» */
function resolvedDeptName(docId) {
  const doc = DB.doctors[docId];
  if (!doc) return "По умолчанию";
  if (doc.dept && DB.settings.depts[doc.dept]) return doc.dept;
  const hay = ((doc.dept || "") + " " + (doc.spec || "")).toLowerCase();
  if (hay.trim()) {
    for (const [name, p] of Object.entries(DB.settings.depts)) {
      if (name === "По умолчанию") continue;
      for (const m of (p.matchers || [])) {
        if (hay.includes(m.toLowerCase())) return name;
      }
    }
  }
  return "По умолчанию";
}
function profileForDoctor(docId) {
  return deptProfile(resolvedDeptName(docId));
}

/* палитра групп: закреплена за позицией группы в таксономии отделения */
const GROUP_PALETTE = ["#2563eb", "#7c3aed", "#059669", "#d97706", "#0d9488", "#db2777", "#94a3b8", "#9333ea", "#65a30d", "#dc2626", "#0891b2", "#64748b"];
function groupColor(profile, group) {
  const order = Object.keys(profile.groups);
  const i = order.indexOf(group);
  return GROUP_PALETTE[(i >= 0 ? i : order.length) % GROUP_PALETTE.length];
}

function cosmetologyRules() {
  return [
    // Инъекции
    ["ботулинотерап", "Инъекции", "Ботулинотерапия", ""],
    ["диспорт", "Инъекции", "Ботулинотерапия", ""],
    ["ксеомин", "Инъекции", "Ботулинотерапия", ""],
    ["релатокс", "Инъекции", "Ботулинотерапия", ""],
    ["лантокс", "Инъекции", "Ботулинотерапия", ""],
    ["миотокс", "Инъекции", "Ботулинотерапия", ""],
    ["ботокс", "Инъекции", "Ботулинотерапия", ""],
    ["лаеннек", "Инъекции", "Лаеннек", ""],
    ["лаенек", "Инъекции", "Лаеннек", ""],
    ["мэлсмон", "Товары", "Мелсмон (товар)", "товар"],
    ["мелсмон", "Товары", "Мелсмон (товар)", "товар"],
    ["мэлсмон", "Инъекции", "Мелсмон", ""],
    ["мелсмон", "Инъекции", "Мелсмон", ""],
    ["плацентарн", "Инъекции", "Мелсмон", ""],
    ["контурная пластика", "Инъекции", "Контурная/биоревит./мезо", ""],
    ["контурной пластики", "Инъекции", "Контурная/биоревит./мезо", ""],
    ["биоревитализ", "Инъекции", "Контурная/биоревит./мезо", ""],
    ["биорепарац", "Инъекции", "Контурная/биоревит./мезо", ""],
    ["мезотерап", "Инъекции", "Контурная/биоревит./мезо", ""],
    ["мезо-", "Инъекции", "Контурная/биоревит./мезо", ""],
    ["мезоскальпт", "Инъекции", "Контурная/биоревит./мезо", ""],
    ["коллагенотерап", "Инъекции", "Контурная/биоревит./мезо", ""],
    ["коллост", "Инъекции", "Контурная/биоревит./мезо", ""],
    ["гиалуронидаза", "Инъекции", "Контурная/биоревит./мезо", ""],
    ["ферментная терапия", "Инъекции", "Контурная/биоревит./мезо", ""],
    ["энзимная терапия", "Инъекции", "Контурная/биоревит./мезо", ""],
    ["плазмотерап", "Инъекции", "Контурная/биоревит./мезо", ""],
    ["полимолочн", "Инъекции", "Контурная/биоревит./мезо", ""],
    ["микроигл", "Инъекции", "Контурная/биоревит./мезо", ""],
    ["канюля", "Инъекции", "Контурная/биоревит./мезо", ""],
    ["дипроспан", "Инъекции", "Прочие инъекции", ""],
    ["лонгидаза", "Инъекции", "Прочие инъекции", ""],
    ["инъекц", "Инъекции", "Прочие инъекции", ""],
    // Накожные применения (включая ПДРН — по шаблону заведующей)
    ["пдрн", "Накожные применения", "", ""],
    ["накожн", "Накожные применения", "", ""],
    ["нар. прим", "Накожные применения", "", ""],
    ["нар прим", "Накожные применения", "", ""],
    ["наруж. прим", "Накожные применения", "", ""],
    // Анализы
    ["анализ", "Анализы", "", ""],
    ["взятие крови", "Анализы", "", ""],
    ["ихла", "Анализы", "", ""],
    ["гематологическ", "Анализы", "", ""],
    ["диагностик", "Анализы", "", ""],
    // Приемы
    ["прием", "Приемы", "", ""],
    ["консультац", "Приемы", "", ""],
    // Товары и процедурка
    ["аптека", "Товары", "Аптека и процедурка", ""],
    ["процедурный кабинет", "Товары", "Аптека и процедурка", ""],
    ["процедуры введения", "Товары", "Аптека и процедурка", ""],
    ["введение препарата", "Товары", "Аптека и процедурка", ""],
    ["введения лекарств", "Товары", "Аптека и процедурка", ""],
    ["внутривен", "Товары", "Аптека и процедурка", ""],
    ["внутримышеч", "Товары", "Аптека и процедурка", ""],
    ["капельн", "Товары", "Аптека и процедурка", ""],
    ["косметика", "Товары", "Косметика", ""],
    ["бад", "Товары", "БАДы", "товар"],
    ["пищевая", "Товары", "БАДы", "товар"],
    ["концентрат пищевой", "Товары", "БАДы", ""],
    ["добавка к пище", "Товары", "БАДы", ""],
    // Другие услуги
    ["пилинг", "Другие услуги", "Маски и пилинги", "услуга"],
    ["маска", "Другие услуги", "Маски и пилинги", "услуга"],
    ["маски и пилинги", "Другие услуги", "Маски и пилинги", ""],
    ["демакияж", "Другие услуги", "Маски и пилинги", ""],
    ["чистка", "Другие услуги", "Маски и пилинги", "услуга"],
    ["уход", "Другие услуги", "Маски и пилинги", "услуга"],
    ["дмк ", "Другие услуги", "Маски и пилинги", "услуга"],
    ["удаление", "Другие услуги", "Удаление", ""],
    ["эпиляц", "Другие услуги", "Эпиляция", ""],
    ["массаж", "Другие услуги", "Тело", ""],
    ["водородотерап", "Другие услуги", "Прочие", ""],
  ];
}

let DB = {
  version: APP_VERSION,
  settings: defaultSettings(),
  doctors: {},   // id -> {name, aliases:[], spec, dept}
  months: {},    // 'YYYY-MM' -> {vyrabotka:{}, kb:{docId:{win:{...}}}, naznach:{docId:{slice:{...}}}, pervichka:{}, prostoy:{}, zapis:{}, manual6:{}}
  dynamicNotes: {}, // ручные пояснения к точкам роста и риска
  fileLog: [],
};

/* ---------- утилиты ---------- */

function fmtMoney(v) {
  if (v == null || isNaN(v)) return "—";
  return Math.round(v).toLocaleString("ru-RU") + " ₽";
}
function fmtNum(v, d = 0) {
  if (v == null || isNaN(v)) return "—";
  return v.toLocaleString("ru-RU", { maximumFractionDigits: d, minimumFractionDigits: 0 });
}
function fmtPct(v, d = 1) {
  if (v == null || isNaN(v)) return "—";
  return v.toLocaleString("ru-RU", { maximumFractionDigits: d }) + "%";
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function monthLabel(key) {
  if (!key) return "—";
  const [y, m] = key.split("-").map(Number);
  return MONTH_NAMES[m - 1] + " " + y;
}
function parseRuNumber(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).replace(/ /g, "").replace(/\s/g, "").replace(",", ".");
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}
function parseHoursMin(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Math.round(v * 24 * 60);
  const s = String(v).trim();
  const m = s.match(/^(\d+):(\d{1,2})(?::\d{1,2})?$/);
  if (m) return parseInt(m[1]) * 60 + parseInt(m[2]);
  const n = parseRuNumber(s);
  return n == null ? null : Math.round(n * 60);
}
function minToHours(min) {
  if (min == null) return "—";
  return Math.floor(min / 60) + ":" + String(min % 60).padStart(2, "0");
}
function extractPeriod(text) {
  const m = String(text).match(/(\d{2})\.(\d{2})\.(\d{4})\s*[-–]\s*(\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) return null;
  return { from: { d: +m[1], m: +m[2], y: +m[3] }, to: { d: +m[4], m: +m[5], y: +m[6] } };
}
function periodMonthKey(p) { return p.to.y + "-" + String(p.to.m).padStart(2, "0"); }
function periodMonths(p) { return (p.to.y - p.from.y) * 12 + (p.to.m - p.from.m) + 1; }
function periodStr(p) {
  if (!p) return "—";
  const f = n => String(n).padStart(2, "0");
  return `${f(p.from.d)}.${f(p.from.m)}.${p.from.y} – ${f(p.to.d)}.${f(p.to.m)}.${p.to.y}`;
}
function prevYearKey(monthKey) {
  const [y, m] = monthKey.split("-");
  return (Number(y) - 1) + "-" + m;
}
function prevMonthKey(monthKey, back = 1) {
  let [y, m] = monthKey.split("-").map(Number);
  m -= back;
  while (m <= 0) { m += 12; y--; }
  return y + "-" + String(m).padStart(2, "0");
}

/* ---------- ФИО ---------- */

function normFio(raw) {
  return String(raw || "")
    .replace(/\(.*?\)/g, " ")
    .replace(/[«»"']/g, " ")
    .replace(/\.{2,}\s*$/, "")
    .replace(/ё/gi, "е")
    .toLowerCase()
    .replace(/[^а-яa-z\- ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function fioTokens(raw) {
  return normFio(raw).split(" ").filter(Boolean);
}
function tokenMatch(a, b) {
  if (a === b) return 1;
  const min = Math.min(a.length, b.length);
  if (min >= 4 && (a.startsWith(b) || b.startsWith(a))) return 0.9;
  return 0;
}
function fioScore(rawA, rawB) {
  const ta = fioTokens(rawA), tb = fioTokens(rawB);
  if (!ta.length || !tb.length) return 0;
  if (tokenMatch(ta[0], tb[0]) === 0) return 0;
  const n = Math.min(ta.length, tb.length, 3);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += tokenMatch(ta[i], tb[i]);
  return sum / Math.max(Math.min(ta.length, 3), Math.min(tb.length, 3));
}
function resolveDoctor(rawName) {
  const norm = normFio(rawName);
  if (!norm) return null;
  let bestId = null, bestScore = 0;
  for (const [id, doc] of Object.entries(DB.doctors)) {
    for (const alias of [doc.name, ...doc.aliases]) {
      const s = fioScore(alias, rawName);
      if (s > bestScore) { bestScore = s; bestId = id; }
    }
  }
  if (bestId && bestScore >= 0.85) {
    const doc = DB.doctors[bestId];
    const cleaned = cleanupFioDisplay(rawName);
    if (!doc.aliases.includes(cleaned) && cleaned !== doc.name) doc.aliases.push(cleaned);
    const tNew = fioTokens(cleaned).length, tOld = fioTokens(doc.name).length;
    if (tNew > tOld || (tNew === tOld && cleaned.length > doc.name.length)) doc.name = cleaned;
    return bestId;
  }
  const id = "d" + (Object.keys(DB.doctors).length + 1) + "_" + norm.split(" ")[0];
  DB.doctors[id] = { name: cleanupFioDisplay(rawName), aliases: [] };
  return id;
}
function cleanupFioDisplay(raw) {
  return String(raw).replace(/\.{2,}\s*$/, "").replace(/\s+/g, " ").trim();
}
function doctorName(id) {
  return DB.doctors[id] ? DB.doctors[id].name : "?";
}

/* ---------- хранилище ---------- */

function emptyMonth() {
  return { vyrabotka: {}, kb: {}, naznach: {}, pervichka: {}, prostoy: {}, zapis: {}, manual6: {} };
}
function ensureMonth(key) {
  if (!DB.months[key]) DB.months[key] = emptyMonth();
  const m = DB.months[key];
  for (const k of ["vyrabotka", "kb", "naznach", "pervichka", "prostoy", "zapis", "manual6"]) {
    if (!m[k]) m[k] = {};
  }
  return m;
}

/* Миграция базы: v1 → v3 и v2 → v3 (данные месяцев v2 совместимы с v3) */
function migrateDB(parsed) {
  if (!parsed || !parsed.months) return null;
  if (parsed.version === APP_VERSION) {
    if (!parsed.dynamicNotes || typeof parsed.dynamicNotes !== "object") parsed.dynamicNotes = {};
    return parsed;
  }

  if (parsed.version === 2) {
    // данные не меняются; глобальные настройки v2 переносим в профили
    const old = parsed.settings || {};
    const def = defaultSettings();
    const settings = { showScores: old.showScores !== false, weightsV: def.weightsV, depts: def.depts };
    // косметологический профиль наследует ручные наработки v2
    const cosmo = settings.depts["Косметология"];
    if (Array.isArray(old.devices) && old.devices.length) {
      cosmo.expertise.items = old.devices.map(d => ({ name: d.name, syn: d.syn || [d.name.toLowerCase()], core: d.core !== false }));
    }
    if (Array.isArray(old.deviceRules)) cosmo.expertise.rules = old.deviceRules;
    if (Array.isArray(old.deviceHints) && old.deviceHints.length) cosmo.expertise.hints = old.deviceHints;
    if (Array.isArray(old.categoryRules) && old.categoryRules.length) cosmo.rules = old.categoryRules;
    if (old.benchmarks) {
      for (const dn of Object.keys(settings.depts)) {
        settings.depts[dn].scoring.benchmarks = Object.assign({}, defaultBenchmarks(), old.benchmarks);
      }
    }
    // нормативы отделений v2 (плоские) — в одноимённые профили
    for (const [dn, oldD] of Object.entries(old.depts || {})) {
      if (!settings.depts[dn]) settings.depts[dn] = Object.assign(defaultProfile(), { }); // новое отделение из v2
      const p = settings.depts[dn];
      for (const k of ["minVisits", "activeM", "riskM", "courseX", "courseM", "corePct"]) {
        if (oldD[k] != null) p[k] = oldD[k];
      }
      if (oldD.hasDevices === false) p.expertise = Object.assign({}, p.expertise, { mode: "none" });
    }
    return { version: APP_VERSION, settings, doctors: parsed.doctors || {}, months: parsed.months, dynamicNotes: parsed.dynamicNotes || {}, fileLog: parsed.fileLog || [] };
  }

  if (parsed.version === 1) {
    const migrated = {
      version: APP_VERSION,
      settings: defaultSettings(),
      doctors: parsed.doctors || {},
      months: {},
      dynamicNotes: parsed.dynamicNotes || {},
      fileLog: parsed.fileLog || [],
    };
    for (const [mk, m] of Object.entries(parsed.months)) {
      const nm = emptyMonth();
      for (const [docId, v] of Object.entries(m.vyrabotka || {})) {
        nm.vyrabotka[docId] = {
          period: v.period,
          items: (v.items || []).map(it => ({
            cat: it.cat, n: it.n,
            qOwn: it.f === "own" ? (it.q || 0) : 0,
            sOwn: it.f === "own" ? (it.s || 0) : 0,
            qRef: it.f === "ref" ? (it.q || 0) : 0,
            sRef: it.f === "ref" ? (it.s || 0) : 0,
            goods: 0,
          })),
        };
      }
      for (const [docId, kb] of Object.entries(m.kb || {})) {
        const win = String(kb.windowM || 12);
        nm.kb[docId] = {};
        nm.kb[docId][win] = { clients: kb.clients, period: kb.period };
      }
      nm.pervichka = m.pervichka || {};
      nm.prostoy = m.prostoy || {};
      nm.zapis = m.zapis || {};
      nm.manual6 = m.manual6 || {};
      migrated.months[mk] = nm;
    }
    return migrated;
  }
  return null;
}

/* Профиль после загрузки/импорта: добить недостающие ключи до полной формы */
function normalizeProfiles() {
  const def = defaultProfile();
  if (!DB.settings.depts) DB.settings.depts = defaultSettings().depts;
  for (const dn of Object.keys(DB.settings.depts)) {
    const p = Object.assign({}, def, DB.settings.depts[dn]);
    p.expertise = Object.assign({}, def.expertise, DB.settings.depts[dn].expertise || {});
    if (!Array.isArray(p.expertise.items)) p.expertise.items = [];
    if (!Array.isArray(p.expertise.rules)) p.expertise.rules = [];
    if (!Array.isArray(p.expertise.hints)) p.expertise.hints = [];
    if (!p.groups || !Object.keys(p.groups).length) p.groups = JSON.parse(JSON.stringify(def.groups));
    if (!Array.isArray(p.rules)) p.rules = def.rules.slice();
    if (!p.overrides) p.overrides = {};
    const os = (DB.settings.depts[dn].scoring || {});
    p.scoring = {
      weights: Object.assign({}, defaultScoring().weights, os.weights || {}),
      enabled: Object.assign({}, defaultScoring().enabled, os.enabled || {}),
      benchmarks: Object.assign({}, defaultBenchmarks(), os.benchmarks || {}),
    };
    if (!Array.isArray(p.subdivisions)) p.subdivisions = [];
    if (!Array.isArray(p.matchers)) p.matchers = [];
    DB.settings.depts[dn] = p;
  }
}

function applyLoadedDatabase(parsed) {
  const db = migrateDB(parsed);
  if (!db) return false;
  DB = db;
  if (DB.settings.showScores == null) DB.settings.showScores = true;
  normalizeProfiles();
  for (const mk of Object.keys(DB.months)) ensureMonth(mk);
  return true;
}

async function flushDesktopSaveQueue() {
  if (!DESKTOP_API || !desktopPendingSnapshot) return false;
  try {
    while (desktopPendingSnapshot && desktopWrittenRevision < desktopPendingRevision) {
      const revision = desktopPendingRevision;
      const snapshot = desktopPendingSnapshot;
      const summary = await DESKTOP_API.saveDatabase(snapshot);
      desktopWrittenRevision = revision;
      if (desktopWrittenRevision >= desktopPendingRevision) desktopPendingSnapshot = null;
      if (DESKTOP_STATE) DESKTOP_STATE.summary = summary;
    }
    setAutosaveStatus(`сохранено в SQLite (${autosaveTime()})`);
    updateHeaderStatus();
    return true;
  } catch (error) {
    console.error("desktop database save failed", error);
    setAutosaveStatus("ошибка сохранения SQLite: " + error.message);
    toast("⚠ Не удалось сохранить рабочую базу: " + error.message, true);
    return false;
  }
}

function queueDesktopSnapshot(snapshot) {
  desktopPendingSnapshot = snapshot;
  desktopPendingRevision++;
  setAutosaveStatus("сохранение в SQLite…");
  if (!desktopWriterPromise) {
    const writer = flushDesktopSaveQueue();
    desktopWriterPromise = writer;
    writer.finally(() => {
      if (desktopWriterPromise === writer) desktopWriterPromise = null;
    });
  }
  return desktopWriterPromise;
}

function saveLocal() {
  if (typeof clearMetricsCache === "function") clearMetricsCache(); // данные/настройки изменились
  let snapshot;
  try {
    snapshot = JSON.stringify(DB);
  } catch (e) {
    console.warn("database serialization failed", e);
    toast("⚠ Не удалось подготовить базу к сохранению: " + e.message, true);
    updateHeaderStatus();
    return Promise.resolve(false);
  }
  if (DESKTOP_API) {
    return queueDesktopSnapshot(snapshot);
  }
  try {
    // Синхронная локальная копия создаётся до перерисовки интерфейса.
    localStorage.setItem(LS_KEY, snapshot);
  } catch (e) {
    console.warn("localStorage save failed", e);
    toast("⚠ Не удалось сохранить в браузере (переполнение?) — сохраните базу в файл!", true);
  }
  // Тот же снимок немедленно передаётся последовательной записи в подключённый файл.
  const fileSave = queueAutosaveSnapshot(snapshot);
  updateHeaderStatus();
  return fileSave;
}
function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    applyLoadedDatabase(parsed);
  } catch (e) {
    console.warn("localStorage load failed", e);
  }
}

async function loadDesktopDatabase() {
  if (!DESKTOP_API) return null;
  DESKTOP_STATE = await DESKTOP_API.initialize();
  if (DESKTOP_STATE.snapshot) applyLoadedDatabase(DESKTOP_STATE.snapshot);
  setAutosaveStatus(`SQLite · ${DESKTOP_STATE.config.databasePath}`);
  return DESKTOP_STATE;
}

/* Склейка карточек сотрудников (данные складываются — корректно для филиалов) */
function mergeDoctors(ids) {
  ids = ids.filter(id => DB.doctors[id]);
  if (ids.length < 2) return null;
  const target = ids.reduce((a, b) => (DB.doctors[b].name.length > DB.doctors[a].name.length ? b : a));
  for (const id of ids) {
    if (id === target) continue;
    const src = DB.doctors[id], tgt = DB.doctors[target];
    for (const al of [src.name, ...(src.aliases || [])]) {
      if (al !== tgt.name && !tgt.aliases.includes(al)) tgt.aliases.push(al);
    }
    if (!tgt.dept && src.dept) tgt.dept = src.dept;
    if (!tgt.subdept && src.subdept) tgt.subdept = src.subdept;
    if (!tgt.spec && src.spec) tgt.spec = src.spec;
    for (const m of Object.values(DB.months)) {
      if (m.vyrabotka[id]) {
        if (m.vyrabotka[target]) m.vyrabotka[target].items.push(...m.vyrabotka[id].items);
        else m.vyrabotka[target] = m.vyrabotka[id];
        delete m.vyrabotka[id];
      }
      if (m.kb[id]) {
        if (!m.kb[target]) m.kb[target] = {};
        for (const [win, data] of Object.entries(m.kb[id])) {
          if (m.kb[target][win]) m.kb[target][win].clients.push(...data.clients);
          else m.kb[target][win] = data;
        }
        delete m.kb[id];
      }
      if (m.naznach && m.naznach[id]) {
        if (!m.naznach[target]) m.naznach[target] = {};
        for (const [sl, data] of Object.entries(m.naznach[id])) {
          if (m.naznach[target][sl]) m.naznach[target][sl].items.push(...data.items);
          else m.naznach[target][sl] = data;
        }
        delete m.naznach[id];
      }
      if (m.prostoy[id]) {
        if (m.prostoy[target]) {
          const a = m.prostoy[target], b = m.prostoy[id];
          for (const k of ["normaMin", "factMin", "zayavkiMin", "zayavkiNvMin"]) {
            if (a[k] != null || b[k] != null) a[k] = (a[k] || 0) + (b[k] || 0);
          }
          a.schedPct = null;
          a.schedNvPct = null;
        } else m.prostoy[target] = m.prostoy[id];
        delete m.prostoy[id];
      }
      if (m.zapis[id]) {
        if (m.zapis[target]) {
          for (const k of ["created", "zapis", "okaz", "other", "total"]) m.zapis[target][k] += m.zapis[id][k];
        } else m.zapis[target] = m.zapis[id];
        delete m.zapis[id];
      }
      for (const sl of Object.values(m.pervichka)) {
        if (sl.perDoc[id]) {
          if (sl.perDoc[target]) {
            for (const k of ["visits", "first", "ret", "notRet"]) sl.perDoc[target][k] += sl.perDoc[id][k];
          } else sl.perDoc[target] = sl.perDoc[id];
          delete sl.perDoc[id];
        }
      }
      if (m.manual6 && m.manual6[id]) {
        if (!m.manual6[target]) m.manual6[target] = m.manual6[id];
        delete m.manual6[id];
      }
    }
    delete DB.doctors[id];
  }
  return target;
}

/* ---------- автосохранение в файл (Chrome/Edge) ---------- */
let autosaveHandle = null;
let autosaveStatus = "";
let autosavePendingSnapshot = null;
let autosavePendingRevision = 0;
let autosaveWrittenRevision = 0;
let autosaveWriterPromise = null;
let autosaveInteractivePermission = false;

function autosaveTime() {
  return new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function setAutosaveStatus(text) {
  autosaveStatus = text;
  const el = document.getElementById("autosaveStatus");
  if (el) el.textContent = text;
}
function discardAutosaveSnapshot() {
  autosavePendingSnapshot = null;
  autosaveWrittenRevision = autosavePendingRevision;
}

/* Каждая правка ставит свежий снимок в очередь сразу. Пока идёт запись,
   промежуточные снимки объединяются, но последняя версия никогда не теряется. */
function queueAutosaveSnapshot(snapshot, interactive = false) {
  if (!autosaveHandle) {
    setAutosaveStatus(`сохранено локально (${autosaveTime()}) · файл автосохранения не подключён`);
    return Promise.resolve(false);
  }
  autosavePendingSnapshot = snapshot;
  autosavePendingRevision++;
  if (interactive) autosaveInteractivePermission = true;
  setAutosaveStatus(`сохранено локально · запись в ${autosaveHandle.name}…`);
  if (!autosaveWriterPromise) {
    const writer = flushAutosaveQueue();
    autosaveWriterPromise = writer;
    writer.finally(() => {
      if (autosaveWriterPromise === writer) autosaveWriterPromise = null;
    });
  }
  return autosaveWriterPromise;
}

function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("dpi_app_fs", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbSet(k, v) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(v, k);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(k) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction("kv", "readonly");
    const rq = tx.objectStore("kv").get(k);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function restoreAutosave() {
  if (DESKTOP_API) {
    setAutosaveStatus("SQLite · автоматическое сохранение включено");
    return;
  }
  try {
    const h = await idbGet("autosaveHandle");
    if (h) {
      autosaveHandle = h;
      setAutosaveStatus("подключено: " + h.name + " · проверка записи…");
      // При запуске синхронизируем файл с актуальной локальной базой.
      await writeAutosave(false);
    }
  } catch (e) { /* нет дескриптора */ }
}
async function connectAutosave() {
  if (DESKTOP_API) {
    try {
      const result = await DESKTOP_API.createBackup();
      toast("Резервная копия создана: " + result.path);
      setAutosaveStatus(`SQLite · копия ${autosaveTime()}`);
    } catch (error) {
      toast("Не удалось создать резервную копию: " + error.message, true);
    }
    return;
  }
  if (!window.showSaveFilePicker) {
    toast("Автосохранение в файл поддерживают Chrome и Edge. Пользуйтесь кнопкой «Сохранить базу в файл».", true);
    return;
  }
  try {
    // Для уже выбранного файла кнопка служит быстрым сохранением и повторным запросом разрешения.
    if (autosaveHandle) {
      const saved = await writeAutosave(true);
      if (saved) {
        toast("База сохранена в " + autosaveHandle.name + ". Автосохранение активно.");
        renderAll();
        return;
      }
    }
    autosaveHandle = await window.showSaveFilePicker({
      suggestedName: "база_оценки_врачей.json",
      types: [{ description: "База оценки врачей", accept: { "application/json": [".json"] } }],
    });
    await idbSet("autosaveHandle", autosaveHandle);
    setAutosaveStatus("подключено: " + autosaveHandle.name);
    const saved = await writeAutosave(true);
    if (!saved) throw new Error("не получено разрешение на запись");
    toast("Автосохранение подключено — база сразу записывается в " + autosaveHandle.name + " после каждого изменения");
    renderAll();
  } catch (e) {
    if (e.name !== "AbortError") toast("Не удалось подключить автосохранение: " + e.message, true);
  }
}
async function writeAutosave(interactive) {
  let snapshot;
  try {
    snapshot = JSON.stringify(DB);
  } catch (e) {
    setAutosaveStatus("ошибка подготовки базы: " + e.message);
    return false;
  }
  return queueAutosaveSnapshot(snapshot, !!interactive);
}
async function flushAutosaveQueue() {
  if (!autosaveHandle || !autosavePendingSnapshot) return false;
  try {
    let perm = await autosaveHandle.queryPermission({ mode: "readwrite" });
    if (perm !== "granted" && autosaveInteractivePermission) {
      perm = await autosaveHandle.requestPermission({ mode: "readwrite" });
    }
    autosaveInteractivePermission = false;
    if (perm !== "granted") {
      setAutosaveStatus("локально сохранено · для записи в файл нажмите «Автосохранение» и разрешите доступ");
      discardAutosaveSnapshot();
      return false;
    }

    while (autosavePendingSnapshot && autosaveWrittenRevision < autosavePendingRevision) {
      const revision = autosavePendingRevision;
      const snapshot = autosavePendingSnapshot;
      const w = await autosaveHandle.createWritable();
      try {
        await w.write(snapshot);
        await w.close();
      } catch (e) {
        try { if (typeof w.abort === "function") await w.abort(); } catch (_) { /* уже закрыт */ }
        throw e;
      }
      autosaveWrittenRevision = revision;
    }
    if (autosaveWrittenRevision >= autosavePendingRevision) autosavePendingSnapshot = null;
    setAutosaveStatus("сохранено: браузер + " + autosaveHandle.name + " (" + autosaveTime() + ")");
    return true;
  } catch (e) {
    console.warn("autosave failed", e);
    setAutosaveStatus("локально сохранено · ошибка записи в файл: " + e.message);
    discardAutosaveSnapshot();
    return false;
  }
}

async function exportDB() {
  if (DESKTOP_API) {
    try {
      const result = await DESKTOP_API.exportJson(JSON.stringify(DB, null, 1));
      if (!result.canceled) toast("JSON-копия сохранена: " + result.path);
    } catch (error) {
      toast("Не удалось сохранить JSON-копию: " + error.message, true);
    }
    return;
  }
  const blob = new Blob([JSON.stringify(DB, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const d = new Date();
  a.download = `база_оценки_врачей_${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function importDBFile(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const parsed = JSON.parse(reader.result);
      const db = migrateDB(parsed);
      if (!db) throw new Error("не похоже на файл базы");
      if (DESKTOP_API) await DESKTOP_API.createBackup();
      DB = db;
      normalizeProfiles();
      await saveLocal();
      renderAll();
      toast("База загружена: месяцев — " + Object.keys(DB.months).length + ", врачей — " + Object.keys(DB.doctors).length);
    } catch (e) {
      toast("Ошибка чтения базы: " + e.message, true);
    }
  };
  reader.readAsText(file);
}

async function clearDB() {
  if (!confirm("Удалить все загруженные данные и начать заново? Настройки сохранятся.")) return;
  if (DESKTOP_API) {
    try {
      await DESKTOP_API.createBackup();
    } catch (error) {
      toast("Очистка отменена: не удалось создать резервную копию — " + error.message, true);
      return;
    }
  }
  const st = DB.settings;
  DB = { version: APP_VERSION, settings: st, doctors: {}, months: {}, dynamicNotes: {}, fileLog: [] };
  await saveLocal();
  renderAll();
}

/* ---------- уведомления ---------- */
let toastTimer = null;
function toast(msg, isErr) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.setAttribute("aria-atomic", "true");
    el.title = "Нажмите, чтобы закрыть";
    el.addEventListener("click", () => { el.style.display = "none"; });
    el.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1c2333;color:#fff;padding:10px 22px;border-radius:10px;font-size:13px;z-index:200;box-shadow:0 6px 24px rgba(0,0,0,.25);max-width:80%;";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.setAttribute("aria-live", isErr ? "assertive" : "polite");
  el.style.background = isErr ? "#b91c1c" : "#1c2333";
  el.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = "none"; }, isErr ? 10000 : 5000);
}

function updateHeaderStatus() {
  const el = document.getElementById("headerStatus");
  if (!el) return;
  const months = Object.keys(DB.months).length;
  const docs = Object.keys(DB.doctors).length;
  const storage = DESKTOP_API ? " · SQLite" : "";
  el.textContent = (months ? `в базе: ${months} мес., ${docs} сотр.` : "база пуста") + storage;
}
