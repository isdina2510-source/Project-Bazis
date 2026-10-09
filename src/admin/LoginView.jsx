import { useEffect, useRef, useState } from "react";

export default function LoginView({ busy, error, insecure = false, onSubmit }) {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const inputRef = useRef(null);
  const trackCapsLock = (event) => setCapsLock(!!event.getModifierState?.("CapsLock"));

  useEffect(() => {
    if (error && !busy) inputRef.current?.focus();
  }, [error, busy]);

  const toggleLabel = showPassword ? "Скрыть пароль" : "Показать пароль";

  return (
    <div className="admin-login">
      <form
        className="admin-login-card"
        method="post"
        autoComplete="on"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) onSubmit(password);
        }}
      >
        <p className="admin-badge">Admin</p>
        <h1>Вход в админку</h1>
        <p className="admin-login-lead">CRM заказов, клиентов и каталог магазина</p>
        {insecure && (
          <p className="admin-error" role="alert">
            Соединение не защищено (нет HTTPS). Вход отключён, чтобы пароль не перехватили.
          </p>
        )}

        <label className="password-label" htmlFor="admin-password">
          Пароль
        </label>
        <div className="password-field">
          <input
            ref={inputRef}
            id="admin-password"
            type={showPassword ? "text" : "password"}
            name="password"
            autoComplete="current-password"
            placeholder="Введите пароль"
            required
            minLength={1}
            disabled={busy}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={trackCapsLock}
            onKeyUp={trackCapsLock}
            onBlur={() => setCapsLock(false)}
            aria-describedby="admin-password-hint"
          />
          <button
            type="button"
            className="password-toggle"
            aria-label={toggleLabel}
            aria-pressed={showPassword}
            title={toggleLabel}
            onClick={() => setShowPassword((v) => !v)}
          >
            {showPassword ? "🙈" : "👁"}
          </button>
        </div>
        <p id="admin-password-hint" className="admin-login-hint" aria-live="polite">
          {capsLock ? "Включён Caps Lock — регистр букв в пароле важен." : "Регистр букв учитывается."}
        </p>

        <button type="submit" className="admin-login-btn" disabled={busy || insecure}>
          {busy ? "Проверяем…" : "Войти"}
        </button>
        <p className="admin-error" role="alert" hidden={!error}>
          {error}
        </p>
        <a className="admin-back" href="/">
          ← На сайт
        </a>
      </form>
    </div>
  );
}
