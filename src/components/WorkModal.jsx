import { useEffect, useRef } from "react";
import { useI18n } from "../i18n/I18nProvider.jsx";
import { imageSrc } from "../lib/catalog.js";
import { getPortfolioWhatsAppUrl } from "../lib/messages.js";
import { workTerms, workTitle } from "../lib/portfolio-api.js";
import { setScrollLocked } from "../lib/smooth-scroll.js";

/** Работа из портфолио: видео или фото, условия и «Хочу так же» в WhatsApp. */
export default function WorkModal({ work, onClose }) {
  const { lang, t } = useI18n();
  const panelRef = useRef(null);
  const title = workTitle(work, lang);
  const terms = workTerms(work, lang);

  useEffect(() => {
    panelRef.current?.focus();
    setScrollLocked(true);
    document.documentElement.classList.add("work-modal-open");
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.documentElement.classList.remove("work-modal-open");
      setScrollLocked(false);
    };
  }, [onClose]);

  return (
    <div className="work-modal">
      <div className="work-modal-backdrop" onClick={onClose} />
      <div
        ref={panelRef}
        className="work-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="work-modal-title"
        tabIndex={-1}
        data-lenis-prevent=""
      >
        <button type="button" className="work-modal-close" onClick={onClose} aria-label={t("common.close")}>
          ×
        </button>
        <div className="work-modal-media">
          {work.video ? (
            <video
              src={imageSrc(work.video)}
              poster={work.image ? imageSrc(work.image) : undefined}
              controls
              autoPlay
              playsInline
              preload="metadata"
            />
          ) : (
            <img src={imageSrc(work.image)} alt={title} />
          )}
        </div>
        <div className="work-modal-body">
          <span className="mh-work-kind work-modal-kind">{t("media_home.works." + work.kind)}</span>
          <h2 id="work-modal-title">{title}</h2>
          {terms && (
            <>
              <h3>{t("media_home.works.terms")}</h3>
              <p className="work-modal-terms">{terms}</p>
            </>
          )}
          <a
            className="btn btn-primary"
            href={getPortfolioWhatsAppUrl(title, lang)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("media_home.works.order_similar")}
          </a>
        </div>
      </div>
    </div>
  );
}
