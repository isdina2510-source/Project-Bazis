const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createSandbox, startServer } = require("./server-sandbox");

/** Запрос с заданным Host (fetch его не даёт подменить). */
function get(server, path, host) {
  const { port } = new URL(server.url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers: { Host: host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Строки журнала после «Базис CRM:» приходят чуть позже — ждём строку про медиасайт. */
async function waitForOutput(server, re, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (!re.test(server.output()) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
}

async function withServer(env, fn) {
  const sandbox = createSandbox();
  const server = await startServer(sandbox, env);
  await waitForOutput(server, /^Медиасайт: /m);
  await waitForOutput(server, /^База данных/m);
  try {
    await fn(server);
  } finally {
    await server.stop();
    sandbox.cleanup();
  }
}

test("HIGH-09: медиасайт выключен по умолчанию — его домены получают 404 (и страницы, и API), основной сайт работает", async () => {
  await withServer({}, async (server) => {
    assert.match(server.output(), /^Медиасайт: выключен$/m);
    assert.doesNotMatch(server.output(), /Сайт «Базис Медиа»/);
    for (const path of ["/", "/ru/shop", "/admin.html"]) {
      const page = await get(server, path, "media.localhost");
      assert.equal(page.status, 404, path);
      assert.match(page.headers["content-type"], /text\/html/);
      assert.match(page.body, /Сайт «Базис Медиа» сейчас не работает/);
      assert.match(page.body, /<meta name="robots" content="noindex">/);
      assert.match(page.body, /href="http:\/\/127\.0\.0\.1:\d+\/"/);
    }
    const api = await get(server, "/api/products", "media.localhost:8787");
    assert.equal(api.status, 404);
    assert.equal(JSON.parse(api.body).error, "site_disabled");
    const main = await get(server, "/api/products", "127.0.0.1");
    assert.equal(main.status, 200);
  });
});

test("HIGH-09: MEDIA_SITE_ENABLED=true — медиасайт отвечает как раньше", async () => {
  await withServer({ MEDIA_SITE_ENABLED: "true" }, async (server) => {
    assert.match(server.output(), /^Медиасайт: включён$/m);
    assert.match(server.output(), /Сайт «Базис Медиа»: http:\/\/media\.localhost:/);
    const api = await get(server, "/api/products", "media.localhost");
    assert.equal(api.status, 200);
    assert.ok(Array.isArray(JSON.parse(api.body)));
  });
});
