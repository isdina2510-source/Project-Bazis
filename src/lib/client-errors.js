/**
 * Ошибки в браузере → POST /api/client-errors (сервер вырезает личные данные и шлёт оповещение).
 * За сессию вкладки: одна и та же ошибка — один раз, всего — не больше 5 отправок.
 */
import { SITE_ID } from "../site.js";
import { reloadOnceForChunkError } from "./chunk-errors.js";

export const CLIENT_ERRORS_ENDPOINT = "/api/client-errors";
export const MAX_REPORTS_PER_SESSION = 5;
const SESSION_KEY = "bazis_client_errors";
const BUILD_ID = typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__ : "dev";

/** Если sessionStorage недоступен (приватный режим), лимит держится в памяти вкладки. */
let memoryState = { sent: [] };

function readState() {
  let raw;
  try {
    raw = sessionStorage.getItem(SESSION_KEY);
  } catch {
    return memoryState;
  }
  try {
    const parsed = JSON.parse(raw || "null");
    if (parsed && Array.isArray(parsed.sent)) return parsed;
  } catch {
    // битое значение — начинаем заново
  }
  return { sent: [] };
}

function writeState(state) {
  memoryState = state;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(state));
  } catch {
    // остаётся в памяти
  }
}

function describe(error) {
  if (error instanceof Error) return { message: (error.name || "Error") + ": " + error.message, stack: String(error.stack || "") };
  if (error && typeof error === "object" && "message" in error) return { message: String(error.message), stack: String(error.stack || "") };
  return { message: String(error == null ? "" : error), stack: "" };
}

/**
 * Отправить ошибку. kind — откуда она: boundary:<раздел>, onerror, unhandledrejection, catalog, chat.
 * @returns {boolean} отправлена ли (false — повтор, лимит сессии или пустая ошибка)
 */
export function reportClientError(error, { kind = "error", componentStack = "" } = {}) {
  const { message: raw, stack } = describe(error);
  const message = ("[" + kind + "] " + raw.trim()).slice(0, 500);
  if (!raw.trim()) return false;
  const signature = message.slice(0, 200);
  const state = readState();
  if (state.sent.length >= MAX_REPORTS_PER_SESSION || state.sent.includes(signature)) return false;
  writeState({ sent: [...state.sent, signature] });
  const body = {
    message,
    // Сервер принимает до 8 КБ: кириллица в UTF-8 — по 2 байта на символ.
    stack: (stack + (componentStack ? "\n" + componentStack : "")).slice(0, 2000),
    path: typeof location !== "undefined" ? location.pathname : "",
    site: SITE_ID,
    userAgent: typeof navigator !== "undefined" ? String(navigator.userAgent || "").slice(0, 300) : "",
    build: BUILD_ID,
  };
  try {
    fetch(CLIENT_ERRORS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // отчёт об ошибке не должен сам ронять страницу
  }
  return true;
}

const installed = new WeakSet();

/** window.onerror и unhandledrejection — один раз на страницу. */
export function installClientErrorReporting(target = window) {
  if (installed.has(target)) return;
  installed.add(target);
  target.addEventListener("error", (event) => {
    // Ошибки загрузки картинок и скриптов приходят без error и message — это не сбой кода.
    if (!event || (!event.error && !event.message)) return;
    reportClientError(event.error || event.message, { kind: "onerror" });
  });
  target.addEventListener("unhandledrejection", (event) => {
    reportClientError(event && event.reason, { kind: "unhandledrejection" });
  });
  // Vite не смог подгрузить модуль новой сборки: одна перезагрузка вместо ошибки (см. chunk-errors.js).
  target.addEventListener("vite:preloadError", (event) => {
    if (reloadOnceForChunkError()) event.preventDefault();
  });
}
