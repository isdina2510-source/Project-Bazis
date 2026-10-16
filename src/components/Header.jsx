import { useLayoutEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../i18n/I18nProvider.jsx";
import { IS_MEDIA, SIBLING_ID, siteUrl } from "../site.js";
import { useStore } from "../store/StoreContext.jsx";
import AnchorLink from "./AnchorLink.jsx";
import LanguageSwitcher from "./LanguageSwitcher.jsx";

function CartIcon() {
  return (
    <svg
      className="cart-icon"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="9" cy="21" r="1" />
      <circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
    </svg>
  );
}

function LogoImage() {
  const { t } = useI18n();
  if (IS_MEDIA) {
    return (
      <>
        <img className="logo-img" src="/brand/logo-media.svg" alt={t("header.logo_alt")} width="153" height="34" />
        <span className="logo-tag" aria-hidden="true">
          {t("header.logo_tag")}
        </span>
      </>
    );
  }
  return <img className="logo-img" src="/brand/logo.svg" alt={t("header.logo_alt")} width="153" height="34" />;
}

const MAX_COMPACT = 3;

/**
 * Ширина подписей зависит от сайта, языка и масштаба страницы, поэтому одной ширины для @media мало:
 * шапка сама проверяет, помещаются ли кнопки, и ужимает их по ступеням (data-compact в styles.css):
 * 1 — прячет «Как работаем», 2 — ссылка на соседний сайт становится стрелкой, 3 — остаются только иконки.
 */
function useCompactTopbar(ref, deps) {
  useLayoutEffect(() => {
    const header = ref.current;
    const end = header?.querySelector(".topbar-end");
    if (!end) return undefined;

    const fit = () => {
      for (let level = 0; level <= MAX_COMPACT; level++) {
        if (level) header.dataset.compact = String(level);
        else delete header.dataset.compact;
        // scrollWidth и clientWidth округляются до целых — 1px переполнения глазом не виден
        if (end.scrollWidth - end.clientWidth <= 1) return;
      }
    };

    fit();
    let cancelled = false;
    document.fonts?.ready.then(() => !cancelled && fit());
    if (typeof ResizeObserver === "undefined") return () => (cancelled = true);
    let width = header.clientWidth;
    const observer = new ResizeObserver(() => {
      if (header.clientWidth === width) return;
      width = header.clientWidth;
      fit();
    });
    observer.observe(header);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, deps);
}

/** Якоря главной: у медиа-сайта — портфолио, у Dinara BILab — блок «О нас». */
const HOME_FIRST_ANCHOR = IS_MEDIA ? { href: "#works", key: "works" } : { href: "#about", key: "about" };

/** variant: "home" — прозрачная шапка с якорями; "shop" / "articles" — сплошная, со ссылками на разделы. */
export default function Header({ variant, solid }) {
  const { cartCount, openCart, openContact } = useStore();
  const { lang, t, to } = useI18n();
  const isShop = variant !== "home";
  const mainSiteUrl = IS_MEDIA && SIBLING_ID ? siteUrl(SIBLING_ID) : "";
  const current = (page) => (variant === page ? "page" : undefined);
  const headerRef = useRef(null);
  useCompactTopbar(headerRef, [lang, variant, mainSiteUrl]);

  const className = ["topbar", solid || isShop ? "is-solid" : "", isShop ? "shop-topbar" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <header className={className} id="topbar" ref={headerRef}>
      {isShop ? (
        <Link className="logo" to={to("/")} aria-label={t("header.logo_alt")}>
          <LogoImage />
        </Link>
      ) : (
        <AnchorLink className="logo" href="#top" aria-label={t("header.logo_alt")}>
          <LogoImage />
        </AnchorLink>
      )}
      <div className="topbar-end">
        <LanguageSwitcher />
        <nav aria-label={t("header.nav_label")}>
          {mainSiteUrl && (
            <a className="nav-cta nav-sibling" href={mainSiteUrl + "/" + lang + "/"} aria-label={t("header.sibling_label")}>
              <span className="nav-sibling-text">{t("header.sibling")}</span>
              <span className="nav-sibling-icon" aria-hidden="true">
                ←
              </span>
            </a>
          )}
          {isShop ? (
            <>
              <Link className="nav-cta" to={to("/")}>
                {t(IS_MEDIA ? "footer.home" : "header.menu.about")}
              </Link>
              <Link className="nav-cta" to={to("/shop")} aria-current={current("shop")}>
                {t("header.menu.shop")}
              </Link>
              <Link className="nav-cta" to={to("/articles")} aria-current={current("articles")}>
                {t("header.menu.articles")}
              </Link>
            </>
          ) : (
            <>
              <AnchorLink className="nav-cta" href={HOME_FIRST_ANCHOR.href}>
                {t("header.menu." + HOME_FIRST_ANCHOR.key)}
              </AnchorLink>
              <Link className="nav-cta" to={to("/shop")}>
                {t("header.menu.shop")}
              </Link>
              <Link className="nav-cta" to={to("/articles")}>
                {t("header.menu.articles")}
              </Link>
              <AnchorLink className="nav-cta nav-hide-sm" href="#process">
                {t("header.menu.process")}
              </AnchorLink>
            </>
          )}
          <button type="button" className="nav-cta nav-contact" onClick={openContact}>
            {t("header.menu.contact")}
          </button>
          <button type="button" className="nav-cta cart-trigger" onClick={openCart} aria-label={t("header.cart")}>
            <CartIcon />
            <span className="cart-badge" hidden={cartCount === 0}>
              {cartCount}
            </span>
          </button>
        </nav>
      </div>
    </header>
  );
}
