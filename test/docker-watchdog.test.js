const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const SCRIPT = path.join(__dirname, "..", "scripts", "docker-autostart.ps1");
const skip = process.platform !== "win32" ? "только Windows (PowerShell)" : false;

/**
 * Поддельный docker: записывает аргументы в calls.jsonl и отвечает как Docker Desktop
 * с одним работающим контейнером, состояние здоровья которого задаёт health.txt.
 */
const FAKE_DOCKER = `const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify(args) + "\\n");
const health = fs.readFileSync(path.join(__dirname, "health.txt"), "utf8").trim();
if (args[0] === "info") console.log("27.0.0");
else if (args[0] === "compose" && args.includes("ps")) console.log("abc123");
else if (args[0] === "inspect") console.log("running " + health);
else if (args[0] === "restart") console.log("abc123");
else if (args[0] === "compose" && args.includes("run")) console.log("Оповещение отправлено");
`;

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(SCRIPT, path.join(root, "scripts", "docker-autostart.ps1"));
  const fake = path.join(root, "fake");
  fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, "docker.js"), FAKE_DOCKER);
  fs.writeFileSync(path.join(fake, "docker.cmd"), `@"${process.execPath}" "%~dp0docker.js" %*\r\n`);
  const setHealth = (value) => fs.writeFileSync(path.join(fake, "health.txt"), value);
  const calls = () =>
    fs.existsSync(path.join(fake, "calls.jsonl"))
      ? fs.readFileSync(path.join(fake, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
      : [];
  const watch = () =>
    new Promise((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "docker-autostart.ps1"), "watch"],
        { env: { ...process.env, BAZIS_DOCKER_EXE: path.join(fake, "docker.cmd") }, windowsHide: true }
      );
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, output }));
    });
  const log = () => {
    const file = path.join(root, "logs", "docker-autostart.log");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  };
  return { setHealth, calls, watch, log };
}

const restarts = (calls) => calls.filter((args) => args[0] === "restart");
const alerts = (calls) => calls.filter((args) => args[0] === "compose" && args.includes("run"));

test("MED-12: watchdog — unhealthy два раза подряд: docker restart, запись в журнал и оповещение через notify/cli.js", { skip }, async (t) => {
  const w = setup(t);
  w.setHealth("unhealthy");
  const first = await w.watch();
  assert.equal(first.code, 0, first.output);
  assert.deepEqual(restarts(w.calls()), [], "одна неудачная проверка — ещё не повод перезапускать");
  assert.match(w.log(), /unhealthy \(проверка 1 из 2\)/);

  const second = await w.watch();
  assert.equal(second.code, 0, second.output);
  assert.deepEqual(restarts(w.calls()), [["restart", "abc123"]]);
  const [alert] = alerts(w.calls());
  assert.ok(alert, JSON.stringify(w.calls()));
  assert.deepEqual(alert.slice(alert.indexOf("run"), alert.indexOf("notify/cli.js") + 1), [
    "run",
    "--rm",
    "--no-deps",
    "-T",
    "bazis",
    "node",
    "notify/cli.js",
  ]);
  assert.match(w.log(), /перезапускаю контейнер abc123/);
  assert.match(w.log(), /Контейнер перезапущен/);

  // Счётчик сброшен: следующая одиночная неудача снова только записывается.
  await w.watch();
  assert.equal(restarts(w.calls()).length, 1);
});

test("MED-12: watchdog — healthy между неудачами сбрасывает счётчик", { skip }, async (t) => {
  const w = setup(t);
  w.setHealth("unhealthy");
  await w.watch();
  w.setHealth("healthy");
  await w.watch();
  w.setHealth("unhealthy");
  await w.watch();
  assert.deepEqual(restarts(w.calls()), []);
  assert.match(w.log(), /Сайт снова healthy/);
});
