/**
 * GET /api/health — для HEALTHCHECK Docker и внешнего мониторинга: отвечает ли база (SELECT 1).
 * Без пароля, но с лимитом запросов по адресу. В ответе только итог, состояние базы, время работы и версия —
 * причина сбоя пишется в журнал, а не наружу.
 */
const HEALTH_RATE_LIMIT = 60;
const HEALTH_RATE_WINDOW_MS = 60 * 1000;

/** Проверка базы не дольше этого: зависший PostgreSQL — это тоже «не отвечает», а не повисший HEALTHCHECK. */
const PING_TIMEOUT_MS = 3000;

/**
 * @param {{ ping: () => boolean | Promise<boolean>, version: string, uptime?: () => number, pingTimeoutMs?: number,
 *   sendJson: Function, clientIp: (req: object) => string, checkRateLimit: Function,
 *   log?: Pick<Console, "error">, limit?: number, windowMs?: number }} deps
 */
function createHealthHandler(deps) {
  const { ping, version, sendJson, clientIp, checkRateLimit } = deps;
  const uptime = deps.uptime || (() => process.uptime());
  const log = deps.log || console;
  const limit = deps.limit || HEALTH_RATE_LIMIT;
  const windowMs = deps.windowMs || HEALTH_RATE_WINDOW_MS;
  const pingTimeoutMs = deps.pingTimeoutMs || PING_TIMEOUT_MS;
  /** @type {Map<string, number[]>} */
  const buckets = new Map();
  let lastProblem = "";

  function pingWithTimeout() {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`база не ответила за ${pingTimeoutMs} мс`)), pingTimeoutMs);
    });
    return Promise.race([Promise.resolve().then(ping), timeout]).finally(() => clearTimeout(timer));
  }

  return async function handleHealth(req, res) {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" }, req);
      return;
    }
    if (!checkRateLimit(buckets, clientIp(req), limit, windowMs)) {
      sendJson(res, 429, { ok: false, error: "rate_limited" }, req);
      return;
    }
    let problem = "";
    try {
      if ((await pingWithTimeout()) !== true) problem = "база не ответила на SELECT 1";
    } catch (err) {
      problem = (err && err.message) || String(err);
    }
    if (problem) {
      // Docker спрашивает каждые 30 с: одна и та же причина пишется в журнал один раз.
      if (problem !== lastProblem) log.error("Проверка здоровья: база не отвечает — " + problem);
      lastProblem = problem;
      sendJson(res, 503, { ok: false, db: "error" }, req);
      return;
    }
    lastProblem = "";
    sendJson(res, 200, { ok: true, db: "ok", uptime: Math.floor(uptime()), version }, req);
  };
}

module.exports = { createHealthHandler, HEALTH_RATE_LIMIT };
