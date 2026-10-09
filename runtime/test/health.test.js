const test = require("node:test");
const assert = require("node:assert/strict");
const { createHealthHandler } = require("../health");

/** Обработчик с поддельными зависимостями: ответы складываются в массив, лимит — простой счётчик. */
function setup({ ping, limit = 3 } = {}) {
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
  });
  const get = (ip = "198.51.100.1", method = "GET") => handle({ method, ip }, {});
  return { replies, logged, get };
}

test("MED-12: база отвечает — 200 { ok: true, db: ok, uptime, version }", () => {
  const { replies, get } = setup({ ping: () => true });
  get();
  assert.deepEqual(replies, [{ status: 200, body: { ok: true, db: "ok", uptime: 12, version: "2.0.0" } }]);
});

test("MED-12: база не отвечает — 503 { ok: false, db: error } без текста ошибки; причина в журнале один раз", () => {
  const { replies, logged, get } = setup({
    ping: () => {
      throw new Error("database is not open: C:\\secret\\data\\bazis.db");
    },
  });
  get();
  get();
  assert.deepEqual(replies.map((r) => r.status), [503, 503]);
  assert.deepEqual(replies[0].body, { ok: false, db: "error" });
  assert.equal(logged.length, 1);
  assert.match(logged[0], /database is not open/);

  const falsy = setup({ ping: () => false });
  falsy.get();
  assert.deepEqual(falsy.replies[0], { status: 503, body: { ok: false, db: "error" } });
});

test("MED-12: лимит запросов по адресу — 429; другой адрес не затронут; не GET — 405", () => {
  const { replies, get } = setup({ ping: () => true, limit: 2 });
  get("203.0.113.5");
  get("203.0.113.5");
  get("203.0.113.5");
  get("203.0.113.6");
  get("203.0.113.6", "POST");
  assert.deepEqual(replies.map((r) => r.status), [200, 200, 429, 200, 405]);
});
