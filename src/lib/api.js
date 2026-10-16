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
export async function apiFetch(path, { method = "GET", body, admin = false, password, headers: extraHeaders, keepalive = false } = {}) {
  const headers = { ...extraHeaders };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  // Заголовок — запасной путь для скриптов; браузерная админка его не шлёт.
  if (password != null && password !== "") {
    headers["X-Admin-Password"] = encodeURIComponent(String(password));
  }

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
    credentials: "same-origin",
    // Запрос доживёт до ответа, даже если посетитель ушёл со страницы (переход в WhatsApp на телефоне).
    keepalive,
  });
  if (admin && res.status === 401) throw unauthorizedError();
  return res;
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
