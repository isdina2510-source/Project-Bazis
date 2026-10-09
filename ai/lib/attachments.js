/**
 * Разбор вложений чата на сервере — единый источник правды для всех фич ядра.
 *
 * На вход — элемент из body.attachments в одном из видов:
 *   { name, type, size, data: "data:<mime>;base64,..." }  исходный файл (разбирается здесь)
 *   { kind: "image", name, dataUrl }                       уже ужатое браузером фото
 *   { kind: "text", name, text }                           текст, извлечённый браузером (запасной путь)
 * На выходе — нормализованное вложение:
 *   { kind: "text" | "image" | "binary" | "error", name, type, size, text?, truncated?, dataUrl?, summary, error? }
 */
const zlib = require("zlib");
const { sniffImageMime, pixelsToPngDataUrl } = require("./image");

const MAX_ATTACHMENTS = 4;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 12000;
const MAX_IMAGE_DATAURL = 7 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 32 * 1024 * 1024;
/** Картинки внутри документов: сколько и какого размера передавать модели. */
const MAX_DOC_IMAGES = 3;
const MIN_DOC_IMAGE_BYTES = 3 * 1024;
const MAX_DOC_IMAGE_BYTES = 1.5 * 1024 * 1024;
/** PDF считается сканом, если в нём меньше стольких букв/цифр — тогда страницы уходят модели картинками. */
const PDF_SCAN_MAX_LETTERS = 100;
const PDF_SCAN_PAGES = 3;
const PDF_MIN_IMAGE_SIDE = 200;

const lower = (value) => String(value || "").toLowerCase();

function formatBytes(n) {
  const size = Number(n) || 0;
  if (size < 1024) return size + " Б";
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " КБ";
  return (size / (1024 * 1024)).toFixed(1) + " МБ";
}

function decodeDataUrl(dataUrl) {
  const match = /^data:([^;,]*)(;[^,]*)?,/.exec(String(dataUrl || ""));
  if (!match) return null;
  const payload = String(dataUrl).slice(match[0].length);
  const isBase64 = /;base64/i.test(match[2] || "");
  try {
    const buffer = isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
    return { mime: lower(match[1]), buffer };
  } catch {
    return null;
  }
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tidyText(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ---------------- ZIP (docx, xlsx, pptx, odt, ods) ---------------- */

function readZipEntries(buffer) {
  let eocd = -1;
  const start = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= start; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("файл повреждён или это не ZIP-документ");

  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  let budget = MAX_UNZIPPED_BYTES;
  const entries = new Map();

  for (let e = 0; e < count && p + 46 <= buffer.length; e++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    entries.set(name, () => {
      const lhNameLen = buffer.readUInt16LE(localOffset + 26);
      const lhExtraLen = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
      const data = buffer.subarray(dataStart, dataStart + compSize);
      let out;
      if (method === 0) out = data;
      else if (method === 8) out = zlib.inflateRawSync(data, { maxOutputLength: budget });
      else throw new Error("неподдерживаемое сжатие ZIP");
      budget -= out.length;
      if (budget <= 0) throw new Error("документ слишком большой после распаковки");
      return out;
    });
  }
  return {
    has: (name) => entries.has(name),
    read: (name) => (entries.has(name) ? entries.get(name)().toString("utf8") : null),
    readBuffer: (name) => (entries.has(name) ? entries.get(name)() : null),
    names: () => [...entries.keys()],
  };
}

/** Картинки, вложенные в офисный документ (word/media, ppt/media, Pictures/). */
function extractZipImages(zip) {
  const images = [];
  let skipped = 0;
  const candidates = zip
    .names()
    .filter((n) => /^(word\/media|ppt\/media|xl\/media|Pictures)\//.test(n))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  for (const name of candidates) {
    let buffer;
    try {
      buffer = zip.readBuffer(name);
    } catch {
      continue;
    }
    const mime = sniffImageMime(buffer);
    if (!mime || buffer.length < MIN_DOC_IMAGE_BYTES) continue;
    if (images.length >= MAX_DOC_IMAGES || buffer.length > MAX_DOC_IMAGE_BYTES) {
      skipped++;
      continue;
    }
    images.push({ name: name.split("/").pop(), dataUrl: "data:" + mime + ";base64," + buffer.toString("base64") });
  }
  return { images, skipped };
}

const byNumberInName = (a, b) => Number((a.match(/(\d+)\.xml$/) || [])[1] || 0) - Number((b.match(/(\d+)\.xml$/) || [])[1] || 0);

function stripXml(xml) {
  return decodeXmlEntities(String(xml || "").replace(/<[^>]+>/g, ""));
}

function docxXmlToText(xml) {
  return stripXml(
    String(xml || "")
      .replace(/<w:tab[^>]*\/>/g, "\t")
      .replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/w:tc>/g, "\t")
      .replace(/<\/w:tr>/g, "\n")
  );
}

function extractDocx(zip) {
  const body = zip.read("word/document.xml");
  if (body == null) throw new Error("в DOCX нет основного текста");
  const extras = zip
    .names()
    .filter((n) => /^word\/(footnotes|endnotes)\.xml$/.test(n))
    .map((n) => docxXmlToText(zip.read(n)));
  return [docxXmlToText(body), ...extras].join("\n\n");
}

function columnIndex(ref) {
  const letters = String(ref || "").replace(/[^A-Z]/gi, "").toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(0, n - 1);
}

function extractXlsx(zip) {
  const shared = [];
  const sst = zip.read("xl/sharedStrings.xml");
  if (sst) {
    for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXmlEntities(t[1])).join(""));
    }
  }
  const workbook = zip.read("xl/workbook.xml") || "";
  const sheetNames = [...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => decodeXmlEntities(m[1]));
  const sheets = zip.names().filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(byNumberInName);
  if (!sheets.length) throw new Error("в XLSX нет листов");

  const blocks = sheets.map((sheetPath, idx) => {
    const xml = zip.read(sheetPath) || "";
    const lines = [];
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1] || "";
        const inner = c[2] || "";
        const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || "";
        const col = columnIndex((attrs.match(/\br="([^"]+)"/) || [])[1]);
        const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let value = "";
        if (type === "s") value = shared[Number(v)] || "";
        else if (type === "inlineStr") value = stripXml((inner.match(/<is>([\s\S]*?)<\/is>/) || [])[1]);
        else if (v != null) value = decodeXmlEntities(v);
        cells[col] = value;
      }
      const line = Array.from(cells, (x) => x || "").join("\t").replace(/\t+$/, "");
      if (line.trim()) lines.push(line);
    }
    const title = sheetNames.length === sheets.length ? sheetNames[idx] : "Лист " + (idx + 1);
    return lines.length ? "Лист «" + title + "»:\n" + lines.join("\n") : "";
  });
  return blocks.filter(Boolean).join("\n\n");
}

function extractPptx(zip) {
  const slides = zip.names().filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byNumberInName);
  if (!slides.length) throw new Error("в PPTX нет слайдов");
  return slides
    .map((slidePath, idx) => {
      const text = stripXml((zip.read(slidePath) || "").replace(/<\/a:p>/g, "\n").replace(/<a:br\/>/g, "\n"));
      return text.trim() ? "Слайд " + (idx + 1) + ":\n" + text.trim() : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function extractOpenDocument(zip) {
  const xml = zip.read("content.xml");
  if (xml == null) throw new Error("в документе нет content.xml");
  return stripXml(
    xml
      .replace(/<text:tab\/>/g, "\t")
      .replace(/<text:line-break\/>/g, "\n")
      .replace(/<text:s\/>/g, " ")
      .replace(/<\/text:(p|h)>/g, "\n")
      .replace(/<\/table:table-cell>/g, "\t")
      .replace(/<\/table:table-row>/g, "\n")
  );
}

/* ---------------- PDF ---------------- */

let unpdfModule;
async function loadUnpdf() {
  if (unpdfModule === undefined) {
    try {
      unpdfModule = await import("unpdf");
    } catch {
      unpdfModule = null;
    }
  }
  return unpdfModule;
}

/** Запасной разбор без зависимостей: строки Tj/TJ из (в т.ч. сжатых) content streams. Без ToUnicode-карт. */
function extractPdfBuiltin(buffer) {
  const raw = buffer.toString("latin1");
  const chunks = [];
  const re = /<<([\s\S]*?)>>\s*stream\r?\n/g;
  let match;
  while ((match = re.exec(raw))) {
    const start = match.index + match[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    let data = buffer.subarray(start, end);
    if (/\/FlateDecode/.test(match[1])) {
      try {
        data = zlib.inflateSync(data, { maxOutputLength: MAX_UNZIPPED_BYTES });
      } catch {
        continue;
      }
    } else if (/\/Filter/.test(match[1])) {
      continue;
    }
    const content = data.toString("latin1");
    if (!/\b(Tj|TJ)\b/.test(content)) continue;
    for (const s of content.matchAll(/\((?:\\.|[^\\)])*\)/g)) {
      const str = s[0]
        .slice(1, -1)
        .replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, esc) => {
          const map = { n: "\n", r: "", t: "\t", b: "", f: "", "(": "(", ")": ")", "\\": "\\" };
          return esc in map ? map[esc] : String.fromCharCode(parseInt(esc, 8));
        });
      chunks.push(str);
    }
    if (chunks.join("").length > MAX_TEXT_CHARS * 2) break;
  }
  return chunks.join(" ");
}

/** Запасной путь для сканов без unpdf: JPEG-потоки (DCTDecode) — это готовые JPEG-файлы. */
function extractPdfJpegsBuiltin(buffer) {
  const raw = buffer.toString("latin1");
  const images = [];
  const re = /<<([\s\S]*?)>>\s*stream\r?\n/g;
  let match;
  while ((match = re.exec(raw)) && images.length < PDF_SCAN_PAGES) {
    if (!/\/Subtype\s*\/Image/.test(match[1]) || !/\/DCTDecode/.test(match[1]) || /\/FlateDecode/.test(match[1])) continue;
    const start = match.index + match[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    const jpeg = buffer.subarray(start, end);
    if (sniffImageMime(jpeg) !== "image/jpeg" || jpeg.length > MAX_DOC_IMAGE_BYTES) continue;
    images.push({ name: "страница " + (images.length + 1), dataUrl: "data:image/jpeg;base64," + jpeg.toString("base64") });
  }
  return images;
}

function countLetters(text) {
  return (String(text || "").match(/[A-Za-zА-Яа-яЁё0-9]/g) || []).length;
}

/** Самая крупная картинка на каждой из первых страниц — так выглядит скан. */
async function extractPdfScanPages(lib, pdf) {
  const images = [];
  const pages = Math.min(pdf.numPages || 0, PDF_SCAN_PAGES);
  for (let page = 1; page <= pages; page++) {
    let found = [];
    try {
      found = await lib.extractImages(pdf, page);
    } catch {
      continue;
    }
    const biggest = found
      .filter((img) => img && img.width >= PDF_MIN_IMAGE_SIDE && img.height >= PDF_MIN_IMAGE_SIDE)
      .sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!biggest) continue;
    const png = pixelsToPngDataUrl(biggest, { maxBytes: MAX_DOC_IMAGE_BYTES });
    if (png) images.push({ name: "страница " + page, dataUrl: png.dataUrl });
  }
  return images;
}

async function extractPdf(buffer) {
  const lib = await loadUnpdf();
  if (lib) {
    let pdf;
    try {
      pdf = await lib.getDocumentProxy(new Uint8Array(buffer));
      const { text } = await lib.extractText(pdf, { mergePages: false });
      const pages = Array.isArray(text) ? text : [String(text || "")];
      const joined = pages
        .map((page, i) => (String(page).trim() ? (pages.length > 1 ? "Стр. " + (i + 1) + ":\n" : "") + String(page).trim() : ""))
        .filter(Boolean)
        .join("\n\n");
      if (countLetters(joined) >= PDF_SCAN_MAX_LETTERS) return { text: joined };
      const images = await extractPdfScanPages(lib, pdf);
      return { text: joined, images, scanned: countLetters(joined) < 3 };
    } catch (err) {
      if (/password/i.test(String(err && err.message))) throw new Error("PDF защищён паролем");
    } finally {
      if (pdf && typeof pdf.cleanup === "function") pdf.cleanup().catch(() => {});
    }
  }
  const text = extractPdfBuiltin(buffer);
  if (countLetters(text) >= PDF_SCAN_MAX_LETTERS) return { text };
  return { text, images: extractPdfJpegsBuiltin(buffer), scanned: countLetters(text) < 3 };
}

/* ---------------- RTF, DOC, обычный текст ---------------- */

function decodeText(buffer) {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.toString("utf8", 3);
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder("utf-16le").decode(buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder("utf-16be").decode(buffer.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("windows-1251").decode(buffer);
  }
}

const RTF_SKIP_DESTINATIONS = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "pict", "header", "footer", "headerl", "headerr",
  "footerl", "footerr", "listtable", "listoverridetable", "rsidtbl", "generator", "xmlnstbl", "themedata",
  "colorschememapping", "latentstyles", "datastore", "object", "fldinst",
]);

function extractRtf(buffer) {
  const src = buffer.toString("latin1");
  const cpMatch = src.match(/\\ansicpg(\d+)/);
  let decoder;
  try {
    decoder = new TextDecoder(cpMatch ? "windows-" + cpMatch[1] : "windows-1251");
  } catch {
    decoder = new TextDecoder("windows-1251");
  }
  const out = [];
  let bytes = [];
  const flushBytes = () => {
    if (bytes.length) out.push(decoder.decode(Uint8Array.from(bytes)));
    bytes = [];
  };
  const stack = [];
  let skip = false;
  let ucSkip = 1;
  let pendingSkip = 0;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      stack.push({ skip, ucSkip });
      continue;
    }
    if (ch === "}") {
      const prev = stack.pop();
      if (prev) ({ skip, ucSkip } = prev);
      continue;
    }
    if (ch === "\\") {
      const next = src[i + 1];
      if (next === "'") {
        const code = parseInt(src.substr(i + 2, 2), 16);
        i += 3;
        if (pendingSkip > 0) pendingSkip--;
        else if (!skip && !Number.isNaN(code)) bytes.push(code);
        continue;
      }
      if (next === "*") {
        skip = true;
        i += 1;
        continue;
      }
      if (next === "\\" || next === "{" || next === "}") {
        if (!skip) {
          flushBytes();
          out.push(next);
        }
        i += 1;
        continue;
      }
      const word = /^([a-z]+)(-?\d+)? ?/i.exec(src.slice(i + 1, i + 40));
      if (!word) {
        i += 1;
        continue;
      }
      i += word[0].length;
      const name = word[1];
      const arg = word[2] == null ? null : Number(word[2]);
      if (RTF_SKIP_DESTINATIONS.has(name)) skip = true;
      if (skip) continue;
      if (name === "uc" && arg != null) ucSkip = arg;
      else if (name === "u" && arg != null) {
        flushBytes();
        out.push(String.fromCharCode(arg < 0 ? arg + 65536 : arg));
        pendingSkip = ucSkip;
      } else if (name === "par" || name === "line" || name === "row") {
        flushBytes();
        out.push("\n");
      } else if (name === "tab" || name === "cell") {
        flushBytes();
        out.push("\t");
      }
      continue;
    }
    if (ch === "\r" || ch === "\n") continue;
    if (skip) continue;
    if (pendingSkip > 0) {
      pendingSkip--;
      continue;
    }
    flushBytes();
    out.push(ch);
  }
  flushBytes();
  return out.join("");
}

/** Word 97–2003 (.doc): приблизительно — текстовые UTF-16 фрагменты из бинарника. */
function extractLegacyDoc(buffer) {
  if (buffer.readUInt32LE(0) !== 0xe011cfd0) throw new Error("это не документ Word");
  const runs = [];
  let current = "";
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    const code = buffer.readUInt16LE(i);
    const ok =
      (code >= 0x20 && code < 0x7f) || (code >= 0x400 && code <= 0x4ff) || code === 0x0d || code === 0x09 ||
      code === 0xab || code === 0xbb || code === 0x2013 || code === 0x2014 || code === 0x2116 || code === 0xa0;
    if (ok) {
      current += code === 0x0d ? "\n" : String.fromCharCode(code);
    } else {
      if (current.replace(/\s/g, "").length >= 6 && /[A-Za-zА-Яа-яЁё]{3}/.test(current)) runs.push(current);
      current = "";
    }
  }
  if (current.replace(/\s/g, "").length >= 6) runs.push(current);
  return runs.join("\n");
}

/* ---------------- Определение формата ---------------- */

const FORMATS = [
  { id: "docx", label: "Документ Word", ext: /\.docx$/, mime: /wordprocessingml/, zip: extractDocx },
  { id: "xlsx", label: "Таблица Excel", ext: /\.xlsx$/, mime: /spreadsheetml/, zip: extractXlsx },
  { id: "pptx", label: "Презентация", ext: /\.pptx$/, mime: /presentationml/, zip: extractPptx },
  { id: "odt", label: "Документ OpenDocument", ext: /\.(odt|ods|odp)$/, mime: /opendocument/, zip: extractOpenDocument },
  { id: "pdf", label: "PDF-документ", ext: /\.pdf$/, mime: /^application\/pdf$/, parse: extractPdf },
  { id: "rtf", label: "Документ RTF", ext: /\.rtf$/, mime: /rtf/, parse: extractRtf },
  { id: "doc", label: "Документ Word 97–2003", ext: /\.doc$/, mime: /^application\/msword$/, parse: extractLegacyDoc },
  {
    id: "text",
    label: "Текстовый файл",
    ext: /\.(txt|md|csv|tsv|json|xml|html?|js|ts|css|log|ini|yml|yaml)$/,
    mime: /^text\/|json|xml|javascript|csv|markdown/,
    parse: decodeText,
  },
];

function detectFormat(name, mime, buffer) {
  const n = lower(name);
  const byExt = FORMATS.find((f) => f.ext.test(n));
  if (byExt) return byExt;
  if (buffer && buffer.subarray(0, 5).toString("latin1") === "%PDF-") return FORMATS.find((f) => f.id === "pdf");
  if (buffer && buffer.subarray(0, 5).toString("latin1") === "{\\rtf") return FORMATS.find((f) => f.id === "rtf");
  return FORMATS.find((f) => f.mime.test(lower(mime))) || null;
}

function errorAttachment(base, message) {
  return { ...base, kind: "error", error: message, summary: "Файл «" + base.name + "» не прочитан: " + message };
}

function imagesNote(images, extra = {}) {
  const parts = [];
  if (images.length) parts.push((extra.scanned ? "страниц-сканов передано картинками: " : "изображений внутри: ") + images.length);
  if (extra.skipped) parts.push("ещё " + extra.skipped + " изобр. не передано");
  return parts.length ? ", " + parts.join(", ") : "";
}

function textAttachment(base, label, rawText, images = [], extra = {}) {
  const full = tidyText(rawText);
  const text = full.slice(0, MAX_TEXT_CHARS);
  const truncated = full.length > MAX_TEXT_CHARS;
  const out = {
    ...base,
    kind: "text",
    text,
    truncated,
    summary:
      label + " «" + base.name + "» (" + formatBytes(base.size) + ")" +
      (extra.scanned ? ", текстового слоя нет" : truncated ? ", текст обрезан" : "") +
      imagesNote(images, extra),
  };
  if (images.length) out.images = images;
  return out;
}

/** Проверяет картинку по содержимому, а не по заявленному типу: битые данные роняют весь запрос к модели. */
function checkImageDataUrl(dataUrl) {
  const decoded = decodeDataUrl(dataUrl);
  if (!decoded || !decoded.buffer.length) return { error: "изображение не передано" };
  const mime = sniffImageMime(decoded.buffer);
  if (!mime) return { error: "формат изображения не поддерживается ИИ — пришлите JPG, PNG или WebP" };
  if (String(dataUrl).length > MAX_IMAGE_DATAURL) return { error: "изображение слишком большое" };
  return { mime, size: decoded.buffer.length, dataUrl: "data:" + mime + ";base64," + decoded.buffer.toString("base64") };
}

function imageAttachment(base, dataUrl) {
  const checked = checkImageDataUrl(dataUrl);
  if (checked.error) return errorAttachment(base, checked.error);
  return {
    ...base,
    type: checked.mime,
    size: base.size || checked.size,
    kind: "image",
    dataUrl: checked.dataUrl,
    summary: "Изображение «" + base.name + "» (" + formatBytes(base.size || checked.size) + ")",
  };
}

/** Картинки документа, которые клиент получил из /_attachments и прислал обратно. */
function sanitizeDocImages(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const img of list.slice(0, MAX_DOC_IMAGES)) {
    if (!img || typeof img !== "object") continue;
    const checked = checkImageDataUrl(img.dataUrl);
    if (!checked.error) out.push({ name: String(img.name || "изображение").slice(0, 120), dataUrl: checked.dataUrl });
  }
  return out;
}

async function parseAttachment(raw) {
  if (!raw || typeof raw !== "object") return null;
  const base = {
    name: String(raw.name || "файл").slice(0, 200),
    type: String(raw.type || "").slice(0, 120),
    size: Math.max(0, Number(raw.size) || 0),
  };

  if (raw.kind === "error") return errorAttachment(base, String(raw.error || "ошибка чтения").slice(0, 500));

  if (raw.kind === "image" || (!raw.data && raw.dataUrl)) return imageAttachment(base, raw.dataUrl);

  if (raw.data) {
    const decoded = decodeDataUrl(raw.data);
    if (!decoded || !decoded.buffer.length) return errorAttachment(base, "файл пустой или не передан");
    const buffer = decoded.buffer;
    const file = { ...base, type: base.type || decoded.mime, size: buffer.length };
    if (buffer.length > MAX_FILE_BYTES) return errorAttachment(file, "файл больше 8 МБ");

    if (lower(file.type).startsWith("image/") || sniffImageMime(buffer)) return imageAttachment(file, raw.data);
    if (/\.xls$/.test(lower(file.name))) {
      return errorAttachment(file, "старый формат .xls не поддерживается — сохраните как .xlsx или .csv");
    }

    const format = detectFormat(file.name, file.type, buffer);
    if (!format) {
      return {
        ...file,
        kind: "binary",
        summary:
          "Файл «" + file.name + "» (" + (file.type || "без типа") + ", " + formatBytes(file.size) +
          ") — этот формат не разбирается автоматически.",
      };
    }
    let result;
    try {
      if (format.zip) {
        const zip = readZipEntries(buffer);
        const media = extractZipImages(zip);
        result = { text: format.zip(zip), images: media.images, skipped: media.skipped };
      } else {
        const parsed = await format.parse(buffer);
        result = typeof parsed === "string" ? { text: parsed } : parsed;
      }
    } catch (err) {
      return errorAttachment(file, "не удалось прочитать (" + String((err && err.message) || "ошибка") + ")");
    }
    const images = result.images || [];
    if (countLetters(result.text) < 3 && !images.length) {
      return errorAttachment(
        file,
        format.id === "pdf"
          ? "в PDF нет текстового слоя (похоже на скан), а страницы извлечь не удалось — пришлите их фотографиями"
          : "в документе нет читаемого текста"
      );
    }
    return textAttachment(file, format.label, result.text, images, result);
  }

  if (raw.kind === "text" && (raw.text || raw.images)) {
    const format = detectFormat(base.name, base.type, null);
    return textAttachment(base, format ? format.label : "Документ", String(raw.text || ""), sanitizeDocImages(raw.images));
  }

  return {
    ...base,
    kind: "binary",
    summary: String(raw.summary || "Файл «" + base.name + "» (" + formatBytes(base.size) + ")").slice(0, 1000),
  };
}

async function parseAttachments(list, { limit = MAX_ATTACHMENTS } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list.slice(0, limit)) {
    const item = await parseAttachment(raw);
    if (item) out.push(item);
  }
  return out;
}

/** Все картинки из разобранных вложений по порядку: сами фото и изображения внутри документов. */
function collectImages(attachments) {
  const out = [];
  for (const f of Array.isArray(attachments) ? attachments : []) {
    if (!f) continue;
    if (f.kind === "image" && f.dataUrl) out.push({ name: f.name, dataUrl: f.dataUrl, source: f.name });
    for (const img of f.images || []) out.push({ name: img.name, dataUrl: img.dataUrl, source: f.name });
  }
  return out;
}

module.exports = { parseAttachment, parseAttachments, collectImages, MAX_ATTACHMENTS, MAX_FILE_BYTES, MAX_TEXT_CHARS };
