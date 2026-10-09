import { LANGS, OG_LOCALES, t } from "./index.js";

const PAGE_PATHS = { home: "/", shop: "/shop", articles: "/articles" };

/** Путь страницы на языке; без lang — x-default (сервер выберет язык сам). */
export function pagePath(page, lang) {
  const path = PAGE_PATHS[page] || "/";
  if (!lang) return path;
  return "/" + lang + (path === "/" ? "/" : path);
}

/**
 * Всё, что нужно в <head> страницы на языке: тексты из словаря, canonical и hreflang.
 * origin — https://example.kz без слеша на конце; пусто — относительные ссылки.
 */
export function headData(page, lang, origin = "") {
  const key = PAGE_PATHS[page] ? page : "home";
  const title = t(`meta.${key}.title`, undefined, lang);
  return {
    lang,
    title,
    description: t(`meta.${key}.description`, undefined, lang),
    ogTitle: title,
    ogDescription: t(`meta.${key}.og_description`, undefined, lang),
    ogLocale: OG_LOCALES[lang],
    ogLocaleAlternates: LANGS.filter((code) => code !== lang).map((code) => OG_LOCALES[code]),
    siteName: t("common.brand", undefined, lang),
    twitterTitle: title,
    twitterDescription: t(`meta.${key}.twitter_description`, undefined, lang),
    canonical: origin + pagePath(key, lang),
    alternates: [
      ...LANGS.map((code) => ({ hreflang: code, href: origin + pagePath(key, code) })),
      { hreflang: "x-default", href: origin + pagePath(key, "") },
    ],
  };
}
