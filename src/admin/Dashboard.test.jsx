import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { jsonResponse, mockFetch } from "../test/fetch-mock.js";

vi.mock("./CompanySection.jsx", () => ({
  default: () => {
    throw new Error("company section crashed");
  },
}));

const { default: Dashboard } = await import("./Dashboard.jsx");
const { DialogHost } = await import("./dialogs.jsx");

const PRODUCT = { id: "p1", title: "Экспресс-аудит", description: "Описание", price: 150000, currency: "KZT", category: "management" };

/** Заказы и заявки — пусто; остальное задаёт тест. */
function routes(extra = {}) {
  return {
    "GET /api/orders": (url) => (url.includes("kind=") ? { items: [], nextCursor: null, counts: { all: 0 } } : []),
    "GET /api/products": [PRODUCT],
    "GET /api/clients": [],
    "POST /api/client-errors": new Response(null, { status: 204 }),
    ...extra,
  };
}

const openTab = (name) => fireEvent.click(within(screen.getByRole("navigation", { name: "Разделы админки" })).getByRole("button", { name }));

describe("HIGH-02: ErrorBoundary у каждого раздела админки", () => {
  test("упавший раздел показывает ошибку, остальные вкладки работают", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch(routes());
    render(<Dashboard onLogout={() => {}} />);
    openTab("Реквизиты");
    expect(screen.getByText("company section crashed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Обновить раздел" })).toBeTruthy();
    openTab("Заказы");
    await screen.findByText(/Заказы ·/);
    expect(screen.queryByText("company section crashed")).toBeNull();
  });
});

describe("HIGH-06: клиенты не загрузились — ошибка, а не пустой список", () => {
  test("ошибка сервера: «Не удалось загрузить клиентов» и «Повторить»", async () => {
    let clientsFail = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch(
      routes({
        "GET /api/clients": () => (clientsFail ? jsonResponse({ error: "server_error" }, 500) : jsonResponse([{ id: "c1", name: "Айгерим", phone: "77010000000" }])),
      })
    );
    render(<Dashboard onLogout={() => {}} />);
    openTab("Клиенты");
    await screen.findByText(/Не удалось загрузить клиентов/);
    expect(screen.queryByText(/Пока нет клиентов/)).toBeNull();
    clientsFail = false;
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await screen.findByText("Айгерим");
    expect(screen.queryByText(/Не удалось загрузить клиентов/)).toBeNull();
  });

  test("LOW-15: ответ не того вида тоже показывается как ошибка", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch(routes({ "GET /api/clients": { clients: [] } }));
    render(<Dashboard onLogout={() => {}} />);
    openTab("Клиенты");
    await screen.findByText(/Не удалось загрузить клиентов/);
    expect(screen.queryByText(/Пока нет клиентов/)).toBeNull();
  });
});

describe("LOW-03: сервер отклонил статус заказа", () => {
  test("invalid_status — понятное сообщение, а не «проверьте сервер»", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const order = { id: "ord_1", channel: "whatsapp", status: "new", customerName: "Айгерим", items: [], createdAt: "2026-10-01T10:00:00Z" };
    mockFetch(
      routes({
        "GET /api/orders": (url) => (url.includes("kind=") ? { items: [order], nextCursor: null, counts: { all: 1 } } : [order]),
        "PATCH /api/orders/ord_1": jsonResponse({ error: "invalid_status", message: "Неизвестный статус заказа" }, 400),
      })
    );
    render(
      <>
        <Dashboard onLogout={() => {}} />
        <DialogHost />
      </>
    );
    openTab("Заказы");
    const select = await screen.findByRole("combobox", { name: "Статус заказа" });
    fireEvent.change(select, { target: { value: "in_progress" } });
    await screen.findByText(/Такого статуса заказа нет — обновите страницу/);
  });
});

describe("HIGH-07: товары в админке", () => {
  test("сбой загрузки, есть копия — баннер с датой копии, создание, правка и удаление заблокированы", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const savedAt = new Date(2026, 9, 1, 12, 30).getTime();
    localStorage.setItem("bazis_products_cache", JSON.stringify({ savedAt, products: [PRODUCT] }));
    mockFetch(routes({ "GET /api/products": jsonResponse({ error: "server_error" }, 500) }));
    render(<Dashboard onLogout={() => {}} />);
    openTab("Товары");
    await screen.findByText(/Данные не загружены, показана копия от 01\.10\.2026/);
    expect(screen.getByText("Экспресс-аудит")).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ Новый товар" }).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Выбрать" }).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Удалить" }).disabled).toBe(true);
  });

  test("сбой загрузки без копии — ошибка и «Повторить», списка нет; после успешной загрузки — правка доступна", async () => {
    let fail = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch(routes({ "GET /api/products": () => (fail ? new TypeError("Failed to fetch") : jsonResponse([PRODUCT])) }));
    render(<Dashboard onLogout={() => {}} />);
    openTab("Товары");
    await screen.findByText(/Не удалось загрузить товары с сервера/);
    expect(screen.queryByText("Экспресс-аудит")).toBeNull();
    expect(screen.queryByText(/Пока нет товаров/)).toBeNull();
    expect(screen.getByRole("button", { name: "+ Новый товар" }).disabled).toBe(true);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await screen.findByText("Экспресс-аудит");
    await waitFor(() => expect(screen.getByRole("button", { name: "+ Новый товар" }).disabled).toBe(false));
    expect(screen.getByRole("button", { name: "Выбрать" }).disabled).toBe(false);
  });

  test("каталог по умолчанию в админке не показывается", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch(routes({ "GET /api/products": jsonResponse({ error: "server_error" }, 500) }));
    render(<Dashboard onLogout={() => {}} />);
    openTab("Товары");
    await screen.findByText(/Не удалось загрузить товары с сервера/);
    expect(document.querySelectorAll(".admin-product")).toHaveLength(0);
  });
});
