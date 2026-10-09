import { detectLang, isLang, t } from "../i18n/index.js";
import ContactLinks from "./ContactLinks.jsx";

/** Язык из адреса (/kk/…, /ru/…): экран рисуется вне I18nProvider — он мог упасть вместе со страницей. */
function langFromPath() {
  const match = String(typeof location !== "undefined" ? location.pathname : "").match(/^\/([a-z]{2})(?=\/|$)/);
  return match && isLang(match[1]) ? match[1] : detectLang();
}

/** Витрина упала при отрисовке: вместо белого экрана — объяснение, перезагрузка и контакты. */
export default function StoreErrorScreen() {
  const lang = langFromPath();
  return (
    <main className="section error-screen" role="alert" lang={lang}>
      <h1>{t("errors.screen.title", undefined, lang)}</h1>
      <p>{t("errors.screen.text", undefined, lang)}</p>
      <div className="hero-actions">
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          {t("errors.screen.reload", undefined, lang)}
        </button>
      </div>
      <ContactLinks lang={lang} />
    </main>
  );
}
