import { Link } from "react-router-dom";
import { useI18n } from "../i18n/I18nProvider.jsx";
import { localizedField } from "../i18n/index.js";
import { categoryText } from "../lib/catalog.js";
import { DIRECTION_IMAGES } from "./DirectionCard.jsx";
import ResponsiveImage from "./ResponsiveImage.jsx";

const CARD_WIDTHS = [360, 480, 768, 1080];

/** Карточка статьи или теста в списке «Полезные статьи». */
export default function ArticleCard({ article }) {
  const { lang, t, to } = useI18n();
  const isTest = article.type === "test";
  const href = to("/articles/" + article.slug);
  const title = localizedField(article, "title", lang);

  return (
    <article className={"article-card" + (isTest ? " is-test" : "")}>
      <Link className="article-card-media" to={href} tabIndex={-1} aria-hidden="true">
        <ResponsiveImage
          src={article.image || DIRECTION_IMAGES[article.category]}
          alt=""
          width={1152}
          height={864}
          ratio={16 / 9}
          widths={CARD_WIDTHS}
          sizes="(max-width: 900px) calc(100vw - 2.4rem), 340px"
        />
        <span className="article-badge">{t(isTest ? "articles.type_test" : "articles.type_article")}</span>
      </Link>
      <div className="article-card-body">
        <p className="article-meta">
          {categoryText(article.category, "title", lang)}
        </p>
        <h3>
          <Link to={href}>{title}</Link>
        </h3>
        <p>{localizedField(article, "excerpt", lang)}</p>
        <Link className="article-card-link" to={href}>
          {t(isTest ? "articles.take_test" : "articles.read")} →
        </Link>
      </div>
    </article>
  );
}
