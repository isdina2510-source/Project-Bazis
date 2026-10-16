/**
 * Отдача файла статики потоком. Файла нет (ENOENT) или это папка (EISDIR) — 404. Любая другая ошибка чтения
 * (нет прав, сбой диска) — 500, журнал и оповещение: иначе сломанный сайт выглядел бы как «страница не найдена».
 */
const fs = require("fs");
const path = require("path");

const NOT_FOUND_CODES = new Set(["ENOENT", "EISDIR"]);

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

/**
 * Диапазон из заголовка Range (один, bytes=начало-конец / bytes=-хвост) для файла размером size.
 * null — заголовка нет или он непонятен (отдаём весь файл), false — диапазон за пределами файла (416).
 */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start;
  let end;
  if (!match[1]) {
    const tail = Number(match[2]);
    if (!tail) return false;
    start = Math.max(0, size - tail);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return false;
  return { start, end };
}

/**
 * @param {{ mime: Record<string, string>, log?: Pick<Console, "error">,
 *   onServerError?: (req: import("http").IncomingMessage, err: Error) => void,
 *   createReadStream?: typeof fs.createReadStream }} options
 */
function createFileSender(options) {
  const { mime } = options;
  const log = options.log || console;
  const onServerError = options.onServerError || (() => {});
  const createReadStream = options.createReadStream || fs.createReadStream;
  const statFile = options.stat || fs.statSync;

  return function sendFile(req, res, filePath, cacheControl) {
    const ext = path.extname(filePath).toLowerCase();
    if (!mime[ext]) {
      sendText(res, 403, "Forbidden");
      return;
    }
    const headers = { "Content-Type": mime[ext], "X-Content-Type-Options": "nosniff" };
    if (cacheControl) headers["Cache-Control"] = cacheControl;
    let status = 200;
    let streamOptions;
    // Видео браузер грузит кусками (перемотка); Safari без ответа 206 не воспроизводит его совсем.
    if (mime[ext].startsWith("video/")) {
      let size;
      try {
        size = statFile(filePath).size;
      } catch {
        sendText(res, 404, "Not found");
        return;
      }
      headers["Accept-Ranges"] = "bytes";
      const range = parseRange(req.headers && req.headers.range, size);
      if (range === false) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` });
        res.end();
        return;
      }
      if (range) {
        status = 206;
        streamOptions = range;
        headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
        headers["Content-Length"] = range.end - range.start + 1;
      } else {
        headers["Content-Length"] = size;
      }
      if (req.method === "HEAD" || !size) {
        res.writeHead(status, headers);
        res.end();
        return;
      }
    }
    const stream = streamOptions ? createReadStream(filePath, streamOptions) : createReadStream(filePath);
    stream.on("error", (err) => {
      const code = (err && err.code) || "без кода";
      if (res.headersSent) {
        log.error(`[${req.id}] Чтение ${filePath} оборвалось после начала ответа (${code}): ${err && err.message} — соединение закрыто`);
        res.destroy();
        return;
      }
      if (NOT_FOUND_CODES.has(code)) {
        sendText(res, 404, "Not found");
        return;
      }
      log.error(`[${req.id}] Не удалось прочитать файл ${filePath} (${code}):`, err);
      onServerError(req, err);
      sendText(res, 500, "Внутренняя ошибка сервера");
    });
    // Заголовки — с первыми данными, а не при открытии: в Windows папка открывается, и EISDIR приходит только при чтении.
    stream.once("data", (chunk) => {
      res.writeHead(status, headers);
      res.write(chunk);
      stream.pipe(res);
    });
    stream.once("end", () => {
      if (res.headersSent) return;
      res.writeHead(status, headers);
      res.end();
    });
    // Посетитель перемотал или закрыл видео — недочитанный файл не держим открытым.
    res.once("close", () => stream.destroy());
  };
}

module.exports = { createFileSender, parseRange, NOT_FOUND_CODES };
