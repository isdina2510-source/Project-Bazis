import { Link } from "react-router-dom";
import { useI18n } from "../i18n/I18nProvider.jsx";
import { IS_MEDIA } from "../site.js";
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
        <img className="logo-img" src="/brand/logo-media.svg" alt={t("header.logo_alt")} width="133" height="34" />
        <span className="logo-tag" aria-hidden="true">
          {t("header.logo_tag")}
        </span>
      </>
    );
  }
  return <img className="logo-img" src="/brand/logo.svg" alt={t("header.logo_alt")} width="133" height="34" />;
}

/** Якоря главной: у медиа-сайта — портфолио, у «Базиса» — блок «О нас». */
const HOME_FIRST_ANCHOR = IS_MEDIA ? { href: "#works", key: "works" } : { href: "#about", key: "about" };

/** variant: "home" — прозрачная шапка с якорями; "shop" / "articles" — сплошная, со ссылками на разделы. */
export default function Header({ variant, solid }) {
  const { cartCount, openCart, openContact } = useStore();
  const { t, to } = useI18n();
  const isShop = variant !== "home";
  const current = (page) => (variant === page ? "page" : undefined);

  const className = ["topbar", solid || isShop ? "is-solid" : "", isShop ? "shop-topbar" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <header className={className} id="topbar">
      {isShop ? (
        <Link className="logo" to={to("/")}>
          <LogoImage />
        </Link>
      ) : (
        <AnchorLink className="logo" href="#top">
          <LogoImage />
        </AnchorLink>
      )}
      <div className="topbar-end">
        <LanguageSwitcher />
        <nav aria-label={t("header.nav_label")}>
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
