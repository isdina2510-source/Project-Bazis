const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { createClientErrorsHandler, sanitizeClientError } = require("../client-errors");

test("HIGH-02: отчёт из браузера — без e-mail, телефонов, строки запроса; сайт только из списка", () => {
  const report = sanitizeClientError(
    {
      message: "Ошибка у ivan@example.com",
      stack: Array.from({ length: 30 }, (_, i) => "at line" + i).join("\n"),
      path: "/kk/shop/ord_12345678901?phone=77011234567",
      site: "evil",
      userAgent: "UA " + "x".repeat(500),
      build: "bad build!",
    },
    { siteIds: new Set(["bazis"]) }
  );
  assert.equal(report.message, "Ошибка у [e-mail]");
  assert.equal(report.stack.split("\n").length, 12);
  assert.equal(report.path, "/kk/shop/:id");
  assert.equal(report.site, "");
  assert.ok(report.userAgent.length <= 200);
  assert.equal(report.build, "");
  assert.equal(sanitizeClientError({ message: "" }, { siteIds: [] }), null);
});

test("HIGH-02: ключ оповещения — по тексту ошибки (повтор отсекает антиспам notifier.alert), адреса нет нигде", async () => {
  const alerts = [];
  const spy = { alert: (key, text) => alerts.push({ key, text }) };
  const logs = [];
  const handle = createClientErrorsHandler({
    readJsonObject: async (req) => JSON.parse(req.body),
    sendJson: (res, status, body) => res.end(status, body),
    isJsonRequest: () => true,
    clientIp: () => "203.0.113.5",
    checkRateLimit: () => true,
    notifier: spy,
    siteIds: new Set(["bazis"]),
    log: { error: (line) => logs.push(line) },
  });
  const call = async (message) => {
    const req = Object.assign(Readable.from([]), { method: "POST", body: JSON.stringify({ message, site: "bazis" }) });
    const res = { status: 0, writeHead(status) { this.status = status; }, end() {} };
    await handle(req, res);
    return res.status;
  };
  assert.equal(await call("TypeError: a"), 204);
  assert.equal(await call("TypeError: a"), 204);
  assert.equal(await call("TypeError: b"), 204);
  assert.equal(alerts[0].key, alerts[1].key, "ключ антиспама — по тексту ошибки");
  assert.notEqual(alerts[0].key, alerts[2].key);
  assert.ok(logs.every((line) => !line.includes("203.0.113.5")), "адрес не в журнале");
  assert.ok(alerts.every(({ text }) => !text.includes("203.0.113.5")), "адрес не в оповещении");
});
