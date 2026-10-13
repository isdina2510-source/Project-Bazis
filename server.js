/**
 * Сервер сайта + CRM API (orders/clients/products JSON) + ИИ-ядро (папка ai/).
 * Фронтенд (React) собирается командой `npm run build`: «Dinara BILab» — в dist/, «Dinara BILab Медиа» — в dist-media/.
 * Запуск: npm start  |  start-site.bat
 * Сайт: http://127.0.0.1:8787, медиа-сайт: http://media.localhost:8787 (домены — shared/sites.json)
 * Ключ OpenAI: только в .env (OPENAI_API_KEY) — не в браузере.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { URL } = require("url");
const { DEFAULT_PRODUCTS, CATEGORIES, CART_RULES } = require("./shared/catalog.json");
const SITES_CONFIG = require("./shared/sites.json");
const { createAi, createAiHttpHandler, AiError } = require("./ai");
const { createStore } = require("./db/store");
const { parseDatabaseUrl, isConnectionError } = require("./db/connection");
const { orderTotalText, orderTotalsSummary } = require("./documents/money");
const { fetchRemoteImage } = require("./security/remote-image");
const { createDocuments } = require("./documents");
const { sharpStatus } = require("./documents/images");
const { createSender } = require("./documents/send");
const { createDocumentsHttpHandler } = require("./documents/http");
const { normalizeClientRequisites } = require("./documents/requisites");
const { MIN_LENGTH: ADMIN_PASSWORD_MIN_LENGTH, checkAdminPassword, headerMatchesPassword } = require("./auth/admin-password");
const { installFileLog } = require("./logging/file-log");
const { securityHeaders, isAdminPath } = require("./security/headers");
const { loadEnvFile } = require("./config/env");
const { resolveSites, isLocalHostname } = require("./config/sites");
const { parseTrustProxy, isProxied, clientAddress, forwardedProto } = require("./config/proxy");
const { readNumber, readTimeZone } = require("./config/values");
const { integrationProblems, contentProblems } = require("./config/production");
const { createOrderGuard, loadOrderGuardConfig } = require("./antispam/order-guard");
const { createNotifier, scrub } = require("./notify");
const { createClientErrorsHandler } = require("./notify/client-errors");
const { createFileSender } = require("./runtime/static-file");
const { createHealthHandler } = require("./runtime/health");
const { createShutdown, watchStopFile, createCrashHandler } = require("./runtime/shutdown");
const { createUploadRemover } = require("./runtime/uploads");
const { version: APP_VERSION } = require("./package.json");

loadEnvFile(path.join(__dirname, ".env"));

/**
 * Журнал в logs/ (LOG_DIR); LOG_TO_FILE=0 — только консоль. --check-config файлов не создаёт.
 * Отключение и восстановление журнала — оповещение; setImmediate: notifier создаётся ниже.
 */
const fileLog =
  process.env.LOG_TO_FILE === "0" || process.argv.includes("--check-config")
    ? null
    : installFileLog({
        dir: path.resolve(__dirname, process.env.LOG_DIR || "logs"),
        keepDays: Number(process.env.LOG_KEEP_DAYS) || 14,
        maxBytes: (Number(process.env.LOG_MAX_MB) || 20) * 1024 * 1024,
        onStatus: (status, text) => setImmediate(() => notifier.alert("file_log:" + status, text)),
      });

const PORT = Number(process.env.PORT || 8787);
/** Снаружи сервер доступен только через прокси; 0.0.0.0 — для Docker, где порт закрывает сам Docker (docker-compose.yml). */
const HOST = String(process.env.HOST || "127.0.0.1").trim();
const ROOT = __dirname;
const DEFAULT_SITE = SITES_CONFIG.default;
/** Сведения о сборке в папке сайта: для какого адреса она сделана (пишет vite.config.mjs, наружу не отдаётся). */
const BUILD_INFO_FILE = ".build-info.json";
/** Код выхода «ошибка настроек»: run-server.bat не перезапускает сервер, пока .env не исправят. */
const EXIT_CONFIG_ERROR = 4;

const adminPasswordCheck = checkAdminPassword(process.env.ADMIN_PASSWORD);
const sitesCheck = resolveSites(SITES_CONFIG, process.env);
const trustProxyCheck = parseTrustProxy(process.env.TRUST_PROXY);
/** Опечатка вроде 30/min дала бы NaN, а сравнение с NaN всегда ложно — лимит молча отключился бы. */
const rateLimitChecks = {
  chat: readNumber(process.env, "CHAT_RATE_LIMIT", 20, { min: 1 }),
  chatWindowMs: readNumber(process.env, "CHAT_RATE_WINDOW_MS", 60 * 1000, { min: 1000 }),
  admin: readNumber(process.env, "ADMIN_RATE_LIMIT", 30, { min: 1 }),
  adminWindowMs: readNumber(process.env, "ADMIN_RATE_WINDOW_MS", 60 * 1000, { min: 1000 }),
};
/** Пояс для дат и года нумерации документов (documents/templates/common.js читает ту же переменную). */
const documentsTzCheck = readTimeZone(process.env, "DOCUMENTS_TZ", "Asia/Almaty");
const databaseCheck = parseDatabaseUrl(process.env.DATABASE_URL);
const configErrors = [
  databaseCheck.ok ? "" : databaseCheck.error,
  adminPasswordCheck.ok
    ? ""
    : `${adminPasswordCheck.error} Задайте в .env строку ADMIN_PASSWORD=ваш_пароль — не короче ${ADMIN_PASSWORD_MIN_LENGTH} символов, ` +
      "регистр букв учитывается.",
  ...sitesCheck.errors,
  trustProxyCheck.ok ? "" : trustProxyCheck.error,
  ...Object.values(rateLimitChecks).map((check) => (check.ok ? "" : check.error)),
  documentsTzCheck.ok ? "" : documentsTzCheck.error,
].filter(Boolean);
if (configErrors.length) {
  console.error("Сервер не запущен — исправьте .env и запустите снова:\n" + configErrors.map((err) => "  • " + err).join("\n"));
  process.exit(EXIT_CONFIG_ERROR);
}
const ADMIN_PASSWORD = adminPasswordCheck.password;
const TRUST_PROXY = trustProxyCheck.trust;

/**
 * Сайты на одном сервере: «Dinara BILab» и «Dinara BILab Медиа». Какой отдать — по домену из запроса (Host);
 * домены — hosts в shared/sites.json плюс адрес из SITE_DOMAIN / SITE_URL / MEDIA_SITE_URL (config/sites.js).
 */
const SITES = sitesCheck.sites.map((resolved) => {
  const site = SITES_CONFIG.sites[resolved.id];
  return { ...resolved, hosts: new Set(resolved.hosts), distDir: path.join(ROOT, site.outDir), admin: !!site.admin };
});
const SITE_IDS = new Set(SITES.map((site) => site.id));
/** Выключенные сайты (MEDIA_SITE_ENABLED не true): на их домены — 404, а не основной сайт. */
const DISABLED_SITES = sitesCheck.disabled.map((resolved) => ({ ...resolved, hosts: new Set(resolved.hosts) }));
const MEDIA_ENABLED = SITE_IDS.has("media");
const MEDIA_STATUS_LINE = `Медиасайт: ${MEDIA_ENABLED ? "включён" : "выключен"}`;
const IMAGES_DIR = path.join(ROOT, "images");
const DATA_DIR = path.join(ROOT, "data");
const UPLOADS_DIR = path.join(ROOT, "images", "uploads");

/**
 * Данные перенесены в другое место (из папки data в Docker или обратно — scripts/switch-data.ps1): эта копия устарела.
 * Запуск на ней разделил бы заказы между двумя базами, поэтому сервер не стартует ни одним способом.
 */
const DATA_MOVED_FILE = path.join(DATA_DIR, "DATA-MOVED.txt");
/** Код выхода «данные перенесены»: run-server.bat не перезапускает сервер. */
const EXIT_DATA_MOVED = 5;
if (fs.existsSync(DATA_MOVED_FILE)) {
  let note = "";
  try {
    note = fs.readFileSync(DATA_MOVED_FILE, "utf8").trim();
  } catch {
    // текст пояснения не обязателен
  }
  console.error(
    `Сервер не запущен: данные из ${DATA_DIR} перенесены, эта копия устарела.\n` +
      (note ? note + "\n" : "") +
      "Запуск на старой копии разделил бы заказы между двумя базами."
  );
  process.exit(EXIT_DATA_MOVED);
}

/** Для какого адреса собран сайт: { built: false } — не собран, url: null — сборка старая, без сведений. */
function readBuildInfo(site) {
  if (!fs.existsSync(path.join(site.distDir, "index.html"))) return { built: false, url: null };
  try {
    const info = JSON.parse(fs.readFileSync(path.join(site.distDir, BUILD_INFO_FILE), "utf8"));
    return { built: true, url: typeof info.url === "string" ? info.url : "" };
  } catch {
    return { built: true, url: null };
  }
}

/** Чего не хватает для работы в интернете; пустой список — готово. */
function productionProblems() {
  const problems = [];
  const withoutUrl = SITES.filter((site) => !site.url);
  if (withoutUrl.length === SITES.length) {
    problems.push("Домен сайта не задан: добавьте в .env строку SITE_DOMAIN=ваш-домен.kz (без https://).");
  } else {
    withoutUrl.forEach((site) => problems.push(`У сайта «${site.label}» нет адреса: задайте SITE_DOMAIN или ${site.id.toUpperCase()}_SITE_URL в .env.`));
  }
  if (!TRUST_PROXY) {
    problems.push("TRUST_PROXY=0: за Caddy/nginx все посетители будут одним адресом. Уберите строку или поставьте TRUST_PROXY=1.");
  }
  if (databaseCheck.kind === "pglite") {
    problems.push("DATABASE_URL=pglite:… — встроенная база для тестов и разработки. Для работы сайта укажите сервер PostgreSQL (postgres://…).");
  }
  for (const site of SITES) {
    const info = readBuildInfo(site);
    if (!info.built) problems.push(`Сайт «${site.label}» не собран: запустите update-site.bat.`);
    else if (info.url === null) problems.push(`Сайт «${site.label}» собран без сведений об адресе: запустите update-site.bat.`);
    else if (info.url !== site.url) {
      problems.push(
        `Сайт «${site.label}» собран для адреса ${info.url || "(локальный)"}, а в настройках ${site.url || "(локальный)"}: ` +
          "ссылки canonical и между сайтами будут неверными. Запустите update-site.bat."
      );
    }
  }
  problems.push(...integrationProblems(process.env));
  problems.push(
    ...contentProblems({
      portfolio: readSourceFile("src/content/portfolio.js"),
      catalog: readSourceFile("src/lib/catalog.js"),
      mediaPublished: MEDIA_ENABLED,
    })
  );
  // Вызывается и при старте сервера: сбой загрузки sharp попадает в журнал сразу, а не при первом PDF.
  const sharp = sharpStatus();
  if (!sharp.ok) {
    problems.push(
      `Модуль sharp не загружается (${sharp.error}): картинки WebP/GIF в PDF-каталогах будут пустыми. ` +
        "Выполните npm ci (в Docker — пересоберите образ)."
    );
  }
  return problems;
}

/** Исходник сайта для проверки заглушек; null — файла нет (в Docker-образе только сборка). */
function readSourceFile(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

if (process.argv.includes("--check-config")) {
  console.log("ADMIN_PASSWORD: задан.");
  console.log(`База: ${databaseCheck.display}`);
  SITES.forEach((site) => {
    console.log(`Сайт «${site.label}»: ${site.url || "адрес не задан (только локально)"}; домены: ${[...site.hosts].join(", ")}`);
  });
  console.log(MEDIA_STATUS_LINE);
  console.log(`Прокси: ${TRUST_PROXY ? "адрес посетителя — из X-Forwarded-For от Caddy/nginx на этом компьютере" : "выключен (TRUST_PROXY=0)"}`);
  if (process.argv.includes("--production")) {
    const problems = productionProblems();
    if (problems.length) {
      console.error("\nК публикации в интернете не готово:\n" + problems.map((p) => "  • " + p).join("\n"));
      process.exit(EXIT_CONFIG_ERROR);
    }
    console.log("\nК публикации готово.");
  }
  process.exit(0);
}
const MAX_BODY_BYTES = 512 * 1024;
const MAX_PRODUCTS_BODY_BYTES = 2.5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const MAX_DRAIN_BYTES = 64 * 1024 * 1024;
const BODY_TOO_LARGE_MESSAGE = "Слишком большой запрос: уменьшите или уберите вложения";
const CATEGORY_IDS = new Set(CATEGORIES.map((item) => item.id));
/** Стоковая картинка, которую старая админка (открытая до обновления вкладка) подставляет вместо «нет фото». */
const LEGACY_DEFAULT_IMAGE =
  "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?auto=format&fit=crop&w=900&q=80";
const CHAT_RATE_LIMIT = rateLimitChecks.chat.value;
const CHAT_RATE_WINDOW_MS = rateLimitChecks.chatWindowMs.value;
const ADMIN_RATE_LIMIT = rateLimitChecks.admin.value;
const ADMIN_RATE_WINDOW_MS = rateLimitChecks.adminWindowMs.value;
const MAX_CART_QTY = CART_RULES.maxQty;
const DISCUSS_ONLY_CATEGORIES = new Set(CART_RULES.discussOnlyCategories);
const SINGLE_QTY_IDS = new Set(CART_RULES.singleQtyIds);
const SINGLE_QTY_TITLE_RE = new RegExp(CART_RULES.singleQtyTitlePattern, "i");
const ORDER_ID_RE = /^ord_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATA_APIS = new Set(["orders", "clients", "products", "settings", "documents"]);
const ORDER_STATUSES = ["new", "in_progress", "done", "cancelled"];
const LEGACY_REDIRECTS = {
  "/index.html": "/",
  "/shop.html": "/shop",
  "/admin": "/admin.html",
};

/** Публичная форма заказов: токен с доказательством работы, ловушка, лимиты (см. antispam/order-guard.js). */
const orderGuard = createOrderGuard(loadOrderGuardConfig(process.env));
/** @type {Map<string, number[]>} */
const adminRateBuckets = new Map();
/** @type {Map<string, number[]>} */
const adminFailBuckets = new Map();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2",
};

const CURRENCIES = new Set(["KZT", "RUB", "USD"]);

/** Только для чтения старых данных: неизвестная валюта → KZT. Новый ввод проверяет parseCurrency. */
function normalizeCurrency(value) {
  const code = String(value || "KZT").toUpperCase();
  return CURRENCIES.has(code) ? code : "KZT";
}

/** Валюта из запроса: не прислали — KZT, неизвестная — undefined (ошибка, а не тихая замена). */
function parseCurrency(value) {
  if (value == null || value === "") return "KZT";
  const code = String(value).trim().toUpperCase();
  return CURRENCIES.has(code) ? code : undefined;
}

function normalizeKind(value) {
  return String(value || "service") === "product" ? "product" : "service";
}

/** Только для чтения старых данных: неизвестный раздел → «management». */
function normalizeCategory(value) {
  const id = String(value || "").trim();
  return CATEGORY_IDS.has(id) ? id : "management";
}

function normalizeStoredProduct(item) {
  const raw = item && typeof item === "object" ? item : {};
  const id = String(raw.id || "").trim() || "p" + Date.now();
  return {
    id,
    title: String(raw.title || "").trim().slice(0, 120),
    description: String(raw.description || "").trim().slice(0, 500),
    price: roundPrice(raw.price),
    currency: normalizeCurrency(raw.currency),
    kind: normalizeKind(raw.kind),
    category: normalizeCategory(raw.category),
    image: storedImageValue(raw.image, id),
    stock: parseStock(raw.stock) ?? null,
    ...localizedProductFields(raw),
  };
}

const MAX_IMAGE_REF_LENGTH = 2000;
/** data:-картинка из старых данных — до переноса в файл (migrateInlineImages); base64 ≈ 4/3 от MAX_IMAGE_BYTES. */
const MAX_INLINE_IMAGE_LENGTH = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 100;

/**
 * Ссылка на картинку товара: путь images/… или URL; data: сохраняется только для переноса в файл при запуске.
 * Пустая строка — фото нет (сайт и PDF покажут нейтральную заглушку).
 */
function storedImageValue(value, productId) {
  const image = String(value || "").trim();
  if (!image) return "";
  if (image.startsWith("data:")) {
    if (image.length <= MAX_INLINE_IMAGE_LENGTH) return image;
    console.warn(`Картинка товара ${productId} в старых данных больше ${MAX_IMAGE_BYTES} байт — не перенесена, у товара не будет фото`);
    return "";
  }
  return image.slice(0, MAX_IMAGE_REF_LENGTH);
}

/**
 * Разовые правки данных при запуске; отметка о выполнении хранится в настройках, повторно не выполняются.
 * - clients_backfill: привязка заказов к карточкам (данные, перенесённые из JSON). Дальше карточки
 *   заводятся при смене статуса заказа; удалённая админом карточка не должна создаваться заново.
 * - orders_missing_clients_v1: ссылки на удалённые карточки (до того, как удаление стало отвязывать заказы).
 * - order_totals_v1: итог с учётом скидок и доставки у заказов, сохранённых до этого исправления.
 * Если при этом запуске из старых JSON-файлов добавлены заказы, все шаги выполняются заново — для них.
 */
async function runStartupMigrations(store) {
  const done = store.importedOrders() > 0 ? {} : (await store.settings.get("migrations")) || {};
  const steps = {
    clients_backfill: () => store.clients.backfill(),
    orders_missing_clients_v1: () => store.clients.unlinkMissing(),
    order_totals_v1: async () => {
      const fixed = await store.orders.recomputeTotals();
      if (fixed) console.log(`Пересчитан итог у заказов со скидками или доставкой: ${fixed}`);
    },
  };
  let changed = false;
  for (const [name, run] of Object.entries(steps)) {
    if (done[name]) continue;
    await run();
    done[name] = new Date().toISOString();
    changed = true;
  }
  if (changed) await store.settings.set("migrations", done);
}

/**
 * Старые товары хранили картинку прямо в базе (data:image/…;base64) — это раздувает GET /api/products.
 * При запуске переносим такие картинки в images/uploads; повреждённые убираем (товар остаётся без фото).
 */
async function migrateInlineImages(store) {
  let moved = 0;
  let replaced = 0;
  for (const product of await store.products.list()) {
    if (!String(product.image || "").startsWith("data:")) continue;
    let image = "";
    try {
      image = saveDataUrlImage(product.image);
    } catch (err) {
      console.warn(`Картинка товара «${product.title}» (${product.id}) повреждена (${err.code || err.message}) — фото убрано`);
    }
    try {
      await store.products.update({ ...product, image });
    } catch (err) {
      deleteUploadIfOwned(image);
      throw err;
    }
    if (!image) replaced += 1;
    else moved += 1;
  }
  if (moved || replaced) {
    console.log(`Картинки товаров из базы перенесены в images/uploads: ${moved}, убраны повреждённые: ${replaced}`);
  }
}

const MAX_STOCK = 999999;
/** Верхняя граница цены: вместе с количеством до 999 не вылезает за сумму, которую счёт пишет прописью. */
const MAX_PRICE = 1e12;

/** Цена в валюте товара, округление до тиына/копейки/цента. */
function roundPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}

/** Сумма позиции в целых минимальных единицах, чтобы 10.1 × 3 не превращалось в 30.299999999999997. */
function lineAmount(price, qty) {
  const unit = Math.round(Number(price) * 100);
  const count = Math.max(0, Math.floor(Number(qty) || 0));
  if (!Number.isFinite(unit) || unit < 0 || !Number.isFinite(count)) return 0;
  return (unit * count) / 100;
}

/**
 * Остаток: null (пусто) — не учитывается, иначе целое 0…MAX_STOCK.
 * Некорректное значение — undefined: при сохранении из админки это ошибка, при чтении старых данных — «без учёта».
 */
function parseStock(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_STOCK) return undefined;
  return n;
}

/** Переводы на казахский: title_kk / description_kk (пустые не храним — сайт покажет русский). */
function localizedProductFields(raw) {
  const out = {};
  const titleKk = String(raw.title_kk || "").trim().slice(0, 120);
  const descriptionKk = String(raw.description_kk || "").trim().slice(0, 500);
  if (titleKk) out.title_kk = titleKk;
  if (descriptionKk) out.description_kk = descriptionKk;
  return out;
}

function newProductId() {
  return "p" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

const deleteUploadIfOwned = createUploadRemover({ root: ROOT, uploadsDir: UPLOADS_DIR });

function saveDataUrlImage(dataUrl) {
  const match = String(dataUrl || "").match(
    /^data:(image\/(jpeg|jpg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i
  );
  if (!match) {
    const err = new Error("invalid_image");
    err.code = "invalid_image";
    throw err;
  }
  let mime = match[1].toLowerCase();
  if (mime === "image/jpg") mime = "image/jpeg";
  return saveImageBuffer(Buffer.from(match[3].replace(/\s+/g, ""), "base64"), mime);
}

/** Сохранить картинку в images/uploads после проверки размера и сигнатуры формата. */
function saveImageBuffer(buffer, mime) {
  const extMap = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
  };
  const ext = extMap[mime];
  if (!ext) {
    const err = new Error("invalid_image");
    err.code = "invalid_image";
    throw err;
  }
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
    const err = new Error("image_too_large");
    err.code = "image_too_large";
    throw err;
  }
  if (!imageMagicMatches(buffer, mime)) {
    const err = new Error("invalid_image");
    err.code = "invalid_image";
    throw err;
  }
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const fileName = "img_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8) + ext;
  const full = path.join(UPLOADS_DIR, fileName);
  try {
    fs.writeFileSync(full, buffer);
  } catch (err) {
    // ENOSPC и т.п. могут оставить недописанный файл — он никому не принадлежит.
    deleteUploadIfOwned("images/uploads/" + fileName);
    throw err;
  }
  return "images/uploads/" + fileName;
}

/** Проверка сигнатуры файла, а не только MIME из data-URL. */
function imageMagicMatches(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  if (mime === "image/jpeg") return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === "image/png") {
    return (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    );
  }
  if (mime === "image/gif") {
    const head = buffer.slice(0, 6).toString("ascii");
    return head === "GIF87a" || head === "GIF89a";
  }
  if (mime === "image/webp") {
    return (
      buffer.slice(0, 4).toString("ascii") === "RIFF" &&
      buffer.slice(8, 12).toString("ascii") === "WEBP"
    );
  }
  return false;
}

/** Поля image нет в запросе — картинка прежняя; пустая строка — убрать фото. */
function resolveProductImage(rawImage, previousImage) {
  if (rawImage === undefined) return previousImage || "";
  const value = String(rawImage || "").trim();
  if (!value) return "";
  if (value.startsWith("data:image/")) {
    return saveDataUrlImage(value);
  }
  // Внешняя ссылка остаётся только у старых товаров, пока её не перенесли к себе (localizeProductImage).
  if (/^https?:\/\//i.test(value)) {
    if (value === previousImage) return previousImage;
    const err = new Error("invalid_image");
    err.code = "invalid_image";
    throw err;
  }
  const cleaned = value.replace(/\\/g, "/").replace(/^\/+/, "").slice(0, 400);
  if (cleaned.startsWith("images/") && !cleaned.includes("..")) {
    return cleaned;
  }
  const err = new Error("invalid_image");
  err.code = "invalid_image";
  throw err;
}

function productError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

/** previous — текущий товар при правке: поля, которых нет в запросе, остаются прежними. */
function buildProductFromBody(body, previous) {
  // Поле не прислали — оставляем прежнее значение (форма админки, например, без *_kk).
  const keep = (key) => (body[key] !== undefined ? body[key] : previous ? previous[key] : undefined);
  const title = String(keep("title") || "").trim().slice(0, 120);
  if (!title) throw productError("title_required");
  const description = String(keep("description") || "").trim().slice(0, 500);
  if (!description) throw productError("description_required");
  const priceNum = Number(keep("price"));
  if (keep("price") == null || keep("price") === "" || !Number.isFinite(priceNum) || priceNum < 0 || priceNum > MAX_PRICE) {
    throw productError("invalid_price");
  }
  const stock = parseStock(keep("stock"));
  if (stock === undefined) throw productError("invalid_stock");
  // Не прислали — прежнее значение (при чтении старых данных оно нормализуется); прислали неизвестное — ошибка.
  const currency = body.currency !== undefined ? parseCurrency(body.currency) : previous ? previous.currency : "KZT";
  if (currency === undefined) throw productError("invalid_currency");
  const categoryId = body.category !== undefined ? String(body.category || "").trim() : previous ? previous.category : "";
  if (!CATEGORY_IDS.has(categoryId) && (body.category !== undefined || !previous)) throw productError("invalid_category");
  const image = resolveProductImage(body.image, previous && previous.image);
  return normalizeStoredProduct({
    id: previous && previous.id ? previous.id : newProductId(),
    title,
    description,
    title_kk: body.title_kk != null ? body.title_kk : previous && previous.title_kk,
    description_kk: body.description_kk != null ? body.description_kk : previous && previous.description_kk,
    price: roundPrice(priceNum),
    currency,
    kind: keep("kind"),
    category: categoryId,
    image,
    stock,
  });
}

const PRODUCT_ERROR_MESSAGES = {
  image_too_large: "Изображение больше 1.5 МБ",
  title_required: "Укажите название",
  description_required: "Укажите описание",
  invalid_price: `Укажите цену — число от 0 до ${MAX_PRICE.toLocaleString("ru-RU")}`,
  stock_held: "Нельзя выключить учёт остатка: товар ещё числится в незакрытых заказах. Отмените их или отметьте выполненными.",
  product_reserved: "Нельзя удалить товар: он ещё числится в незакрытых заказах. Отмените их или отметьте выполненными.",
  invalid_stock: `Остаток — целое число от 0 до ${MAX_STOCK} (или выключите учёт остатка)`,
  invalid_currency: "Неизвестная валюта: выберите тенге, рубли или доллары. Если список валют в форме другой — обновите страницу.",
  invalid_category: "Такого раздела нет: выберите раздел из списка. Если список в форме другой — обновите страницу.",
  invalid_image: "Картинка должна быть файлом JPG, PNG, WebP или GIF",
  invalid_image_url: "Ссылка на картинку должна начинаться с https://",
  image_host_blocked: "По этой ссылке картинку загрузить нельзя — укажите адрес в интернете или загрузите файл",
  image_fetch_failed: "Не удалось скачать картинку по ссылке — проверьте её или загрузите файл",
};

/**
 * Картинка по внешней ссылке скачивается и хранится у нас: сайт не зависит от чужого хостинга,
 * а посетители не раскрываются сторонним серверам. Ссылка, которая уже стоит у товара, не перекачивается.
 * Возвращает путь сохранённого файла (для удаления при ошибке) или null.
 */
async function localizeProductImage(body, previous) {
  const value = typeof body.image === "string" ? body.image.trim() : "";
  if (!/^https?:\/\//i.test(value) || (previous && value === previous.image)) return null;
  // Старая вкладка админки шлёт стоковую картинку вместо «без фото» — не качаем её и не зависим от unsplash.
  if (value === LEGACY_DEFAULT_IMAGE) {
    body.image = "";
    return null;
  }
  const { buffer, mime } = await fetchRemoteImage(value, { maxBytes: MAX_IMAGE_BYTES, timeoutMs: 15000 });
  const saved = saveImageBuffer(buffer, mime);
  body.image = saved;
  return saved;
}

/** Старые товары с внешними ссылками: после запуска переносим картинки к себе; не вышло — ссылка остаётся. */
async function localizeExternalImages(store) {
  let moved = 0;
  const failed = [];
  for (const product of await store.products.list()) {
    const image = String(product.image || "");
    if (!/^https:\/\//i.test(image)) continue;
    let saved = null;
    try {
      const { buffer, mime } = await fetchRemoteImage(image, { maxBytes: MAX_IMAGE_BYTES, timeoutMs: 15000 });
      saved = saveImageBuffer(buffer, mime);
      // Пока качали, админ мог поменять или удалить товар — тогда файл не нужен. Проверка и запись — в одной транзакции.
      const updated = await store.tx(async () => {
        const current = await store.products.get(product.id);
        if (!current || current.image !== image) return null;
        return store.products.update({ ...current, image: saved });
      });
      if (!updated) {
        deleteUploadIfOwned(saved);
        continue;
      }
      moved += 1;
    } catch (err) {
      if (saved) deleteUploadIfOwned(saved);
      failed.push(`${product.id} (${err.code || err.message})`);
    }
  }
  if (moved) console.log(`Картинки товаров по внешним ссылкам сохранены в images/uploads: ${moved}`);
  if (failed.length) {
    console.warn(`Картинки по внешним ссылкам пока не перенесены (повтор при следующем запуске): ${failed.join(", ")}`);
  }
}

/**
 * Ошибки, о которых менеджеру можно сказать «исправьте данные»: проверка полей (buildProductFromBody),
 * картинка (saveImageBuffer, security/remote-image.js) и остатки в незакрытых заказах (db/store.js).
 */
const PRODUCT_ERROR_STATUS = {
  title_required: 400,
  description_required: 400,
  invalid_price: 400,
  invalid_stock: 400,
  invalid_currency: 400,
  invalid_category: 400,
  invalid_image: 400,
  invalid_image_url: 400,
  image_host_blocked: 400,
  image_fetch_failed: 400,
  image_too_large: 413,
  stock_held: 409,
  product_reserved: 409,
};

/**
 * Известная ошибка — ответ 4xx с понятным текстом. Любая другая (ENOSPC, EACCES, ошибка в коде) пробрасывается
 * в глобальный обработчик: 500, журнал с requestId и оповещение — а не «Некорректные данные товара».
 * Загруженный в этом запросе файл вызывающий удаляет до вызова.
 */
function sendProductError(res, err, req) {
  const code = err && err.code;
  if (typeof code !== "string" || !Object.hasOwn(PRODUCT_ERROR_STATUS, code)) throw err;
  sendJson(res, PRODUCT_ERROR_STATUS[code], { error: code, message: PRODUCT_ERROR_MESSAGES[code] }, req);
}

function normalizePhone(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("8")) digits = "7" + digits.slice(1);
  if (digits.length === 10) digits = "7" + digits;
  return digits;
}

function hostnameOf(value) {
  return String(value || "").trim().toLowerCase().replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
}

/** Неизвестные домены, о которых уже предупредили (не больше 50, чтобы мусорные Host не росли в памяти). */
const unknownHostsWarned = new Set();

/** Сайт по домену запроса; неизвестный домен — основной сайт. */
function siteForHost(req) {
  const host = hostnameOf(req && req.headers && req.headers.host);
  const site = SITES.find((item) => item.hosts.has(host));
  if (site) return site;
  if (host && !isLocalHostname(host) && unknownHostsWarned.size < 50 && !unknownHostsWarned.has(host)) {
    unknownHostsWarned.add(host);
    console.warn(
      `⚠ Запрос на домен ${host}, которого нет в настройках, — показан сайт «${SITES.find((item) => item.id === DEFAULT_SITE).label}». ` +
        "Если это ваш домен, проверьте SITE_DOMAIN в .env (медиа-сайт открывается на media.<домен>)."
    );
  }
  return SITES.find((item) => item.id === DEFAULT_SITE);
}

/** Выключенный сайт, если запрос пришёл на его домен. */
function disabledSiteForHost(req) {
  const host = hostnameOf(req && req.headers && req.headers.host);
  return DISABLED_SITES.find((item) => item.hosts.has(host)) || null;
}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

/**
 * Домен выключенного сайта: 404, а не редирект — поисковики убирают сайт из выдачи, а не склеивают его
 * с основным как дубль; человек видит, что сайт закрыт, и ссылку на основной.
 */
function sendDisabledSite(req, res, url, site) {
  if (url.pathname.startsWith("/api/")) {
    sendJson(res, 404, { error: "site_disabled" }, req);
    return;
  }
  const main = SITES.find((item) => item.id === DEFAULT_SITE);
  const mainUrl = main.url || `http://${[...main.hosts][0]}:${PORT}`;
  const html =
    '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="robots" content="noindex">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(site.label)} — сайт не работает</title></head>` +
    '<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1rem;line-height:1.5">' +
    `<h1>Сайт «${escapeHtml(site.label)}» сейчас не работает</h1>` +
    `<p>Все услуги Dinara BILab — на основном сайте: <a href="${escapeHtml(mainUrl)}/">${escapeHtml(main.label)}</a>.</p>` +
    "</body></html>";
  res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
  res.end(req.method === "HEAD" ? undefined : html);
}

/**
 * С какого сайта пришёл заказ или вопрос в чат. Браузер присылает id своего сайта (через dev-прокси Vite
 * домен один на оба сайта); метка только для CRM, поэтому неизвестное значение заменяем доменом.
 */
function siteIdForRequest(req, bodySite) {
  const claimed = String(bodySite || "").trim();
  return SITE_IDS.has(claimed) ? claimed : siteForHost(req).id;
}

function corsOrigin(req) {
  const origin = String((req && req.headers && req.headers.origin) || "").trim();
  if (!origin) return "*";
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) return origin;
  if (/^https?:\/\//i.test(origin) && SITES.some((site) => site.hosts.has(hostnameOf(origin.replace(/^https?:\/\//i, ""))))) {
    return origin;
  }
  // file:// и прочие локальные сценарии
  if (origin === "null") return "null";
  return "http://127.0.0.1:" + PORT;
}

function corsHeaders(req) {
  return {
    "Access-Control-Allow-Origin": corsOrigin(req),
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Password, If-None-Match",
    "Access-Control-Expose-Headers": "ETag, X-Request-Id",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Vary": "Origin",
  };
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

/** id запроса для поиска в журнале: от прокси (nginx $request_id) при TRUST_PROXY=1, иначе свой. */
function assignRequestId(req, res) {
  const fromProxy = TRUST_PROXY ? String(req.headers["x-request-id"] || "").trim() : "";
  req.id = REQUEST_ID_RE.test(fromProxy) ? fromProxy : crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  res.setHeader("X-Request-Id", req.id);
}

/** Путь запроса для журнала и оповещений: без строки запроса — в ней бывают имя, телефон, поиск по клиентам. */
function requestPath(req) {
  return String((req && req.url) || "/").split(/[?#]/)[0];
}

/** Ответы от 16 КБ сжимаем, если клиент принимает gzip (за прокси без сжатия — тоже быстрее). */
const GZIP_MIN_BYTES = 16 * 1024;

function acceptsGzip(req) {
  return /\bgzip\b/i.test(String((req && req.headers && req.headers["accept-encoding"]) || ""));
}

/**
 * JSON-ответ. В ответы с ошибкой (4xx/5xx) добавляется requestId — по нему запрос находится в журнале.
 * options.etag — GET-ответ с ETag: если у клиента та же версия (If-None-Match), отдаём 304 без тела.
 */
function sendJson(res, status, body, req, options = {}) {
  if (res.headersSent || res.destroyed) return;
  const withId =
    status >= 400 && req && req.id && body && typeof body === "object" && !Array.isArray(body) && !body.requestId
      ? { ...body, requestId: req.id }
      : body;
  const payload = Buffer.from(JSON.stringify(withId), "utf8");
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(req),
  };
  if (options.etag && status === 200) {
    const etag = '"' + crypto.createHash("sha1").update(payload).digest("base64url") + '"';
    headers.ETag = etag;
    headers["Cache-Control"] = "no-store";
    const known = String((req && req.headers["if-none-match"]) || "")
      .split(",")
      .map((tag) => tag.trim().replace(/^W\//, ""));
    if (known.includes(etag)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
  }
  if (payload.length < GZIP_MIN_BYTES || !acceptsGzip(req) || status === 204) {
    res.writeHead(status, headers);
    res.end(status === 204 ? undefined : payload);
    return;
  }
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
}

/**
 * Тело сверх лимита дочитывается и выбрасывается, чтобы клиент получил ответ 413,
 * а не обрыв соединения. Совсем огромные загрузки (больше MAX_DRAIN_BYTES сверх лимита) обрываются.
 */
function readBody(req, maxBytes) {
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : MAX_BODY_BYTES;
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      chunks = [];
      reject(err);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (tooLarge) {
        if (size > limit + MAX_DRAIN_BYTES) {
          fail(new Error("body_too_large"));
          req.destroy();
        }
        return;
      }
      if (size > limit) {
        tooLarge = true;
        chunks = [];
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      if (tooLarge) return fail(new Error("body_too_large"));
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8");
      chunks = [];
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", fail);
  });
}

/** Тело запроса к API данных: только JSON-объект (null, массив или строка — 400 invalid_json). */
async function readJsonObject(req, maxBytes) {
  const body = await readBody(req, maxBytes);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SyntaxError("json_object_expected");
  return body;
}

/** Адрес посетителя для лимитов и защиты от перебора паролей (за прокси — из X-Forwarded-For, см. config/proxy.js). */
function clientIp(req) {
  return clientAddress(req, TRUST_PROXY);
}

let proxyWarningShown = false;

/** X-Forwarded-For при TRUST_PROXY=0: сайт за прокси, но все посетители выглядят одним адресом. */
function warnIfUntrustedProxy(req) {
  if (TRUST_PROXY || proxyWarningShown || !req.headers["x-forwarded-for"]) return;
  proxyWarningShown = true;
  console.warn(
    "⚠ Запросы приходят через прокси (есть X-Forwarded-For), но в .env стоит TRUST_PROXY=0: все посетители считаются " +
      "одним адресом — лимит заказов станет общим на весь сайт, а неверные пароли заблокируют вход в админку всем. " +
      "Уберите строку TRUST_PROXY=0 из .env (или поставьте 1) и перезапустите сервер."
  );
}

function isLocalHost(req) {
  const host = hostnameOf(req.headers.host);
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}

/** Прокси сообщил, что посетитель пришёл по HTTP (не HTTPS) и не с этого компьютера. */
function isInsecureProxiedRequest(req) {
  if (isLocalHost(req)) return false;
  const proto = forwardedProto(req, TRUST_PROXY);
  // Прокси не сообщил протокол — значит, он настроен не по deploy/*.template; считаем соединение небезопасным.
  if (!proto) return isProxied(req, TRUST_PROXY);
  return proto !== "https";
}

/** Без application/json браузер шлёт запрос с чужого сайта без CORS-проверки — такие не принимаем. */
function isJsonRequest(req) {
  return /^application\/json\b/i.test(String(req.headers["content-type"] || ""));
}

function checkRateLimit(buckets, ip, limit, windowMs) {
  const now = Date.now();
  const windowStart = now - windowMs;
  let stamps = buckets.get(ip) || [];
  stamps = stamps.filter((t) => t > windowStart);
  if (stamps.length >= limit) {
    buckets.set(ip, stamps);
    return false;
  }
  stamps.push(now);
  buckets.set(ip, stamps);
  if (buckets.size > 5000) {
    for (const [key, list] of buckets) {
      const fresh = list.filter((t) => t > windowStart);
      if (!fresh.length) buckets.delete(key);
      else buckets.set(key, fresh);
    }
  }
  return true;
}

function isOverRateLimit(buckets, ip, limit, windowMs) {
  const windowStart = Date.now() - windowMs;
  return (buckets.get(ip) || []).filter((t) => t > windowStart).length >= limit;
}

function allowsCartQty(product) {
  if (SINGLE_QTY_IDS.has(product.id)) return false;
  return !SINGLE_QTY_TITLE_RE.test(product.title);
}

const CURRENCY_SYMBOLS = { KZT: "₸", RUB: "₽", USD: "$" };
const NBSP = "\u00A0";

function formatPrice(value, currency) {
  const amount = new Intl.NumberFormat("ru-RU").format(Number(value) || 0).replace(/\s/g, NBSP);
  const symbol = CURRENCY_SYMBOLS[currency] || CURRENCY_SYMBOLS.KZT;
  return currency === "USD" ? symbol + amount : amount + NBSP + symbol;
}

function totalsText(items) {
  const totals = new Map();
  items.forEach((item) => {
    const minor = Math.round(Number(item.lineTotal) * 100);
    totals.set(item.currency, (totals.get(item.currency) || 0) + (Number.isFinite(minor) ? minor : 0));
  });
  if (!totals.size) return formatPrice(0, "KZT");
  return Array.from(totals, ([currency, minor]) => formatPrice(minor / 100, currency)).join(" + ");
}

/**
 * Позиции заказа из корзины по каталогу сервера: название, цену и сумму от браузера не берём.
 * Если товара нет, он только для обсуждения или его цена/валюта разошлись с корзиной —
 * catalog_changed: покупатель видел другие условия, сайт обновит каталог и попросит проверить корзину.
 * Количество не исправляется молча: не целое, меньше 1 или больше предела позиции — qty_out_of_range
 * (иначе в CRM было бы одно количество, а в сообщении клиента в мессенджер — другое).
 */
function buildCartItems(rawItems, products) {
  if (!Array.isArray(rawItems) || !rawItems.length) return { error: "items_required" };
  if (rawItems.length > 50) return { error: "items_invalid" };
  const byId = new Map(products.map((product) => [product.id, product]));
  const lines = new Map();
  for (const item of rawItems) {
    const raw = item && typeof item === "object" ? item : {};
    const product = byId.get(String(raw.id || "").trim());
    if (!product || DISCUSS_ONLY_CATEGORIES.has(product.category)) return { error: "catalog_changed" };
    if (raw.price != null && Number(raw.price) !== product.price) return { error: "catalog_changed" };
    if (raw.currency != null && String(raw.currency).trim().toUpperCase() !== product.currency) return { error: "catalog_changed" };
    const qty = Number(raw.qty);
    if (!Number.isInteger(qty) || qty < 1) return { error: "qty_out_of_range" };
    lines.set(product.id, { product, qty: (lines.has(product.id) ? lines.get(product.id).qty : 0) + qty });
  }
  for (const { product, qty } of lines.values()) {
    if (qty > (allowsCartQty(product) ? MAX_CART_QTY : 1)) return { error: "qty_out_of_range" };
  }
  const items = Array.from(lines.values(), ({ product, qty }) => ({
    id: product.id,
    title: product.title,
    qty,
    price: product.price,
    currency: product.currency,
    lineTotal: lineAmount(product.price, qty),
    kind: product.kind,
  }));
  return { items };
}

/** Нехватка остатка при списании → 409 со списком позиций и доступным количеством; транзакция уже откачена. */
async function withStockErrors(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!err || err.code !== "out_of_stock") throw err;
    const titles = err.items.map((item) => `«${item.title}» — доступно ${item.available}`).join(", ");
    return {
      status: 409,
      body: {
        error: "out_of_stock",
        items: err.items.map(({ id, available }) => ({ id, available })),
        message: "Недостаточно на складе: " + titles,
      },
    };
  }
}

function buildLeadItem(category) {
  return {
    id: "lead" + (category ? "-" + category.id : ""),
    title: category ? "Заявка: " + category.title : "Заявка с сайта",
    qty: 1,
    price: 0,
    currency: "KZT",
    lineTotal: 0,
    kind: "service",
  };
}

function buildChatLeadItem(category) {
  return {
    ...buildLeadItem(category),
    id: "lead-chat" + (category ? "-" + category.id : ""),
    title: category ? "ИИ-чат: " + category.title : "Заявка из ИИ-чата",
  };
}

/**
 * Номер обращения из ИИ-чата: те же 6 символов id браузер подставляет в сообщение WhatsApp,
 * чтобы менеджер нашёл диалог в CRM (src/chat/handoff-lead.js).
 */
function chatCodeFor(orderId) {
  return String(orderId).replace(/^ord_/, "").replace(/-/g, "").slice(0, 6).toUpperCase();
}

function isAdmin(req) {
  return headerMatchesPassword(req.headers["x-admin-password"], ADMIN_PASSWORD);
}

/**
 * Строгий лимит — на неверные пароли (защита от перебора); пока он исчерпан, отказываем всем,
 * чтобы 429/200 не выдавали верный пароль. Авторизованная работа ограничена мягче.
 */
function requireAdmin(req, res) {
  const ip = clientIp(req);
  const tooMany = () => {
    sendJson(res, 429, { error: "rate_limited", message: "Слишком много запросов. Подождите минуту." }, req);
    return false;
  };
  if (isInsecureProxiedRequest(req)) {
    sendJson(res, 403, { error: "https_required", message: "Админка работает только по HTTPS" }, req);
    return false;
  }
  if (isOverRateLimit(adminFailBuckets, ip, ADMIN_RATE_LIMIT, ADMIN_RATE_WINDOW_MS)) return tooMany();
  if (!isAdmin(req)) {
    checkRateLimit(adminFailBuckets, ip, ADMIN_RATE_LIMIT, ADMIN_RATE_WINDOW_MS);
    sendJson(res, 401, { error: "unauthorized" }, req);
    return false;
  }
  if (!checkRateLimit(adminRateBuckets, ip, ADMIN_RATE_LIMIT * 10, ADMIN_RATE_WINDOW_MS)) return tooMany();
  return true;
}

/** Путь внутри baseDir или null, если запрос пытается выйти за его пределы. */
function safePathIn(baseDir, relPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(relPath);
  } catch {
    return null;
  }
  const clean = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(baseDir, clean);
  const rel = path.relative(baseDir, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep).filter(Boolean);
  if (!parts.length || parts.some((part) => part.startsWith("."))) return null;
  return full;
}

const MAX_MONEY = 1e12;
const MAX_ITEM_DISCOUNTS = 500;

/** Сумма для заказа: число от 0, копейки округляются; пустое значение — 0. */
function moneyField(value) {
  const n = value === "" || value == null ? 0 : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) throw new Error("invalid_amount");
  return Math.round(n * 100) / 100;
}

/** Скидки, доставка и НДС из PATCH заказа (поля, которых нет в запросе, не трогаем). */
function orderAdjustments(body) {
  const fields = {};
  if (body.discount !== undefined) fields.discount = moneyField(body.discount);
  if (body.delivery !== undefined) fields.delivery = moneyField(body.delivery);
  if (body.adjustCurrency !== undefined) {
    if (!CURRENCY_SYMBOLS[body.adjustCurrency]) throw new Error("invalid_currency");
    fields.adjustCurrency = body.adjustCurrency;
  }
  if (body.vatRate !== undefined) {
    const rate = body.vatRate === "" || body.vatRate == null ? 0 : Number(body.vatRate);
    if (!Number.isFinite(rate) || rate < 0 || rate >= 100) throw new Error("invalid_vat_rate");
    fields.vatRate = Math.round(rate * 100) / 100;
  }
  if (body.itemDiscounts !== undefined) {
    if (!Array.isArray(body.itemDiscounts) || body.itemDiscounts.length > MAX_ITEM_DISCOUNTS) throw new Error("invalid_amount");
    fields.itemDiscounts = body.itemDiscounts.map((entry) => {
      const position = Number(entry && entry.position);
      if (!Number.isInteger(position) || position < 0) throw new Error("invalid_amount");
      return { position, discount: moneyField(entry.discount) };
    });
  }
  return fields;
}

/**
 * Заказ для полного списка (клиенты, отчёты, экспорт): без текста сообщения — он до 8000 символов
 * и есть в карточке заказа (GET /api/orders/:id и страницы ?limit=). Исключение — старые заявки
 * без поля lead: отчёт и сообщение клиенту берут комментарий из текста, начиная со строки «Комментарий:».
 */
function orderSummary(order) {
  const { message, ...rest } = order;
  if (order.channel !== "site") return withTotals(rest);
  if (order.lead) return rest;
  const text = String(message || "");
  const start = text.search(/^Комментарий:/m);
  return start >= 0 ? { ...rest, message: text.slice(start, start + 2000) } : rest;
}

/** Заказ для карточки в CRM: плюс разбивка итога (позиции, скидки, доставка) по валютам. У заявок сумм нет. */
function withTotals(order) {
  if (!order || order.channel === "site") return order;
  return { ...order, totals: orderTotalsSummary(order) };
}

/** Граница периода из запроса: дата-время ISO → нормализованная строка ISO в UTC, иначе null. */
function isoParam(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 40) return null;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Ссылки и разметка в имени — признак спама; у людей их там не бывает. */
const SPAM_NAME_RE = /(https?:|www\.|<[a-z/]|\[url|@\w+\.\w)/i;

/** Содержимое заказа для склейки повторов: тот же телефон + та же корзина или та же заявка. */
function orderFingerprint(channel, body, leadCategory, rawLead) {
  if (channel === "site") {
    return "site:" + (leadCategory ? leadCategory.id : "") + ":" + String(rawLead.comment || "").trim().slice(0, 300);
  }
  const items = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
  return channel + ":" + items.map((item) => String(item && item.id) + "x" + Number(item && item.qty)).sort().join(",");
}

async function handleOrdersApi(req, res, orderId, url) {
  if (orderId === "challenge" && req.method === "GET") {
    const issued = orderGuard.challenge(clientIp(req));
    res.setHeader("Cache-Control", "no-store");
    if (!issued.ok) {
      res.setHeader("Retry-After", "300");
      sendJson(res, issued.status, { error: issued.error, message: issued.message }, req);
      return;
    }
    sendJson(res, 200, issued.body, req);
    return;
  }

  if (req.method === "POST" && !orderId) {
    const body = await readJsonObject(req);
    // Переход из ИИ-чата в мессенджер — тоже заявка с сайта; имя и телефон клиент мог не называть.
    const fromChat = body.channel === "chat";
    let customerName = String(body.customerName || "").trim().slice(0, 120);
    let customerPhone = String(body.customerPhone || "").trim().slice(0, 32);
    let phoneDigits = normalizePhone(customerPhone);
    const nameOk = customerName.length >= 2 && !SPAM_NAME_RE.test(customerName);
    const phoneOk = phoneDigits.length >= 11 && phoneDigits.length <= 15;
    if (fromChat) {
      if (!nameOk) customerName = "";
      if (!phoneOk) customerPhone = phoneDigits = "";
    } else if (!nameOk || !phoneOk) {
      sendJson(res, 400, {
        error: "customer_required",
        message: "Укажите имя и телефон",
      }, req);
      return;
    }
    const channel = fromChat ? "site" : ["telegram", "site"].includes(body.channel) ? body.channel : "whatsapp";
    const rawLead = body.lead && typeof body.lead === "object" ? body.lead : {};
    const leadCategory = CATEGORIES.find((item) => item.id === String(rawLead.direction || "")) || null;
    // Случайный UUID от браузера — ключ идемпотентности; иначе id выдаёт сервер, чтобы его нельзя было угадать.
    const newOrderId = ORDER_ID_RE.test(String(body.id || "")) ? String(body.id) : "ord_" + crypto.randomUUID();
    if (fromChat && !String(rawLead.comment || "").trim()) {
      sendJson(res, 400, { error: "message_required", message: "Пустой диалог" }, req);
      return;
    }

    // Повтор после сбоя сети (тот же id) — без новой проверки: токен первой попытки уже израсходован.
    if (await store.orders.exists(newOrderId)) {
      sendJson(res, 200, { id: newOrderId, duplicate: true }, req);
      return;
    }

    const ip = clientIp(req);
    const fingerprint = (fromChat ? "chat:" : "") + orderFingerprint(channel, body, leadCategory, rawLead);
    // Без телефона лимиты «на номер» считаются по адресу, иначе все анонимные заявки делили бы один счётчик.
    const limitKey = phoneDigits || "anon:" + ip;
    // Без исключения для админа: иначе ответ на X-Admin-Password выдавал бы, верен ли пароль, в обход лимита неверных попыток.
    const guard = orderGuard.check({ ip, phone: limitKey, fingerprint, body });
    if (!guard.ok) {
      if (guard.status === 429) res.setHeader("Retry-After", "600");
      sendJson(res, guard.status, { error: guard.error, message: guard.message }, req);
      return;
    }
    if (guard.trap) {
      console.warn(`[${req.id}] Заказ с заполненным полем-ловушкой не сохранён (адрес ${ip})`);
      sendJson(res, 201, { id: newOrderId, status: "new" }, req);
      return;
    }
    if (guard.duplicateOf && (await store.orders.exists(guard.duplicateOf))) {
      sendJson(res, 200, { id: guard.duplicateOf, duplicate: true }, req);
      return;
    }

    const result = await withStockErrors(() => store.tx(async () => {
      if (await store.orders.exists(newOrderId)) return { status: 200, body: { id: newOrderId, duplicate: true } };

      let items;
      if (fromChat) {
        items = [buildChatLeadItem(leadCategory)];
      } else if (channel === "site") {
        items = [buildLeadItem(leadCategory)];
      } else {
        const built = buildCartItems(body.items, await store.products.list());
        if (built.error) {
          const status = built.error === "catalog_changed" ? 409 : 400;
          const body = { error: built.error };
          if (built.error === "qty_out_of_range") body.message = `Количество позиции — целое число от 1 до ${MAX_CART_QTY}; для части услуг — только 1`;
          return { status, body };
        }
        items = built.items;
      }

      const now = new Date().toISOString();
      const created = {
        id: newOrderId,
        createdAt: now,
        updatedAt: now,
        channel,
        status: "new",
        customerName,
        customerPhone,
        items,
        totalText: fromChat ? "Диалог из ИИ-чата" : channel === "site" ? "Заявка с формы" : totalsText(items),
        message: String(body.message || "").slice(0, 8000),
        sourcePage: String(body.sourcePage || "").slice(0, 120),
        site: siteIdForRequest(req, body.site),
      };
      if (channel === "site") {
        created.lead = {
          direction: leadCategory ? leadCategory.id : "",
          comment: String(rawLead.comment || "").trim().slice(0, 2000),
        };
      }
      if (fromChat) {
        created.leadSource = "chat";
        created.handoff = body.handoff === "telegram" ? "telegram" : "whatsapp";
        created.chatCode = chatCodeFor(newOrderId);
      }

      // Карточку клиента создаёт переход заказа в работу (PATCH) — спам-заказы не плодят карточки.
      const client = await store.clients.findByContact(customerName, customerPhone);
      if (client) created.clientId = client.id;

      return { status: 201, body: await store.orders.insert(created) };
    }));
    if (result.status === 201) {
      orderGuard.accepted({ phone: limitKey, fingerprint, orderId: newOrderId });
      notifier.order(result.body);
      refreshAiCatalog();
    }
    sendJson(res, result.status, result.body, req);
    return;
  }

  if (req.method === "GET" && !orderId) {
    if (!requireAdmin(req, res)) return;
    const query = url.searchParams;
    // ?limit=… — страница для вкладок «Заказы» и «Заявки»; без него — весь список (клиенты, отчёты, экспорт).
    if (query.has("limit")) {
      const status = query.get("status");
      const from = query.has("from") ? isoParam(query.get("from")) : null;
      const to = query.has("to") ? isoParam(query.get("to")) : null;
      if ((query.get("from") && !from) || (query.get("to") && !to)) {
        sendJson(res, 400, { error: "invalid_date", message: "Проверьте даты периода" }, req);
        return;
      }
      try {
        const page = await store.orders.page({
          kind: query.get("kind"),
          status: ORDER_STATUSES.includes(status) ? status : null,
          cursor: query.get("cursor"),
          limit: query.get("limit"),
          q: String(query.get("q") || "").slice(0, 100),
          from,
          to,
        });
        sendJson(res, 200, { ...page, items: page.items.map(withTotals) }, req);
      } catch (err) {
        if (err && err.code === "invalid_cursor") sendJson(res, 400, { error: "invalid_cursor" }, req);
        else throw err;
      }
      return;
    }
    // Только чтение: карточки клиентов заводятся при смене статуса заказа, а не при просмотре списка.
    sendJson(res, 200, (await store.orders.list()).map(orderSummary), req, { etag: true });
    return;
  }

  if (req.method === "GET" && orderId) {
    if (!requireAdmin(req, res)) return;
    const order = await store.orders.get(orderId);
    if (!order) {
      sendJson(res, 404, { error: "not_found" }, req);
      return;
    }
    sendJson(res, 200, withTotals(order), req);
    return;
  }

  if (req.method === "PATCH" && orderId) {
    if (!requireAdmin(req, res)) return;
    const body = await readJsonObject(req);
    let fields;
    try {
      fields = orderAdjustments(body);
    } catch (err) {
      sendJson(res, 400, { error: err.message, message: "Проверьте скидки, доставку и ставку НДС" }, req);
      return;
    }
    if (body.status !== undefined) {
      if (!ORDER_STATUSES.includes(body.status)) {
        sendJson(res, 400, { error: "invalid_status", message: "Неизвестный статус заказа — обновите страницу и выберите статус из списка" }, req);
        return;
      }
      fields.status = body.status;
    }
    if (typeof body.customerName === "string") fields.customerName = body.customerName.trim().slice(0, 120);
    if (typeof body.customerPhone === "string") fields.customerPhone = body.customerPhone.trim().slice(0, 32);
    if (typeof body.note === "string") fields.note = body.note.trim().slice(0, 500);
    if (body.clientId !== undefined) {
      const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
      if (!clientId || clientId.length > 80 || !(await store.clients.exists(clientId))) {
        sendJson(res, 400, { error: "client_not_found", message: "Такого клиента нет — обновите список клиентов" }, req);
        return;
      }
      fields.clientId = clientId;
    }
    const result = await withStockErrors(() => store.tx(async () => {
      let updated = await store.orders.patch(orderId, fields);
      if (!updated) return { status: 404, body: { error: "not_found" } };
      // Заказ взят в работу — теперь это настоящий клиент: заводим карточку (с формы она не создаётся).
      if (!updated.clientId && (updated.status === "in_progress" || updated.status === "done")) {
        const client = await store.clients.upsert({ name: updated.customerName, phone: updated.customerPhone, source: "order" });
        if (client) updated = (await store.orders.patch(orderId, { clientId: client.id })) || updated;
      }
      return { status: 200, body: withTotals(updated) };
    }));
    if (result.status === 200) refreshAiCatalog();
    sendJson(res, result.status, result.body, req);
    return;
  }

  if (req.method === "DELETE" && orderId) {
    if (!requireAdmin(req, res)) return;
    if (!(await store.orders.remove(orderId))) {
      sendJson(res, 404, { error: "not_found" }, req);
      return;
    }
    refreshAiCatalog();
    sendJson(res, 200, { ok: true }, req);
    return;
  }

  sendJson(res, 405, { error: "method_not_allowed" }, req);
}

/**
 * Реквизиты покупателя из тела запроса: undefined — не переданы, false — ошибка (ответ 400 уже отправлен).
 */
function clientRequisites(body, res, req) {
  if (body.requisites === undefined) return undefined;
  const { values, errors } = normalizeClientRequisites(body.requisites);
  if (errors.length) {
    sendJson(res, 400, { error: "invalid_requisites", message: "Проверьте реквизиты", errors }, req);
    return false;
  }
  return values;
}

async function handleClientsApi(req, res, clientId) {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {}, req);
    return;
  }
  if (!requireAdmin(req, res)) return;

  if (req.method === "GET" && !clientId) {
    sendJson(res, 200, await store.clients.list(), req);
    return;
  }

  if (req.method === "POST" && !clientId) {
    const body = await readJsonObject(req);
    const requisites = clientRequisites(body, res, req);
    if (requisites === false) return;
    const client = await store.tx(async () => {
      const created = await store.clients.upsert({
        id: body.id != null ? String(body.id).trim().slice(0, 80) : "",
        name: body.name != null ? String(body.name).slice(0, 120) : "",
        phone: body.phone != null ? String(body.phone).slice(0, 32) : "",
        note: body.note != null ? String(body.note).slice(0, 500) : undefined,
        source: body.source,
        requisites,
      });
      if (created) await store.clients.syncOrders(created, null);
      return created;
    });
    if (!client) {
      sendJson(res, 400, { error: "name_or_phone_required" }, req);
      return;
    }
    sendJson(res, 201, client, req);
    return;
  }

  if (req.method === "PATCH" && clientId) {
    const body = await readJsonObject(req);
    const fields = {};
    if (typeof body.name === "string") fields.name = body.name.trim().slice(0, 120);
    if (typeof body.phone === "string") fields.phone = body.phone.trim().slice(0, 32);
    if (typeof body.note === "string") fields.note = body.note.trim().slice(0, 500);
    const requisites = clientRequisites(body, res, req);
    if (requisites === false) return;
    if (requisites !== undefined) fields.requisites = requisites;
    const client = await store.clients.patch(clientId, fields);
    if (!client) {
      sendJson(res, 404, { error: "not_found" }, req);
      return;
    }
    sendJson(res, 200, client, req);
    return;
  }

  if (req.method === "DELETE" && clientId) {
    if (!(await store.clients.remove(clientId))) {
      sendJson(res, 404, { error: "not_found" }, req);
      return;
    }
    sendJson(res, 200, { ok: true }, req);
    return;
  }

  sendJson(res, 405, { error: "method_not_allowed" }, req);
}

async function handleProductsApi(req, res, productId) {
  if (req.method === "GET" && !productId) {
    sendJson(res, 200, await store.products.list(), req);
    return;
  }

  if (req.method === "GET" && productId) {
    const product = await store.products.get(productId);
    if (!product) {
      sendJson(res, 404, { error: "not_found" }, req);
      return;
    }
    sendJson(res, 200, product, req);
    return;
  }

  if (!requireAdmin(req, res)) return;

  if (req.method === "POST" && !productId) {
    let body;
    try {
      body = await readJsonObject(req, MAX_PRODUCTS_BODY_BYTES);
    } catch (err) {
      if (err && err.message === "body_too_large") {
        sendJson(res, 413, { error: "body_too_large", message: "Слишком большой файл изображения" }, req);
        return;
      }
      sendJson(res, 400, { error: "invalid_json" }, req);
      return;
    }

    let product;
    let fetched = null;
    try {
      fetched = await localizeProductImage(body, null);
      product = buildProductFromBody(body, null);
    } catch (err) {
      deleteUploadIfOwned(fetched);
      sendProductError(res, err, req);
      return;
    }
    let created;
    try {
      created = await store.products.insert(product);
    } catch (err) {
      deleteUploadIfOwned(product.image);
      throw err;
    }
    refreshAiCatalog();
    sendJson(res, 201, created, req);
    return;
  }

  if (req.method === "PATCH" && productId) {
    let body;
    try {
      body = await readJsonObject(req, MAX_PRODUCTS_BODY_BYTES);
    } catch (err) {
      if (err && err.message === "body_too_large") {
        sendJson(res, 413, { error: "body_too_large", message: "Слишком большой файл изображения" }, req);
        return;
      }
      sendJson(res, 400, { error: "invalid_json" }, req);
      return;
    }

    // Картинку по ссылке качаем до чтения товара: за время загрузки могли пройти продажи (остаток).
    let fetched = null;
    try {
      const current = await store.products.get(productId);
      if (current) fetched = await localizeProductImage(body, current);
    } catch (err) {
      sendProductError(res, err, req);
      return;
    }
    const previous = await store.products.get(productId);
    if (!previous) {
      deleteUploadIfOwned(fetched);
      sendJson(res, 404, { error: "not_found" }, req);
      return;
    }
    // Остаток меняется продажами, пока админ редактирует карточку: stockBase — значение, которое он видел.
    // Если оно устарело, не затираем продажи, а просим проверить.
    if (body.stock !== undefined && body.stockBase !== undefined && parseStock(body.stockBase) !== previous.stock) {
      deleteUploadIfOwned(fetched);
      sendJson(res, 409, {
        error: "stock_conflict",
        stock: previous.stock,
        message: "Остаток изменился, пока вы редактировали товар (были продажи или отмены). Проверьте значение и сохраните снова.",
      }, req);
      return;
    }
    let next;
    try {
      next = buildProductFromBody(body, previous);
    } catch (err) {
      deleteUploadIfOwned(fetched);
      sendProductError(res, err, req);
      return;
    }
    const imageChanged = previous.image !== next.image;
    let updated;
    try {
      updated = await store.products.update(next);
    } catch (err) {
      if (imageChanged) deleteUploadIfOwned(next.image);
      if (err && err.code === "stock_held") {
        sendProductError(res, err, req);
        return;
      }
      throw err;
    }
    if (!updated) {
      if (imageChanged) deleteUploadIfOwned(next.image);
      sendJson(res, 404, { error: "not_found" }, req);
      return;
    }
    if (imageChanged) deleteUploadIfOwned(previous.image);
    refreshAiCatalog();
    sendJson(res, 200, updated, req);
    return;
  }

  if (req.method === "DELETE" && productId) {
    let removed;
    try {
      removed = await store.products.remove(productId);
    } catch (err) {
      if (err && err.code === "product_reserved") {
        sendProductError(res, err, req);
        return;
      }
      throw err;
    }
    if (!removed) {
      sendJson(res, 404, { error: "not_found" }, req);
      return;
    }
    deleteUploadIfOwned(removed.image);
    refreshAiCatalog();
    sendJson(res, 200, { ok: true }, req);
    return;
  }

  sendJson(res, 405, { error: "method_not_allowed" }, req);
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {}, req);
    return;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api") {
    sendJson(res, 404, { error: "not_found" }, req);
    return;
  }

  if (["POST", "PUT", "PATCH"].includes(req.method) && DATA_APIS.has(parts[1]) && !isJsonRequest(req)) {
    sendJson(res, 415, { error: "unsupported_media_type", message: "Ожидается JSON (Content-Type: application/json)" }, req);
    return;
  }

  if (parts[1] === "client-errors" && parts.length === 2) {
    await handleClientErrors(req, res);
    return;
  }

  if (documentsHttp.matches(parts)) {
    await documentsHttp.handle(req, res, parts);
    return;
  }

  if (parts[1] === "orders") {
    await handleOrdersApi(req, res, parts[2] || null, url);
    return;
  }

  if (parts[1] === "clients") {
    await handleClientsApi(req, res, parts[2] || null);
    return;
  }

  if (parts[1] === "products") {
    await handleProductsApi(req, res, parts[2] || null);
    return;
  }

  if (parts[1] === "chat") {
    await handleAiApi(req, res, "consultant");
    return;
  }

  if (parts[1] === "ai") {
    await handleAiApi(req, res, parts[2] || null);
    return;
  }

  sendJson(res, 404, { error: "not_found" }, req);
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function isFile(filePath) {
  return !!filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

const sendFile = createFileSender({
  mime: MIME,
  onServerError: (req, err) => notifier.serverError(req.method, requestPath(req), err),
});

const SITE_LANGS = ["kk", "ru"];
const DEFAULT_SITE_LANG = "kk";
/** Поисковики и превью ссылок: без редиректа по языку, им отдаём x-default (kk). */
const BOT_UA = /bot|crawl|spider|slurp|bingpreview|yandex|facebookexternalhit|whatsapp|vkshare|telegram/i;

/** Язык посетителя: cookie lang (явный выбор) → Accept-Language → kk. */
function pickSiteLang(req) {
  const cookie = String(req.headers.cookie || "").match(/(?:^|;\s*)lang=(kk|ru)(?:;|$)/);
  if (cookie) return cookie[1];
  const prefs = String(req.headers["accept-language"] || "")
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { base: tag.toLowerCase().split("-")[0], q: q ? Number(q.slice(2)) || 0 : 1 };
    })
    .filter((pref) => pref.q > 0)
    .sort((a, b) => b.q - a.q);
  const hit = prefs.find((pref) => SITE_LANGS.includes(pref.base));
  return hit ? hit.base : DEFAULT_SITE_LANG;
}

/** Статья раздела «Полезные статьи»: /articles/<slug>; есть ли такая статья — решает фронтенд. */
const ARTICLE_PATH_RE = /^\/articles\/[a-z0-9-]{1,120}$/;

/** Ближайший существующий раздел: /shop/что-угодно → /shop, /articles/… → /articles, остальное → главная. */
function nearestSection(rest) {
  if (rest === "/" || rest === "") return "/";
  if (rest === "/shop" || rest === "/shop/" || rest === "/shop.html") return "/shop";
  if (rest.startsWith("/shop/")) return "/shop";
  if (rest === "/articles" || rest.startsWith("/articles/")) return "/articles";
  return "/";
}

const SECTION_HTML = { "/shop": "shop.html", "/articles": "articles.html" };

function sendLangPage(req, res, distDir, lang, section) {
  const name = SECTION_HTML[section] || "index.html";
  const localized = lang ? path.join(distDir, lang, name) : "";
  const filePath = isFile(localized) ? localized : path.join(distDir, isFile(path.join(distDir, name)) ? name : "index.html");
  res.setHeader("Content-Language", lang || DEFAULT_SITE_LANG);
  sendFile(req, res, filePath, "no-cache");
}

function redirect(res, status, location, headers = {}) {
  res.writeHead(status, { Location: location, ...headers });
  res.end();
}

function serveStatic(req, res, url) {
  const pathname = url.pathname;

  if (LEGACY_REDIRECTS[pathname]) {
    res.writeHead(301, { Location: LEGACY_REDIRECTS[pathname] + url.search + url.hash });
    res.end();
    return;
  }

  if (pathname.startsWith("/images/")) {
    const filePath = safePathIn(IMAGES_DIR, pathname.slice("/images/".length));
    if (!isFile(filePath)) {
      sendText(res, 404, "Not found");
      return;
    }
    sendFile(req, res, filePath);
    return;
  }

  const site = siteForHost(req);
  const distDir = site.distDir;
  if (!fs.existsSync(path.join(distDir, "index.html"))) {
    sendText(
      res,
      503,
      `Фронтенд сайта «${site.label}» не собран. Выполните \`npm run build\` (или запустите start-site.bat).`
    );
    return;
  }

  // /kk/…, /ru/… — языковые версии страниц.
  const langMatch = pathname.match(/^\/(kk|ru)(\/.*)?$/);
  if (langMatch) {
    const lang = langMatch[1];
    const rest = langMatch[2] || "";
    const section = nearestSection(rest);
    const canonical = "/" + lang + (section === "/" ? "/" : section);
    if (rest !== "/" && rest !== "/shop" && rest !== "/articles" && !ARTICLE_PATH_RE.test(rest)) {
      redirect(res, rest === "" || rest === "/index.html" || rest === "/shop.html" ? 301 : 302, canonical + url.search);
      return;
    }
    sendLangPage(req, res, distDir, lang, section);
    return;
  }

  if (pathname !== "/") {
    const filePath = safePathIn(distDir, pathname.slice(1));
    if (!filePath) {
      sendText(res, 404, "Not found");
      return;
    }
    if (isFile(filePath)) {
      const immutable = pathname.startsWith("/assets/");
      sendFile(req, res, filePath, immutable ? "public, max-age=31536000, immutable" : "no-cache");
      return;
    }
    // Файл с расширением не найден — 404, а не SPA-страница.
    if (path.extname(pathname)) {
      sendText(res, 404, "Not found");
      return;
    }
  }

  // Страницы без языкового префикса (/, /shop, старые ссылки): людям — редирект на язык
  // из cookie / Accept-Language, ботам — x-default без редиректа (там canonical и hreflang).
  const section = nearestSection(pathname);
  if (BOT_UA.test(String(req.headers["user-agent"] || ""))) {
    sendLangPage(req, res, distDir, "", section);
    return;
  }
  const lang = pickSiteLang(req);
  const target = ARTICLE_PATH_RE.test(pathname) ? pathname : section === "/" ? "/" : section;
  redirect(res, 302, "/" + lang + target + url.search, {
    Vary: "Accept-Language, Cookie",
    "Cache-Control": "private, no-cache",
  });
}

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
/**
 * База открывается только после того, как порт занят: если уже запущен другой экземпляр сервера,
 * этот завершится, не трогая данные (в т.ч. не начав перенос из JSON).
 */
let store = null;
let documents = null;
const sender = createSender({ env: process.env });
const crmSite = SITES.find((site) => site.admin) || SITES[0];
const notifier = createNotifier({
  sender,
  stateFile: path.join(DATA_DIR, "notify-state.json"),
  crmUrl: (crmSite.url || `http://${[...crmSite.hosts][0]}:${PORT}`) + "/admin.html",
});
const handleClientErrors = createClientErrorsHandler({
  readJsonObject,
  sendJson,
  isJsonRequest,
  clientIp,
  checkRateLimit,
  notifier,
  siteIds: SITE_IDS,
  hideSecrets: sender.hideSecrets,
});
const documentsHttp = createDocumentsHttpHandler(() => documents, sender, {
  sendJson,
  readJsonObject,
  requireAdmin,
  corsHeaders,
});

const AI_BUDGET_KEY = "ai_budget";
const AI_HISTORY_SECRET_KEY = "ai_history_secret";
/** Каталог для ИИ перечитывается после каждой правки товаров и заказов; это — страховка на случай пропуска. */
const AI_CATALOG_MAX_AGE_MS = 60 * 1000;

/**
 * ИИ-ядро читает каталог, расход бюджета и ключ подписи синхронно, а база отвечает асинхронно.
 * Поэтому здесь их копии в памяти: загружаются при запуске (loadAiState) до приёма запросов к API.
 */
const aiState = {
  catalog: null,
  catalogVersion: 0,
  catalogCheckedAt: 0,
  budget: null,
  budgetWrites: Promise.resolve(),
  historySecret: null,
};

function refreshAiCatalog(target = store) {
  if (!target) return Promise.resolve();
  const version = ++aiState.catalogVersion;
  aiState.catalogCheckedAt = Date.now();
  return target.products.list().then(
    (list) => {
      if (version === aiState.catalogVersion) aiState.catalog = list;
    },
    (err) => console.warn("Каталог для ИИ-консультанта не обновлён:", err.message)
  );
}

/**
 * Каталог, расход бюджета за сутки и ключ подписи реплик консультанта.
 * Ключ — из .env (AI_HISTORY_SECRET) или созданный один раз и сохранённый в базе.
 */
async function loadAiState(target) {
  await refreshAiCatalog(target);
  aiState.budget = await target.settings.get(AI_BUDGET_KEY);
  const fromEnv = String(process.env.AI_HISTORY_SECRET || "").trim();
  if (fromEnv.length >= 16) {
    aiState.historySecret = fromEnv;
    return;
  }
  const saved = await target.settings.get(AI_HISTORY_SECRET_KEY);
  aiState.historySecret =
    typeof saved === "string" && saved.length >= 32
      ? saved
      : await target.settings.set(AI_HISTORY_SECRET_KEY, crypto.randomBytes(32).toString("base64url"));
}

const ai = createAi(process.env, {
  budgetStorage: {
    load: () => aiState.budget,
    // Записи по очереди: более старое состояние не перезапишет новое, даже если запрос к базе ответит позже.
    save: (state) => {
      aiState.budget = state;
      if (!store) return;
      const target = store;
      aiState.budgetWrites = aiState.budgetWrites
        .then(() => target.settings.set(AI_BUDGET_KEY, state))
        .catch((err) => console.error("AI-бюджет: не удалось сохранить расход:", err.message));
    },
  },
  getProducts: () => {
    if (store && Date.now() - aiState.catalogCheckedAt > AI_CATALOG_MAX_AGE_MS) refreshAiCatalog();
    return aiState.catalog;
  },
  historySecret: () => aiState.historySecret,
  notifier,
});
const handleAiApi = createAiHttpHandler(ai, {
  sendJson,
  readBody,
  clientIp,
  checkRateLimit,
  requireAdmin,
  rateLimit: { limit: CHAT_RATE_LIMIT, windowMs: CHAT_RATE_WINDOW_MS },
  onError: notifyAiError,
});

/** Ошибки, после которых ИИ-консультант отвечает посетителям офлайн-ботом по ключевым словам. */
const AI_OFFLINE_REASONS = {
  ai_not_configured: () => "не задан ключ ИИ (OPENAI_API_KEY в .env)",
  ai_budget_exceeded: () => "исчерпан суточный лимит токенов (AI_DAILY_TOKENS)",
  ai_unavailable: () => "ИИ временно отключён после серии ошибок провайдера",
  ai_upstream_error: (err) =>
    err.status === 401 || err.status === 403
      ? `провайдер отклонил ключ (HTTP ${err.status}) — проверьте OPENAI_API_KEY`
      : err.status === 402 || err.status === 429
        ? `лимит или баланс у провайдера ИИ (HTTP ${err.status})`
        : `ошибка провайдера ИИ (HTTP ${err.status})`,
};

function notifyAiError(err, req) {
  if (!(err instanceof AiError)) {
    notifier.serverError(req.method, requestPath(req), err);
    return;
  }
  const reason = AI_OFFLINE_REASONS[err.code];
  if (!reason) return;
  const detail = err.detail ? "\nОтвет провайдера: " + scrub(err.detail, sender.hideSecrets).slice(0, 200) : "";
  notifier.alert("ai:" + err.code + ":" + err.status, "ИИ-консультант перешёл в офлайн-режим: " + reason(err) + detail);
}

const handleHealth = createHealthHandler({
  ping: async () => {
    if (!store) throw new Error("база ещё не открыта (сервер запускается)");
    return store.ping();
  },
  version: APP_VERSION,
  sendJson,
  clientIp,
  checkRateLimit,
});

async function handleRequest(req, res) {
  assignRequestId(req, res);
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const headers = securityHeaders({ https: forwardedProto(req, TRUST_PROXY) === "https", admin: isAdminPath(url.pathname) });
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    warnIfUntrustedProxy(req);
    const disabledSite = disabledSiteForHost(req);
    if (disabledSite) {
      sendDisabledSite(req, res, url, disabledSite);
      return;
    }
    if (url.pathname === "/api/health") {
      await handleHealth(req, res);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      if (!store) {
        sendJson(res, 503, { error: "starting", message: "Сервер запускается, повторите через несколько секунд" }, req);
        return;
      }
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url);
  } catch (err) {
    if (res.headersSent || res.destroyed) return;
    if (err && err.message === "body_too_large") {
      sendJson(res, 413, { error: "body_too_large", message: BODY_TOO_LARGE_MESSAGE }, req);
      return;
    }
    if (err instanceof SyntaxError) {
      sendJson(res, 400, { error: "invalid_json" }, req);
      return;
    }
    // PostgreSQL не отвечает (остановлен, перезапускается, оборвалась связь): запрос можно повторить позже.
    if (isConnectionError(err)) {
      console.error(`[${req.id}] ${req.method} ${requestPath(req)}: база ${store ? store.location : ""} недоступна — ${err.message}`);
      notifier.alert(
        "db_unavailable",
        "База данных PostgreSQL не отвечает — сайт не может работать с заказами. Проверьте, что PostgreSQL запущен."
      );
      sendJson(res, 503, { error: "db_unavailable", message: "База данных временно недоступна. Повторите через минуту." }, req);
      return;
    }
    console.error(`[${req.id}] ${req.method} ${requestPath(req)}:`, err);
    notifier.serverError(req.method, requestPath(req), err);
    sendJson(res, 500, { error: "server_error", message: "Внутренняя ошибка сервера" }, req);
  }
}

/** Сбой в самом обработчике ошибок не должен стать необработанным отказом промиса (он завершает процесс). */
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error(`[${req.id}] ${req.method} ${requestPath(req)}: ошибка при обработке ошибки:`, err);
    res.destroy();
  });
});

/** Код выхода «порт занят»: run-server.bat не перезапускает сервер сразу, а ждёт дольше. */
const EXIT_PORT_IN_USE = 3;

server.once("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`Порт ${PORT} уже занят — вероятно, сайт уже запущен в другом окне. Закройте его и запустите снова.`);
    process.exit(EXIT_PORT_IN_USE);
  }
  console.error("Не удалось запустить сервер:", err);
  process.exit(1);
});

/** База открыта, данные перенесены, копии в памяти загружены — только после этого API принимает запросы. */
async function openStore() {
  const opened = await createStore({
    dataDir: DATA_DIR,
    databaseUrl: process.env.DATABASE_URL,
    normalizePhone,
    normalizeProduct: normalizeStoredProduct,
    defaultProducts: DEFAULT_PRODUCTS,
    orderTotalText,
    onBackupError: (err) => notifier.alert("backup", "Не удалось сделать резервную копию базы: " + scrub(err.message, sender.hideSecrets)),
  });
  try {
    await runStartupMigrations(opened);
    await migrateInlineImages(opened);
    await loadAiState(opened);
    documents = createDocuments({ store: opened, rootDir: ROOT, dataDir: DATA_DIR, notifier });
  } catch (err) {
    await opened.close().catch(() => {});
    throw err;
  }
  return opened;
}

server.listen(PORT, HOST, async () => {
  try {
    store = await openStore();
  } catch (err) {
    // Стек обязателен: по одному тексту не найти, в какой миграции или проверке упал запуск.
    console.error("Сервер не запустился:", (err && err.stack) || err);
    notifier.failed("ошибка запуска", err);
    notifier.flush().then(
      () => process.exit(1),
      () => process.exit(1)
    );
    return;
  }
  console.log(`Dinara BILab CRM: http://127.0.0.1:${PORT}`);
  SITES.forEach((site) => {
    const local = `http://${[...site.hosts][0]}:${PORT}`;
    console.log(`Сайт «${site.label}»: ${local}` + (site.url ? `, в интернете — ${site.url}` : ""));
  });
  console.log(MEDIA_STATUS_LINE);
  console.log(`База данных: ${store.location}`);
  console.log(`Резервные копии: ${store.backupDir}`);
  console.log(fileLog && fileLog.file() ? `Журнал: ${path.dirname(fileLog.file())} (по дням, хранится ${Number(process.env.LOG_KEEP_DAYS) || 14} дн.)` : "Журнал: только консоль");
  console.log(
    TRUST_PROXY
      ? "Прокси: адрес посетителя — из X-Forwarded-For от Caddy/nginx на этом компьютере, админка через прокси — только по HTTPS"
      : "Прокси: выключен (TRUST_PROXY=0)"
  );
  const problems = productionProblems();
  if (problems.length) {
    console.warn(
      "⚠ Для работы в интернете не хватает настроек (локально сайт работает):\n" +
        problems.map((p) => "  • " + p).join("\n") +
        "\n  Проверка: npm run check:prod"
    );
  }
  const aiStatus = ai.status();
  console.log(
    aiStatus.configured
      ? `ИИ: включён (${aiStatus.provider}, модель ${aiStatus.model}); фичи: ${aiStatus.features.map((f) => f.name).join(", ")}; ` +
          (ai.config.dailyTokens > 0
            ? `лимит ${ai.config.dailyTokens.toLocaleString("ru-RU")} токенов в сутки (AI_DAILY_TOKENS)`
            : "⚠ суточный лимит токенов выключен (AI_DAILY_TOKENS=0)")
      : `ИИ: выключен — ${ai.provider.notConfiguredMessage || "провайдер не настроен"}`
  );
  const channels = sender.channels();
  console.log(
    "Отправка PDF: e-mail " + (channels.email ? "включён" : "выключен (SMTP_HOST, SMTP_FROM)") +
      ", Telegram " + (channels.telegram ? "включён" : "выключен (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)")
  );
  console.log(
    notifier.enabled
      ? "Оповещения: в Telegram (новые заказы и заявки, сбои сервера)"
      : "Оповещения: выключены — задайте TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID"
  );
  notifier.started(aiStatus.configured ? `ИИ: ${aiStatus.model}` : "ИИ: выключен");
  if (!aiStatus.configured) notifyAiError(new AiError("ai_not_configured", 503), { method: "", url: "" });
  setTimeout(() => {
    localizeExternalImages(store).catch((err) => console.warn("Перенос картинок товаров:", err.message));
  }, 3000).unref();
  // Только после успешного запуска: экземпляр, упавший на занятом порту, не должен удалить чужую просьбу.
  watchStopFile(STOP_FILE, () => shutdown(path.basename(STOP_FILE)));
});

/** Файл-просьба об остановке от службы Windows (scripts/windows-service.ps1): в Windows нет SIGTERM. */
const STOP_FILE = path.join(ROOT, "server.stop");

const shutdown = createShutdown({
  server,
  closeDocuments: () => documents && documents.close(),
  closeStore: async () => {
    if (!store) return;
    await aiState.budgetWrites;
    await store.close();
  },
  closeLog: () => fileLog && fileLog.close(),
});
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

const crash = createCrashHandler({
  notifier,
  closeStore: () => {
    if (store) store.close().catch(() => {});
  },
});
// Отказ промиса без обработчика — такая же ошибка в коде, как исключение: состояние процесса не гарантировано.
process.on("unhandledRejection", (err) => crash("необработанный отказ промиса", err));
process.on("uncaughtException", (err) => crash("сбой процесса", err));
