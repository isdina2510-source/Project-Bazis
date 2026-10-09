import { describe, expect, test } from "vitest";
import { clientErrorReports, mockFetch } from "../test/fetch-mock.js";
import { MAX_REPORTS_PER_SESSION, installClientErrorReporting, reportClientError } from "./client-errors.js";
import { isChunkError, reloadOnceForChunkError } from "./chunk-errors.js";

describe("HIGH-02: отчёты об ошибках из браузера", () => {
  test("поля отчёта: сообщение, стек, путь, сайт, браузер, сборка", () => {
    const fetchMock = mockFetch({ "POST /api/client-errors": new Response(null, { status: 204 }) });
    expect(reportClientError(new TypeError("x is undefined"), { kind: "boundary:store" })).toBe(true);
    const [report] = clientErrorReports(fetchMock);
    expect(report.message).toBe("[boundary:store] TypeError: x is undefined");
    expect(report.stack).toContain("x is undefined");
    expect(report.path).toBe(location.pathname);
    expect(report.site).toBe("bazis");
    expect(report.build).toBe("test");
    expect(typeof report.userAgent).toBe("string");
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true);
  });

  test("одна и та же ошибка — один раз за сессию, всего не больше 5", () => {
    const fetchMock = mockFetch({ "POST /api/client-errors": new Response(null, { status: 204 }) });
    reportClientError(new Error("same"));
    reportClientError(new Error("same"));
    expect(clientErrorReports(fetchMock)).toHaveLength(1);
    for (let i = 0; i < 10; i++) reportClientError(new Error("other " + i));
    expect(clientErrorReports(fetchMock)).toHaveLength(MAX_REPORTS_PER_SESSION);
  });

  test("window.onerror и unhandledrejection отправляются; ошибки загрузки картинок — нет", () => {
    const fetchMock = mockFetch({ "POST /api/client-errors": new Response(null, { status: 204 }) });
    const target = new EventTarget();
    installClientErrorReporting(target);
    target.dispatchEvent(Object.assign(new Event("error"), { error: new Error("boom"), message: "boom" }));
    target.dispatchEvent(new Event("error"));
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new Error("rejected") }));
    const messages = clientErrorReports(fetchMock).map((r) => r.message);
    expect(messages).toEqual(["[onerror] Error: boom", "[unhandledrejection] Error: rejected"]);
  });

  test("сбой отправки отчёта не бросает исключение", () => {
    mockFetch({ "POST /api/client-errors": new TypeError("Failed to fetch") });
    expect(() => reportClientError(new Error("offline"))).not.toThrow();
  });
});

describe("HIGH-02: ошибка загрузки чанка — одна перезагрузка", () => {
  test("распознаёт ошибки загрузки модулей", () => {
    expect(isChunkError(new TypeError("Failed to fetch dynamically imported module: /assets/x.js"))).toBe(true);
    expect(isChunkError(new Error("x is undefined"))).toBe(false);
  });

  test("вторая перезагрузка в течение 5 минут не делается (защита от цикла)", () => {
    let reloads = 0;
    const reload = () => reloads++;
    const t0 = 1_000_000;
    expect(reloadOnceForChunkError(reload, t0)).toBe(true);
    expect(reloadOnceForChunkError(reload, t0 + 1000)).toBe(false);
    expect(reloads).toBe(1);
    expect(reloadOnceForChunkError(reload, t0 + 6 * 60 * 1000)).toBe(true);
    expect(reloads).toBe(2);
  });
});
