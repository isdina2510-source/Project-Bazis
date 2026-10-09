const { AiError } = require("../errors");

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(signal.reason);
    const timer = setTimeout(done, ms);
    function done() {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Повторяет fn при ошибках с err.retryable: экспоненциальная задержка с джиттером,
 * учитывает Retry-After (err.retryAfterMs) и не выходит за deadline.
 */
async function withRetry(fn, { retries = 2, baseMs = 500, maxMs = 4000, deadline = Infinity, signal } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (!err || !err.retryable || attempt >= retries) throw err;
      const backoff = Math.min(maxMs, baseMs * 2 ** attempt);
      const delay = Math.max(err.retryAfterMs || 0, backoff / 2 + Math.random() * (backoff / 2));
      if (Date.now() + delay >= deadline) throw err;
      await sleep(delay, signal).catch(() => {
        throw new AiError("client_closed", 499, "Клиент закрыл соединение");
      });
    }
  }
}

module.exports = { withRetry, sleep };
