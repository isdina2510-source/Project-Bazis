import { Link } from "react-router-dom";
import { useI18n } from "../i18n/I18nProvider.jsx";
import { categoryText } from "../lib/catalog.js";
import { SIBLING_ID, siteUrl } from "../site.js";
import ResponsiveImage from "./ResponsiveImage.jsx";

export const DIRECTION_IMAGES = {
  management: "/images/directions/management.jpg",
  infrastructure: "/images/directions/infrastructure.jpg",
  media: "/images/directions/media.jpg",
};

const CARD_WIDTHS = [360, 480, 768, 1080];

/** Карточка раздела магазина: фото, описание и ссылка на раздел. */
export default function DirectionCard({ category }) {
  const { lang, t, to } = useI18n();
  const title = categoryText(category, "title", lang);

  return (
    <article className="product-card direction-card">
      <div className="product-media">
        <ResponsiveImage
          src={DIRECTION_IMAGES[category]}
          alt={title}
          width={1152}
          height={864}
          ratio={4 / 3}
          widths={CARD_WIDTHS}
          sizes="(max-width: 900px) calc(100vw - 2.4rem), (max-width: 1000px) 45vw, 340px"
        />
      </div>
      <div className="product-body">
        <p className="product-category">{categoryText(category, "eyebrow", lang)}</p>
        <h3>{title}</h3>
        <p>{categoryText(category, "lead", lang)}</p>
        <div className="product-actions direction-card-actions">
          <Link className="btn btn-ghost" to={to("/shop#" + category)}>
            {t("product.to_shop")}
          </Link>
        </div>
      </div>
    </article>
  );
}

/** Карточка-ссылка на второй сайт: визуал и медиа теперь живут отдельно. */
export function SiblingSiteCard() {
  const { lang, t } = useI18n();
  const url = SIBLING_ID ? siteUrl(SIBLING_ID) : "";
  if (!url) return null;
  const title = t("home.sibling.title");

  return (
    <article className="product-card direction-card sibling-card">
      <div className="product-media">
        <ResponsiveImage
          src={DIRECTION_IMAGES.media}
          alt={title}
          width={1152}
          height={864}
          ratio={4 / 3}
          widths={CARD_WIDTHS}
          sizes="(max-width: 900px) calc(100vw - 2.4rem), (max-width: 1000px) 45vw, 340px"
        />
      </div>
      <div className="product-body">
        <p className="product-category">{t("home.sibling.eyebrow")}</p>
        <h3>{title}</h3>
        <p>{t("home.sibling.lead")}</p>
        <div className="product-actions direction-card-actions">
          <a className="btn btn-primary" href={url + "/" + lang + "/"}>
            {t("home.sibling.cta")}
          </a>
        </div>
      </div>
    </article>
  );
}
