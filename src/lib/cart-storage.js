export const CART_KEY = "bazis_cart";

export function readCart() {
  try {
    const raw = localStorage.getItem(CART_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && item.id).map((item) => ({ id: String(item.id), qty: Number(item.qty) || 1 }))
      : [];
  } catch {
    return [];
  }
}

export function writeCart(cart) {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  } catch {
    // ignore
  }
}

export function removeFromStoredCart(productId) {
  writeCart(readCart().filter((item) => item.id !== productId));
}
