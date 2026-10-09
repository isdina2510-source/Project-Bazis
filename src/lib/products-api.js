import { apiError, apiFetch, invalidResponseError, parseApiError, readJson } from "./api.js";
import { DEFAULT_IMAGE, normalizeCategory, normalizeCurrency, normalizeKind, normalizeProduct } from "./catalog.js";

/** Старый формат — просто массив, без даты. */
const LEGACY_PRODUCTS_KEY = "bazis_products";
const PRODUCTS_CACHE_KEY = "bazis_products_cache";

/**
 * Последний каталог, полученный с сервера: { products, savedAt } (savedAt — мс или null для старого кэша без даты)
 * или null, если кэша нет. Каталога по умолчанию тут нет: его цены могут не совпадать с настоящими.
 */
export function readCachedProducts() {
  for (const key of [PRODUCTS_CACHE_KEY, LEGACY_PRODUCTS_KEY]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.products) ? parsed.products : null;
      if (!list || !list.length) continue;
      const products = list.map(normalizeProduct).filter((item) => item.id && item.title);
      if (!products.length) continue;
      const savedAt = !Array.isArray(parsed) && Number.isFinite(parsed.savedAt) ? parsed.savedAt : null;
      return { products, savedAt };
    } catch {
      // битый кэш — игнорируем
    }
  }
  return null;
}

export function writeCachedProducts(list, savedAt = Date.now()) {
  try {
    localStorage.setItem(PRODUCTS_CACHE_KEY, JSON.stringify({ savedAt, products: list }));
    localStorage.removeItem(LEGACY_PRODUCTS_KEY);
  } catch {
    // QuotaExceeded — кэш не критичен
  }
}

export async function fetchProducts() {
  let res;
  try {
    res = await apiFetch("/api/products");
  } catch {
    throw apiError("network", "network_error");
  }
  if (!res.ok) throw apiError("products_fetch_failed", "products_fetch_failed", res.status);
  const data = await readJson(res);
  const list = Array.isArray(data) ? data : data && data.products;
  if (!Array.isArray(list)) throw invalidResponseError();
  const normalized = list.map(normalizeProduct);
  writeCachedProducts(normalized);
  return normalized;
}

function buildPayload(product) {
  const optional = {};
  // Поля *_kk отправляем, только если они есть: иначе сервер сохраняет прежний перевод.
  ["title_kk", "description_kk"].forEach((key) => {
    if (product[key] != null) optional[key] = String(product[key]).trim();
  });
  // Остаток — только если его меняли (null — выключить учёт). stockBase — значение, которое видел админ:
  // если за это время прошли продажи, сервер ответит stock_conflict, а не затрёт их.
  if (product.stock !== undefined) {
    optional.stock = product.stock;
    if (product.stockBase !== undefined) optional.stockBase = product.stockBase;
  }
  return {
    ...optional,
    title: String(product.title || "").trim(),
    description: String(product.description || "").trim(),
    price: String(product.price != null ? product.price : "0"),
    currency: normalizeCurrency(product.currency),
    kind: normalizeKind(product.kind),
    category: normalizeCategory(product.category),
    image: String(product.image || "").trim() || DEFAULT_IMAGE,
  };
}

async function saveProduct(path, method, product) {
  const payload = buildPayload(product);
  if (!payload.title) throw new Error("Укажите название"); // i18n-ignore: админка
  if (!payload.description) throw new Error("Укажите описание"); // i18n-ignore: админка
  const res = await apiFetch(path, { method, body: payload, admin: true });
  if (res.status === 409) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.message || "conflict");
    err.code = data.error;
    err.stock = data.stock;
    throw err;
  }
  if (!res.ok) throw new Error(await parseApiError(res));
  return normalizeProduct(await res.json());
}

export function createProduct(product) {
  return saveProduct("/api/products", "POST", product);
}

export function updateProduct(id, product) {
  return saveProduct("/api/products/" + encodeURIComponent(id), "PATCH", product);
}

export async function deleteProduct(id) {
  const res = await apiFetch("/api/products/" + encodeURIComponent(id), {
    method: "DELETE",
    admin: true,
  });
  if (!res.ok) throw new Error(await parseApiError(res));
  return true;
}
