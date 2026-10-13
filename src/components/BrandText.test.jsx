import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import BrandText from "./BrandText.jsx";

function html(text) {
  const { container, unmount } = render(
    <p>
      <BrandText>{text}</BrandText>
    </p>
  );
  const result = container.querySelector("p").innerHTML;
  unmount();
  return result;
}

describe("BrandText: название бренда в подписях с text-transform", () => {
  test("название бренда — в отдельном span, остальной текст как есть", () => {
    expect(html("Блог Dinara BILab Медиа")).toBe('Блог <span class="brand-name">Dinara BILab</span> Медиа');
    expect(html("Dinara BILab")).toBe('<span class="brand-name">Dinara BILab</span>');
  });

  test("без названия бренда — обычный текст", () => {
    expect(html("Как работаем")).toBe("Как работаем");
    expect(html(undefined)).toBe("");
  });
});
