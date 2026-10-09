const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createSandbox, startServer, runServer, ADMIN_PASSWORD } = require("./server-sandbox");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (!check() && Date.now() < until) await sleep(25);
  return check();
}

/** Минимальный PNG: сигнатура формата проверяется сервером, содержимое — нет. */
const PNG_DATA_URL =
  "data:image/png;base64," + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]).toString("base64");

const PRODUCT = { title: "Тестовый товар", description: "Описание", price: 1000, category: "management" };

function adminJson(server, method, urlPath, body) {
  return fetch(server.url + urlPath, {
    method,
    headers: { "Content-Type": "application/json", "X-Admin-Password": ADMIN_PASSWORD },
    body: JSON.stringify(body),
  });
}

/** Все файлы в images/ копии (кроме самой «папки» загрузок, заменённой файлом). */
function imageFiles(dir) {
  return fs.readdirSync(path.join(dir, "images"), { recursive: true }).filter((name) => /img_/.test(String(name)));
}

test("HIGH-03 и LOW-07: папка загрузок недоступна для записи — 500 с requestId, запись в журнале без строки запроса, файла-сироты нет", async () => {
  const sandbox = createSandbox();
  const server = await startServer(sandbox);
  try {
    const created = await adminJson(server, "POST", "/api/products", PRODUCT);
    assert.equal(created.status, 201);
    const { id } = await created.json();

    // Проверка данных по-прежнему отвечает 400 с понятным текстом.
    const invalid = await adminJson(server, "POST", "/api/products", { ...PRODUCT, title: "" });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, "title_required");

    // Папка images/uploads заменена файлом: запись картинки падает с ENOENT/ENOTDIR, а не с ошибкой валидации.
    const uploads = path.join(sandbox.dir, "images", "uploads");
    fs.rmSync(uploads, { recursive: true, force: true });
    fs.writeFileSync(uploads, "не папка");

    const create = await adminJson(server, "POST", "/api/products?phone=77011234567", { ...PRODUCT, image: PNG_DATA_URL });
    const createBody = await create.json();
    assert.equal(create.status, 500, JSON.stringify(createBody));
    assert.equal(createBody.error, "server_error");
    assert.ok(createBody.requestId);

    const replace = await adminJson(server, "PATCH", `/api/products/${id}?q=Иванов`, { image: PNG_DATA_URL });
    const replaceBody = await replace.json();
    assert.equal(replace.status, 500, JSON.stringify(replaceBody));

    assert.ok(await waitFor(() => server.output().includes(`[${replaceBody.requestId}]`)), server.output());
    const log = server.output();
    assert.match(log, new RegExp(`\\[${createBody.requestId}\\] POST /api/products:`));
    assert.match(log, new RegExp(`\\[${replaceBody.requestId}\\] PATCH /api/products/${id}:`));
    assert.doesNotMatch(log, /77011234567|Иванов|\?phone|\?q=/);
    assert.deepEqual(imageFiles(sandbox.dir), []);

    // Товар не изменился: картинка осталась прежней.
    const product = await (await fetch(server.url + "/api/products/" + id)).json();
    assert.doesNotMatch(product.image, /uploads/);
  } finally {
    await server.stop();
    sandbox.cleanup();
  }
});

test("MED-12: GET /api/health — 200 { ok, db, uptime, version } без пароля и без внутренних деталей", async () => {
  const sandbox = createSandbox();
  const server = await startServer(sandbox);
  try {
    const res = await fetch(server.url + "/api/health");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ["db", "ok", "uptime", "version"]);
    assert.equal(body.ok, true);
    assert.equal(body.db, "ok");
    assert.equal(body.version, require("../package.json").version);
    assert.ok(Number.isInteger(body.uptime) && body.uptime >= 0);
  } finally {
    await server.stop();
    sandbox.cleanup();
  }
});

test("MED-15: ошибка запуска пишется со стеком, а не одной строкой", async () => {
  const sandbox = createSandbox({ "data/bazis.db": "это не база SQLite ".repeat(200) });
  try {
    const { code, stdout, stderr } = await runServer(sandbox, [], { PORT: "0" });
    assert.equal(code, 1, stdout + stderr);
    assert.match(stderr, /Сервер не запустился: Error: База .* повреждена/);
    assert.match(stderr, /\n\s+at .*store\.js/, "в журнале есть стек");
  } finally {
    sandbox.cleanup();
  }
});

test("MED-15: необработанный отказ промиса завершает процесс с кодом 1 и записью в журнал", async () => {
  const sandbox = createSandbox({
    "reject-later.js": "setTimeout(() => { Promise.reject(new Error('отказ без обработчика')); }, 1500);",
  });
  try {
    // NODE_OPTIONS разбирается как командная строка: обратные косые черты Windows в нём съедаются.
    const inject = path.join(sandbox.dir, "reject-later.js").replace(/\\/g, "/");
    const { code, stdout, stderr } = await runServer(sandbox, [], { PORT: "0", NODE_OPTIONS: `--require "${inject}"` });
    assert.equal(code, 1, stdout + stderr);
    assert.match(stderr, /Сервер упал \(необработанный отказ промиса\): Error: отказ без обработчика/);
    assert.match(stderr, /\n\s+at /);
  } finally {
    sandbox.cleanup();
  }
});

test("LOW-18: файл server.stop — штатная остановка с кодом 0; оставшийся от прошлого запуска файл не останавливает сервер", async () => {
  const sandbox = createSandbox({ "server.stop": "остался от прошлого запуска" });
  const server = await startServer(sandbox);
  try {
    await sleep(2500);
    assert.equal(fs.existsSync(path.join(sandbox.dir, "server.stop")), false, "старый файл удалён при запуске");
    assert.match((await fetch(server.url + "/api/health")).status.toString(), /^200$/);

    fs.writeFileSync(path.join(sandbox.dir, "server.stop"), "stop");
    const code = await Promise.race([server.exited, sleep(10000).then(() => "timeout")]);
    assert.equal(code, 0, server.output());
    assert.match(server.output(), /server\.stop: останавливаю сервер/);
  } finally {
    await server.stop();
    sandbox.cleanup();
  }
});
