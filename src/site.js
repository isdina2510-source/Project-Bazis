/**
 * Какой из сайтов собран: «Базис» (управление бизнесом + инфраструктура) или «Базис Медиа»
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

export function siteUrl(id) {
  return String(SITE_URLS[id] || "").replace(/\/+$/, "");
}

export function siteHasCategory(id) {
  return SITE.categories.includes(id);
}
