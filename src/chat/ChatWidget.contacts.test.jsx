import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { I18nProvider } from "../i18n/I18nProvider.jsx";
import { hasClientMessages } from "./handoff-transcript.js";

const setChatOpen = vi.fn();
const setMessengerOpen = vi.fn();
vi.mock("../store/StoreContext.jsx", () => ({
  useStore: () => ({ products: [], chatOpen: true, setChatOpen, setMessengerOpen }),
}));
vi.mock("./cloud.js", () => ({
  consultCloud: async () => ({ text: "Создание сайта стоит от 50 000 ₸.", handoff: true, offTopic: false, imageNotes: "", sig: "" }),
}));

const { default: ChatWidget } = await import("./ChatWidget.jsx");
const { useChatSession } = await import("./chat-session.js");

let session = null;
function SessionProbe() {
  session = useChatSession();
  return null;
}

function renderChat() {
  return render(
    <I18nProvider lang="ru">
      <ChatWidget />
      <SessionProbe />
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

describe("ИИ-чат отделён от кнопок связи", () => {
  test("в панели чата нет ссылок на мессенджеры и формы контактов", () => {
    renderChat();
    expect(screen.queryByRole("link", { name: /WhatsApp|Telegram/ })).toBeNull();
    expect(screen.queryByPlaceholderText("Как к вам обращаться")).toBeNull();
  });

  test("ответ ИИ появляется, а переписка доступна виджету связи", async () => {
    renderChat();
    const input = screen.getByPlaceholderText(/Напишите вопрос/);
    fireEvent.change(input, { target: { value: "Сколько стоит сайт?" } });
    fireEvent.submit(input.closest("form"));
    await screen.findByText(/от 50 000/);
    expect(screen.queryByText("Печатает...")).toBeNull();
    expect(hasClientMessages(session.history)).toBe(true);
    expect(session.lastUserText).toBe("Сколько стоит сайт?");
    await waitFor(() => expect(session.handoff).toBe(true));

    setChatOpen.mockClear();
    setMessengerOpen.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Написать в WhatsApp или Telegram" }));
    expect(setChatOpen).toHaveBeenCalledWith(false);
    expect(setMessengerOpen).toHaveBeenCalledWith(true);
  });

  test("«Связаться» сразу открывает кнопку связи, а не спрашивает ИИ", () => {
    renderChat();
    setChatOpen.mockClear();
    setMessengerOpen.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Связаться" }));
    expect(setChatOpen).toHaveBeenCalledWith(false);
    expect(setMessengerOpen).toHaveBeenCalledWith(true);
    expect(screen.queryByText("Хочу связаться с вами")).toBeNull();
  });
});
