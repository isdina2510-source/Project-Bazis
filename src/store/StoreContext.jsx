import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { isDiscussOnlyProduct, isOutOfStock, isSiteProduct, lineAmount, maxCartQty } from "../lib/catalog.js";
import { CART_KEY, readCart, writeCart } from "../lib/cart-storage.js";
import { reportClientError } from "../lib/client-errors.js";
import { fetchProducts, readCachedProducts } from "../lib/products-api.js";
import { totalsText } from "../lib/messages.js";
import { setScrollLocked } from "../lib/smooth-scroll.js";

const StoreContext = createContext(null);

function useBodyClass(className, active) {
  useEffect(() => {
    document.body.classList.toggle(className, active);
    return () => document.body.classList.remove(className);
  }, [className, active]);
}

/**
 * Каталог витрины: сначала последняя копия с сервера (если есть), затем свежий список.
 * productsStatus: loading — ждём сервер; ready — данные свежие; stale — сервер не ответил, показана копия
 * (цены могут быть устаревшими); error — сервер не ответил и копии нет. Каталога по умолчанию нет:
 * его цены не совпадают с настоящими, а HTML для поисковиков товаров не содержит (scripts/i18n-html.mjs).
 */
function initialCatalog() {
  const cached = readCachedProducts();
  return { list: cached ? cached.products : [], status: "loading" };
}

export function StoreProvider({ children }) {
  const [catalog, setCatalog] = useState(initialCatalog);
  const allProducts = catalog.list;
  const productsStatus = catalog.status;
  const products = useMemo(() => allProducts.filter(isSiteProduct), [allProducts]);
  const [cart, setCart] = useState(readCart);
  const [cartOpen, setCartOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchProducts()
      .then((list) => {
        if (!cancelled) setCatalog({ list, status: "ready" });
      })
      .catch((err) => {
        if (cancelled) return;
        reportClientError(err, { kind: "catalog" });
        setCatalog((prev) => ({ list: prev.list, status: prev.list.length ? "stale" : "error" }));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshProducts = useCallback(async () => {
    const list = await fetchProducts();
    setCatalog({ list, status: "ready" });
    return list.filter(isSiteProduct);
  }, []);

  // Синхронизация корзины между вкладками.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key === CART_KEY) setCart(readCart());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const updateCart = useCallback((updater) => {
    setCart((prev) => {
      const next = updater(prev);
      writeCart(next);
      return next;
    });
  }, []);

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const addToCart = useCallback(
    (productId, qty = 1) => {
      const product = productById.get(productId);
      if (!product || isDiscussOnlyProduct(product)) return;
      const max = maxCartQty(product);
      if (max <= 0) return;
      const addQty = Math.max(1, Number(qty) || 1);
      updateCart((prev) => {
        const existing = prev.find((item) => item.id === productId);
        if (!existing) return [...prev, { id: productId, qty: Math.min(max, addQty) }];
        return prev.map((item) => (item.id === productId ? { ...item, qty: Math.min(max, item.qty + addQty) } : item));
      });
    },
    [productById, updateCart]
  );

  const setCartQty = useCallback(
    (productId, qty) => {
      const product = productById.get(productId);
      const nextQty = Math.min(product ? maxCartQty(product) : 0, Math.max(0, Number(qty) || 0));
      updateCart((prev) =>
        nextQty <= 0
          ? prev.filter((item) => item.id !== productId)
          : prev.map((item) => (item.id === productId ? { ...item, qty: nextQty } : item))
      );
    },
    [productById, updateCart]
  );

  const removeFromCart = useCallback(
    (productId) => updateCart((prev) => prev.filter((item) => item.id !== productId)),
    [updateCart]
  );

  // Пишем сразу, а не в updater: после оформления страница может тут же уйти на мессенджер.
  const clearCart = useCallback(() => {
    writeCart([]);
    setCart([]);
  }, []);

  // Количество в корзине не больше остатка (он мог уменьшиться после добавления).
  const cartItems = useMemo(
    () =>
      cart
        .map((item) => {
          const product = productById.get(item.id);
          if (!product || isDiscussOnlyProduct(product) || isOutOfStock(product)) return null;
          const qty = Math.min(maxCartQty(product), Math.max(1, Number(item.qty) || 1));
          return { ...product, qty, lineTotal: lineAmount(product.price, qty) };
        })
        .filter(Boolean),
    [cart, productById]
  );

  /** Позиции корзины, которые закончились: в заказ не идут, покупатель видит их отдельно и может убрать. */
  const cartUnavailable = useMemo(
    () =>
      cart
        .map((item) => productById.get(item.id))
        .filter((product) => product && !isDiscussOnlyProduct(product) && isOutOfStock(product)),
    [cart, productById]
  );

  const cartCount = useMemo(() => cartItems.reduce((sum, item) => sum + item.qty, 0), [cartItems]);
  const cartTotalText = useMemo(() => totalsText(cartItems), [cartItems]);

  const openCart = useCallback(() => setCartOpen(true), []);
  const closeCart = useCallback(() => setCartOpen(false), []);
  const openContact = useCallback(() => {
    setCartOpen(false);
    setContactOpen(true);
  }, []);
  const closeContact = useCallback(() => setContactOpen(false), []);

  useBodyClass("cart-open", cartOpen);
  useBodyClass("contact-open", contactOpen);

  useEffect(() => {
    setScrollLocked(cartOpen || contactOpen || chatOpen);
  }, [cartOpen, contactOpen, chatOpen]);

  const value = {
    products,
    productsStatus,
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
    openCart,
    closeCart,
    contactOpen,
    openContact,
    closeContact,
    chatOpen,
    setChatOpen,
  };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore должен вызываться внутри <StoreProvider>"); // i18n-ignore: ошибка разработчика
  return ctx;
}
