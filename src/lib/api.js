export const UNAUTHORIZED_EVENT = "bazis:admin-unauthorized";

/** Старые ключи: пароль больше не храним в sessionStorage. */
const LEGACY_PASS_KEY = "bazis_admin_password";
const LEGACY_AUTH_KEY = "bazis_admin_auth";

function clearLegacyAdminStorage() {
  try {
    sessionStorage.removeItem(LEGACY_PASS_KEY);
    sessionStorage.removeItem(LEGACY_AUTH_KEY);
  } catch {
    // sessionStorage недоступен
  }
}

clearLegacyAdminStorage();

export function clearAdminSession() {
  clearLegacyAdminStorage();
}

/**
 * fetch к API сайта.
 * admin: true — credentials (cookie-сессия) и 401 → событие повторного входа.
 * password — только для одноразовой проверки при миграциях; обычно не нужен.
 */
export async function apiFetch(
  path,
  { method = "GET", body, admin = false, password, headers: extraHeaders, keepalive = false, signal, timeoutMs = 0 } = {}
) {
  const headers = { ...extraHeaders };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  // Заголовок — запасной путь для скриптов; браузерная админка его не шлёт.
  if (password != null && password !== "") {
    headers["X-Admin-Password"] = encodeURIComponent(String(password));
  }

  const timeout = timeoutMs > 0 ? linkedTimeout(signal, timeoutMs) : null;
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
      credentials: "same-origin",
      // Запрос доживёт до ответа, даже если посетитель ушёл со страницы (переход в WhatsApp на телефоне).
      keepalive,
      signal: timeout ? timeout.signal : signal,
    });
  } catch (err) {
    if (timeout && timeout.timedOut()) throw apiError("timeout", "timeout");
    throw err;
  } finally {
    if (timeout) timeout.clear();
  }
  if (admin && res.status === 401) throw unauthorizedError();
  return res;
}

/** Сигнал, который срабатывает по таймауту или вместе с внешним signal. AbortSignal.any есть не во всех Safari. */
function linkedTimeout(signal, ms) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clear() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Повторы GET: паузы перед 2-й и 3-й попыткой и таймаут одной попытки (без ответа — повтор).
 * Тесты обнуляют паузы (src/test/setup.js).
 */
export const retryPolicy = { delaysMs: [700, 2000], timeoutMs: 20000 };
const RETRY_STATUSES = new Set([502, 503, 504]);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(apiError("aborted", "aborted"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(apiError("aborted", "aborted"));
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Ждёт, пока вкладка снова станет видимой: в фоне iOS обрывает и не пускает запросы. */
function whenVisible(signal) {
  if (typeof document === "undefined" || document.visibilityState !== "hidden") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      document.removeEventListener("visibilitychange", onChange);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    const onChange = () => {
      if (document.visibilityState === "hidden") return;
      done();
      resolve();
    };
    const onAbort = () => {
      done();
      reject(apiError("aborted", "aborted"));
    };
    document.addEventListener("visibilitychange", onChange);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * GET к API для данных, без которых страница пустая (каталог, примеры работ).
 * Сбой сети, таймаут и 502/503/504 повторяются: мобильный Safari после возврата из фона или смены сети
 * роняет первый запрос («TypeError: Load failed»), а пока Node перезапускается, nginx отвечает 502.
 * Остальные ответы (2xx, 4xx, 500) возвращаются как есть — повтор их не исправит.
 * Сеть так и не ответила — apiError("network", "network_error") с cause (последняя ошибка) и attempts.
 */
export async function apiGetWithRetry(path, { signal, ...options } = {}) {
  const { delaysMs, timeoutMs } = retryPolicy;
  const attempts = delaysMs.length + 1;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) {
      await sleep(delaysMs[attempt - 2], signal);
      await whenVisible(signal);
    }
    try {
      const res = await apiFetch(path, { ...options, method: "GET", signal, timeoutMs });
      if (!RETRY_STATUSES.has(res.status) || attempt === attempts) return res;
    } catch (err) {
      if (signal && signal.aborted) throw apiError("aborted", "aborted");
      if (err && err.code === "unauthorized") throw err;
      lastError = err;
    }
  }
  const err = apiError("network", "network_error");
  err.cause = lastError;
  err.attempts = attempts;
  throw err;
}

/** Вход: пароль уходит один раз в теле запроса, сервер ставит HttpOnly cookie. */
export async function adminLogin(password) {
  const res = await apiFetch("/api/admin/login", {
    method: "POST",
    body: { password: String(password || "").trim() },
  });
  if (res.status === 401) return { ok: false, reason: "bad_password" };
  if (res.status === 403) return { ok: false, reason: "https" };
  if (res.status === 429) return { ok: false, reason: "rate_limited" };
  if (!res.ok) return { ok: false, reason: "server" };
  return { ok: true };
}

export async function adminLogout() {
  try {
    await apiFetch("/api/admin/logout", { method: "POST", body: {} });
  } catch {
    // сеть недоступна — cookie всё равно протухнет по TTL
  }
  clearAdminSession();
}

/** Есть ли действующая серверная сессия (cookie). */
export async function checkAdminSession() {
  const res = await apiFetch("/api/admin/session");
  if (res.status === 401) return { ok: false, reason: "bad_password" };
  if (res.status === 403) return { ok: false, reason: "https" };
  if (res.status === 429) return { ok: false, reason: "rate_limited" };
  if (!res.ok) return { ok: false, reason: "server" };
  return { ok: true };
}

export function unauthorizedError() {
  const err = new Error("Требуется повторный вход"); // i18n-ignore: админка
  err.code = "unauthorized";
  try {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  } catch {
    // ignore
  }
  return err;
}

export function apiError(code, message, status) {
  const err = new Error(message || code);
  err.code = code;
  err.status = status;
  return err;
}

/** Сервер (или прокси перед ним) ответил не тем, что ждали: HTML вместо JSON, объект вместо списка. */
export function invalidResponseError() {
  return apiError("invalid_response", "Сервер вернул ответ неожиданного вида. Обновите страницу; если не поможет — проверьте сервер."); // i18n-ignore: админка
}

/** Тело ответа как JSON; не JSON — invalid_response. */
export async function readJson(res) {
  try {
    return await res.json();
  } catch {
    throw invalidResponseError();
  }
}

export async function parseApiError(res) {
  try {
    const data = await res.json();
    return data.message || data.error || "request_failed";
  } catch {
    return "request_failed";
  }
}
