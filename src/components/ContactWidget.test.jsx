import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { I18nProvider } from "../i18n/I18nProvider.jsx";

const setChatOpen = vi.fn();
vi.mock("../store/StoreContext.jsx", async () => {
  const { useState } = await import("react");
  return {
    useStore: () => {
      const [messengerOpen, setMessengerOpen] = useState(false);
      return { chatOpen: false, setChatOpen, messengerOpen, setMessengerOpen };
    },
  };
});
vi.mock("../lib/order-proof.js", () => ({ warmOrderProof: async () => {} }));
const sendChatLead = vi.fn();
const sendContactLead = vi.fn();
vi.mock("../chat/handoff-lead.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sendChatLead: (...args) => sendChatLead(...args),
  sendContactLead: (...args) => sendContactLead(...args),
}));

const { default: ContactWidget } = await import("./ContactWidget.jsx");
const { resetChatSession, updateChatSession } = await import("../chat/chat-session.js");

function renderWidget() {
  render(
    <I18nProvider lang="ru">
      <ContactWidget />
    </I18nProvider>
  );
  fireEvent.click(screen.getByRole("button", { name: "Написать в WhatsApp или Telegram" }));
}

afterEach(() => {
  act(() => resetChatSession());
  sendChatLead.mockClear();
  sendContactLead.mockClear();
  setChatOpen.mockClear();
});

describe("кнопка связи отдельно от ИИ-чата", () => {
  test("без переписки с ИИ — форма открывается сразу, заявка уходит без диалога", () => {
    renderWidget();
    expect(setChatOpen).toHaveBeenCalledWith(false);
    const nameInput = screen.getByPlaceholderText("Как к вам обращаться");
    expect(document.activeElement).toBe(nameInput);

    const tg = screen.getByRole("link", { name: "Telegram" });
    expect(screen.getByRole("link", { name: "WhatsApp" }).getAttribute("href")).toMatch(/^https:\/\/wa\.me\/\d+\?text=/);
    // false — переход по ссылке отменён (preventDefault), пока нет контактов.
    expect(fireEvent.click(tg)).toBe(false);
    expect(screen.getByRole("alert").textContent).toBe("Укажите, как к вам обращаться.");

    fireEvent.change(nameInput, { target: { value: "Айгерим" } });
    fireEvent.change(screen.getByPlaceholderText("+7 (___) ___-__-__"), { target: { value: "7011234567" } });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(fireEvent.click(tg)).toBe(true);
    expect(sendChatLead).not.toHaveBeenCalled();
    expect(sendContactLead).toHaveBeenCalledTimes(1);
    expect(sendContactLead.mock.calls[0][1]).toMatchObject({
      channel: "telegram",
      customerName: "Айгерим",
      customerPhone: "+7 (701) 123-45-67",
      consent: true,
    });
  });

  test("после переписки с ИИ просит контакты и отправляет заявку с диалогом", () => {
    const history = [
      { id: 1, role: "bot", text: "Здравствуйте!", attachments: [] },
      { id: 2, role: "user", text: "Сколько стоит сайт? Мой номер +7 701 123 45 67", attachments: [] },
    ];
    act(() => updateChatSession({ history, lastUserText: "Сколько стоит сайт?", direction: "sites" }));
    renderWidget();

    const wa = screen.getByRole("link", { name: "WhatsApp" });
    expect(decodeURIComponent(wa.getAttribute("href"))).toContain("Сколько стоит сайт?");
    expect(screen.getByPlaceholderText("+7 (___) ___-__-__").value).toBe("+7 (701) 123-45-67");

    expect(fireEvent.click(wa)).toBe(false);
    expect(screen.getByRole("alert").textContent).toBe("Укажите, как к вам обращаться.");

    fireEvent.change(screen.getByPlaceholderText("Как к вам обращаться"), { target: { value: "Айгерим" } });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(fireEvent.click(wa)).toBe(true);
    expect(sendContactLead).not.toHaveBeenCalled();
    expect(sendChatLead).toHaveBeenCalledTimes(1);
    expect(sendChatLead.mock.calls[0][1]).toMatchObject({
      history,
      channel: "whatsapp",
      direction: "sites",
      customerName: "Айгерим",
      customerPhone: "+7 (701) 123-45-67",
      consent: true,
    });
  });
});
