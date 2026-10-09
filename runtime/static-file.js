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
 * @param {{ mime: Record<string, string>, log?: Pick<Console, "error">,
 *   onServerError?: (req: import("http").IncomingMessage, err: Error) => void,
 *   createReadStream?: typeof fs.createReadStream }} options
 */
function createFileSender(options) {
  const { mime } = options;
  const log = options.log || console;
  const onServerError = options.onServerError || (() => {});
  const createReadStream = options.createReadStream || fs.createReadStream;

  return function sendFile(req, res, filePath, cacheControl) {
    const ext = path.extname(filePath).toLowerCase();
    if (!mime[ext]) {
      sendText(res, 403, "Forbidden");
      return;
    }
    const headers = { "Content-Type": mime[ext], "X-Content-Type-Options": "nosniff" };
    if (cacheControl) headers["Cache-Control"] = cacheControl;
    const stream = createReadStream(filePath);
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
      res.writeHead(200, headers);
      res.write(chunk);
      stream.pipe(res);
    });
    stream.once("end", () => {
      if (res.headersSent) return;
      res.writeHead(200, headers);
      res.end();
    });
  };
}

module.exports = { createFileSender, NOT_FOUND_CODES };
