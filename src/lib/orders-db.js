/**
 * Заказы и клиенты CRM. Единственный источник данных — сервер (/api): в браузере
 * заказы и контакты покупателей не хранятся.
 */
import { apiFetch } from "./api.js";
import { SITE_ID } from "../site.js";
import { isProofError, takeOrderProof } from "./order-proof.js";

export const ORDER_STATUSES = ["new", "in_progress", "done", "cancelled"];

const LEGACY_LS_KEYS = ["bazis_orders_db", "bazis_clients_db"];
const LEGACY_IDB_NAME = "bazis_crm";

/** Удаляет из браузера локальные копии заказов и контактов, если они там остались. */
export function purgeLegacyLocalCrm() {
  try {
    LEGACY_LS_KEYS.forEach((key) => localStorage.removeItem(key));
  } catch {
    // localStorage недоступен
  }
  try {
    if (window.indexedDB) window.indexedDB.deleteDatabase(LEGACY_IDB_NAME);
  } catch {
    // ignore
  }
}

function apiError(code, message, status) {
  const err = new Error(message || code);
  err.code = code;
  err.status = status;
  return err;
}

/** Запрос к API: любая неудача — исключение с code (network, rate_limited, catalog_changed, …). */
async function request(path, options) {
  let res;
  try {
    res = await apiFetch(path, options);
  } catch (err) {
    if (err && err.code === "unauthorized") throw err;
    throw apiError("network", "network_error");
  }
  if (!res.ok) {
    let data = {};
    try {
      data = await res.json();
    } catch {
      // тело не JSON
    }
    throw apiError(data.error || "http_" + res.status, data.message, res.status);
  }
  return res.json();
}

function ignoreNotFound(err) {
  if (err && err.status === 404) return null;
  throw err;
}

/** Ключ идемпотентности: повтор того же заказа после сбоя сети не создаст дубль. */
export function newOrderId() {
  try {
    if (crypto.randomUUID) return "ord_" + crypto.randomUUID();
  } catch {
    // небезопасный контекст — id выдаст сервер
  }
  return undefined;
}

/**
 * Сохранить заказ из корзины на сервере. Цены и суммы сервер берёт из своего каталога;
 * если они разошлись с корзиной, придёт ошибка catalog_changed.
 * @param {{ id?: string, channel: string, items: Array, customer: {name: string, phone: string}, message: string, sourcePage?: string }} input
 */
export function saveCheckoutOrder(input) {
  return submitPublicOrder({
    id: input.id,
    channel: input.channel === "telegram" ? "telegram" : "whatsapp",
    customerName: String(input.customer.name || "").trim(),
    customerPhone: String(input.customer.phone || "").trim(),
    items: input.items.map((item) => ({
      id: item.id,
      qty: item.qty,
      price: item.price,
      currency: item.currency,
    })),
    message: input.message,
    sourcePage: input.sourcePage || "",
    site: SITE_ID,
    website: input.website || "",
  });
}

/**
 * POST /api/orders с антиспам-токеном (см. order-proof.js). Если токен устарел или сервер
 * перезапускался — одна повторная попытка со свежим токеном; id заказа тот же, дубля не будет.
 */
export async function submitPublicOrder(body, { keepalive = false } = {}) {
  const send = async () => {
    let proof;
    try {
      proof = await takeOrderProof();
    } catch (err) {
      throw err && err.status ? apiError(err.code, err.message, err.status) : apiError("network", "network_error");
    }
    return request("/api/orders", { method: "POST", body: { ...body, proof }, keepalive });
  };
  try {
    return await send();
  } catch (err) {
    if (!isProofError(err && err.code)) throw err;
    return send();
  }
}

/** Последний полный список и его ETag: если заказы не менялись, сервер ответит 304 без тела. */
let ordersCache = null;

/**
 * Все заказы для клиентов и отчётов — без текста сообщения (он есть в карточке заказа).
 * Повторная загрузка без изменений на сервере не передаёт список заново.
 */
export async function listOrders() {
  const headers = ordersCache ? { "If-None-Match": ordersCache.etag } : undefined;
  let res;
  try {
    res = await apiFetch("/api/orders", { admin: true, headers });
  } catch (err) {
    if (err && err.code === "unauthorized") {
      ordersCache = null;
      throw err;
    }
    throw apiError("network", "network_error");
  }
  if (res.status === 304 && ordersCache) return ordersCache.data;
  if (!res.ok) {
    let data = {};
    try {
      data = await res.json();
    } catch {
      // тело не JSON
    }
    throw apiError(data.error || "http_" + res.status, data.message, res.status);
  }
  const data = await res.json();
  const list = Array.isArray(data) ? data : [];
  const etag = res.headers.get("ETag");
  ordersCache = etag ? { etag, data: list } : null;
  return list;
}

/**
 * Страница заказов или заявок (новые сверху) и число записей по статусам.
 * q — часть имени, телефона или код обращения из чата; from/to — границы даты создания (ISO, to не включается).
 * @param {{ kind: "orders" | "leads", status?: string, cursor?: string | null, limit?: number,
 *   q?: string, from?: string | null, to?: string | null }} params
 * @returns {Promise<{ items: Array, nextCursor: string | null, counts: Record<string, number> }>}
 */
export async function listOrdersPage({ kind, status, cursor, limit = 50, q, from, to }) {
  const query = new URLSearchParams({ kind, limit: String(limit) });
  if (status && status !== "all") query.set("status", status);
  if (cursor) query.set("cursor", cursor);
  if (q && q.trim()) query.set("q", q.trim());
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  const data = await request("/api/orders?" + query, { admin: true });
  return {
    items: Array.isArray(data.items) ? data.items : [],
    nextCursor: data.nextCursor || null,
    counts: data.counts || {},
  };
}

export function updateOrderStatus(id, status) {
  if (!ORDER_STATUSES.includes(status)) return Promise.reject(apiError("invalid_status"));
  return request("/api/orders/" + encodeURIComponent(id), { method: "PATCH", body: { status }, admin: true });
}

export function removeOrder(id) {
  return request("/api/orders/" + encodeURIComponent(id), { method: "DELETE", admin: true }).catch(ignoreNotFound);
}

export async function listClients() {
  const data = await request("/api/clients", { admin: true });
  return Array.isArray(data) ? data : [];
}

/** Создать или обновить клиента; при совпадении телефона сервер объединит карточки. */
export async function saveClient(fields) {
  const body = {
    name: String(fields.name || "").trim(),
    phone: String(fields.phone || "").trim(),
    note: String(fields.note || "").trim(),
    source: fields.source || "manual",
  };
  if (fields.requisites) body.requisites = fields.requisites;
  if (fields.id) {
    const updated = await request("/api/clients/" + encodeURIComponent(fields.id), {
      method: "PATCH",
      body,
      admin: true,
    }).catch(ignoreNotFound);
    if (updated) return updated;
  }
  return request("/api/clients", { method: "POST", body: { ...body, id: fields.id || undefined }, admin: true });
}

export function removeClient(id) {
  return request("/api/clients/" + encodeURIComponent(id), { method: "DELETE", admin: true }).catch(ignoreNotFound);
}
