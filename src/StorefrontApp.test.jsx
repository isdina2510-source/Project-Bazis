import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";
import { clientErrorReports, mockFetch } from "./test/fetch-mock.js";

vi.mock("./i18n/routing.jsx", () => ({
  LangGate: () => {
    throw new Error("render failed");
  },
  RootGate: () => null,
  NearestSection: () => null,
}));

const { default: StorefrontApp } = await import("./StorefrontApp.jsx");

describe("HIGH-02: ErrorBoundary витрины", () => {
  test("страница упала — экран ошибки с перезагрузкой и контактами, ошибка ушла на сервер", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    window.history.replaceState(null, "", "/ru/shop");
    const fetchMock = mockFetch({
      "GET /api/products": [],
      "POST /api/client-errors": new Response(null, { status: 204 }),
    });
    render(
      <MemoryRouter initialEntries={["/ru/shop"]}>
        <StorefrontApp />
      </MemoryRouter>
    );
    expect(screen.getByRole("heading", { name: "Что-то пошло не так" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Обновить страницу" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Написать в WhatsApp" }).getAttribute("href")).toMatch(/^https:\/\/wa\.me\/\d+$/);
    expect(screen.getByRole("link", { name: "Написать в Telegram" }).getAttribute("href")).toMatch(/^https:\/\/t\.me\//);
    const reports = clientErrorReports(fetchMock);
    expect(reports.map((r) => r.message)).toContain("[boundary:store] Error: render failed");
  });

  test("тексты экрана ошибки — на языке страницы (kk)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    window.history.replaceState(null, "", "/kk/");
    mockFetch({ "GET /api/products": [], "POST /api/client-errors": new Response(null, { status: 204 }) });
    render(
      <MemoryRouter initialEntries={["/kk/"]}>
        <StorefrontApp />
      </MemoryRouter>
    );
    expect(screen.getByRole("heading", { name: "Бірдеңе дұрыс болмады" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Бетті жаңарту" })).toBeTruthy();
  });
});
