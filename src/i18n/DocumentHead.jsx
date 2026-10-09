import { useEffect } from "react";
import { headData } from "./head.js";
import { useI18n } from "./I18nProvider.jsx";

function setMeta(attr, key, content) {
  let el = document.head.querySelector(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function setLink(selector, attrs) {
  let el = document.head.querySelector(selector);
  if (!el) {
    el = document.createElement("link");
    document.head.appendChild(el);
  }
  Object.entries(attrs).forEach(([name, value]) => el.setAttribute(name, value));
}

/** Обновляет <html lang>, <title>, description, Open Graph, canonical и hreflang при смене языка/страницы. */
export default function DocumentHead({ page }) {
  const { lang } = useI18n();

  useEffect(() => {
    const head = headData(page, lang, window.location.origin);
    document.documentElement.lang = head.lang;
    document.title = head.title;
    setMeta("name", "description", head.description);
    setMeta("property", "og:title", head.ogTitle);
    setMeta("property", "og:description", head.ogDescription);
    setMeta("property", "og:locale", head.ogLocale);
    setMeta("property", "og:site_name", head.siteName);
    setMeta("property", "og:url", head.canonical);
    setMeta("name", "twitter:title", head.twitterTitle);
    setMeta("name", "twitter:description", head.twitterDescription);
    setLink('link[rel="canonical"]', { rel: "canonical", href: head.canonical });
    head.alternates.forEach(({ hreflang, href }) => {
      setLink(`link[rel="alternate"][hreflang="${hreflang}"]`, { rel: "alternate", hreflang, href });
    });
  }, [lang, page]);

  return null;
}
