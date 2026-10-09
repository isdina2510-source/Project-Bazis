import { vi } from "vitest";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * fetch по таблице маршрутов: { "GET /api/products": [..] | Response | (url, init) => Response | Error }.
 * Путь сравнивается без строки запроса. Неизвестный маршрут — 404. Возвращает vi.fn — calls для проверок.
 */
export function mockFetch(routes) {
  const fn = vi.fn(async (input, init = {}) => {
    const url = String(input);
    const method = String(init.method || "GET").toUpperCase();
    const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const route = routes[method + " " + path];
    if (route === undefined) return json({ error: "not_found" }, 404);
    const value = typeof route === "function" ? await route(url, init) : route;
    if (value instanceof Error) throw value;
    if (value instanceof Response) return value;
    return json(value);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

export const jsonResponse = json;

/** Тела отправленных отчётов об ошибках. */
export function clientErrorReports(fetchMock) {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).includes("/api/client-errors"))
    .map(([, init]) => JSON.parse(init.body));
}
