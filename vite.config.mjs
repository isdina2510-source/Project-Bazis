import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { i18nHtml } from "./scripts/i18n-html.mjs";
import { HERO_IMAGE } from "./src/lib/hero.js";
import { responsiveSources } from "./src/lib/images.js";
import sitesConfig from "./shared/sites.json" with { type: "json" };
import siteConfig from "./config/sites.js";

const SERVER_PORT = process.env.PORT || 8787;
const API_TARGET = "http://127.0.0.1:" + SERVER_PORT;
/** Для какого адреса сделана сборка — по нему сервер замечает, что сайт пора пересобрать (см. server.js). */
const BUILD_INFO_FILE = ".build-info.json";

/**
 * Адрес каждого включённого сайта для ссылок между сайтами: SITE_DOMAIN / SITE_URL / MEDIA_SITE_URL / url из shared/sites.json
 * (config/sites.js), иначе локальный адрес (dev-сервер Vite или node server.js на первом домене из hosts).
 * Выключенного сайта (MEDIA_SITE_ENABLED) в списке нет — ссылки на него не показываются (siteUrl → "").
 * В режиме разработки ссылки всегда локальные, чтобы не уводить на боевой сайт.
 */
function siteUrls(resolved, command) {
  return Object.fromEntries(
    resolved.sites.map(({ id, url }) => {
      const site = sitesConfig.sites[id];
      const local = command === "serve" ? `http://127.0.0.1:${site.devPort}` : `http://${site.hosts[0]}:${SERVER_PORT}`;
      return [id, command === "serve" ? local : url || local];
    })
  );
}

function buildInfo(siteId, url) {
  return {
    name: "build-info",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: BUILD_INFO_FILE, source: JSON.stringify({ site: siteId, url }, null, 2) + "\n" });
    },
  };
}

/** Preload главной картинки: браузер начинает качать её до выполнения JS. */
function heroPreload() {
  const { src, srcSet } = responsiveSources(HERO_IMAGE.src, HERO_IMAGE);
  return {
    name: "hero-preload",
    transformIndexHtml(html, ctx) {
      if (!/[\\/]index\.html$/.test(ctx.filename)) return html;
      return [
        {
          tag: "link",
          attrs: {
            rel: "preload",
            as: "image",
            href: src,
            imagesrcset: srcSet,
            imagesizes: HERO_IMAGE.sizes,
            fetchpriority: "high",
          },
          injectTo: "head",
        },
      ];
    },
  };
}

/** Класс сайта на <body> и цвет панели браузера сразу в HTML: тема применяется до выполнения JS, без мигания. */
function siteTheme(siteId, { themeColor, ogImage }) {
  return {
    name: "site-theme",
    transformIndexHtml(html) {
      let out = html.replace(/<body([^>]*)>/, (match, attrs) =>
        /class=/.test(attrs) ? match : `<body${attrs} class="site-${siteId}">`
      );
      if (themeColor) out = out.replace(/(<meta name="theme-color" content=")[^"]*(")/, `$1${themeColor}$2`);
      if (ogImage) {
        out = out.replace(/(<meta (?:property="og:image"|name="twitter:image") content=")[^"]*(")/g, `$1${ogImage}$2`);
      }
      return out;
    },
  };
}

export default defineConfig(({ mode, command }) => {
  const env = { ...loadEnv(mode, import.meta.dirname, ""), ...process.env };
  const siteId = sitesConfig.sites[mode] ? mode : sitesConfig.default;
  const site = sitesConfig.sites[siteId];
  const resolved = siteConfig.resolveSites(sitesConfig, env);
  if (!resolved.ok) throw new Error("Неверные настройки адреса сайта в .env:\n" + resolved.errors.map((err) => "  • " + err).join("\n"));
  const urls = siteUrls(resolved, command);
  // Абсолютные canonical, hreflang и og:url — только если адрес сайта задан (SITE_DOMAIN и т.п.).
  // Выключенный сайт (MEDIA_SITE_ENABLED) собирается без адреса: сервер его не отдаёт, ссылок на него нет.
  const own = resolved.sites.find((item) => item.id === siteId);
  const origin = own ? own.url : "";

  const input = {
    main: resolve(import.meta.dirname, "index.html"),
    // то же SPA, но с мета-тегами магазина для превью ссылок /shop
    shop: resolve(import.meta.dirname, "shop.html"),
    articles: resolve(import.meta.dirname, "articles.html"),
  };
  if (site.admin) input.admin = resolve(import.meta.dirname, "admin.html");

  return {
    plugins: [
      react(),
      // У медиа-сайта своя главная без портрета — preload картинки «Базиса» ей не нужен.
      ...(siteId === sitesConfig.default ? [heroPreload()] : []),
      siteTheme(siteId, site),
      i18nHtml({ origin, site: siteId }),
      buildInfo(siteId, origin),
    ],
    define: {
      "import.meta.env.VITE_SITE": JSON.stringify(siteId),
      __SITE_URLS__: JSON.stringify(urls),
      // Метка сборки в отчётах об ошибках из браузера (src/lib/client-errors.js): 20261009T1530.
      __BUILD_ID__: JSON.stringify(command === "serve" ? "dev" : new Date().toISOString().replace(/[-:]/g, "").slice(0, 13)),
    },
    build: {
      outDir: site.outDir,
      emptyOutDir: true,
      // exceljs и pdfmake грузятся лениво только при экспорте отчётов
      chunkSizeWarningLimit: 1100,
      rollupOptions: { input },
    },
    server: {
      host: "127.0.0.1",
      port: site.devPort,
      strictPort: true,
      proxy: {
        "/api": API_TARGET,
        "/images": API_TARGET,
      },
      fs: {
        // dev-сервер отдаёт файлы из корня проекта — закрываем данные CRM и серверный код
        deny: [
          ".env",
          ".env.*",
          "*.{crt,pem}",
          "**/.git/**",
          "**/data/**",
          "**/legacy/**",
          "**/.backup-*/**",
          "**/.tools/**",
          "server.js",
          "package.json",
          "package-lock.json",
          "*.bat",
          "*.md",
        ],
      },
    },
  };
});
