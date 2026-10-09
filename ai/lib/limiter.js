const { AiError } = require("../errors");

/**
 * Ограничитель параллельных запросов к модели с ограниченной очередью.
 * Защищает сервер и квоту провайдера от всплесков: лишние запросы быстро получают 503.
 */
function createLimiter({ maxConcurrent = 8, maxQueue = 50, queueTimeoutMs = 10000 } = {}) {
  let active = 0;
  const queue = [];

  function next() {
    while (active < maxConcurrent && queue.length) {
      const item = queue.shift();
      item.cleanup();
      item.start();
    }
  }

  /** maxWaitMs — сколько этот запрос может простоять в очереди (не больше queueTimeoutMs). */
  function run(fn, signal, maxWaitMs = Infinity) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        return reject(new AiError("client_closed", 499, "Клиент закрыл соединение"));
      }
      const start = () => {
        active++;
        const release = () => {
          active--;
          next();
        };
        Promise.resolve()
          .then(fn)
          .then(
            (value) => {
              release();
              resolve(value);
            },
            (err) => {
              release();
              reject(err);
            }
          );
      };

      if (active < maxConcurrent) return start();
      if (queue.length >= maxQueue) {
        return reject(new AiError("ai_busy", 503, "ИИ сейчас перегружен. Попробуйте через минуту."));
      }

      const item = { start, cleanup };
      const waitMs = Math.max(0, Math.min(queueTimeoutMs, maxWaitMs));
      const timer = setTimeout(() => drop(new AiError("ai_busy", 503, "ИИ сейчас перегружен. Попробуйте через минуту.")), waitMs);
      const onAbort = () => drop(new AiError("client_closed", 499, "Клиент закрыл соединение"));
      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      function cleanup() {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
      function drop(err) {
        const idx = queue.indexOf(item);
        if (idx >= 0) queue.splice(idx, 1);
        cleanup();
        reject(err);
      }
      queue.push(item);
    });
  }

  return {
    run,
    stats: () => ({ active, queued: queue.length, maxConcurrent, maxQueue }),
  };
}

module.exports = { createLimiter };
