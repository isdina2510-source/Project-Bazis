import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import ProductCard from "../components/ProductCard.jsx";
import { useI18n } from "../i18n/I18nProvider.jsx";
import { CATEGORIES, categoryText } from "../lib/catalog.js";
import { useStore } from "../store/StoreContext.jsx";

function categoryFromHash(hash) {
  const id = String(hash || "").replace("#", "").trim();
  return CATEGORIES.some((item) => item.id === id) ? id : "all";
}

function ProductsGrid({ items }) {
  return (
    <div className="products-grid">
      {items.map((product) => (
        <ProductCard key={product.id} product={product} />
      ))}
    </div>
  );
}

export default function ShopPage() {
  const { products } = useStore();
  const { lang, t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const activeId = categoryFromHash(location.hash);

  useEffect(() => {
    if (!location.hash) navigate({ hash: "#all" }, { replace: true });
  }, [location.hash, navigate]);

  const setCategory = (id) => navigate({ hash: "#" + id }, { replace: true });
  const allTitle = t("shop.catalog.all");

  const renderCatalog = () => {
    if (!products.length) {
      return <p className="products-empty">{t("shop.catalog.empty")}</p>;
    }

    if (activeId === "all") {
      return CATEGORIES.map((category) => ({
        id: category.id,
        items: products.filter((product) => product.category === category.id),
      }))
        .filter((group) => group.items.length)
        .map((group) => (
          <section className="shop-group" id={group.id} key={group.id}>
            <header className="shop-group-head">
              <p className="eyebrow">{categoryText(group.id, "eyebrow", lang)}</p>
              <h3>{categoryText(group.id, "title", lang)}</h3>
              <p>{categoryText(group.id, "lead", lang)}</p>
            </header>
            <ProductsGrid items={group.items} />
          </section>
        ));
    }

    const filtered = products.filter((product) => product.category === activeId);
    if (!filtered.length) {
      return <p className="products-empty">{t("shop.catalog.empty_section")}</p>;
    }
    return <ProductsGrid items={filtered} />;
  };

  return (
    <main>
      <section className="section shop-hero">
        <p className="eyebrow">{t("shop.hero.eyebrow")}</p>
        <h1>{t("shop.hero.title")}</h1>
        <p className="shop-hero-text">{t("shop.hero.text")}</p>
      </section>

      <section className="section products shop-catalog">
        <header className="section-head shop-toolbar">
          <div>
            <p className="eyebrow">{t("shop.catalog.eyebrow")}</p>
            <h2>{activeId === "all" ? allTitle : categoryText(activeId, "title", lang)}</h2>
          </div>
        </header>
        <nav className="shop-categories" aria-label={t("shop.catalog.categories_label")}>
          {[{ id: "all" }, ...CATEGORIES].map((item) => {
            const isActive = item.id === activeId;
            return (
              <button
                key={item.id}
                type="button"
                className={"shop-cat" + (isActive ? " is-active" : "")}
                aria-pressed={isActive}
                onClick={() => setCategory(item.id)}
              >
                {item.id === "all" ? allTitle : categoryText(item.id, "title", lang)}
              </button>
            );
          })}
        </nav>
        <div>{renderCatalog()}</div>
      </section>
    </main>
  );
}
