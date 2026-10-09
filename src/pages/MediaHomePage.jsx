import { useState } from "react";
import { Link } from "react-router-dom";
import AnchorLink from "../components/AnchorLink.jsx";
import ArticleCard from "../components/ArticleCard.jsx";
import ContactSection from "../components/ContactSection.jsx";
import ResponsiveImage from "../components/ResponsiveImage.jsx";
import { sortedArticles } from "../content/articles.js";
import { PORTFOLIO, PORTFOLIO_KINDS } from "../content/portfolio.js";
import { useI18n } from "../i18n/I18nProvider.jsx";
import { formatFromPrice, productText } from "../lib/catalog.js";
import { getPortfolioWhatsAppUrl } from "../lib/messages.js";
import { useStore } from "../store/StoreContext.jsx";

const BADGES = ["badge_turnkey", "badge_ai", "badge_order"];
const STEPS = ["brief", "production", "delivery"];
const COLLAGE_SIZE = 4;
const TILE_WIDTHS = [360, 480, 768];
const WORK_WIDTHS = [360, 480, 768, 1080];

function workTitle(work, lang) {
  return (lang === "kk" && work.title_kk) || work.title;
}

export default function MediaHomePage() {
  const { lang, t, to } = useI18n();
  const { products, openContact } = useStore();
  const [kind, setKind] = useState("all");

  const kinds = PORTFOLIO_KINDS.filter((id) => PORTFOLIO.some((work) => work.kind === id));
  const works = PORTFOLIO.filter((work) => kind === "all" || work.kind === kind);
  const collage = PORTFOLIO.slice(0, COLLAGE_SIZE);
  const articles = sortedArticles().slice(0, 3);

  return (
    <main id="top" className="media-home">
      <section className="mh-hero">
        <div className="mh-hero-copy">
          <p className="mh-eyebrow">{t("media_home.hero.eyebrow")}</p>
          <h1>
            {t("media_home.hero.title_line1")}
            <br />
            <span className="mh-gradient-text">{t("media_home.hero.title_line2")}</span>
          </h1>
          <p className="mh-lead">{t("media_home.hero.lead")}</p>
          <div className="hero-actions">
            <Link className="btn btn-primary" to={to("/shop")}>
              {t("media_home.hero.cta_order")}
            </Link>
            <AnchorLink className="btn btn-ghost" href="#works">
              {t("media_home.hero.cta_works")}
            </AnchorLink>
          </div>
          <ul className="mh-badges">
            {BADGES.map((key) => (
              <li key={key}>{t("media_home.hero." + key)}</li>
            ))}
          </ul>
        </div>
        <div className="mh-collage" aria-hidden="true">
          {collage.map((work, index) => (
            <div className={"mh-tile mh-tile-" + (index + 1)} key={work.id}>
              <ResponsiveImage
                src={work.image}
                alt=""
                width={600}
                height={600}
                ratio={1}
                widths={TILE_WIDTHS}
                sizes="(max-width: 900px) 45vw, 280px"
                priority={index < 2}
              />
            </div>
          ))}
        </div>
      </section>

      <section id="services" className="section mh-services">
        <header className="section-head shop-preview-head">
          <div>
            <p className="eyebrow">{t("media_home.services.eyebrow")}</p>
            <h2>{t("media_home.services.title")}</h2>
          </div>
          <Link className="btn btn-ghost" to={to("/shop")}>
            {t("media_home.services.all")}
          </Link>
        </header>
        <div className="mh-service-grid">
          {products.map((product) => {
            const title = productText(product, "title", lang);
            return (
              <Link className="mh-service" key={product.id} to={to("/shop#" + product.category)}>
                <span className="mh-service-media">
                  <ResponsiveImage
                    src={product.image}
                    alt=""
                    width={800}
                    height={600}
                    ratio={4 / 3}
                    widths={TILE_WIDTHS}
                    sizes="(max-width: 700px) calc(100vw - 2.4rem), (max-width: 1000px) 45vw, 260px"
                  />
                </span>
                <span className="mh-service-body">
                  <strong>{title}</strong>
                  <span className="mh-service-price">{formatFromPrice(product.price, product.currency, lang)}</span>
                </span>
              </Link>
            );
          })}
        </div>
      </section>

      <section id="works" className="section mh-works">
        <header className="section-head">
          <p className="eyebrow">{t("media_home.works.eyebrow")}</p>
          <h2>{t("media_home.works.title")}</h2>
          <p className="mh-section-lead">{t("media_home.works.lead")}</p>
        </header>
        <nav className="shop-categories mh-filter" aria-label={t("media_home.works.filter_label")}>
          {["all", ...kinds].map((id) => (
            <button
              key={id}
              type="button"
              className={"shop-cat" + (id === kind ? " is-active" : "")}
              aria-pressed={id === kind}
              onClick={() => setKind(id)}
            >
              {t("media_home.works." + id)}
            </button>
          ))}
        </nav>
        <div className="mh-works-grid">
          {works.map((work, index) => {
            const title = workTitle(work, lang);
            return (
              <a
                className={"mh-work" + (index % 5 === 0 ? " is-wide" : "")}
                key={work.id}
                href={getPortfolioWhatsAppUrl(title, lang)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ResponsiveImage
                  src={work.image}
                  alt={title}
                  width={800}
                  height={600}
                  ratio={4 / 3}
                  widths={WORK_WIDTHS}
                  sizes="(max-width: 700px) calc(100vw - 2.4rem), (max-width: 1000px) 45vw, 360px"
                />
                <span className="mh-work-overlay">
                  <span className="mh-work-kind">{t("media_home.works." + work.kind)}</span>
                  <span className="mh-work-title">{title}</span>
                  <span className="mh-work-cta">{t("media_home.works.order_similar")}</span>
                </span>
              </a>
            );
          })}
        </div>
      </section>

      <section id="process" className="section mh-process">
        <header className="section-head">
          <p className="eyebrow">{t("media_home.process.eyebrow")}</p>
          <h2>{t("media_home.process.title")}</h2>
        </header>
        <ol className="mh-steps">
          {STEPS.map((step, index) => (
            <li className="mh-step" key={step}>
              <span className="mh-step-num" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <h3>{t(`media_home.process.${step}.title`)}</h3>
              <p>{t(`media_home.process.${step}.text`)}</p>
            </li>
          ))}
        </ol>
      </section>

      {articles.length > 0 && (
        <section id="articles" className="section articles-preview">
          <header className="section-head shop-preview-head">
            <div>
              <p className="eyebrow">{t("articles.home_eyebrow")}</p>
              <h2>{t("articles.title")}</h2>
            </div>
            <Link className="btn btn-ghost" to={to("/articles")}>
              {t("articles.home_all")}
            </Link>
          </header>
          <div className="articles-grid">
            {articles.map((article) => (
              <ArticleCard key={article.slug} article={article} />
            ))}
          </div>
        </section>
      )}

      <section className="section mh-cta">
        <div className="mh-cta-panel">
          <h2>{t("media_home.cta.title")}</h2>
          <p>{t("media_home.cta.text")}</p>
          <button type="button" className="btn btn-primary" onClick={openContact}>
            {t("media_home.cta.button")}
          </button>
        </div>
      </section>

      <ContactSection />
    </main>
  );
}
