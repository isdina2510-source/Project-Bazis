const test = require("node:test");
const assert = require("node:assert/strict");
const { createSandbox, startServer } = require("./server-sandbox");

let sandbox;
let server;
test.before(async () => {
  sandbox = createSandbox();
  server = await startServer(sandbox);
});
test.after(async () => {
  if (server) await server.stop();
  sandbox.cleanup();
});

const post = (body, { headers = {}, ip } = {}) =>
  fetch(server.url + "/api/client-errors", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(ip ? { "X-Forwarded-For": ip } : {}), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("HIGH-02: POST /api/client-errors — 204 без тела, в журнале ошибка без личных данных и без адреса", async () => {
  const res = await post(
    {
      message: "[boundary:store] TypeError: заказ для ivan@example.com, +7 701 123 45 67 не найден",
      stack: "TypeError: x\n    at https://bazis.kz/assets/index.js?token=SECRET123:1:200\n    at f (+7 701 123 45 67)",
      path: "/ru/shop?phone=77011234567&utm=1",
      site: "bazis",
      userAgent: "Mozilla/5.0 Test",
      build: "20261009T1530",
    },
    { ip: "203.0.113.77" }
  );
  assert.equal(res.status, 204);
  assert.equal(await res.text(), "");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const log = server.output();
  const line = log.split("\n").find((l) => l.includes("[client-error]"));
  assert.ok(line, log);
  assert.match(line, /TypeError: заказ для \[e-mail\], \[номер\] не найден/);
  assert.match(line, /bazis, \/ru\/shop, сборка 20261009T1530/);
  assert.doesNotMatch(log, /ivan@example\.com|701 123 45 67|77011234567|SECRET123|203\.0\.113\.77/);
});

test("HIGH-02: тело больше 8 КБ — 413; не JSON — 415; без текста ошибки — 400", async () => {
  const big = await post({ message: "x", stack: "y".repeat(9 * 1024) }, { ip: "203.0.113.1" });
  assert.equal(big.status, 413);
  const text = await post("message=x", { headers: { "Content-Type": "text/plain" }, ip: "203.0.113.1" });
  assert.equal(text.status, 415);
  const empty = await post({ message: "  " }, { ip: "203.0.113.1" });
  assert.equal(empty.status, 400);
});

test("HIGH-02: лимит по адресу — 11-й отчёт за минуту получает 429, другой адрес — нет", async () => {
  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await post({ message: "e" + i }, { ip: "198.51.100.9" })).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(204));
  assert.equal(statuses[10], 429);
  assert.equal((await post({ message: "other" }, { ip: "198.51.100.10" })).status, 204);
});
