/**
 * Vite-плагин: HTML-страницы на каждом языке (dist/kk/index.html, dist/ru/shop.html …)
 * с правильными <html lang>, title, description, Open Graph, canonical и hreflang —
 * их видят поисковики и превью ссылок в мессенджерах, не выполняя JS.
 */
import fs from "node:fs";
import path from "node:path";
import { headData } from "../src/i18n/head.js";
import { DEFAULT_LANG, LANGS, applySiteDictionaries } from "../src/i18n/index.js";

const PAGES = { "index.html": "home", "shop.html": "shop", "articles.html": "articles" };

function pageFromRest(rest) {
  if (rest.startsWith("/shop")) return "shop";
  if (rest.startsWith("/articles")) return "articles";
  return "home";
}

const escapeAttr = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeText = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function setMeta(html, attr, key, value) {
  const re = new RegExp(`(<meta\\s+${attr}="${key}"\\s+content=")[^"]*(")`);
  if (re.test(html)) return html.replace(re, (_, start, end) => start + escapeAttr(value) + end);
  return html.replace("</head>", () => `  <meta ${attr}="${key}" content="${escapeAttr(value)}" />\n</head>`);
}

export function localizeHtml(html, page, lang, origin = "") {
  const head = headData(page, lang, origin);
  let out = html
    .replace(/<html\b[^>]*>/, `<html lang="${head.lang}">`)
    .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${escapeText(head.title)}</title>`)
    .replace(/\s*<link rel="(?:canonical|alternate)"[^>]*>/g, "")
    .replace(/\s*<meta property="og:(?:url|locale:alternate)"[^>]*>/g, "");

  out = setMeta(out, "name", "description", head.description);
  out = setMeta(out, "property", "og:title", head.ogTitle);
  out = setMeta(out, "property", "og:description", head.ogDescription);
  out = setMeta(out, "property", "og:locale", head.ogLocale);
  out = setMeta(out, "property", "og:site_name", head.siteName);
  out = setMeta(out, "name", "twitter:title", head.twitterTitle);
  out = setMeta(out, "name", "twitter:description", head.twitterDescription);

  const tags = [
    `<link rel="canonical" href="${escapeAttr(head.canonical)}" />`,
    ...head.alternates.map(
      ({ hreflang, href }) => `<link rel="alternate" hreflang="${hreflang}" href="${escapeAttr(href)}" />`
    ),
    ...head.ogLocaleAlternates.map((locale) => `<meta property="og:locale:alternate" content="${locale}" />`),
  ];
  if (origin) tags.push(`<meta property="og:url" content="${escapeAttr(head.canonical)}" />`);
  return out.replace("</head>", () => tags.map((tag) => "  " + tag).join("\n") + "\n</head>");
}

function langFromUrl(url) {
  const match = String(url || "").match(/^\/(kk|ru)(?=[/?#]|$)(.*)$/);
  return match ? { lang: match[1], rest: match[2] || "/" } : { lang: DEFAULT_LANG, rest: String(url || "/") };
}

/**
 * origin — адрес сайта (SITE_URL) для абсолютных canonical / hreflang / og:url;
 * site — какой сайт собирается: его тексты (locales/sites) попадают в мета-теги.
 */
export function i18nHtml({ origin = "", site = "" } = {}) {
  const base = origin.replace(/\/+$/, "");
  if (site) applySiteDictionaries(site);
  let outDir = "dist";
  return {
    name: "i18n-html",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const name = path.basename(ctx.filename);
        if (!PAGES[name]) return html;
        if (ctx.server) {
          const { lang, rest } = langFromUrl(ctx.originalUrl);
          return localizeHtml(html, pageFromRest(rest), lang, base);
        }
        // Корневые /, /shop — x-default: язык по умолчанию, ссылки на языковые версии.
        return localizeHtml(html, PAGES[name], DEFAULT_LANG, base);
      },
    },
    writeBundle() {
      Object.entries(PAGES).forEach(([name, page]) => {
        const source = path.join(outDir, name);
        if (!fs.existsSync(source)) return;
        const html = fs.readFileSync(source, "utf8");
        LANGS.forEach((lang) => {
          fs.mkdirSync(path.join(outDir, lang), { recursive: true });
          fs.writeFileSync(path.join(outDir, lang, name), localizeHtml(html, page, lang, base));
        });
      });
    },
  };
}
