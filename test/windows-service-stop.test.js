const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { createSandbox, startServer } = require("./server-sandbox");

const SCRIPT = path.join(__dirname, "..", "scripts", "windows-service.ps1");
const skip = process.platform !== "win32" ? "только Windows (служба)" : false;
/** Своё имя задачи: настоящую службу «Bazis Site» тест не трогает. */
const TASK = "Bazis Test " + process.pid;

function stopSite(dir, extra = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(dir, "scripts", "windows-service.ps1"), "stop", "-TaskName", TASK, ...extra],
      { windowsHide: true }
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output }));
  });
}

function prepare(sandbox, port) {
  fs.mkdirSync(path.join(sandbox.dir, "scripts"));
  fs.copyFileSync(SCRIPT, path.join(sandbox.dir, "scripts", "windows-service.ps1"));
  fs.writeFileSync(path.join(sandbox.dir, ".env"), `PORT=${port}\n`);
}

test("LOW-18: Stop-Site просит сервер остановиться (server.stop) и дожидается штатного выхода", { skip }, async () => {
  const sandbox = createSandbox();
  const server = await startServer(sandbox);
  try {
    prepare(sandbox, server.port);
    const started = Date.now();
    const result = await stopSite(sandbox.dir);
    assert.equal(result.code, 0, result.output);
    assert.equal(await server.exited, 0, server.output());
    assert.match(server.output(), /server\.stop: останавливаю сервер/);
    assert.ok(Date.now() - started < 30000);
    const runLog = path.join(sandbox.dir, "server-run.log");
    assert.ok(!fs.existsSync(runLog) || !/killing/.test(fs.readFileSync(runLog, "utf8")));
  } finally {
    await server.stop();
    sandbox.cleanup();
  }
});

test("LOW-18: сервер не остановился за отведённое время — node завершается принудительно с записью в журнал", { skip }, async () => {
  const sandbox = createSandbox();
  // «Зависший» node: слушает порт сайта и не смотрит на server.stop.
  const stuck = spawn(
    process.execPath,
    ["-e", "const s = require('http').createServer().listen(0, '127.0.0.1', () => console.log(s.address().port))"],
    { windowsHide: true }
  );
  const exited = new Promise((resolve) => stuck.on("exit", resolve));
  try {
    const port = await new Promise((resolve) => stuck.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim()))));
    prepare(sandbox, port);
    const result = await stopSite(sandbox.dir, ["-StopTimeoutSeconds", "2"]);
    assert.equal(result.code, 0, result.output);
    await exited;
    const runLog = fs.readFileSync(path.join(sandbox.dir, "server-run.log"), "utf8");
    assert.match(runLog, /stop: server did not exit within 2 s, killing node \(pid \d+\)/);
    assert.equal(fs.existsSync(path.join(sandbox.dir, "server.stop")), false);
  } finally {
    stuck.kill();
    sandbox.cleanup();
  }
});
