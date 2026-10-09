import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../i18n/I18nProvider.jsx";
import {
  categoryText,
  formatFromPrice,
  isDiscussOnlyProduct,
  isLowStock,
  isOutOfStock,
  productText,
} from "../lib/catalog.js";
import { getWhatsAppConsultationUrl } from "../lib/messages.js";
import { useStore } from "../store/StoreContext.jsx";
import ResponsiveImage from "./ResponsiveImage.jsx";

const CARD_WIDTHS = [360, 480, 768, 1080];

/** showCategory / showShopLink — варианты для главной страницы. */
export default function ProductCard({ product, showCategory = false, showShopLink = false }) {
  const { addToCart } = useStore();
  const { lang, t, to } = useI18n();
  const title = productText(product, "title", lang);
  // Счётчик кликов: каждый клик перезапускает таймер «Добавлено», 0 — исходная надпись.
  const [addedTick, setAddedTick] = useState(0);
  const added = addedTick > 0;
  const discussOnly = isDiscussOnlyProduct(product);
  const soldOut = !discussOnly && isOutOfStock(product);

  useEffect(() => {
    if (!addedTick) return undefined;
    const timer = setTimeout(() => setAddedTick(0), 900);
    return () => clearTimeout(timer);
  }, [addedTick]);

  const onAdd = () => {
    addToCart(product.id, 1);
    setAddedTick((tick) => tick + 1);
  };

  return (
    <article className="product-card">
      <div className="product-media">
        <ResponsiveImage
          src={product.image}
          alt={title}
          width={800}
          height={600}
          ratio={4 / 3}
          widths={CARD_WIDTHS}
          sizes="(max-width: 900px) calc(100vw - 2.4rem), (max-width: 1000px) 45vw, 340px"
        />
      </div>
      <div className="product-body">
        {showCategory && <p className="product-category">{categoryText(product.category, "title", lang)}</p>}
        <h3>{title}</h3>
        <p>{productText(product, "description", lang)}</p>
        <p className="product-price">{formatFromPrice(product.price, product.currency, lang)}</p>
        {!discussOnly && isLowStock(product) && (
          <p className="stock-note">{t("product.stock_left", { count: product.stock })}</p>
        )}
        <div className="product-actions">
          {discussOnly ? (
            <a
              className="btn btn-primary"
              href={getWhatsAppConsultationUrl(product)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("product.discuss")}
            </a>
          ) : (
            <>
              {soldOut ? (
                <button type="button" className="btn btn-primary is-disabled" disabled>
                  {t("product.out_of_stock")}
                </button>
              ) : (
                <button type="button" className="btn btn-primary" onClick={onAdd}>
                  {added ? t("product.added") : t("product.add")}
                </button>
              )}
              {showShopLink && (
                <Link className="btn btn-ghost" to={to("/shop#" + (product.category || "all"))}>
                  {t("product.to_shop")}
                </Link>
              )}
            </>
          )}
        </div>
      </div>
    </article>
  );
}
