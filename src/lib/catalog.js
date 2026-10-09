import catalog from "../../shared/catalog.json";
import { formatNumber, getLang, localizedField, t } from "../i18n/index.js";
import { siteHasCategory } from "../site.js";

/** Все разделы каталога — для админки, отчётов и проверки данных. */
export const ALL_CATEGORIES = catalog.CATEGORIES;
/** Разделы, которые показывает этот сайт. */
export const CATEGORIES = ALL_CATEGORIES.filter((item) => siteHasCategory(item.id));
// catalog.DEFAULT_PRODUCTS — только для первого заполнения базы на сервере: в браузере их цены могли устареть.

const CART_RULES = catalog.CART_RULES;
/** Тот же предел сервер применяет к количеству в заказе. */
export const MAX_CART_QTY = CART_RULES.maxQty;
const DISCUSS_ONLY_CATEGORIES = new Set(CART_RULES.discussOnlyCategories);
const SINGLE_QTY_IDS = new Set(CART_RULES.singleQtyIds);
const SINGLE_QTY_TITLE = new RegExp(CART_RULES.singleQtyTitlePattern, "i");

export const CONTACT_PHONE = "77753899972";
/** Username Telegram без @ */
export const CONTACT_TELEGRAM = "Dinara_888888";
export const DEFAULT_IMAGE =
  "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?auto=format&fit=crop&w=900&q=80";

export function normalizeCurrency(value) {
  const code = String(value || "KZT").toUpperCase();
  return code === "RUB" || code === "USD" || code === "KZT" ? code : "KZT";
}

export function currencySymbol(currency) {
  const map = { KZT: "₸", RUB: "₽", USD: "$" };
  return map[normalizeCurrency(currency)];
}

const NBSP = "\u00A0";

/** 12 500 ₸ — неразрывные пробелы в разрядах и перед знаком валюты. */
export function formatPrice(value, currency, lang = getLang()) {
  const amount = formatNumber(value, lang);
  const code = normalizeCurrency(currency);
  const symbol = currencySymbol(code);
  if (code === "USD") return symbol + amount;
  return amount + NBSP + symbol;
}

export function formatFromPrice(value, currency, lang = getLang()) {
  const price = formatPrice(value, currency, lang);
  return t("price.from", { price }, lang).replace(" " + price, NBSP + price);
}

export function normalizeKind(value) {
  return String(value || "service") === "product" ? "product" : "service";
}

export function normalizeCategory(value) {
  const id = String(value || "").trim();
  return ALL_CATEGORIES.some((item) => item.id === id) ? id : "management";
}

export function getCategoryById(id) {
  return (
    ALL_CATEGORIES.find((item) => item.id === id) ||
    ALL_CATEGORIES[0] || { id: "management", title: "Управление бизнесом" } // i18n-ignore: запасное значение данных
  );
}

/** Позиция относится к разделу, который показывает этот сайт. */
export function isSiteProduct(product) {
  return !!product && siteHasCategory(product.category);
}

export function getCategoryLabel(id) {
  return getCategoryById(id).title;
}

/** Название / надзаголовок / описание раздела на текущем языке. */
export function categoryText(id, field, lang = getLang()) {
  const category = getCategoryById(id);
  return t(`catalog.category.${category.id}.${field}`, undefined, lang);
}

/** Название и описание товара на текущем языке (title_kk / description_kk, иначе русские). */
export function productText(product, field, lang = getLang()) {
  return localizedField(product, field, lang);
}

/** Консалтинг: только обсуждение, без корзины */
export function isDiscussOnlyProduct(product) {
  return DISCUSS_ONLY_CATEGORIES.has(normalizeCategory(product && product.category));
}

/** Медиа и инфраструктура: покупка через корзину */
export function isCartProduct(product) {
  return !isDiscussOnlyProduct(product);
}

/** Можно ли сейчас добавить позицию в корзину: не «только обсуждение» и есть в наличии. */
export function isAddableProduct(product) {
  return isCartProduct(product) && !isOutOfStock(product);
}

/** Qty скрываем для менторства, регламентов и аналогов по названию */
export function allowsCartQty(product) {
  const raw = product && typeof product === "object" ? product : {};
  if (SINGLE_QTY_IDS.has(String(raw.id || "").trim())) return false;
  return !SINGLE_QTY_TITLE.test(String(raw.title || ""));
}

export function normalizeProduct(item) {
  const raw = item && typeof item === "object" ? item : {};
  return {
    id: String(raw.id || "").trim(),
    title: String(raw.title || "").trim(),
    description: String(raw.description || "").trim(),
    title_kk: String(raw.title_kk || "").trim(),
    description_kk: String(raw.description_kk || "").trim(),
    price: Math.max(0, Number(raw.price) || 0),
    currency: normalizeCurrency(raw.currency),
    kind: normalizeKind(raw.kind),
    category: normalizeCategory(raw.category),
    image: String(raw.image || DEFAULT_IMAGE).trim() || DEFAULT_IMAGE,
    stock: normalizeStock(raw.stock),
  };
}

/** Остаток: null — не учитывается (без ограничений), иначе целое ≥ 0. */
export function normalizeStock(value) {
  if (value == null || value === "") return null;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

/** Сумма позиции без ошибки двоичной дроби: 10.1 × 3 = 30.3, а не 30.299999999999997. */
export function lineAmount(price, qty) {
  const unit = Math.round(Number(price) * 100);
  const count = Math.max(0, Math.floor(Number(qty) || 0));
  if (!Number.isFinite(unit) || unit < 0) return 0;
  return (unit * count) / 100;
}

/** С какого остатка покупателю показывается «Осталось: N». */
export const LOW_STOCK_THRESHOLD = 5;

export function isOutOfStock(product) {
  return !!product && product.stock != null && product.stock <= 0;
}

/** Сколько этой позиции можно положить в корзину (0 — нет в наличии). Сервер проверяет то же при оформлении. */
export function maxCartQty(product) {
  const limit = allowsCartQty(product) ? MAX_CART_QTY : 1;
  return product && product.stock != null ? Math.min(limit, Math.max(0, product.stock)) : limit;
}

export function isLowStock(product) {
  return !!product && product.stock != null && product.stock > 0 && product.stock <= LOW_STOCK_THRESHOLD;
}

/** По одной позиции из каждого раздела, затем добиваем до limit. */
export function getFeaturedProducts(products, limit = 3) {
  const picked = [];
  const seen = new Set();

  CATEGORIES.forEach((category) => {
    const item = products.find((product) => product.category === category.id);
    if (item && !seen.has(item.id)) {
      picked.push(item);
      seen.add(item.id);
    }
  });

  products.forEach((product) => {
    if (picked.length >= limit || seen.has(product.id)) return;
    picked.push(product);
    seen.add(product.id);
  });

  return picked.slice(0, limit);
}

/**
 * Безопасный src для <img>: относительные пути каталога (images/...) делаем
 * абсолютными, чтобы они работали на любом маршруте SPA.
 */
export function imageSrc(src) {
  const value = String(src || "").trim();
  if (!value) return DEFAULT_IMAGE;
  if (/^javascript:/i.test(value) || /^data:text\//i.test(value)) return DEFAULT_IMAGE;
  if (value.startsWith("data:image/")) return value;
  if (/^https?:\/\//i.test(value)) return value;
  const rel = value.replace(/^\/+/, "");
  if (rel.startsWith("images/") && !rel.includes("..")) return "/" + rel;
  return DEFAULT_IMAGE;
}

export function normalizeTelegramUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^@+/, "")
    .replace(/^https?:\/\/t\.me\//i, "")
    .split(/[/?#]/)[0]
    .trim();
}

export function getTelegramUsername() {
  return normalizeTelegramUsername(CONTACT_TELEGRAM);
}

export function getTelegramProfileUrl() {
  return "https://t.me/" + getTelegramUsername();
}
