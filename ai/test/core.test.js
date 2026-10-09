const test = require("node:test");
const assert = require("node:assert/strict");
const { createAiCore, loadAiConfig, AiError } = require("..");
const { loadFeatures } = require("../features");

const FAST = { ...loadAiConfig({}), retryBaseMs: 1, retryMaxMs: 5, deadlineMs: 2000, log: false };

const echoFeature = {
  name: "echo",
  buildMessages: (input) => [{ role: "user", content: String(input.text || "") }],
};

function fakeProvider(impl, extra = {}) {
  const calls = [];
  return {
    name: "fake",
    configured: true,
    model: "main",
    calls,
    async chat(args) {
      calls.push(args);
      return impl(args, calls.length);
    },
    ...extra,
  };
}

function transient() {
  return Object.assign(new AiError("ai_upstream_error", 503), { retryable: true });
}

test("все фичи из ai/features валидны и регистрируются", () => {
  const features = loadFeatures();
  assert.ok(features.length >= 1);
  const ai = createAiCore({ provider: fakeProvider(() => "ok"), features, config: FAST });
  assert.ok(ai.get("consultant"));
});

test("некорректная фича отклоняется при регистрации", () => {
  const ai = createAiCore({ provider: fakeProvider(() => "ok"), config: FAST });
  assert.throws(() => ai.register({ name: "Bad Name", buildMessages() {} }));
  assert.throws(() => ai.register({ name: "no-build" }));
  ai.register(echoFeature);
  assert.throws(() => ai.register(echoFeature), /уже зарегистрирована/);
});

test("консультант: валидация ввода и handoff", async () => {
  const ai = createAiCore({ provider: fakeProvider(() => "Пишите в WhatsApp"), features: loadFeatures(), config: FAST });
  await assert.rejects(ai.run("consultant", {}), { code: "message_required", status: 400 });
  assert.deepEqual(await ai.run("consultant", { message: "цена сайта" }), { text: "Пишите в WhatsApp", handoff: true });
});

test("без ключа — ai_not_configured (фронтенд уходит в офлайн)", async () => {
  const ai = createAiCore({ provider: fakeProvider(() => "ok", { configured: false }), features: [echoFeature], config: FAST });
  await assert.rejects(ai.run("echo", {}), { code: "ai_not_configured", status: 503 });
});

test("временная ошибка повторяется, затем успех", async () => {
  const provider = fakeProvider((_, n) => {
    if (n < 3) throw transient();
    return "ok";
  });
  const ai = createAiCore({ provider, features: [echoFeature], config: FAST });
  assert.deepEqual(await ai.run("echo", { text: "hi" }), { text: "ok" });
  assert.equal(provider.calls.length, 3);
});

test("постоянная ошибка (400) не повторяется", async () => {
  const provider = fakeProvider(() => {
    throw new AiError("ai_upstream_error", 400);
  });
  const ai = createAiCore({ provider, features: [echoFeature], config: FAST });
  await assert.rejects(ai.run("echo", {}), { status: 400 });
  assert.equal(provider.calls.length, 1);
});

test("резервная модель, если основная недоступна", async () => {
  const provider = fakeProvider(({ model }) => {
    if (model === "main") throw Object.assign(new AiError("ai_upstream_error", 404), { modelUnavailable: true });
    return "from " + model;
  });
  const ai = createAiCore({ provider, features: [echoFeature], config: { ...FAST, fallbackModels: ["backup"] } });
  assert.deepEqual(await ai.run("echo", {}), { text: "from backup" });
});

test("выключатель размыкается после серии сбоев и отвечает сразу", async () => {
  const provider = fakeProvider(() => {
    throw transient();
  });
  const ai = createAiCore({
    provider,
    features: [echoFeature],
    config: { ...FAST, retries: 0, breakerThreshold: 3, breakerCooldownMs: 60000 },
  });
  for (let i = 0; i < 3; i++) await assert.rejects(ai.run("echo", {}), { code: "ai_upstream_error" });
  await assert.rejects(ai.run("echo", {}), { code: "ai_unavailable", status: 503 });
  assert.equal(provider.calls.length, 3);
  assert.equal(ai.health().breaker.state, "open");
});

test("таймаут, если модель не отвечает в срок", async () => {
  const provider = fakeProvider(
    ({ signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(new AiError("timeout", 504, "Таймаут ответа ИИ")))
      )
  );
  const ai = createAiCore({ provider, features: [echoFeature], config: { ...FAST, deadlineMs: 50 } });
  await assert.rejects(ai.run("echo", {}), { code: "timeout", status: 504 });
});

test("отмена клиентом прерывает запрос к модели", async () => {
  let seenSignal = null;
  const provider = fakeProvider(({ signal }) => {
    seenSignal = signal;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  });
  const ai = createAiCore({ provider, features: [echoFeature], config: FAST });
  const controller = new AbortController();
  const pending = ai.run("echo", {}, { signal: controller.signal });
  setTimeout(() => controller.abort(new AiError("client_closed", 499)), 10);
  await assert.rejects(pending, { code: "client_closed" });
  assert.equal(seenSignal.aborted, true);
});

test("перегрузка: лишние запросы получают ai_busy", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const provider = fakeProvider(() => gate.then(() => "ok"));
  const ai = createAiCore({
    provider,
    features: [echoFeature],
    config: { ...FAST, maxConcurrent: 1, maxQueue: 1, queueTimeoutMs: 1000 },
  });
  const first = ai.run("echo", {});
  const queued = ai.run("echo", {});
  await assert.rejects(ai.run("echo", {}), { code: "ai_busy", status: 503 });
  release();
  assert.deepEqual(await first, { text: "ok" });
  assert.deepEqual(await queued, { text: "ok" });
});

test("плагины получают события, а их ошибки не ломают запрос", async () => {
  const events = [];
  const ai = createAiCore({
    provider: fakeProvider(() => "ok"),
    features: [echoFeature],
    config: FAST,
    plugins: [
      { name: "broken", onStart() { throw new Error("boom"); } },
      { name: "spy", onSuccess: (call) => events.push(call.feature), snapshot: () => events.length },
    ],
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await ai.run("echo", {}), { text: "ok" });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(events, ["echo"]);
  assert.equal(ai.health().spy, 1);
});
