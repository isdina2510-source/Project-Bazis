import { useCallback, useEffect, useState } from "react";
import {
  UNAUTHORIZED_EVENT,
  apiFetch,
  clearAdminSession,
  getAdminPassword,
  hasStoredAdminSession,
  saveAdminSession,
} from "../lib/api.js";
import AdminErrorBoundary from "./AdminErrorBoundary.jsx";
import Dashboard from "./Dashboard.jsx";
import { DialogHost, closeDialogs } from "./dialogs.jsx";
import LoginView from "./LoginView.jsx";

const SERVER_DOWN = "Сервер не ответил. Запустите start-site.bat";
const NO_CONNECTION = "Нет связи с сервером. Запустите start-site.bat";
const HTTPS_REQUIRED = "Админка открыта без HTTPS — пароль не отправлен. Откройте её по адресу https://…";

/** HTTPS или этот компьютер (localhost): иначе пароль в заголовке может перехватить любой в сети. */
const SECURE_CONNECTION = typeof window === "undefined" || window.isSecureContext !== false;

/** Проверка пароля: любой админский GET вернёт 401 при неверном пароле; берём одну запись, а не весь список. */
async function verifyPassword(password) {
  if (!SECURE_CONNECTION) return { ok: false, reason: "https" };
  const res = await apiFetch("/api/orders?kind=leads&limit=1", { password });
  if (res.status === 401) return { ok: false, reason: "bad_password" };
  if (res.status === 403) return { ok: false, reason: "https" };
  if (res.status === 429) return { ok: false, reason: "rate_limited" };
  if (!res.ok) return { ok: false, reason: "server" };
  return { ok: true };
}

export default function AdminApp() {
  return (
    <AdminErrorBoundary name="app">
      <AdminShell />
    </AdminErrorBoundary>
  );
}

function AdminShell() {
  const [authed, setAuthed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const logout = useCallback((message = "") => {
    closeDialogs();
    clearAdminSession();
    setAuthed(false);
    setError(message);
  }, []);

  // Восстановление сессии только после повторной проверки пароля на сервере.
  useEffect(() => {
    if (!hasStoredAdminSession()) {
      clearAdminSession();
      return;
    }
    let cancelled = false;
    setBusy(true);
    verifyPassword(getAdminPassword())
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setAuthed(true);
          return;
        }
        clearAdminSession();
        if (result.reason === "bad_password") setError("Сессия истекла. Войдите снова.");
        else if (result.reason === "https") setError(HTTPS_REQUIRED);
        else if (result.reason === "server") setError(SERVER_DOWN);
      })
      .catch(() => {
        if (cancelled) return;
        clearAdminSession();
        setError(NO_CONNECTION);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onUnauthorized = () => logout("Сессия истекла. Войдите снова.");
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [logout]);

  const login = async (rawPassword) => {
    const password = String(rawPassword || "").trim();
    if (!password) {
      setError("Введите пароль");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await verifyPassword(password);
      if (!result.ok) {
        if (result.reason === "bad_password") setError("Неверный пароль. Проверьте регистр букв и раскладку.");
        else if (result.reason === "https") setError(HTTPS_REQUIRED);
        else if (result.reason === "rate_limited") setError("Слишком много попыток. Подождите минуту.");
        else setError(SERVER_DOWN);
        return;
      }
      saveAdminSession(password);
      setAuthed(true);
    } catch {
      setError(NO_CONNECTION);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {authed ? (
        <Dashboard onLogout={() => logout()} />
      ) : (
        <LoginView busy={busy} error={error} insecure={!SECURE_CONNECTION} onSubmit={login} />
      )}
      <DialogHost />
    </>
  );
}
