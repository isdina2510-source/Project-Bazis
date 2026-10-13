import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { CONTACT_PHONE, getTelegramProfileUrl } from "../lib/catalog.js";
import ChatText from "./ChatText.jsx";

const TG = getTelegramProfileUrl();
const WA = "https://wa.me/" + CONTACT_PHONE;

function hrefs(text) {
  const { container, unmount } = render(<ChatText text={text} />);
  const result = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
  unmount();
  return result;
}

describe("ChatText: ссылки в ответе ИИ", () => {
  test("выдуманный Telegram и WhatsApp заменяются нашими контактами", () => {
    expect(hrefs("Пишите: https://t.me/bazis или https://wa.me/79990000000")).toEqual([TG, WA]);
    expect(hrefs("https://bazis.t.me https://telegram.me/x https://telegram.dog/x")).toEqual([TG, TG, TG]);
    expect(hrefs("https://api.whatsapp.com/send?phone=7999 https://web.whatsapp.com/")).toEqual([WA, WA]);
  });

  test("адрес мессенджера без https:// тоже становится нашей ссылкой", () => {
    expect(hrefs("Напишите в t.me/bazis или wa.me/79990000000")).toEqual([TG, WA]);
  });

  test("мессенджер внутри «цитаты» и **акцента**", () => {
    expect(hrefs("«https://t.me/bazis» и **t.me/bazis**")).toEqual([TG, TG]);
  });

  test("знаки после ссылки остаются текстом", () => {
    render(<ChatText text={"Пишите (https://t.me/bazis). Или https://example.kz/page, спасибо!"} />);
    const links = screen.getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([TG, "https://example.kz/page"]);
    expect(links[0].parentElement.textContent).toBe("Пишите (" + TG + "). Или https://example.kz/page, спасибо!");
  });

  test("остальные ссылки не меняются; похожие домены не трогаем", () => {
    expect(hrefs("https://example.kz/page http://127.0.0.1:8787/ru/shop")).toEqual([
      "https://example.kz/page",
      "http://127.0.0.1:8787/ru/shop",
    ]);
    expect(hrefs("сайт chat.me/x и ottawa.me/y")).toEqual([]);
  });
});
