const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const { createFileSender } = require("../static-file");

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

/** Сервер, который отдаёт один и тот же путь через sendFile; журнал и оповещения собираются в массивы. */
async function serve(t, filePath, createReadStream) {
  const logged = [];
  const alerts = [];
  const sendFile = createFileSender({
    mime: MIME,
    log: { error: (...args) => logged.push(args.map((a) => (a instanceof Error ? `${a.code} ${a.message}` : String(a))).join(" ")) },
    onServerError: (req, err) => alerts.push({ method: req.method, code: err.code }),
    createReadStream,
  });
  const server = http.createServer((req, res) => {
    req.id = "req12345";
    sendFile(req, res, filePath, "no-cache");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/`, logged, alerts };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "static-file-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("LOW-05: файл есть — 200; файла нет (ENOENT) и папка (EISDIR) — 404 без записи в журнал", async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>ok</h1>");
  fs.mkdirSync(path.join(dir, "folder.html"));

  const ok = await serve(t, path.join(dir, "index.html"));
  const res = await fetch(ok.url);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "<h1>ok</h1>");

  for (const name of ["missing.html", "folder.html"]) {
    const site = await serve(t, path.join(dir, name));
    assert.equal((await fetch(site.url)).status, 404, name);
    assert.deepEqual(site.logged, []);
    assert.deepEqual(site.alerts, []);
  }
});

test("LOW-05: другая ошибка чтения (EACCES) — 500, журнал с путём и кодом, оповещение", async (t) => {
  const failing = () => {
    const stream = new Readable({ read() {} });
    process.nextTick(() => stream.destroy(Object.assign(new Error("permission denied"), { code: "EACCES" })));
    return stream;
  };
  const site = await serve(t, "/srv/dist/index.html", failing);
  const res = await fetch(site.url);
  assert.equal(res.status, 500);
  assert.equal(site.logged.length, 1);
  assert.match(site.logged[0], /\[req12345\] .*\/srv\/dist\/index\.html.*EACCES/);
  assert.deepEqual(site.alerts, [{ method: "GET", code: "EACCES" }]);
});

test("LOW-05: ошибка после начала ответа — соединение закрывается, запись в журнале", async (t) => {
  const brokenMidway = () => {
    const stream = new Readable({ read() {} });
    process.nextTick(() => {
      stream.emit("open");
      stream.push("<h1>начало");
      setTimeout(() => stream.destroy(Object.assign(new Error("i/o error"), { code: "EIO" })), 50);
    });
    return stream;
  };
  const site = await serve(t, "/srv/dist/index.html", brokenMidway);
  const res = await fetch(site.url);
  assert.equal(res.status, 200);
  await assert.rejects(() => res.text());
  assert.equal(site.logged.length, 1);
  assert.match(site.logged[0], /оборвалось.*EIO/);
});
