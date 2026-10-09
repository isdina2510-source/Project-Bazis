import { useEffect, useRef, useState } from "react";
import { getChannels, sendPdf } from "./documents-api.js";

const CHANNEL_LABELS = { email: "E-mail", telegram: "Telegram (рабочий чат)" };

/**
 * Отправка PDF по e-mail или в рабочий чат Telegram.
 * target — { type: "document", id } или { type: "catalog", ids, showPrices, showStock }.
 */
export default function SendDialog({ title, target, defaultEmail = "", onClose, onSent }) {
  const [channels, setChannels] = useState(null);
  const [channel, setChannel] = useState("email");
  const [to, setTo] = useState(defaultEmail);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState("");
  const firstRef = useRef(null);

  useEffect(() => {
    let alive = true;
    getChannels()
      .then((value) => {
        if (!alive) return;
        setChannels(value);
        if (!value.email && value.telegram) setChannel("telegram");
      })
      .catch((err) => {
        if (alive && err.code !== "unauthorized") setError(err.message);
      });
    return () => {
      alive = false;
    };
  }, []);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("modal-open");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("modal-open");
    };
  }, []);

  useEffect(() => {
    firstRef.current?.focus();
  }, [channels]);

  const available = channels ? Object.keys(CHANNEL_LABELS).filter((key) => channels[key]) : [];

  const submit = async (event) => {
    event.preventDefault();
    if (sending) return;
    setError("");
    if (channel === "email" && !to.trim()) {
      setError("Укажите адрес e-mail получателя.");
      return;
    }
    setSending(true);
    try {
      const result = await sendPdf({ target, channel, to: to.trim(), comment: comment.trim() });
      setDone(channel === "email" ? "Отправлено на " + result.recipient : "Отправлено в Telegram");
      if (onSent) onSent();
    } catch (err) {
      if (err.code !== "unauthorized") setError(err.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="product-modal">
      <div className="product-modal-backdrop" onClick={onClose} />
      <div className="product-modal-panel" role="dialog" aria-modal="true" aria-labelledby="send-dialog-title">
        <header className="product-modal-head">
          <h2 id="send-dialog-title">Отправить: {title}</h2>
          <button type="button" className="product-modal-close" onClick={onClose} aria-label="Закрыть">
            ×
          </button>
        </header>
        {done ? (
          <div className="dash-form modal-form">
            <p className="doc-success" role="status">
              {done}
            </p>
            <div className="dash-form-actions">
              <button type="button" className="dash-btn dash-btn-fill" onClick={onClose}>
                Готово
              </button>
            </div>
          </div>
        ) : (
          <form className="dash-form modal-form" onSubmit={submit}>
            {channels && !available.length ? (
              <p className="admin-hint">
                Отправка не настроена. Задайте на сервере в файле .env параметры SMTP (SMTP_HOST, SMTP_FROM и др.) для
                e-mail или TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID для Telegram и перезапустите сайт.
              </p>
            ) : null}
            {available.length > 1 && (
              <label>
                Куда
                <select ref={firstRef} value={channel} onChange={(event) => setChannel(event.target.value)}>
                  {available.map((key) => (
                    <option key={key} value={key}>
                      {CHANNEL_LABELS[key]}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {available.length === 1 && <p className="admin-hint">Канал: {CHANNEL_LABELS[available[0]]}</p>}
            {channel === "email" && available.includes("email") && (
              <label>
                E-mail получателя
                <input
                  ref={available.length > 1 ? undefined : firstRef}
                  type="email"
                  maxLength={120}
                  placeholder="client@example.kz"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                />
              </label>
            )}
            {available.length > 0 && (
              <label>
                {channel === "email" ? "Текст письма" : "Подпись к файлу"}
                <textarea
                  rows={3}
                  maxLength={1000}
                  placeholder={channel === "email" ? "Здравствуйте! Документ во вложении." : "Комментарий для команды"}
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                />
              </label>
            )}
            {error && (
              <p className="form-inline-error admin-error" role="alert">
                {error}
              </p>
            )}
            <div className="dash-form-actions">
              <button type="submit" className="dash-btn dash-btn-fill" disabled={sending || !available.length}>
                {sending ? "Отправляем…" : "Отправить"}
              </button>
              <button type="button" className="dash-btn" onClick={onClose}>
                Отмена
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
