import { apiFetch, parseApiError } from "./api.js";
import {
  DEFAULT_IMAGE,
  DEFAULT_PRODUCTS,
  normalizeCategory,
  normalizeCurrency,
  normalizeKind,
  normalizeProduct,
} from "./catalog.js";

const PRODUCTS_KEY = "bazis_products";
const PRODUCTS_CACHE_KEY = "bazis_products_cache";

export function readCachedProducts() {
  for (const key of [PRODUCTS_CACHE_KEY, PRODUCTS_KEY]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        return parsed.map(normalizeProduct).filter((item) => item.id && item.title);
      }
    } catch {
      // битый кэш — игнорируем
    }
  }
  return DEFAULT_PRODUCTS.map(normalizeProduct);
}

function writeCachedProducts(list) {
  try {
    const payload = JSON.stringify(list);
    localStorage.setItem(PRODUCTS_CACHE_KEY, payload);
    localStorage.setItem(PRODUCTS_KEY, payload);
  } catch {
    // QuotaExceeded — кэш не критичен
  }
}

export async function fetchProducts() {
  const res = await apiFetch("/api/products");
  if (!res.ok) throw new Error("products_fetch_failed");
  const data = await res.json();
  const list = Array.isArray(data) ? data : data && data.products;
  if (!Array.isArray(list)) throw new Error("products_invalid");
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
