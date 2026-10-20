import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { I18nProvider } from "../i18n/I18nProvider.jsx";

vi.mock("../store/StoreContext.jsx", () => ({
  useStore: () => ({ products: [], chatOpen: true, setChatOpen: () => {} }),
}));
vi.mock("./cloud.js", () => ({
  consultCloud: async () => ({ text: "Создание сайта стоит от 50 000 ₸.", handoff: false, offTopic: false, imageNotes: "", sig: "" }),
}));
vi.mock("../lib/order-proof.js", () => ({ warmOrderProof: async () => {} }));

const { default: ChatWidget } = await import("./ChatWidget.jsx");

function renderChat() {
  return render(
    <I18nProvider lang="ru">
      <ChatWidget />
    </I18nProvider>
  );
}

beforeAll(() => {
  window.matchMedia =
    window.matchMedia ||
    ((query) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
    }));
});

describe("чат: переписка не вытесняется формой контактов", () => {
  test("форма контактов свёрнута и раскрывается по кнопке мессенджера без перехода", () => {
    renderChat();
    expect(screen.queryByPlaceholderText("Как к вам обращаться")).toBeNull();

    const wa = screen.getByRole("link", { name: "Продолжить в WhatsApp" });
    // false — переход по ссылке отменён (preventDefault).
    expect(fireEvent.click(wa)).toBe(false);
    expect(screen.getByPlaceholderText("Как к вам обращаться")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Свернуть" }));
    expect(screen.queryByPlaceholderText("Как к вам обращаться")).toBeNull();
  });

  test("ответ ИИ появляется, а индикатор набора исчезает", async () => {
    renderChat();
    const input = screen.getByPlaceholderText(/Напишите вопрос/);
    fireEvent.change(input, { target: { value: "Сколько стоит сайт?" } });
    fireEvent.submit(input.closest("form"));
    await screen.findByText(/от 50 000/);
    expect(screen.queryByText("Печатает...")).toBeNull();
  });
});
