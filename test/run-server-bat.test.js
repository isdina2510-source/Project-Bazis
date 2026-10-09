const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const BAT = path.join(ROOT, "run-server.bat");
const skip = process.platform !== "win32" || !fs.existsSync(BAT) ? "только Windows (run-server.bat)" : false;

/** Копия проекта с run-server.bat и сервером-заглушкой: первые crashes запусков падают с кодом 1, потом выход 0. */
function sandbox(t, crashes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-server-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  fs.copyFileSync(BAT, path.join(dir, "run-server.bat"));
  for (const sub of ["node_modules", "dist", "dist-media"]) fs.mkdirSync(path.join(dir, sub));
  fs.writeFileSync(path.join(dir, "dist", "index.html"), "");
  fs.writeFileSync(path.join(dir, "dist-media", "index.html"), "");
  fs.writeFileSync(
    path.join(dir, "server.js"),
    `const fs = require("fs");
const runs = (fs.existsSync("runs.txt") ? Number(fs.readFileSync("runs.txt", "utf8")) : 0) + 1;
fs.writeFileSync("runs.txt", String(runs));
process.exit(runs <= ${crashes} ? 1 : 0);
`
  );
  return dir;
}

function runBat(dir, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("cmd.exe", ["/d", "/c", "run-server.bat", "service"], {
      cwd: dir,
      env: { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH, ...env },
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("run-server.bat не завершился"));
    }, 60000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

test("MED-15: run-server.bat — 5 падений за 2 минуты дают паузу с понятной строкой в журнале, затем новые попытки", { skip }, async (t) => {
  const dir = sandbox(t, 6);
  const code = await runBat(dir, { BAZIS_RESTART_WAIT: "1", BAZIS_CRASH_PAUSE: "1" });
  assert.equal(code, 0);
  assert.equal(fs.readFileSync(path.join(dir, "runs.txt"), "utf8"), "7", "после паузы сервер снова запускается");
  const log = fs.readFileSync(path.join(dir, "server-run.log"), "utf8");
  const pauses = log.split("\n").filter((line) => /server crashed 5 times within 120 s - pausing 1 s before next attempts/.test(line));
  assert.equal(pauses.length, 1, log);
  const lines = log.split("\n").filter((line) => line.startsWith("==="));
  const pauseAt = lines.findIndex((line) => line.includes("pausing"));
  assert.equal(lines.slice(0, pauseAt).filter((line) => line.includes("server exited with code 1")).length, 4, "пауза — вместо 5-го обычного перезапуска");
  assert.match(lines[pauseAt + 1], /pause over, starting again/);
  assert.match(lines.at(-1), /server stopped/);
});

test("MED-15: run-server.bat — редкие падения перезапускаются без паузы", { skip }, async (t) => {
  const dir = sandbox(t, 2);
  const code = await runBat(dir, { BAZIS_RESTART_WAIT: "1", BAZIS_CRASH_PAUSE: "1" });
  assert.equal(code, 0);
  const log = fs.readFileSync(path.join(dir, "server-run.log"), "utf8");
  assert.doesNotMatch(log, /pausing/);
  assert.equal(log.split("\n").filter((line) => line.includes("server exited with code 1")).length, 2);
});
