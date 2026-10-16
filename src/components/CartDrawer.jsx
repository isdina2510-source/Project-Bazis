import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  CONTACT_PHONE,
  allowsCartQty,
  formatFromPrice,
  formatPrice,
  getTelegramProfileUrl,
  isAddableProduct,
  isLowStock,
  maxCartQty,
  productText,
} from "../lib/catalog.js";
import { copyText } from "../lib/clipboard.js";
import { buildCartOrderMessage, isCheckoutCustomerValid, whatsappUrl } from "../lib/messages.js";
import { newOrderId, saveCheckoutOrder } from "../lib/orders-db.js";
import { warmOrderProof } from "../lib/order-proof.js";
import { isValidCustomerName, isValidPhone } from "../lib/phone.js";
import { useI18n } from "../i18n/I18nProvider.jsx";
import { useStore } from "../store/StoreContext.jsx";
import ConsentField from "./ConsentField.jsx";
import ResponsiveImage from "./ResponsiveImage.jsx";

const THUMB_WIDTHS = [96, 144];

const CHECKOUT_ERROR_TEXT = {
  catalog_changed: "cart.status.catalog_changed",
  out_of_stock: "cart.status.out_of_stock",
  qty_out_of_range: "cart.status.qty_out_of_range",
  rate_limited: "cart.status.rate_limited",
  busy: "cart.status.busy",
  customer_required: "cart.status.invalid",
  consent_required: "contact.form.error_consent",
};

function CartItem({ item, onQty, onRemove }) {
  const { lang, t } = useI18n();
  return (
    <article className="cart-item">
      <ResponsiveImage src={item.image} alt="" width={72} height={72} ratio={1} widths={THUMB_WIDTHS} sizes="72px" />
      <div className="cart-item-body">
        <h3>{productText(item, "title", lang)}</h3>
        <p>{formatPrice(item.price, item.currency, lang)}</p>
        {isLowStock(item) && <p className="stock-note">{t("product.stock_left", { count: item.stock })}</p>}
        {allowsCartQty(item) ? (
          <div className="cart-qty">
            <button type="button" onClick={() => onQty(item.id, item.qty - 1)} aria-label={t("cart.decrease")}>
              −
            </button>
            <span>{item.qty}</span>
            <button
              type="button"
              onClick={() => onQty(item.id, item.qty + 1)}
              disabled={item.qty >= maxCartQty(item)}
              aria-label={t("cart.increase")}
            >
              +
            </button>
          </div>
        ) : (
          <div className="cart-qty cart-qty-fixed">
            <span>1</span>
          </div>
        )}
      </div>
      <div className="cart-item-side">
        <strong>{formatPrice(item.lineTotal, item.currency, lang)}</strong>
        <button type="button" className="cart-remove" onClick={() => onRemove(item.id)}>
          {t("cart.remove")}
        </button>
      </div>
    </article>
  );
}

export default function CartDrawer() {
  const {
    products,
    refreshProducts,
    cart,
    cartItems,
    cartUnavailable,
    cartCount,
    cartTotalText,
    addToCart,
    setCartQty,
    removeFromCart,
    clearCart,
    cartOpen,
    closeCart,
  } = useStore();
  const location = useLocation();
  const { lang, t } = useI18n();

  const [catalogOpen, setCatalogOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [invalid, setInvalid] = useState({ name: false, phone: false });
  const [status, setStatus] = useState(null);
  /** Заказ в Telegram сохранён, но текст не скопировался: { text, url } — показываем текст с кнопкой копирования. */
  const [manualCopy, setManualCopy] = useState(null);
  const [manualCopied, setManualCopied] = useState(false);
  const manualTextRef = useRef(null);
  const savingRef = useRef(false);
  /** { key, id }: пока корзина и контакты не менялись, повторная отправка идёт с тем же id. */
  const pendingOrderRef = useRef(null);
  const nameRef = useRef(null);
  const phoneRef = useRef(null);
  const trapRef = useRef(null);

  const customer = { name, phone };
  const hasItems = cartItems.length > 0;

  const addable = useMemo(() => {
    const inCart = new Set(cart.map((item) => item.id));
    return products.filter((product) => isAddableProduct(product) && !inCart.has(product.id));
  }, [products, cart]);

  const orderMessage = buildCartOrderMessage(cartItems, customer, lang);
  const waHref = whatsappUrl(orderMessage, CONTACT_PHONE);
  const tgHref = getTelegramProfileUrl();

  // Пока страница была открыта, цены и остатки могли измениться — показываем актуальные до оформления.
  useEffect(() => {
    if (!cartOpen) return;
    refreshProducts().catch(() => {});
    warmOrderProof().catch(() => {});
  }, [cartOpen, refreshProducts]);

  useEffect(() => {
    if (!cartOpen) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") closeCart();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cartOpen, closeCart]);

  const onFieldChange = (setter) => (event) => {
    setter(event.target.value);
    setInvalid({ name: false, phone: false });
    const next = { ...customer, [event.target.name === "checkout-name" ? "name" : "phone"]: event.target.value };
    if (isCheckoutCustomerValid(next)) setStatus(null);
  };

  const runCheckout = async (channel, event) => {
    event.preventDefault();
    if (savingRef.current) return;
    if (!cartCount) {
      setStatus({ text: t("cart.status.empty"), tone: "error" });
      return;
    }

    if (!isCheckoutCustomerValid(customer)) {
      const nameOk = isValidCustomerName(name);
      setInvalid({ name: !nameOk, phone: !isValidPhone(phone) });
      setStatus({ text: t("cart.status.invalid"), tone: "error" });
      (nameOk ? phoneRef : nameRef).current?.focus();
      return;
    }
    if (!consent) {
      setStatus({ text: t("contact.form.error_consent"), tone: "error" });
      return;
    }

    savingRef.current = true;
    setInvalid({ name: false, phone: false });
    setStatus({ text: t("cart.status.saving"), tone: "info" });

    const url = channel === "telegram" ? tgHref : waHref;
    const orderKey = JSON.stringify([channel, cartItems.map((item) => [item.id, item.qty, item.price]), name.trim(), phone.trim()]);
    if (!pendingOrderRef.current || pendingOrderRef.current.key !== orderKey) {
      pendingOrderRef.current = { key: orderKey, id: newOrderId() };
    }

    setManualCopy(null);
    // Буфер обмена и окно — синхронно в обработчике клика: после await браузер их запретит.
    const copyPromise = channel === "telegram" ? copyText(orderMessage) : null;
    let popup = null;
    try {
      popup = window.open("about:blank", "_blank");
    } catch {
      popup = null;
    }

    try {
      await saveCheckoutOrder({
        id: pendingOrderRef.current.id,
        channel,
        items: cartItems,
        customer,
        consent: true,
        message: orderMessage,
        sourcePage: location.pathname,
        website: trapRef.current ? trapRef.current.value : "",
      });
    } catch (err) {
      console.warn("Не удалось сохранить заказ в БД", err); // i18n-ignore: лог для разработчика
      try {
        popup?.close();
      } catch {
        // ignore
      }
      const code = err && err.code;
      if (code === "catalog_changed" || code === "out_of_stock" || code === "qty_out_of_range") {
        pendingOrderRef.current = null;
        refreshProducts().catch(() => {});
      }
      setStatus({ text: t(CHECKOUT_ERROR_TEXT[code] || "cart.status.error"), tone: "error" });
      savingRef.current = false;
      return;
    }

    try {
      pendingOrderRef.current = null;
      const copied = copyPromise ? await copyPromise : false;

      setCatalogOpen(true);
      clearCart();

      if (popup && !popup.closed) {
        try {
          popup.opener = null;
        } catch {
          // ignore
        }
        popup.location.href = url;
      } else {
        // Окно заблокировали при клике; новый window.open после await браузер тоже молча заблокирует.
        window.location.assign(url);
      }

      if (channel === "telegram") {
        if (copied) {
          setStatus({ text: t("cart.status.telegram_copied"), tone: "ok" });
        } else {
          setManualCopied(false);
          setManualCopy({ text: orderMessage, url });
          setStatus({ text: t("cart.status.telegram_not_copied"), tone: "warn" });
        }
      } else {
        setStatus({ text: t("cart.status.whatsapp_ok"), tone: "ok" });
      }
    } finally {
      savingRef.current = false;
    }
  };

  return (
    <aside
      className={"cart-drawer" + (cartOpen ? " is-open" : "")}
      aria-hidden={cartOpen ? "false" : "true"}
      data-lenis-prevent=""
      data-lenis-prevent-wheel=""
      data-lenis-prevent-touch=""
    >
      <div className="cart-backdrop" onClick={closeCart} />
      <div className="cart-panel" role="dialog" aria-modal="true" aria-labelledby="cart-title">
        <header className="cart-header">
          <h2 id="cart-title">{t("cart.title")}</h2>
          <button type="button" className="cart-close" onClick={closeCart} aria-label={t("common.close")}>
            ×
          </button>
        </header>

        <div className="cart-items">
          {hasItems ? (
            cartItems.map((item) => (
              <CartItem key={item.id} item={item} onQty={setCartQty} onRemove={removeFromCart} />
            ))
          ) : (
            <p className="cart-empty">{t("cart.empty")}</p>
          )}

          {cartUnavailable.length > 0 && (
            <div className="cart-unavailable" role="status">
              <p>{t("cart.unavailable")}</p>
              <ul>
                {cartUnavailable.map((product) => (
                  <li key={product.id}>
                    <span>{productText(product, "title", lang)}</span>
                    <button type="button" className="cart-remove" onClick={() => removeFromCart(product.id)}>
                      {t("cart.remove")}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="cart-add">
            <button
              type="button"
              className="cart-add-toggle"
              aria-expanded={catalogOpen}
              onClick={() => setCatalogOpen((open) => !open)}
            >
              <span className="cart-add-icon">+</span>
              {t("cart.add_service")}
            </button>
            <div className="cart-catalog" hidden={!catalogOpen}>
              {addable.length ? (
                addable.map((product) => (
                  <button
                    key={product.id}
                    type="button"
                    className="cart-catalog-item"
                    onClick={() => {
                      addToCart(product.id, 1);
                      setCatalogOpen(true);
                    }}
                  >
                    <ResponsiveImage
                      src={product.image}
                      alt=""
                      width={48}
                      height={48}
                      ratio={1}
                      widths={THUMB_WIDTHS}
                      sizes="48px"
                    />
                    <span className="cart-catalog-text">
                      <strong>{productText(product, "title", lang)}</strong>
                      <em>{formatFromPrice(product.price, product.currency, lang)}</em>
                    </span>
                    <span className="cart-catalog-plus" aria-hidden="true">
                      +
                    </span>
                  </button>
                ))
              ) : (
                <p className="cart-catalog-empty">
                  {t("cart.all_in_cart")}
                </p>
              )}
            </div>
          </div>
        </div>

        <footer className="cart-footer">
          <div className="cart-total">
            <span>{t("cart.total")}</span>
            <strong>{cartTotalText}</strong>
          </div>
          <div className="cart-checkout-fields">
            <label>
              {t("cart.name_label")} *
              <input
                ref={nameRef}
                type="text"
                name="checkout-name"
                autoComplete="name"
                placeholder={t("cart.name_placeholder")}
                maxLength={80}
                required
                value={name}
                onChange={onFieldChange(setName)}
                className={invalid.name ? "is-invalid" : undefined}
              />
            </label>
            <label>
              {t("cart.phone_label")} *
              <input
                ref={phoneRef}
                type="tel"
                name="checkout-phone"
                autoComplete="tel"
                placeholder="+7 ..."
                maxLength={32}
                required
                value={phone}
                onChange={onFieldChange(setPhone)}
                className={invalid.phone ? "is-invalid" : undefined}
              />
            </label>
            {/* Ловушка для ботов: люди это поле не видят и не заполняют. */}
            <input ref={trapRef} className="form-trap" type="text" name="hp_note" tabIndex={-1} autoComplete="off" aria-hidden="true" />
            <ConsentField
              className="cart-consent"
              checked={consent}
              onChange={(value) => {
                setConsent(value);
                if (value) setStatus(null);
              }}
            />
            <p className="cart-checkout-hint">{t("cart.hint")}</p>
            <p
              className="cart-checkout-status"
              role="status"
              aria-live="polite"
              hidden={!status}
              data-tone={status ? status.tone : undefined}
            >
              {status ? status.text : ""}
            </p>
            {manualCopy && (
              <div className="cart-manual-copy">
                <label htmlFor="cart-manual-copy-text">{t("cart.manual_copy.label")}</label>
                <textarea
                  id="cart-manual-copy-text"
                  ref={manualTextRef}
                  readOnly
                  rows={6}
                  value={manualCopy.text}
                  onFocus={(event) => event.target.select()}
                />
                <div className="cart-manual-copy-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      copyText(manualCopy.text).then((ok) => {
                        setManualCopied(ok);
                        // Не скопировалось и так — выделяем текст, чтобы клиент скопировал его сам.
                        if (!ok) manualTextRef.current?.select();
                      });
                    }}
                  >
                    {manualCopied ? t("cart.manual_copy.copied") : t("cart.manual_copy.copy")}
                  </button>
                  <a className="btn btn-ghost" href={manualCopy.url} target="_blank" rel="noopener noreferrer">
                    {t("cart.manual_copy.open")}
                  </a>
                  <button type="button" className="btn btn-ghost" onClick={() => setManualCopy(null)}>
                    {t("cart.manual_copy.done")}
                  </button>
                </div>
              </div>
            )}
          </div>
          <a
            className={"btn btn-primary" + (hasItems ? "" : " is-disabled")}
            aria-disabled={hasItems ? "false" : "true"}
            href={waHref}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => runCheckout("whatsapp", event)}
          >
            {t("cart.checkout_whatsapp")}
          </a>
          <a
            className={"btn btn-ghost" + (hasItems ? "" : " is-disabled")}
            aria-disabled={hasItems ? "false" : "true"}
            href={tgHref}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => runCheckout("telegram", event)}
          >
            {t("cart.checkout_telegram")}
          </a>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              clearCart();
              setCatalogOpen(true);
            }}
          >
            {t("cart.clear")}
          </button>
        </footer>
      </div>
    </aside>
  );
}
