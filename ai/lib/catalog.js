const CATALOG = require("../../shared/catalog.json");
const SITES_CONFIG = require("../../shared/sites.json");

/**
 * Список услуг для промпта консультанта. Собирается на сервере из базы: каталог из браузера
 * можно подменить (например, вписать ложные цены), и модель повторила бы их клиенту.
 * Формат совпадает с getCatalogLines() в src/chat/consult.js.
 */

const MAX_CATALOG_CHARS = 8000;
const SYMBOLS = { KZT: "₸", RUB: "₽", USD: "$" };
const NBSP = "\u00A0";

function formatFromPrice(value, currency) {
  const code = SYMBOLS[String(currency || "").toUpperCase()] ? String(currency).toUpperCase() : "KZT";
  const amount = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 })
    .format(Math.max(0, Number(value) || 0))
    .replace(/\s/g, NBSP);
  return "от" + NBSP + (code === "USD" ? SYMBOLS.USD + amount : amount + NBSP + SYMBOLS[code]);
}

function siteCategories(siteId) {
  const site = SITES_CONFIG.sites[siteId] || SITES_CONFIG.sites[SITES_CONFIG.default];
  return new Set((site && site.categories) || []);
}

/** @param {Array<object>} products товары из базы  @param {string} siteId */
function buildCatalogText(products, siteId) {
  const allowed = siteCategories(siteId);
  const list = Array.isArray(products) ? products : [];
  const lines = [];
  for (const cat of CATALOG.CATEGORIES) {
    if (!allowed.has(cat.id)) continue;
    const items = list.filter((p) => p && p.category === cat.id && String(p.title || "").trim());
    if (!items.length) continue;
    lines.push(cat.title + ":");
    items.forEach((p, i) => {
      const outOfStock = p.stock != null && p.stock <= 0;
      lines.push(
        i + 1 + ". " + String(p.title).trim() + " (" + formatFromPrice(p.price, p.currency) + ")" +
          (outOfStock ? " — нет в наличии" : "")
      );
    });
  }
  return lines.join("\n").slice(0, MAX_CATALOG_CHARS);
}

module.exports = { buildCatalogText, formatFromPrice, DEFAULT_PRODUCTS: CATALOG.DEFAULT_PRODUCTS };
