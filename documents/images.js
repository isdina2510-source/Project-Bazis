/**
 * Картинки для PDF. pdfmake понимает только JPEG и PNG, поэтому всё (WebP, GIF, AVIF, внешние ссылки)
 * переводится в JPEG нужной ширины через sharp и кэшируется в data/cache/images.
 * Картинка, которую не удалось получить, не ломает документ — вместо неё будет пустое место.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const FETCH_TIMEOUT_MS = 10000;
const MAX_REMOTE_BYTES = 10 * 1024 * 1024;

let sharpModule;
function loadSharp() {
  if (sharpModule === undefined) {
    try {
      sharpModule = require("sharp");
    } catch {
      sharpModule = null;
    }
  }
  return sharpModule;
}

function sniffMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return "";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  const head = buffer.slice(0, 6).toString("ascii");
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  return "";
}

/**
 * Картинка из data-URL (печать, подпись). Принимаются PNG и JPEG — форматы, которые pdfmake вставит как есть.
 * @returns {{ buffer: Buffer, ext: string }}
 */
function parseDataUrlImage(dataUrl, maxBytes) {
  const match = String(dataUrl || "").match(/^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i);
  const fail = (code) => Object.assign(new Error(code), { code });
  if (!match) throw fail("invalid_image");
  const buffer = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (!buffer.length || buffer.length > maxBytes) throw fail("image_too_large");
  const mime = sniffMime(buffer);
  if (mime !== "image/png" && mime !== "image/jpeg") throw fail("invalid_image");
  return { buffer, ext: mime === "image/png" ? ".png" : ".jpg" };
}

function toDataUrl(buffer, mime) {
  return "data:" + mime + ";base64," + buffer.toString("base64");
}

/**
 * @param {{ rootDir: string, cacheDir: string, log?: Pick<Console, "warn">, fetchImpl?: typeof fetch }} options
 */
function createImageLoader(options) {
  const { rootDir, cacheDir } = options;
  const log = options.log || console;
  const fetchImpl = options.fetchImpl || fetch;
  const imagesDir = path.join(rootDir, "images");

  /** Локальный путь каталога (images/…) внутри папки images или null. */
  function localPath(src) {
    const rel = String(src).replace(/\\/g, "/").replace(/^\/+/, "");
    if (!rel.startsWith("images/") || rel.includes("..")) return null;
    const full = path.resolve(rootDir, rel);
    const inside = path.relative(imagesDir, full);
    if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) return null;
    return full;
  }

  async function fetchRemote(url) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > MAX_REMOTE_BYTES) throw new Error("слишком большой файл");
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_REMOTE_BYTES) throw new Error("слишком большой файл");
    return buffer;
  }

  /** Исходные байты картинки и ключ кэша (для локальных файлов — с датой изменения). */
  async function readSource(src) {
    const value = String(src || "").trim();
    if (value.startsWith("data:image/")) {
      const match = value.match(/^data:image\/[a-z+.-]+;base64,(.+)$/i);
      if (!match) return null;
      const buffer = Buffer.from(match[1], "base64");
      return { buffer, key: crypto.createHash("sha1").update(buffer).digest("hex") };
    }
    if (/^https?:\/\//i.test(value)) {
      return { lazy: () => fetchRemote(value), key: value };
    }
    const full = localPath(value);
    if (!full || !fs.existsSync(full)) return null;
    const stat = fs.statSync(full);
    if (!stat.isFile()) return null;
    return { lazy: () => fs.promises.readFile(full), key: full + ":" + stat.mtimeMs + ":" + stat.size };
  }

  async function convert(buffer, maxWidth) {
    const sharp = loadSharp();
    if (sharp) {
      return sharp(buffer, { animated: false })
        .rotate()
        .resize({ width: maxWidth, withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer();
    }
    // Без sharp вставляем только то, что pdfmake понимает сам.
    const mime = sniffMime(buffer);
    return mime === "image/jpeg" || mime === "image/png" ? buffer : null;
  }

  /**
   * @param {string} src путь каталога, внешняя ссылка или data-URL
   * @param {number} [maxWidth] ширина в пикселях (для печати достаточно ~2× ширины в документе)
   * @returns {Promise<string | null>} data-URL JPEG/PNG или null
   */
  async function load(src, maxWidth = 600) {
    try {
      const source = await readSource(src);
      if (!source) return null;
      const cacheFile = path.join(
        cacheDir,
        crypto.createHash("sha1").update(source.key + "|" + maxWidth).digest("hex") + ".img"
      );
      if (fs.existsSync(cacheFile)) {
        const cached = await fs.promises.readFile(cacheFile);
        const mime = sniffMime(cached);
        if (mime) return toDataUrl(cached, mime);
      }
      const original = source.buffer || (await source.lazy());
      const ready = await convert(original, maxWidth);
      if (!ready) return null;
      await fs.promises.mkdir(cacheDir, { recursive: true });
      const tmp = cacheFile + "." + process.pid + ".tmp";
      await fs.promises.writeFile(tmp, ready);
      await fs.promises.rename(tmp, cacheFile);
      return toDataUrl(ready, sniffMime(ready));
    } catch (err) {
      log.warn("PDF: картинка не загружена (" + String(src).slice(0, 120) + "): " + (err && err.message));
      return null;
    }
  }

  return { load };
}

module.exports = { createImageLoader, parseDataUrlImage, sniffMime };
