const MAX_PHOTO_BYTES = 1.2 * 1024 * 1024;
const MAX_SIDE = 1600;

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
      reject(new Error("bad_image"));
    };
    img.src = url;
  });
}

/**
 * Data-URL фото для загрузки на сервер: большие/PNG-файлы ужимаются в JPEG
 * (до 1600px по большей стороне и ~1.2 МБ). Бросает image_too_large.
 */
export async function compressImageFile(file) {
  if (!file || !file.type.startsWith("image/")) return "";
  if (file.size <= MAX_PHOTO_BYTES && file.type !== "image/png") {
    return readFileAsDataUrl(file);
  }

  try {
    const img = await loadImageFromFile(file);
    let width = img.naturalWidth || img.width;
    let height = img.naturalHeight || img.height;
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return readFileAsDataUrl(file);
    ctx.drawImage(img, 0, 0, width, height);

    // base64 раздувает размер ~в 1.37 раза
    const limit = MAX_PHOTO_BYTES * 1.37;
    let quality = 0.85;
    let dataUrl = canvas.toDataURL("image/jpeg", quality);
    while (dataUrl.length > limit && quality > 0.5) {
      quality -= 0.1;
      dataUrl = canvas.toDataURL("image/jpeg", quality);
    }
    if (dataUrl.length > limit) throw new Error("image_too_large");
    return dataUrl;
  } catch (err) {
    if (err && err.message === "image_too_large") throw err;
    if (file.size > MAX_PHOTO_BYTES) throw new Error("image_too_large");
    return readFileAsDataUrl(file);
  }
}
