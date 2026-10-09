/** Документы PDF в админке: реквизиты, счета и акты, каталог, отправка. */
import { apiFetch, invalidResponseError, readJson } from "../lib/api.js";
import { downloadBlob } from "../lib/download.js";

function apiError(code, message, status, extra = {}) {
  return Object.assign(new Error(message || code), { code, status, ...extra });
}

async function send(path, options) {
  let res;
  try {
    res = await apiFetch(path, { admin: true, ...options });
  } catch (err) {
    if (err && err.code === "unauthorized") throw err;
    throw apiError("network", "Сервер недоступен. Проверьте подключение.");
  }
  if (!res.ok) {
    let data = {};
    try {
      data = await res.json();
    } catch {
      // тело не JSON
    }
    throw apiError(data.error || "http_" + res.status, data.message || "Ошибка сервера (" + res.status + ")", res.status, {
      errors: Array.isArray(data.errors) ? data.errors : [],
      fields: Array.isArray(data.fields) ? data.fields : [],
    });
  }
  return res;
}

const json = async (path, options) => readJson(await send(path, options));
const id = (value) => encodeURIComponent(value);

/** Имя файла из Content-Disposition (filename* с кириллицей приоритетнее). */
function fileNameFrom(res, fallback) {
  const header = res.headers.get("Content-Disposition") || "";
  const star = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      // ниже — запасной вариант
    }
  }
  const plain = header.match(/filename="([^"]+)"/i);
  return plain ? plain[1] : fallback;
}

async function downloadPdf(path, options, fallback) {
  const res = await send(path, options);
  downloadBlob(await res.blob(), fileNameFrom(res, fallback));
}

/* ---------- реквизиты компании ---------- */

export const getCompany = () => json("/api/settings/company");

export const saveCompany = (fields) => json("/api/settings/company", { method: "PUT", body: { fields } });

/** dataUrl — PNG/JPEG или null, чтобы убрать картинку. */
export const setCompanyImage = (kind, dataUrl) =>
  json("/api/settings/company/" + kind, { method: "PUT", body: { image: dataUrl } });

/** Картинка печати/подписи для предпросмотра (запрос с паролем, поэтому через blob). */
export async function companyImageUrl(kind) {
  const res = await send("/api/settings/company/" + kind + "?t=" + Date.now());
  return URL.createObjectURL(await res.blob());
}

/* ---------- счета и акты ---------- */

export const KIND_LABELS = { invoice: "Счёт", act: "Акт" };

/** Ошибки, которые исправляются в разделе «Реквизиты»: не заполнены реквизиты, не читается файл печати или подписи. */
export const COMPANY_ERROR_CODES = new Set(["company_requisites_missing", "company_asset_unreadable"]);

export async function listOrderDocuments(orderId) {
  const list = await json("/api/orders/" + id(orderId) + "/documents");
  if (!Array.isArray(list)) throw invalidResponseError();
  return list;
}

/** Выписать (или получить действующие) — по документу на каждую валюту заказа. */
export const issueDocuments = (orderId, kind) =>
  json("/api/orders/" + id(orderId) + "/documents", { method: "POST", body: { kind } });

export const reissueDocument = (docId) => json("/api/documents/" + id(docId) + "/reissue", { method: "POST", body: {} });

export const downloadDocument = (doc) => downloadPdf("/api/documents/" + id(doc.id) + "/pdf", {}, doc.number + ".pdf");

export const updateOrderAdjustments = (orderId, fields) =>
  json("/api/orders/" + id(orderId), { method: "PATCH", body: fields });

/* ---------- каталог, товар, заявка ---------- */

export const downloadCatalog = ({ ids, showPrices, showStock }) =>
  downloadPdf("/api/products/catalog.pdf", { method: "POST", body: { ids, showPrices, showStock } }, "catalog.pdf");

export const downloadProductPdf = (productId) => downloadPdf("/api/products/" + id(productId) + "/pdf", {}, "product.pdf");

export const downloadLeadPdf = (orderId) => downloadPdf("/api/orders/" + id(orderId) + "/lead.pdf", {}, "lead.pdf");

/* ---------- отправка ---------- */

let channelsPromise = null;

/** { email, telegram } — какие каналы настроены на сервере (один запрос на сессию). */
export function getChannels() {
  if (!channelsPromise) {
    channelsPromise = json("/api/documents/channels").catch((err) => {
      channelsPromise = null;
      throw err;
    });
  }
  return channelsPromise;
}

/**
 * @param {{ target: { type: "document", id: string } | { type: "catalog", ids: string[], showPrices: boolean, showStock: boolean },
 *   channel: "email" | "telegram", to?: string, comment?: string }} input
 */
export const sendPdf = (input) => json("/api/documents/send", { method: "POST", body: input });
