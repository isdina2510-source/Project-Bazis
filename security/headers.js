/**
 * Заголовки безопасности для всех ответов сервера. Дублируют заголовки из deploy/*.template,
 * чтобы защита работала и без прокси, и при ошибке в его настройке.
 *
 * CSP рассчитана на сборку Vite: скрипты — только файлы сайта (встроенных скриптов и eval нет);
 * встроенные стили разрешены — их использует окно печати отчётов в админке;
 * картинки — с любого HTTPS-адреса (у товара может быть внешняя ссылка на картинку), data: и blob: (превью в админке).
 */
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' https: blob:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
];

const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()";
const HSTS = "max-age=31536000";

/**
 * @param {{ https?: boolean, admin?: boolean }} context
 *   https — посетитель пришёл по HTTPS (по словам доверенного прокси): включаем HSTS и upgrade-insecure-requests;
 *   admin — страница или API админки: встраивание во фреймы запрещено полностью.
 */
function securityHeaders({ https = false, admin = false } = {}) {
  const csp = [...CSP_DIRECTIVES, admin ? "frame-ancestors 'none'" : "frame-ancestors 'self'"];
  if (https) csp.push("upgrade-insecure-requests");
  const headers = {
    "Content-Security-Policy": csp.join("; "),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": admin ? "DENY" : "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": PERMISSIONS_POLICY,
    "Cross-Origin-Resource-Policy": "same-site",
  };
  if (https) headers["Strict-Transport-Security"] = HSTS;
  return headers;
}

/** Страница админки (/admin.html, /admin, /admin/…) — её нельзя встраивать ни в какие фреймы. */
function isAdminPath(pathname) {
  return /^\/admin(\.html)?(\/|$)/.test(pathname);
}

module.exports = { securityHeaders, isAdminPath };
