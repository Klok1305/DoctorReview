# Карта проекта

Проверено: **2026-09-16**. Версия приложения: **2.6.18** (источник — `package.json`).
Репозиторий: `Klok1305/DoctorReview`. Desktop: Windows / Electron 37. Node.js ≥22, pnpm 11.

## Самое важное: релиз запускаем и не ждём

1. Только по просьбе о релизе: проверить изменения, обновить версию в `package.json`, эту карту и `docs/ОБНОВЛЕНИЕ.md`, создать коммит и новый тег `v<version>`.
2. Отправить `main` и тег: `git push --atomic origin main v<version>`.
3. После успешного push **сразу** ответить: «Релиз <version> запущен» и **всегда дать ссылку [на страницу релизов](https://github.com/Klok1305/DoctorReview/releases)**.
4. **Не ждать GitHub Actions, установщиков и публикации файлов. Не запускать мониторинг без отдельной просьбы.** Push подтверждает запуск, а не готовность релиза.
5. При ошибке push сообщить ошибку, не объявлять запуск; ссылку на релизы всё равно дать. Существующие теги и релизы не перезаписывать. Успешные проверки повторять только после новых изменений или обнаруженной проблемы.

## Как работать с картой

Прочитать карту целиком, затем открывать только нужные исходники и связанные тесты из таблицы ниже. Перед правкой сверяться с кодом. Не начинать с обхода всего репозитория или чтения `index.html`, `node_modules`, `dist`, `tmp`, `output`.

Карта — индекс, а не история изменений. Обновлять её при изменении модулей, потока данных, форматов, хранения, границ доступа, сборки или релиза. Менять дату проверки; версию брать из `package.json`.

## Что входит в приложение

- **Admin** импортирует выгрузки 1С, хранит рабочую базу, считает показатели, формирует отчёты и публикации.
- **Viewer** показывает готовые отчёты: отдельное Windows-приложение с импортом ZIP или автономный HTML. Рабочую SQLite Admin не читает.
- **Мобильная PWA** показывает готовые отчёты через Node.js-сервер Bitrix24 Black Hole. Импорта 1С и самостоятельного пересчёта в ней нет. Локальный режим открывает `.kvmobile` одного врача; демо содержит синтетические данные.

## Поток данных

```text
Файлы 1С → FileService → renderer: parsers → DB → metrics → UI
                                           ↓ saveLocal: очередь полных JSON-снимков
                          preload → desktop/main → DatabaseService → SQLite
                          импорт: database:save-import (снимок + источники)
                                  → одна транзакция SQLite → успех либо откат renderer

UI → неизменяемая ReportModel v1 с SHA-256-ревизией
   → общая очистка HTML в renderer до хеширования и повторная проверка в сервисе
   → HTML/PDF/JSON-адаптеры → Viewer ZIP v4 / автономный HTML v4 / PDF
UI → buildMobilePublication → mobile-publication-service → .kvmobilebundle
   → мобильный сервер → API готового отчёта → mobile-pilot/app.js
```

Renderer Admin — общая очистка Viewer HTML и четыре скрипта в общем глобальном контексте: `viewer-html-sanitizer → core → parsers → metrics → ui`. ES-модулей и bundler нет. Большая часть расчётов выполняется в renderer. SQLite и локальные сервисы работают в main-процессе Electron; основной драйвер — `DatabaseSync`.

## Куда идти за изменением

Пути в таблице указаны от корня репозитория. После изменения кода обязателен `pnpm test`; дополнительные проверки перечислены ниже.

| Задача | Исходники и поисковые якоря | Связанные тесты |
|---|---|---|
| Состояние, профили, миграция снимка, сохранение | `build/app-core.js`: `DB`, `migrateDB`, `normalizeProfiles`, `profileForDoctor`, `saveLocal`, `flushDesktopSaveQueue`, `withImportMutation` | `tests/legacy-core.test.cjs` |
| Импорт 1С, ZIP, сопоставление полей | `build/app-parsers.js`: `detectReportType`, `processFile`, `handleFilesBatch` | `tests/legacy-core.test.cjs` |
| Формулы и сводки | `build/app-metrics.js`: `computeMetrics`, `kbSummary`, `partitionClientBase`, `aggregateDeptMonth` (`coverage`, необязательный список врачей), `buildDynamics`; `build/app-ui.js`: `aggregateCoverageHtml` | `tests/legacy-core.test.cjs` |
| Экраны, настройки, графики, публикации | `build/app-ui.js`: `initApp`, `renderAll`, `renderSettings`, `saveDeptBasics`; `build/app.css`; `build/index.template.html` | `tests/build.test.cjs`, `tests/legacy-core.test.cjs`, smoke |
| Electron и IPC | `desktop/main.cjs`: `registerIpc`; `desktop/preload.cjs`: `window.desktopAPI` | `tests/build.test.cjs`, smoke |
| SQLite, JSON-копия, комментарии, назначения заведующих | `desktop/services/database.cjs`: `DatabaseService`, `saveSnapshot`, `createPortableJson`, `restorePortableJson`, `viewerExportCredentials` | `tests/database.test.cjs`, `tests/auth-publication.test.cjs` |
| Рабочая папка и файлы | `desktop/services/config-store.cjs`, `desktop/services/file-service.cjs` | `tests/desktop-services.test.cjs` |
| Backup и обновление Admin | `desktop/services/backup-service.cjs`, `desktop/services/update-service.cjs` | `tests/desktop-services.test.cjs`, `tests/database.test.cjs` |
| PDF и Excel | `build/app-ui.js`: `createImmutableReportModel`, `reportModelPdfAdapter`, `pdfTargetSource`, экспорт; `desktop/main.cjs`: `renderHtmlToPdf`; print CSS | `tests/build.test.cjs`, PDF-smoke и визуальная проверка |
| Подготовка Viewer | `build/app-ui.js`: `composeViewerDashboardHtml`, `createImmutableReportModel`, `exportViewerPackage`; `build/viewer-html-sanitizer.js`: общая очистка HTML до хеширования и в сервисе; `desktop/services/viewer-package-service.cjs`: нормализация ReportModel, оценка размера, общие страницы и адаптеры | `tests/viewer-publication.test.cjs`, `tests/auth-publication.test.cjs`, smoke |
| Установленный Viewer | `viewer/main.cjs`, `viewer/preload.cjs`, `viewer/storage-service.cjs`: поколения каталога и общий пул страниц; `viewer/app.js`, `viewer/index.html`, `viewer/viewer.css` | `tests/viewer-publication.test.cjs` |
| Автономный Viewer | `viewer/standalone.html`, `viewer/standalone-app.js`, `desktop/services/viewer-package-service.cjs` | `tests/viewer-publication.test.cjs`, smoke |
| Данные мобильного отчёта | `build/app-ui.js`: `buildMobilePublication`, `exportAllMobilePublications`; `desktop/services/mobile-publication-service.cjs` | `tests/legacy-core.test.cjs`, `tests/mobile-pilot.test.cjs` |
| Мобильный интерфейс | `mobile-pilot/app.js`, `app.css`, `index.html`, `demo-data.js`, `manifest.webmanifest`, `service-worker.js`, `icons/` | `tests/mobile-pilot.test.cjs`, браузерная проверка |
| Мобильный сервер | `mobile-server/server.cjs`: `createMobileServer`; `scripts/build-mobile-server-package.cjs` | `tests/mobile-server.test.cjs` |
| Сборка и релиз | `build/assemble.ps1`, `package.json`, `electron-builder.viewer.json`, `.github/workflows/ci.yml`, `.github/workflows/release.yml` | `tests/build.test.cjs`, audit, `dist:all` |

## Данные и совместимость

- Рабочая папка Admin: `Входящие/`, `База/оценка-врачей.sqlite`, `Результаты/`, `Резервные копии/`, `Журналы/`. Путь хранит `ConfigStore` в пользовательском `config.json`. OneDrive и сетевые UNC/SMB-папки не поддерживаются.
- SQLite: **схема 5**, снимок `DB`: **версия 4**, читаются снимки 1–4. Это отдельные версии, не версия приложения. Миграции — только в `database.cjs`, учёт — `schema_migrations`; выпущенные миграции не переписывать.
- Аналитика хранится JSON-записями в `app_settings`, `app_meta`, `doctors`, `months`. Импорты, комментарии и версии, публикации и страницы, настройки Viewer и заведующие хранятся в отдельных таблицах того же сервиса. `saveSnapshot(snapshot, importRecords)` атомарно сохраняет аналитику и происхождение импорта без изменения схемы.
- Импорт фиксируется по одному файлу через `desktopAPI.saveImport` → `database:save-import`. Успех и счётчики обновляются после commit; отказ откатывает врачей/месяцы renderer и останавливает оставшуюся пачку. Обычное автосохранение во время изменения импорта откладывается до commit или отката. Ожидающие обычные снимки объединяются; команды импорта сохраняют порядок и происхождение. ZIP подтверждается в транзакции последнего поддерживаемого файла; при ошибке архива подтверждения нет. Повтор пропускает только источники, успешно записанные в SQLite, без доверия устаревшему `source.imported`.
- Полная JSON-копия: `klinvekt-portable-json` v1, включает снимок и служебные таблицы. Фактические заведующие берутся из `viewer_department_heads`, а не из устаревшего renderer-снимка. Старый JSON остаётся импортом только аналитики. Восстановление имеет страховочную копию и откат. `.ovbackup` — копия SQLite.
- Viewer ZIP и автономный HTML создаются в формате **4** из неизменяемой `klinvekt-report-model` v1. Перед вычислением идентификаторов страниц renderer очищает HTML тем же модулем `build/viewer-html-sanitizer.js`, который сервис повторно применяет при проверке. Модель содержит уникальные страницы, привязки к врачам и SHA-256-ревизию; одинаковая сводная страница хранится и шифруется один раз, а получателю через его PIN выдаются только ключи разрешённых страниц. До PBKDF2/scrypt и сборки результата сервис рассчитывает верхнюю оценку размера и отклоняет заведомо слишком большую публикацию. ZIP форматов 2 и 3 импортируются новым Viewer; ранее выпущенные автономные HTML форматов 2 и 3 самодостаточны, а код нового автономного Viewer также сохраняет их контракт чтения.
- Установленный Viewer хранит неизменяемые страницы/выпуски отдельно от метаданных. Новый каталог полностью собирается в `_viewer/generations/<generationId>`, затем одним атомарным обновлением `_viewer/current.json` становится активным; при отказе до переключения читается прежнее поколение. Старый корневой каталог без указателя остаётся читаемым. По решению пользователя автоматическое удаление прежних выпусков и поколений не выполняется.
- Пресет полной публикации выбирает все доступные периоды, все три типа страниц, всех включённых получателей и полный состав управляемых отделений; включённый заведующий может не иметь собственной выработки, если у его отделения есть отчёты. Действующие PIN врачей берутся из SQLite без изменения; администраторский PIN для автономного HTML вводится повторно, потому что открытым текстом не хранится. Совместимость сохранять.
- `.kvmobile` — публикация v1; `.kvmobilebundle` — пакет v2, сервер также читает v1. В v2 каждый отчёт хранится один раз; получатель получает разрешения на свой отчёт и отчёты управляемых отделений. Назначения и PIN берутся из SQLite. Заведующий может не иметь собственной выработки.
- Мобильный экспорт включает до шести последних периодов с персональной «Выработкой». Необязательные деревья, графики, история KPI и комментарии совместимы со старыми публикациями. Пропуски не заменять нулями.

## Правила расчётов, которые легко случайно нарушить

- Личный дашборд создаёт только «Выработка» (`doctorHasDashboardData`). Нулевая выработка допустима; общий отчёт или ручная оценка сами по себе не создают дашборд.
- Сводные отношения `aggregateDeptMonth` рассчитываются только при сопоставимых данных всех включённых врачей. `coverage[metric]` содержит `coveredDoctors`, `expectedDoctors`, `complete`, `missingDoctors`; неполные отношения и месячные пациенты/визиты остаются `null`, UI и новые отчёты показывают пояснение. Расписание суммирует минуты; среднее отдельных процентов без минут не подставляется. Курсовое требует одинакового окна; групповые доли первичной базы требуют одинаковых окон у всех врачей. Персональные формулы не изменены.
- Сводная база объединяет пациентов по ID, при отсутствии ID — по нормализованному ФИО; строки без идентификатора и имени остаются отдельными. Разные ID не объединяются по совпавшему имени. Визиты и выручка складываются как отношения пациент–врач, группы объединяются и могут пересекаться; сводка не выдаётся за непересекающееся разбиение единой базы. Отчёт отделения использует тот же агрегат с точным списком своих врачей.
- Выручка выполненных перенаправлений берётся из «Выработки». «Назначения» дают количества и конверсию. Индивидуальное `overrides[name].referralIncluded` имеет приоритет над общим правилом учёта выручки.
- Admin В4 и новые публикации Viewer: `adminClientBaseSummary → partitionClientBase`, только точное окно **36 месяцев**, четыре непересекающиеся группы. Viewer сохраняет тот же блок, диаграмму и пороги Admin, добавляя PIN-защищённый реестр пациентов; методика помечена `partition-v1-36m`. Настройки `clientBasePartition`: `loyalVisits`, `activeM`, `lostM`, `lostAnyVisits`. В настройках четыре строки с визитами и сроком; `syncClientBasePartitionControls` связывает общие границы. Порог лояльности общий; максимум визитов новых/потерянных на единицу меньше. Интерфейс не вводит независимых алгоритмов для строк.
- `kbSummary` и прежние нормативы B–F по-прежнему управляют KPI, баллами, сводками и мобильными публикациями; прежние Viewer-пакеты самодостаточны и сохраняют старое представление. Эти группы могут пересекаться. Прежняя таблица пяти групп убрана из настроек; сохранённые параметры B–F не изменяются при сохранении четырёх групп. Не заменять формулы KPI и мобильной публикации новым разбиением без отдельного решения о формулах и совместимости.
- Admin `adminDoctorDynamics` показывает январь–выбранный месяц; `computeDoctorDynamics` используется другими потребителями для шестимесячной динамики. История карточек — `doctorMetricDynamics`. Эти пути пока не полностью унифицированы: известные расхождения описаны в обзоре архитектуры.
- `parseProstoy` читает фактическое время из подколонки «Факт», а не «Норма». `parseHoursMin` сохраняет минуты; месяц импорта определяется периодом внутри файла.

## Границы продуктов

- Admin доверяет локальной учётной записи Windows. Renderer обращается к сервисам только через проверяемый IPC; `contextIsolation` включён.
- Viewer не обращается к рабочей SQLite. PIN врача — 4 цифры, Admin PIN Viewer — 6–12. Санитизацию HTML и ограничения страниц не ослаблять. Реестр пациентов допускается только в защищённых личных отчётах Viewer.
- Мобильные отчёты не содержат реестра пациентов и сырых выгрузок. Локальный `.kvmobile` не зашифрован; серверный пакет передаётся администратору. Black Hole использует `PORTAL`/`NAMED_USERS`, gateway identity и сессии. Новая загрузка пакета отзывает прежние сессии.
- Мобильные сессии хранятся в памяти одного процесса. Очистка использует настоящее время; при лимите 2000 новый вход получает HTTP 503 с `Retry-After`, действующие сессии и незавершённые загрузки не удаляются. Повторный вход заменяет только сессии той же учётной записи в том же портале. После перезапуска нужен новый вход; сохранённый пакет остаётся доступным.
- PWA кэширует оболочку, не серверные отчёты. Для iPhone сохранять flex-оболочку `100dvh`, скролл `main#reportScroller`, поля от 16 px и явное закрытие установочного диалога. После изменений ресурсов синхронно обновлять версии CSS/JS и кэш service worker; проверять WebKit, узкий/горизонтальный экран и iframe.

## Сборка и проверки

`index.html` — отслеживаемый результат `pnpm run assemble`. **Не редактировать вручную.** После правок `build/*` пересобрать и включить его в изменение. Библиотеки XLSX, JSZip, Chart.js, html2canvas и jsPDF, а также общая очистка Viewer HTML встроены из локальных файлов.

| Команда | Когда нужна |
|---|---|
| `pnpm install --frozen-lockfile` | Подготовка зависимостей |
| `pnpm run assemble` | Изменились исходники Admin в `build/` |
| `pnpm test` | Любое изменение кода |
| `pnpm run test:smoke` | UI, рендеринг, публикации; скрытый Electron, синтетическая база |
| `pnpm run test:pdf` | PDF; Chromium `printToPDF`, затем визуальная проверка |
| `pnpm run audit:repo` | Состав репозитория и документация |
| `pnpm run dist:all` | Локальная сборка установщиков Admin и Viewer |
| `pnpm run start:mobile-pilot` / `start:mobile-pilot:lan` | Локальная PWA, порт 4173; сервер — `scripts/serve-mobile-pilot.cjs` |
| `pnpm run start:mobile-server:local` | Локальный серверный сценарий, порт 3000 |
| `pnpm run build:mobile-server` | Деплой-каталог `tmp/klinvekt-mobile-server/` |

Smoke запускать последовательно, дожидаться кода завершения. Результат — `tmp/smoke-result.json`, журнал — `tmp/electron-smoke/<pid>/smoke.log`, предел — 120 секунд. Не отделять `electron.exe` от запускающей консоли. Не заменять PDF огромным canvas: длинные отчёты должны сохранять читаемый текст и разбиение страниц.

Данные клиники, базы, выгрузки, backup, установщики, результаты и секреты не добавлять в Git. При изменении состава исходников синхронно обновлять `.gitignore` и `scripts/audit-repository.ps1`. После одной документации достаточно audit и проверки ссылок.

CI проверяет `main` и PR. Release workflow проверяет совпадение тега с версией, запускает тесты и сборки. Артефакты релиза: Admin EXE, `.blockmap`, `latest.yml`, Viewer EXE, `KlinVekt-Mobile-Server-<version>.zip`. Рабочий мобильный пакет туда не входит. Автообновление есть у Admin; Viewer обновляется отдельным установщиком.

## Дополнительные документы

- [Обзор архитектуры: быстродействие, расчёты, мобильный перенос](ARCHITECTURE_REVIEW.md) — подтверждённые проблемы, замеры и порядок исправлений на дату проверки.
- [Выпуск и обновление](ОБНОВЛЕНИЕ.md) — релизная документация и история версий.
- [Мобильный пилот](МОБИЛЬНЫЙ_ПИЛОТ.md) — Black Hole, PWA, импорт публикаций.
- [Инструкция пользователя](ИНСТРУКЦИЯ.md), [README](../README.md) — эксплуатация.
