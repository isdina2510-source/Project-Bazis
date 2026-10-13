import { useLocation, useNavigate } from "react-router-dom";
import ArticleCard from "../components/ArticleCard.jsx";
import BrandText from "../components/BrandText.jsx";
import { sortedArticles } from "../content/articles.js";
import { useI18n } from "../i18n/I18nProvider.jsx";

const FILTERS = ["all", "article", "test"];

/** «Полезные статьи»: статьи и тесты, фильтр по типу в #hash (/articles#test). */
export default function ArticlesPage() {
  const { t } = useI18n();
  const { hash } = useLocation();
  const navigate = useNavigate();
  const fromHash = hash.replace("#", "");
  const active = FILTERS.includes(fromHash) ? fromHash : "all";
  const items = sortedArticles().filter((item) => active === "all" || item.type === active);

  return (
    <main>
      <section className="section shop-hero articles-hero">
        <p className="eyebrow">
          <BrandText>{t("articles.eyebrow")}</BrandText>
        </p>
        <h1>{t("articles.title")}</h1>
        <p className="shop-hero-text">{t("articles.lead")}</p>
      </section>

      <section className="section articles-list">
        <nav className="shop-categories" aria-label={t("articles.filter_label")}>
          {FILTERS.map((id) => (
            <button
              key={id}
              type="button"
              className={"shop-cat" + (id === active ? " is-active" : "")}
              aria-pressed={id === active}
              onClick={() => navigate({ hash: id === "all" ? "" : "#" + id }, { replace: true })}
            >
              {t("articles." + id)}
            </button>
          ))}
        </nav>
        <div className="articles-grid">
          {items.map((article) => (
            <ArticleCard key={article.slug} article={article} />
          ))}
        </div>
      </section>
    </main>
  );
}
