const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { createPortfolioHandler, normalizeItems, signatureMatches } = require("../portfolio");
const { parseRange } = require("../static-file");

const MP4_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(8)]);
const JPEG_HEAD = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12)]);

test("normalizeItems: обязательные поля, тип, фото или видео; номер работы в ошибке", () => {
  const [item] = normalizeItems([
    { id: "w1", kind: "video", title: "  Ролик ", video: "images/uploads/pf_abc.mp4", terms: "от 30 000 ₸", title_kk: "" },
  ]);
  assert.deepEqual(item, { id: "w1", kind: "video", title: "Ролик", image: "", video: "images/uploads/pf_abc.mp4", terms: "от 30 000 ₸" });

  assert.throws(() => normalizeItems("x"), { code: "invalid_items" });
  assert.throws(() => normalizeItems([{ kind: "video", image: "images/a.jpg" }]), { code: "title_required", index: 0 });
  assert.throws(() => normalizeItems([{ title: "a", kind: "music", image: "images/a.jpg" }]), { code: "invalid_kind" });
  assert.throws(() => normalizeItems([{ title: "a", kind: "photo" }]), { code: "media_required" });
  assert.throws(() => normalizeItems([{ title: "a", kind: "photo", image: "../server.js" }]), { code: "invalid_image" });
  assert.throws(() => normalizeItems([{ title: "a", kind: "photo", image: "javascript:alert(1)" }]), { code: "invalid_image" });
  assert.throws(() => normalizeItems([{ title: "a", kind: "video", video: "images/uploads/../x.mp4" }]), { code: "invalid_video" });
  assert.throws(
    () => normalizeItems([{ title: "a", kind: "photo", image: "images/a.jpg" }, { title: "", kind: "photo" }]),
    (err) => err.index === 1 && /Работа №2/.test(err.message)
  );
});

test("normalizeItems: повторяющийся или кривой id заменяется новым", () => {
  const items = normalizeItems([
    { id: "w1", title: "a", kind: "photo", image: "https://example.com/a.jpg" },
    { id: "w1", title: "b", kind: "photo", image: "images/b.jpg" },
    { id: "<script>", title: "c", kind: "photo", image: "images/c.jpg" },
  ]);
  assert.equal(new Set(items.map((item) => item.id)).size, 3);
  assert.equal(items[0].id, "w1");
});

test("signatureMatches: содержимое должно совпасть с типом", () => {
  assert.equal(signatureMatches(MP4_HEAD, "video/mp4"), true);
  assert.equal(signatureMatches(JPEG_HEAD, "video/mp4"), false);
  assert.equal(signatureMatches(JPEG_HEAD, "image/jpeg"), true);
  assert.equal(signatureMatches(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]), "video/webm"), true);
});

test("parseRange: обычный, открытый, хвостовой и невозможный диапазон", () => {
  assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=500-", 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=0-5000", 1000), { start: 0, end: 999 });
  assert.equal(parseRange("bytes=1000-", 1000), false);
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(parseRange("items=0-1", 1000), null);
});

/** Обработчик с базой в памяти и паролем «ok» в X-Admin-Password. */
async function serve(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portfolio-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = new Map();
  const deleted = [];
  const sendJson = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const handler = createPortfolioHandler({
    getStore: () => ({
      settings: {
        get: async (key) => (settings.has(key) ? JSON.parse(settings.get(key)) : null),
        set: async (key, value) => settings.set(key, JSON.stringify(value)),
      },
    }),
    uploadsDir: dir,
    sendJson,
    readJsonObject: (req) =>
      new Promise((resolve) => {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => resolve(JSON.parse(raw || "{}")));
      }),
    isJsonRequest: (req) => /json/.test(String(req.headers["content-type"])),
    requireAdmin: (req, res) => {
      if (req.headers["x-admin-password"] === "ok") return true;
      sendJson(res, 401, { error: "unauthorized" });
      return false;
    },
    deleteUpload: (rel) => {
      deleted.push(rel);
      fs.rmSync(path.join(dir, path.basename(rel)), { force: true });
    },
    ...options,
  });
  const server = http.createServer((req, res) => {
    const parts = req.url.split("/").filter(Boolean);
    handler.handle(req, res, parts).catch((err) => sendJson(res, 500, { error: String(err.message) }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/api/portfolio`, dir, deleted };
}

const admin = (extra = {}) => ({ "X-Admin-Password": "ok", ...extra });

test("API: пусто — items null; загрузка видео, сохранение, удаление старого файла", async (t) => {
  const site = await serve(t);
  assert.deepEqual(await (await fetch(site.url)).json(), { items: null });

  const denied = await fetch(site.url + "/upload", { method: "POST", headers: { "Content-Type": "video/mp4" }, body: MP4_HEAD });
  assert.equal(denied.status, 401);

  const upload = await fetch(site.url + "/upload", { method: "POST", headers: admin({ "Content-Type": "video/mp4" }), body: MP4_HEAD });
  assert.equal(upload.status, 201);
  const { path: videoPath } = await upload.json();
  assert.match(videoPath, /^images\/uploads\/pf_[a-z0-9_]+\.mp4$/);
  assert.ok(fs.existsSync(path.join(site.dir, path.basename(videoPath))));

  const items = [{ kind: "video", title: "Ролик", video: videoPath, terms: "3 дня" }];
  const saved = await fetch(site.url, { method: "PUT", headers: admin({ "Content-Type": "application/json" }), body: JSON.stringify({ items }) });
  assert.equal(saved.status, 200);
  const list = (await (await fetch(site.url)).json()).items;
  assert.equal(list.length, 1);
  assert.equal(list[0].video, videoPath);

  const cleared = await fetch(site.url, { method: "PUT", headers: admin({ "Content-Type": "application/json" }), body: '{"items":[]}' });
  assert.equal(cleared.status, 200);
  assert.deepEqual(site.deleted, [videoPath]);
  assert.deepEqual((await (await fetch(site.url)).json()).items, []);
});

test("API: подделанный тип, неизвестный тип и слишком большой файл не сохраняются", async (t) => {
  const site = await serve(t, { maxVideoBytes: 64 });
  const fake = await fetch(site.url + "/upload", { method: "POST", headers: admin({ "Content-Type": "video/mp4" }), body: JPEG_HEAD });
  assert.equal(fake.status, 400);
  assert.equal((await fake.json()).error, "bad_signature");

  const exe = await fetch(site.url + "/upload", { method: "POST", headers: admin({ "Content-Type": "application/x-msdownload" }), body: "MZ" });
  assert.equal(exe.status, 415);

  const big = await fetch(site.url + "/upload", { method: "POST", headers: admin({ "Content-Type": "video/mp4" }), body: Buffer.alloc(100) });
  assert.equal(big.status, 413);

  assert.deepEqual(fs.readdirSync(site.dir), []);
});

test("API: ошибка в списке — 400 с номером работы, сохранённое не меняется", async (t) => {
  const site = await serve(t);
  const res = await fetch(site.url, {
    method: "PUT",
    headers: admin({ "Content-Type": "application/json" }),
    body: JSON.stringify({ items: [{ kind: "photo", title: "Фото" }] }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "media_required");
  assert.equal(body.index, 0);
  assert.deepEqual(await (await fetch(site.url)).json(), { items: null });
});
