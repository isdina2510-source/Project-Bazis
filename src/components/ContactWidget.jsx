import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/I18nProvider.jsx";
import { CONTACT_PHONE, getTelegramProfileUrl } from "../lib/catalog.js";
import { buildHandoffMessage, whatsappUrl } from "../lib/messages.js";
import { warmOrderProof } from "../lib/order-proof.js";
import { isValidCustomerName, isValidPhone, maskPhone } from "../lib/phone.js";
import { useStore } from "../store/StoreContext.jsx";
import { getChatLead, useChatSession } from "../chat/chat-session.js";
import { createChatLeadSession, hasClientMessages, sendChatLead, sendContactLead } from "../chat/handoff-lead.js";
import { findPhone } from "../chat/handoff-transcript.js";
import ConsentField from "./ConsentField.jsx";

function WhatsAppIcon({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.16-.17.2-.35.22-.64.08-.3-.15-1.26-.46-2.39-1.48-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.6.13-.14.3-.35.45-.52.15-.18.2-.3.3-.5.1-.2.05-.37-.03-.52-.07-.15-.67-1.61-.92-2.2-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.21 3.07c.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.7.63.71.22 1.36.19 1.87.12.57-.09 1.76-.72 2-1.41.25-.7.25-1.29.18-1.41-.08-.13-.27-.2-.57-.35Zm-5.42 7.4h-.01a9.87 9.87 0 0 1-5.03-1.38l-.36-.21-3.74.98 1-3.65-.24-.37a9.86 9.86 0 0 1-1.51-5.26c0-5.45 4.44-9.88 9.89-9.88 2.64 0 5.12 1.03 6.99 2.9a9.83 9.83 0 0 1 2.89 6.99c0 5.45-4.44 9.88-9.88 9.88Zm8.41-18.3A11.82 11.82 0 0 0 12.05 0C5.5 0 .16 5.34.16 11.89c0 2.1.55 4.14 1.59 5.95L.06 24l6.3-1.65a11.88 11.88 0 0 0 5.68 1.45h.01c6.55 0 11.89-5.34 11.89-11.9 0-3.17-1.24-6.16-3.48-8.41Z" />
    </svg>
  );
}

/**
 * Кнопка связи с менеджером в WhatsApp или Telegram — отдельно от ИИ-чата.
 * Перед переходом просим имя, телефон и согласие — заявка уходит в CRM. Если посетитель уже
 * переписывался с ИИ-консультантом, в заявке его переписка, а в сообщении WhatsApp — номер обращения.
 */
export default function ContactWidget() {
  const { chatOpen, setChatOpen, messengerOpen: open, setMessengerOpen: setOpen } = useStore();
  const { lang, t } = useI18n();
  const session = useChatSession();
  const hasDialog = hasClientMessages(session.history);
  const chatLead = getChatLead();
  /** Заявка без переписки — отдельная, чтобы после разговора с ИИ ушла ещё и заявка с диалогом. */
  const contactLeadRef = useRef(null);
  if (!contactLeadRef.current) contactLeadRef.current = createChatLeadSession();
  const lead = hasDialog ? chatLead : contactLeadRef.current;

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const phonePrefillRef = useRef("");
  const fabRef = useRef(null);
  const nameRef = useRef(null);

  // На телефоне фокус открыл бы клавиатуру, и она закрыла бы панель — фокус только при мыши.
  useEffect(() => {
    const finePointer = !window.matchMedia || window.matchMedia("(pointer: fine)").matches;
    if (open && finePointer) nameRef.current?.focus();
  }, [open]);

  // Две панели в углу экрана перекрыли бы друг друга.
  useEffect(() => {
    if (chatOpen) setOpen(false);
  }, [chatOpen, setOpen]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      fabRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  useEffect(() => {
    if (open && !lead.sent) warmOrderProof().catch(() => {});
  }, [open, lead]);

  useEffect(() => {
    const found = findPhone(session.history);
    if (!found || found === phonePrefillRef.current) return;
    phonePrefillRef.current = found;
    setPhone((prev) => (prev.trim() ? prev : maskPhone(found)));
  }, [session.history]);

  const toggle = () => {
    if (!open) setChatOpen(false);
    setOpen(!open);
  };

  const waHref = whatsappUrl(
    buildHandoffMessage(session.lastUserText, session.lastFileNames, lang, hasDialog ? chatLead.code : ""),
    CONTACT_PHONE
  );

  /** Не мешает переходу по ссылке: заявка уходит в фоне (keepalive). Без имени, телефона и согласия переход блокируем. */
  const recordHandoff = (channel) => (event) => {
    const customerName = name.trim();
    const problem = !isValidCustomerName(customerName)
      ? t("contact_widget.error_name")
      : !isValidPhone(phone)
        ? t("contact_widget.error_phone")
        : !consent
          ? t("contact.form.error_consent")
          : "";
    if (problem) {
      event.preventDefault();
      setError(problem);
      return;
    }
    setError("");
    const contacts = { channel, direction: session.direction, customerName, customerPhone: phone, consent: true };
    if (hasDialog) sendChatLead(lead, { ...contacts, history: session.history });
    else sendContactLead(lead, contacts);
  };

  const clearError = () => {
    if (error) setError("");
  };

  return (
    <div className={"contact-widget" + (open ? " is-open" : "") + (chatOpen ? " is-chat-open" : "")}>
      {open && (
        <div className="contact-widget-panel" role="dialog" aria-label={t("contact_widget.title")}>
          <div className="contact-widget-head">
            <div>
              <strong>{t("contact_widget.title")}</strong>
              <p>{t("contact_widget.subtitle")}</p>
            </div>
            <button type="button" className="contact-widget-x" onClick={() => setOpen(false)} aria-label={t("common.close")}>
              ×
            </button>
          </div>

          <div className="contact-widget-form">
            <p className="contact-widget-hint">{t(hasDialog ? "contact_widget.hint_dialog" : "contact_widget.hint")}</p>
            <label className="contact-widget-field">
              <span>{t("contact_widget.name")} *</span>
              <input
                ref={nameRef}
                type="text"
                name="contact-widget-name"
                autoComplete="name"
                maxLength={120}
                required
                placeholder={t("contact_widget.name_placeholder")}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  clearError();
                }}
              />
            </label>
            <label className="contact-widget-field">
              <span>{t("contact_widget.phone")} *</span>
              <input
                type="tel"
                name="contact-widget-phone"
                autoComplete="tel"
                inputMode="tel"
                required
                placeholder="+7 (___) ___-__-__"
                value={phone}
                onChange={(event) => {
                  setPhone(maskPhone(event.target.value));
                  clearError();
                }}
              />
            </label>
            {error ? (
              <p className="contact-widget-error" role="alert">
                {error}
              </p>
            ) : null}
            <ConsentField
              className="contact-widget-consent"
              checked={consent}
              onChange={(value) => {
                setConsent(value);
                if (value) clearError();
              }}
            />
          </div>

          <div className="contact-widget-links">
            <a
              className="contact-widget-link contact-widget-link-wa"
              href={waHref}
              target="_blank"
              rel="noopener noreferrer"
              onClick={recordHandoff("whatsapp")}
            >
              <WhatsAppIcon size={18} />
              WhatsApp
            </a>
            <a
              className="contact-widget-link contact-widget-link-tg"
              href={getTelegramProfileUrl()}
              target="_blank"
              rel="noopener noreferrer"
              onClick={recordHandoff("telegram")}
            >
              Telegram
            </a>
          </div>
        </div>
      )}

      <button
        ref={fabRef}
        type="button"
        className={"contact-fab" + (session.handoff && !open ? " is-pulse" : "")}
        aria-label={t("contact_widget.open")}
        aria-expanded={open}
        onClick={toggle}
      >
        <WhatsAppIcon />
        <span className="contact-fab-close" aria-hidden="true">
          ×
        </span>
      </button>
    </div>
  );
}
