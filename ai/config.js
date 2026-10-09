/** Все настройки ядра в одном месте; значения по умолчанию рассчитаны на один сервер. */

function num(value, fallback, min = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function list(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadAiConfig(env = process.env) {
  return {
    /** Общий бюджет времени на запрос, включая повторы. Фронтенд ждёт 50 c. */
    deadlineMs: num(env.AI_TIMEOUT_MS, 45000, 1000),
    retries: num(env.AI_RETRIES, 2),
    retryBaseMs: num(env.AI_RETRY_BASE_MS, 500),
    retryMaxMs: num(env.AI_RETRY_MAX_MS, 4000),
    /** Модели, на которые переключаемся, если основная недоступна. */
    fallbackModels: list(env.AI_FALLBACK_MODELS),
    maxConcurrent: num(env.AI_MAX_CONCURRENT, 8, 1),
    maxQueue: num(env.AI_MAX_QUEUE, 50),
    queueTimeoutMs: num(env.AI_QUEUE_TIMEOUT_MS, 10000, 100),
    breakerThreshold: num(env.AI_BREAKER_THRESHOLD, 5, 1),
    breakerCooldownMs: num(env.AI_BREAKER_COOLDOWN_MS, 30000, 1000),
    log: env.AI_LOG !== "0",
    /** Зрение: 0 — модель не умеет картинки, они заменяются пометкой. */
    vision: env.AI_VISION !== "0",
    /** Отдельная модель для запросов с картинками (если основная без зрения или дешевле). */
    visionModel: String(env.AI_VISION_MODEL || "").trim(),
    imageDetail: ["low", "high", "auto"].includes(env.AI_IMAGE_DETAIL) ? env.AI_IMAGE_DETAIL : "auto",

    /**
     * Суточный (UTC) лимит токенов на все вызовы модели с сайта; 0 — без лимита.
     * 3 млн токенов gpt-4o-mini — порядка 1–2 $ в сутки в худшем случае.
     */
    dailyTokens: num(env.AI_DAILY_TOKENS, 3000000),
    /** Оценка картинки для резерва бюджета; фактический расход потом берётся из ответа API. */
    imageTokensLow: num(env.AI_IMAGE_TOKENS_LOW, 3000),
    imageTokensHigh: num(env.AI_IMAGE_TOKENS_HIGH, 26000),
    /** Потолок длины ответа, если фича не задала свой. */
    maxOutputTokens: num(env.AI_MAX_OUTPUT_TOKENS, 1200, 16),
    /** Запросов к ИИ с одного адреса за сутки (0 — без лимита): один посетитель не выберет общий бюджет. */
    dailyRequestsPerIp: num(env.AI_DAILY_REQUESTS_PER_IP, 150),

    /** Разбор файлов (POST /api/ai/_attachments): лимиты на адрес и на сервер целиком. */
    attachmentsPerMinute: num(env.AI_ATTACHMENTS_PER_MINUTE, 10, 1),
    attachmentsPerDay: num(env.AI_ATTACHMENTS_PER_DAY, 100),
    attachmentsConcurrent: num(env.AI_ATTACHMENTS_CONCURRENT, 2, 1),
    attachmentsQueue: num(env.AI_ATTACHMENTS_QUEUE, 6),
    attachmentsTimeoutMs: num(env.AI_ATTACHMENTS_TIMEOUT_MS, 30000, 1000),
  };
}

module.exports = { loadAiConfig };
