import { useCallback, useEffect, useState } from "react";
import {
  UNAUTHORIZED_EVENT,
  adminLogin,
  adminLogout,
  checkAdminSession,
  clearAdminSession,
} from "../lib/api.js";
import AdminErrorBoundary from "./AdminErrorBoundary.jsx";
import Dashboard from "./Dashboard.jsx";
import { DialogHost, closeDialogs } from "./dialogs.jsx";
import LoginView from "./LoginView.jsx";

const SERVER_DOWN = "Сервер не ответил. Запустите start-site.bat";
const NO_CONNECTION = "Нет связи с сервером. Запустите start-site.bat";
const HTTPS_REQUIRED = "Админка открыта без HTTPS — пароль не отправлен. Откройте её по адресу https://…";

/** HTTPS или этот компьютер (localhost): иначе пароль в теле запроса может перехватить любой в сети. */
const SECURE_CONNECTION = typeof window === "undefined" || window.isSecureContext !== false;

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
  const [bootstrapped, setBootstrapped] = useState(false);

  const logout = useCallback((message = "") => {
    closeDialogs();
    clearAdminSession();
    setAuthed(false);
    setError(message);
    void adminLogout();
  }, []);

  // Восстановление: cookie HttpOnly — проверяем на сервере, пароль из JS не читаем.
  useEffect(() => {
    let cancelled = false;
    if (!SECURE_CONNECTION) {
      clearAdminSession();
      setBootstrapped(true);
      return;
    }
    setBusy(true);
    checkAdminSession()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setAuthed(true);
          return;
        }
        if (result.reason === "https") setError(HTTPS_REQUIRED);
        else if (result.reason === "server") setError(SERVER_DOWN);
      })
      .catch(() => {
        if (!cancelled) setError(NO_CONNECTION);
      })
      .finally(() => {
        if (!cancelled) {
          setBusy(false);
          setBootstrapped(true);
        }
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
    if (!SECURE_CONNECTION) {
      setError(HTTPS_REQUIRED);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await adminLogin(password);
      if (!result.ok) {
        if (result.reason === "bad_password") setError("Неверный пароль. Проверьте регистр букв и раскладку.");
        else if (result.reason === "https") setError(HTTPS_REQUIRED);
        else if (result.reason === "rate_limited") setError("Слишком много попыток. Подождите минуту.");
        else setError(SERVER_DOWN);
        return;
      }
      setAuthed(true);
    } catch {
      setError(NO_CONNECTION);
    } finally {
      setBusy(false);
    }
  };

  if (!bootstrapped && busy) {
    return (
      <>
        <LoginView busy error="" insecure={!SECURE_CONNECTION} onSubmit={() => {}} />
        <DialogHost />
      </>
    );
  }

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
