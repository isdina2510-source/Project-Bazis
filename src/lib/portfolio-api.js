import { apiError, apiFetch, invalidResponseError, parseApiError, readJson, unauthorizedError } from "./api.js";

export const PORTFOLIO_KINDS = ["video", "cartoon", "photo", "invite", "site"];
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];

/** Работы из админки; null — там ещё ничего не сохраняли (сайт показывает встроенные примеры). */
export async function fetchPortfolio() {
  let res;
  try {
    res = await apiFetch("/api/portfolio");
  } catch {
    throw apiError("network", "network_error");
  }
  if (!res.ok) throw apiError("portfolio_fetch_failed", "portfolio_fetch_failed", res.status);
  const data = await readJson(res);
  if (!data || typeof data !== "object" || (data.items !== null && !Array.isArray(data.items))) throw invalidResponseError();
  return data.items;
}

export async function savePortfolio(items) {
  const res = await apiFetch("/api/portfolio", { method: "PUT", body: { items }, admin: true });
  if (!res.ok) throw new Error(await parseApiError(res));
  const data = await readJson(res);
  return data.items;
}

/**
 * Загрузка фото или видео: тело запроса — сам файл. XHR, а не fetch — ради полосы прогресса у больших видео.
 * onProgress(доля 0…1). Ответ — путь сохранённого файла images/uploads/….
 */
export function uploadPortfolioFile(blob, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/portfolio/upload");
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", blob.type);
    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      };
    }
    xhr.onload = () => {
      if (xhr.status === 401) {
        reject(unauthorizedError());
        return;
      }
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // не JSON — ниже общая ошибка
      }
      if (xhr.status >= 200 && xhr.status < 300 && data && typeof data.path === "string") resolve(data.path);
      else if (xhr.status === 413 && !data) reject(new Error("Файл слишком большой для сервера или прокси")); // i18n-ignore: админка
      else reject(new Error((data && (data.message || data.error)) || "Не удалось загрузить файл")); // i18n-ignore: админка
    };
    xhr.onerror = () => reject(new Error("Нет связи с сервером — файл не загружен")); // i18n-ignore: админка
    xhr.onabort = () => reject(apiError("aborted", "aborted"));
    if (signal) signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

export function workTitle(work, lang) {
  return (lang === "kk" && work.title_kk) || work.title;
}

export function workTerms(work, lang) {
  return (lang === "kk" && work.terms_kk) || work.terms || "";
}
