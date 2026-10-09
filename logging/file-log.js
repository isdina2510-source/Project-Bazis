/**
 * Журнал сервера в файлах: всё, что пишется через console.log/info/warn/error, дублируется
 * в logs/server-ГГГГ-ММ-ДД.log с временем и уровнем. Новый файл — каждые сутки (по местному времени)
 * и при превышении maxBytes (server-ГГГГ-ММ-ДД.2.log, .3.log…); файлы старше keepDays удаляются.
 * Запись синхронная: строка об ошибке, после которой процесс завершится, не потеряется.
 * Сбой записи (диск полон, нет прав) не роняет сервер — журнал в файл отключается с предупреждением,
 * а файл открывается заново через retryMs (5 минут) или с началом нового дня. Об отключении и восстановлении —
 * по одной строке в консоль и вызов onStatus("disabled" | "restored", текст): так сервер оповещает владельца,
 * а этот модуль не зависит от notify.
 */
const fs = require("fs");
const path = require("path");
const util = require("util");

const LEVELS = { log: "INFO", info: "INFO", warn: "WARN", error: "ERROR" };
const FILE_RE = /^server-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;

const pad = (n, size = 2) => String(n).padStart(size, "0");

function localDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localTimestamp(date) {
  return (
    `${localDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}`
  );
}

/**
 * @param {{ dir: string, keepDays?: number, maxBytes?: number, retryMs?: number, console?: Pick<Console, "error">,
 *   now?: () => Date, onStatus?: (status: "disabled" | "restored", text: string) => void }} options
 * @returns {{ write(level: string, args: any[]): void, close(): void, file(): string | null }}
 */
function createFileLog(options) {
  const dir = options.dir;
  const keepDays = Math.max(1, Math.floor(Number(options.keepDays) || 14));
  const maxBytes = Math.max(64 * 1024, Math.floor(Number(options.maxBytes) || 20 * 1024 * 1024));
  const retryMs = Number(options.retryMs) > 0 ? Number(options.retryMs) : RETRY_MS;
  const now = options.now || (() => new Date());
  const fallback = options.console || console;
  const onStatus = options.onStatus || (() => {});

  let fd = null;
  let day = "";
  let part = 1;
  let size = 0;
  let currentFile = null;
  /** null — журнал работает; иначе когда и в какой день отключился и сколько строк не записано. */
  let outage = null;

  function report(status, text) {
    try {
      fallback.error(text);
    } catch {
      // консоль недоступна — сообщить больше некуда
    }
    try {
      onStatus(status, text);
    } catch (err) {
      try {
        fallback.error("Журнал в файл: ошибка в обработчике onStatus: " + (err && err.message));
      } catch {
        // ignore
      }
    }
  }

  function disable(err, current) {
    closeFd();
    if (outage) {
      outage.at = current.getTime();
      outage.day = localDate(current);
      return;
    }
    outage = { at: current.getTime(), day: localDate(current), lost: 1 };
    report(
      "disabled",
      `Журнал в файл отключён: ${err && err.message}. Сообщения выводятся только в консоль; ` +
        `повторная попытка через ${Math.round(retryMs / 60000)} мин или с началом нового дня.`
    );
  }

  /** Пора ли снова пробовать открыть файл: прошло retryMs или наступил новый день. */
  function shouldRetry(current) {
    return current.getTime() - outage.at >= retryMs || localDate(current) !== outage.day;
  }

  function closeFd() {
    if (fd == null) return;
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
    fd = null;
  }

  function fileName(forDay, forPart) {
    return path.join(dir, `server-${forDay}${forPart > 1 ? "." + forPart : ""}.log`);
  }

  /** Последняя часть за этот день — продолжаем её после перезапуска, а не начинаем новый файл. */
  function lastPart(forDay) {
    let last = 1;
    for (const name of fs.readdirSync(dir)) {
      const match = name.match(FILE_RE);
      if (match && match[1] === forDay) last = Math.max(last, Number(match[2] || 1));
    }
    return last;
  }

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
    }
  }

  function open(forDay, forPart) {
    closeFd();
    day = forDay;
    part = forPart;
    currentFile = fileName(day, part);
    fd = fs.openSync(currentFile, "a");
    size = fs.fstatSync(fd).size;
  }

  function ensureFile(current) {
    const today = localDate(current);
    if (fd == null || today !== day) {
      fs.mkdirSync(dir, { recursive: true });
      open(today, lastPart(today));
      cleanup(current);
    }
    while (size >= maxBytes) open(day, part + 1);
  }

  function append(current, level, text) {
    ensureFile(current);
    const line = Buffer.from(`${localTimestamp(current)} ${level.padEnd(5)} ${text.replace(/\r?\n/g, "\n  ")}\n`, "utf8");
    fs.writeSync(fd, line);
    size += line.length;
  }

  function write(level, args) {
    const current = now();
    if (outage && !shouldRetry(current)) {
      outage.lost += 1;
      return;
    }
    try {
      if (outage) {
        const { lost } = outage;
        append(current, "WARN", `Журнал в файл снова работает; пока он был отключён, не записано строк: ${lost}`);
        outage = null;
        report("restored", `Журнал в файл снова работает: ${currentFile} (не записано строк: ${lost}).`);
      }
      append(current, level, util.format(...args));
    } catch (err) {
      if (outage) outage.lost += 1;
      disable(err, current);
    }
  }

  return {
    write,
    close: closeFd,
    file: () => currentFile,
  };
}

/**
 * Подключить журнал к console: вывод на экран остаётся, плюс запись в файл.
 * @returns {{ close(): void, file(): string | null }}
 */
function installFileLog(options) {
  const original = {};
  for (const method of Object.keys(LEVELS)) original[method] = console[method].bind(console);
  const log = createFileLog({ ...options, console: { error: original.error } });
  for (const method of Object.keys(LEVELS)) {
    console[method] = (...args) => {
      original[method](...args);
      log.write(LEVELS[method], args);
    };
  }
  return log;
}

module.exports = { createFileLog, installFileLog };
