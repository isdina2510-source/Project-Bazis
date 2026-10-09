import { useI18n } from "../i18n/I18nProvider.jsx";
import { categoryText, formatFromPrice } from "../lib/catalog.js";
import { CHIP_LABELS, getCatalogGroups } from "./consult.js";

function cheapest(items) {
  return items.slice().sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0))[0];
}

/** Короткая подпись кнопки: перевод названия, иначе сокращение из CHIP_LABELS (только ru). */
function chipLabel(product, lang) {
  if (lang !== "ru" && product.title_kk) return product.title_kk;
  return CHIP_LABELS[product.title] || product.title;
}

function BackButton({ wide, onBack }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={"chat-quick-back" + (wide ? " chat-quick-back-wide" : "")}
      onClick={onBack}
      aria-label={t("chat.quick.back_label")}
    >
      {t("chat.quick.back")}
    </button>
  );
}

function ServiceRow({ group, onAsk }) {
  const { lang, t, field } = useI18n();
  return (
    <div className="chat-quick-row">
      {group.items.map((product) => (
        <button
          key={product.id}
          type="button"
          className="chat-quick-service"
          onClick={() => onAsk(t("chat.quick.ask_product", { title: field(product, "title") }))}
        >
          <strong>{chipLabel(product, lang)}</strong>
          <span>{formatFromPrice(product.price, product.currency, lang)}</span>
        </button>
      ))}
    </div>
  );
}

function ContactButton({ onAsk }) {
  const { t } = useI18n();
  return (
    <button type="button" className="is-accent chat-quick-contact" onClick={() => onAsk(t("chat.quick.ask_contact"))}>
      {t("chat.quick.contact")}
    </button>
  );
}

/** Быстрые кнопки под чатом: разделы → услуги раздела → «Связаться». */
export default function ChatQuick({ products, sectionId, afterConsult, onSection, onBack, onAsk, style }) {
  const { lang, t } = useI18n();
  const groups = getCatalogGroups(products);
  const active = groups.find((group) => group.id === sectionId);
  const groupTitle = (group) => categoryText(group.id, "title", lang);

  let content;
  if (afterConsult) {
    content = (
      <>
        <BackButton wide onBack={onBack} />
        <p className="chat-quick-label">{active ? groupTitle(active) : t("chat.quick.sections")}</p>
        {active && <ServiceRow group={active} onAsk={onAsk} />}
        <ContactButton onAsk={onAsk} />
      </>
    );
  } else if (active) {
    content = (
      <>
        <div className="chat-quick-head">
          <BackButton onBack={onBack} />
          <p className="chat-quick-label">{groupTitle(active)}</p>
        </div>
        <ServiceRow group={active} onAsk={onAsk} />
        <ContactButton onAsk={onAsk} />
      </>
    );
  } else {
    content = (
      <>
        <p className="chat-quick-label">{t("chat.quick.sections")}</p>
        <div className="chat-quick-sections">
          {groups.map((group) => {
            const low = group.items.length ? cheapest(group.items) : null;
            const count = t("chat.quick.service_count", { count: group.items.length });
            return (
              <button key={group.id} type="button" className="chat-quick-section" onClick={() => onSection(group.id)}>
                <strong>{groupTitle(group)}</strong>
                <span>{low ? count + " · " + formatFromPrice(low.price, low.currency, lang) : count}</span>
              </button>
            );
          })}
        </div>
        <button type="button" className="chat-quick-price" onClick={() => onAsk(t("chat.quick.ask_all_prices"))}>
          {t("chat.quick.all_prices")}
        </button>
        <ContactButton onAsk={onAsk} />
      </>
    );
  }

  return (
    <div className="chat-quick" aria-label={t("shop.catalog.categories_label")} style={style}>
      {content}
    </div>
  );
}
