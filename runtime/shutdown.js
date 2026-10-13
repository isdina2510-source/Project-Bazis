/**
 * Остановка сервера.
 *
 * createShutdown — штатная остановка: перестаём принимать соединения, ждём текущие запросы (ответ ИИ — до 45 с),
 * закрываем документы, базу и журнал, код 0. Не уложились в timeoutMs — предупреждение и код 1: запрос завис,
 * база закрыта не штатно, и в журнале это не должно выглядеть обычной остановкой.
 *
 * watchStopFile — просьба остановиться через файл. В Windows у процесса нет SIGTERM: служба (scripts/windows-service.ps1)
 * создаёт файл server.stop и ждёт, пока сервер завершится сам, и только потом снимает его принудительно.
 *
 * createCrashHandler — необработанная ошибка (uncaughtException, unhandledRejection): состояние процесса
 * не гарантировано. Журнал со стеком, оповещение, закрыть базу, дождаться отправки и выйти с кодом 1 —
 * run-server.bat, Docker или systemd поднимут сервер заново.
 */
const fs = require("fs");

const SHUTDOWN_TIMEOUT_MS = 50000;
const STOP_FILE_POLL_MS = 1000;
const CRASH_FLUSH_MS = 3000;

/**
 * @param {{ server: { close(cb: () => void): void, closeIdleConnections(): void },
 *   closeDocuments?: () => Promise<unknown> | unknown, closeStore?: () => Promise<unknown> | unknown, closeLog?: () => void,
 *   timeoutMs?: number, log?: Pick<Console, "log" | "warn" | "error">, exit?: (code: number) => void }} options
 * @returns {(reason: string) => void}
 */
function createShutdown(options) {
  const { server } = options;
  const log = options.log || console;
  const exit = options.exit || ((code) => process.exit(code));
  const timeoutMs = options.timeoutMs || SHUTDOWN_TIMEOUT_MS;
  let started = false;

  async function closeAll() {
    if (options.closeDocuments) {
      try {
        await options.closeDocuments();
      } catch (err) {
        log.error("Остановка: не удалось закрыть модуль документов (поток сборки PDF):", err);
      }
    }
    if (options.closeStore) {
      try {
        await options.closeStore();
      } catch (err) {
        log.error("Остановка: не удалось закрыть базу:", err);
      }
    }
  }

  return function shutdown(reason) {
    if (started) return;
    started = true;
    log.log(`${reason}: останавливаю сервер...`);
    const timer = setTimeout(() => {
      log.warn(
        `Сервер не остановился за ${Math.round(timeoutMs / 1000)} с: зависли запросы, база закрыта не штатно. ` +
          "Выход принудительно (код 1)."
      );
      if (options.closeLog) options.closeLog();
      exit(1);
    }, timeoutMs);
    timer.unref();
    server.close(() => {
      closeAll().then(() => {
        clearTimeout(timer);
        if (options.closeLog) options.closeLog();
        exit(0);
      });
    });
    server.closeIdleConnections();
  };
}

/**
 * Следит за файлом-просьбой об остановке. Оставшийся от прошлого запуска файл удаляется сразу,
 * иначе сервер остановился бы, едва запустившись.
 * @returns {() => void} прекратить слежение
 */
function watchStopFile(file, onStop, { intervalMs = STOP_FILE_POLL_MS, log = console } = {}) {
  const remove = () => {
    try {
      fs.rmSync(file, { force: true });
      return true;
    } catch (err) {
      log.warn(`Не удалось удалить ${file}: ${err.message}`);
      return false;
    }
  };
  remove();
  const timer = setInterval(() => {
    if (!fs.existsSync(file)) return;
    clearInterval(timer);
    remove();
    onStop();
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * @param {{ notifier: { failed(kind: string, err: unknown): unknown, flush(ms: number): Promise<unknown> },
 *   closeStore?: () => void, log?: Pick<Console, "error">, exit?: (code: number) => void,
 *   flushMs?: number, now?: () => Date }} options
 * @returns {(kind: string, err: unknown) => void}
 */
function createCrashHandler(options) {
  const { notifier } = options;
  const log = options.log || console;
  const exit = options.exit || ((code) => process.exit(code));
  const flushMs = options.flushMs || CRASH_FLUSH_MS;
  const now = options.now || (() => new Date());
  let crashing = false;

  return function crash(kind, err) {
    log.error(`[${now().toISOString()}] Сервер упал (${kind}):`, err);
    if (options.closeStore) {
      try {
        options.closeStore();
      } catch {
        // повторная ошибка во время аварийного выхода: база уже закрыта
      }
    }
    if (crashing) {
      exit(1);
      return;
    }
    crashing = true;
    let flushed;
    try {
      notifier.failed(kind, err);
      flushed = Promise.resolve(notifier.flush(flushMs));
    } catch (notifyErr) {
      log.error("Оповещение о падении не отправлено:", notifyErr);
      flushed = Promise.resolve();
    }
    flushed.then(
      () => exit(1),
      () => exit(1)
    );
  };
}

module.exports = { createShutdown, watchStopFile, createCrashHandler, SHUTDOWN_TIMEOUT_MS };
