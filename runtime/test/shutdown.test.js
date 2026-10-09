const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createShutdown, watchStopFile, createCrashHandler } = require("../shutdown");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function recorder() {
  const lines = [];
  const push = (level) => (...args) => lines.push(level + " " + args.map((a) => (a instanceof Error ? a.stack : String(a))).join(" "));
  return { lines, log: { log: push("log"), warn: push("warn"), error: push("error") } };
}

/** exit(code) — промис, который ждёт тест. */
function exitSpy() {
  let resolve;
  const done = new Promise((r) => (resolve = r));
  const codes = [];
  return {
    codes,
    done,
    exit: (code) => {
      codes.push(code);
      resolve(code);
    },
  };
}

test("LOW-06: штатная остановка — документы, база и журнал закрыты по порядку, код 0", async () => {
  const order = [];
  const { lines, log } = recorder();
  const spy = exitSpy();
  const shutdown = createShutdown({
    server: { close: (cb) => setImmediate(cb), closeIdleConnections: () => order.push("idle") },
    closeDocuments: async () => order.push("documents"),
    closeStore: () => order.push("store"),
    closeLog: () => order.push("log"),
    log,
    exit: spy.exit,
  });
  shutdown("SIGTERM");
  shutdown("SIGTERM");
  assert.equal(await spy.done, 0);
  assert.deepEqual(order, ["idle", "documents", "store", "log"]);
  assert.deepEqual(spy.codes, [0]);
  assert.match(lines[0], /SIGTERM: останавливаю сервер/);
});

test("LOW-06: зависший запрос — по таймеру предупреждение в журнал и код 1", async () => {
  const { lines, log } = recorder();
  const spy = exitSpy();
  const keepAlive = setTimeout(() => {}, 5000);
  const shutdown = createShutdown({
    server: { close: () => {}, closeIdleConnections: () => {} },
    timeoutMs: 50,
    log,
    exit: spy.exit,
  });
  shutdown("SIGTERM");
  assert.equal(await spy.done, 1);
  clearTimeout(keepAlive);
  assert.ok(lines.some((line) => /^warn Сервер не остановился за .*код 1/.test(line)), lines.join("\n"));
});

test("LOW-06: ошибка documents.close() пишется в журнал, база всё равно закрывается", async () => {
  const { lines, log } = recorder();
  const spy = exitSpy();
  let storeClosed = false;
  const shutdown = createShutdown({
    server: { close: (cb) => setImmediate(cb), closeIdleConnections: () => {} },
    closeDocuments: () => Promise.reject(new Error("worker не остановился")),
    closeStore: () => (storeClosed = true),
    log,
    exit: spy.exit,
  });
  shutdown("SIGINT");
  assert.equal(await spy.done, 0);
  assert.equal(storeClosed, true);
  assert.ok(lines.some((line) => /^error Остановка: не удалось закрыть модуль документов.*worker не остановился/s.test(line)), lines.join("\n"));
});

test("MED-15: аварийный выход — журнал со стеком, оповещение, база закрыта, код 1; повторный сбой — сразу код 1", async () => {
  const { lines, log } = recorder();
  const spy = exitSpy();
  const calls = [];
  const crash = createCrashHandler({
    notifier: {
      failed: (kind, err) => calls.push(["failed", kind, err.message]),
      flush: async (ms) => calls.push(["flush", ms]),
    },
    closeStore: () => calls.push(["store"]),
    log,
    exit: spy.exit,
  });
  crash("необработанный отказ промиса", new Error("сбой в фоне"));
  assert.equal(await spy.done, 1);
  assert.deepEqual(calls, [["store"], ["failed", "необработанный отказ промиса", "сбой в фоне"], ["flush", 3000]]);
  assert.match(lines[0], /Сервер упал \(необработанный отказ промиса\): Error: сбой в фоне\n\s+at /);

  crash("сбой процесса", new Error("ещё один"));
  assert.deepEqual(spy.codes, [1, 1]);
  assert.equal(calls.filter(([name]) => name === "failed").length, 1);
});

test("LOW-18: watchStopFile — старый файл удаляется сразу, новый вызывает остановку и удаляется", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stop-file-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "server.stop");
  fs.writeFileSync(file, "old");
  let stops = 0;
  const unwatch = watchStopFile(file, () => stops++, { intervalMs: 20 });
  t.after(unwatch);
  assert.equal(fs.existsSync(file), false);
  const keepAlive = setTimeout(() => {}, 2000);
  await sleep(80);
  assert.equal(stops, 0);
  fs.writeFileSync(file, "stop");
  for (let i = 0; i < 50 && !stops; i++) await sleep(20);
  clearTimeout(keepAlive);
  assert.equal(stops, 1);
  assert.equal(fs.existsSync(file), false);
});
