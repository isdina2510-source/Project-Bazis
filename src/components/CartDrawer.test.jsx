import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";
import { I18nProvider } from "../i18n/I18nProvider.jsx";

const ITEM = { id: "p7", title: "Сайт-визитка", price: 100000, currency: "KZT", category: "infrastructure", image: "", stock: null, qty: 2, lineTotal: 200000 };
const refreshProducts = vi.fn(async () => {});

vi.mock("../store/StoreContext.jsx", () => ({
  useStore: () => ({
    products: [ITEM],
    refreshProducts,
    cart: [{ id: ITEM.id, qty: ITEM.qty }],
    cartItems: [ITEM],
    cartUnavailable: [],
    cartCount: ITEM.qty,
    cartTotalText: "200 000 ₸",
    addToCart: () => {},
    setCartQty: () => {},
    removeFromCart: () => {},
    clearCart: () => {},
    cartOpen: true,
    closeCart: () => {},
  }),
}));
vi.mock("../lib/order-proof.js", () => ({ warmOrderProof: async () => null }));
vi.mock("../lib/orders-db.js", () => ({
  newOrderId: () => "ord_test",
  saveCheckoutOrder: async () => {
    const err = new Error("Количество позиции — целое число от 1 до 999");
    err.code = "qty_out_of_range";
    err.status = 400;
    throw err;
  },
}));

const { default: CartDrawer } = await import("./CartDrawer.jsx");

describe("LOW-04: сервер отклонил количество", () => {
  test("qty_out_of_range — понятный текст из словаря и обновление каталога, а не «ошибка»", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(window, "open").mockReturnValue(null);
    render(
      <MemoryRouter>
        <I18nProvider lang="ru">
          <CartDrawer />
        </I18nProvider>
      </MemoryRouter>
    );
    fireEvent.change(screen.getByPlaceholderText("+7 ..."), { target: { value: "+7 701 123 45 67" } });
    fireEvent.change(document.querySelector('input[name="checkout-name"]'), { target: { value: "Айгерим" } });
    fireEvent.click(screen.getByText("Оформить в WhatsApp", { exact: false }));
    const status = await screen.findByText(/Количество в корзине больше допустимого/);
    expect(status.textContent).not.toMatch(/cart\.status/);
    expect(refreshProducts).toHaveBeenCalledTimes(2);
  });
});
