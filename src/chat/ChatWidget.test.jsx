import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { I18nProvider } from "../i18n/I18nProvider.jsx";
import { clientErrorReports, mockFetch } from "../test/fetch-mock.js";

vi.mock("../store/StoreContext.jsx", () => ({
  useStore: () => ({ products: [], chatOpen: true, setChatOpen: () => {} }),
}));
vi.mock("./cloud.js", () => ({ consultCloud: async () => null }));
vi.mock("./consult.js", async (importOriginal) => ({
  ...(await importOriginal()),
  consultOffline: () => {
    throw new Error("offline consult crashed");
  },
}));

const { default: ChatWidget } = await import("./ChatWidget.jsx");

describe("LOW-16: сбой в чате не проглатывается молча", () => {
  test("ошибка при ответе — посетитель видит сообщение, а ошибка уходит на сервер", async () => {
    const fetchMock = mockFetch({ "POST /api/client-errors": new Response(null, { status: 204 }) });
    render(
      <I18nProvider lang="ru">
        <ChatWidget />
      </I18nProvider>
    );
    fireEvent.change(screen.getByPlaceholderText(/./), { target: { value: "Сколько стоит аудит?" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await screen.findByText(/Не удалось разобрать сообщение/);
    expect(clientErrorReports(fetchMock).map((r) => r.message)).toEqual(["[chat] Error: offline consult crashed"]);
  });
});
