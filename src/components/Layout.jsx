import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import DocumentHead from "../i18n/DocumentHead.jsx";
import { pageOf, stripLang } from "../i18n/routing.jsx";
import { initSmoothScroll, scrollToTarget } from "../lib/smooth-scroll.js";
import CartDrawer from "./CartDrawer.jsx";
import ChatWidget from "../chat/ChatWidget.jsx";
import ContactModal from "./ContactModal.jsx";
import Footer from "./Footer.jsx";
import Header from "./Header.jsx";

export default function Layout() {
  const { pathname, hash } = useLocation();
  // Смена языка (/kk/shop → /ru/shop) — та же страница: прокрутку не сбрасываем.
  const page = stripLang(pathname);
  const variant = pageOf(pathname);
  const [scrolled, setScrolled] = useState(false);
  const lastPathRef = useRef(null);

  useEffect(() => initSmoothScroll((y) => setScrolled(y > 28)), []);

  // Новая страница — наверх; при первой загрузке главной с якорем (/#contact) — к секции.
  // Смена hash (разделы магазина) скролл не трогает.
  useEffect(() => {
    if (lastPathRef.current === page) return;
    const isFirst = lastPathRef.current === null;
    lastPathRef.current = page;
    if (isFirst) {
      const id = hash.slice(1);
      const target = variant === "home" && id ? document.getElementById(id) : null;
      if (target) scrollToTarget(target, true);
      return;
    }
    scrollToTarget(0, true);
  }, [page, hash, variant]);

  useEffect(() => {
    document.body.classList.toggle("shop-page", variant !== "home");
  }, [variant]);

  return (
    <>
      <DocumentHead page={variant} />
      <Header variant={variant} solid={scrolled} />
      <Outlet />
      <ContactModal />
      <CartDrawer />
      <Footer variant={variant} />
      <ChatWidget />
    </>
  );
}
