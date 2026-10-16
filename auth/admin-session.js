/**
 * Сессии админки: после входа браузер держит только HttpOnly-cookie, пароль в JS не хранится.
 * В памяти — хеш токена (не сам токен). Заголовок X-Admin-Password остаётся для скриптов/e2e.
 */
const crypto = require("crypto");

const COOKIE_NAME = "bazis_admin_session";
/** Абсолютный срок жизни сессии с момента входа. */
const ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000;
/** Без активности сессия истекает раньше. */
const IDLE_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_SESSIONS = 40;
const TOKEN_BYTES = 32;

function digest(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("base64url");
}

function parseCookies(header) {
  const out = Object.create(null);
  for (const part of String(header || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    let value = part.slice(idx + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // оставляем как есть
    }
    out[key] = value;
  }
  return out;
}

function createAdminSessions({
  absoluteTtlMs = ABSOLUTE_TTL_MS,
  idleTtlMs = IDLE_TTL_MS,
  maxSessions = MAX_SESSIONS,
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, { createdAt: number, lastSeenAt: number }>} */
  const sessions = new Map();

  function prune(ts = now()) {
    for (const [id, session] of sessions) {
      if (ts - session.createdAt > absoluteTtlMs || ts - session.lastSeenAt > idleTtlMs) {
        sessions.delete(id);
      }
    }
  }

  function create() {
    prune();
    while (sessions.size >= maxSessions) {
      let oldestId = null;
      let oldestAt = Infinity;
      for (const [id, session] of sessions) {
        if (session.createdAt < oldestAt) {
          oldestAt = session.createdAt;
          oldestId = id;
        }
      }
      if (oldestId) sessions.delete(oldestId);
      else break;
    }
    const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
    const id = digest(token);
    const ts = now();
    sessions.set(id, { createdAt: ts, lastSeenAt: ts });
    return token;
  }

  function touch(token) {
    if (!token) return false;
    prune();
    const id = digest(token);
    const session = sessions.get(id);
    if (!session) return false;
    session.lastSeenAt = now();
    return true;
  }

  function destroy(token) {
    if (!token) return false;
    return sessions.delete(digest(token));
  }

  function destroyAll() {
    sessions.clear();
  }

  function size() {
    prune();
    return sessions.size;
  }

  return { create, touch, destroy, destroyAll, size, cookieName: COOKIE_NAME };
}

/**
 * Флаг Secure для cookie: на localhost браузеры принимают Secure по HTTP;
 * с публичного хоста — только если посетитель пришёл по HTTPS.
 */
function cookieSecureFlag({ localHost, https }) {
  return !!(localHost || https);
}

function sessionCookieHeader(token, { secure, maxAgeSec }) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function clearSessionCookieHeader({ secure }) {
  return sessionCookieHeader("", { secure, maxAgeSec: 0 });
}

function readSessionToken(req) {
  return parseCookies(req && req.headers && req.headers.cookie)[COOKIE_NAME] || "";
}

/**
 * Для cookie-auth мутаций: Origin/Referer должны совпадать с Host (или Origin отсутствует —
 * так бывает у same-origin навигации; тогда полагаемся на SameSite=Strict).
 * Запросы с чужого Origin отклоняем.
 */
function cookieRequestOriginOk(req, { allowedHostnames }) {
  const host = String((req.headers && req.headers.host) || "")
    .split(":")[0]
    .trim()
    .toLowerCase();
  if (!host) return false;

  const origin = String((req.headers && req.headers.origin) || "").trim();
  if (origin) {
    try {
      const url = new URL(origin);
      const name = url.hostname.toLowerCase();
      if (name === host) return true;
      if (allowedHostnames && allowedHostnames.has(name)) return true;
      return false;
    } catch {
      return false;
    }
  }

  const referer = String((req.headers && req.headers.referer) || "").trim();
  if (referer) {
    try {
      const url = new URL(referer);
      const name = url.hostname.toLowerCase();
      if (name === host) return true;
      if (allowedHostnames && allowedHostnames.has(name)) return true;
      return false;
    } catch {
      return false;
    }
  }

  // Нет Origin/Referer — типичный same-origin XHR; SameSite=Strict не отпустит cookie с чужого сайта.
  return true;
}

module.exports = {
  COOKIE_NAME,
  ABSOLUTE_TTL_MS,
  IDLE_TTL_MS,
  createAdminSessions,
  cookieSecureFlag,
  sessionCookieHeader,
  clearSessionCookieHeader,
  readSessionToken,
  cookieRequestOriginOk,
  parseCookies,
};
