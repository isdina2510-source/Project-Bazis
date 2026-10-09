import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test } from "vitest";
import { I18nProvider } from "../i18n/I18nProvider.jsx";
import { StoreProvider } from "../store/StoreContext.jsx";
import { clientErrorReports, jsonResponse, mockFetch } from "../test/fetch-mock.js";
import ShopPage from "./ShopPage.jsx";

const PRODUCT = { id: "p1", title: "Экспресс-аудит", description: "Описание", price: 150000, currency: "KZT", category: "management", kind: "service" };

function renderShop() {
  return render(
    <MemoryRouter initialEntries={["/ru/shop#all"]}>
      <StoreProvider>
        <I18nProvider lang="ru">
          <ShopPage />
        </I18nProvider>
      </StoreProvider>
    </MemoryRouter>
  );
}

describe("MED-11: каталог витрины, когда сервер не отвечает", () => {
  test("нет копии — «Каталог временно недоступен» и контакты, без каталога по умолчанию; сбой отправлен на сервер", async () => {
    const fetchMock = mockFetch({
      "GET /api/products": new TypeError("Failed to fetch"),
      "POST /api/client-errors": new Response(null, { status: 204 }),
    });
    renderShop();
    await screen.findByText("Каталог временно недоступен");
    expect(screen.getByRole("link", { name: "Написать в WhatsApp" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Написать в Telegram" })).toBeTruthy();
    expect(document.querySelectorAll(".product-card")).toHaveLength(0);
    expect(clientErrorReports(fetchMock).map((r) => r.message)).toEqual(["[catalog] Error: network_error"]);
  });

  test("есть копия — показываем её с пометкой «Цены могут быть неактуальны»", async () => {
    localStorage.setItem("bazis_products_cache", JSON.stringify({ savedAt: Date.now() - 3600e3, products: [PRODUCT] }));
    mockFetch({
      "GET /api/products": jsonResponse({ error: "server_error" }, 503),
      "POST /api/client-errors": new Response(null, { status: 204 }),
    });
    renderShop();
    await screen.findByText("Цены могут быть неактуальны, уточните у менеджера.");
    expect(screen.getByText("Экспресс-аудит")).toBeTruthy();
  });

  test("пока каталог грузится, без копии — «Загружаем каталог…», не каталог по умолчанию", async () => {
    let release;
    mockFetch({ "GET /api/products": () => new Promise((resolve) => (release = () => resolve(jsonResponse([PRODUCT])))) });
    renderShop();
    expect(screen.getByText("Загружаем каталог…")).toBeTruthy();
    expect(document.querySelectorAll(".product-card")).toHaveLength(0);
    await waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await screen.findByText("Экспресс-аудит");
    expect(screen.queryByText(/Цены могут быть неактуальны/)).toBeNull();
  });
});
