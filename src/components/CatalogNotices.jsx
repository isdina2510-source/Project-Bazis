import ContactLinks from "./ContactLinks.jsx";

/** Сервер не ответил, копии каталога нет: честно говорим и даём контакты менеджера. */
export function CatalogUnavailable({ lang, t }) {
  return (
    <div className="catalog-unavailable" role="alert">
      <p className="catalog-unavailable-title">{t("shop.catalog.unavailable")}</p>
      <p className="products-empty">{t("shop.catalog.unavailable_hint")}</p>
      <ContactLinks lang={lang} />
    </div>
  );
}

/** Показана сохранённая копия каталога: цены могли измениться. */
export function StaleCatalogNote({ t }) {
  return (
    <p className="catalog-stale-note" role="status">
      {t("shop.catalog.stale")}
    </p>
  );
}
