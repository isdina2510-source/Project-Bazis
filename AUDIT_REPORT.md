# Аудит обработки ошибок и скрытых фолбэков — «Базис» (сайт + CRM)

Дата аудита: 09.10.2026. Аудит проводился в режиме «только чтение»: код проекта не менялся, создан только этот отчёт.
Редакция отчёта: полная, переписана после двух задач исправлений. Номера строк указаны по коду на коммите `cfbf64c`, кроме статусов находок пакетов 1–5 (там — после коммита соответствующего пакета; в `server.js` строки после 30 сдвинулись примерно на +12…+40, в `documents/index.js` после 20 — на +3…+45).

| Коммит | Что сделано |
|---|---|
| `d7f0347` baseline before fixes | Первый коммит проекта. Вошли исправление CRIT-01 (контакт Telegram) и подсветка выбранной кнопки чата |
| `cfbf64c` notify | Модуль `notify/` — оповещения в Telegram о заказах, заявках, ошибках 500, запуске/падении сервера, неудачном бэкапе, офлайн-режиме ИИ |
| `34ed69e` fix: security & config (audit pack 1) | Пакет 1: MED-01, MED-02, MED-05, LOW-08, LOW-21 — проверка настроек `.env`, убран обход антиспама для админа, предупреждения `check:prod`. Номера строк в статусах этих находок — после этого коммита |
| `bc50e56` fix: documents (audit pack 2) | Пакет 2: HIGH-05, MED-04, MED-10, LOW-20, FB-14 и поправка к LOW-21 — печать и подпись, реквизиты перед выпуском, журнал отправок, sharp, логотип. Номера строк в статусах этих находок — после этого коммита |
| `f32300a` test: timing margin for AI retry-deadline test | Нестабильный тест ИИ (падал при сборке в Docker) — увеличен запас времени, код приложения не менялся |
| `dbb4f25` fix: frontend errors & data truth (audit pack 3) | Пакет 3: HIGH-02, HIGH-06, HIGH-07, MED-07, MED-11, LOW-13, LOW-15, LOW-16, часть HIGH-09 и HIGH-10, поправка к LOW-21 — выключатель медиасайта `MEDIA_SITE_ENABLED`, Error Boundary, отправка ошибок фронтенда на сервер, честные состояния загрузки в админке и на витрине. Номера строк в статусах этих находок — после этого коммита |
| `64ec401` fix: server errors & health (audit pack 4) | Пакет 4: HIGH-03, LOW-05, MED-15, MED-12, MED-06, LOW-07, LOW-06, LOW-18 — ошибки сохранения товара и чтения статики → 500 с журналом, `GET /api/health` и перезапуск unhealthy-контейнера, `unhandledRejection` как падение, пауза после 5 падений, журнал в файл с повтором, путь без query в журнале, штатная остановка службы Windows. Номера строк в статусах этих находок — после этого коммита |
| fix: validation & frontend (audit pack 5) | Пакет 5: LOW-02, LOW-03, LOW-04, MED-14, LOW-14, LOW-12, LOW-01, MED-13 — 400 вместо молчаливой нормализации валюты, раздела, статуса и количества; товар без фото с нейтральной заглушкой; разные сообщения «формат» / «размер» фото; `i18n-check` в `npm test` и сборке; журнал неудачного удаления файла; заявки из ИИ-чата досылаются из `localStorage`. Номера строк в статусах этих находок — после этого коммита |

Главный вопрос аудита: **может ли что-то сломаться так, что ни пользователь, ни владелец сайта об этом не узнают?**
Короткий ответ на момент аудита: **да.** Сервер в целом написан аккуратно: есть глобальный обработчик, транзакции, таймауты, повторы, логирование. Но у проекта не было ни одного канала, по которому сбой дошёл бы до человека: ни уведомлений о новых заказах и заявках, ни мониторинга ошибок, ни оповещений о проваленных резервных копиях. Ошибки писались только в локальные файлы журналов, которые никто не читает. Кроме того, в коде витрины осталась заглушка контакта Telegram, а в портфолио медиасайта — стоковые фото. После коммита `cfbf64c` канал оповещений появился, но **включится только после того, как в `.env` будут заданы `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID`**.

---

## 1. Сводка

**Стек.** Node.js ≥ 22.13, встроенный `http` без фреймворка (`server.js`), SQLite через встроенный `node:sqlite` (синхронный `DatabaseSync`, WAL). Фронтенд — React 19, react-router-dom 7, Vite 8: две витрины («Базис» и «Базис Медиа», `shared/sites.json`) и SPA админки/CRM (`admin.html`). ИИ-консультант — OpenAI-совместимый API через `fetch`. PDF — pdfmake в worker-потоке, картинки — sharp, почта — nodemailer (SMTP), Telegram Bot API. Запуск: Windows (`run-server.bat`, задача планировщика), Docker Compose (текущий рабочий режим — `data/DATA-MOVED.txt` есть), systemd (шаблон).

**Проверено файлов с кодом при аудите: 165** (около 22 100 строк): 97 `.js`, 42 `.jsx`, 6 `.mjs`, 5 `.ps1`, 10 `.bat`, `Dockerfile`, `docker-compose.yml`, `deploy/bazis.service`, 2 шаблона прокси (`deploy/*.template`). Из них 17 файлов тестов. Сейчас в репозитории 173 файла с кодом: добавлены 2 файла модуля `notify/` (написаны в рамках исправлений) и 6 файлов резервного копирования вне Docker, появившихся после аудита (см. раздел 8 «Покрытие»).

**Находки по уровням:**

| Уровень | Всего | Исправлено | Частично устранено (статус «открыта») | Открыто полностью |
|---|---|---|---|---|
| CRITICAL | 1 | 1 (CRIT-01) | 0 | 0 |
| HIGH | 10 | 6 (HIGH-01, HIGH-02, HIGH-03, HIGH-05, HIGH-06, HIGH-07) | 4 (HIGH-04, HIGH-08, HIGH-09, HIGH-10) | 0 |
| MEDIUM | 15 | 12 (MED-01, MED-02, MED-04, MED-05, MED-06, MED-07, MED-10, MED-11, MED-12, MED-13, MED-14, MED-15) | 0 | 3 |
| LOW | 22 | 16 (LOW-01, LOW-02, LOW-03, LOW-04, LOW-05, LOW-06, LOW-07, LOW-08, LOW-12, LOW-13, LOW-14, LOW-15, LOW-16, LOW-18, LOW-20, LOW-21) | 1 (LOW-22) | 5 |
| **Итого** | **48** | **35** | **5** | **8** |

**Намеренные (легитимные) фолбэки:** в прежней редакции — таблица из 30 строк, 7 из них объединяли несколько мест в коде. В этой редакции каждое место описано отдельно: **43 фолбэка** (FB-01 … FB-43), ни одна из 30 прежних строк не потеряна — у каждого фолбэка указан номер строки прежней таблицы.

**Топ-5 самых опасных проблем:**

1. **[CRIT-01] — исправлена.** Заглушка `CONTACT_TELEGRAM = "bazis"` вела клиентов с заказами и персональными данными на чужой аккаунт `t.me/bazis`. Заменена на `Dinara_888888`, пересобрано и развёрнуто в Docker.
2. **[HIGH-01] — исправлена в коде, ждёт настроек.** О новых заказах и заявках никто не уведомлялся. Теперь `notifier.order()` шлёт сообщение в Telegram сразу после сохранения. Пока в `.env` нет `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID`, оповещения выключены (в журнале при старте: «Оповещения: выключены»).
3. **[HIGH-10] — открыта, частично устранена.** Нет мониторинга ошибок. Сервер теперь шлёт в Telegram ошибки 500, падения и запуски; с пакета 3 туда же приходят ошибки фронтенда (`POST /api/client-errors`). Sentry нет.
4. **[HIGH-04] — открыта, частично устранена.** Неудачная резервная копия была видна только в журнале, копии лежали на том же диске. Теперь провал серверного бэкапа шлёт оповещение, а `scripts/offsite-backup.ps1` (задача «Bazis Backup») делает копии вне Docker. Провал внешней копии по-прежнему виден только в `logs/backup.log` и `BACKUP-FAILED.txt`.
5. **[HIGH-02] — исправлена в пакете 3.** Во фронтенде не было ни одного Error Boundary: любое исключение при рендере превращало витрину или админку в пустую белую страницу. Теперь — экран ошибки с контактами (витрина) или «Обновить раздел» (админка) и отправка ошибки на сервер.

---

## 2. Карта проекта

### Точки входа

| Точка входа | Что делает |
|---|---|
| `server.js` | HTTP-сервер: статика обоих сайтов, `/api/orders`, `/api/clients`, `/api/products`, `/api/settings`, `/api/documents`, `/api/ai/*`, `/api/order-challenge`. На старте — создание хранилища, миграции, перенос картинок, оповещение о запуске, затем фоновый `localizeExternalImages` через 3 с |
| `src/main.jsx` | SPA витрины (оба сайта, сборка `vite build` и `vite build --mode media`) |
| `src/admin/main.jsx` → `AdminApp.jsx` | SPA админки/CRM |
| `ai/index.js` + `ai/http.js` | ИИ-ядро и его HTTP-обработчик (консультант, разбор вложений в worker-потоках) |
| `documents/index.js` + `documents/http.js` | Счета, акты, каталоги, PDF (worker), отправка по e-mail/Telegram |
| `notify/index.js` | Оповещения в Telegram (добавлен в `cfbf64c`) |
| `run-server.bat`, `start-site.bat`, `update-site.bat`, `install-service.bat`, `switch-*.bat` + `scripts/*.ps1` | Запуск, автоперезапуск, служба Windows, Docker-автозапуск, перенос данных |
| `backup-now.bat`, `install-backup.bat`, `restore-backup.bat`, `uninstall-backup.bat` + `scripts/offsite-backup.ps1`, `scripts/backup-snapshot.js` | Копии данных вне Docker (появились после аудита) |
| `Dockerfile`, `docker-compose.yml`, `deploy/bazis.service` | Контейнер (healthcheck `GET /api/ai`; с пакета 4 — `GET /api/health`), systemd |
| `scripts/images.mjs`, `scripts/fonts.mjs`, `scripts/i18n-*.mjs`, `scripts/deploy-config.mjs`, `scripts/db-check.js` | Сборочные и сервисные скрипты |

### Внешние интеграции

| Интеграция | Где | Таймаут / повторы |
|---|---|---|
| OpenAI-совместимый API (`BAZIS_AI_URL`, по умолчанию `api.openai.com`) | `ai/providers/openai.js`, `ai/core.js` | Таймаут, повторы, circuit breaker, суточный бюджет токенов |
| SMTP (nodemailer) | `documents/send.js` | Таймауты соединения заданы |
| Telegram Bot API: `sendDocument` (PDF) и `sendMessage` (оповещения) | `documents/send.js`, `notify/index.js` | 30 с для документов, 15 с для текста; ошибка оповещения только пишется в журнал |
| Загрузка внешних картинок товаров (unsplash и др.) | `security/remote-image.js`, `documents/images.js` | 10–15 с, лимит размера |
| WhatsApp / Telegram (deeplink `wa.me`, `t.me`) | `src/lib/catalog.js`, `src/lib/messages.js` | — (ссылки в браузере) |
| CDN unsplash (картинки на витрине) | `src/lib/images.js`, `src/content/portfolio.js` | — |

**Платежей, вебхуков, очередей нет.** Фоновые задачи: `setInterval(backup)` раз в 6 часов (`db/store.js:1372`), миграции и перенос картинок при старте, задачи планировщика Windows (`Bazis Site`, `Bazis Docker`, `Bazis Docker Watchdog`, `Bazis Backup`).

### Хранилище

- `data/bazis.db` (SQLite, WAL). Транзакции через `store.tx()` (`BEGIN IMMEDIATE` / `ROLLBACK`). На старте `PRAGMA quick_check`, миграции схемы с предварительной копией `VACUUM INTO`.
- `data/backups` — ежедневные копии, хранятся 14 штук (в том же Docker-томе, что и база).
- Внешние копии `scripts/offsite-backup.ps1` — папки `bazis-<дата>` с `manifest.json` (SHA-256 каждого файла), хранятся 30 штук, по умолчанию на другом диске или в «Документах».
- `data/documents` — кэш PDF, `data/company` — печать и подпись, `images/uploads` — фото товаров, `data/notify-state.json` — время последних оповещений.

### Версионный контроль

На момент аудита каталог не был git-репозиторием. Сейчас — репозиторий на ветке `main`, два коммита (`d7f0347`, `cfbf64c`). `.gitignore` исключает `.env`, базу, бэкапы, журналы, `node_modules`, сборки. Удалённого репозитория нет.

---

## 3. Глобальная обработка ошибок

| Механизм | Где | Оценка |
|---|---|---|
| Глобальный `try/catch` HTTP-запроса | `server.js:1769-1806` | ✅ 413 / 400 / 503 (повреждённая база) / 500 с `requestId`. Стек клиенту не утекает. Ошибка пишется в журнал с методом и URL; с `cfbf64c` — ещё и `notifier.serverError` (путь без query, текст без телефонов, e-mail и секретов, не чаще раза в 10 мин) и `notifier.alert("db_corrupt")` |
| `uncaughtException` | `server.js:1909-1921` | ✅ Закрывает базу, оповещает (`notifier.failed` + `flush(3000)`), `exit(1)`; `run-server.bat` / Docker / systemd перезапускают процесс |
| `unhandledRejection` | `server.js:1901-1907` | ⚠ Пишет в журнал и с `cfbf64c` оповещает, но процесс работает дальше в неизвестном состоянии (MED-15; исправлена в пакете 4 — как `uncaughtException`) |
| Ошибки старта (база, миграции) | `server.js:1834-1839` | ⚠ `console.error(err.message)` без стека, затем цикл перезапусков раз в 5 с. С `cfbf64c` — оповещение не чаще раза в 10 мин и причина в сообщении о следующем запуске (MED-15; исправлена в пакете 4 — стек и пауза после 5 падений за 2 мин) |
| Журнал в файл | `logging/file-log.js` | ⚠ Подменяет `console.*`, пишет `logs/server-YYYY-MM-DD.log` (14 дней). При первой ошибке записи отключается навсегда (MED-06; исправлена в пакете 4 — повтор через 5 мин и в новый день) |
| Внешний мониторинг (Sentry и т.п.) | — | ❌ Нет. Есть только Telegram-оповещения сервера (HIGH-10) |
| Метрики | `ai/plugins/metrics.js` | ⚠ Только в памяти и только для ИИ; при перезапуске теряются; в админке не показываются |
| Error Boundary во фронтенде | — | ❌ Нет ни в витрине, ни в админке (HIGH-02; исправлена в пакете 3) |
| Обработка ошибок API во фронтенде | `src/lib/api.js`, `src/lib/orders-db.js` | ✅ Ошибки разбираются в коды, в корзине и форме контактов пользователю показывается сообщение |
| Healthcheck | `Dockerfile:50-51` | ⚠ Проверяет только, что HTTP отвечает на `/api/ai` — не базу. Статус `unhealthy` никто не обрабатывает (MED-12; исправлена в пакете 4) |
| Оповещения | `notify/index.js` | ✅ Очередь, антиспам 10 мин по ключу (состояние в файле), сбой Telegram → только `log.warn`. ⚠ Выключены, пока в `.env` нет `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` |

---

## 4. Находки

Формат каждой находки: ID и серьёзность, файл и строки, категория, фрагмент кода, сценарий сбоя, рекомендация, уверенность, статус.

### [CRIT-01] [CRITICAL] Заглушка контакта Telegram в продакшене: заказы и данные клиентов могли уходить постороннему аккаунту

- **Файл:** `src/lib/catalog.js:19-20`, `src/lib/catalog.js:203-209`; используется в `src/components/CartDrawer.jsx:118`, `src/components/CartDrawer.jsx:163`, `src/components/CartDrawer.jsx:171`, `src/components/ContactSection.jsx:144`, `src/chat/ChatWidget.jsx:525`
- **Категория:** заглушка / тестовые данные в проде
- **Код (до исправления):**

```js
/** Username без @ — замените на реальный аккаунт Telegram */
export const CONTACT_TELEGRAM = "bazis";
// ...
export function getTelegramUsername() {
  return normalizeTelegramUsername(CONTACT_TELEGRAM) || "bazis";
}
```

- **Код (сейчас):**

```js
/** Username Telegram без @ */
export const CONTACT_TELEGRAM = "Dinara_888888";
// ...
export function getTelegramUsername() {
  return normalizeTelegramUsername(CONTACT_TELEGRAM);
}
```

```js
// CartDrawer.jsx:118, 163, 171
const tgHref = getTelegramProfileUrl();
const url = channel === "telegram" ? tgHref : waHref;
const copyPromise = channel === "telegram" ? copyText(orderMessage) : null;
```

- **Сценарий сбоя (до исправления):** клиент выбирает «Оформить в Telegram». Текст заказа с его именем, телефоном и составом копируется в буфер, открывается `t.me/bazis`. Аккаунт `@bazis` принадлежит постороннему человеку (на скриншоте владельца — «Boris B», Москва). Клиент отправлял ему заказ и персональные данные, ждал ответа и не получал его. Владелец видел заказ в CRM (он сохраняется до перехода), но не знал, что клиент написал не туда. `npm run check:prod` контакты не проверяет.
- **Рекомендация:** заменить на реальный username (сделано). Дальше — вынести контакты в `shared/*.json` или в настройки компании и добавить в `productionProblems()` проверку на заглушку (проверка добавлена в пакете 1, см. LOW-21; вынос контактов в настройки не сделан).
- **Уверенность:** высокая (владелец подтвердил, что `@bazis` — чужой аккаунт).
- **Статус: исправлена.** Что изменено: в `src/lib/catalog.js` строка 19 — комментарий «замените на реальный аккаунт» заменён на «Username Telegram без @»; строка 20 — значение `"bazis"` заменено на `"Dinara_888888"`; строка 204 — убран запасной вариант `|| "bazis"`, чтобы заглушка не могла вернуться при пустом значении. Изменение вошло в коммит `d7f0347`. Сайт пересобран (`docker compose up -d --build`), в контейнере `project-bazis-1` в `dist/assets/products-api-*.js` и `dist-media/assets/main-*.js` проверено наличие `Dinara_888888` и отсутствие `t.me/bazis`.

---

### [HIGH-01] [HIGH] Не было уведомлений о новых заказах и заявках — они молча копились в CRM

- **Файл:** `server.js:1113-1168` (создание заказа), `server.js:1163-1166` (оповещение), `notify/index.js:45-71`, `notify/index.js:145-148`, `documents/send.js` (`sendTelegramText`)
- **Категория:** мониторинг / сценарий «новый заказ»
- **Код (до исправления):**

```js
    const result = withStockErrors(() => store.tx(() => {
      if (store.orders.exists(newOrderId)) return { status: 200, body: { id: newOrderId, duplicate: true } };
      // ... сборка заказа ...
      return { status: 201, body: store.orders.insert(created) };
    }));
    if (result.status === 201) orderGuard.accepted({ phone: limitKey, fingerprint, orderId: newOrderId });
    sendJson(res, result.status, result.body, req);
```

- **Код (сейчас):**

```js
    if (result.status === 201) {
      orderGuard.accepted({ phone: limitKey, fingerprint, orderId: newOrderId });
      notifier.order(result.body);
    }
    sendJson(res, result.status, result.body, req);
```

- **Сценарий сбоя (до исправления):** заявка с формы «Контакты» (`channel: "site"`) и заявка из ИИ-чата (`leadSource: "chat"`) приходят только в базу. Клиент никому не пишет в мессенджер — он ждёт звонка. Значок новых заявок (`src/admin/Dashboard.jsx:65-72`) виден, только если админка открыта. Telegram-бот был настроен только для документов. Если менеджер день не открывает CRM, клиенты теряются.
- **Рекомендация:** после успешной вставки отправлять уведомление в Telegram, не блокируя ответ клиенту, ошибку отправки только логировать (сделано).
- **Уверенность:** высокая.
- **Статус: исправлена в коде (коммит `cfbf64c`), заработает после настройки.** Что изменено: `notifier.order()` вызывается после каждого принятого заказа или заявки (тип, имя, телефон, состав или направление и комментарий, код обращения из чата, ссылка на CRM). Отправка идёт в фоне по очереди, сбой Telegram пишется в журнал как «Оповещение в Telegram не отправлено: …» и не влияет на сохранение заказа. Нужно добавить в `.env` переменные `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID`, иначе оповещения выключены.

---

### [HIGH-02] [HIGH] Нет Error Boundary — ошибка рендера даёт белую страницу

- **Файл:** `src/main.jsx:28-43`, `src/admin/main.jsx:11-15`
- **Категория:** фронтенд / необработанные ошибки
- **Код:**

```jsx
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <StoreProvider>
        <Routes>
          <Route path=":lang" element={<LangGate />}>
            {pages}
          </Route>
```

```jsx
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>
);
```

- **Сценарий сбоя:** любой `throw` при рендере (товар с неожиданной структурой из `localStorage`, `null` вместо массива в ответе API, ошибка `IntlMessageFormat` из-за битой строки перевода) размонтирует всё дерево React. Посетитель видит пустую страницу без текста и кнопок, менеджер — пустую админку. Ошибка остаётся в консоли браузера и никуда не отправляется. Поиск `ErrorBoundary|componentDidCatch|getDerivedStateFromError` по `src/` ничего не находит.
- **Рекомендация:** обернуть `<Routes>` и `<AdminApp>` в Error Boundary с сообщением «Что-то пошло не так, обновите страницу» и контактами; отправлять ошибку на сервер (например, `POST /api/client-errors` → журнал и `notifier.alert`) или в Sentry.
- **Уверенность:** высокая.
- **Статус: исправлена** (коммит «fix: frontend errors & data truth (audit pack 3)»). Что изменено:
  - `src/components/ErrorBoundary.jsx` — общий Error Boundary: ловит ошибку рендера, отправляет её на сервер, показывает запасной экран; `reset` перемонтирует содержимое.
  - Витрина: `src/StorefrontApp.jsx:26` — `ErrorBoundary` вокруг `StoreProvider` и `Routes`; `src/components/StoreErrorScreen.jsx` — «Что-то пошло не так», кнопка «Обновить страницу», ссылки WhatsApp и Telegram (`ContactLinks.jsx`); тексты в `ru.json` и `kk.json` (`errors.screen.*`, `errors.contacts.*`).
  - Админка: `src/admin/AdminApp.jsx:33` — вся админка в `AdminErrorBoundary`; `src/admin/Dashboard.jsx:190` — каждый раздел в своём `AdminErrorBoundary` (ошибка одного раздела не гасит меню и остальные); экран — «Раздел не открылся из-за ошибки», текст ошибки, кнопка «Обновить раздел».
  - Ошибка загрузки чанка после обновления сайта (`src/lib/chunk-errors.js:14`) — одна автоматическая перезагрузка страницы, повтор не раньше чем через 5 минут (метка в `sessionStorage`), чтобы не было цикла.
  - `src/lib/client-errors.js:51` — отправка ошибок из Error Boundary, `window.onerror`, `unhandledrejection` и `vite:preloadError`: одна отправка на одинаковую ошибку, не больше 5 за сессию; `installClientErrorReporting()` в `src/main.jsx:10` и `src/admin/main.jsx:10`.
  - Сервер: `POST /api/client-errors` (`notify/client-errors.js`, маршрут `server.js:1584`) — публичный, 10 запросов в минуту с одного IP, тело до 8 КБ, только JSON; текст и стек чистятся `scrub` (телефоны, e-mail, токены), из адресов убирается query, id в пути заменяются на `:id`; ответ 204 без тела. Пишет `console.error("[client-error] …")` без IP и `notifier.alert` с антиспамом 10 минут по ключу «сайт + текст ошибки».
  - Тесты: `src/StorefrontApp.test.jsx`, `src/admin/AdminApp.test.jsx`, `src/admin/Dashboard.test.jsx` (ошибка раздела), `src/lib/client-errors.test.js`, `notify/test/client-errors.test.js`, `test/server-client-errors.test.js`. До исправления падали.

---

### [HIGH-03] [HIGH] Ошибки сервера при сохранении товара маскируются под «Некорректные данные товара» (400) и не логируются

- **Файл:** `server.js:561-576`; вызовы — `server.js:1377-1384`, `server.js:1411-1417`, `server.js:1436-1442`; источник сбоя — `server.js:410-414`
- **Категория:** поглощённая ошибка / неверный HTTP-статус
- **Код:**

```js
function sendProductError(res, err, req) {
  const code = (err && err.code) || "invalid_product";
  sendJson(res, productErrorStatus(code), {
    error: code,
    message: PRODUCT_ERROR_MESSAGES[code] || "Некорректные данные товара",
  }, req);
}
```

```js
    try {
      fetched = await localizeProductImage(body, null);
      product = buildProductFromBody(body, null);
    } catch (err) {
      deleteUploadIfOwned(fetched);
      sendProductError(res, err, req);
      return;
    }
```

```js
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const fileName = "img_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8) + ext;
  const full = path.join(UPLOADS_DIR, fileName);
  fs.writeFileSync(full, buffer);
```

- **Сценарий сбоя:** закончилось место на диске (`ENOSPC`), нет прав на `images/uploads` (`EACCES`/`EPERM` — типично после переноса между Docker и Windows или запуска службы от SYSTEM), или в `buildProductFromBody` / `localizeProductImage` ошибка программиста (`TypeError`). У таких ошибок `err.code` — `"ENOSPC"` / `"EACCES"` или `undefined`; `productErrorStatus` для всего неизвестного возвращает **400**, текст — «Некорректные данные товара». В журнал не попадает ничего, оповещение `notifier.serverError` тоже не срабатывает (до глобального обработчика ошибка не доходит). Менеджер перепроверяет поля, пробует снова и думает, что виноват он.
- **Рекомендация:** в `sendProductError` различать известные коды валидации (ключи `PRODUCT_ERROR_MESSAGES`) и всё остальное; неизвестное — `throw err` в глобальный обработчик (500, журнал с `requestId`, оповещение).
- **Уверенность:** высокая.
- **Статус: исправлена** (коммит «fix: server errors & health (audit pack 4)»). Что изменено:
  - `server.js:625-648` — таблица `PRODUCT_ERROR_STATUS` вместо `productErrorStatus`. 4xx отдаётся только для 11 кодов, которые реально бросает код: проверка полей в `buildProductFromBody` (`title_required`, `description_required`, `invalid_price`, `invalid_stock`), картинка в `saveImageBuffer` / `resolveProductImage` (`invalid_image`, `image_too_large`), загрузка по ссылке в `security/remote-image.js` (`invalid_image_url`, `image_host_blocked`, `image_fetch_failed`, `image_too_large`, `invalid_image`), база (`stock_held`, `product_reserved`). Все 11 есть в `PRODUCT_ERROR_MESSAGES`. Любой другой код (`ENOSPC`, `EACCES`, `EPERM`, `ENOTDIR`, `TypeError` без кода) `sendProductError` пробрасывает в глобальный обработчик: 500, `console.error` с `requestId`, `notifier.serverError`.
  - Проверены все вызовы: создание (`POST /api/products`), изменение и замена фото (`PATCH /api/products/:id` — загрузка по ссылке, сборка товара, `stock_held` при сохранении), удаление (`product_reserved`). Во всех местах загруженный в этом запросе файл удаляется до проброса ошибки.
  - `server.js:466-474` — если запись картинки упала на середине (`ENOSPC`), недописанный файл удаляется: сирот в `images/uploads` не остаётся.
  - Тест: `test/server-errors.test.js` — «HIGH-03 и LOW-07: папка загрузок недоступна для записи…» (создание и замена фото → 500 с `requestId`, строки в журнале, файлов `img_*` нет, товар не изменился; ошибка валидации по-прежнему 400). До исправления падал (было 400 «Некорректные данные товара»).

---

### [HIGH-04] [HIGH] Провал резервного копирования был виден только в журнале; копии на том же диске

- **Файл:** `db/store.js:1349-1373`, `server.js:1829`, `scripts/offsite-backup.ps1:205-235`
- **Категория:** фоновые задачи / мониторинг
- **Код:**

```js
  function backup() {
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      // ...
        db.prepare("VACUUM INTO ?").run(tmp);
        fs.renameSync(tmp, target);
      // ...
    } catch (err) {
      log.error("Не удалось сделать резервную копию базы:", err.message);
      if (typeof onBackupError === "function") onBackupError(err);
    }
  }
```

```powershell
  } catch {
    Write-Log "ОШИБКА копии: $($_.Exception.Message)"
    foreach ($dir in $Targets) { Write-FailedFlag $dir $_.Exception.Message }
    Remove-Item -Recurse -Force -LiteralPath $staging -ErrorAction SilentlyContinue
    return $false
  }
```

- **Сценарий сбоя:** диск заполнен, папка заблокирована антивирусом или `VACUUM INTO` падает. Раньше каждые 6 часов в журнал писалась одна строка, и никто её не видел. Копии `data/backups` лежат в том же Docker-томе, что и база: при `docker compose down -v`, сбросе Docker Desktop или отказе диска теряются и база, и все копии.
- **Рекомендация:** (1) уведомлять об ошибке бэкапа; (2) копировать бэкапы вне машины или хотя бы вне тома; (3) показывать дату последней успешной копии в админке и предупреждать, если копии больше 2 суток; (4) об ошибке внешней копии тоже уведомлять в Telegram.
- **Уверенность:** высокая.
- **Статус: открыта (частично устранена).** Сделано: (1) в `cfbf64c` добавлен `onBackupError` — провал серверного бэкапа шлёт оповещение «Не удалось сделать резервную копию базы» (`server.js:1829`), не чаще раза в 10 минут; (2) после аудита появился `scripts/offsite-backup.ps1` — ежедневная копия в 03:00 в папки Windows с проверкой SHA-256 (сделан не в рамках этого аудита). Остаётся: провал внешней копии виден только в `logs/backup.log` и файле `BACKUP-FAILED.txt` в папке копий (в Telegram не приходит); если папка копий на системном диске, от отказа диска она не спасает (скрипт об этом предупреждает при установке); в админке нет даты последней копии.

---

### [HIGH-05] [HIGH] Печать и подпись молча пропадают из счёта/акта, и PDF без них кэшируется навсегда

- **Файл:** `documents/index.js:111-118`, `documents/index.js:127-132`, `documents/index.js:299-318`; заглушка «М.П.» — `documents/templates/invoice.js:119`, `documents/templates/act.js:161`
- **Категория:** поглощённая ошибка / скрытый фолбэк
- **Код:**

```js
  function readCompanyAsset(fileName) {
    if (!fileName || !/^(stamp|signature)-[0-9a-f]{20}\.(png|jpg)$/.test(fileName)) return null;
    try {
      return fs.readFileSync(path.join(companyDir, fileName));
    } catch {
      return null;
    }
  }
```

```js
    try {
      buffer = await fs.promises.readFile(file);
    } catch {
      const snap = doc.snapshot;
      const assets = snap.assets || {};
      buffer = await renderer.render(doc.kind, {
        ...snap,
        logo: logo(),
        stamp: assetDataUrl(assets.stamp),
        signature: assetDataUrl(assets.signature),
```

```js
      await writeAtomic(file, buffer).catch((err) => log.warn("PDF: не удалось сохранить в кэш: " + err.message));
```

- **Сценарий сбоя:** после переноса данных (`switch-data.ps1`), восстановления из бэкапа без папки `data/company` или при ошибке прав файл печати не читается. Имя файла в настройках есть, а `readCompanyAsset` молча возвращает `null`. Счёт формируется с текстом «М.П.» вместо печати и без подписи. Этот PDF **записывается в кэш** `data/documents/<год>/<id>.pdf` и дальше отдаётся всегда, даже когда файл печати снова доступен. В журнале ничего нет. Клиент получает по e-mail счёт без печати, бухгалтерия его не принимает.
- **Рекомендация:** различать «печать не задана» (`fileName` пуст) и «печать задана, но не читается». Во втором случае — `log.error` и ошибка выпуска PDF (или хотя бы не кэшировать такой результат).
- **Уверенность:** высокая.
- **Статус: исправлена** (коммит «fix: documents (audit pack 2)»). Что изменено:
  - `documents/index.js:132-168` — новая `companyAsset(kind, fileName)`: имени файла в настройках нет → `null`, документ без печати/подписи допустим; имя задано, но файла нет, имя недопустимое или файл не PNG/JPEG → `log.error` с полным путём и причиной, `notifier.alert("company_asset:<вид>", …)` и ошибка `409 company_asset_unreadable` с текстом «Файл печати (подписи) не найден — загрузите его заново в разделе «Реквизиты»». `companyAssets()` проверяет обе картинки. Прежняя тихая `assetDataUrl` удалена; `readCompanyAsset` осталась только для предпросмотра в админке.
  - `documents/index.js:254-269` — `assertIssuable()` вызывается в `issueOne` **до** `store.documents.issue`: при нечитаемой печати номер не расходуется (и при выпуске, и при перевыпуске).
  - `documents/index.js:349-366` — `documentPdf` берёт картинки через `companyAssets(snap.assets)`: при ошибке PDF не собирается и в кэш `data/documents` ничего не пишется.
  - `server.js:1875` — модулю документов передаётся `notifier`.
  - Админка: `src/admin/OrderDocuments.jsx:180-186, 236-247` — при `company_asset_unreadable` показывается текст ошибки и кнопка «Открыть раздел «Реквизиты»» (`src/admin/Dashboard.jsx:153-155`, `src/admin/OrdersSection.jsx:54, 202, 251, 359` передают переход).
  - Тесты: `documents/test/documents.test.js` — «HIGH-05: печать задана, но файл пропал…» (409, номер не израсходован, путь в журнале, одно оповещение; после повторной загрузки счёт получает номер 1) и «HIGH-05: PDF с заданной, но нечитаемой подписью не собирается и не попадает в кэш». До исправления оба падали.
  - Кэш уже выпущенных PDF: проверено (только чтение) в рабочем контейнере 09.10.2026 — в базе один документ (счёт `2026-0001`), печать и подпись в настройках не заданы, в кэше один PDF. Без печати он собран законно, пересборка не нужна. Очистка кэша безопасна: `documentPdf` собирает документ заново из снимка в базе (номер, дата, реквизиты, позиции, имена файлов печати/подписи). Отличаться может только оформление: логотип берётся текущий, шаблоны — текущей версии, дата форматируется по текущему `DOCUMENTS_TZ`. Восстановление из внешней копии (`scripts/offsite-backup.ps1`) и так удаляет `data/documents`.

---

### [HIGH-06] [HIGH] Ошибка загрузки клиентов в CRM показывается как «клиентов нет»

- **Файл:** `src/admin/Dashboard.jsx:48-56`; отчёт — `src/admin/reports/build.js:271-273`
- **Категория:** фронтенд / ошибка выглядит как пустое состояние
- **Код:**

```jsx
  const loadClients = useCallback(async () => {
    try {
      setClients(await listClients());
    } catch (err) {
      if (isUnauthorized(err)) return;
      console.warn(err);
      setClients([]);
    }
  }, []);
```

- **Сценарий сбоя:** `GET /api/clients` вернул 500 или 503 (повреждённая база), либо пропала сеть. Вкладка «Клиенты» показывает пустой список, отчёт «Клиенты» строится только по заказам, без сохранённых карточек. Флага ошибки нет (у заказов он есть — `ordersError`, строки 29, 44). Менеджер может решить, что карточки клиентов удалены, и начать заводить их заново, создавая дубли.
- **Рекомендация:** завести `clientsError` по аналогии с `ordersError` и показывать «Не удалось загрузить клиентов — Повторить» вместо пустого состояния.
- **Уверенность:** высокая.
- **Статус: исправлена** (коммит «fix: frontend errors & data truth (audit pack 3)»). Что изменено: `src/admin/Dashboard.jsx:38` — флаг `clientsError`, при ошибке список клиентов не обнуляется; `src/admin/ClientsSection.jsx:90-93` — при ошибке вместо «Пока нет клиентов» баннер «Не удалось загрузить клиентов» с кнопкой «Повторить» (`src/admin/LoadErrorBanner.jsx`), список не показывается; `src/admin/ReportsSection.jsx:67` — в отчёте «Клиенты» предупреждение, что карточки не загружены и отчёт неполный, выгрузка в Excel/PDF заблокирована. Тесты: `src/admin/Dashboard.test.jsx`, `src/admin/ReportsSection.test.jsx`; до исправления падали.

---

### [HIGH-07] [HIGH] Ошибка загрузки товаров в админке — менеджер видит кэш или демо-каталог как настоящий

- **Файл:** `src/admin/Dashboard.jsx:31`, `src/admin/Dashboard.jsx:74-80`, `src/lib/products-api.js:14-28`
- **Категория:** маскирующий фолбэк / демо-данные
- **Код:**

```jsx
  const [products, setProducts] = useState(() => readCachedProducts());
  // ...
  const loadProducts = useCallback(async () => {
    try {
      setProducts(await fetchProducts());
    } catch {
      // сервер недоступен — показываем кэш
    }
  }, []);
```

```js
export function readCachedProducts() {
  for (const key of [PRODUCTS_CACHE_KEY, PRODUCTS_KEY]) {
    try {
      const raw = localStorage.getItem(key);
      // ...
    } catch {
      // битый кэш — игнорируем
    }
  }
  return DEFAULT_PRODUCTS.map(normalizeProduct);
}
```

- **Сценарий сбоя:** админка открыта на новом компьютере или в новом браузере (кэша нет), `GET /api/products` упал. В разделе «Товары» показывается встроенный демо-каталог `DEFAULT_PRODUCTS` с демо-ценами — без пометки. Если кэш есть, видны устаревшие цены и остатки. Менеджер редактирует «товар», которого нет в базе (получит 404), или принимает решения по старым остаткам.
- **Рекомендация:** в админке не использовать `DEFAULT_PRODUCTS` вообще. При ошибке загрузки показывать баннер «Данные не загружены (показана копия от …)» и блокировать редактирование.
- **Уверенность:** высокая.
- **Статус: исправлена** (коммит «fix: frontend errors & data truth (audit pack 3)»). Что изменено:
  - `src/lib/products-api.js:12-40` — `readCachedProducts()` возвращает `{ products, savedAt }` или `null` (демо-каталога больше нет), `writeCachedProducts` хранит копию вместе с датой (ключ `bazis_products_cache`; старый ключ без даты читается и удаляется), `fetchProducts` бросает `network` / `products_fetch_failed` / `invalid_response`. Экспорт `DEFAULT_PRODUCTS` удалён из `src/lib/catalog.js`.
  - `src/admin/Dashboard.jsx:40-43` — состояние `{ list, savedAt, status }`; создавать, редактировать и удалять товары можно только при `status === "ready"` («+ Новый товар» неактивна, окно товара не открывается).
  - `src/admin/ProductsSection.jsx` — ошибка с копией: баннер «Данные не загружены, показана копия от <дата>» и «Повторить», кнопки «Выбрать» и удаления выключены; ошибка без копии: «Не удалось загрузить товары» и «Повторить», список не показывается.
  - Тесты: `src/admin/Dashboard.test.jsx`, `src/lib/data-api.test.js`; до исправления падали.

---

### [HIGH-08] [HIGH] ИИ-консультант незаметно для владельца превращается в офлайн-бота: отозванный ключ, исчерпанная квота, ключ не задан

- **Файл:** `ai/providers/openai.js:62-70`, `ai/plugins/logger.js:13-18`, `src/chat/cloud.js:80`, `src/chat/cloud.js:94`; частичное исправление — `server.js:1745-1767`, `server.js:1881`
- **Категория:** внешний API / маскирующий фолбэк / мониторинг
- **Код:**

```js
    if (!res.ok) {
      const status = res.status >= 400 && res.status < 600 ? res.status : 502;
      throw upstreamError(status, raw.slice(0, 240), {
        retryable: RETRYABLE_STATUS.has(res.status),
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
        modelUnavailable: res.status === 404,
        notBilled: true,
      });
    }
```

```js
  if (res.status === 503 && data && data.error === "ai_not_configured") return null;
  // ...
  if (!data || !data.text) return null;
```

```js
function notifyAiError(err, req) {
  if (!(err instanceof AiError)) {
    notifier.serverError(req.method, req.url, err);
    return;
  }
  const reason = AI_OFFLINE_REASONS[err.code];
  if (!reason) return;
```

- **Сценарий сбоя:**
  1. Ключ OpenAI отозван или закончились деньги: апстрим отвечает 401/403/429 `insufficient_quota`. 401/403 не считаются повторяемыми и не размыкают circuit breaker. Каждый запрос даёт одну строку `console.warn` (`[ai] … error=ai_upstream_error`). Статус апстрима (401) **пробрасывается посетителю** как статус ответа нашего API. Посетитель видит «ИИ недоступен» и офлайн-ответ по ключевым словам. `GET /api/ai` продолжает сообщать `configured: true`; `/api/ai/_health` в админке нигде не показывается.
  2. После переезда на новый сервер `OPENAI_API_KEY` не задан: сервер отвечает `ai_not_configured`, `cloud.js:80` возвращает `null`, и виджет **без какого-либо сообщения** отвечает офлайн-ботом.
- **Рекомендация:** отображать 401/403 апстрима в 503 `ai_unavailable`; писать явный `console.error` «ключ ИИ недействителен / нет квоты»; оповещать владельца; показывать статус ИИ в админке; включить `OPENAI_API_KEY` в `check:prod`.
- **Уверенность:** средняя (поведение circuit breaker для 401 выведено из `RETRYABLE_STATUS` и логики ядра, на реальном ключе не проверялось).
- **Статус: открыта (частично устранена).** Сделано в `cfbf64c`: при `ai_not_configured`, `ai_budget_exceeded`, `ai_unavailable` и `ai_upstream_error` владелец получает оповещение «ИИ-консультант перешёл в офлайн-режим: <причина>» (для 401/403 — «провайдер отклонил ключ — проверьте OPENAI_API_KEY»), не чаще раза в 10 минут на каждую пару «код + HTTP-статус». Если ключ не задан, оповещение уходит при старте сервера. Остаётся: статус 401 по-прежнему пробрасывается посетителю; `cloud.js:80` по-прежнему молча переключает посетителя на офлайн-бота; статуса ИИ в админке нет; `check:prod` ключ не проверяет.

---

### [HIGH-09] [HIGH] Портфолио «Базис Медиа» — заглушки со стоковыми фото

- **Файл:** `src/content/portfolio.js:1-51`; используется в `src/pages/MediaHomePage.jsx:8`, `src/pages/MediaHomePage.jsx:29-31`
- **Категория:** заглушка / демо-данные в проде
- **Код:**

```js
/**
 * Портфолио сайта «Базис Медиа».
 * Сейчас здесь ЗАГЛУШКИ со стоковыми фото — перед публикацией замените на реальные работы:
 */
export const PORTFOLIO = [
  {
    id: "w1",
    kind: "video",
    title: "Рекламный ролик",
    image: "https://images.unsplash.com/photo-1574717024653-61fd2cf4d44d?auto=format&fit=crop&w=900&q=80",
  },
```

- **Сценарий сбоя:** на главной медиасайта стоковые фотографии unsplash выдаются за «наши работы» («Рекламный ролик», «Мультфильм на заказ», «ИИ-фотосессия»…). Это вводит клиентов в заблуждение и создаёт репутационные и юридические риски. Ни сборка, ни `check:prod` этого не ловят.
- **Рекомендация:** заменить реальными работами или скрыть блок портфолио, пока список пуст; добавить в `check:prod` проверку на `images.unsplash.com` в портфолио.
- **Уверенность:** средняя (комментарий прямо называет это заглушкой; опубликован ли медиасайт — неизвестно).
- **Статус: открыта (частично устранена).** Сделано в коммите «fix: frontend errors & data truth (audit pack 3)»: выключатель `MEDIA_SITE_ENABLED` (по умолчанию `false`; только `true`/`false`, иное — ошибка настроек, код 4; `config/values.js:42`, `config/sites.js:73`, `"enabledEnv"` в `shared/sites.json`). Пока медиасайт выключен, стоковое портфолио никто не видит: все домены медиасайта отвечают 404 (`server.js:655-690`, `/api/*` — `{"error":"site_disabled"}`, остальное — страница «Сайт «Базис Медиа» сейчас не работает» с `noindex` и ссылкой на основной сайт), медиасайт не попадает в конфиги прокси (`scripts/deploy-config.mjs`), в ссылки сборки (`vite.config.mjs`) и в список сайтов ИИ-консультанта; `check:prod` портфолио не проверяет. При старте и в `--check-config` строка «Медиасайт: включён/выключен» (`server.js:100`). Включённый медиасайт работает как раньше, и `check:prod` снова предупреждает о стоковых фото. Тесты: `test/server-media-switch.test.js`, `config/test/config.test.js`, `test/server-config.test.js`; до исправления падали. Остаётся: само портфолио — по-прежнему заглушки; перед включением медиасайта их нужно заменить.

---

### [HIGH-10] [HIGH] Нет мониторинга ошибок и оповещений: все сбои остаются в локальных журналах

- **Файл:** `server.js:1803-1805`, `server.js:1901-1907`, `server.js:1910-1921`, `logging/file-log.js`, `ai/plugins/metrics.js`, `run-server.bat:42-77`
- **Категория:** логирование и мониторинг
- **Код:**

```js
    console.error(`[${req.id}] ${req.method} ${req.url}:`, err);
    notifier.serverError(req.method, req.url, err);
    sendJson(res, 500, { error: "server_error", message: "Внутренняя ошибка сервера" }, req);
```

```bat
set "WAIT=5"
call :say "Сервер остановился с кодом %CODE%. Перезапуск через %WAIT% с..." "server exited with code %CODE%, restart in %WAIT% s"
rem ping вместо timeout: timeout не работает без консоли (в службе).
ping -n %WAIT% 127.0.0.1 >nul
goto loop
```

- **Сценарий сбоя:** ошибки 500, падения процесса, цикл перезапусков (например, повреждена база → `quick_check` падает → `exit(1)` каждые 5 секунд), ошибки ИИ, провал бэкапа, ошибки JS у посетителей. До `cfbf64c` всё это оставалось в `logs/server-*.log` / `server-run.log` на локальной машине или в консоли браузера посетителя. Нет Sentry, нет счётчика ошибок, нет страницы «Состояние» в админке. Метрики ИИ хранятся только в памяти.
- **Рекомендация:** минимум — отправлять в Telegram ошибки уровня error с дедупликацией (сделано для сервера). Дальше — Sentry (сервер и фронтенд, с фильтрацией персональных данных); в админке раздел «Состояние»: последний бэкап, статус ИИ, число ошибок за сутки; отправка ошибок фронтенда на сервер.
- **Уверенность:** высокая.
- **Статус: открыта (частично устранена).** Сделано в `cfbf64c`: оповещения в Telegram об ошибках 500 (метод, путь без query и id, текст без телефонов, e-mail и секретов), повреждённой базе, необработанных ошибках, падении процесса, ошибке запуска, запуске и перезапуске сервера (с причиной прошлого падения), провале бэкапа, офлайн-режиме ИИ; одинаковые — не чаще раза в 10 минут. В пакете 3 добавлена отправка ошибок фронтенда (`POST /api/client-errors` → журнал и оповещение, см. HIGH-02). В пакете 4 зависание сервера или недоступная база в Docker обнаруживаются: `GET /api/health`, `HEALTHCHECK` и перезапуск с оповещением из watchdog (см. MED-12). Остаётся: нет Sentry, счётчиков и раздела «Состояние»; в режиме службы Windows зависание без выхода не обнаруживается; оповещения выключены, пока в `.env` нет `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID`.

---

### [MED-01] [MEDIUM] Опечатка в настройке лимита отключает защиту от перебора пароля админки

- **Файл:** `server.js:169-172`; использование — `server.js:943-949`, `server.js:795-803`, `server.js:816-819`
- **Категория:** фолбэк переменных окружения
- **Код:**

```js
const CHAT_RATE_LIMIT = Number(process.env.CHAT_RATE_LIMIT || 20);
const CHAT_RATE_WINDOW_MS = Number(process.env.CHAT_RATE_WINDOW_MS || 60 * 1000);
const ADMIN_RATE_LIMIT = Number(process.env.ADMIN_RATE_LIMIT || 30);
const ADMIN_RATE_WINDOW_MS = Number(process.env.ADMIN_RATE_WINDOW_MS || 60 * 1000);
```

```js
function isOverRateLimit(buckets, ip, limit, windowMs) {
  const windowStart = Date.now() - windowMs;
  return (buckets.get(ip) || []).filter((t) => t > windowStart).length >= limit;
}
```

- **Сценарий сбоя:** в `.env` написано `ADMIN_RATE_LIMIT=30/min` или `ADMIN_RATE_LIMIT= 30 шт`. `Number(...)` даёт `NaN`, сравнение `length >= NaN` всегда `false`, и лимит неверных паролей **полностью отключается** — без предупреждения на старте. То же для лимитов чата. `ai/config.js:3-6` такие значения хотя бы заменяет на значения по умолчанию, здесь — нет.
- **Рекомендация:** использовать общий `num(value, fallback, min)` с выводом предупреждения или завершать старт с кодом 4 (ошибка `.env`), как для остальных настроек.
- **Уверенность:** высокая.
- **Статус: исправлена** (коммит «fix: security & config (audit pack 1)»). Что изменено:
  - новый модуль `config/values.js` (строки 1-41): `readNumber(env, name, fallback, { min, max })` — пустое значение → значение по умолчанию; непустое, но не число или вне границ → `{ ok: false, error: "ИМЯ=значение — нужно число не меньше …" }`;
  - `server.js:61-66` — четыре лимита читаются через `readNumber`: `CHAT_RATE_LIMIT` и `ADMIN_RATE_LIMIT` не меньше 1, `CHAT_RATE_WINDOW_MS` и `ADMIN_RATE_WINDOW_MS` не меньше 1000;
  - `server.js:76` — ошибки добавлены в общий список ошибок `.env`: сервер пишет «Сервер не запущен — исправьте .env…» с именем переменной и завершается с кодом 4 (`run-server.bat` не перезапускает);
  - `server.js:199-202` — константы берут проверенные значения.
  - Тесты: `test/server-config.test.js` (три теста MED-01: мусор → код 4 для каждой из 4 переменных, `0` → код 4, пустые и верные значения → старт), `config/test/config.test.js` (`readNumber`). До исправления два первых теста падали (код 0).

---

### [MED-02] [MEDIUM] Публичный `POST /api/orders` проверяет пароль админки без лимита неверных попыток

- **Файл:** `server.js:1097`; сравнить с `server.js:933-951`
- **Категория:** авторизация
- **Код:**

```js
    const ip = clientIp(req);
    const fingerprint = (fromChat ? "chat:" : "") + orderFingerprint(channel, body, leadCategory, rawLead);
    const limitKey = phoneDigits || "anon:" + ip;
    const guard = isAdmin(req) ? { ok: true } : orderGuard.check({ ip, phone: limitKey, fingerprint, body });
    if (!guard.ok) {
      if (guard.status === 429) res.setHeader("Retry-After", "600");
      sendJson(res, guard.status, { error: guard.error, message: guard.message }, req);
      return;
    }
```

- **Сценарий сбоя:** `requireAdmin()` считает неверные пароли в `adminFailBuckets` и отклоняет запросы по HTTP через прокси. В `POST /api/orders` заголовок `X-Admin-Password` проверяется напрямую: верный пароль даёт 201 без антиспам-токена, неверный — ответ антиспама. Это «оракул» для перебора пароля в обход лимита неверных попыток (лимиты `orderGuard` по IP ограничивают только принятые заказы). Неверные попытки нигде не логируются.
- **Рекомендация:** использовать здесь ту же логику, что в `requireAdmin` (учёт неудачных попыток), или убрать обход антиспама для админа (e2e-скрипт `scripts/docker-e2e.ps1:40` можно перевести на получение токена).
- **Уверенность:** средняя (не проверял, учитывает ли `orderGuard` что-то при неверном токене).
- **Статус: исправлена** (коммит «fix: security & config (audit pack 1)»). Выбран вариант «убрать обход антиспама для админа совсем»: «оракул» исчезает целиком, а не ограничивается лимитом; админка заказы через `POST /api/orders` не создаёт — обход использовал только e2e-скрипт. Что изменено:
  - `server.js:1127-1128` — `const guard = orderGuard.check(...)` для всех запросов, `isAdmin(req)` в этом маршруте больше не вызывается; ответ без токена одинаков при верном, неверном и отсутствующем пароле (403 `challenge_required`);
  - `scripts/docker-e2e.ps1:20-23` — функция `New-Proof` получает токен `GET /api/orders/challenge`; `:36` — тестовый контейнер запускается с `ORDER_POW_BITS=0` и `ORDER_MIN_FILL_MS=0`, чтобы токен не требовал подбора; `:45`, `:52` — заказ и заявка отправляются с `proof`.
  - Тесты: `test/server-orders.test.js` — сервер во временной копии проекта; верный пароль без токена → 403 (до исправления был 201); ответы для верного, неверного и пустого пароля совпадают.

---

### [MED-03] [MEDIUM] Повреждённый JSON в базе молча становится пустым объектом

- **Файл:** `db/store.js:206-214`; следствие — `documents/index.js:301`
- **Категория:** поглощённая ошибка / БД
- **Код:**

```js
function parseExtra(text) {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
```

- **Сценарий сбоя:** функция используется для дополнительных полей заказа, реквизитов клиента и снимков документов. Если значение повреждено (ручная правка базы, обрыв записи, баг сериализации): реквизиты клиента показываются пустыми, и при следующем сохранении карточки пустые реквизиты **перезаписывают** повреждённые; снимок документа `{}` проходит проверку `!doc.snapshot`, и PDF рендерится пустым или падает. В журнал ничего не пишется.
- **Рекомендация:** при ошибке парсинга писать `log.error` с таблицей и id записи; для снимков документов — бросать ошибку, а не возвращать `{}`.
- **Уверенность:** средняя (вероятность повреждения невысока, но последствия незаметны).
- **Статус: открыта.**

---

### [MED-04] [MEDIUM] Без модуля `sharp` картинки WebP/GIF молча пропадают из PDF-каталогов

- **Файл:** `documents/images.js:14-23`, `documents/images.js:102-115`, `documents/images.js:136-137`
- **Категория:** поглощённая ошибка / деградация
- **Код:**

```js
function loadSharp() {
  if (sharpModule === undefined) {
    try {
      sharpModule = require("sharp");
    } catch {
      sharpModule = null;
    }
  }
  return sharpModule;
}
```

```js
    // Без sharp вставляем только то, что pdfmake понимает сам.
    const mime = sniffMime(buffer);
    return mime === "image/jpeg" || mime === "image/png" ? buffer : null;
  // ...
      const ready = await convert(original, maxWidth);
      if (!ready) return null;
```

- **Сценарий сбоя:** `sharp` — нативный модуль; после `npm install` на другой ОС или архитектуре или при сломанной установке `require` падает. Ошибка проглатывается, и все картинки, кроме JPEG/PNG (загруженные WebP, все unsplash-картинки с `auto=format`), в PDF-каталогах и карточках товара будут пустыми. `return null` на строке 137 идёт **без** `log.warn` (в отличие от `catch` на строках 143-146). Менеджер отправляет клиенту каталог без фото и не знает почему.
- **Рекомендация:** при ошибке `require("sharp")` один раз писать `console.error` с причиной; на строке 137 логировать «формат не поддерживается без sharp».
- **Уверенность:** высокая.
- **Статус: исправлена** (коммит «fix: documents (audit pack 2)»). Что изменено:
  - `documents/images.js:13-35` — при ошибке `require("sharp")` один раз `console.error` с причиной и советом (`npm ci`, в Docker — пересобрать образ); новая `sharpStatus()` → `{ ok, error }`.
  - `documents/images.js:123-127` — вместо молчаливого `return null` — `log.warn("PDF: формат <mime> не поддерживается без sharp — картинка пропущена.")`.
  - `server.js:165-172` (импорт — строка 21) — `productionProblems()` добавляет пункт «Модуль sharp не загружается (<причина>)…». Эта функция вызывается и при старте сервера, поэтому сбой sharp попадает в журнал сразу, а не при первом PDF; в `check:prod` это «не готово».
  - Тесты: `documents/test/images-sharp.test.js` (2 теста: подменённый `require("sharp")` с ошибкой — одна запись с причиной; WebP пропускается с предупреждением о формате, PNG вставляется), `test/server-config.test.js` — «MED-04: sharp не загружается — check:prod сообщает причину» (в копии проекта подложен сломанный `node_modules/sharp`). До исправления все три падали.

---

### [MED-05] [MEDIUM] Неверный `DOCUMENTS_TZ` молча заменяется часовым поясом сервера — даты и год нумерации документов

- **Файл:** `documents/templates/common.js:33`, `documents/templates/common.js:40-50`; год нумерации — `documents/index.js:221`
- **Категория:** фолбэк переменных окружения
- **Код:**

```js
const TIME_ZONE = process.env.DOCUMENTS_TZ || "Asia/Almaty";
// ...
  if (!partsFormat) {
    try {
      partsFormat = new Intl.DateTimeFormat("en-GB", {
        timeZone: TIME_ZONE, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23",
      });
    } catch {
      partsFormat = new Intl.DateTimeFormat("en-GB", {
        year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23",
      });
    }
```

- **Сценарий сбоя:** опечатка `DOCUMENTS_TZ=Asia/Almati` → `RangeError` → используется часовой пояс процесса. На Linux-сервере (systemd) это обычно UTC (в Docker задан `TZ=Asia/Almaty`, там риск ниже). Документ, выпущенный 1 января в 03:00 по Алматы, получит дату 31 декабря и **номер из прошлого года** (`const year = localParts(now).year`). Предупреждения нет.
- **Рекомендация:** проверять `DOCUMENTS_TZ` при старте (как прочие настройки `.env`) и завершаться с кодом 4 или хотя бы писать `console.error`.
- **Уверенность:** средняя.
- **Статус: исправлена** (коммит «fix: security & config (audit pack 1)»). Что изменено:
  - `config/values.js` — `readTimeZone(env, name, fallback)` проверяет значение тем же `Intl.DateTimeFormat`, что и `documents/templates/common.js`, в том же виде (без обрезки пробелов);
  - `server.js:68` — проверка `DOCUMENTS_TZ` при старте, `server.js:77` — ошибка в списке ошибок `.env` → «DOCUMENTS_TZ=… — неизвестный часовой пояс; пример: DOCUMENTS_TZ=Asia/Almaty» и код 4. Запасной вариант в `common.js:40-50` остался, но с проверкой при старте до него не доходит.
  - Тесты: `test/server-config.test.js` (опечатка → код 4; `Asia/Almaty`, `Europe/Moscow`, пусто → старт), `config/test/config.test.js` (`readTimeZone`). До исправления тест с опечаткой падал (код 0).

---

### [MED-06] [MEDIUM] Одна ошибка записи навсегда отключает журнал в файл

- **Файл:** `logging/file-log.js:47-55`
- **Категория:** логирование
- **Код:**

```js
  function disable(err) {
    disabled = true;
    closeFd();
    try {
      fallback.error(`Журнал в файл отключён: ${err && err.message}. Сообщения выводятся только в консоль.`);
    } catch {
      // ignore
    }
  }
```

- **Сценарий сбоя:** кратковременная нехватка места или блокировка файла антивирусом — и до перезапуска процесса (возможно, недели) файловый журнал выключен. В режиме службы Windows консоль — это `server-run.log` через перенаправление `run-server.bat`, а в Docker — `docker logs` с ротацией 3 × 10 МБ. Подробные журналы по дням теряются, сообщение об этом пишется один раз туда, куда никто не смотрит, и в Telegram не уходит.
- **Рекомендация:** повторять попытку открыть файл при смене дня или через N минут, а не отключать навсегда; при отключении — `notifier.alert`.
- **Уверенность:** высокая.
- **Статус: исправлена** (коммит «fix: server errors & health (audit pack 4)»). Что изменено: `logging/file-log.js` — после ошибки записи журнал не отключается навсегда: следующая запись через 5 минут (`retryMs`) или в новый день снова открывает файл. Неудачная повторная попытка новых сообщений не даёт. Об отключении и о восстановлении — по одной строке в консоль («Журнал в файл отключён… повторная попытка через 5 мин», «Журнал в файл снова работает… не записано строк: N»), в сам файл после восстановления пишется строка WARN с числом потерянных строк. Оповещение — через хук `onStatus(status, text)`, который передаёт сервер (`server.js:54` → `notifier.alert("file_log:<status>")`, антиспам 10 минут); `logging/` от `notify/` не зависит. Тесты: `logging/test/file-log.test.js` — «MED-06: после отключения файл открывается снова через 5 минут…» и «MED-06: с началом нового дня…». До исправления падали.

---

### [MED-07] [MEDIUM] ИИ-консультант при ошибке чтения каталога называет клиентам демо-цены

- **Файл:** `ai/features/consultant.js:96-107`
- **Категория:** маскирующий фолбэк / демо-данные
- **Код:**

```js
function catalogFor(ctx, siteId) {
  const getProducts = ctx && ctx.services && ctx.services.getProducts;
  let products = null;
  if (typeof getProducts === "function") {
    try {
      products = getProducts();
    } catch (err) {
      console.error("ИИ-консультант: не удалось прочитать каталог:", err.message);
    }
  }
  return buildCatalogText(Array.isArray(products) ? products : DEFAULT_PRODUCTS, siteId);
}
```

- **Сценарий сбоя:** ошибка базы при чтении товаров — ИИ получает в промпт **встроенный демо-каталог** с демо-ценами и уверенно называет их клиенту. Ошибка логируется, но ответ клиенту выглядит нормально. Кроме того, до открытия базы `getProducts` возвращает `null` (`server.js:1732`) — тоже демо-каталог.
- **Рекомендация:** при ошибке не подставлять `DEFAULT_PRODUCTS`, а давать ИИ инструкцию «цены уточняйте у менеджера» или отвечать ошибкой.
- **Уверенность:** высокая.
- **Статус: исправлена** (коммит «fix: frontend errors & data truth (audit pack 3)»). Что изменено: `ai/features/consultant.js:131` — `catalogFor` возвращает `{ available, text }`; при ошибке чтения или неоткрытой базе ИИ не получает никакого каталога, а `DEFAULT_PRODUCTS` из модуля убран. Вместо правил о ценах в системный промпт идёт `NO_CATALOG_RULES` (строка 52): не называть цены, сроки и наличие, предлагать уточнить у менеджера. `reportCatalogProblem` (строка 114) пишет `console.error` (не чаще раза в минуту) и `notifier.alert("ai:catalog", …)` с антиспамом 10 минут; `notifier` передаётся в ИИ из `server.js` через `createAi`. Тесты: `ai/test/consultant-catalog.test.js`; до исправления падали.

---

### [MED-08] [MEDIUM] Ошибка загрузки `unpdf` проглатывается навсегда — PDF-вложения разбираются упрощённым парсером

- **Файл:** `ai/lib/attachments.js:248-258`; упрощённый разбор — `ai/lib/attachments.js:360-362`
- **Категория:** поглощённая ошибка / деградация
- **Код:**

```js
let unpdfModule;
async function loadUnpdf() {
  if (unpdfModule === undefined) {
    try {
      unpdfModule = await import("unpdf");
    } catch {
      unpdfModule = null;
    }
  }
  return unpdfModule;
}
```

- **Сценарий сбоя:** зависимость не установилась или несовместима после обновления — весь разбор PDF-вложений в чате до перезапуска идёт встроенным упрощённым парсером (хуже извлекает текст, не справляется со сжатыми потоками). ИИ отвечает по неполному документу, ни строки в журнале.
- **Рекомендация:** логировать ошибку импорта (`console.error` один раз).
- **Уверенность:** высокая.
- **Статус: открыта.**

---

### [MED-09] [MEDIUM] Ошибки разбора вложений (422) не логируются

- **Файл:** `ai/http.js:65-91`, `ai/http.js:120-133`; фронтенд — `src/chat/attachments.js:242-266`
- **Категория:** логирование / внешний модуль
- **Код:**

```js
  function sendError(req, res, err) {
    if (typeof deps.onError === "function") {
      try {
        deps.onError(err, req);
      } catch (hookErr) {
        console.error("AI: обработчик onError:", hookErr);
      }
    }
    if (res.writableEnded || res.destroyed) return;
    if (err instanceof AiError) {
      const body = { error: err.code };
```

- **Сценарий сбоя:** `POST /api/ai/_attachments` не проходит через ядро ИИ, поэтому плагин-логгер не срабатывает. Падение worker-потока, таймаут, нехватка памяти превращаются в `AiError` 422/503 и уходят клиенту без записи в журнал. Хук `onError`, добавленный в `cfbf64c`, для `AiError` оповещает только о кодах офлайн-режима ИИ, ошибки вложений не логирует. Видно только в `attachmentsPool.stats()` (в памяти). Фронтенд молча переходит на локальный разбор.
- **Рекомендация:** логировать `AiError` со статусом ≥ 500, а также 422 с `detail` от worker-потока.
- **Уверенность:** высокая.
- **Статус: открыта.**

---

### [MED-10] [MEDIUM] Счёт выпускается и номер тратится, даже если реквизиты компании не заполнены

- **Файл:** `documents/index.js:216-246`, `documents/templates/invoice.js:22-28`; источник пустых настроек — `db/store.js:1116-1122`
- **Категория:** валидация / скрытый фолбэк
- **Код:**

```js
  function issueOne(order, kind, bucket, replaces) {
    const settings = companySettings();
    const source = sourceOf(bucket, buyerFor(order));
    const now = new Date().toISOString();
    const year = localParts(now).year;
    return store.documents.issue({
      // ...
          company: settings.fields,
```

```js
          { stack: [{ text: "Бенефициар:", style: "small" }, { text: dash(company.name), bold: true }, { text: "ИИН/БИН: " + dash(company.bin) }] },
          cellTitle("ИИК", company.iik, { bold: true }),
          cellTitle("Кбе", company.kbe, { bold: true }),
```

- **Сценарий сбоя:** после нового развёртывания или потери настроек (`settings.get` возвращает `null` при битом JSON, см. LOW-11) счёт выпускается с «—» вместо БИН, ИИК, БИК. Номер из нумератора израсходован (документ в базе навсегда), PDF можно сразу отправить клиенту по e-mail. Клиент не сможет оплатить.
- **Рекомендация:** перед `issue({ kind: "invoice" })` проверять обязательные поля (`name`, `bin`, `iik`, `bik`, `bank`) и отвечать 400 `company_requisites_missing` с переходом в раздел «Компания».
- **Уверенность:** средняя (не исключаю, что форма «Компания» не даёт сохранить пустые поля, но серверной проверки при выпуске нет). Подтверждено 09.10.2026: в рабочей базе реквизиты компании пустые, а счёт `2026-0001` уже выпущен.
- **Статус: исправлена** (коммит «fix: documents (audit pack 2)»). Что изменено:
  - `documents/requisites.js:58-75` — `REQUIRED_COMPANY_FIELDS` и `missingCompanyFields(kind, values)`. Для **счёта** по шаблону `invoice.js` (блок банковских реквизитов): `name`, `bin`, `bank`, `iik`, `bik` и дополнительно `kbe` — без КБе банк не примет платёжное поручение. `knp` не обязателен: код назначения платежа выбирает плательщик. Для **акта** (форма Р-1, `act.js` — исполнитель с ИИН/БИН, банковских реквизитов в акте нет): `name`, `bin`.
  - `documents/index.js:254-269` — `assertIssuable()` до присвоения номера: `400 company_requisites_missing`, `fields` — ключи незаполненных полей, в тексте — их названия и «Заполните их в разделе «Реквизиты»». Номер не расходуется ни при выпуске, ни при перевыпуске.
  - `documents/http.js:56` — `fields` передаётся в ответе API; `src/admin/documents-api.js:24-27, 75-76` — `fields` в ошибке и `COMPANY_ERROR_CODES`.
  - Админка: `src/admin/OrderDocuments.jsx:180-186, 236-247` — сообщение и кнопка «Открыть раздел «Реквизиты»» (вкладка админки называется «Реквизиты», а не «Компания»).
  - Тесты: `documents/test/documents.test.js` — «MED-10: без обязательных реквизитов счёт и акт не выпускаются, номер не тратится» и «MED-10: ответ API — 400 company_requisites_missing со списком полей». До исправления оба падали. В прежних тестах документов добавлены полные реквизиты `COMPANY`.

---

### [MED-11] [MEDIUM] Витрина при ошибке API показывает кэш или демо-каталог без какой-либо пометки

- **Файл:** `src/store/StoreContext.jsx:18`, `src/store/StoreContext.jsx:25-37`, `src/lib/products-api.js:14-28`
- **Категория:** маскирующий фолбэк
- **Код:**

```jsx
  const [allProducts, setProducts] = useState(readCachedProducts);
  // ...
  useEffect(() => {
    let cancelled = false;
    fetchProducts()
      .then((list) => {
        if (!cancelled) setProducts(list);
      })
      .catch(() => {
        // сервер недоступен — остаёмся на кэше / сиде
      });
```

- **Сценарий сбоя:** API недоступен (перезапуск, повреждённая база → 503). Новый посетитель видит **демо-каталог** `DEFAULT_PRODUCTS`, вернувшийся — свой старый кэш со старыми ценами. Оформление заказа защищено сервером (`catalog_changed`, `server.js:858-860`), но цены в карточках и в сообщении WhatsApp могут быть неверными. Ни посетитель, ни владелец о сбое не узнают.
- **Рекомендация:** при ошибке показывать ненавязчивую плашку «Цены могут быть неактуальны» и сообщать о сбое на сервер; демо-каталог использовать только как заглушку на время загрузки.
- **Уверенность:** высокая (смягчено серверной проверкой при оформлении, поэтому MEDIUM, а не HIGH).
- **Статус: исправлена** (коммит «fix: frontend errors & data truth (audit pack 3)»). Что изменено:
  - SEO: пререндера и SSR в проекте нет. `scripts/i18n-html.mjs` вставляет в HTML только `title`, `description`, OG-теги, `canonical` и `hreflang`; карточки товаров рисуются только в браузере после загрузки. `DEFAULT_PRODUCTS` был лишь начальным состоянием до ответа API и в HTML не попадал, поэтому для индексации не нужен — экспорт удалён из клиента целиком. Мета-теги и ссылки между языками не менялись.
  - `src/store/StoreContext.jsx` — каталог в состоянии `loading / ready / stale / error`; при ошибке API берётся копия из `localStorage`, без копии — ошибка; сбой отправляется на сервер (`reportClientError(err, { kind: "catalog" })`, строка 47; одна отправка за сессию).
  - `src/components/CatalogNotices.jsx`, `src/pages/ShopPage.jsx`, `src/pages/MediaHomePage.jsx` — копия показывается с плашкой «Цены могут быть неактуальны, уточните у менеджера»; без копии — «Каталог временно недоступен» и ссылки WhatsApp/Telegram; во время первой загрузки — «Загружаем каталог…». Тексты в `ru.json` и `kk.json` (`shop.catalog.*`).
  - Тесты: `src/pages/ShopPage.test.jsx`, `src/lib/data-api.test.js`; до исправления падали.

---

### [MED-12] [MEDIUM] Docker: статус `unhealthy` никто не обрабатывает, healthcheck не проверяет базу

- **Файл:** `Dockerfile:50-51`, `docker-compose.yml:22`, `scripts/docker-autostart.ps1:187-195`
- **Категория:** фоновые задачи / мониторинг
- **Код:**

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/ai').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
```

```powershell
  "watch" {
    try {
      $script:Docker = Get-DockerExe
      if (-not (Start-Engine)) { exit 1 }
    } catch {
      Write-Log "ОШИБКА: $($_.Exception.Message)"
      exit 1
    }
  }
```

- **Сценарий сбоя:** `restart: unless-stopped` перезапускает контейнер только при **выходе** процесса, а не при `unhealthy`. Если сервер завис (event loop заблокирован) или база недоступна, а `/api/ai` (статус ИИ без обращения к базе) отвечает, контейнер «healthy», а сайт не работает. Watchdog каждые 5 минут проверяет только движок Docker, не контейнер и не сайт. Оповещения `notify` при зависании не срабатывают: процесс не падает и не отвечает 500.
- **Рекомендация:** отдельный `/api/health` с `SELECT 1` к базе; в watchdog проверять `docker inspect … Health.Status` и перезапускать контейнер или слать уведомление.
- **Уверенность:** высокая.
- **Статус: исправлена для Docker** (коммит «fix: server errors & health (audit pack 4)»). Что изменено:
  - `runtime/health.js`, маршрут `server.js:1904` — `GET /api/health`: `SELECT 1` к базе (`store.ping()`, `db/store.js`), ответ `200 {ok:true, db:"ok", uptime, version}` или `503 {ok:false, db:"error"}` (плюс `requestId`, как во всех ошибках). Причина сбоя — только в журнале, одна и та же — один раз. Без пароля, лимит 60 запросов в минуту с адреса (429). Отвечает и пока база ещё не открыта (503).
  - `Dockerfile` — `HEALTHCHECK` проверяет `/api/health`, а не `/api/ai`.
  - `scripts/docker-autostart.ps1`, режим `watch` (раз в 5 минут) — `Watch-Health`: читает `State.Status` и `State.Health.Status` контейнера; `unhealthy` — счётчик в `logs/docker-unhealthy.txt`; два раза подряд — `docker restart`, строка в `logs/docker-autostart.log` и оповещение владельцу. `healthy` сбрасывает счётчик, `starting` его не трогает, остановленный вручную контейнер не трогается.
  - `notify/cli.js` — `node notify/cli.js "текст"`: тот же модуль `notify`, переменные из окружения или `.env`, общий с сервером антиспам (`data/notify-state.json`). Watchdog вызывает его через `docker compose run --rm --no-deps -T bazis node notify/cli.js "…"` — переменные Telegram контейнер получает из `env_file`, скрипт `.env` не читает. Коды выхода: 0 — отправлено или пропущено антиспамом, 1 — Telegram отказал, 2 — нет текста, 3 — оповещения не настроены.
  - Тесты: `runtime/test/health.test.js`, `test/server-errors.test.js` («MED-12: GET /api/health…»), `notify/test/cli.test.js`, `test/docker-watchdog.test.js` (поддельный docker; только Windows). До исправления падали.
  - Служба Windows (без Docker) такой проверки не получила: `run-server.bat` перезапускает сервер только после выхода процесса, зависание не заметит. Предложение (не реализовано): задача планировщика раз в 5 минут — `Invoke-WebRequest http://127.0.0.1:<PORT>/api/health -TimeoutSec 10`; два отказа подряд — `windows-service.ps1 restart` и `node notify/cli.js "…"`. Сейчас сайт работает в Docker, поэтому это не срочно.

---

### [MED-13] [MEDIUM] Заявка из ИИ-чата при передаче в мессенджер может потеряться — видно только в консоли посетителя

- **Файл:** `src/chat/handoff-lead.js:37-50`
- **Категория:** поглощённая ошибка
- **Код:**

```js
  const attempt = () => submitPublicOrder(body, { keepalive: true });
  session.sending = attempt()
    .catch((err) => {
      if (err && err.code === "network") return new Promise((resolve) => setTimeout(resolve, 5000)).then(attempt);
      throw err;
    })
    .then(() => {
      session.sent = true;
    })
    .catch((err) => console.warn("Заявка из чата не сохранена в CRM", err))
```

- **Сценарий сбоя:** посетитель жмёт «Написать в WhatsApp» — страница уходит в фон или закрывается (мобильный браузер). `submitPublicOrder` сначала получает антиспам-токен и считает proof-of-work, и только финальный запрос идёт с `keepalive`. Подготовительные шаги могут не успеть, повтор через 5 с в фоновой вкладке часто не выполняется. Переписка и телефон клиента не попадают в CRM, и оповещение HIGH-01 тоже не отправляется (заявки на сервере нет). Решение «не показывать ошибку посетителю» разумно, но сервер о неудаче не знает.
- **Рекомендация:** готовить токен заранее (`warmOrderProof` уже вызывается при открытии чата — `ChatWidget.jsx:305`, но результат может устареть); при неудаче сохранять заявку в `localStorage` и досылать при следующем визите.
- **Уверенность:** средняя (не воспроизводил на мобильном устройстве).
- **Статус: исправлена** (коммит «fix: validation & frontend (audit pack 5)»). Что изменено: новый модуль `src/chat/lead-outbox.js` (ключ `bazis_chat_lead_outbox`). `src/chat/handoff-lead.js:39` — заявка кладётся в `localStorage` **до** отправки (без антиспам-токена), поэтому она не теряется и тогда, когда вкладку закрыли раньше ответа сервера. После успешного ответа запись удаляется; при отказе сервера по существу (4xx, кроме 403 и 429) — тоже удаляется, повтор не поможет. `src/main.jsx:14` — через 3 с после загрузки любой страницы витрины `flushLeadOutbox` досылает отложенные заявки с **тем же id**: сервер отвечает `200 duplicate`, если заявка уже дошла, — дублей в CRM нет. Записи старше 7 дней удаляются без отправки (`console.warn`). Сбой сети или лимит (429) — запись остаётся до следующего визита. Хранится не больше 20 заявок. Тесты: `src/chat/lead-outbox.test.js` (5 тестов: досылка с тем же id, запись до ответа сервера, очистка после успеха, срок 7 дней, лимит или отказ 400). До исправления модуля не было — тесты падали.

---

### [MED-14] [MEDIUM] Товар без фото молча получает стоковую картинку unsplash, а сервер её скачивает

- **Файл:** `src/lib/products-api.js:71`, `src/admin/ProductModal.jsx:109`, `server.js:167-168`, `server.js:245-250`
- **Категория:** скрытый фолбэк / заглушка
- **Код:**

```js
    image: String(product.image || "").trim() || DEFAULT_IMAGE,
```

```js
function storedImageValue(value) {
  const image = String(value || "").trim();
  if (!image) return DEFAULT_PRODUCT_IMAGE;
  if (image.startsWith("data:")) return image.length <= MAX_INLINE_IMAGE_LENGTH ? image : DEFAULT_PRODUCT_IMAGE;
  return image.slice(0, MAX_IMAGE_REF_LENGTH);
}
```

- **Сценарий сбоя:** менеджер сохраняет товар без фото — на витрине и в PDF-каталоге появляется случайная стоковая фотография «офиса». Слишком большая встроенная картинка из старых данных молча заменяется той же заглушкой (оригинал теряется). Если сервер не может скачать unsplash (нет интернета или блокировка), сохранение товара падает с `image_fetch_failed`, хотя менеджер фото вообще не выбирал.
- **Рекомендация:** хранить пустое значение и показывать нейтральный плейсхолдер на клиенте; при отбрасывании слишком большой картинки — `console.warn` с id товара.
- **Уверенность:** высокая.
- **Статус: исправлена** (коммит «fix: validation & frontend (audit pack 5)»). Что изменено:
  - Сервер: товар без фото хранит `""`. `server.js:511` `resolveProductImage` — поля `image` нет в запросе → картинка прежняя, пустая строка → фото убрано (файл из `images/uploads` удаляется). Стоковая картинка больше нигде не подставляется: `server.js:316` `storedImageValue` и `server.js:359` `migrateInlineImages` (повреждённая картинка → `""`).
  - Слишком большая встроенная картинка в старых данных: `server.js:316` — `console.warn` «Картинка товара <id> в старых данных больше N байт — не перенесена, у товара не будет фото».
  - Сохранение без фото не зависит от unsplash: новая админка шлёт `""`, а стоковую ссылку от вкладки, открытой до обновления, сервер не качает и сохраняет «без фото» (`server.js:600`, `LEGACY_DEFAULT_IMAGE`).
  - Клиент: `src/lib/catalog.js:22` — `PRODUCT_PLACEHOLDER` (`public/brand/product-placeholder.svg`, нейтральная рамка «картинка» в цветах сайта, без текста). Его показывают витрина, корзина и админка через `imageSrc`. В форме товара — кнопка «Убрать фото» (`src/admin/ProductModal.jsx:300`). PDF-каталог: вместо пустой клетки — «Без фото» на светлом фоне (`documents/templates/catalog.js:31`); карточка товара в PDF без фото выводится без картинки, как и раньше.
  - Старые товары, у которых стоковая картинка уже была скачана в `images/uploads`, отличить от настоящих фото нельзя — их фото можно убрать кнопкой «Убрать фото». Данные автоматически не менялись.
  - Тесты: `test/server-validation.test.js` (2 теста MED-14, сеть для картинок в них отключена), `src/admin/ProductModal.test.jsx` («сохраняется с пустой картинкой…», «Убрать фото…»), `documents/test/catalog-placeholder.test.js`. До исправления падали.

---

### [MED-15] [MEDIUM] `unhandledRejection` не завершает процесс; ошибка старта теряет стек и уходит в бесконечный цикл перезапусков

- **Файл:** `server.js:1901-1907`, `server.js:1834-1839`, `run-server.bat:66-77`
- **Категория:** необработанные async-ошибки
- **Код:**

```js
process.on("unhandledRejection", (err) => {
  console.error("Необработанная ошибка:", err);
  notifier.alert(
    "unhandled:" + scrub(err && err.message, sender.hideSecrets).slice(0, 80),
    "Необработанная ошибка в фоне: " + scrub(err && err.message ? err.message : err, sender.hideSecrets)
  );
});
```

```js
  } catch (err) {
    console.error(err.message);
    notifier.failed("ошибка запуска", err);
    notifier.flush().then(() => process.exit(1));
    return;
  }
```

- **Сценарий сбоя:** (1) необработанный отказ промиса в фоновой задаче оставляет процесс в неопределённом состоянии, при этом для `uncaughtException` выбран выход с перезапуском — поведение непоследовательное. (2) Если база не открывается из-за ошибки, отличной от «повреждена» (например, `EACCES`), в журнал попадает только текст без стека, процесс выходит с кодом 1, `run-server.bat` перезапускает его каждые 5 секунд **бесконечно**, засоряя `server-run.log`. Сайт при этом лежит.
- **Рекомендация:** логировать `err.stack`; ограничить число быстрых перезапусков подряд (например, 5 за 2 минуты → пауза); для `unhandledRejection` — то же поведение, что для `uncaughtException`.
- **Уверенность:** высокая.
- **Сделано раньше, в `cfbf64c`:** и необработанная ошибка, и ошибка запуска шлют оповещение в Telegram; благодаря состоянию в `data/notify-state.json` цикл перезапусков даёт одно сообщение раз в 10 минут, а не каждые 5 секунд, и после восстановления приходит «Сервер перезапущен после сбоя: <причина>».
- **Статус: исправлена** (коммит «fix: server errors & health (audit pack 4)»). Что изменено:
  - `server.js:1976` — ошибка запуска пишется со стеком («Сервер не запустился: Error: … at …»).
  - `runtime/shutdown.js` — `createCrashHandler`, `server.js:2046-2049`: `unhandledRejection` ведёт себя как `uncaughtException` — журнал со стеком, `notifier.failed`, `flush` (до 3 с), закрыть базу, код 1.
  - Перед этим проверены места, где отказ промиса мог остаться без обработчика:
    1. обработчик HTTP-запроса был `async`, и сбой внутри его же `catch` стал бы необработанным отказом и теперь ронял бы сервер. Теперь `server.js:1942` — `handleRequest(...).catch(...)`: журнал и обрыв соединения;
    2. `server.close(async () => …)` при остановке — перенесено в `createShutdown`, все шаги в `try/catch`;
    3. `ai/core.js` `untilAborted`: если сигнал уже отменён, запущенный запрос к провайдеру оставался без обработчика. Сейчас такого не бывает (сигнал проверяется синхронно перед вызовом), но добавлен `promise.catch(() => {})`;
    4. `documents/render.js` — `terminate()` зависшего потока PDF без обработчика: добавлен `.catch` с записью в журнал;
    5. `notifier.flush().then(...)` при ошибке запуска — добавлен обработчик отказа.
    Проверены и безопасны: `localizeExternalImages(...).catch`, `writeAtomic(...).catch` в `documents/index.js`, промисы классификатора темы и описания картинок ИИ (`.catch(() => null / "")`), `pdf.cleanup().catch`, `worker.terminate().catch`, очередь `notifier` (сбой Telegram перехватывается в `send`), `sleep(...).catch` в `ai/lib/retry.js`, `Promise.all` в `mapLimit`, отказы `documents/render.js` и `ai/lib/attachments-pool.js` (их ждут вызывающие). Вызовы `notifier.alert/serverError/order` без `await` не отклоняются никогда.
  - `run-server.bat` — 5 падений за 2 минуты (скользящее окно по времени падений): пауза 5 минут со строкой «Сервер упал 5 раз за 120 с… Пауза 300 с, затем новые попытки» (в журнале службы — `server crashed 5 times within 120 s - pausing 300 s before next attempts`), после паузы — «Пауза окончена». Время берётся из `node -e`, пороги можно переопределить переменными `BAZIS_CRASH_*` (только для тестов).
  - Docker: `restart: unless-stopped` перезапускает с нарастающей задержкой — 100 мс, дальше удваивается до потолка в 1 минуту; задержка сбрасывается, если контейнер проработал больше 10 с. Цикл «падает сразу при запуске» сам замедляется до одного перезапуска в минуту, поэтому `docker-compose.yml` не менялся.
  - Тесты: `test/server-errors.test.js` («ошибка запуска пишется со стеком», «необработанный отказ промиса завершает процесс с кодом 1»), `runtime/test/shutdown.test.js` («аварийный выход…»), `test/run-server-bat.test.js` (только Windows). До исправления падали (кроме контрольного «редкие падения перезапускаются без паузы»).

---

### [LOW-01] [LOW] Ошибки удаления загруженных файлов игнорируются

- **Файл:** `server.js:358-370`
- **Категория:** поглощённая ошибка
- **Код:**

```js
function deleteUploadIfOwned(imagePath) {
  if (!isUploadPath(imagePath)) return;
  // ...
  try {
    if (fs.existsSync(full) && fs.statSync(full).isFile()) fs.unlinkSync(full);
  } catch {
    // ignore cleanup errors
  }
}
```

- **Сценарий сбоя:** заблокированный файл (Windows, антивирус) не удаляется при замене фото или откате неудачного сохранения товара, в `images/uploads` копятся «сироты». Данные не теряются, но диск засоряется молча.
- **Рекомендация:** `console.warn` с путём.
- **Уверенность:** высокая.
- **Статус: исправлена** (коммит «fix: validation & frontend (audit pack 5)»). Что изменено: удаление вынесено в `runtime/uploads.js` (`createUploadRemover`, подключение — `server.js:428`); при ошибке — `console.warn` «Не удалось удалить загруженный файл <полный путь>: <код>» (например, `EBUSY`). Проверка «только свои файлы в images/uploads» не изменилась. Тесты: `runtime/test/uploads.test.js`; до исправления модуля не было — тесты падали.

---

### [LOW-02] [LOW] Неизвестная валюта или категория товара молча заменяется на KZT / «management»

- **Файл:** `server.js:210-222`
- **Категория:** маскирующий фолбэк
- **Код:**

```js
function normalizeCurrency(value) {
  const code = String(value || "KZT").toUpperCase();
  return code === "RUB" || code === "USD" || code === "KZT" ? code : "KZT";
}
// ...
function normalizeCategory(value) {
  const id = String(value || "").trim();
  return CATEGORY_IDS.has(id) ? id : "management";
}
```

- **Сценарий сбоя:** админ (или старая версия админки после обновления справочника) присылает `EUR` или удалённую категорию. Товар сохраняется с ценой в тенге (сумма та же, валюта другая) или переезжает в чужой раздел без ошибки.
- **Рекомендация:** при создании и изменении через API отвечать 400 `invalid_currency` / `invalid_category`; молчаливую нормализацию оставить только для миграции старых данных.
- **Уверенность:** высокая.
- **Статус: исправлена** (коммит «fix: validation & frontend (audit pack 5)»). Что изменено: `server.js:275` `parseCurrency` и проверка в `buildProductFromBody` (`server.js:558`): `POST`/`PATCH /api/products` с неизвестной валютой — 400 `invalid_currency`, с неизвестным разделом — 400 `invalid_category`, оба с понятным текстом (`PRODUCT_ERROR_MESSAGES`). Регистр валюты не важен (`usd` → `USD`). Не прислали валюту при создании — KZT (валюта по умолчанию в форме); не прислали раздел при создании — `invalid_category` (без раздела товар молча уехал бы в «Управление бизнесом»). При правке отсутствующее поле остаётся прежним. `normalizeCurrency`/`normalizeCategory` остались только для чтения старых данных (импорт JSON, корзина). Клиент тоже больше не подменяет значения: `src/lib/products-api.js:74` отправляет валюту и раздел как есть; админка показывает текст сервера под формой. Тесты: `test/server-validation.test.js` («LOW-02…»), `src/admin/ProductModal.test.jsx` («клиент не подменяет…», показ текста ошибок). Серверный тест и тест клиента до исправления падали.

---

### [LOW-03] [LOW] Неверный статус в `PATCH /api/orders/:id` молча игнорируется

- **Файл:** `server.js:1226`
- **Категория:** валидация
- **Код:**

```js
    try {
      fields = orderAdjustments(body);
    } catch (err) {
      sendJson(res, 400, { error: err.message, message: "Проверьте скидки, доставку и ставку НДС" }, req);
      return;
    }
    if (body.status && ORDER_STATUSES.includes(body.status)) fields.status = body.status;
```

- **Сценарий сбоя:** клиент отправил `status: "completed"`, сервер ответил 200 со старым статусом. Админка проверяет статус на клиенте (`src/lib/orders-db.js:176`), так что риск — для будущих интеграций и старых вкладок.
- **Рекомендация:** 400 `invalid_status`, как это уже сделано для скидок.
- **Уверенность:** высокая.
- **Статус: исправлена** (коммит «fix: validation & frontend (audit pack 5)»). Что изменено: `server.js:1363` — поле `status` прислано, но его нет в списке → 400 `invalid_status` с текстом «Неизвестный статус заказа — обновите страницу…», заказ не меняется. Фильтр `?status=` в списке заказов не трогали — это параметр поиска, а не ввод данных. Админка: `src/admin/OrdersSection.jsx:74` — «Такого статуса заказа нет — обновите страницу и выберите статус из списка» вместо «Проверьте сервер». Тесты: `test/server-validation.test.js` («LOW-03…»), `src/admin/Dashboard.test.jsx` («LOW-03: сервер отклонил статус заказа»). До исправления падали.

---

### [LOW-04] [LOW] Количество в заказе молча исправляется (мусор → 1, больше максимума → максимум)

- **Файл:** `server.js:861`, `server.js:865`
- **Категория:** валидация
- **Код:**

```js
    const qty = Math.max(1, Math.floor(Number(raw.qty) || 1));
    lines.set(product.id, { product, qty: (lines.has(product.id) ? lines.get(product.id).qty : 0) + qty });
  }
  const items = Array.from(lines.values(), ({ product, qty }) => {
    const finalQty = allowsCartQty(product) ? Math.min(MAX_CART_QTY, qty) : 1;
```

- **Сценарий сбоя:** клиент заказал 150 шт. при максимуме 99 — в CRM записано 99, в сообщении WhatsApp клиента осталось 150. Расхождение незаметно.
- **Рекомендация:** отвечать 400 `qty_out_of_range` (корзина уже ограничивает количество на клиенте).
- **Уверенность:** средняя.
- **Статус: исправлена** (коммит «fix: validation & frontend (audit pack 5)»). Что изменено: `server.js:981` `buildCartItems` — количество должно быть целым от 1 до `maxQty` (999), для «штучных» услуг (менторство, регламенты) — ровно 1; сумма одной позиции, пришедшей несколькими строками, тоже не больше предела. Иначе — 400 `qty_out_of_range` с текстом (`server.js:1259`), заказ не создаётся. Отсутствующее количество — тоже ошибка. Валюта позиции сравнивается без подмены неизвестной на KZT (`EUR` → `catalog_changed`). Корзина: `src/components/CartDrawer.jsx:28` — текст `cart.status.qty_out_of_range` («Количество в корзине больше допустимого… Корзина обновлена…») и обновление каталога, как при `catalog_changed`. Обычная корзина таких запросов не шлёт (количество ограничено на клиенте), ошибка возможна, только если правила каталога поменялись, пока страница была открыта. Тесты: `test/server-validation.test.js` («LOW-04…»), `src/components/CartDrawer.test.jsx`. До исправления падали.

---

### [LOW-05] [LOW] Любая ошибка чтения статического файла отдаётся как 404 без записи в журнал

- **Файл:** `server.js:1555-1559`
- **Категория:** HTTP / неверный статус
- **Код:**

```js
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    if (!res.headersSent) sendText(res, 404, "Not found");
    else res.destroy();
  });
```

- **Сценарий сбоя:** `EACCES` или `EMFILE` на `dist/assets/*.js` — посетитель получает 404 вместо 500, сайт не загружается, в журнале пусто, оповещение не отправляется.
- **Рекомендация:** 404 только для `ENOENT`, иначе — 500, `console.error` и `notifier.serverError`.
- **Уверенность:** высокая.
- **Статус: исправлена** (коммит «fix: server errors & health (audit pack 4)»). Что изменено: отдача файлов вынесена в `runtime/static-file.js` (`createFileSender`, подключение — `server.js:1662`). `ENOENT` и `EISDIR` — 404 без записи в журнал; любая другая ошибка (`EACCES`, `EMFILE`, `EIO`…) — 500, `console.error` с `requestId`, путём и кодом, `notifier.serverError` (путь без query). Заголовки отправляются с первыми данными файла, а не при открытии: в Windows папка открывается без ошибки, и `EISDIR` приходит только при чтении. Ошибка после начала ответа — запись в журнал и `res.destroy()`. Тесты: `runtime/test/static-file.test.js` (200, 404 для ENOENT и папки, 500 для EACCES с журналом и оповещением, обрыв в середине). До исправления модуля не было — тесты падали.

---

### [LOW-06] [LOW] Принудительный выход при остановке считается штатным (`exit(0)`), ошибка закрытия документов проглатывается

- **Файл:** `server.js:1888-1898`
- **Категория:** поглощённая ошибка
- **Код:**

```js
function shutdown(signal) {
  console.log(`${signal}: останавливаю сервер...`);
  server.close(async () => {
    if (documents) await documents.close().catch(() => {});
    if (store) store.close();
    if (fileLog) fileLog.close();
    process.exit(0);
  });
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 50000).unref();
}
```

- **Сценарий сбоя:** зависший запрос не даёт закрыть сервер — через 50 с процесс выходит с кодом 0, база не закрыта штатно (WAL переживёт, но в журнале это выглядит как нормальная остановка).
- **Рекомендация:** при выходе по таймеру писать предупреждение и использовать ненулевой код; логировать ошибку `documents.close()`.
- **Уверенность:** высокая.
- **Статус: исправлена** (коммит «fix: server errors & health (audit pack 4)»). Что изменено: `runtime/shutdown.js` — `createShutdown` (подключение — `server.js:2037`). Выход по таймеру 50 с: предупреждение «Сервер не остановился за 50 с: зависли запросы, база закрыта не штатно. Выход принудительно (код 1)» и код 1. Ошибка `documents.close()` пишется в журнал («Остановка: не удалось закрыть модуль документов…»), база и журнал всё равно закрываются, код 0 — остановка запрошена штатно, и `run-server.bat` не должен перезапускать сервер. Ошибка `store.close()` тоже пишется. Тесты: `runtime/test/shutdown.test.js` (три теста LOW-06). До исправления падали.

---

### [LOW-07] [LOW] В журнал ошибок попадают персональные данные из строки запроса

- **Файл:** `server.js:1803`
- **Категория:** логирование / персональные данные
- **Код:**

```js
    console.error(`[${req.id}] ${req.method} ${req.url}:`, err);
    notifier.serverError(req.method, req.url, err);
    sendJson(res, 500, { error: "server_error", message: "Внутренняя ошибка сервера" }, req);
```

- **Сценарий сбоя:** `GET /api/orders?q=Иванов 7701…` при ошибке пишет имя и телефон в журнал, который хранится 14 дней и копируется при переносах. В оповещение Telegram они не попадают (`routeOf` отрезает query), а в локальный журнал — попадают.
- **Рекомендация:** логировать `url.pathname` без query или маскировать параметр `q`.
- **Уверенность:** высокая.
- **Статус: исправлена** (коммит «fix: server errors & health (audit pack 4)»). Что изменено: `server.js:753` — `requestPath(req)`: путь без `?…` и `#…`. Все места, где `req.url` попадал в журнал или оповещение (поиск `req.url`, `request.url`, `originalUrl` по серверному коду):
  1. глобальный обработчик — `console.error` и `notifier.serverError` (`server.js:1935-1936`);
  2. `notifyAiError` — `notifier.serverError` для не-ИИ ошибок (`server.js:1872`);
  3. новые места пакета: отдача статики при ошибке чтения (`server.js:1664`) и сбой в обработчике ошибок (`server.js:1944`).
  Остальные `req.url` в журнал не пишут: `server.js` — разбор адреса в `new URL(...)`; `ai/test/*` — тестовые серверы; `scripts/i18n-html.mjs` (`ctx.originalUrl`) — dev-сервер Vite. Журнал ИИ (`ai/plugins/logger.js`) и `[client-error]` (`notify/client-errors.js`) адрес запроса не пишут или чистят сами. Тест: `test/server-errors.test.js` — запросы `?phone=77011234567` и `?q=Иванов` при ошибке 500 оставляют в журнале только путь. До исправления падал.

---

### [LOW-08] [LOW] Неверные числовые настройки ИИ молча заменяются значениями по умолчанию

- **Файл:** `ai/config.js:3-6`
- **Категория:** фолбэк переменных окружения
- **Код:**

```js
/** Все настройки ядра в одном месте; значения по умолчанию рассчитаны на один сервер. */

function num(value, fallback, min = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? n : fallback;
}
```

- **Сценарий сбоя:** `AI_DAILY_TOKENS=1 000 000` (с пробелами) → значение по умолчанию вместо заданного лимита, без предупреждения. Владелец уверен, что задал свой бюджет.
- **Рекомендация:** при непустом, но неверном значении писать `console.warn` с именем переменной.
- **Уверенность:** высокая.
- **Статус: исправлена** (коммит «fix: security & config (audit pack 1)»). Что изменено: `ai/config.js:2-9` — `num(env, name, fallback, min)` читает значение через общий `readNumber` из `config/values.js`; при неверном значении пишет `console.warn("ИИ: AI_DAILY_TOKENS=1 000 000 — нужно число не меньше 0 … Используется значение по умолчанию: 3000000.")` и сервер не останавливает; `ai/config.js:21-56` — все вызовы передают имя переменной. Изменение поведения: пустая строка (`AI_DAILY_TOKENS=`) раньше превращалась в 0 («без лимита»), теперь — в значение по умолчанию. Тесты: `ai/test/config.test.js` (2 теста; до исправления оба падали).

---

### [LOW-09] [LOW] Описание изображений для ИИ при ошибке молча пустое

- **Файл:** `ai/features/consultant.js:81-92`
- **Категория:** поглощённая ошибка
- **Код:**

```js
  const controller = new AbortController();
  const pending = ctx
    .complete(
      [
        { role: "system", content: IMAGE_NOTES_PROMPT },
        { role: "user", content },
      ],
      { temperature: 0.2, maxTokens: 300, signal: controller.signal }
    )
    .then((text) => String(text || "").trim().slice(0, 1500))
    .catch(() => "");
```

- **Сценарий сбоя:** ошибка vision-запроса — ответ ИИ строится без учёта присланной фотографии, клиент получает ответ «мимо». Плагин-логгер ядра вызов зафиксирует, но связи с ответом не будет.
- **Рекомендация:** при ошибке добавлять в промпт пометку «изображения не удалось разобрать», чтобы ИИ попросил описать их словами.
- **Уверенность:** средняя.
- **Статус: открыта.**

---

### [LOW-10] [LOW] Сбой чтения суточного бюджета ИИ обнуляет расход

- **Файл:** `ai/lib/budget.js:56-72`
- **Категория:** скрытый фолбэк
- **Код:**

```js
    if (!state) {
      let saved = null;
      try {
        saved = storage && typeof storage.load === "function" ? storage.load() : null;
      } catch (err) {
        console.error("AI-бюджет: не удалось прочитать расход:", err.message);
      }
      state =
        saved && saved.day === day && Number.isFinite(Number(saved.spent))
          ? { ...fresh(day), spent: Number(saved.spent), calls: Number(saved.calls) || 0, rejected: Number(saved.rejected) || 0 }
          : fresh(day);
```

- **Сценарий сбоя:** после перезапуска с ошибкой чтения настроек (или повреждённым значением `ai_budget`, которое `settings.get` молча превращает в `null`, см. LOW-11) счётчик токенов на сегодня начинается с нуля, суточный лимит может быть превышен до двух раз. Ошибка чтения логируется, повреждённое значение — нет.
- **Рекомендация:** при ошибке чтения считать бюджет исчерпанным (fail-closed) или повторять чтение.
- **Уверенность:** высокая.
- **Статус: открыта.**

---

### [LOW-11] [LOW] Повреждённое значение настройки молча становится `null`

- **Файл:** `db/store.js:1114-1123`
- **Категория:** поглощённая ошибка / БД
- **Код:**

```js
  const settings = {
    /** @returns {object | null} значение, сохранённое как JSON */
    get(key) {
      const row = sql.settingGet.get(str(key));
      if (!row) return null;
      try {
        return JSON.parse(row.value);
      } catch {
        return null;
      }
    },
```

- **Сценарий сбоя:** повреждена настройка — реквизиты компании пустые (см. MED-10), секрет подписи истории ИИ сгенерируется заново (старые подписи станут недействительны), отметки о выполненных миграциях потеряются, и миграции запустятся повторно. Ничего не логируется.
- **Рекомендация:** `log.error` с ключом настройки.
- **Уверенность:** средняя.
- **Статус: открыта.**

---

### [LOW-12] [LOW] Отсутствующий ключ перевода в продакшене молча показывается как технический ключ

- **Файл:** `src/i18n/index.js:79-84`
- **Категория:** скрытый фолбэк
- **Код:**

```js
function format(key, values, lang) {
  const resolved = resolveMessage(key, lang);
  if (!resolved) {
    if (import.meta.env?.DEV) console.warn("i18n: нет ключа " + key);
    return key;
  }
```

- **Сценарий сбоя:** посетитель видит на кнопке `cart.status.error` вместо текста. Частично ловится `scripts/i18n-check.mjs`, но эта проверка не входит в `npm test` и `npm run build`.
- **Рекомендация:** подключить `i18n-check` к `prebuild`.
- **Уверенность:** средняя.
- **Статус: исправлена** (коммит «fix: validation & frontend (audit pack 5)»). Что изменено: `package.json` — `node scripts/i18n-check.mjs` входит в `npm test` (между серверными тестами и `vitest`), а `prebuild` начинается с `npm run i18n:check`; сборка Docker запускает и то и другое. Сама проверка раньше не находила главного — ключа, которого нет в словаре. Теперь `scripts/i18n-check.mjs` (`createKeyChecker`) проверяет каждую строку в коде витрины, похожую на ключ из словаря (`"cart.status.error"`, значения таблиц вроде `CHECKOUT_ERROR_TEXT`): если такого ключа нет в `ru.json` и это не префикс существующих ключей — ошибка с файлом и строкой. Ключи, собранные шаблонной строкой (`` `catalog.category.${id}.title` ``), не проверяются. На текущем коде ошибок нет — недостающих ключей не нашлось; новый ключ `cart.status.qty_out_of_range` (LOW-04) добавлен в `ru.json` и `kk.json`. Параметр `--root` — для тестов. Тесты: `test/i18n-check.test.js` (неизвестный ключ — код 1; префиксы и шаблоны — не ошибка; проверка подключена к `npm test` и `prebuild`). До исправления падали (кроме контрольного «все ключи есть…»).

---

### [LOW-13] [LOW] Предпросмотр печати и подписи в админке при ошибке показывает «не загружена»

- **Файл:** `src/admin/CompanySection.jsx:37-43`
- **Категория:** фронтенд / ошибка выглядит как пустое состояние
- **Код:**

```jsx
    let alive = true;
    let objectUrl = "";
    companyImageUrl(kind)
      .then((value) => {
        objectUrl = value;
        if (alive) setUrl(value);
        else URL.revokeObjectURL(value);
      })
      .catch(() => {});
```

- **Сценарий сбоя:** временная ошибка сети или сервера — менеджер видит, что печать «не загружена», и загружает её повторно, хотя она есть.
- **Рекомендация:** отдельное состояние «не удалось загрузить предпросмотр».
- **Уверенность:** высокая.
- **Статус: исправлена** (коммит «fix: frontend errors & data truth (audit pack 3)»). Что изменено: `src/admin/CompanySection.jsx:28` — `CompanyImage` различает «не загружена» (файла в настройках нет), «загружается», картинку и ошибку «Не удалось загрузить предпросмотр» с кнопкой «Повторить» (повторный запрос с новым адресом). Тест: `src/admin/CompanySection.test.jsx`; до исправления падал.

---

### [LOW-14] [LOW] Ошибка декодирования фото описывается как «Фото слишком большое»

- **Файл:** `src/admin/ProductModal.jsx:67-75`, `src/admin/image.js:64-68`
- **Категория:** вводящее в заблуждение сообщение
- **Код:**

```jsx
    if (!file || !file.type.startsWith("image/")) return;
    try {
      const dataUrl = await compressImageFile(file);
      setForm((prev) => ({ ...prev, image: dataUrl, imageUrl: "" }));
    } catch {
      notify("Фото слишком большое. Выберите файл меньше 1.2 МБ или сожмите изображение.");
    }
```

```js
  } catch (err) {
    if (err && err.message === "image_too_large") throw err;
    if (file.size > MAX_PHOTO_BYTES) throw new Error("image_too_large");
    return readFileAsDataUrl(file);
  }
```

- **Сценарий сбоя:** HEIC с iPhone больше 1,2 МБ — браузер (кроме Safari) не может его декодировать (`bad_image`), `compressImageFile` превращает это в `image_too_large`, менеджер видит «слишком большое», сжимает файл, а проблема в формате. Маленький HEIC проходит без сжатия, и сервер отвечает «неверный формат» уже при сохранении.
- **Рекомендация:** различать «формат не поддерживается браузером» и «слишком большой файл».
- **Уверенность:** средняя.
- **Статус: исправлена** (коммит «fix: validation & frontend (audit pack 5)»). Что изменено: `src/admin/image.js` — `compressImageFile` бросает `unsupported_format`, если браузер не может открыть файл (HEIC в Chrome, повреждённый файл, не картинка), и `image_too_large`, только если картинка открылась, но и после сжатия больше 1.2 МБ. Файлы в форматах, которых сервер не принимает (HEIC, TIFF, BMP), больше не отправляются как есть даже маленькими — их перекодирует браузер (Safari открывает HEIC и превращает в JPEG), иначе — `unsupported_format` сразу, а не «неверный формат» при сохранении. HEIC без MIME-типа (так бывает в Windows) узнаётся по расширению — раньше выбор такого файла молча игнорировался. `src/admin/ProductModal.jsx:7` — два разных сообщения: «Этот формат фото браузер не открывает (например, HEIC с iPhone). Сохраните фото как JPG или PNG…» и «Фото слишком большое: даже после сжатия больше 1.2 МБ…». Тесты: `src/admin/ProductModal.test.jsx` (3 теста LOW-14); тесты HEIC до исправления падали, «слишком большое» — контрольный.

---

### [LOW-15] [LOW] Ответ API не того формата молча становится пустым списком

- **Файл:** `src/lib/orders-db.js:146`, `src/lib/orders-db.js:169`, `src/lib/orders-db.js:184-187`
- **Категория:** маскирующий фолбэк
- **Код:**

```js
  const data = await res.json();
  const list = Array.isArray(data) ? data : [];
// ...
    items: Array.isArray(data.items) ? data.items : [],
// ...
export async function listClients() {
  const data = await request("/api/clients", { admin: true });
  return Array.isArray(data) ? data : [];
}
```

- **Сценарий сбоя:** прокси вернул JSON-заглушку с кодом 200 или формат ответа изменился после обновления — в CRM «нет заказов» или «нет клиентов» вместо ошибки.
- **Рекомендация:** бросать `apiError("invalid_response")`.
- **Уверенность:** средняя.
- **Статус: исправлена** (коммит «fix: frontend errors & data truth (audit pack 3)»). Что изменено: `src/lib/api.js:81` — `invalidResponseError()` (код `invalid_response`, текст «Сервер ответил в неожиданном формате») и `readJson(res)`; `src/lib/orders-db.js:50` — `asList` и проверки в `listOrders`, `listOrdersPage` (не объект или `items` не массив), `listClients` бросают ошибку вместо `[]`; так же `listOrderDocuments` в `src/admin/documents-api.js` и `fetchProducts` в `src/lib/products-api.js`. Места вызова проверены: заказы → `ordersError` в `Dashboard.jsx`, клиенты → `clientsError` (HIGH-06), товары → баннер (HIGH-07), документы заказа → сообщение об ошибке в `OrderDocuments.jsx`, витрина → копия или «Каталог временно недоступен» (MED-11). Тест: `src/lib/data-api.test.js`; до исправления падал.

---

### [LOW-16] [LOW] Общий `catch` в ИИ-чате не логирует ошибку

- **Файл:** `src/chat/ChatWidget.jsx:275-279`
- **Категория:** поглощённая ошибка
- **Код:**

```jsx
      const matched = findProductByQuery(products, normalize(value));
      if (matched) {
        setQuickSection((prev) => matched.category || prev);
        setAfterConsult(true);
      }
    } catch {
      setTyping(false);
      push("bot", t("chat.parse_failed"));
      setHandoff(true);
```

- **Сценарий сбоя:** исключение в офлайн-боте или в `findProductByQuery` — посетителю предлагают менеджера (это хорошо), но причина нигде не видна.
- **Рекомендация:** `console.error(err)` и отправка на сервер (см. HIGH-10).
- **Уверенность:** высокая.
- **Статус: исправлена** (коммит «fix: frontend errors & data truth (audit pack 3)»). Что изменено: `src/chat/ChatWidget.jsx:277` — в `catch` вызывается `reportClientError(err, { kind: "chat" })` (пишет `console.error` и отправляет на `POST /api/client-errors`); посетителю по-прежнему предлагают менеджера. Тест: `src/chat/ChatWidget.test.jsx`; до исправления падал.

---

### [LOW-17] [LOW] Перенос данных из Docker: ошибка копирования загруженных фото подавляется

- **Файл:** `scripts/switch-data.ps1:184`, `scripts/switch-data.ps1:188`
- **Категория:** поглощённая ошибка / скрипты
- **Код:**

```powershell
    Rename-Item $HostData $old
    Move-Item (Join-Path $stage "data") $HostData
    Copy-Item (Join-Path $stage "uploads\*") $HostUploads -Recurse -Force -ErrorAction SilentlyContinue
    Write-Marker (Join-Path $stage $MarkerName) $WindowsNote
    Invoke-InImage @("${stage}:/stage:ro") @("cp", "/stage/$MarkerName", "/app/data/$MarkerName") "Отметка в Docker" | Out-Null
    Invoke-Checked "Удаление контейнера" compose -f $ComposeFile down | Out-Null
    Remove-Item -Recurse -Force $stage
```

- **Сценарий сбоя:** заблокированный файл или нехватка места — часть фото не скопирована, промежуточная папка удаляется, скрипт пишет «Данные перенесены из Docker в папку data и проверены» (проверяется только число записей базы). Фото остаются в Docker-томе, но сайт на Windows показывает битые картинки.
- **Рекомендация:** без `SilentlyContinue`; сравнивать число файлов в uploads до и после копирования.
- **Уверенность:** высокая.
- **Статус: открыта.**

---

### [LOW-18] [LOW] Перезапуск службы убивает node через 5 секунд, а сервер рассчитан на 50 секунд штатной остановки

- **Файл:** `scripts/windows-service.ps1:44-55`
- **Категория:** фоновые задачи
- **Код:**

```powershell
function Stop-Site {
  if (Get-Task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
  $port = Get-SitePort
  for ($i = 0; $i -lt 10; $i++) {
    # ...
    if (-not $nodes.Count) { return }
    if ($i -eq 5) { $nodes | Stop-Process -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
  }
}
```

- **Сценарий сбоя:** `update-site.bat` во время ответа ИИ или выпуска PDF — запрос обрывается, клиент получает сетевую ошибку. Данные целы (SQLite + WAL), но ошибка незаметна. В Docker-режиме не применяется (там `stop_grace_period: 60s`).
- **Рекомендация:** ждать до 50–60 с, как `stop_grace_period` в Docker.
- **Уверенность:** средняя.
- **Статус: исправлена** (коммит «fix: server errors & health (audit pack 4)»). Что изменено:
  - Одного ожидания мало: в Windows у node нет SIGTERM, и раньше сервер никто не просил остановиться штатно. Теперь `scripts/windows-service.ps1` (`Stop-Site`) создаёт файл `server.stop`. Сервер проверяет его раз в секунду (`watchStopFile` в `runtime/shutdown.js`, `server.js:2031`) и выполняет ту же штатную остановку, что по SIGTERM: ждёт запросы, закрывает базу, код 0. После этого `run-server.bat` завершается без перезапуска. Файл, оставшийся от прошлого запуска, сервер удаляет при старте.
  - `Stop-Site` ждёт выхода node до 60 с (`-StopTimeoutSeconds`, как `stop_grace_period: 60s` в Docker). Только после этого node завершается принудительно, со строкой `stop: server did not exit within 60 s, killing node (pid …)` в `server-run.log`. Задача планировщика снимается после остановки node. Новое действие `windows-service.ps1 stop`; `restart`, `uninstall` и `install` используют тот же `Stop-Site`.
  - Тесты: `runtime/test/shutdown.test.js` («watchStopFile…»), `test/server-errors.test.js` («LOW-18: файл server.stop…»), `test/windows-service-stop.test.js` (штатная остановка и принудительная после 2 с; своё имя задачи, настоящую службу не трогает; только Windows). До исправления падали.

---

### [LOW-19] [LOW] Заказы удаляются физически, без журнала действий

- **Файл:** `server.js:1252-1260`
- **Категория:** БД / аудит действий
- **Код:**

```js
  if (req.method === "DELETE" && orderId) {
    if (!requireAdmin(req, res)) return;
    if (!store.orders.remove(orderId)) {
      sendJson(res, 404, { error: "not_found" }, req);
      return;
    }
    sendJson(res, 200, { ok: true }, req);
    return;
  }
```

- **Сценарий сбоя:** заказ удалён по ошибке или посторонним с паролем — восстановить можно только из бэкапа за прошлые сутки, кто и когда удалил — неизвестно.
- **Рекомендация:** мягкое удаление или запись в журнал действий (id заказа, IP, время).
- **Уверенность:** высокая.
- **Статус: открыта.**

---

### [LOW-20] [LOW] Ошибка записи журнала отправки после успешной отправки документа приводит к 500 и повторной отправке

- **Файл:** `documents/http.js:150-175`
- **Категория:** транзакционность / внешний API
- **Код:**

```js
    } catch (err) {
      if (attachment.documentId) {
        documents.logSend({ documentId: attachment.documentId, channel, recipient: String(body.to || ""), ok: false, error: err.message });
      }
      log.warn("PDF: отправка не удалась: " + err.message);
      throw err;
    }
    if (attachment.documentId) {
      documents.logSend({ documentId: attachment.documentId, channel, recipient: result.recipient, ok: true });
    }
    return sendJson(res, 200, { ok: true, ...result }, req);
```

- **Сценарий сбоя:** письмо или документ в Telegram уже ушли, а `documents.logSend` (запись в `document_sends`) бросает исключение — например, база занята (`SQLITE_BUSY`) или повреждена. Ошибка без `status` проходит через `sendError` (`documents/http.js:50-53`, `if (!status) throw err`) в глобальный обработчик — менеджер видит 500, клиенту письмо пришло. Менеджер нажимает «Отправить» ещё раз — клиент получает дубль. Во ветке ошибки отправки та же проблема: если `logSend` в `catch` бросит исключение, исходная причина сбоя отправки потеряется.
- **Рекомендация:** после успешной отправки ошибку записи журнала только логировать (`log.error`), клиенту отвечать «отправлено»; в ветке ошибки оборачивать `logSend` в `try/catch`.
- **Уверенность:** высокая — путь в коде подтверждён; сам сбой записи маловероятен.
- **Статус: исправлена** (коммит «fix: documents (audit pack 2)»). Что изменено:
  - `documents/http.js:180-189` — `logSendSafely()`: ошибка записи журнала отправок только пишется в `log.error` (документ, канал, отправлен/не отправлен, причина).
  - `documents/http.js:173-176` — после успешной отправки менеджер получает 200 «отправлено», даже если журнал не записался — повторной отправки дубля не будет.
  - `documents/http.js:166-171` — в ветке ошибки отправки `logSend` тоже через `logSendSafely`: менеджер видит исходную причину (например, ошибку SMTP), а не ошибку базы.
  - Тесты: `documents/test/documents.test.js` — «LOW-20: письмо ушло, а журнал отправок не записался…» и «LOW-20: отправка не удалась и журнал тоже…». До исправления оба падали.

---

### [LOW-21] [LOW] `check:prod` не проверяет то, что ломается молча

- **Файл:** `server.js:120-143`, `package.json:22`
- **Категория:** конфигурация
- **Код:**

```js
function productionProblems() {
  const problems = [];
  const withoutUrl = SITES.filter((site) => !site.url);
  if (withoutUrl.length === SITES.length) {
    problems.push("Домен сайта не задан: добавьте в .env строку SITE_DOMAIN=ваш-домен.kz (без https://).");
  }
  // ... TRUST_PROXY, собран ли сайт и для какого адреса
  return problems;
}
```

- **Сценарий сбоя:** «К публикации готово» выводится при отсутствующем ключе ИИ, без настроенного канала Telegram/SMTP (а значит, и без оповещений HIGH-01/HIGH-10), со стоковым портфолио (HIGH-09). До исправления CRIT-01 не ловилась и заглушка контакта Telegram.
- **Рекомендация:** добавить предупреждения по этим пунктам.
- **Уверенность:** высокая.
- **Статус: исправлена** (коммит «fix: security & config (audit pack 1)»). Что изменено:
  - новый модуль `config/production.js` (строки 1-48): `integrationProblems(env)` — не задан `OPENAI_API_KEY`; не задан `TELEGRAM_BOT_TOKEN` или `TELEGRAM_CHAT_ID` (оповещения выключены); `contentProblems({ portfolio, catalog })` — в `src/content/portfolio.js` есть `images.unsplash.com`; `CONTACT_TELEGRAM` в `src/lib/catalog.js` пустой, равен `bazis` (в любом регистре, с `@`) или не найден;
  - `server.js:155-161` — `productionProblems()` добавляет эти пункты; `server.js:166-174` — `readSourceFile` читает исходники, отсутствующий файл (в Docker-образе нет `src/`) пропускается.
  - Предупреждения выводятся при старте сервера и в `npm run check:prod`; в `check:prod` любой пункт означает «К публикации не готово» и код 4.
  - Тесты: `test/server-config.test.js` (3 теста на копии проекта с подставленными файлами портфолио и каталога), `config/test/config.test.js` (2 теста). До исправления два теста с заглушками падали.
  - **Поправка в пакете 2** (коммит «fix: documents (audit pack 2)»): портфолио показывает только «Базис Медиа» (`src/pages/MediaHomePage.jsx`), поэтому стоковые фото проверяются, только если медиасайт опубликован. Признак — у медиасайта есть публичный домен: `MEDIA_SITE_URL`, `url` в `shared/sites.json` или `SITE_DOMAIN` (тогда медиасайт получает `media.<домен>`). `config/production.js:24-37` — параметр `mediaPublished` (по умолчанию `false`); `server.js:157-163` — `mediaPublished: media.publicHosts.length > 0`. Отдельного флага «медиасайт закрыт» нет: при заданном `SITE_DOMAIN` медиасайт публикуется всегда — предложение, как его задать, в отчёте по пакету 2. Тесты: «LOW-21: медиасайт без домена (не опубликован) — о стоковом портфолио не предупреждаем» (`test/server-config.test.js`) и «contentProblems: медиасайт не опубликован…» (`config/test/config.test.js`); до поправки оба падали. В тесте со стоковым портфолио задан `SITE_DOMAIN=example.kz`.
  - **Поправка в пакете 3** (коммит «fix: frontend errors & data truth (audit pack 3)»): признак «медиасайт опубликован» теперь — `MEDIA_SITE_ENABLED=true` (`server.js:166` — `mediaPublished: MEDIA_ENABLED`). По умолчанию медиасайт выключен, и портфолио не проверяется даже при заданном `SITE_DOMAIN`. Тесты: «HIGH-09: медиасайт выключен (MEDIA_SITE_ENABLED не задан) — даже с доменом стоковое портфолио не проверяется» (`test/server-config.test.js`); в тесте со стоковым портфолио теперь задан ещё `MEDIA_SITE_ENABLED=true`. См. HIGH-09.

---

### [LOW-22] [LOW] Нет тестов для HTTP-слоя `server.js` и фронтенда; код не был под версионным контролем

- **Файл:** `package.json:21`
- **Категория:** подавление проверок / процесс
- **Код:**

```json
"test": "node --test \"ai/test/*.test.js\" \"antispam/test/*.test.js\" \"auth/test/*.test.js\" \"config/test/*.test.js\" \"db/test/*.test.js\" \"documents/test/*.test.js\" \"logging/test/*.test.js\" \"notify/test/*.test.js\" \"security/test/*.test.js\"",
"check:prod": "node server.js --check-config --production",
```

- **Сценарий сбоя:** тесты покрывают модули, но не маршруты `server.js` (≈1920 строк, вся логика заказов и товаров) и не React-код. Регрессии вроде HIGH-03 и HIGH-06 тестами не ловятся. Сквозная проверка `scripts/docker-e2e.ps1` есть, но запускается вручную. На момент аудита каталог не был git-репозиторием — откатить неудачное обновление было нечем.
- **Рекомендация:** git и удалённый репозиторий; несколько интеграционных тестов `server.js` (создание заказа, товара, ошибка записи файла).
- **Уверенность:** высокая.
- **Статус: открыта (частично устранена).** Сделано: git-репозиторий (`main`, коммиты `d7f0347`, `cfbf64c`), `.gitignore` без секретов и данных; добавлены 9 тестов `notify/test/notify.test.js`. Остаётся: нет удалённого репозитория (копия кода только на этом компьютере); нет тестов маршрутов `server.js` и фронтенда.

> Подавлений проверок в коде нет: поиск `eslint-disable`, `@ts-ignore`, `@ts-nocheck`, `it.skip`, `describe.skip`, `test.skip`, `.only(`, `xit(` ничего не нашёл. `forEach(async` / `.map(async` не встречаются. ESLint и TypeScript в проекте не используются.

---

## 5. Прохождение критических сценариев (этап 2)

| Сценарий | Что проверено | Итог |
|---|---|---|
| **Авторизация админки** | `server.js:925-951`, `auth/admin-password.js` | Сравнение пароля за постоянное время, лимит неверных попыток, запрет HTTP через прокси — хорошо. MED-01 (лимит отключался опечаткой) и MED-02 (обход через `POST /api/orders`) — исправлены в пакете 1 |
| **Оформление заказа (корзина)** | `CartDrawer.jsx:116-220`, `server.js:1085-1168`, `antispam/order-guard.js` | Хорошо: идемпотентный id, транзакция, проверка цен и остатков, ошибки показываются клиенту. CRIT-01 — исправлена; HIGH-01 — исправлена в коде; LOW-04 — исправлена (пакет 5) |
| **Заявка с формы «Контакты»** | `ContactSection.jsx`, `server.js:1113-1168` | Ошибки показываются пользователю. HIGH-01 — исправлена в коде (оповещение после сохранения) |
| **Заявка из ИИ-чата** | `src/chat/handoff-lead.js`, `ChatWidget.jsx` | MED-13 исправлена в пакете 5: недошедшая заявка досылается из `localStorage` при следующем визите |
| **CRUD товаров** | `server.js:1355-1470`, `ProductModal.jsx`, `products-api.js` | Конфликт остатков (409) сделан хорошо. HIGH-03 (пакет 4), HIGH-07 (пакет 3), MED-14, LOW-02, LOW-14 (пакет 5) исправлены |
| **CRUD клиентов и заказов в CRM** | `Dashboard.jsx`, `OrdersSection.jsx`, `ClientsSection.jsx`, `orders-db.js` | Заказы: ошибка показывается. Клиенты: HIGH-06. LOW-03 (пакет 5) и LOW-15 исправлены; открыта LOW-19 |
| **Загрузка файлов** (фото товаров, печать/подпись, вложения чата) | `server.js:372-415`, `documents/images.js`, `ai/lib/attachments*.js` | Проверка сигнатуры и размера — хорошо. HIGH-03 и LOW-01 исправлены; открыты MED-08, MED-09 |
| **Документы и PDF** | `documents/*` | Нумерация в транзакции, рендер в worker с таймаутом — хорошо. HIGH-05, MED-04, MED-10, LOW-20 — исправлены в пакете 2, MED-05 — в пакете 1 |
| **E-mail / Telegram-отправка документов** | `documents/send.js`, `documents/http.js` | Таймауты есть, ошибки показываются менеджеру и пишутся в журнал, токен скрывается — хорошо. LOW-20 — исправлена в пакете 2 |
| **Оповещения владельцу** | `notify/index.js`, `server.js` | Добавлены в `cfbf64c`: очередь, антиспам, сбой Telegram не ломает заказ. Выключены, пока не заданы переменные `.env` |
| **Внешний ИИ** | `ai/*`, `src/chat/*` | Таймауты, повторы, breaker, бюджет — хорошо. HIGH-08 (частично), MED-07, MED-08, MED-09, LOW-08, LOW-09, LOW-10, LOW-16 |
| **Фоновые задачи** | бэкап, миграции, перенос картинок, планировщик, Docker | Миграции в транзакции с предварительной копией — хорошо. HIGH-04 (частично), LOW-17; MED-12, MED-15, LOW-18 исправлены в пакете 4 |
| **Фронтенд: состояния загрузки/ошибки/пустоты** | все `src/admin/*`, `src/components/*`, `src/pages/*` | Разделы заказов, отчётов, документов, отправки разделяют загрузку, ошибку и пустоту корректно. HIGH-02, HIGH-06, HIGH-07, MED-11, LOW-13, LOW-15 — исправлены в пакете 3. Бесконечной загрузки не найдено: `fetch` к ИИ с таймаутом (`src/chat/cloud.js`), остальные запросы короткие |
| **Платежи / вебхуки / cron** | — | В проекте отсутствуют (cron заменён `setInterval` и планировщиком Windows) |
| **Логирование и мониторинг** | `logging/file-log.js`, `server.js`, плагины ИИ, `notify/` | HIGH-10 (частично); MED-06 и LOW-07 исправлены в пакете 4. Секреты в журналы не пишутся: токен Telegram скрывается (`documents/send.js`), пароль админки не логируется; оповещения чистятся `scrub` |
| **Конфигурация и запуск** | `config/*.js`, `server.js:86-160`, `.bat`, `.ps1` | Ошибки `.env` → код 4 без перезапуска, перенесённые данные → код 5 — хорошо. MED-01, MED-05, LOW-08, LOW-21 — исправлены в пакете 1 |

---

## 6. Повторяющиеся паттерны

Одни и те же приёмы встречаются в разных частях кода. Исправлять их лучше сразу везде, по одному правилу.

### П-1. `catch` без записи в журнал, возвращающий «пустое» значение (`null`, `{}`, `[]`, `""`)

Ошибка исчезает в месте возникновения, а дальше код ведёт себя так, будто данных просто нет.
**Где:** HIGH-05 (`readCompanyAsset` → `null`), MED-03 (`parseExtra` → `{}`), MED-04 (`loadSharp` → `null`), MED-08 (`loadUnpdf` → `null`), LOW-01 (удаление файла), LOW-09 (описание изображений → `""`), LOW-11 (`settings.get` → `null`), LOW-13 (`.catch(() => {})`), LOW-16 (catch в чате).
**Правило:** «нет данных» и «не удалось прочитать данные» — разные состояния. Во втором случае — хотя бы `console.error` с контекстом (ключ, id, путь), для дорогих последствий — ошибка наружу.

### П-2. Ошибка загрузки показывается как пустое состояние

Пользователь видит «нет клиентов», «не загружена», «нет заказов» вместо «не удалось загрузить».
**Где:** HIGH-06, LOW-13, LOW-15, LOW-12 (технический ключ вместо текста).
**Правило:** у каждого списка три состояния — загрузка, ошибка с кнопкой «Повторить», пустота. Образец уже есть в коде: `ordersError` в `Dashboard.jsx`.

### П-3. Подстановка демо-данных или заглушек вместо настоящих

**Где:** CRIT-01 (контакт Telegram, исправлена), HIGH-07 и MED-11 (`DEFAULT_PRODUCTS` в админке и на витрине), MED-07 (демо-каталог в промпте ИИ), MED-14 (стоковая картинка товара), HIGH-09 (стоковое портфолио).
**Правило:** демо-данные — только в режиме разработки или как заглушка на время загрузки; в продакшене при сбое — явная пометка или ошибка. Заглушки контента проверять в `check:prod` (LOW-21).

### П-4. Молчаливая нормализация ввода вместо ошибки 400

Неверное значение тихо заменяется «разумным», и запрос проходит.
**Где:** LOW-02 (валюта, категория), LOW-03 (статус заказа), LOW-04 (количество), MED-14 (пустая картинка → unsplash).
**Правило:** нормализация — только для миграции старых данных; новый ввод через API с неверным значением — 400 с понятным кодом. Образец уже есть: `orderAdjustments` → 400.

### П-5. Числовые и прочие настройки `.env` без проверки

`Number(x || default)` или `try { … } catch { по умолчанию }` без предупреждения.
**Где:** MED-01 (`NaN` отключает лимит), MED-05 (`DOCUMENTS_TZ`), LOW-08 (`num()` в настройках ИИ).
**Правило:** одна функция чтения настроек: непустое неверное значение → завершение с кодом 4 (как уже сделано для остальных ошибок `.env`) или как минимум предупреждение с именем переменной.

### П-6. Сбой виден только в локальном журнале

Ошибка логируется, но человек о ней не узнаёт.
**Где:** HIGH-04, HIGH-10, MED-06, MED-09, MED-12, MED-15, LOW-05; на фронтенде — HIGH-02, MED-13, LOW-16 (только консоль браузера посетителя).
**Правило:** после `cfbf64c` на сервере есть `notifier.alert(key, text)` с антиспамом — сбои, требующие действия человека, должны идти через него. Фронтенду нужен канал ошибок на сервер.

### П-7. Неверный HTTP-статус или код выхода

**Где:** HIGH-03 (ошибка диска → 400), LOW-05 (любая ошибка чтения → 404), HIGH-08 (401 апстрима пробрасывается посетителю), LOW-06 (принудительный выход → код 0).
**Правило:** 4xx — только для ошибок запроса клиента, всё остальное — 5xx через глобальный обработчик (там журнал и оповещение).

### П-8. Необязательная зависимость, ошибка загрузки которой проглатывается навсегда

**Где:** MED-04 (`sharp`), MED-08 (`unpdf`).
**Правило:** деградация допустима, но причину нужно один раз записать в журнал на старте или при первой загрузке.

### П-9. Частичный успех без компенсации

Действие наполовину выполнено, а пользователь видит ошибку или полный успех.
**Где:** LOW-20 (документ отправлен, журнал не записан → 500 → повторная отправка), MED-10 (номер счёта израсходован при пустых реквизитах), LOW-17 (база перенесена, фото — частично).
**Правило:** проверять предусловия до необратимого шага; после необратимого шага ошибки вспомогательных операций только логировать.

---

## 7. Намеренные (легитимные) фолбэки

Эти места выглядят как «проглоченные» ошибки, но сделаны осознанно. Каждое место описано отдельно. В колонке «строка прежней таблицы» — номер строки из прошлой редакции отчёта (30 строк). Строки 6, 9, 19, 21, 24, 27 и 28 объединяли несколько мест — здесь они разделены. Прошу подтвердить, что это желаемое поведение.

### FB-01. Ловушка для ботов: фиктивный успех без сохранения

- **Файл:** `server.js:1103-1107` (строка прежней таблицы: 1)
- **Код:**

```js
    if (guard.trap) {
      console.warn(`[${req.id}] Заказ с заполненным полем-ловушкой не сохранён (адрес ${ip})`);
      sendJson(res, 201, { id: newOrderId, status: "new" }, req);
      return;
    }
```

- **Что подставляет при сбое:** при заполненном скрытом поле отвечает 201 «заказ создан», хотя ничего не сохраняет.
- **Почему допустимо:** это антиспам-приём: бот не должен понять, что его распознали. Живой человек скрытое поле не заполняет.
- **Логируется ли:** да — `console.warn` с id запроса и IP.

### FB-02. Ошибка сжатия ответа — отдаём без сжатия

- **Файл:** `server.js:688-697` (строка прежней таблицы: 2)
- **Код:**

```js
  zlib.gzip(payload, (err, compressed) => {
    if (res.headersSent || res.destroyed) return;
    if (err) {
      res.writeHead(status, headers);
      res.end(payload);
      return;
    }
    res.writeHead(status, { ...headers, "Content-Encoding": "gzip", Vary: "Origin, Accept-Encoding" });
    res.end(compressed);
  });
```

- **Что подставляет при сбое:** тот же ответ без gzip.
- **Почему допустимо:** сжатие — оптимизация; клиент получает те же данные, только больше по размеру.
- **Логируется ли:** нет. Ошибка `zlib.gzip` на корректном буфере практически невозможна, запись не нужна.

### FB-03. Повреждённая встроенная картинка при миграции → картинка по умолчанию

- **Файл:** `server.js:284-307` (строка прежней таблицы: 3)
- **Код:**

```js
    let image = DEFAULT_PRODUCT_IMAGE;
    try {
      image = saveDataUrlImage(product.image);
    } catch (err) {
      console.warn(`Картинка товара «${product.title}» (${product.id}) повреждена (${err.code || err.message}) — заменена картинкой по умолчанию`);
    }
```

- **Что подставляет при сбое:** если старую картинку `data:` из базы нельзя сохранить в файл, у товара будет картинка по умолчанию.
- **Почему допустимо:** разовая миграция старых данных; битую картинку всё равно нельзя показать; запуск сервера не блокируется. Ошибка записи в базу при этом пробрасывается (строки 295-300).
- **Логируется ли:** да — `console.warn` с названием и id товара; итог — `console.log` с числом заменённых картинок.

### FB-04. Перенос картинок по внешним ссылкам: неудача → повтор при следующем запуске

- **Файл:** `server.js:540-558`, `server.js:1882-1884` (строка прежней таблицы: 4)
- **Код:**

```js
    } catch (err) {
      if (saved) deleteUploadIfOwned(saved);
      failed.push(`${product.id} (${err.code || err.message})`);
    }
  // ...
    console.warn(`Картинки по внешним ссылкам пока не перенесены (повтор при следующем запуске): ${failed.join(", ")}`);
  // ...
    localizeExternalImages(store).catch((err) => console.warn("Перенос картинок товаров:", err.message));
```

- **Что подставляет при сбое:** товар остаётся со ссылкой на внешнюю картинку (она продолжает показываться с CDN).
- **Почему допустимо:** фоновая оптимизация; витрина работает и без переноса; попытка повторяется при каждом запуске.
- **Логируется ли:** да — `console.warn` со списком id товаров и причиной.

### FB-05. Нет `AI_HISTORY_SECRET` — секрет создаётся и сохраняется в базе

- **Файл:** `server.js:1718-1725` (строка прежней таблицы: 5)
- **Код:**

```js
function aiHistorySecret() {
  const fromEnv = String(process.env.AI_HISTORY_SECRET || "").trim();
  if (fromEnv.length >= 16) return fromEnv;
  if (!store) return null;
  const saved = store.settings.get(AI_HISTORY_SECRET_KEY);
  if (typeof saved === "string" && saved.length >= 32) return saved;
  return store.settings.set(AI_HISTORY_SECRET_KEY, crypto.randomBytes(32).toString("base64url"));
}
```

- **Что подставляет при сбое:** при отсутствии или слишком коротком значении в `.env` — случайный секрет, сохранённый в настройках.
- **Почему допустимо:** секрет нужен только для подписи реплик ИИ в истории чата; случайный и постоянный секрет так же надёжен, как заданный вручную. Поведение задокументировано в комментарии.
- **Логируется ли:** нет (не ошибка, а штатная настройка по умолчанию). Риск — только в связке с LOW-11 (повреждённая настройка → новый секрет).

### FB-06. Не читается текст пояснения `DATA-MOVED.txt`

- **Файл:** `server.js:93-106` (строка прежней таблицы: 6, первая часть)
- **Код:**

```js
if (fs.existsSync(DATA_MOVED_FILE)) {
  let note = "";
  try {
    note = fs.readFileSync(DATA_MOVED_FILE, "utf8").trim();
  } catch {
    // текст пояснения не обязателен
  }
  console.error(
    `Сервер не запущен: данные из ${DATA_DIR} перенесены, эта копия устарела.\n` +
```

- **Что подставляет при сбое:** пустое пояснение; сервер всё равно не запускается (код 5).
- **Почему допустимо:** главное решение (не запускаться на устаревшей копии) принимается по самому факту наличия файла, текст — только подсказка.
- **Логируется ли:** причина остановки — да (`console.error`), ошибка чтения текста — нет (не влияет на результат).

### FB-07. Не читается `.build-info.json` сборки

- **Файл:** `server.js:109-117` (строка прежней таблицы: 6, вторая часть)
- **Код:**

```js
function readBuildInfo(site) {
  if (!fs.existsSync(path.join(site.distDir, "index.html"))) return { built: false, url: null };
  try {
    const info = JSON.parse(fs.readFileSync(path.join(site.distDir, BUILD_INFO_FILE), "utf8"));
    return { built: true, url: typeof info.url === "string" ? info.url : "" };
  } catch {
    return { built: true, url: null };
  }
}
```

- **Что подставляет при сбое:** «сайт собран, адрес сборки неизвестен» (`url: null`).
- **Почему допустимо:** `null` не скрывается — `productionProblems()` превращает его в предупреждение «собран без сведений об адресе: запустите update-site.bat» (строка 134).
- **Логируется ли:** да, косвенно — предупреждение при старте и в `check:prod`.

### FB-08. Ошибка чтения `.env` → работа на системных переменных

- **Файл:** `config/env.js:29-36` (строка прежней таблицы: 7)
- **Код:**

```js
function loadEnvFile(envPath, target = process.env) {
  try {
    for (const [key, val] of Object.entries(readEnvFile(envPath))) {
      if (target[key] == null) target[key] = val;
    }
  } catch (err) {
    console.warn("Не удалось прочитать .env:", err && err.message);
  }
}
```

- **Что подставляет при сбое:** только переменные окружения системы (в Docker они передаются через `env_file`).
- **Почему допустимо:** обязательные настройки дальше проверяются отдельно (пароль админки, `check:prod`); при их отсутствии сервер сообщает об этом и завершается с кодом 4.
- **Логируется ли:** да — `console.warn`.

### FB-09. Ошибка `ROLLBACK` игнорируется

- **Файл:** `db/store.js:347-353` (строка прежней таблицы: 8)
- **Код:**

```js
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // транзакция уже откатилась
      }
      throw err;
    } finally {
```

- **Что подставляет при сбое:** ничего — исходная ошибка пробрасывается дальше.
- **Почему допустимо:** SQLite сам откатывает транзакцию при некоторых ошибках (например, `SQLITE_FULL`), и повторный `ROLLBACK` бросает «no transaction is active». Важная ошибка не теряется.
- **Логируется ли:** исходная ошибка — да (глобальный обработчик), ошибка `ROLLBACK` — нет (она вторична).

### FB-10. Повреждённый `orders.json`, появившийся после перехода на SQLite, не импортируется

- **Файл:** `db/store.js:1309-1315` (строка прежней таблицы: 9, первая часть)
- **Код:**

```js
    let legacyOrders;
    try {
      legacyOrders = readLegacyJson("orders.json", ["orders", "clients"]);
    } catch (err) {
      log.warn(`⚠ ${err.message} Файл оставлен на месте, в базу из него ничего не добавлено.`);
      return;
    }
```

- **Что подставляет при сбое:** пропуск дозагрузки; файл остаётся на месте для ручного разбора.
- **Почему допустимо:** это дозагрузка «опоздавших» данных старого сервера; база при этом цела, файл не удаляется.
- **Логируется ли:** да — `log.warn` с причиной.

### FB-11. Старый JSON-файл не удалось отложить в архивную папку

- **Файл:** `db/store.js:1333-1337` (строка прежней таблицы: 9, вторая часть)
- **Код:**

```js
      try {
        fs.renameSync(path.join(dataDir, name), path.join(target, name));
      } catch (err) {
        log.warn(`Не удалось переместить ${name} в ${target}: ${err.message}. Файл больше не используется.`);
      }
```

- **Что подставляет при сбое:** файл остаётся в `data/`.
- **Почему допустимо:** данные из него уже в базе; перемещение — только уборка. Файл не удаляется.
- **Логируется ли:** да — `log.warn`.

### FB-12. Неверный курсор пагинации → `invalid_cursor` (400)

- **Файл:** `db/store.js:275-283`, `db/store.js:713-718`, `server.js:1194-1196` (строка прежней таблицы: 10)
- **Код:**

```js
function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    return typeof createdAt === "string" && typeof id === "string" ? { createdAt, id } : null;
  } catch {
    return null;
  }
}
```

- **Что подставляет при сбое:** `null`, который на строках 713-718 превращается в ошибку `invalid_cursor` → ответ 400.
- **Почему допустимо:** курсор приходит от клиента; ошибка не проглатывается, а возвращается клиенту с понятным кодом.
- **Логируется ли:** нет — это ошибка ввода клиента, не сервера.

### FB-13. PDF не записался в кэш — отдаётся без кэширования

- **Файл:** `documents/index.js:317` (строка прежней таблицы: 11)
- **Код:**

```js
      buffer = await renderer.render(doc.kind, {
        ...snap,
        // ...
      });
      await writeAtomic(file, buffer).catch((err) => log.warn("PDF: не удалось сохранить в кэш: " + err.message));
    }
```

- **Что подставляет при сбое:** PDF отдаётся пользователю, но в следующий раз будет собран заново.
- **Почему допустимо:** кэш — оптимизация, документ собирается из снимка в базе одинаково.
- **Логируется ли:** да — `log.warn`.

### FB-14. Нет логотипа — документ без логотипа

- **Файл:** `documents/index.js:134-149` (строка прежней таблицы: 12)
- **Код:**

```js
  let logoCache;
  function logo() {
    if (logoCache === undefined) {
      logoCache = null;
      for (const dir of ["public", "dist"]) {
        try {
          const buffer = fs.readFileSync(path.join(rootDir, dir, "brand", "logo.png"));
          logoCache = "data:image/png;base64," + buffer.toString("base64");
          break;
        } catch {
          /* следующий вариант */
        }
```

- **Что подставляет при сбое:** вместо логотипа — название компании текстом (`documents/templates/common.js:163`).
- **Почему допустимо:** логотип — оформление, на юридическую силу документа не влияет (в отличие от печати, HIGH-05).
- **Логируется ли:** да, с пакета 2 (коммит «fix: documents (audit pack 2)»): `documents/index.js:182` — один `log.warn` «PDF: логотип brand/logo.png не найден ни в public, ни в dist…» при первом обращении (результат кэшируется, повторов нет). Тест: «FB-14: логотипа нет ни в public, ни в dist — одно предупреждение на все документы» (`documents/test/documents.test.js`), до исправления падал. Раньше: не логировался.

### FB-15. Картинка не загрузилась — PDF без неё

- **Файл:** `documents/images.js:143-146` (строка прежней таблицы: 13)
- **Код:**

```js
    } catch (err) {
      log.warn("PDF: картинка не загружена (" + String(src).slice(0, 120) + "): " + (err && err.message));
      return null;
    }
```

- **Что подставляет при сбое:** карточка товара в PDF-каталоге без фото.
- **Почему допустимо:** каталог важнее отдельной картинки; одна недоступная картинка не должна ломать весь документ.
- **Логируется ли:** да — `log.warn` с адресом картинки. (Исключение без журнала — строка 137, см. MED-04; с пакета 2 там тоже `log.warn` о неподдерживаемом без sharp формате.)

### FB-16. Ошибка плагина ИИ не ломает ответ

- **Файл:** `ai/core.js:68-77` (строка прежней таблицы: 14)
- **Код:**

```js
  function emit(hook, ...args) {
    for (const plugin of pluginList) {
      if (typeof plugin[hook] !== "function") continue;
      try {
        plugin[hook](...args);
      } catch (err) {
        console.error(`AI-плагин ${plugin.name || "?"}.${hook}:`, err);
      }
    }
  }
```

- **Что подставляет при сбое:** пропуск хука одного плагина (журнал, метрики).
- **Почему допустимо:** плагины — наблюдение за вызовом, а не его логика; посетитель получает ответ.
- **Логируется ли:** да — `console.error` с именем плагина и хука.

### FB-17. Классификатор темы упал → ответ без фильтра (fail-open)

- **Файл:** `ai/lib/topic.js:84-87` (строка прежней таблицы: 15)
- **Код:**

```js
  return ctx
    .complete(buildClassifierMessages(scope, input), { temperature: 0, maxTokens: 500, json: true })
    .then((raw) => parseClassifierAnswer(raw, input.attachments, input.message))
    .catch(() => null);
}
```

- **Что подставляет при сбое:** `null` — «вердикта нет», вопрос обрабатывается как относящийся к теме.
- **Почему допустимо:** задокументировано («промис никогда не отклоняется»); лучше ответить на вопрос не по теме, чем отказать клиенту по делу. Основной промпт консультанта сам ограничивает тематику.
- **Логируется ли:** отдельно — нет. Сам вызов модели фиксирует плагин-логгер ядра. Рекомендация: счётчик срабатываний.

### FB-18. Перебор кодировок текстового файла

- **Файл:** `ai/lib/attachments.js:367-375` (строка прежней таблицы: 16)
- **Код:**

```js
function decodeText(buffer) {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.toString("utf8", 3);
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder("utf-16le").decode(buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder("utf-16be").decode(buffer.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("windows-1251").decode(buffer);
  }
}
```

- **Что подставляет при сбое:** если файл не UTF-8 — читает его как Windows-1251.
- **Почему допустимо:** это не ошибка, а штатное определение кодировки: `fatal: true` используется как проверка «это UTF-8?». Для русскоязычных пользователей 1251 — самая вероятная альтернатива.
- **Логируется ли:** нет (не ошибка).

### FB-19. Ошибка сохранения бюджета ИИ

- **Файл:** `ai/lib/budget.js:74-81` (строка прежней таблицы: 17)
- **Код:**

```js
  function persist() {
    if (!storage || typeof storage.save !== "function") return;
    try {
      storage.save({ ...state });
    } catch (err) {
      console.error("AI-бюджет: не удалось сохранить расход:", err.message);
    }
  }
```

- **Что подставляет при сбое:** расход остаётся только в памяти до следующей удачной записи.
- **Почему допустимо:** в работающем процессе лимит соблюдается; теряется расход только при перезапуске в момент сбоя.
- **Логируется ли:** да — `console.error`.

### FB-20. Заголовок пароля не декодируется → сравнивается как есть

- **Файл:** `auth/admin-password.js:65-77` (строка прежней таблицы: 18)
- **Код:**

```js
function headerMatchesPassword(header, expected) {
  const raw = String(header || "").trim();
  if (!raw || !expected) return false;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // не URI-кодировка — сравниваем как есть
  }
  const decodedOk = passwordMatches(decoded, expected);
  const rawOk = passwordMatches(raw, expected);
  return decodedOk || rawOk;
}
```

- **Что подставляет при сбое:** сырое значение заголовка.
- **Почему допустимо:** старые вкладки админки шлют пароль без кодирования; оба варианта сравниваются за постоянное время, ошибка декодирования не даёт доступа.
- **Логируется ли:** нет — неверный пароль учитывается лимитом в `requireAdmin`.

### FB-21. Ошибка закрытия файла журнала

- **Файл:** `logging/file-log.js:57-65` (строка прежней таблицы: 19, первая часть)
- **Код:**

```js
  function closeFd() {
    if (fd == null) return;
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
    fd = null;
  }
```

- **Что подставляет при сбое:** дескриптор считается закрытым.
- **Почему допустимо:** при закрытии сделать больше нечего; ОС закроет дескриптор при выходе процесса.
- **Логируется ли:** нет — это сам журнал, писать некуда.

### FB-22. Старый файл журнала не удалось удалить при ротации

- **Файл:** `logging/file-log.js:81-93` (строка прежней таблицы: 19, вторая часть)
- **Код:**

```js
  function cleanup(current) {
    const cutoff = current.getTime() - keepDays * DAY_MS;
    for (const name of fs.readdirSync(dir)) {
      const match = name.match(FILE_RE);
      if (!match) continue;
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {
        // файл занят или уже удалён — попробуем в следующий раз
      }
```

- **Что подставляет при сбое:** файл остаётся до следующей ротации.
- **Почему допустимо:** уборка повторяется каждый день; лишний старый журнал ничего не ломает.
- **Логируется ли:** нет.

### FB-23. Фоновое обновление цен и прогрев токена при открытии корзины

- **Файл:** `src/components/CartDrawer.jsx:121-125` (строка прежней таблицы: 20)
- **Код:**

```jsx
  useEffect(() => {
    if (!cartOpen) return;
    refreshProducts().catch(() => {});
    warmOrderProof().catch(() => {});
  }, [cartOpen, refreshProducts]);
```

- **Что подставляет при сбое:** корзина показывается с уже загруженными ценами; токен будет запрошен при оформлении.
- **Почему допустимо:** при оформлении сервер сам проверяет цены (`catalog_changed`), а ошибки отправки заказа показываются клиенту (`CartDrawer.jsx:175-220`).
- **Логируется ли:** нет (повтор с обработкой ошибок будет при оформлении).

### FB-24. Прогрев антиспам-токена в форме «Контакты»

- **Файл:** `src/components/ContactSection.jsx:76` (строка прежней таблицы: 21, первая часть)
- **Код:**

```jsx
  /** { key, id }: повтор той же заявки после сбоя сети не создаст дубль в CRM. */
  const pendingRef = useRef(null);
  const trapRef = useRef(null);
  /** Антиспам-токен считается в фоне, пока посетитель заполняет форму. */
  const warm = () => warmOrderProof().catch(() => {});
```

- **Что подставляет при сбое:** ничего; токен будет запрошен заново при отправке формы.
- **Почему допустимо:** прогрев — ускорение; при отправке ошибки обрабатываются и показываются (`ContactSection.jsx:121`).
- **Логируется ли:** нет.

### FB-25. Прогрев антиспам-токена в ИИ-чате

- **Файл:** `src/chat/ChatWidget.jsx:303-306` (строка прежней таблицы: 21, вторая часть)
- **Код:**

```jsx
  const hasDialog = hasClientMessages(history);
  useEffect(() => {
    if (open && hasDialog && !leadRef.current.sent) warmOrderProof().catch(() => {});
  }, [open, hasDialog]);
```

- **Что подставляет при сбое:** ничего; токен будет запрошен при передаче заявки.
- **Почему допустимо:** то же, что FB-24. Риск потери заявки из чата описан отдельно (MED-13).
- **Логируется ли:** нет.

### FB-26. ИИ недоступен — сообщение посетителю и офлайн-ответ

- **Файл:** `src/chat/ChatWidget.jsx:243-262` (строка прежней таблицы: 22)
- **Код:**

```jsx
      try {
        cloud = await consultCloud(value, files, priorHistory);
      } catch (err) {
        cloudError = err;
      }
      const result = cloud || consultOffline(products, value, files);
      setTyping(false);
      if (cloudError && !cloud) {
        const reason = String(cloudError.message || "").trim().replace(/[\s.!]+$/, "");
        // ...
        push("bot", t("chat.offline_lead", { lead }));
      }
```

- **Что подставляет при сбое:** ответ офлайн-бота по ключевым словам.
- **Почему допустимо:** посетитель явно предупреждён («ИИ недоступен: <причина>»), и ему всё равно предлагают помощь и переход к менеджеру. Исключение — `ai_not_configured`, когда предупреждения нет (HIGH-08).
- **Логируется ли:** на сервере — да (плагин-логгер; с `cfbf64c` — оповещение владельцу), в браузере — нет.

### FB-27. Серверный разбор вложений не удался → локальный разбор в браузере

- **Файл:** `src/chat/attachments.js:242-266` (строка прежней таблицы: 23)
- **Код:**

```js
    if (res.status === 413) {
      return { ...base, kind: "error", error: t("file.error.too_big_parse") };
    }
    if (!res.ok) return null;
    const data = await res.json();
    const item = data && Array.isArray(data.attachments) ? data.attachments[0] : null;
    if (!item) return null;
    // ...
  } catch {
    return null;
  } finally {
```

- **Что подставляет при сбое:** `null` → файл разбирается упрощённо в браузере.
- **Почему допустимо:** посетитель всё равно получает ответ по файлу; слишком большой файл (413) не проглатывается, а показывается как ошибка.
- **Логируется ли:** нет ни в браузере, ни на сервере для 422 (см. MED-09).

### FB-28. Корзина в `localStorage` повреждена → пустая корзина

- **Файл:** `src/lib/cart-storage.js:3-14` (строка прежней таблицы: 24, часть 1)
- **Код:**

```js
export function readCart() {
  try {
    const raw = localStorage.getItem(CART_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && item.id).map((item) => ({ id: String(item.id), qty: Number(item.qty) || 1 }))
      : [];
  } catch {
    return [];
  }
}
```

- **Что подставляет при сбое:** пустую корзину.
- **Почему допустимо:** корзина — черновик посетителя в его браузере; при приватном режиме или битом значении лучше начать с нуля, чем сломать витрину.
- **Логируется ли:** нет.

### FB-29. Корзину не удалось сохранить в `localStorage`

- **Файл:** `src/lib/cart-storage.js:16-22` (строка прежней таблицы: 24, часть 2)
- **Код:**

```js
export function writeCart(cart) {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  } catch {
    // ignore
  }
}
```

- **Что подставляет при сбое:** корзина живёт только в памяти вкладки.
- **Почему допустимо:** при переполнении квоты или запрете хранилища оформление в текущей вкладке работает; теряется только сохранение между визитами.
- **Логируется ли:** нет.

### FB-30. Каталог не удалось сохранить в кэш браузера

- **Файл:** `src/lib/products-api.js:30-38` (строка прежней таблицы: 24, часть 3)
- **Код:**

```js
function writeCachedProducts(list) {
  try {
    const payload = JSON.stringify(list);
    localStorage.setItem(PRODUCTS_CACHE_KEY, payload);
    localStorage.setItem(PRODUCTS_KEY, payload);
  } catch {
    // QuotaExceeded — кэш не критичен
  }
}
```

- **Что подставляет при сбое:** свежий каталог показывается, но не кэшируется.
- **Почему допустимо:** кэш нужен только на случай недоступности API; сама загрузка прошла успешно. (Проблема использования кэша и демо-каталога при ошибке — в HIGH-07 и MED-11, не здесь.)
- **Логируется ли:** нет.

### FB-31. `sessionStorage` недоступен — пароль админки не читается

- **Файл:** `src/lib/api.js:5-11` (строка прежней таблицы: 24, часть 4)
- **Код:**

```js
export function getAdminPassword() {
  try {
    return String(sessionStorage.getItem(ADMIN_PASS_KEY) || "").trim();
  } catch {
    return "";
  }
}
```

- **Что подставляет при сбое:** пустой пароль → сервер ответит 401 → админка покажет вход.
- **Почему допустимо:** безопасный отказ: при ошибке хранилища доступ не даётся, а запрашивается заново.
- **Логируется ли:** нет.

### FB-32. `sessionStorage` недоступен — сессия админки считается отсутствующей

- **Файл:** `src/lib/api.js:13-19` (строка прежней таблицы: 24, часть 5)
- **Код:**

```js
export function hasStoredAdminSession() {
  try {
    return sessionStorage.getItem(ADMIN_AUTH_KEY) === "1" && !!getAdminPassword();
  } catch {
    return false;
  }
}
```

- **Что подставляет при сбое:** `false` → показывается экран входа.
- **Почему допустимо:** безопасный отказ, как FB-31.
- **Логируется ли:** нет.

### FB-33. Сессию админки не удалось сохранить

- **Файл:** `src/lib/api.js:21-28` (строка прежней таблицы: 24, часть 6)
- **Код:**

```js
export function saveAdminSession(password) {
  try {
    sessionStorage.setItem(ADMIN_AUTH_KEY, "1");
    sessionStorage.setItem(ADMIN_PASS_KEY, String(password || "").trim());
  } catch {
    // sessionStorage недоступен — работаем без восстановления сессии
  }
}
```

- **Что подставляет при сбое:** работа без восстановления сессии — после перезагрузки страницы нужно войти заново.
- **Почему допустимо:** неудобство, а не потеря данных; поведение описано в комментарии.
- **Логируется ли:** нет.

### FB-34. Сессию админки не удалось очистить

- **Файл:** `src/lib/api.js:30-37` (строка прежней таблицы: 24, часть 7)
- **Код:**

```js
export function clearAdminSession() {
  try {
    sessionStorage.removeItem(ADMIN_AUTH_KEY);
    sessionStorage.removeItem(ADMIN_PASS_KEY);
  } catch {
    // ignore
  }
}
```

- **Что подставляет при сбое:** ничего.
- **Почему допустимо:** если `sessionStorage` недоступен, то и сохранить в нём ничего не удалось (FB-33) — очищать нечего; `sessionStorage` в любом случае очищается при закрытии вкладки.
- **Логируется ли:** нет.

### FB-35. Не удалось разослать событие «требуется повторный вход»

- **Файл:** `src/lib/api.js:39-48` (строка прежней таблицы: 24, часть 8)
- **Код:**

```js
export function unauthorizedError() {
  const err = new Error("Требуется повторный вход");
  err.code = "unauthorized";
  try {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  } catch {
    // ignore
  }
  return err;
}
```

- **Что подставляет при сбое:** ошибка `unauthorized` всё равно возвращается вызывающему коду.
- **Почему допустимо:** событие — дополнительный способ вернуть на экран входа; основная ошибка не теряется.
- **Логируется ли:** нет.

### FB-36. Удаление уже удалённого заказа (404) считается успехом

- **Файл:** `src/lib/orders-db.js:56-59`, `src/lib/orders-db.js:180-182` (строка прежней таблицы: 25)
- **Код:**

```js
function ignoreNotFound(err) {
  if (err && err.status === 404) return null;
  throw err;
}
// ...
export function removeOrder(id) {
  return request("/api/orders/" + encodeURIComponent(id), { method: "DELETE", admin: true }).catch(ignoreNotFound);
}
```

- **Что подставляет при сбое:** при 404 — успех; остальные ошибки пробрасываются.
- **Почему допустимо:** идемпотентность: цель «заказа нет» достигнута (например, его удалили в другой вкладке).
- **Логируется ли:** нет (не ошибка).

### FB-37. Значок числа новых заявок не загрузился

- **Файл:** `src/admin/Dashboard.jsx:64-72` (строка прежней таблицы: 26)
- **Код:**

```jsx
  const [newLeads, setNewLeads] = useState(0);
  const loadLeadBadge = useCallback(async () => {
    try {
      const page = await listOrdersPage({ kind: "leads", status: "new", limit: 1 });
      setNewLeads(page.counts.new || 0);
    } catch {
      // значок не критичен
    }
  }, []);
```

- **Что подставляет при сбое:** прежнее значение значка (при первой загрузке — 0).
- **Почему допустимо:** значок второстепенен; сами заявки при открытии вкладки загружаются с показом ошибки. С `cfbf64c` о новых заявках есть оповещение в Telegram (HIGH-01).
- **Логируется ли:** нет.

### FB-38. Clipboard API недоступен или отказал → «не скопировано»

- **Файл:** `src/lib/clipboard.js:11-21` (строка прежней таблицы: 27, первая часть)
- **Код:**

```js
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      return navigator.clipboard.writeText(value).then(
        () => true,
        () => false
      );
    }
  } catch {
    // Clipboard API недоступен
  }
  return Promise.resolve(false);
```

- **Что подставляет при сбое:** `false`.
- **Почему допустимо:** вызывающий код по `false` показывает текст заказа для ручного копирования — результат не теряется.
- **Логируется ли:** нет.

### FB-39. `execCommand("copy")` отказал → «не скопировано»

- **Файл:** `src/lib/clipboard.js:35-48` (строка прежней таблицы: 27, вторая часть)
- **Код:**

```js
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, value.length);
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    field.remove();
    try {
      if (active && typeof active.focus === "function") active.focus({ preventScroll: true });
    } catch {
      // ignore
    }
```

- **Что подставляет при сбое:** `false`, после чего пробуется Clipboard API (FB-38); фокус возвращается, если это возможно.
- **Почему допустимо:** два способа копирования по очереди, итог честно возвращается вызывающему коду.
- **Логируется ли:** нет.

### FB-40. Устаревший чанк при экспорте отчёта → понятная ошибка `StaleBuildError`

- **Файл:** `src/admin/reports/export.js:40-55` (строка прежней таблицы: 28, первая часть)
- **Код:**

```js
const CHUNK_ERROR_RE = /dynamically imported module|Importing a module script failed|error loading dynamically|Failed to fetch|Unable to preload/i;

async function lazyImport(load) {
  try {
    return await load();
  } catch (err) {
    throw CHUNK_ERROR_RE.test(String(err && err.message)) ? new StaleBuildError(err) : err;
  }
}
```

- **Что подставляет при сбое:** ничего не подставляет — переводит техническую ошибку загрузки модуля в понятную «обновите страницу», остальные пробрасывает как есть.
- **Почему допустимо:** после обновления сайта старая вкладка не может загрузить удалённые чанки; это хорошая практика, ошибка не теряется.
- **Логируется ли:** ошибка показывается менеджеру; в журнал не пишется.

### FB-41. Неудачная загрузка pdfmake не кэшируется

- **Файл:** `src/admin/reports/export.js:165` (строка прежней таблицы: 28, вторая часть)
- **Код:**

```js
    ).then(
      ([pdfModule, fontsModule]) => {
        const pdfMake = pdfModule.default || pdfModule;
        pdfMake.addVirtualFileSystem(fontsModule.default || fontsModule);
        return pdfMake;
      }
    );
    pdfMakePromise.catch(() => (pdfMakePromise = null));
```

- **Что подставляет при сбое:** сбрасывает закэшированный промис, чтобы следующая попытка загрузила модуль заново.
- **Почему допустимо:** сама ошибка доходит до вызывающего кода (этот `.catch` создаёт отдельную ветку); без сброса одна сетевая ошибка ломала бы экспорт до перезагрузки страницы.
- **Логируется ли:** ошибку видит менеджер; в журнал не пишется.

### FB-42. Нечитаемое изображение при сборке пропускается

- **Файл:** `scripts/images.mjs:64-70` (строка прежней таблицы: 29)
- **Код:**

```js
  let meta;
  try {
    meta = await sharp(file).rotate().metadata();
  } catch (err) {
    console.warn(`⚠ ${key}: не удалось прочитать (${err.message}) — пропускаю`);
    continue;
  }
```

- **Что подставляет при сбое:** для этого файла не создаются оптимизированные варианты; используется исходный путь.
- **Почему допустимо:** сборка не должна падать из-за одной битой картинки; предупреждение видно в выводе `update-site.bat`.
- **Логируется ли:** да — `console.warn` при сборке.

### FB-43. Секрет антиспам-токенов создаётся заново при каждом запуске

- **Файл:** `antispam/order-guard.js:89`, `antispam/order-guard.js:103` (строка прежней таблицы: 30)
- **Код:**

```js
function createOrderGuard(config = loadOrderGuardConfig({}), { now = Date.now, secret = crypto.randomBytes(32) } = {}) {
  const challengesByIp = createWindow(10 * MINUTE, now);
  // ...
  const sign = (payload) => crypto.createHmac("sha256", secret).update(payload).digest("base64url");
```

- **Что подставляет при сбое:** после перезапуска токены, выданные до него, не проходят проверку.
- **Почему допустимо:** токены короткоживущие; фронтенд при отказе запрашивает новый токен и повторяет отправку (сообщение «Обновите страницу и отправьте форму ещё раз» — крайний случай). Секрет не хранится нигде и не может утечь.
- **Логируется ли:** отказ по токену учитывается в `stats.badProof`; отдельной записи в журнал нет.

---

## 8. Покрытие: проверенные и исключённые пути

### 8.1. Проверено при аудите (165 файлов с кодом)

**Сервер и корень**
- `server.js`
- `Dockerfile`, `docker-compose.yml`
- `run-server.bat`, `start-site.bat`, `update-site.bat`, `install-service.bat`, `uninstall-service.bat`, `install-docker-autostart.bat`, `uninstall-docker-autostart.bat`, `switch-to-docker.bat`, `switch-to-windows.bat`, `setup-autologon.bat`
- `vite.config.mjs`

**`ai/`**
- `ai/config.js`, `ai/core.js`, `ai/errors.js`, `ai/http.js`, `ai/index.js`
- `ai/features/consultant.js`, `ai/features/index.js`, `ai/features/product-description.js`
- `ai/lib/attachments-pool.js`, `ai/lib/attachments-worker.js`, `ai/lib/attachments.js`, `ai/lib/breaker.js`, `ai/lib/budget.js`, `ai/lib/catalog.js`, `ai/lib/history-sign.js`, `ai/lib/image.js`, `ai/lib/limiter.js`, `ai/lib/messages.js`, `ai/lib/retry.js`, `ai/lib/topic.js`, `ai/lib/vision.js`
- `ai/plugins/logger.js`, `ai/plugins/metrics.js`
- `ai/providers/index.js`, `ai/providers/openai.js`
- тесты: `ai/test/abuse.test.js`, `ai/test/attachments.test.js`, `ai/test/core.test.js`, `ai/test/edge.test.js`, `ai/test/http.test.js`, `ai/test/openai.test.js`, `ai/test/topic.test.js`, `ai/test/vision.test.js`

**`antispam/`, `auth/`, `config/`, `security/`, `logging/`**
- `antispam/order-guard.js`; тесты `antispam/test/handoff.test.js`, `antispam/test/order-guard.test.js`
- `auth/admin-password.js`; тест `auth/test/admin-password.test.js`
- `config/env.js`, `config/proxy.js`, `config/sites.js`; тест `config/test/config.test.js`
- `security/headers.js`, `security/remote-image.js`; тест `security/test/remote-image.test.js`
- `logging/file-log.js`; тест `logging/test/file-log.test.js`

**`db/`**
- `db/store.js`; тест `db/test/store.test.js`

**`documents/`**
- `documents/http.js`, `documents/images.js`, `documents/index.js`, `documents/money.js`, `documents/render-worker.js`, `documents/render.js`, `documents/requisites.js`, `documents/send.js`
- `documents/templates/act.js`, `documents/templates/catalog.js`, `documents/templates/common.js`, `documents/templates/invoice.js`, `documents/templates/lead.js`
- тесты: `documents/test/documents.test.js`, `documents/test/money.test.js`

**`deploy/`**
- `deploy/bazis.service`, `deploy/Caddyfile.template`, `deploy/nginx.conf.template`

**`scripts/`**
- `scripts/db-check.js`, `scripts/deploy-config.mjs`, `scripts/fonts.mjs`, `scripts/i18n-check.mjs`, `scripts/i18n-html.mjs`, `scripts/images.mjs`
- `scripts/docker-autostart.ps1`, `scripts/docker-e2e.ps1`, `scripts/setup-autologon.ps1`, `scripts/switch-data.ps1`, `scripts/windows-service.ps1`

**`src/` — витрина и общее**
- `src/main.jsx`, `src/site.js`
- `src/components/AnchorLink.jsx`, `ArticleCard.jsx`, `ArticleCta.jsx`, `CartDrawer.jsx`, `ContactModal.jsx`, `ContactSection.jsx`, `DirectionCard.jsx`, `Footer.jsx`, `Header.jsx`, `LanguageSwitcher.jsx`, `Layout.jsx`, `ProductCard.jsx`, `Quiz.jsx`, `ResponsiveImage.jsx`
- `src/pages/ArticlePage.jsx`, `ArticlesPage.jsx`, `HomePage.jsx`, `MediaHomePage.jsx`, `ShopPage.jsx`
- `src/content/articles.js`, `src/content/portfolio.js`
- `src/i18n/DocumentHead.jsx`, `I18nProvider.jsx`, `head.js`, `index.js`, `routing.jsx`
- `src/lib/api.js`, `cart-storage.js`, `catalog.js`, `clipboard.js`, `download.js`, `hero.js`, `images.js`, `messages.js`, `order-proof.js`, `orders-db.js`, `phone.js`, `products-api.js`, `smooth-scroll.js`
- `src/store/StoreContext.jsx`

**`src/chat/`**
- `ChatQuick.jsx`, `ChatText.jsx`, `ChatWidget.jsx`, `attachments.js`, `cloud.js`, `consult.js`, `handoff-lead.js`, `handoff-transcript.js`, `useResizable.js`

**`src/admin/`**
- `AdminApp.jsx`, `ClientModal.jsx`, `ClientsSection.jsx`, `CompanySection.jsx`, `Dashboard.jsx`, `LoginView.jsx`, `OrderDocuments.jsx`, `OrdersSection.jsx`, `ProductModal.jsx`, `ProductsSection.jsx`, `RefreshButton.jsx`, `ReportsSection.jsx`, `SendDialog.jsx`, `client-views.js`, `dialogs.jsx`, `documents-api.js`, `format.js`, `image.js`, `main.jsx`, `requisites-form.js`
- `src/admin/reports/build.js`, `src/admin/reports/export.js`

**Не код, просмотрено как данные и настройки:** `package.json`, `.gitignore`, `.dockerignore`, `shared/*.json` (сайты, категории, правила корзины).

### 8.2. Изменено или добавлено после аудита

| Путь | Состояние |
|---|---|
| `notify/index.js`, `notify/test/notify.test.js` | Написаны в рамках исправлений (коммит `cfbf64c`); учтены в статусах HIGH-01, HIGH-04, HIGH-08, HIGH-10, MED-15, LOW-22 |
| `server.js`, `db/store.js`, `ai/http.js`, `documents/send.js`, `Dockerfile`, `package.json` | Изменены в `cfbf64c`; номера строк в отчёте указаны по текущей версии, изменённые места перепроверены |
| `src/lib/catalog.js`, `src/chat/ChatWidget.jsx`, `src/styles/styles.css` | Изменены до первого коммита (CRIT-01 и подсветка кнопок чата); перепроверены |
| `scripts/offsite-backup.ps1`, `scripts/backup-snapshot.js` | Появились после аудита, не в рамках этих исправлений. Прочитаны при подготовке этой редакции только для оценки статуса HIGH-04; полный аудит по методике не проводился |
| `backup-now.bat`, `install-backup.bat`, `restore-backup.bat`, `uninstall-backup.bat` | Появились после аудита, **не проверялись** |
| `update-site.bat` | Изменён после аудита (сейчас 87 строк), **повторно не проверялся** |
| `README.md` | Появился после аудита, не код, не проверялся |

### 8.3. Исключено из проверки

| Путь | Причина |
|---|---|
| `node_modules/` | Сторонние зависимости |
| `dist/`, `dist-media/` | Результат сборки Vite (просматривался только для проверки CRIT-01 в контейнере) |
| `.tools/` | Встроенный дистрибутив Node.js (`node-v22.20.0-win-x64`) |
| `package-lock.json` | Lock-файл |
| `src/generated/images-manifest.json`, `deploy/generated/` | Генерируются скриптами |
| `images/` (включая `images/optimized/`, `images/uploads/`) | Бинарные изображения и сгенерированные варианты |
| `data/`, `data-old-*/`, `data-pretest-backup/` | Рабочие данные и копии (SQLite, PDF) — не код |
| `logs/`, `.e2e-totals` | Журналы и служебные результаты |
| `assets-src/`, `documents/fonts/` | Шрифты (бинарные) |
| `public/` | Статика без JS (логотип, шрифты, манифест) |
| `src/locales/*.json`, `src/styles/*.css`, `*.html` | Словари, стили и шаблоны HTML — не логика обработки ошибок (просматривались выборочно при проверке i18n) |
| `.git/` | Служебная папка git |
| `.env` | **Намеренно не читался**, чтобы не раскрыть секреты; значения по умолчанию и проверки настроек оценены по коду (`config/*.js`, `server.js`, `ai/config.js`, `documents/send.js`, `notify/index.js`) |
