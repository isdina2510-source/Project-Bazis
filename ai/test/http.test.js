const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { createAiCore, createAiHttpHandler, loadAiConfig } = require("..");
const { createDailyCounter } = require("../http");

const FAST = { ...loadAiConfig({}), retryBaseMs: 1, retryMaxMs: 5, deadlineMs: 2000, log: false };

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req, maxBytes = 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on("data", (c) => {
      if (rejected) return;
      size += c.length;
      if (size > maxBytes) {
        rejected = true;
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (rejected) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function checkRateLimit(buckets, key, limit) {
  const count = (buckets.get(key) || 0) + 1;
  buckets.set(key, count);
  return count <= limit;
}

async function startApp(t, providerImpl, features, limit = 100) {
  const seen = { signals: [] };
  const ai = createAiCore({
    provider: {
      name: "fake",
      configured: true,
      model: "m",
      chat: (args) => {
        seen.signals.push(args.signal);
        return providerImpl(args);
      },
    },
    features,
    config: FAST,
  });
  const handle = createAiHttpHandler(ai, {
    sendJson,
    readBody,
    clientIp: () => "127.0.0.1",
    checkRateLimit,
    requireAdmin: (req, res) => {
      if (req.headers["x-admin-password"] === "secret") return true;
      sendJson(res, 401, { error: "unauthorized" });
      return false;
    },
    rateLimit: { limit, windowMs: 60000 },
  });
  const server = http.createServer((req, res) => handle(req, res, req.url.split("/")[3] || null));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/ai`;
  return { base, seen, ai };
}

const echo = {
  name: "echo",
  buildMessages: (input) => [{ role: "user", content: String(input.text || "") }],
};
const adminOnly = { ...echo, name: "secret-tool", access: "admin" };

async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

test("http: успешный запрос, X-Request-Id и статус фич", async (t) => {
  const { base } = await startApp(t, async () => "ответ", [echo, adminOnly]);
  const ok = await post(base + "/echo", { text: "hi" });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { text: "ответ" });
  assert.match(ok.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);

  const status = await (await fetch(base)).json();
  assert.deepEqual(
    status.features.map((f) => [f.name, f.access]),
    [["echo", "public"], ["secret-tool", "admin"]]
  );
});

test("http: ошибки запроса", async (t) => {
  const { base } = await startApp(t, async () => "ok", [echo]);
  assert.equal((await post(base + "/nope", {})).status, 404);
  assert.equal((await post(base + "/echo", "{oops")).body.error, "invalid_json");
  assert.equal((await post(base + "/echo", { text: "x".repeat(2000) })).status, 413);
  assert.equal((await fetch(base + "/echo", { method: "DELETE" })).status, 405);
  assert.equal((await fetch(base, { method: "POST" })).status, 405);
});

test("http: админские фичи и _health требуют пароль", async (t) => {
  const { base } = await startApp(t, async () => "ok", [adminOnly]);
  assert.equal((await post(base + "/secret-tool", {})).status, 401);
  assert.equal((await post(base + "/secret-tool", {}, { "X-Admin-Password": "secret" })).status, 200);
  assert.equal((await fetch(base + "/_health")).status, 401);
  const health = await (await fetch(base + "/_health", { headers: { "X-Admin-Password": "secret" } })).json();
  assert.equal(health.breaker.state, "closed");
  assert.equal(health.limiter.active, 0);
});

test("суточный счётчик не обнуляет уже набранные лимиты при переполнении", () => {
  const hit = createDailyCounter(1, 2);
  assert.equal(hit("a"), true);
  assert.equal(hit("b"), true);
  assert.equal(hit("c"), false, "новый адрес сверх ёмкости не получает свежую квоту");
  assert.equal(hit("a"), false, "адрес, который лимит уже выбрал, не обнуляется");
  assert.equal(hit("b"), false);
});

test("http: лимит запросов отдаёт 429 с Retry-After", async (t) => {
  const { base } = await startApp(t, async () => "ok", [echo], 2);
  await post(base + "/echo", {});
  await post(base + "/echo", {});
  const limited = await post(base + "/echo", {});
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "rate_limited");
  assert.equal(limited.headers.get("retry-after"), "30");
});

test("http: закрытие соединения клиентом прерывает запрос к модели", async (t) => {
  let resolveStarted;
  const started = new Promise((r) => (resolveStarted = r));
  const { base, seen, ai } = await startApp(
    t,
    ({ signal }) => {
      resolveStarted();
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    },
    [echo]
  );
  const controller = new AbortController();
  const pending = fetch(base + "/echo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: controller.signal,
  }).catch(() => null);
  await started;
  controller.abort();
  await pending;
  for (let i = 0; i < 50 && !seen.signals[0].aborted; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen.signals[0].aborted, true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ai.health().limiter.active, 0, "слот очереди освобождён");
  assert.equal(ai.health().breaker.failures, 0, "уход клиента не считается сбоем провайдера");
});
