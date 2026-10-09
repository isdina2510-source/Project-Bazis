import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { jsonResponse, mockFetch } from "../test/fetch-mock.js";
import { CompanyImage } from "./CompanySection.jsx";

describe("LOW-13: предпросмотр печати и подписи", () => {
  test("файл есть, но предпросмотр не загрузился — отдельное состояние с «Повторить», а не «Не загружена»", async () => {
    let fail = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    URL.createObjectURL = vi.fn(() => "blob:stamp");
    URL.revokeObjectURL = vi.fn();
    mockFetch({
      "GET /api/settings/company/stamp": () =>
        fail ? jsonResponse({ error: "server_error" }, 500) : new Response("png", { headers: { "Content-Type": "image/png" } }),
    });
    render(<CompanyImage kind="stamp" file="stamp.png" onChanged={() => {}} />);
    await screen.findByText(/Не удалось загрузить предпросмотр/);
    expect(screen.queryByText("Не загружена")).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    const img = await screen.findByRole("img");
    expect(img.getAttribute("src")).toBe("blob:stamp");
  });

  test("файла нет — «Не загружена» без запроса к серверу", () => {
    const fetchMock = mockFetch({});
    render(<CompanyImage kind="signature" file="" onChanged={() => {}} />);
    expect(screen.getByText("Не загружена")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
