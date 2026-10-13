/**
 * server.js во временной копии проекта: своя папка data, без .env и без data/DATA-MOVED.txt рабочей копии.
 * Зависимости берутся из node_modules проекта через NODE_PATH — ссылки на папку не создаются.
 * База — своя PGlite в папке pgdata копии (DATABASE_URL можно передать и явно).
 */
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { pgliteCopy } = require("./pg");

const ROOT = path.join(__dirname, "..");
const SERVER_DIRS = ["ai", "antispam", "auth", "config", "db", "documents", "logging", "notify", "runtime", "security", "shared"];
const ADMIN_PASSWORD = "sandbox-admin-password-1";

/** @param {Record<string, string>} [files] дополнительные файлы: путь относительно корня копии → текст */
function createSandbox(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazis-test-"));
  fs.copyFileSync(path.join(ROOT, "server.js"), path.join(dir, "server.js"));
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
  for (const name of SERVER_DIRS) {
    fs.cpSync(path.join(ROOT, name), path.join(dir, name), {
      recursive: true,
      filter: (src) => !path.relative(ROOT, src).split(path.sep).includes("test"),
    });
  }
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
  };
}

/** Окружение без переменных разработчика: только системное, пароль админки и переданное. */
function sandboxEnv(extra = {}) {
  const env = { NODE_PATH: path.join(ROOT, "node_modules"), ADMIN_PASSWORD, LOG_TO_FILE: "0", NODE_NO_WARNINGS: "1" };
  for (const key of ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

/** База песочницы: при первом запуске — копия готовой папки PGlite, дальше та же папка (данные переживают перезапуск). */
async function databaseEnv(sandbox, env) {
  if ("DATABASE_URL" in env) return env;
  const dir = path.join(sandbox.dir, "pgdata");
  const url = fs.existsSync(dir) ? "pglite:" + dir : await pgliteCopy(dir);
  return { DATABASE_URL: url, ...env };
}

/** Запуск до выхода (например, --check-config): { code, stdout, stderr }. */
async function runServer(sandbox, args, env = {}, timeoutMs = 20000) {
  const fullEnv = sandboxEnv(await databaseEnv(sandbox, env));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server.js", ...args], { cwd: sandbox.dir, env: fullEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("server.js не завершился за " + timeoutMs + " мс:\n" + stdout + stderr));
    }, timeoutMs);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Работающий сервер: { url, output(), stop() }; готов, когда в журнале появилась строка «Dinara BILab CRM:». */
async function startServer(sandbox, env = {}, timeoutMs = 20000) {
  const port = await freePort();
  const fullEnv = sandboxEnv(await databaseEnv(sandbox, { PORT: String(port), ...env }));
  const child = spawn(process.execPath, ["server.js"], { cwd: sandbox.dir, env: fullEnv });
  let output = "";
  const exited = new Promise((resolve) => child.on("exit", resolve));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("сервер не запустился:\n" + output)), timeoutMs);
    const onData = (chunk) => {
      output += chunk;
      if (output.includes("Dinara BILab CRM:")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`сервер завершился с кодом ${code}:\n` + output));
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    output: () => output,
    /** Код выхода, когда сервер завершится сам. */
    exited,
    async stop() {
      if (child.exitCode === null) child.kill();
      await exited;
    },
  };
}

module.exports = { createSandbox, runServer, startServer, sandboxEnv, ADMIN_PASSWORD };
