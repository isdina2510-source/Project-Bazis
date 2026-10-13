const test = require("node:test");
const assert = require("node:assert/strict");
const { createHealthHandler } = require("../health");

/** Обработчик с поддельными зависимостями: ответы складываются в массив, лимит — простой счётчик. */
function setup({ ping, limit = 3, pingTimeoutMs } = {}) {
  const replies = [];
  const logged = [];
  const handle = createHealthHandler({
    ping,
    version: "2.0.0",
    uptime: () => 12.7,
    sendJson: (res, status, body) => replies.push({ status, body }),
    clientIp: (req) => req.ip,
    checkRateLimit: (buckets, ip, max) => {
      const count = (buckets.get(ip) || 0) + 1;
      buckets.set(ip, count);
      return count <= max;
    },
    log: { error: (text) => logged.push(text) },
    limit,
    pingTimeoutMs,
  });
  const get = (ip = "198.51.100.1", method = "GET") => handle({ method, ip }, {});
  return { replies, logged, get };
}

test("MED-12: база отвечает — 200 { ok: true, db: ok, uptime, version }", async () => {
  const { replies, get } = setup({ ping: async () => true });
  await get();
  assert.deepEqual(replies, [{ status: 200, body: { ok: true, db: "ok", uptime: 12, version: "2.0.0" } }]);
});

test("MED-12: база не отвечает — 503 { ok: false, db: error } без текста ошибки; причина в журнале один раз", async () => {
  const { replies, logged, get } = setup({
    ping: async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.5:5432 (postgres://bazis@secret-host/bazis)");
    },
  });
  await get();
  await get();
  assert.deepEqual(replies.map((r) => r.status), [503, 503]);
  assert.deepEqual(replies[0].body, { ok: false, db: "error" });
  assert.equal(logged.length, 1);
  assert.match(logged[0], /ECONNREFUSED/);

  const falsy = setup({ ping: () => false });
  await falsy.get();
  assert.deepEqual(falsy.replies[0], { status: 503, body: { ok: false, db: "error" } });
});

test("MED-12: зависшая база — 503 по таймауту, а не вечное ожидание", async () => {
  const { replies, logged, get } = setup({ ping: () => new Promise(() => {}), pingTimeoutMs: 30 });
  await get();
  assert.deepEqual(replies, [{ status: 503, body: { ok: false, db: "error" } }]);
  assert.match(logged[0], /не ответила за 30 мс/);
});

test("MED-12: лимит запросов по адресу — 429; другой адрес не затронут; не GET — 405", async () => {
  const { replies, get } = setup({ ping: () => true, limit: 2 });
  await get("203.0.113.5");
  await get("203.0.113.5");
  await get("203.0.113.5");
  await get("203.0.113.6");
  await get("203.0.113.6", "POST");
  assert.deepEqual(replies.map((r) => r.status), [200, 200, 429, 200, 405]);
});
