import { createContext, useContext, useMemo } from "react";
import { LANGS, formatDate, formatNumber, localizedField, setLang, t, tRich } from "./index.js";

const I18nContext = createContext(null);

/** Язык берётся из URL (/kk/…, /ru/…) и пробрасывается вниз по дереву. */
export function I18nProvider({ lang, children }) {
  setLang(lang);
  const value = useMemo(
    () => ({
      lang,
      langs: LANGS,
      t: (key, values) => t(key, values, lang),
      tRich: (key, values) => tRich(key, values, lang),
      field: (item, name) => localizedField(item, name, lang),
      formatNumber: (n) => formatNumber(n, lang),
      formatDate: (d) => formatDate(d, lang),
      /** Путь внутри текущего языка: to("/shop") → "/kk/shop". */
      to: (path = "/") => "/" + lang + (path === "/" ? "/" : path),
    }),
    [lang]
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n должен вызываться внутри <I18nProvider>"); // i18n-ignore: ошибка разработчика
  return ctx;
}
