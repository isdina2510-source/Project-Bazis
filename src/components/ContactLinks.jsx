import { CONTACT_PHONE, getTelegramProfileUrl } from "../lib/catalog.js";
import { t } from "../i18n/index.js";

/** WhatsApp и Telegram менеджера — когда сайт не может показать каталог или упал. */
export default function ContactLinks({ lang }) {
  return (
    <div className="hero-actions">
      <a className="btn btn-primary" href={"https://wa.me/" + CONTACT_PHONE} target="_blank" rel="noopener noreferrer">
        {t("errors.contacts.whatsapp", undefined, lang)}
      </a>
      <a className="btn btn-ghost" href={getTelegramProfileUrl()} target="_blank" rel="noopener noreferrer">
        {t("errors.contacts.telegram", undefined, lang)}
      </a>
    </div>
  );
}
