/**
 * «Примеры работ» медиасайта: список хранится в настройках базы (ключ portfolio), файлы — в images/uploads (pf_*).
 * GET /api/portfolio — публичный: { items } (null — админ ещё ничего не сохранял, сайт показывает заглушки).
 * PUT /api/portfolio — админ сохраняет весь список; файлы, которые из него ушли, удаляются.
 * POST /api/portfolio/upload — админ загружает фото или видео (тело — сам файл, тип — Content-Type): { path }.
 */
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { Transform } = require("stream");

const SETTINGS_KEY = "portfolio";
const KINDS = ["video", "cartoon", "photo", "invite", "site"];
const MAX_ITEMS = 100;
const MAX_TITLE = 120;
const MAX_TERMS = 2000;
const MAX_REF = 2000;
const MAX_LIST_BODY_BYTES = 512 * 1024;
const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024;
/** Загруженный, но так и не сохранённый в списке файл (админ закрыл окно) удаляется через сутки. */
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FILE_PREFIX = "pf_";
const UPLOAD_PATH_RE = /^images\/uploads\/pf_[a-z0-9_]+\.(jpg|png|webp|gif|mp4|webm|mov)$/;
const VIDEO_PATH_RE = /^images\/uploads\/pf_[a-z0-9_]+\.(mp4|webm|mov)$/;

const UPLOAD_TYPES = {
  "image/jpeg": { ext: ".jpg", video: false },
  "image/png": { ext: ".png", video: false },
  "image/webp": { ext: ".webp", video: false },
  "image/gif": { ext: ".gif", video: false },
  "video/mp4": { ext: ".mp4", video: true },
  "video/webm": { ext: ".webm", video: true },
  "video/quicktime": { ext: ".mov", video: true },
};

const MESSAGES = {
  invalid_items: "Список работ должен быть массивом",
  too_many_items: `Не больше ${MAX_ITEMS} работ`,
  title_required: "Укажите название работы",
  invalid_kind: "Выберите тип работы из списка",
  media_required: "Добавьте фото или видео",
  invalid_image: "Фото — файл JPG, PNG, WebP или GIF, загруженный в админке, или ссылка https://",
  invalid_video: "Видео — файл MP4, WebM или MOV, загруженный в админке",
  unsupported_type: "Можно загрузить фото (JPG, PNG, WebP, GIF) или видео (MP4, WebM, MOV)",
  file_too_large: "Файл слишком большой",
  empty_file: "Файл пустой",
  bad_signature: "Содержимое файла не совпадает с его типом — файл повреждён или переименован",
};

function portfolioError(code, extra = {}) {
  const err = new Error(MESSAGES[code] || code);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

const text = (value, max) => String(value == null ? "" : value).trim().slice(0, max);

/** Фото: файл из images/… (свой) или https-ссылка; пусто — фото нет. */
function cleanImage(value) {
  const image = text(value, MAX_REF);
  if (!image) return "";
  if (/^https:\/\/[^\s]+$/i.test(image)) return image;
  const rel = image.replace(/\\/g, "/").replace(/^\/+/, "");
  if (rel.startsWith("images/") && !rel.includes("..") && /\.(jpe?g|png|webp|gif|avif)$/i.test(rel)) return rel;
  throw portfolioError("invalid_image");
}

function cleanVideo(value) {
  const video = text(value, MAX_REF).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!video) return "";
  if (VIDEO_PATH_RE.test(video)) return video;
  throw portfolioError("invalid_video");
}

function newId() {
  return "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Проверка списка из админки; ошибка указывает номер работы (index), чтобы админ понял, где поправить. */
function normalizeItems(raw) {
  if (!Array.isArray(raw)) throw portfolioError("invalid_items");
  if (raw.length > MAX_ITEMS) throw portfolioError("too_many_items");
  const seen = new Set();
  return raw.map((entry, index) => {
    try {
      const item = entry && typeof entry === "object" ? entry : {};
      const title = text(item.title, MAX_TITLE);
      if (!title) throw portfolioError("title_required");
      const kind = String(item.kind || "");
      if (!KINDS.includes(kind)) throw portfolioError("invalid_kind");
      const image = cleanImage(item.image);
      const video = cleanVideo(item.video);
      if (!image && !video) throw portfolioError("media_required");
      let id = /^[a-z0-9_]{1,40}$/i.test(String(item.id || "")) ? String(item.id) : newId();
      if (seen.has(id)) id = newId();
      seen.add(id);
      const out = { id, kind, title, image, video, terms: text(item.terms, MAX_TERMS) };
      const titleKk = text(item.title_kk, MAX_TITLE);
      const termsKk = text(item.terms_kk, MAX_TERMS);
      if (titleKk) out.title_kk = titleKk;
      if (termsKk) out.terms_kk = termsKk;
      return out;
    } catch (err) {
      err.index = index;
      err.message = `Работа №${index + 1}: ${err.message}`;
      throw err;
    }
  });
}

/** Свои загруженные файлы, на которые ссылается список. */
function ownFiles(items) {
  const files = new Set();
  for (const item of items || []) {
    for (const ref of [item.image, item.video]) if (UPLOAD_PATH_RE.test(String(ref || ""))) files.add(ref);
  }
  return files;
}

/** Сигнатура начала файла: тип из Content-Type должен совпасть с содержимым. */
function signatureMatches(head, mime) {
  if (!head || head.length < 12) return false;
  const ascii = (from, to) => head.slice(from, to).toString("ascii");
  switch (mime) {
    case "image/jpeg":
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case "image/png":
      return head.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/gif":
      return ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a";
    case "image/webp":
      return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    case "video/mp4":
      return ascii(4, 8) === "ftyp";
    case "video/quicktime":
      return ["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot"].includes(ascii(4, 8));
    case "video/webm":
      return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
    default:
      return false;
  }
}

function readHead(file, bytes = 16) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * @param {{ getStore: () => any, uploadsDir: string, sendJson: Function, readJsonObject: Function,
 *   isJsonRequest: Function, requireAdmin: Function, deleteUpload: (rel: string) => void,
 *   log?: Pick<Console, "warn">, maxVideoBytes?: number, maxImageBytes?: number }} deps
 */
function createPortfolioHandler(deps) {
  const { getStore, uploadsDir, sendJson, readJsonObject, isJsonRequest, requireAdmin, deleteUpload } = deps;
  const log = deps.log || console;
  const limits = {
    video: deps.maxVideoBytes || MAX_VIDEO_UPLOAD_BYTES,
    image: deps.maxImageBytes || MAX_IMAGE_UPLOAD_BYTES,
  };

  async function readItems() {
    const saved = await getStore().settings.get(SETTINGS_KEY);
    return Array.isArray(saved) ? saved : null;
  }

  /** Файлы pf_*, которых нет в списке и которые старше суток (недосохранённые загрузки). */
  function removeOrphans(keep) {
    let names;
    try {
      names = fs.readdirSync(uploadsDir);
    } catch {
      return;
    }
    const now = Date.now();
    for (const name of names) {
      if (!name.startsWith(FILE_PREFIX)) continue;
      const rel = "images/uploads/" + name;
      if (keep.has(rel)) continue;
      try {
        if (now - fs.statSync(path.join(uploadsDir, name)).mtimeMs < ORPHAN_MAX_AGE_MS) continue;
      } catch {
        continue;
      }
      if (name.endsWith(".part")) {
        try {
          fs.unlinkSync(path.join(uploadsDir, name));
        } catch (err) {
          log.warn(`Не удалось удалить недогруженный файл ${name}: ${err.code || err.message}`);
        }
      } else {
        deleteUpload(rel);
      }
    }
  }

  async function handleList(req, res) {
    if (req.method === "GET") {
      sendJson(res, 200, { items: await readItems() }, req, { etag: true });
      return;
    }
    if (req.method !== "PUT") {
      sendJson(res, 405, { error: "method_not_allowed" }, req);
      return;
    }
    if (!requireAdmin(req, res)) return;
    if (!isJsonRequest(req)) {
      sendJson(res, 415, { error: "unsupported_media_type", message: "Ожидается JSON (Content-Type: application/json)" }, req);
      return;
    }
    const body = await readJsonObject(req, MAX_LIST_BODY_BYTES);
    let items;
    try {
      items = normalizeItems(body.items);
    } catch (err) {
      if (!Object.hasOwn(MESSAGES, err.code)) throw err;
      sendJson(res, 400, { error: err.code, message: err.message, index: err.index }, req);
      return;
    }
    const previous = (await readItems()) || [];
    await getStore().settings.set(SETTINGS_KEY, items);
    const keep = ownFiles(items);
    for (const rel of ownFiles(previous)) if (!keep.has(rel)) deleteUpload(rel);
    removeOrphans(keep);
    sendJson(res, 200, { items }, req);
  }

  async function handleUpload(req, res) {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed" }, req);
      return;
    }
    if (!requireAdmin(req, res)) return;
    const mime = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    const type = UPLOAD_TYPES[mime];
    if (!type) {
      req.resume();
      sendJson(res, 415, { error: "unsupported_type", message: MESSAGES.unsupported_type }, req);
      return;
    }
    const limit = type.video ? limits.video : limits.image;
    const tooLarge = () =>
      sendJson(res, 413, {
        error: "file_too_large",
        message: `${MESSAGES.file_too_large}: ${type.video ? "видео" : "фото"} — до ${Math.round(limit / 1024 / 1024)} МБ`,
      }, req);
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      tooLarge();
      return;
    }

    fs.mkdirSync(uploadsDir, { recursive: true });
    const base = FILE_PREFIX + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    const partFile = path.join(uploadsDir, base + ".part");
    const finalName = base + type.ext;
    let size = 0;
    const counter = new Transform({
      transform(chunk, _enc, done) {
        size += chunk.length;
        if (size > limit) done(portfolioError("file_too_large"));
        else done(null, chunk);
      },
    });
    const dropPart = () => fs.rmSync(partFile, { force: true });
    try {
      await pipeline(req, counter, fs.createWriteStream(partFile));
    } catch (err) {
      dropPart();
      if (err && err.code === "file_too_large") {
        req.resume();
        tooLarge();
        return;
      }
      // Админ закрыл вкладку или оборвалась связь посреди загрузки — отвечать уже некому.
      if (req.destroyed || (err && (err.code === "ECONNRESET" || err.code === "ERR_STREAM_PREMATURE_CLOSE"))) return;
      throw err;
    }
    if (!size) {
      dropPart();
      sendJson(res, 400, { error: "empty_file", message: MESSAGES.empty_file }, req);
      return;
    }
    if (!signatureMatches(readHead(partFile), mime)) {
      dropPart();
      sendJson(res, 400, { error: "bad_signature", message: MESSAGES.bad_signature }, req);
      return;
    }
    try {
      fs.renameSync(partFile, path.join(uploadsDir, finalName));
    } catch (err) {
      dropPart();
      throw err;
    }
    sendJson(res, 201, { path: "images/uploads/" + finalName, video: type.video, size }, req);
  }

  return {
    /** parts — путь запроса по частям: ["api", "portfolio", …]. */
    matches: (parts) => parts[1] === "portfolio" && parts.length <= 3,
    async handle(req, res, parts) {
      if (parts.length === 2) return handleList(req, res);
      if (parts[2] === "upload") return handleUpload(req, res);
      sendJson(res, 404, { error: "not_found" }, req);
    },
  };
}

module.exports = {
  createPortfolioHandler,
  normalizeItems,
  signatureMatches,
  KINDS,
  MAX_VIDEO_UPLOAD_BYTES,
  MAX_IMAGE_UPLOAD_BYTES,
};
