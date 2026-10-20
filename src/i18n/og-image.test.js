import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { localizeHtml } from "../../scripts/i18n-html.mjs";
import sitesConfig from "../../shared/sites.json";

const ROOT = resolve(import.meta.dirname, "../..");
const PAGES = ["index.html", "shop.html", "articles.html"];
const OG_RE = /<meta (?:property="og:image"|name="twitter:image") content="([^"]*)"/g;

const ogImages = (html) => [...html.matchAll(OG_RE)].map((match) => match[1]);

describe("картинка превью ссылок", () => {
  test.each(PAGES)("%s: своя картинка из public/, не стоковое фото", (page) => {
    const images = ogImages(readFileSync(resolve(ROOT, page), "utf8"));
    expect(images).toHaveLength(2);
    for (const src of images) {
      expect(src).toMatch(/^\/og\//);
      expect(existsSync(resolve(ROOT, "public", src.slice(1)))).toBe(true);
    }
  });

  test("у сайтов со своей картинкой превью файл лежит в их папке", () => {
    for (const site of Object.values(sitesConfig.sites)) {
      if (!site.ogImage) continue;
      expect(site.ogImage).toMatch(/^\/og\//);
      expect(existsSync(resolve(ROOT, site.publicOverlay || "public", site.ogImage.slice(1)))).toBe(true);
    }
  });

  test("с адресом сайта ссылка на картинку становится полной, подпись — на языке страницы", () => {
    const html = readFileSync(resolve(ROOT, "index.html"), "utf8").replace(/\/og\/dinara\.jpg/g, "/og/dinara.jpg?v=abc");
    const out = localizeHtml(html, "home", "ru", "https://dinarabi.com");
    expect(ogImages(out)).toEqual(["https://dinarabi.com/og/dinara.jpg?v=abc", "https://dinarabi.com/og/dinara.jpg?v=abc"]);
    expect(out).toMatch(/<meta property="og:image:alt" content="[^"]+"/);
    expect(out).toMatch(/<meta name="twitter:image:alt" content="[^"]+"/);
  });

  test("без адреса сайта ссылка остаётся относительной, а внешние не трогаются", () => {
    const html = '<head>\n  <meta property="og:image" content="/og/dinara.jpg" />\n  <meta name="twitter:image" content="https://cdn.example.com/x.jpg" />\n</head>';
    expect(ogImages(localizeHtml(html, "home", "ru"))).toEqual(["/og/dinara.jpg", "https://cdn.example.com/x.jpg"]);
    expect(ogImages(localizeHtml(html, "home", "ru", "https://dinarabi.com"))).toEqual([
      "https://dinarabi.com/og/dinara.jpg",
      "https://cdn.example.com/x.jpg",
    ]);
  });
});
