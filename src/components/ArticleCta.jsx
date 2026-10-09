import { Link } from "react-router-dom";
import { useI18n } from "../i18n/I18nProvider.jsx";
import { formatFromPrice, productText } from "../lib/catalog.js";
import { buildArticleMessage, whatsappUrl } from "../lib/messages.js";
import { useStore } from "../store/StoreContext.jsx";

/** Призыв после статьи или теста: услуга из каталога, WhatsApp с контекстом и ссылка в магазин. */
export default function ArticleCta({ eyebrow, title, text, productId, articleTitle, quiz }) {
  const { products } = useStore();
  const { lang, t, to } = useI18n();
  const product = products.find((item) => item.id === productId) || null;
  const message = buildArticleMessage({ title: articleTitle, quiz, product }, lang);

  return (
    <aside className="article-cta">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h2>{title || (product ? productText(product, "title", lang) : "")}</h2>
      {text && <p>{text}</p>}
      {product && (
        <p className="article-cta-product">
          {productText(product, "title", lang)} — {formatFromPrice(product.price, product.currency, lang)}
        </p>
      )}
      <div className="article-cta-actions">
        <a className="btn btn-primary" href={whatsappUrl(message)} target="_blank" rel="noopener noreferrer">
          {t("articles.cta_discuss")}
        </a>
        <Link className="btn btn-ghost" to={to("/shop#" + (product ? product.category : "all"))}>
          {t("articles.cta_shop")}
        </Link>
      </div>
    </aside>
  );
}
