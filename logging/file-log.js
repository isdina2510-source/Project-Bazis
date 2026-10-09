/**
 * Журнал сервера в файлах: всё, что пишется через console.log/info/warn/error, дублируется
 * в logs/server-ГГГГ-ММ-ДД.log с временем и уровнем. Новый файл — каждые сутки (по местному времени)
 * и при превышении maxBytes (server-ГГГГ-ММ-ДД.2.log, .3.log…); файлы старше keepDays удаляются.
 * Запись синхронная: строка об ошибке, после которой процесс завершится, не потеряется.
 * Сбой записи (диск полон, нет прав) не роняет сервер — журнал в файл отключается с предупреждением.
 */
const fs = require("fs");
const path = require("path");
const util = require("util");

const LEVELS = { log: "INFO", info: "INFO", warn: "WARN", error: "ERROR" };
const FILE_RE = /^server-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/;
const DAY_MS = 24 * 60 * 60 * 1000;

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
 * @param {{ dir: string, keepDays?: number, maxBytes?: number, console?: Console, now?: () => Date }} options
 * @returns {{ write(level: string, args: any[]): void, close(): void, file(): string | null }}
 */
function createFileLog(options) {
  const dir = options.dir;
  const keepDays = Math.max(1, Math.floor(Number(options.keepDays) || 14));
  const maxBytes = Math.max(64 * 1024, Math.floor(Number(options.maxBytes) || 20 * 1024 * 1024));
  const now = options.now || (() => new Date());
  const fallback = options.console || console;

  let fd = null;
  let day = "";
  let part = 1;
  let size = 0;
  let currentFile = null;
  let disabled = false;

  function disable(err) {
    disabled = true;
    closeFd();
    try {
      fallback.error(`Журнал в файл отключён: ${err && err.message}. Сообщения выводятся только в консоль.`);
    } catch {
      // ignore
    }
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

  function write(level, args) {
    if (disabled) return;
    try {
      const current = now();
      ensureFile(current);
      const text = util.format(...args).replace(/\r?\n/g, "\n  ");
      const line = Buffer.from(`${localTimestamp(current)} ${level.padEnd(5)} ${text}\n`, "utf8");
      fs.writeSync(fd, line);
      size += line.length;
    } catch (err) {
      disable(err);
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
