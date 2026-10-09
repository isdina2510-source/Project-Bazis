import { useEffect } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import ArticleCard from "../components/ArticleCard.jsx";
import ArticleCta from "../components/ArticleCta.jsx";
import Quiz from "../components/Quiz.jsx";
import { findArticle, sortedArticles } from "../content/articles.js";
import { useI18n } from "../i18n/I18nProvider.jsx";
import { localizedField } from "../i18n/index.js";
import { categoryText } from "../lib/catalog.js";

function Block({ block, lang }) {
  const text = (field) => localizedField(block, field, lang);
  if (block.h2) return <h2>{text("h2")}</h2>;
  if (block.tip) return <p className="article-tip">{text("tip")}</p>;
  if (block.ul || block.ol) {
    const Tag = block.ul ? "ul" : "ol";
    const items = (lang !== "ru" && block[(block.ul ? "ul" : "ol") + "_" + lang]) || block.ul || block.ol;
    return (
      <Tag>
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </Tag>
    );
  }
  return <p>{text("p")}</p>;
}

/** Отдельная статья или тест: /articles/:slug. */
export default function ArticlePage() {
  const { slug } = useParams();
  const { lang, t, to } = useI18n();
  const article = findArticle(slug);
  const title = article ? localizedField(article, "title", lang) : "";
  const excerpt = article ? localizedField(article, "excerpt", lang) : "";

  useEffect(() => {
    if (!article) return;
    document.title = title + " — " + t("common.brand");
    document.head.querySelector('meta[name="description"]')?.setAttribute("content", excerpt);
  }, [article, title, excerpt, t]);

  if (!article) return <Navigate replace to={to("/articles")} />;

  const related = sortedArticles()
    .filter((item) => item.slug !== article.slug)
    .sort((a, b) => Number(b.category === article.category) - Number(a.category === article.category))
    .slice(0, 3);

  return (
    <main>
      <article className="section article-page">
        <Link className="article-back" to={to("/articles")}>
          {t("articles.back")}
        </Link>
        <p className="article-meta">
          {t(article.type === "test" ? "articles.type_test" : "articles.type_article")} ·{" "}
          {categoryText(article.category, "title", lang)}
        </p>
        <h1>{title}</h1>
        <p className="article-lead">{excerpt}</p>

        {article.type === "test" ? (
          <Quiz key={article.slug} test={article} />
        ) : (
          <>
            <div className="article-body">
              {article.body.map((block, index) => (
                <Block key={index} block={block} lang={lang} />
              ))}
            </div>
            {article.cta && (
              <ArticleCta
                title={localizedField(article.cta, "title", lang)}
                text={localizedField(article.cta, "text", lang)}
                productId={article.cta.productId}
                articleTitle={title}
              />
            )}
          </>
        )}
      </article>

      {related.length > 0 && (
        <section className="section articles-related">
          <header className="section-head">
            <h2>{t("articles.related")}</h2>
          </header>
          <div className="articles-grid">
            {related.map((item) => (
              <ArticleCard key={item.slug} article={item} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
