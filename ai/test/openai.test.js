const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { createOpenAiProvider } = require("../providers/openai");

function startFakeApi(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => handler(JSON.parse(raw || "{}"), res));
    });
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
      resolve({
        url,
        close: () =>
          new Promise((r) => {
            server.close(r);
            server.closeAllConnections();
          }),
      });
    });
  });
}

test("openai: успешный ответ и параметры запроса", async (t) => {
  let sent = null;
  const api = await startFakeApi((body, res) => {
    sent = body;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "  привет  " } }] }));
  });
  t.after(api.close);
  const provider = createOpenAiProvider({ OPENAI_API_KEY: "k", BAZIS_AI_URL: api.url });
  const text = await provider.chat({ messages: [{ role: "user", content: "hi" }], temperature: 0.7, maxTokens: 50 });
  assert.equal(text, "привет");
  assert.equal(sent.model, "gpt-4o-mini");
  assert.equal(sent.temperature, 0.7);
  assert.equal(sent.max_tokens, 50);
});

test("openai: 429 помечается повторяемой ошибкой с Retry-After", async (t) => {
  const api = await startFakeApi((_, res) => {
    res.writeHead(429, { "Retry-After": "2" });
    res.end("{}");
  });
  t.after(api.close);
  const provider = createOpenAiProvider({ OPENAI_API_KEY: "k", BAZIS_AI_URL: api.url });
  await assert.rejects(provider.chat({ messages: [] }), (err) => {
    assert.equal(err.status, 429);
    assert.equal(err.retryable, true);
    assert.equal(err.retryAfterMs, 2000);
    return true;
  });
});

test("openai: 401 (неверный ключ) не повторяется", async (t) => {
  const api = await startFakeApi((_, res) => {
    res.writeHead(401);
    res.end("{}");
  });
  t.after(api.close);
  const provider = createOpenAiProvider({ OPENAI_API_KEY: "k", BAZIS_AI_URL: api.url });
  await assert.rejects(provider.chat({ messages: [] }), (err) => err.status === 401 && !err.retryable);
});

test("openai: пустой ответ (фильтр контента) не повторяется", async (t) => {
  const api = await startFakeApi((_, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: null }, finish_reason: "content_filter" }] }));
  });
  t.after(api.close);
  const provider = createOpenAiProvider({ OPENAI_API_KEY: "k", BAZIS_AI_URL: api.url });
  await assert.rejects(provider.chat({ messages: [] }), (err) => {
    assert.equal(err.status, 502);
    assert.ok(!err.retryable);
    assert.match(err.detail, /content_filter/);
    return true;
  });
});

test("openai: таймаут по сигналу превращается в 504", async (t) => {
  const api = await startFakeApi(() => {});
  t.after(api.close);
  const provider = createOpenAiProvider({ OPENAI_API_KEY: "k", BAZIS_AI_URL: api.url });
  await assert.rejects(provider.chat({ messages: [], signal: AbortSignal.timeout(50) }), { code: "timeout", status: 504 });
});

test("openai: без ключа провайдер не настроен", () => {
  assert.equal(createOpenAiProvider({}).configured, false);
});
