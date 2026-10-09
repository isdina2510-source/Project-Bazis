import { useRef, useState } from "react";
import { useI18n } from "../i18n/I18nProvider.jsx";
import { newOrderId, submitPublicOrder } from "../lib/orders-db.js";
import { warmOrderProof } from "../lib/order-proof.js";
import { CATEGORIES, CONTACT_PHONE, categoryText, getTelegramProfileUrl } from "../lib/catalog.js";
import { formatPhoneDisplay, isValidPhone } from "../lib/phone.js";
import { SITE_ID } from "../site.js";

/**
 * «+7 (777) 123-45-67» по мере ввода. Номер в Казахстане сам начинается с 7, поэтому первая 7 —
 * это код страны, только если поле уже начинается с «+» или цифр больше десяти; ведущая 8 — всегда префикс.
 */
function maskPhone(raw) {
  const value = String(raw || "").trim();
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("8") || (value.startsWith("+") && digits.startsWith("7"))) digits = digits.slice(1);
  if (digits.length > 10 && (digits.startsWith("7") || digits.startsWith("8"))) digits = digits.slice(1);
  digits = digits.slice(0, 10);
  if (!digits) return "";
  let out = "+7 (" + digits.slice(0, 3);
  if (digits.length >= 3) out += ")";
  if (digits.length > 3) out += " " + digits.slice(3, 6);
  if (digits.length > 6) out += "-" + digits.slice(6, 8);
  if (digits.length > 8) out += "-" + digits.slice(8, 10);
  return out;
}

function Icon({ name }) {
  const paths = {
    whatsapp: (
      <path d="M3 21l1.65-4.5A8.5 8.5 0 1 1 8 19.6L3 21zm6-12.5c0 3.5 3 6.5 6.5 6.5l1.5-1.5-2-1-1 1c-1.5-.5-2.5-1.5-3-3l1-1-1-2L9 8.5z" />
    ),
    telegram: <path d="M21.5 4.5L2.5 11.8l5.6 2 2 6.2 3.2-3.6 5.3 3.9 2.9-15.8zM8.1 13.8l9.4-6.3-7.4 7.5" />,
    phone: (
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z" />
    ),
  };
  return (
    <svg
      className="contact-link-icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

const EMPTY_FORM = { name: "", phone: "", direction: "", comment: "" };

export default function ContactSection() {
  return (
    <section id="contact" className="section contact">
      <ContactPanel />
    </section>
  );
}

/** Контакты и форма заявки: блок на главной и окно «Контакт». */
export function ContactPanel({ headingId }) {
  const { t, lang } = useI18n();
  const [form, setForm] = useState(EMPTY_FORM);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  /** { key, id }: повтор той же заявки после сбоя сети не создаст дубль в CRM. */
  const pendingRef = useRef(null);
  const trapRef = useRef(null);
  /** Антиспам-токен считается в фоне, пока посетитель заполняет форму. */
  const warm = () => warmOrderProof().catch(() => {});

  const set = (field) => (event) => setForm((prev) => ({ ...prev, [field]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    const name = form.name.trim();
    if (name.length < 2) {
      setError(t("contact.form.error_name"));
      return;
    }
    if (!isValidPhone(form.phone)) {
      setError(t("contact.form.error_phone"));
      return;
    }
    setError("");
    setStatus("sending");

    const directionTitle = form.direction ? categoryText(form.direction, "title", "ru") : "";
    const message = [
      "Заявка с формы на сайте", // i18n-ignore: текст для CRM
      directionTitle && "Направление: " + directionTitle, // i18n-ignore: текст для CRM
      form.comment.trim() && "Комментарий: " + form.comment.trim(), // i18n-ignore: текст для CRM
    ]
      .filter(Boolean)
      .join("\n");

    const key = JSON.stringify([name, form.phone, form.direction, form.comment.trim()]);
    if (!pendingRef.current || pendingRef.current.key !== key) pendingRef.current = { key, id: newOrderId() };

    try {
      await submitPublicOrder({
        id: pendingRef.current.id,
        channel: "site",
        customerName: name,
        customerPhone: form.phone,
        message,
        lead: { direction: form.direction, comment: form.comment.trim() },
        sourcePage: window.location.pathname,
        site: SITE_ID,
        website: trapRef.current ? trapRef.current.value : "",
      });
      pendingRef.current = null;
      setStatus("sent");
      setForm(EMPTY_FORM);
    } catch (err) {
      setStatus("idle");
      const code = err && err.code;
      setError(
        code === "rate_limited" || code === "busy" ? t("contact.form.error_limited") : t("contact.form.error_send")
      );
    }
  };

  return (
    <div className="contact-grid">
      <div className="contact-info">
        <p className="eyebrow contact-eyebrow">{t("contact.section_eyebrow")}</p>
        <h2 id={headingId}>{t("contact.section_title")}</h2>
        <p className="contact-text">{t("contact.section_text")}</p>
        <a className="contact-phone" href={"tel:+" + CONTACT_PHONE}>
          {formatPhoneDisplay(CONTACT_PHONE)}
        </a>
        <div className="contact-links">
          <a className="contact-link" href={"https://wa.me/" + CONTACT_PHONE} target="_blank" rel="noopener noreferrer">
            <Icon name="whatsapp" />
            WhatsApp
          </a>
          <a className="contact-link" href={getTelegramProfileUrl()} target="_blank" rel="noopener noreferrer">
            <Icon name="telegram" />
            Telegram
          </a>
          <a className="contact-link" href={"tel:+" + CONTACT_PHONE}>
            <Icon name="phone" />
            {t("contact.call")}
          </a>
        </div>
      </div>

      <div className="contact-form-wrap">
        {status === "sent" ? (
          <div className="contact-sent" role="status">
            <h3>{t("contact.form.sent_title")}</h3>
            <p>{t("contact.form.sent_text")}</p>
            <button type="button" className="btn btn-ghost" onClick={() => setStatus("idle")}>
              {t("contact.form.again")}
            </button>
          </div>
        ) : (
          <form className="contact-form" onSubmit={submit} onFocus={warm} noValidate>
            {/* Ловушка для ботов: люди это поле не видят и не заполняют. */}
            <input ref={trapRef} className="form-trap" type="text" name="hp_note" tabIndex={-1} autoComplete="off" aria-hidden="true" />
            <div className="contact-form-row">
              <label className="contact-field">
                <span>{t("contact.form.name")} *</span>
                <input
                  type="text"
                  name="name"
                  autoComplete="name"
                  maxLength={120}
                  required
                  placeholder={t("contact.form.name_placeholder")}
                  value={form.name}
                  onChange={set("name")}
                />
              </label>
              <label className="contact-field">
                <span>{t("contact.form.phone")} *</span>
                <input
                  type="tel"
                  name="phone"
                  autoComplete="tel"
                  inputMode="tel"
                  required
                  placeholder="+7 (___) ___-__-__"
                  value={form.phone}
                  onChange={(event) => setForm((prev) => ({ ...prev, phone: maskPhone(event.target.value) }))}
                />
              </label>
            </div>

            <fieldset className="contact-field contact-chips">
              <legend>{t("contact.form.direction")}</legend>
              <div className="contact-chip-list">
                {CATEGORIES.map((category) => {
                  const active = form.direction === category.id;
                  return (
                    <button
                      type="button"
                      key={category.id}
                      className={"contact-chip" + (active ? " is-active" : "")}
                      aria-pressed={active}
                      onClick={() =>
                        setForm((prev) => ({ ...prev, direction: active ? "" : category.id }))
                      }
                    >
                      {categoryText(category.id, "title", lang)}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <label className="contact-field">
              <span>{t("contact.form.comment")}</span>
              <textarea
                name="comment"
                rows={3}
                maxLength={2000}
                placeholder={t("contact.form.comment_placeholder")}
                value={form.comment}
                onChange={set("comment")}
              />
            </label>

            {error ? (
              <p className="contact-error" role="alert">
                {error}
              </p>
            ) : null}

            <div className="contact-submit">
              <button type="submit" className="btn btn-primary contact-submit-btn" disabled={status === "sending"}>
                {status === "sending" ? t("contact.form.sending") : t("contact.form.submit")}
                <span aria-hidden="true">→</span>
              </button>
              <p className="contact-consent">{t("contact.form.consent")}</p>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
