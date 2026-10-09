const crypto = require("crypto");
const { AiError } = require("./errors");
const { createAttachmentsPool } = require("./lib/attachments-pool");

/** Один файл до 8 МБ в base64 (+33%) и JSON-обёртка — браузер шлёт файлы на разбор по одному. */
const ATTACHMENTS_MAX_BODY_BYTES = 11 * 1024 * 1024;
const ATTACHMENTS_PER_REQUEST = 1;
const MAX_DAILY_KEYS = 200000;

/**
 * Счётчик запросов за сутки (UTC) по ключу; в полночь сбрасывается целиком.
 * При переполнении карты новые ключи не пускаем и ничьи счётчики не обнуляем:
 * иначе всплеск адресов заново открывал бы дневной лимит всем, включая тех, кто его уже выбрал.
 */
function createDailyCounter(limit, maxKeys = MAX_DAILY_KEYS) {
  let day = "";
  /** @type {Map<string, number>} */
  let counts = new Map();
  return function hit(key) {
    if (!(limit > 0)) return true;
    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      counts = new Map();
    }
    const prev = counts.get(key) || 0;
    if (prev >= limit) return false;
    if (!counts.has(key) && counts.size >= maxKeys) return false;
    counts.set(key, prev + 1);
    return true;
  };
}

/** Без application/json браузер шлёт POST с чужого сайта без CORS-проверки (простая форма). */
function isJsonRequest(req) {
  return /^application\/json\b/i.test(String((req.headers && req.headers["content-type"]) || ""));
}

/**
 * HTTP-слой ядра. Транспортные помощники приходят из server.js, чтобы ядро
 * не зависело от конкретного сервера (можно подключить к Express, боту и т.п.).
 */
function createAiHttpHandler(ai, deps) {
  const { sendJson, readBody, clientIp, checkRateLimit, requireAdmin, rateLimit } = deps;
  const config = ai.config || {};
  /** @type {Map<string, number[]>} */
  const rateBuckets = new Map();
  const dailyAi = createDailyCounter(config.dailyRequestsPerIp);
  const dailyAttachments = createDailyCounter(config.attachmentsPerDay);
  const attachmentsPool =
    deps.attachmentsPool ||
    createAttachmentsPool({
      concurrent: config.attachmentsConcurrent,
      queue: config.attachmentsQueue,
      timeoutMs: config.attachmentsTimeoutMs,
    });

  function requireJson(req) {
    if (!isJsonRequest(req)) {
      throw new AiError("unsupported_media_type", 415, "Ожидается JSON (Content-Type: application/json)");
    }
  }

  function sendError(req, res, err) {
    if (res.writableEnded || res.destroyed) return;
    if (err instanceof AiError) {
      const body = { error: err.code };
      if (err.message && err.message !== err.code) body.message = err.message;
      if (["rate_limited", "ai_busy", "ai_unavailable", "attachments_busy"].includes(err.code)) res.setHeader("Retry-After", "30");
      sendJson(res, err.status, body, req);
      return;
    }
    if (err && err.message === "body_too_large") {
      sendJson(res, 413, { error: "body_too_large", message: "Слишком большой запрос: уменьшите или уберите вложения" }, req);
      return;
    }
    if (err instanceof SyntaxError) {
      sendJson(res, 400, { error: "invalid_json" }, req);
      return;
    }
    console.error(`[${req.id || res.getHeader("X-Request-Id") || "-"}] AI:`, err);
    sendJson(res, 500, { error: "server_error", message: "Внутренняя ошибка сервера" }, req);
  }

  /** Сигнал, который срабатывает, если клиент закрыл соединение до ответа. */
  function clientSignal(res) {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort(new AiError("client_closed", 499, "Клиент закрыл соединение"));
    });
    return controller.signal;
  }

  /**
   * GET /api/ai            — статус и список фич
   * GET /api/ai/_health    — состояние ядра и метрики (админ)
   * POST /api/ai/_attachments — разбор файлов в текст (работает и без ключа ИИ)
   * GET /api/ai/:feature   — статус фичи
   * POST /api/ai/:feature  — запуск фичи
   */
  return async function handleAiApi(req, res, featureName) {
    // id выдаёт server.js для всех запросов; свой — если обработчик подключён к другому серверу.
    const requestId = req.id || crypto.randomUUID();
    if (!res.getHeader("X-Request-Id")) res.setHeader("X-Request-Id", requestId);
    try {
      if (!featureName) {
        if (req.method !== "GET") throw new AiError("method_not_allowed", 405);
        sendJson(res, 200, ai.status(), req);
        return;
      }

      if (featureName === "_attachments") {
        if (req.method !== "POST") throw new AiError("method_not_allowed", 405);
        requireJson(req);
        const ip = clientIp(req);
        if (!checkRateLimit(rateBuckets, "_attachments:" + ip, config.attachmentsPerMinute || 10, 60000)) {
          throw new AiError("rate_limited", 429, "Слишком много файлов. Подождите минуту.");
        }
        if (!dailyAttachments("_attachments:" + ip)) {
          throw new AiError("rate_limited", 429, "Лимит разбора файлов на сегодня исчерпан.");
        }
        const body = await readBody(req, ATTACHMENTS_MAX_BODY_BYTES);
        const attachments = await attachmentsPool.parse(body && body.attachments, { limit: ATTACHMENTS_PER_REQUEST });
        sendJson(res, 200, { attachments: attachments.map(({ dataUrl, ...rest }) => rest) }, req);
        return;
      }

      if (featureName === "_health") {
        if (req.method !== "GET") throw new AiError("method_not_allowed", 405);
        if (!requireAdmin(req, res)) return;
        sendJson(res, 200, { ...ai.health(), attachments: attachmentsPool.stats() }, req);
        return;
      }

      const feature = ai.get(featureName);
      if (!feature) throw new AiError("feature_not_found", 404);

      if (req.method === "GET") {
        const { configured, model } = ai.status();
        sendJson(res, 200, { configured, model, feature: feature.name }, req);
        return;
      }
      if (req.method !== "POST") throw new AiError("method_not_allowed", 405);

      requireJson(req);
      if (feature.access === "admin" && !requireAdmin(req, res)) return;
      ai.assertConfigured();

      const ip = clientIp(req);
      const limits = { ...rateLimit, ...feature.rateLimit };
      if (!checkRateLimit(rateBuckets, feature.name + ":" + ip, limits.limit, limits.windowMs)) {
        throw new AiError("rate_limited", 429, "Слишком много запросов. Подождите минуту.");
      }
      if (feature.access !== "admin" && !dailyAi(ip)) {
        throw new AiError("rate_limited", 429, "Лимит вопросов ИИ-консультанту на сегодня исчерпан. Напишите нам в WhatsApp.");
      }

      const body = await readBody(req, feature.maxBodyBytes);
      const result = await ai.run(feature.name, body, { req, ip, requestId, signal: clientSignal(res) });
      sendJson(res, 200, result, req);
    } catch (err) {
      sendError(req, res, err);
    }
  };
}

module.exports = { createAiHttpHandler, createDailyCounter };
