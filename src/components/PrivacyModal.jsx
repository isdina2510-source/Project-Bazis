import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/I18nProvider.jsx";
import { CONTACT_PHONE } from "../lib/catalog.js";
import { formatPhoneDisplay } from "../lib/phone.js";
import { setScrollLocked } from "../lib/smooth-scroll.js";

const SECTIONS = ["collect", "purpose", "storage", "term", "rights", "consent"];
const TITLES = {
  collect: "privacy.collect_title",
  purpose: "privacy.purpose_title",
  storage: "privacy.storage_title",
  term: "privacy.term_title",
  rights: "privacy.rights_title",
  consent: "privacy.consent_title",
};
const TEXTS = {
  collect: "privacy.collect_text",
  purpose: "privacy.purpose_text",
  storage: "privacy.storage_text",
  term: "privacy.term_text",
  rights: "privacy.rights_text",
  consent: "privacy.consent_text",
};

/** Политика конфиденциальности поверх страницы или окна «Контакт» (в портале: у панели окна есть transform). */
export default function PrivacyModal({ onClose }) {
  const { t } = useI18n();
  const panelRef = useRef(null);

  useEffect(() => {
    const returnFocus = document.activeElement;
    panelRef.current?.focus();
    setScrollLocked(true);
    // Перехват на window до слушателя окна «Контакт»: Escape закрывает только политику.
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (!document.body.classList.contains("contact-open")) setScrollLocked(false);
      if (returnFocus && typeof returnFocus.focus === "function") returnFocus.focus();
    };
  }, [onClose]);

  return createPortal(
    <div className="privacy-modal">
      <div className="privacy-modal-backdrop" onClick={onClose} />
      <div
        ref={panelRef}
        className="privacy-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="privacy-modal-title"
        tabIndex={-1}
        data-lenis-prevent=""
      >
        <button type="button" className="privacy-modal-close" onClick={onClose} aria-label={t("common.close")}>
          ×
        </button>
        <h2 id="privacy-modal-title">{t("privacy.title")}</h2>
        <p>{t("privacy.intro")}</p>
        {SECTIONS.map((id) => (
          <section key={id}>
            <h3>{t(TITLES[id])}</h3>
            <p>{t(TEXTS[id], { phone: formatPhoneDisplay(CONTACT_PHONE) })}</p>
          </section>
        ))}
      </div>
    </div>,
    document.body
  );
}
