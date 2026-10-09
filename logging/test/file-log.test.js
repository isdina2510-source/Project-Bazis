const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createFileLog } = require("../file-log");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const silent = { error() {} };

test("строки пишутся с временем и уровнем, многострочный текст не ломает формат", (t) => {
  const dir = tempDir(t);
  const log = createFileLog({ dir, console: silent, now: () => new Date(2026, 9, 7, 14, 5, 9, 42) });
  log.write("INFO", ["Заказ %s сохранён", "ord_1"]);
  log.write("ERROR", [new Error("boom")]);
  log.close();
  const text = fs.readFileSync(path.join(dir, "server-2026-10-07.log"), "utf8");
  const lines = text.trimEnd().split("\n");
  assert.equal(lines[0], "2026-10-07 14:05:09.042 INFO  Заказ ord_1 сохранён");
  assert.match(lines[1], /^2026-10-07 14:05:09\.042 ERROR Error: boom$/);
  assert.ok(lines.slice(2).every((line) => line.startsWith("  ")), "стек ошибки — с отступом");
});

test("новый файл каждые сутки", (t) => {
  const dir = tempDir(t);
  let current = new Date(2026, 9, 7, 23, 59, 59);
  const log = createFileLog({ dir, console: silent, now: () => current });
  log.write("INFO", ["вечер"]);
  current = new Date(2026, 9, 8, 0, 0, 1);
  log.write("INFO", ["утро"]);
  log.close();
  assert.match(fs.readFileSync(path.join(dir, "server-2026-10-07.log"), "utf8"), /вечер/);
  assert.match(fs.readFileSync(path.join(dir, "server-2026-10-08.log"), "utf8"), /утро/);
});

test("при превышении размера — следующая часть; после перезапуска пишем в последнюю", (t) => {
  const dir = tempDir(t);
  const now = () => new Date(2026, 9, 7, 12, 0, 0);
  const log = createFileLog({ dir, console: silent, now, maxBytes: 64 * 1024 });
  const big = "x".repeat(40 * 1024);
  log.write("INFO", [big]);
  log.write("INFO", [big]);
  log.write("INFO", [big]);
  log.close();
  assert.ok(fs.existsSync(path.join(dir, "server-2026-10-07.log")));
  assert.ok(fs.existsSync(path.join(dir, "server-2026-10-07.2.log")));

  const again = createFileLog({ dir, console: silent, now, maxBytes: 64 * 1024 });
  again.write("INFO", ["после перезапуска"]);
  again.close();
  assert.equal(path.basename(again.file()), "server-2026-10-07.2.log");
});

test("старые файлы удаляются, чужие не трогаются", (t) => {
  const dir = tempDir(t);
  const old = path.join(dir, "server-2026-09-01.log");
  const foreign = path.join(dir, "notes.txt");
  fs.writeFileSync(old, "old");
  fs.writeFileSync(foreign, "keep");
  const longAgo = new Date(2026, 8, 1);
  fs.utimesSync(old, longAgo, longAgo);
  fs.utimesSync(foreign, longAgo, longAgo);
  const log = createFileLog({ dir, console: silent, keepDays: 14, now: () => new Date(2026, 9, 7) });
  log.write("INFO", ["старт"]);
  log.close();
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(foreign), true);
});

test("сбой записи не роняет процесс: журнал отключается с одним предупреждением", (t) => {
  const dir = tempDir(t);
  const blocker = path.join(dir, "blocked");
  fs.writeFileSync(blocker, "файл вместо папки");
  const warnings = [];
  const log = createFileLog({ dir: path.join(blocker, "logs"), console: { error: (msg) => warnings.push(msg) } });
  assert.doesNotThrow(() => {
    log.write("INFO", ["раз"]);
    log.write("INFO", ["два"]);
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Журнал в файл отключён/);
});
