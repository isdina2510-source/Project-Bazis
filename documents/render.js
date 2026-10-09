/**
 * Очередь к потоку сборки PDF. Поток запускается при первом документе и живёт дальше;
 * если он упал или завис дольше RENDER_TIMEOUT_MS, ожидающие получают ошибку, а следующий запрос поднимет новый.
 */
const path = require("path");
const { Worker } = require("worker_threads");

const RENDER_TIMEOUT_MS = 60000;

function createRenderer(options = {}) {
  const timeoutMs = options.timeoutMs || RENDER_TIMEOUT_MS;
  let worker = null;
  let nextId = 1;
  /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
  const pending = new Map();

  function failAll(err) {
    for (const [id, job] of pending) {
      clearTimeout(job.timer);
      job.reject(err);
      pending.delete(id);
    }
  }

  function start() {
    worker = new Worker(path.join(__dirname, "render-worker.js"));
    const current = worker;
    current.on("message", ({ id, ok, pdf, error }) => {
      const job = pending.get(id);
      if (!job) return;
      pending.delete(id);
      clearTimeout(job.timer);
      // Простаивающий поток не должен держать процесс (тесты, остановка сервера).
      if (!pending.size) current.unref();
      if (ok) job.resolve(Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength));
      else job.reject(new Error(error));
    });
    const reset = (err) => {
      if (worker !== current) return;
      worker = null;
      failAll(err);
    };
    current.on("error", reset);
    current.on("exit", (code) => reset(new Error("Поток сборки PDF завершился (код " + code + ")")));
  }

  /**
   * @param {"invoice" | "act" | "catalog" | "product" | "lead"} template
   * @param {object} data
   * @returns {Promise<Buffer>}
   */
  function render(template, data) {
    if (!worker) start();
    const current = worker;
    current.ref();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Сборка PDF заняла больше " + Math.round(timeoutMs / 1000) + " с"));
        if (worker === current) {
          worker = null;
          current.terminate().catch((err) => console.error("PDF: не удалось остановить зависший поток:", err));
          failAll(new Error("Поток сборки PDF перезапущен после зависания"));
        }
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      current.postMessage({ id, template, data });
    });
  }

  function close() {
    failAll(new Error("Сервер останавливается"));
    if (worker) {
      const current = worker;
      worker = null;
      return current.terminate();
    }
    return Promise.resolve();
  }

  return { render, close };
}

module.exports = { createRenderer };
