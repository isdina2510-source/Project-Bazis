import { useEffect, useRef } from "react";
import { useI18n } from "../i18n/I18nProvider.jsx";
import { useStore } from "../store/StoreContext.jsx";
import { ContactPanel } from "./ContactSection.jsx";

export default function ContactModal() {
  const { contactOpen, closeContact } = useStore();
  const { t } = useI18n();
  const panelRef = useRef(null);

  useEffect(() => {
    if (!contactOpen) return undefined;
    panelRef.current?.focus();
    const onKey = (event) => {
      if (event.key === "Escape") closeContact();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [contactOpen, closeContact]);

  return (
    <div
      className={"contact-modal" + (contactOpen ? " is-open" : "")}
      aria-hidden={contactOpen ? "false" : "true"}
      inert={!contactOpen}
    >
      <div className="contact-modal-backdrop" onClick={closeContact} />
      <div
        ref={panelRef}
        className="contact-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="contact-modal-title"
        tabIndex={-1}
      >
        <button type="button" className="contact-modal-close" onClick={closeContact} aria-label={t("common.close")}>
          ×
        </button>
        <ContactPanel headingId="contact-modal-title" />
      </div>
    </div>
  );
}
