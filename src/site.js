/**
 * Какой из сайтов собран: «Dinara BILab» (управление бизнесом + инфраструктура) или «Dinara BILab Медиа»
 * (инфраструктура + визуал и медиа). Выбирается при сборке: vite build --mode media.
 */
import sites from "../shared/sites.json";

const requested = typeof import.meta.env !== "undefined" ? import.meta.env.VITE_SITE : "";

export const SITE_ID = sites.sites[requested] ? requested : sites.default;
export const SITE = { id: SITE_ID, ...sites.sites[SITE_ID] };
export const IS_MEDIA = SITE_ID === "media";
/** Второй сайт — для перекрёстных ссылок в подвале и на главной. */
export const SIBLING_ID = Object.keys(sites.sites).find((id) => id !== SITE_ID) || "";
export const SIBLING = SIBLING_ID ? { id: SIBLING_ID, ...sites.sites[SIBLING_ID] } : null;

/** Адреса сайтов для перекрёстных ссылок; подставляются при сборке (см. vite.config.mjs). */
const SITE_URLS = typeof __SITE_URLS__ !== "undefined" ? __SITE_URLS__ : {};

function isLocalHost(host) {
  const value = String(host || "").toLowerCase();
  return value === "localhost" || value.endsWith(".localhost") || /^127\./.test(value) || value === "[::1]";
}

export function siteUrl(id) {
  const url = String(SITE_URLS[id] || "").replace(/\/+$/, "");
  if (!url || typeof window === "undefined" || !isLocalHost(window.location.hostname)) return url;
  // Сайт открыт локально: ведём на локальный адрес соседнего сайта, а не на боевой домен.
  try {
    if (isLocalHost(new URL(url).hostname)) return url;
  } catch {
    return url;
  }
  const hosts = (sites.sites[id] && sites.sites[id].hosts) || [];
  const { protocol, port, hostname } = window.location;
  // localhost и 127.0.0.1 — разные сайты для браузера: корзина и язык не переносятся.
  const host = (/localhost$/.test(hostname) && hosts.find((item) => /localhost$/.test(item))) || hosts[0];
  if (!host) return url;
  return protocol + "//" + host + (port ? ":" + port : "");
}

export function siteHasCategory(id) {
  return SITE.categories.includes(id);
}
