const test = require("node:test");
const assert = require("node:assert/strict");
const { createAiCore, loadAiConfig, AiError } = require("..");
const { createLimiter } = require("../lib/limiter");
const { createBreaker } = require("../lib/breaker");

const FAST = { ...loadAiConfig({}), retryBaseMs: 1, retryMaxMs: 5, deadlineMs: 2000, log: false };
const echoFeature = { name: "echo", buildMessages: () => [{ role: "user", content: "hi" }] };

function provider(impl) {
  return { name: "fake", configured: true, model: "main", chat: impl };
}

test("провайдер, игнорирующий отмену, всё равно укладывается в таймаут", async () => {
  const ai = createAiCore({
    provider: provider(() => new Promise(() => {})),
    features: [echoFeature],
    config: { ...FAST, deadlineMs: 50 },
  });
  await assert.rejects(ai.run("echo", {}), { code: "timeout", status: 504 });
});

test("ожидание в очереди входит в общий бюджет времени", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const ai = createAiCore({
    provider: provider(() => gate.then(() => "ok")),
    features: [echoFeature],
    config: { ...FAST, deadlineMs: 100, maxConcurrent: 1, maxQueue: 5, queueTimeoutMs: 5000 },
  });
  const first = ai.run("echo", {}).catch((e) => e);
  const startedAt = Date.now();
  const queued = ai.run("echo", {}).catch((e) => e);
  setTimeout(release, 150);
  const err = await queued;
  assert.ok(["ai_busy", "timeout"].includes(err.code), "получено: " + err.code);
  assert.ok(Date.now() - startedAt < 400, "второй запрос не должен ждать сверх бюджета");
  await first;
});

test("выключатель восстанавливается после паузы по успешной пробе", async () => {
  let clock = 0;
  const breaker = createBreaker({ threshold: 2, cooldownMs: 1000, now: () => clock });
  breaker.failure();
  breaker.failure();
  assert.throws(() => breaker.check(), { code: "ai_unavailable" });
  clock = 1000;
  breaker.check();
  assert.throws(() => breaker.check(), { code: "ai_unavailable" }, "в полуоткрытом состоянии — только одна проба");
  breaker.success();
  assert.equal(breaker.stats().state, "closed");
  breaker.check();
});

test("выключатель считает запросы пользователя, а не отдельные попытки", async () => {
  let calls = 0;
  const ai = createAiCore({
    provider: provider(async () => {
      calls++;
      throw Object.assign(new AiError("ai_upstream_error", 503), { retryable: true });
    }),
    features: [echoFeature],
    config: { ...FAST, retries: 2, breakerThreshold: 2, breakerCooldownMs: 60000 },
  });
  await assert.rejects(ai.run("echo", {}), { code: "ai_upstream_error" });
  assert.equal(calls, 3);
  assert.equal(ai.health().breaker.state, "closed", "один неудачный запрос с повторами — ещё не повод отключаться");
  await assert.rejects(ai.run("echo", {}), { code: "ai_upstream_error" });
  await assert.rejects(ai.run("echo", {}), { code: "ai_unavailable" });
  assert.equal(calls, 6);
});

test("выключатель не застревает, если пауза перед повтором закончилась после дедлайна", async () => {
  // Пауза 150 мс укладывается в дедлайн 300 мс, если первая попытка заняла меньше 150 мс (запас для медленной
  // сборки в Docker); блокировка цикла событий с 140 до 340 мс сдвигает конец паузы за дедлайн.
  let first = true;
  const ai = createAiCore({
    provider: provider(async () => {
      if (first) {
        first = false;
        setTimeout(() => {
          const end = Date.now() + 200;
          while (Date.now() < end) {}
        }, 140);
        throw Object.assign(new AiError("ai_upstream_error", 503), { retryable: true, retryAfterMs: 150 });
      }
      return "ok";
    }),
    features: [echoFeature],
    config: { ...FAST, deadlineMs: 300, retries: 1, breakerThreshold: 1, breakerCooldownMs: 20 },
  });
  await assert.rejects(ai.run("echo", {}), { code: "timeout" });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(await ai.run("echo", {}), { text: "ok" });
  assert.equal(ai.health().breaker.state, "closed");
});

test("проба, прерванная не по вине провайдера, не блокирует выключатель", async () => {
  let fail = true;
  const ai = createAiCore({
    provider: provider(async () => {
      if (fail) throw Object.assign(new AiError("ai_upstream_error", 503), { retryable: true });
      return "ok";
    }),
    features: [echoFeature],
    config: { ...FAST, retries: 0, breakerThreshold: 1, breakerCooldownMs: 1000 },
  });
  await assert.rejects(ai.run("echo", {}), { code: "ai_upstream_error" });
  await new Promise((r) => setTimeout(r, 1050));
  fail = false;
  const controller = new AbortController();
  controller.abort(new AiError("client_closed", 499));
  await assert.rejects(ai.run("echo", {}, { signal: controller.signal }), { code: "client_closed" });
  assert.deepEqual(await ai.run("echo", {}), { text: "ok" });
});

test("отмена без AiError-причины превращается в client_closed", async () => {
  const ai = createAiCore({
    provider: provider(({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))),
    features: [echoFeature],
    config: FAST,
  });
  const controller = new AbortController();
  const pending = ai.run("echo", {}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { code: "client_closed", status: 499 });
});

test("очередь: уже отменённый запрос отклоняется сразу", async () => {
  const limiter = createLimiter({ maxConcurrent: 1, maxQueue: 5, queueTimeoutMs: 5000 });
  const blocker = limiter.run(() => new Promise((r) => setTimeout(r, 50)));
  const controller = new AbortController();
  controller.abort();
  const startedAt = Date.now();
  await assert.rejects(limiter.run(() => "x", controller.signal), { code: "client_closed" });
  assert.ok(Date.now() - startedAt < 30);
  assert.equal(limiter.stats().queued, 0);
  await blocker;
});

test("дополнительный вызов модели не занимает пробу и не считается отдельным сбоем", async () => {
  let sideFail = true;
  let mainFail = false;
  const ai = createAiCore({
    provider: provider(async ({ messages }) => {
      const blob = JSON.stringify(messages);
      if (blob.includes("SIDE")) {
        if (sideFail) throw Object.assign(new AiError("ai_upstream_error", 503), { retryable: true });
        return "side-ok";
      }
      if (mainFail) throw Object.assign(new AiError("ai_upstream_error", 503), { retryable: true });
      return "main-ok";
    }),
    features: [
      {
        name: "echo",
        async buildMessages(_input, ctx) {
          await ctx.complete([{ role: "user", content: "SIDE" }]).catch(() => null);
          return [{ role: "user", content: "MAIN" }];
        },
      },
    ],
    config: { ...FAST, retries: 0, breakerThreshold: 1, breakerCooldownMs: 1000 },
  });
  assert.deepEqual(await ai.run("echo", {}), { text: "main-ok" });
  assert.equal(ai.health().breaker.state, "closed");
  assert.equal(ai.health().breaker.failures, 0, "сбой описания/фильтра при живом ответе не открывает выключатель");

  sideFail = false;
  mainFail = true;
  await assert.rejects(ai.run("echo", {}), { code: "ai_upstream_error" });
  assert.equal(ai.health().breaker.state, "open");

  await new Promise((r) => setTimeout(r, 1100));
  mainFail = false;
  assert.deepEqual(await ai.run("echo", {}), { text: "main-ok" }, "после паузы пробный слот не забирает побочный вызов");
  assert.equal(ai.health().breaker.state, "closed");
});

test("полуоткрытый выключатель пускает вложенные вызовы того же запроса", () => {
  let clock = 0;
  const breaker = createBreaker({ threshold: 1, cooldownMs: 1000, now: () => clock });
  breaker.check("a");
  breaker.failure("a");
  assert.equal(breaker.stats().state, "open");
  clock = 1000;
  breaker.check("b");
  breaker.check("b");
  assert.throws(() => breaker.check("c"), { code: "ai_unavailable" });
  breaker.success("b");
  assert.equal(breaker.stats().state, "closed");
  breaker.check("c");
});

test("очередь: место освобождается и при ошибке задачи", async () => {
  const limiter = createLimiter({ maxConcurrent: 1, maxQueue: 1, queueTimeoutMs: 1000 });
  await assert.rejects(limiter.run(() => Promise.reject(new Error("boom"))), /boom/);
  await assert.rejects(limiter.run(() => { throw new Error("sync"); }), /sync/);
  assert.equal(await limiter.run(() => "ok"), "ok");
  assert.equal(limiter.stats().active, 0);
});
