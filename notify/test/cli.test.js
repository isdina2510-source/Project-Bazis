const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runCli } = require("../cli");

const TELEGRAM = { TELEGRAM_BOT_TOKEN: "123456:test-token", TELEGRAM_CHAT_ID: "42" };

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function quietLog() {
  const lines = [];
  const push = (...args) => lines.push(args.join(" "));
  return { lines, log: { log: push, warn: push, error: push } };
}

function fakeTelegram(ok = true) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(ok ? { ok: true } : { ok: false, description: "chat not found" }), { status: ok ? 200 : 400 });
  };
  return { calls, fetchImpl };
}

test("MED-12: notify/cli.js отправляет текст через модуль notify; повтор в течение 10 минут — пропуск", async (t) => {
  const root = tempRoot(t);
  const telegram = fakeTelegram();
  const { log } = quietLog();
  const options = { env: { ...TELEGRAM }, root, fetchImpl: telegram.fetchImpl, log };
  assert.equal(await runCli(["Сайт", "не", "отвечает"], options), 0);
  assert.equal(telegram.calls.length, 1);
  assert.match(telegram.calls[0].url, /\/sendMessage$/);
  assert.equal(telegram.calls[0].body.chat_id, "42");
  assert.match(telegram.calls[0].body.text, /Сайт не отвечает/);
  assert.ok(fs.existsSync(path.join(root, "data", "notify-state.json")), "антиспам общий с сервером");

  assert.equal(await runCli(["Сайт не отвечает"], { ...options, env: { ...TELEGRAM } }), 0);
  assert.equal(telegram.calls.length, 1);
});

test("MED-12: notify/cli.js — без текста код 2, без переменных Telegram код 3, Telegram отказал — код 1", async (t) => {
  const root = tempRoot(t);
  const { lines, log } = quietLog();
  assert.equal(await runCli([], { env: { ...TELEGRAM }, root, log }), 2);
  assert.equal(await runCli(["текст"], { env: {}, root, log }), 3);
  assert.ok(lines.some((line) => /Оповещения выключены/.test(line)));

  const failing = fakeTelegram(false);
  assert.equal(await runCli(["другой текст"], { env: { ...TELEGRAM }, root, fetchImpl: failing.fetchImpl, log }), 1);
  assert.ok(lines.every((line) => !line.includes("test-token")), "токен не попадает в вывод");
});

test("MED-12: notify/cli.js берёт переменные из .env рядом с сервером", async (t) => {
  const root = tempRoot(t);
  fs.writeFileSync(path.join(root, ".env"), "TELEGRAM_BOT_TOKEN=123456:from-file\nTELEGRAM_CHAT_ID=77\n");
  const telegram = fakeTelegram();
  const { log } = quietLog();
  assert.equal(await runCli(["из файла"], { env: {}, root, fetchImpl: telegram.fetchImpl, log }), 0);
  assert.equal(telegram.calls[0].body.chat_id, "77");
});
