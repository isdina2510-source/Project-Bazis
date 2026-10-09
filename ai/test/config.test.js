const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAiConfig } = require("..");

test("LOW-08: неверное число в настройке ИИ — предупреждение с именем переменной и значение по умолчанию", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const config = loadAiConfig({ AI_DAILY_TOKENS: "1 000 000", AI_MAX_CONCURRENT: "0" });
  assert.equal(config.dailyTokens, 3000000);
  assert.equal(config.maxConcurrent, 8);
  const messages = warn.mock.calls.map((call) => call.arguments.join(" "));
  assert.ok(messages.some((text) => text.includes("AI_DAILY_TOKENS")), messages.join("\n"));
  assert.ok(messages.some((text) => text.includes("AI_MAX_CONCURRENT")), messages.join("\n"));
});

test("LOW-08: пустые и верные значения — без предупреждений", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const config = loadAiConfig({ AI_DAILY_TOKENS: "", AI_TIMEOUT_MS: "30000", AI_RETRIES: "0" });
  assert.equal(config.dailyTokens, 3000000);
  assert.equal(config.deadlineMs, 30000);
  assert.equal(config.retries, 0);
  assert.equal(warn.mock.callCount(), 0);
});
