import { IntlMessageFormat } from "intl-messageformat";
import kk from "../locales/kk.json";
import ru from "../locales/ru.json";
import mediaKk from "../locales/sites/media.kk.json";
import mediaRu from "../locales/sites/media.ru.json";
import { SITE_ID } from "../site.js";

export const LANGS = ["kk", "ru"];
export const DEFAULT_LANG = "kk";
export const FALLBACK_LANG = "ru";
export const LOCALES = { kk: "kk-KZ", ru: "ru-RU" };
export const OG_LOCALES = { kk: "kk_KZ", ru: "ru_KZ" };
export const LANG_COOKIE = "lang";

/** Тексты, которые на сайте отличаются от общих словарей: только изменённые ключи. */
const SITE_OVERRIDES = { media: { kk: mediaKk, ru: mediaRu } };

function deepMerge(base, extra) {
  if (!extra) return base;
  const out = { ...base };
  Object.entries(extra).forEach(([key, value]) => {
    out[key] = value && typeof value === "object" && !Array.isArray(value) ? deepMerge(base[key] || {}, value) : value;
  });
  return out;
}

function buildDicts(site) {
  const overrides = SITE_OVERRIDES[site] || {};
  return { kk: deepMerge(kk, overrides.kk), ru: deepMerge(ru, overrides.ru) };
}

let DICTS = buildDicts(SITE_ID);
const TODO_PREFIX = "TODO(kk):";
const NBSP = "\u00A0";

let current = DEFAULT_LANG;

export const isLang = (value) => LANGS.includes(value);

/** Текущий язык для кода вне React (форматирование, сообщения в мессенджеры). */
export function getLang() {
  return current;
}

export function setLang(lang) {
  if (isLang(lang)) current = lang;
}

const reported = new Set();

/** Нет казахского текста — показываем русский и пишем TODO(kk) в консоль (только в dev). */
function reportTodo(key) {
  if (!import.meta.env?.DEV || reported.has(key)) return;
  reported.add(key);
  console.info(TODO_PREFIX + " " + key);
}

function lookup(lang, key) {
  const value = key.split(".").reduce((node, part) => (node == null ? node : node[part]), DICTS[lang]);
  return typeof value === "string" ? value : null;
}

function resolveMessage(key, lang) {
  const own = lookup(lang, key);
  if (own != null && !own.startsWith(TODO_PREFIX)) return { message: own, lang };
  if (lang !== FALLBACK_LANG) reportTodo(key);
  const fallback = lookup(FALLBACK_LANG, key);
  return fallback != null ? { message: fallback, lang: FALLBACK_LANG } : null;
}

const formatters = new Map();

/** Словари другого сайта — для генерации HTML при сборке (scripts/i18n-html.mjs). */
export function applySiteDictionaries(site) {
  DICTS = buildDicts(site);
  formatters.clear();
}

function format(key, values, lang) {
  const resolved = resolveMessage(key, lang);
  if (!resolved) {
    if (import.meta.env?.DEV) console.warn("i18n: нет ключа " + key); // i18n-ignore: лог для разработчика
    return key;
  }
  const cacheKey = resolved.lang + "\u0000" + key;
  let formatter = formatters.get(cacheKey);
  if (!formatter) {
    formatter = new IntlMessageFormat(resolved.message, LOCALES[resolved.lang]);
    formatters.set(cacheKey, formatter);
  }
  return formatter.format(values);
}

/** Строка из словаря (ICU: {name}, plural, select). */
export function t(key, values, lang = current) {
  const out = format(key, values, lang);
  return Array.isArray(out) ? out.join("") : out;
}

/** То же, но со вставкой React-узлов: tRich("home.fit.owners", { strong: (c) => <strong>{c}</strong> }). */
export function tRich(key, values, lang = current) {
  return format(key, values, lang);
}

/** Поле контента на языке: title_kk → title (с TODO(kk), если перевода нет). */
export function localizedField(item, field, lang = current) {
  if (!item) return "";
  const own = lang === FALLBACK_LANG ? "" : String(item[field + "_" + lang] || "").trim();
  if (own) return own;
  if (lang !== FALLBACK_LANG) reportTodo(`content:${item.id || "?"}.${field}_${lang}`);
  return String(item[field] || "");
}

export function formatNumber(value, lang = current) {
  return new Intl.NumberFormat(LOCALES[lang]).format(Number(value) || 0).replace(/\s/g, NBSP);
}

/** 05.10.2026 */
export function formatDate(value, lang = current) {
  return new Intl.DateTimeFormat(LOCALES[lang], { day: "2-digit", month: "2-digit", year: "numeric" }).format(
    new Date(value)
  );
}

export function readLangCookie() {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(/(?:^|;\s*)lang=([^;]+)/);
  return match && isLang(match[1]) ? match[1] : "";
}

export function writeLangCookie(lang) {
  if (!isLang(lang)) return;
  document.cookie = `${LANG_COOKIE}=${lang}; Max-Age=31536000; Path=/; SameSite=Lax`;
}

/** Язык для первого захода: cookie → язык браузера → по умолчанию kk. */
export function detectLang() {
  const fromCookie = readLangCookie();
  if (fromCookie) return fromCookie;
  const prefs = typeof navigator !== "undefined" ? navigator.languages || [navigator.language] : [];
  for (const pref of prefs) {
    const base = String(pref || "").toLowerCase().split("-")[0];
    if (isLang(base)) return base;
  }
  return DEFAULT_LANG;
}

/** Поисковые роботы и превью ссылок: им не делаем редирект по языку браузера. */
export const BOT_UA = /bot|crawl|spider|slurp|bingpreview|yandex|facebookexternalhit|whatsapp|vkshare/i;
