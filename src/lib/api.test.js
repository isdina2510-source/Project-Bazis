import { afterEach, describe, expect, test, vi } from "vitest";
import { jsonResponse, mockFetch } from "../test/fetch-mock.js";
import { apiGetWithRetry, retryPolicy } from "./api.js";

/** Ответы по очереди: Error — сбой сети, число — статус, остальное — JSON 200. */
function sequence(...steps) {
  let i = 0;
  return () => {
    const step = steps[Math.min(i++, steps.length - 1)];
    if (step instanceof Error) return step;
    if (typeof step === "number") return jsonResponse({ error: "x" }, step);
    return jsonResponse(step);
  };
}

const calls = (fetchMock) => fetchMock.mock.calls.filter(([url]) => url === "/api/products").length;

function setVisibility(state) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

afterEach(() => {
  delete document.visibilityState;
});

describe("GET с повторами (каталог, примеры работ)", () => {
  test("первый запрос оборвался (Safari «Load failed»), второй успешен — ответ без ошибки", async () => {
    const fetchMock = mockFetch({ "GET /api/products": sequence(new TypeError("Load failed"), [{ id: "p1" }]) });
    const res = await apiGetWithRetry("/api/products");
    expect(await res.json()).toEqual([{ id: "p1" }]);
    expect(calls(fetchMock)).toBe(2);
  });

  test("502/503/504 повторяются, последний ответ возвращается как есть", async () => {
    const fetchMock = mockFetch({ "GET /api/products": sequence(502, 503, 504) });
    const res = await apiGetWithRetry("/api/products");
    expect(res.status).toBe(504);
    expect(calls(fetchMock)).toBe(3);
  });

  test("404 и 500 не повторяются", async () => {
    const fetchMock = mockFetch({ "GET /api/products": sequence(500, [{ id: "p1" }]) });
    const res = await apiGetWithRetry("/api/products");
    expect(res.status).toBe(500);
    expect(calls(fetchMock)).toBe(1);
  });

  test("сеть так и не ответила — network_error с исходной ошибкой и числом попыток", async () => {
    const fetchMock = mockFetch({ "GET /api/products": new TypeError("Load failed") });
    const err = await apiGetWithRetry("/api/products").catch((e) => e);
    expect(err.code).toBe("network");
    expect(err.message).toBe("network_error");
    expect(err.cause.message).toBe("Load failed");
    expect(err.attempts).toBe(retryPolicy.delaysMs.length + 1);
    expect(calls(fetchMock)).toBe(3);
  });

  test("нет ответа дольше таймаута — повтор", async () => {
    const saved = retryPolicy.timeoutMs;
    retryPolicy.timeoutMs = 20;
    try {
      let first = true;
      mockFetch({
        "GET /api/products": (url, init) => {
          if (!first) return jsonResponse([{ id: "p1" }]);
          first = false;
          return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
        },
      });
      const res = await apiGetWithRetry("/api/products");
      expect(res.status).toBe(200);
    } finally {
      retryPolicy.timeoutMs = saved;
    }
  });

  test("вкладка в фоне — повтор ждёт, пока её снова откроют", async () => {
    setVisibility("hidden");
    const fetchMock = mockFetch({ "GET /api/products": sequence(new TypeError("Load failed"), [{ id: "p1" }]) });
    const pending = apiGetWithRetry("/api/products");
    await vi.waitFor(() => expect(calls(fetchMock)).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls(fetchMock)).toBe(1);
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect((await pending).status).toBe(200);
    expect(calls(fetchMock)).toBe(2);
  });

  test("отмена (уход со страницы) — aborted, без повторов", async () => {
    const controller = new AbortController();
    const fetchMock = mockFetch({
      "GET /api/products": () => {
        controller.abort();
        throw new TypeError("Load failed");
      },
    });
    const err = await apiGetWithRetry("/api/products", { signal: controller.signal }).catch((e) => e);
    expect(err.code).toBe("aborted");
    expect(calls(fetchMock)).toBe(1);
  });
});
