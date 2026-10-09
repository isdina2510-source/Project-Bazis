/** Удаление загруженных картинок товаров из images/uploads (только своих: путь проверяется). */
const fs = require("fs");
const path = require("path");

function isUploadPath(imagePath) {
  const normalized = String(imagePath || "").replace(/\\/g, "/");
  return normalized.startsWith("images/uploads/");
}

/**
 * @param {{ root: string, uploadsDir: string, log?: Pick<Console, "warn">, fsImpl?: typeof fs }} options
 * @returns {(imagePath: string | null | undefined) => void}
 */
function createUploadRemover({ root, uploadsDir, log = console, fsImpl = fs }) {
  const rootUploads = path.resolve(uploadsDir);
  return function deleteUploadIfOwned(imagePath) {
    if (!isUploadPath(imagePath)) return;
    const rel = String(imagePath).replace(/\\/g, "/");
    const full = path.resolve(root, rel);
    const relative = path.relative(rootUploads, full);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return;
    try {
      if (fsImpl.existsSync(full) && fsImpl.statSync(full).isFile()) fsImpl.unlinkSync(full);
    } catch (err) {
      // Файл занят (антивирус, Windows) — данные целы, но в images/uploads остаётся сирота: путь нужен для ручной чистки.
      log.warn(`Не удалось удалить загруженный файл ${full}: ${(err && (err.code || err.message)) || err}`);
    }
  };
}

module.exports = { createUploadRemover, isUploadPath };
