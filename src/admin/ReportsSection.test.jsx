import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import ReportsSection from "./ReportsSection.jsx";

const ORDER = {
  id: "o1",
  kind: "order",
  status: "new",
  channel: "whatsapp",
  customerName: "Айгерим",
  customerPhone: "77010000000",
  createdAt: new Date().toISOString(),
  items: [{ id: "p1", title: "Аудит", qty: 1, price: 1000, currency: "KZT", kind: "service" }],
};

describe("HIGH-06: отчёт «Клиенты» при ошибке загрузки клиентов", () => {
  test("предупреждение вместо молчаливого отчёта по одним заказам, выгрузка заблокирована", () => {
    render(<ReportsSection orders={[ORDER]} clients={[]} products={[]} loadError={false} clientsError onRefresh={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: /Клиенты/ }));
    expect(screen.getByText(/Не удалось загрузить карточки клиентов/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "CSV" }).disabled).toBe(true);
  });

  test("клиенты загружены — предупреждения нет", () => {
    render(<ReportsSection orders={[ORDER]} clients={[]} products={[]} loadError={false} onRefresh={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: /Клиенты/ }));
    expect(screen.queryByText(/Не удалось загрузить карточки клиентов/)).toBeNull();
  });
});
