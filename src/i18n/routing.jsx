import { Navigate, useLocation, useParams } from "react-router-dom";
import Layout from "../components/Layout.jsx";
import { BOT_UA, DEFAULT_LANG, detectLang, isLang } from "./index.js";
import { I18nProvider } from "./I18nProvider.jsx";

const isBot = () => typeof navigator !== "undefined" && BOT_UA.test(navigator.userAgent || "");

/** Путь без языкового префикса: /kk/shop → /shop. */
export function stripLang(pathname) {
  const match = String(pathname || "/").match(/^\/(kk|ru)(?=\/|$)(.*)$/);
  const rest = match ? match[2] : pathname;
  return rest || "/";
}

export function pageOf(pathname) {
  const rest = stripLang(pathname);
  if (rest.startsWith("/shop")) return "shop";
  if (rest.startsWith("/articles")) return "articles";
  return "home";
}

function LangShell({ lang }) {
  return (
    <I18nProvider lang={lang}>
      <Layout />
    </I18nProvider>
  );
}

/** Первый заход без префикса: язык из cookie / браузера, адрес и якорь сохраняются. */
function PrefixRedirect() {
  const { pathname, search, hash } = useLocation();
  return <Navigate replace to={"/" + detectLang() + (pathname === "/" ? "/" : pathname) + search + hash} />;
}

/** /:lang/… */
export function LangGate() {
  const { lang } = useParams();
  return isLang(lang) ? <LangShell lang={lang} /> : <PrefixRedirect />;
}

/** /, /shop без префикса: людям — редирект на их язык, роботам — версия по умолчанию без редиректа. */
export function RootGate() {
  return isBot() ? <LangShell lang={DEFAULT_LANG} /> : <PrefixRedirect />;
}

/** Страницы нет — ведём в ближайший раздел, а не на 404. */
export function NearestSection() {
  const { pathname } = useLocation();
  const { lang } = useParams();
  const base = "/" + (isLang(lang) ? lang : DEFAULT_LANG);
  const page = pageOf(pathname);
  return <Navigate replace to={base + (page === "home" ? "/" : "/" + page)} />;
}
