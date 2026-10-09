import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { mockFetch } from "../test/fetch-mock.js";

let loginShouldThrow = true;
vi.mock("./LoginView.jsx", () => ({
  default: () => {
    if (loginShouldThrow) throw new Error("login view crashed");
    return <p>Форма входа</p>;
  },
}));

const { default: AdminApp } = await import("./AdminApp.jsx");

describe("HIGH-02: ErrorBoundary всей админки", () => {
  test("упавшая админка показывает текст ошибки и «Обновить раздел»", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch({ "POST /api/client-errors": new Response(null, { status: 204 }) });
    render(<AdminApp />);
    expect(screen.getByText("login view crashed")).toBeTruthy();
    loginShouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "Обновить раздел" }));
    expect(screen.getByText("Форма входа")).toBeTruthy();
  });
});
