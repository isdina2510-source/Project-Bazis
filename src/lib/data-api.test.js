import { describe, expect, test } from "vitest";
import { listOrderDocuments } from "../admin/documents-api.js";
import { mockFetch } from "../test/fetch-mock.js";
import { listClients, listOrders, listOrdersPage } from "./orders-db.js";
import { fetchProducts, readCachedProducts, writeCachedProducts } from "./products-api.js";

const html = () => new Response("<!doctype html><title>502</title>", { status: 200, headers: { "Content-Type": "text/html" } });

describe("LOW-15: ответ не того вида — ошибка invalid_response, а не пустой список", () => {
  test("listClients: объект вместо массива", async () => {
    mockFetch({ "GET /api/clients": { clients: [] } });
    await expect(listClients()).rejects.toMatchObject({ code: "invalid_response" });
  });

  test("listOrders: объект вместо массива и HTML вместо JSON", async () => {
    mockFetch({ "GET /api/orders": { items: [] } });
    await expect(listOrders()).rejects.toMatchObject({ code: "invalid_response" });
    mockFetch({ "GET /api/orders": html });
    await expect(listOrders()).rejects.toMatchObject({ code: "invalid_response" });
  });

  test("listOrdersPage: нет items", async () => {
    mockFetch({ "GET /api/orders": { counts: {} } });
    await expect(listOrdersPage({ kind: "orders" })).rejects.toMatchObject({ code: "invalid_response" });
  });

  test("listOrderDocuments: объект вместо массива", async () => {
    mockFetch({ "GET /api/orders/o1/documents": { documents: [] } });
    await expect(listOrderDocuments("o1")).rejects.toMatchObject({ code: "invalid_response" });
  });

  test("fetchProducts: HTML вместо JSON", async () => {
    mockFetch({ "GET /api/products": html });
    await expect(fetchProducts()).rejects.toMatchObject({ code: "invalid_response" });
  });

  test("правильные ответы по-прежнему принимаются", async () => {
    mockFetch({
      "GET /api/clients": [{ id: "c1" }],
      "GET /api/orders": (url) => (url.includes("kind=") ? { items: [{ id: "o1" }], counts: { all: 1 } } : [{ id: "o1" }]),
    });
    await expect(listClients()).resolves.toEqual([{ id: "c1" }]);
    await expect(listOrdersPage({ kind: "orders" })).resolves.toMatchObject({ items: [{ id: "o1" }] });
  });
});

describe("HIGH-07 / MED-11: кэш каталога в браузере", () => {
  test("без кэша — null, а не каталог по умолчанию", () => {
    expect(readCachedProducts()).toBeNull();
  });

  test("кэш хранит дату сохранения", async () => {
    mockFetch({ "GET /api/products": [{ id: "p1", title: "Аудит", price: 1000, category: "management" }] });
    const before = Date.now();
    await fetchProducts();
    const cached = readCachedProducts();
    expect(cached.products.map((p) => p.id)).toEqual(["p1"]);
    expect(cached.savedAt).toBeGreaterThanOrEqual(before);
  });

  test("старый кэш без даты читается с savedAt: null", () => {
    localStorage.setItem("bazis_products", JSON.stringify([{ id: "p2", title: "Сайт", price: 5 }]));
    expect(readCachedProducts()).toMatchObject({ products: [{ id: "p2" }], savedAt: null });
    writeCachedProducts([{ id: "p3", title: "Новый" }], 123);
    expect(readCachedProducts()).toMatchObject({ products: [{ id: "p3" }], savedAt: 123 });
  });
});
