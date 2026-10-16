/**
 * Готовые конфиги прокси для публикации: deploy/generated/Caddyfile и deploy/generated/nginx.conf
 * из шаблонов deploy/*.template с доменами из .env (SITE_DOMAIN / SITE_URL / MEDIA_SITE_URL) — тех же,
 * по которым сервер выбирает сайт (config/sites.js). Запуск: npm run deploy:config
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { readEnvFile } = require("../config/env.js");
const { resolveSites } = require("../config/sites.js");
const sitesConfig = require("../shared/sites.json");

const ROOT = path.resolve(import.meta.dirname, "..");
const DEPLOY_DIR = path.join(ROOT, "deploy");
const OUT_DIR = path.join(DEPLOY_DIR, "generated");

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Как у сервера: переменные системы важнее .env.
const env = { ...readEnvFile(path.join(ROOT, ".env")), ...process.env };
const resolved = resolveSites(sitesConfig, env);
if (!resolved.ok) fail("Неверные настройки в .env:\n" + resolved.errors.map((err) => "  • " + err).join("\n"));

const missing = resolved.sites.filter((site) => !site.url);
if (missing.length) {
  fail(
    "Не задан домен для сайтов: " + missing.map((site) => "«" + site.label + "»").join(", ") + ".\n" +
      "Добавьте в .env строку SITE_DOMAIN=ваш-домен.kz (без https://) и запустите команду снова."
  );
}

const hosts = [...new Set(resolved.sites.flatMap((site) => site.publicHosts))];
const primary = new URL(resolved.sites.find((site) => site.id === sitesConfig.default).url).hostname;
const wwwHost = hosts.find((host) => host === "www." + primary) || "";
// www обслуживается отдельными server-блоками с 301 на apex, не проксируется на Node.
const nginxHosts = hosts.filter((host) => host !== wwwHost);
const port = String(Number(env.PORT) || 8787);
const wwwRedirectBlocks = wwwHost
  ? `# www → канонический домен (apex), без проксирования на Node.
server {
  listen 80;
  listen [::]:80;
  server_name ${wwwHost};

  location /.well-known/acme-challenge/ {
    root /var/www/certbot;
  }
  location / {
    return 301 https://${primary}$request_uri;
  }
}

server {
  # Ubuntu 24.04 nginx 1.24: HTTP/2 через флаг listen (директива "http2 on" — с 1.25.1).
  listen 443 ssl http2;
  listen [::]:443 ssl http2;
  server_name ${wwwHost};

  ssl_certificate     /etc/letsencrypt/live/${primary}/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/${primary}/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;

  return 301 https://${primary}$request_uri;
}

`
  : "";
const values = {
  CADDY_HOSTS: hosts.join(", "),
  NGINX_HOSTS: nginxHosts.join(" "),
  WWW_REDIRECT_BLOCKS: wwwRedirectBlocks,
  CERT_NAME: primary,
  CERTBOT_DOMAINS: hosts.map((host) => "-d " + host).join(" "),
  PORT: port,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const name of ["Caddyfile", "nginx.conf"]) {
  const template = fs.readFileSync(path.join(DEPLOY_DIR, name + ".template"), "utf8");
  const output = template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    if (!(key in values)) fail(`В шаблоне ${name}.template неизвестная подстановка ${match}`);
    return values[key];
  });
  fs.writeFileSync(path.join(OUT_DIR, name), output);
}

console.log("Готово: deploy/generated/Caddyfile и deploy/generated/nginx.conf");
resolved.sites.forEach((site) => console.log(`  «${site.label}»: ${site.url} (домены: ${site.publicHosts.join(", ")})`));
resolved.disabled.forEach((site) => console.log(`  «${site.label}»: выключен — в конфиги не включён`));
console.log(
  "\nДальше:\n" +
    `  1. DNS: A-записи ${hosts.join(", ")} → IP этого сервера.\n` +
    "  2. Пересоберите сайт под эти адреса: update-site.bat\n" +
    "  3. Запустите прокси: caddy run --config deploy/generated/Caddyfile  (или подключите nginx.conf)\n" +
    "  4. Проверьте: npm run check:prod"
);
