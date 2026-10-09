const path = require("path");
const { Worker } = require("worker_threads");
const { AiError } = require("../errors");

/**
 * Разбор присланных файлов (PDF, Office, архивы) в отдельных потоках: тяжёлый или зловредный файл
 * не блокирует сервер, ограничен по памяти и времени, а одновременно разбирается не больше `concurrent` файлов.
 * Каждый разбор — свой поток: после таймаута его можно просто убить.
 */
function createAttachmentsPool({ concurrent = 2, queue = 6, timeoutMs = 30000, memoryMb = 384 } = {}) {
  let active = 0;
  /** @type {Array<() => void>} */
  const waiting = [];
  const stats = { parsed: 0, failed: 0, timedOut: 0, rejected: 0 };

  function runWorker(list, limit) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, "attachments-worker.js"), {
        resourceLimits: { maxOldGenerationSizeMb: memoryMb, maxYoungGenerationSizeMb: 64 },
      });
      let done = false;
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        worker.terminate().catch(() => {});
        fn(value);
      };
      const timer = setTimeout(() => {
        stats.timedOut++;
        finish(reject, new AiError("attachments_timeout", 422, "Файл слишком сложный для разбора на сервере"));
      }, timeoutMs);
      worker.once("message", (msg) => {
        if (msg && msg.ok) finish(resolve, msg.attachments);
        else finish(reject, new AiError("attachments_failed", 422, "Не удалось разобрать файл", msg && msg.error));
      });
      worker.once("error", (err) =>
        finish(reject, new AiError("attachments_failed", 422, "Не удалось разобрать файл", err && err.message))
      );
      worker.once("exit", (code) =>
        finish(reject, new AiError("attachments_failed", 422, "Не удалось разобрать файл", "exit " + code))
      );
      worker.postMessage({ list, limit });
    });
  }

  function acquire() {
    if (active < concurrent) {
      active++;
      return Promise.resolve();
    }
    if (waiting.length >= queue) {
      stats.rejected++;
      return Promise.reject(new AiError("attachments_busy", 503, "Сервер занят разбором файлов. Попробуйте через минуту."));
    }
    return new Promise((resolve) => waiting.push(resolve));
  }

  function release() {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }

  /** @returns {Promise<object[]>} то же, что parseAttachments() */
  async function parse(list, { limit } = {}) {
    if (!Array.isArray(list) || !list.length) return [];
    await acquire();
    try {
      const result = await runWorker(list, limit);
      stats.parsed++;
      return result;
    } catch (err) {
      stats.failed++;
      throw err;
    } finally {
      release();
    }
  }

  return { parse, stats: () => ({ active, waiting: waiting.length, concurrent, ...stats }) };
}

module.exports = { createAttachmentsPool };
