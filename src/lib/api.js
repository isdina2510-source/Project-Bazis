const ADMIN_PASS_KEY = "bazis_admin_password";
const ADMIN_AUTH_KEY = "bazis_admin_auth";
export const UNAUTHORIZED_EVENT = "bazis:admin-unauthorized";

export function getAdminPassword() {
  try {
    return String(sessionStorage.getItem(ADMIN_PASS_KEY) || "").trim();
  } catch {
    return "";
  }
}

export function hasStoredAdminSession() {
  try {
    return sessionStorage.getItem(ADMIN_AUTH_KEY) === "1" && !!getAdminPassword();
  } catch {
    return false;
  }
}

export function saveAdminSession(password) {
  try {
    sessionStorage.setItem(ADMIN_AUTH_KEY, "1");
    sessionStorage.setItem(ADMIN_PASS_KEY, String(password || "").trim());
  } catch {
    // sessionStorage недоступен — работаем без восстановления сессии
  }
}

export function clearAdminSession() {
  try {
    sessionStorage.removeItem(ADMIN_AUTH_KEY);
    sessionStorage.removeItem(ADMIN_PASS_KEY);
  } catch {
    // ignore
  }
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

/**
 * fetch к API сайта. admin: true — добавляет заголовок пароля и
 * превращает 401 в ошибку с code === "unauthorized".
 */
export async function apiFetch(path, { method = "GET", body, admin = false, password, headers: extraHeaders, keepalive = false } = {}) {
  const headers = { ...extraHeaders };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const pass = password != null ? password : admin ? getAdminPassword() : "";
  // Заголовок HTTP допускает только Latin-1 — кодируем, чтобы работали пароли на кириллице.
  if (pass) headers["X-Admin-Password"] = encodeURIComponent(pass);

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
    // Запрос доживёт до ответа, даже если посетитель ушёл со страницы (переход в WhatsApp на телефоне).
    keepalive,
  });
  if (admin && res.status === 401) throw unauthorizedError();
  return res;
}

export async function parseApiError(res) {
  try {
    const data = await res.json();
    return data.message || data.error || "request_failed";
  } catch {
    return "request_failed";
  }
}
