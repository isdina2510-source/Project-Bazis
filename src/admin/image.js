export const MAX_PHOTO_BYTES = 1.2 * 1024 * 1024;
const MAX_SIDE = 1600;
/** Форматы, которые принимает сервер (server.js saveImageBuffer); остальное браузер должен перекодировать в JPEG. */
const SERVER_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const HEIC_NAME_RE = /\.(heic|heif)$/i;

function photoError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(photoError("unsupported_format"));
    };
    img.src = url;
  });
}

/** Файл, который сервер примет как есть, или null, если его нельзя отправить без перекодирования. */
function sendAsIs(file) {
  return SERVER_TYPES.has(file.type) && file.size <= MAX_PHOTO_BYTES ? readFileAsDataUrl(file) : null;
}

/**
 * Data-URL фото для загрузки на сервер: большие, PNG и прочие форматы ужимаются в JPEG
 * (до 1600px по большей стороне и ~1.2 МБ).
 * Ошибки (err.message / err.code):
 *  - unsupported_format — браузер не может открыть файл (например, HEIC в Chrome) или это не картинка;
 *  - image_too_large — картинка открылась, но и после сжатия больше предела.
 */
export async function compressImageFile(file) {
  if (!file) return "";
  // HEIC на Windows часто приходит без MIME-типа — узнаём его по расширению.
  const isImage = String(file.type || "").startsWith("image/") || HEIC_NAME_RE.test(String(file.name || ""));
  if (!isImage) throw photoError("unsupported_format");
  if (file.size <= MAX_PHOTO_BYTES && SERVER_TYPES.has(file.type) && file.type !== "image/png") {
    return readFileAsDataUrl(file);
  }

  // Не открылась — дело в формате, а не в размере: сжатием это не исправить.
  const img = await loadImageFromFile(file);

  let canvas;
  try {
    let width = img.naturalWidth || img.width;
    let height = img.naturalHeight || img.height;
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no_canvas");
    ctx.drawImage(img, 0, 0, width, height);
  } catch {
    // Холст недоступен: подходящий файл отправляем как есть, иначе честно говорим, в чём дело.
    const asIs = sendAsIs(file);
    if (asIs) return asIs;
    throw photoError(SERVER_TYPES.has(file.type) ? "image_too_large" : "unsupported_format");
  }

  // base64 раздувает размер ~в 1.37 раза
  const limit = MAX_PHOTO_BYTES * 1.37;
  let quality = 0.85;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  while (dataUrl.length > limit && quality > 0.5) {
    quality -= 0.1;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  if (dataUrl.length > limit) throw photoError("image_too_large");
  return dataUrl;
}
