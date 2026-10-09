/**
 * Подготовка вложений чата. Фото ужимаются в браузере, документы разбирает ИИ-ядро на сервере;
 * локальный разбор (.docx, несжатые PDF, текст) — запасной путь, если сервер недоступен.
 */

import { LOCALES, getLang, t } from "../i18n/index.js";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_CHARS = 12000;
export const MAX_ATTACHMENTS = 4;
const AI_IMAGE_MAX_SIDE = 1600;
const AI_IMAGE_MAX_DATAURL = 1.5 * 1024 * 1024;
const AI_IMAGE_DATAURL = /^data:image\/(png|jpeg|webp|gif)[;,]/i;
const SERVER_PARSE_TIMEOUT_MS = 30000;

export function formatBytes(n) {
  if (n < 1024) return t("file.size_b", { size: String(n) });
  const fmt = new Intl.NumberFormat(LOCALES[getLang()], { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (n < 1024 * 1024) return t("file.size_kb", { size: fmt.format(n / 1024) });
  return t("file.size_mb", { size: fmt.format(n / (1024 * 1024)) });
}

const lower = (value) => String(value || "").toLowerCase();

function isImageFile(file) {
  return lower(file.type).startsWith("image/");
}

function isTextLikeFile(file) {
  const name = lower(file.name);
  const type = lower(file.type);
  return (
    type.startsWith("text/") ||
    /json|xml|javascript|csv|markdown|html/.test(type) ||
    /\.(txt|md|csv|json|xml|html|htm|js|ts|css|log|rtf)$/.test(name)
  );
}

function isDocxFile(file) {
  return (
    /\.docx$/.test(lower(file.name)) ||
    lower(file.type) === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
}

function isPdfFile(file) {
  return /\.pdf$/.test(lower(file.name)) || lower(file.type) === "application/pdf";
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/**
 * Фото для ИИ: до AI_IMAGE_MAX_SIDE по большей стороне и ~AI_IMAGE_MAX_DATAURL в base64.
 * Сервер принимает не больше 8 МБ на запрос чата, а OpenAI всё равно уменьшает большие кадры.
 * Если браузер не умеет декодировать формат (например, HEIC) — возвращает исходник.
 */
async function shrinkImageForAi(dataUrl) {
  const img = await loadImage(dataUrl);
  if (!img) return { dataUrl, width: 0, height: 0 };
  const width = img.naturalWidth || 0;
  const height = img.naturalHeight || 0;
  if (!width || !height || (Math.max(width, height) <= AI_IMAGE_MAX_SIDE && dataUrl.length <= AI_IMAGE_MAX_DATAURL)) {
    return { dataUrl, width, height };
  }
  try {
    const scale = Math.min(1, AI_IMAGE_MAX_SIDE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return { dataUrl, width, height };
    // JPEG без альфа-канала: прозрачные области PNG иначе станут чёрными.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    let quality = 0.85;
    let out = canvas.toDataURL("image/jpeg", quality);
    while (out.length > AI_IMAGE_MAX_DATAURL && quality > 0.5) {
      quality -= 0.1;
      out = canvas.toDataURL("image/jpeg", quality);
    }
    return { dataUrl: out.length < dataUrl.length ? out : dataUrl, width, height };
  } catch {
    return { dataUrl, width, height };
  }
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error(t("file.error.no_decompression"));
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Минимальный ZIP-ридер: достаёт один файл из архива (для .docx). */
async function getZipEntryBytes(arrayBuffer, entryName) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  let eocd = -1;
  const start = Math.max(0, bytes.length - 65536);
  for (let i = bytes.length - 22; i >= start; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const cdOffset = view.getUint32(eocd + 16, true);
  const cdCount = view.getUint16(eocd + 10, true);
  let p = cdOffset;

  for (let e = 0; e < cdCount; e++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder("utf-8").decode(bytes.subarray(p + 46, p + 46 + nameLen));

    if (name === entryName) {
      const lhNameLen = view.getUint16(localOffset + 26, true);
      const lhExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
      const data = bytes.subarray(dataStart, dataStart + compSize);
      if (method === 0) return data;
      if (method === 8) return inflateRaw(data);
      throw new Error(t("file.error.zip_method", { method: String(method) }));
    }

    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function docxXmlToPlainText(xml) {
  return decodeXmlEntities(
    String(xml || "")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<w:tab[^>]*\/>/g, "\t")
      .replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<w:t[^>]*>/g, "")
      .replace(/<\/w:t>/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

async function extractDocxText(file) {
  const entry = await getZipEntryBytes(await file.arrayBuffer(), "word/document.xml");
  if (!entry) throw new Error(t("file.error.docx_no_document"));
  const text = docxXmlToPlainText(new TextDecoder("utf-8").decode(entry));
  if (!text) throw new Error(t("file.error.docx_empty"));
  return text;
}

/** Лёгкий разбор текстовых PDF (не сканов): строки в скобках из content streams. */
async function extractPdfText(file) {
  let raw = "";
  try {
    raw = new TextDecoder("latin1").decode(await file.arrayBuffer());
  } catch {
    raw = "";
  }
  if (!raw) throw new Error("PDF не прочитан"); // i18n-ignore: перехватывается, пользователю показывается file.error.pdf

  const chunks = [];
  const re = /\((?:\\.|[^\\)])*\)/g;
  let match;
  while ((match = re.exec(raw))) {
    const s = match[0]
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "")
      .replace(/\\t/g, "\t")
      .replace(/\\\(/g, "(")
      .replace(/\\\)/g, ")")
      .replace(/\\\\/g, "\\");
    if (/[A-Za-zА-Яа-яЁё0-9]/.test(s)) chunks.push(s); // i18n-ignore: фильтр текста PDF
    if (chunks.join("").length > MAX_TEXT_CHARS) break;
  }
  const text = chunks.join(" ").replace(/\s+/g, " ").trim();
  if (text.length < 40) {
    throw new Error("PDF без извлекаемого текста (возможно скан). Приложите .docx или .txt"); // i18n-ignore: перехватывается, пользователю показывается file.error.pdf
  }
  return text;
}

function makeTextAttachment(base, text, label) {
  const full = String(text || "");
  const clipped = full.slice(0, MAX_TEXT_CHARS);
  const truncated = full.length > MAX_TEXT_CHARS;
  return {
    ...base,
    kind: "text",
    text: clipped,
    truncated,
    summary:
      t("file.summary_text", { label, name: base.name, size: formatBytes(base.size) }) +
      "\n" +
      clipped +
      (truncated ? "\n" + t("file.truncated") : ""),
  };
}

/**
 * Документы разбирает ИИ-ядро на сервере (POST /api/ai/_attachments) — там полноценные PDF, Excel, RTF и т.д.
 * null — сервер недоступен, тогда работает локальный разбор ниже.
 */
async function parseOnServer(file, base) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVER_PARSE_TIMEOUT_MS);
  try {
    const res = await fetch("/api/ai/_attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attachments: [{ ...base, data: await readAsDataUrl(file) }] }),
      signal: controller.signal,
    });
    if (res.status === 413) {
      return { ...base, kind: "error", error: t("file.error.too_big_parse") };
    }
    if (!res.ok) return null;
    const data = await res.json();
    const item = data && Array.isArray(data.attachments) ? data.attachments[0] : null;
    if (!item) return null;
    if (item.kind === "error") return { ...item, error: item.error.charAt(0).toUpperCase() + item.error.slice(1) + "." };
    return item;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function prepareAttachment(file) {
  if (!file) return null;
  const base = {
    name: file.name || t("file.default_name"),
    type: file.type || "application/octet-stream",
    size: file.size,
  };

  if (file.size > MAX_FILE_BYTES) {
    return { ...base, kind: "error", error: t("file.error.too_big") };
  }

  if (isImageFile(file)) {
    const meta = await shrinkImageForAi(await readAsDataUrl(file));
    if (!AI_IMAGE_DATAURL.test(meta.dataUrl)) {
      return { ...base, kind: "error", error: t("file.error.image_format", { name: base.name }) };
    }
    return {
      ...base,
      kind: "image",
      previewUrl: meta.dataUrl,
      dataUrl: meta.dataUrl,
      width: meta.width,
      height: meta.height,
      summary:
        meta.width && meta.height
          ? t("file.summary_image_dims", {
              name: base.name,
              width: String(meta.width),
              height: String(meta.height),
              size: formatBytes(base.size),
            })
          : t("file.summary_image", { name: base.name, size: formatBytes(base.size) }),
    };
  }

  const parsed = await parseOnServer(file, base);
  if (parsed) return parsed;

  if (isDocxFile(file)) {
    try {
      return makeTextAttachment(base, await extractDocxText(file), t("file.word"));
    } catch (err) {
      return {
        ...base,
        kind: "error",
        error: t("file.error.docx", { reason: err && err.message ? err.message : t("file.error.docx_reason") }),
      };
    }
  }

  if (isPdfFile(file)) {
    try {
      return makeTextAttachment(base, await extractPdfText(file), t("file.pdf"));
    } catch {
      return { ...base, kind: "error", error: t("file.error.pdf") };
    }
  }

  if (isTextLikeFile(file)) {
    return makeTextAttachment(base, await file.text(), t("file.text"));
  }

  if (/\.doc$/.test(lower(file.name))) {
    return { ...base, kind: "error", error: t("file.error.doc_old") };
  }

  return {
    ...base,
    kind: "binary",
    summary: t("file.summary_binary", {
      name: base.name,
      type: base.type || t("file.no_type"),
      size: formatBytes(base.size),
    }),
  };
}
