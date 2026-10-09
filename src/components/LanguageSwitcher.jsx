import { useEffect, useId, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { writeLangCookie } from "../i18n/index.js";
import { useI18n } from "../i18n/I18nProvider.jsx";
import { stripLang } from "../i18n/routing.jsx";

function GlobeIcon() {
  return (
    <svg className="lang-switch-globe" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" />
    </svg>
  );
}

/** Значок языка с выпадающим меню: ссылки на ту же страницу в другом языке с сохранением #раздела и параметров. */
export default function LanguageSwitcher() {
  const { lang, langs, t } = useI18n();
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const menuId = useId();
  const rest = stripLang(pathname);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    const menu = rootRef.current;
    (menu?.querySelector(".lang-switch-option.is-active") || menu?.querySelector(".lang-switch-option"))?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onMenuKey = (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...rootRef.current.querySelectorAll(".lang-switch-option")];
    const index = items.indexOf(document.activeElement);
    const next = (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  };

  return (
    <nav className={"lang-switch" + (open ? " is-open" : "")} aria-label={t("lang.switcher_label")} ref={rootRef}>
      <button
        type="button"
        ref={buttonRef}
        className="lang-switch-button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        title={t("lang.switcher_label")}
        aria-label={t("lang.switcher_label") + ": " + t("lang." + lang + "_full")}
        onClick={() => setOpen((value) => !value)}
      >
        <GlobeIcon />
        <span className="lang-switch-current">{t("lang." + lang)}</span>
        <span className="lang-switch-chevron" aria-hidden="true" />
      </button>
      <ul className="lang-switch-menu" id={menuId} hidden={!open} onKeyDown={onMenuKey}>
        {langs.map((code) => {
          const active = code === lang;
          const href = "/" + code + (rest === "/" ? "/" : rest) + search + hash;
          const onClick = (event) => {
            writeLangCookie(code);
            setOpen(false);
            if (event.defaultPrevented || event.button !== 0) return;
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            if (!active) navigate(href);
          };
          return (
            <li key={code}>
              <a
                href={href}
                hrefLang={code}
                lang={code}
                className={"lang-switch-option" + (active ? " is-active" : "")}
                aria-current={active ? "true" : undefined}
                onClick={onClick}
              >
                <span>{t("lang." + code + "_full")}</span>
                <span className="lang-switch-code">{t("lang." + code)}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
