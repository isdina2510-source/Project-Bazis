import { Link } from "react-router-dom";
import AnchorLink from "../components/AnchorLink.jsx";
import ArticleCard from "../components/ArticleCard.jsx";
import DirectionCard, { SiblingSiteCard } from "../components/DirectionCard.jsx";
import { sortedArticles } from "../content/articles.js";
import ResponsiveImage from "../components/ResponsiveImage.jsx";
import { useI18n } from "../i18n/I18nProvider.jsx";
import ContactSection from "../components/ContactSection.jsx";
import { CATEGORIES } from "../lib/catalog.js";
import { HERO_IMAGE } from "../lib/hero.js";
import { useStore } from "../store/StoreContext.jsx";

const SERVICES = [
  { num: "01", key: "audit" },
  { num: "02", key: "setup" },
  { num: "03", key: "mentoring" },
];

const PROCESS_STEPS = ["intro", "diagnostics", "implementation", "support"];

const strong = (chunks) => <strong key="s">{chunks}</strong>;

export default function HomePage() {
  const { t, tRich, to } = useI18n();
  const { openContact } = useStore();

  return (
    <main id="top">
      <section className="hero">
        <div className="hero-copy">
          <p className="brand-line">{t("home.hero.brand_line")}</p>
          <h1>
            {t("home.hero.title_line1")}
            <br />
            {t("home.hero.title_line2")}
          </h1>
          <p className="hero-lead">{t("home.hero.lead")}</p>
          <div className="hero-actions">
            <Link className="btn btn-primary" to={to("/shop")}>
              {t("home.hero.cta_shop")}
            </Link>
            <AnchorLink className="btn btn-ghost" href="#about">
              {t("home.hero.cta_about")}
            </AnchorLink>
          </div>
        </div>
        <div className="hero-visual">
          <ResponsiveImage {...HERO_IMAGE} alt={t("home.hero.image_alt")} priority />
        </div>
      </section>

      <section id="about" className="section about">
        <div className="about-grid">
          <div className="about-label">
            <p className="eyebrow">{t("home.about.eyebrow")}</p>
            <h2>{t("home.about.title")}</h2>
          </div>
          <div className="about-body">
            <p className="about-lead">{t("home.about.lead")}</p>
            <p className="about-quote">{t("home.about.quote")}</p>
          </div>
        </div>
      </section>

      <section id="help" className="section help">
        <header className="section-head">
          <p className="eyebrow">{t("home.help.eyebrow")}</p>
          <h2>{t("home.help.title")}</h2>
        </header>
        <div className="cards">
          {SERVICES.map((service) => (
            <article className="card" key={service.num}>
              <span className="card-num">{service.num}</span>
              <h3>{t(`home.help.${service.key}.title`)}</h3>
              <p>{t(`home.help.${service.key}.text`)}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="shop-preview" className="section products">
        <header className="section-head shop-preview-head">
          <div>
            <p className="eyebrow">{t("home.shop_preview.eyebrow")}</p>
            <h2>{t("home.shop_preview.title")}</h2>
          </div>
          <Link className="btn btn-ghost" to={to("/shop")}>
            {t("home.shop_preview.all")}
          </Link>
        </header>
        <div className="products-grid">
          {CATEGORIES.map((category) => (
            <DirectionCard key={category.id} category={category.id} />
          ))}
          <SiblingSiteCard />
        </div>
      </section>

      <section id="process" className="section process">
        <header className="section-head">
          <p className="eyebrow">{t("home.process.eyebrow")}</p>
          <h2>{t("home.process.title")}</h2>
          <p className="process-lead">{t("home.process.lead")}</p>
        </header>
        <ol className="process-steps">
          {PROCESS_STEPS.map((step, index) => (
            <li className="process-step" key={step}>
              <span className="process-num" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <h3>{t(`home.process.${step}.title`)}</h3>
              <p>{t(`home.process.${step}.text`)}</p>
              <p className="process-result">{t(`home.process.${step}.result`)}</p>
            </li>
          ))}
        </ol>
        <div className="process-actions">
          <button type="button" className="btn btn-primary" onClick={openContact}>
            {t("home.process.cta")}
          </button>
          <Link className="btn btn-ghost" to={to("/articles/biznes-bez-vladeltsa-test")}>
            {t("home.process.cta_test")}
          </Link>
        </div>
      </section>

      <section id="fit" className="section fit">
        <header className="section-head">
          <p className="eyebrow">{t("home.fit.eyebrow")}</p>
          <h2>{t("home.fit.title")}</h2>
        </header>
        <ul className="fit-list">
          <li>{tRich("home.fit.companies", { strong })}</li>
          <li>{tRich("home.fit.owners", { strong })}</li>
        </ul>
      </section>

      <section id="philosophy" className="section philosophy">
        <div className="philosophy-panel">
          <p className="eyebrow">{t("home.philosophy.eyebrow")}</p>
          <h2>{t("home.philosophy.title")}</h2>
          <p>{t("home.philosophy.text")}</p>
          <ul>
            <li>{t("home.philosophy.no_infobiz")}</li>
            <li>{t("home.philosophy.no_school")}</li>
            <li>{t("home.philosophy.only_working")}</li>
          </ul>
        </div>
      </section>

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
          {sortedArticles()
            .slice(0, 3)
            .map((article) => (
              <ArticleCard key={article.slug} article={article} />
            ))}
        </div>
      </section>

      <ContactSection />
    </main>
  );
}
