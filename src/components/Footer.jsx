import { Link } from "react-router-dom";
import { useI18n } from "../i18n/I18nProvider.jsx";
import { SIBLING_ID, siteUrl } from "../site.js";
import AnchorLink from "./AnchorLink.jsx";

export default function Footer({ variant }) {
  const { lang, t, to } = useI18n();
  const siblingUrl = SIBLING_ID ? siteUrl(SIBLING_ID) : "";
  return (
    <footer className="footer">
      <p>{t("footer.copyright", { year: new Date().getFullYear() })}</p>
      <div className="footer-links">
        {variant === "home" ? (
          <>
            <Link to={to("/shop")}>{t("footer.shop")}</Link>
            <Link to={to("/articles")}>{t("footer.articles")}</Link>
            <AnchorLink href="#top">{t("footer.top")}</AnchorLink>
          </>
        ) : (
          <>
            <Link to={to("/")}>{t("footer.home")}</Link>
            {variant !== "shop" && <Link to={to("/shop")}>{t("footer.shop")}</Link>}
            {variant !== "articles" && <Link to={to("/articles")}>{t("footer.articles")}</Link>}
          </>
        )}
        {siblingUrl && <a href={siblingUrl + "/" + lang + "/"}>{t("footer.sibling")}</a>}
      </div>
    </footer>
  );
}
