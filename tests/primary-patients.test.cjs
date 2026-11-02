"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { File } = require("node:buffer"), { webcrypto } = require("node:crypto");
const XLSX = require("../build/xlsx.full.min.js");
const { cloudPrivacyPatterns, assertCloudPatientPrivacy } = require("../desktop/services/cloud-privacy.cjs");
const { validateCloudReport } = require("../desktop/services/cloud-report-model.cjs");
const { renderCloudReport } = require("../mobile-server/cloud-report-renderer.cjs");
const root = path.resolve(__dirname, "..");
function context() {
  const c = vm.createContext({ console, window: { addEventListener() {} }, navigator: {},
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => ({ style: {} }) },
    localStorage: { getItem: () => null, setItem() {} }, setTimeout, clearTimeout, Intl, TextDecoder, TextEncoder,
    crypto: webcrypto, Blob, File, XLSX, confirm: () => true });
  for (const file of ["app-core.js", "app-parsers.js", "app-metrics.js", "report-worker.js", "cloud-report-data.js", "app-ui.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, "build", file), "utf8"), c, { filename: file });
  }
  vm.runInContext(`DB.doctors = { d1: { name: 'Тестов Врач Первый', aliases: [], department: 'Косметология' } }; DB.months = {};`, c);
  return c;
}
function primarySheet({ sourceCol = 4 } = {}) {
  const row = (name, primary, clinic, visits, revenue, source) => {
    const values = [name, null, null, null, null, primary, null, clinic, null, visits, revenue];
    if (source != null) values[sourceCol] = source;
    return values;
  };
  const rows = [["Период: 01.01.2026 - 31.01.2026"],
    ["Клиника", null, null, null, null, "Количество первичных", "Сумма первичный", "Количество первичных клиника", "Сумма первичный клиника", "Количество итого", "Сумма"],
    ["Врач"], Array.from({ length: 5 }, (_, i) => i === 0 ? "Клиент" : i === sourceCol ? "Источник информации" : null), ["Услуга"],
    row("Клиника", 1, 1, 3, 300), row("Тестов Врач Первый", 1, 1, 3, 300),
    row("Первичный Пациент Секретный", 1, 1, 2, 200, "Рекомендация"), row("Услуга А", 1, 1, 50, 200),
    row("Повторный Пациент Секретный", null, null, 1, 100), row("Услуга Б", null, null, 90, 100),
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!rows"] = rows.map((_, i) => ({ level: i === 6 ? 1 : [7, 9].includes(i) ? 2 : [8, 10].includes(i) ? 3 : 0 }));
  return { rows, ws };
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }

test("primary XLS parser uses patient hierarchy, shifted source, doctor totals and not service quantities", async () => {
  const c = context();
  for (const sourceCol of [3, 4]) {
    Object.assign(c, primarySheet({ sourceCol }));
    const parsed = plain(vm.runInContext("parsePrimaryPatients(rows, extractHeaderInfo(rows), ws)", c));
    assert.equal(vm.runInContext("detectReportType(rows)", c), "primaryPatients");
    assert.equal(parsed.checked, true);
    assert.equal(parsed.perDoc.length, 1);
    assert.equal(parsed.perDoc[0].patients.length, 2);
    assert.deepEqual(parsed.perDoc[0].patients.map(row => row.visits), [2, 1]);
    assert.equal(parsed.perDoc[0].patients[0].source, "Рекомендация");
    assert.equal(parsed.perDoc[0].patients[1].primary, 0);
  }
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, c.ws, "Данные");
  c.file = new File([XLSX.write(book, { type: "buffer", bookType: "xlsx" })], "имя-не-важно.xlsx");
  vm.runInContext("loadBundledLibrary = () => {};", c);
  c.confirm = () => { throw new Error("Первый импорт не должен спрашивать о замене"); };
  const log = await vm.runInContext("processFile(file)", c);
  assert.equal(log.status, "загружено");
  assert.equal(log.slot.t, "primaryPatients");
  const summary = plain(vm.runInContext("doctorPrimaryPatients('d1', '2026-01')", c));
  assert.equal(summary.current.count, 1); assert.equal(summary.current.total, 2); assert.equal(summary.current.share, 50);
  assert.equal(summary.patients[0].visits, 2); assert.equal(summary.patients[0].revenue, 200);
  const duplicate = await vm.runInContext("processFile(file)", c);
  assert.equal(duplicate.skipReason, "identical");
  const snapshot = plain(vm.runInContext("DB", c));
  c.snapshot = snapshot;
  assert.equal(vm.runInContext("applyLoadedDatabase(snapshot); doctorPrimaryPatients('d1', '2026-01').current.count", c), 1);
});

function cohort(c) {
  vm.runInContext(`
    const p = (name, primary, visits, revenue) => ({ name, primary, primaryClinic: 0, visits, revenue, source: 'Источник' });
    DB.months = Object.fromEntries(['2025-12','2026-01','2026-02','2026-03','2026-04'].map(key => [key, emptyMonth()]));
    const set = (key, patients) => { DB.months[key].primaryPatients = {perDoc:{d1:{patients}}}; };
    set('2025-12', [p('Старый Пациент',1,10,9000)]);
    set('2026-01', [p('Семёнов Пациент Первый',1,1,100),p('Двойной Пациент',1,1,200),p('Тройной Пациент',1,2,300),p('Повторный Пациент',0,3,400)]);
    set('2026-02', [p('  СЕМЕНОВ   ПАЦИЕНТ ПЕРВЫЙ ',0,0,0),p('Двойной Пациент',0,1,250),p('Тройной Пациент',0,1,350)]);
    set('2026-03', [p('Апрель Не Считать',0,1,10)]);
    set('2026-04', [p('Будущий Пациент',1,7,9999)]);
    for (const key of ['2026-01','2026-02','2026-03']) DB.months[key].naznach.d1 = {'1':{items:[],patientDetailsAvailable:true,patientAssignments:[]}};
    DB.months['2026-02'].naznach.d1['1'].patientAssignments = [
      {name:'Двойной Пациент',n:'Приём кардиолога',executor:'Другой Врач',assigned:1,goods:false},
      {name:'Тройной Пациент',n:'Товар',assigned:1,goods:true},
      {name:'Тройной Пациент',n:'Себе',executor:'Тестов Врач Первый',assigned:1,goods:false},
      {name:'Семёнов Пациент Первый',n:'Не назначено',assigned:0,goods:false},
    ];
    DB.months['2026-03'].vyrabotka.d1={items:[{n:'Прием',q:1,sOwn:100,goods:false}]};
  `, c);
}

test("primary cohort keeps year/cutoff, distinct patients, exact name matching, own visits/revenue and 1/2/3+ denominators", () => {
  const c = context(); cohort(c);
  const result = plain(vm.runInContext("doctorPrimaryPatients('d1','2026-03')", c));
  assert.deepEqual(result.missingMonths, []); assert.equal(result.patients.length, 3);
  assert.deepEqual(result.patients.map(p => p.visits).sort(), [1,2,3]);
  assert.deepEqual(result.patients.map(p => p.revenue).sort((a,b)=>a-b), [100,450,650]);
  assert.deepEqual(result.buckets.map(b=>b.count), [1,1,1]);
  result.buckets.forEach(b=>assert.ok(Math.abs(b.share - 100/3) < 1e-10));
  assert.equal(result.patients.find(p=>p.name==='Двойной Пациент').referral.status, true);
  assert.equal(result.patients.find(p=>p.name==='Тройной Пациент').referral.status, false);
  assert.equal(result.patients.find(p=>p.name.includes('Семёнов')).referral.status, false);
  assert.equal(vm.runInContext("primaryPatientReferrals('d1','2026-02','Двойной П.').status", c), false);
});

test("missing months, invalid numbers and legacy/overlapping referrals stay unknown rather than zero/no", () => {
  const c=context();
  assert.equal(vm.runInContext("doctorPrimaryPatients('d1','2026-03').yearCount",c),null);
  assert.deepEqual(plain(vm.runInContext("doctorPrimaryPatients('d1','2026-03').buckets.map(bucket=>bucket.count)",c)),[null,null,null]);
  cohort(c);
  vm.runInContext(`delete DB.months['2026-02'].primaryPatients;
    delete DB.months['2026-03'].naznach.d1['1'];
    DB.months['2026-03'].naznach.d1['3']={patientDetailsAvailable:true,patientAssignments:[]};`,c);
  const summary=plain(vm.runInContext("doctorPrimaryPatients('d1','2026-03')",c));
  assert.deepEqual(summary.missingMonths,['2026-02']); assert.equal(summary.unknownVisits,3);
  assert.deepEqual(summary.buckets.map(b=>b.count),[0,0,0]);
  for(const row of summary.patients){assert.equal(row.visits,null);assert.equal(row.revenue,null);assert.equal(row.referral.status,row.name==='Двойной Пациент'?true:null);}
  assert.equal(vm.runInContext("primaryPatientReferrals('d1','2026-03','Двойной Пациент').status",c),null);
  vm.runInContext(`DB.months['2026-03'].primaryPatients.perDoc.d1.patients[0].primary=null;`,c);
  assert.equal(vm.runInContext("doctorPrimaryPatients('d1','2026-03').current.count",c),null);
});

test("appointments preserve patient/nomenclature/executor and require the referral labour role", () => {
  const c=context();
  c.rows=[['Отбор: Трудовая роль "Назначение": Направление'],
    ['Направивший врач',null,null,null,'Количество назначено','Количество выполнено','Продажи',null],
    ['Номенклатура/Специализация',null,null,null,null,null,'Количество','Сумма'],
    ['Документ','Клиент','Врач - исполнитель','Номенклатура'],
    ['Тестов Врач Первый',null,null,null,1,0,0,0],['Прием 1','Первичный Пациент','Другой Врач','Прием кардиолога',1,0,0,0]];
  c.ws={};
  const parsed=plain(vm.runInContext("parseNaznacheniya(rows,extractHeaderInfo(rows),ws)",c));
  assert.equal(parsed.doctorRaw,'Тестов Врач Первый');
  assert.equal(parsed.patientDetailsAvailable,true);
  assert.deepEqual(parsed.patientAssignments,[{name:'Первичный Пациент',patientId:null,n:'Прием кардиолога',executor:'Другой Врач',assigned:1,goods:false}]);
  c.rows[0]=['Отбор: Трудовая роль "Назначение": Сотрудник'];
  assert.equal(vm.runInContext("parseNaznacheniya(rows,{otborName:'Тестов Врач Первый'},ws).patientDetailsAvailable",c),false);
  c.rows[0]=['Отбор: Трудовая роль "Назначение": Направление. Направивший врач Равно "Тестов Врач Первый"'];
  assert.equal(vm.runInContext("extractHeaderInfo(rows).otborName",c),'Тестов Врач Первый');
});

test("Admin/Viewer markup and online numeric report share the cohort while cloud retains no patient registry", () => {
  const c=context();cohort(c);
  const html=vm.runInContext("primaryPatientsReportHtml('d1','2026-03')",c);
  assert.match(html,/tblPrimaryMonth/);assert.match(html,/tblPrimaryYear/);assert.match(html,/Семёнов Пациент Первый/);
  const report=plain(vm.runInContext("cloudDoctorReport('d1','2026-03',[])",c));
  assert.doesNotThrow(()=>validateCloudReport(report,{periodKey:'2026-03',doctorId:'d1',title:'Тестовый Врач'}));
  assert.equal(report.numbers.metrics.find(m=>m.id==='primary.year.count').value,3);
  assert.equal(report.numbers.metrics.find(m=>m.id==='primary.month.count').value,0);
  const patterns=cloudPrivacyPatterns(vm.runInContext('DB',c));
  assert.ok(patterns.includes('Двойной Пациент'));
  assert.doesNotThrow(()=>assertCloudPatientPrivacy([{report}],patterns));
  assert.throws(()=>assertCloudPatientPrivacy([{report:{note:'Двойной Пациент'}}],patterns),/пациента/);
  assert.doesNotMatch(JSON.stringify(report),/Семёнов|Двойной Пациент|Тройной Пациент|patientAssignments/);
  assert.match(renderCloudReport(report,'Врач'),/Первичные пациенты врача/);
});

test("V4 share series preserves missing calendar months and compares percentages rather than patient counts", () => {
  const c=context();
  vm.runInContext(`for(const [key,active,total] of [['2026-01',1,2],['2026-03',3,4]]){
    const m=ensureMonth(key); m.kb.d1={'36':{clients:Array.from({length:total},(_,i)=>({name:'Пациент '+i,v:i<active?10:1,r:20,s:100}))}}; }
    clearMetricsCache();`,c);
  const series=plain(vm.runInContext("adminClientBaseSeries('d1','2026-03')",c));
  assert.equal(series.months.length,3);assert.equal(series.bases[1],null);
  assert.equal(vm.runInContext("clientBaseShareMovement(75,50)",c),'Доля выросла на 25 п.п.');
  assert.equal(vm.runInContext("clientBaseShareMovement(50,null)",c),'Нет данных за предыдущий месяц');
  const report=plain(vm.runInContext("cloudDoctorReport('d1','2026-03',[])",c));
  const chart=report.vectors[3].windows[0].sections[0].charts.find(c=>c.id==='partition-shares');
  assert.deepEqual(chart.series[0].values,[50,null,75]);
});
