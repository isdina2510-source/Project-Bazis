import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * Уведомления и подтверждения админки вместо window.alert / window.confirm:
 * не блокируют страницу и выглядят как остальные окна. Вызываются из любого модуля,
 * показывает их <DialogHost />, подключённый один раз в корне админки.
 */

const NOTICE_MS = 6000;
const MAX_NOTICES = 4;

let state = { notices: [], confirm: null };
let seq = 0;
const listeners = new Set();

function setState(next) {
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => state;

function dismissNotice(id) {
  setState({ ...state, notices: state.notices.filter((notice) => notice.id !== id) });
}

/**
 * Короткое сообщение в углу экрана; ошибки висят дольше и озвучиваются экранным диктором сразу.
 * @param {string} message
 * @param {{ tone?: "error" | "success" | "info" }} [options]
 */
export function notify(message, { tone = "error" } = {}) {
  const text = String(message || "").trim();
  if (!text) return;
  const id = ++seq;
  const notices = state.notices.filter((notice) => notice.text !== text).slice(-(MAX_NOTICES - 1));
  setState({ ...state, notices: [...notices, { id, text, tone }] });
  setTimeout(() => dismissNotice(id), tone === "error" ? NOTICE_MS * 1.5 : NOTICE_MS);
}

/**
 * Подтверждение действия. Если окно уже открыто, прежнее считается отменённым.
 * @param {string} message
 * @param {{ title?: string, confirmLabel?: string, danger?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export function confirmAction(message, { title = "Подтвердите действие", confirmLabel = "Да", danger = false } = {}) {
  if (state.confirm) state.confirm.resolve(false);
  return new Promise((resolve) => {
    const id = ++seq;
    const settle = (value) => {
      if (!state.confirm || state.confirm.id !== id) return;
      setState({ ...state, confirm: null });
      resolve(value);
    };
    setState({ ...state, confirm: { id, title, message: String(message || ""), confirmLabel, danger, resolve: settle } });
  });
}

/** Закрыть всё (выход из админки): открытое подтверждение считается отменённым. */
export function closeDialogs() {
  if (state.confirm) state.confirm.resolve(false);
  setState({ notices: [], confirm: null });
}

function ConfirmDialog({ dialog }) {
  const confirmRef = useRef(null);
  const cancelRef = useRef(null);
  const resolveRef = useRef(dialog.resolve);
  resolveRef.current = dialog.resolve;

  useEffect(() => {
    const previousFocus = document.activeElement;
    // Для удаления фокус на «Отмена»: случайный Enter ничего не удалит.
    (dialog.danger ? cancelRef : confirmRef).current?.focus();
    const onKey = (event) => {
      if (event.key === "Escape") resolveRef.current(false);
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("modal-open");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("modal-open");
      if (previousFocus && typeof previousFocus.focus === "function") previousFocus.focus();
    };
  }, []);

  return (
    <div className="product-modal confirm-dialog">
      <div className="product-modal-backdrop" onClick={() => dialog.resolve(false)} />
      <div
        className="product-modal-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-text"
      >
        <header className="product-modal-head">
          <h2 id="confirm-dialog-title">{dialog.title}</h2>
        </header>
        <p id="confirm-dialog-text" className="confirm-dialog-text">
          {dialog.message}
        </p>
        <div className="dash-form-actions">
          <button
            ref={confirmRef}
            type="button"
            className={"dash-btn " + (dialog.danger ? "crm-btn-danger" : "dash-btn-fill")}
            onClick={() => dialog.resolve(true)}
          >
            {dialog.confirmLabel}
          </button>
          <button ref={cancelRef} type="button" className="dash-btn" onClick={() => dialog.resolve(false)}>
            Отмена
          </button>
        </div>
      </div>
    </div>
  );
}

function Notice({ notice }) {
  return (
    <div className={"admin-notice admin-notice-" + notice.tone}>
      <p>{notice.text}</p>
      <button
        type="button"
        className="admin-notice-close"
        aria-label="Закрыть уведомление"
        onClick={() => dismissNotice(notice.id)}
      >
        ×
      </button>
    </div>
  );
}

export function DialogHost() {
  const { notices, confirm } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const errors = notices.filter((notice) => notice.tone === "error");
  const others = notices.filter((notice) => notice.tone !== "error");
  return (
    <>
      <div className="admin-notices">
        <div role="alert" aria-live="assertive">
          {errors.map((notice) => (
            <Notice key={notice.id} notice={notice} />
          ))}
        </div>
        <div role="status" aria-live="polite">
          {others.map((notice) => (
            <Notice key={notice.id} notice={notice} />
          ))}
        </div>
      </div>
      {confirm ? <ConfirmDialog key={confirm.id} dialog={confirm} /> : null}
    </>
  );
}
