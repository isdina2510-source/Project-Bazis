const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { pgliteCopy } = require("./pg");
const { createStore } = require("../db/store");

const SCRIPT = path.join(__dirname, "..", "scripts", "backup-snapshot.js");
const silent = { log() {}, warn() {}, error() {} };
const normalizePhone = (raw) => String(raw || "").replace(/\D/g, "");
const normalizeProduct = (raw) => ({
  id: raw.id, title: String(raw.title || ""), description: "", price: Number(raw.price) || 0, currency: "KZT",
  kind: "product", category: "media", image: "", stock: raw.stock == null ? null : raw.stock,
});

/** Песочница: PGlite на диске, папки data и uploads; скрипт и тест не держат базу открытой одновременно. */
async function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazis-snapshot-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const env = {
    ...process.env,
    DATABASE_URL: await pgliteCopy(path.join(dir, "pg")),
    BAZIS_DATA_DIR: path.join(dir, "data"),
    BAZIS_UPLOADS_DIR: path.join(dir, "uploads"),
  };
  fs.mkdirSync(env.BAZIS_DATA_DIR, { recursive: true });
  fs.mkdirSync(env.BAZIS_UPLOADS_DIR, { recursive: true });
  const run = (...args) =>
    new Promise((resolve) => {
      execFile(process.execPath, ["--no-warnings", SCRIPT, ...args], { env }, (err, stdout) => resolve({ code: err ? err.code : 0, stdout }));
    });
  const withStore = async (fn) => {
    const store = await createStore({
      dataDir: env.BAZIS_DATA_DIR, databaseUrl: env.DATABASE_URL, normalizePhone, normalizeProduct,
      defaultProducts: [], log: silent, backups: false,
    });
    try {
      return await fn(store);
    } finally {
      await store.close();
    }
  };
  return { dir, env, run, withStore };
}

const order = (id) => ({
  id, createdAt: "2026-05-01T10:00:00.000Z", channel: "whatsapp", status: "new", customerName: "Анна", customerPhone: "87010000001",
  items: [{ id: "p1", title: "Товар", qty: 1, price: 100, currency: "KZT", kind: "product" }],
});

test("снимок PostgreSQL: проверка копии, порча файла замечается, восстановление возвращает данные и файлы", async (t) => {
  const { dir, env, run, withStore } = await sandbox(t);
  await withStore(async (store) => {
    await store.products.insert(normalizeProduct({ id: "p1", title: "Товар", price: 100, stock: 3 }));
    await store.orders.insert(order("o1"));
  });
  fs.mkdirSync(path.join(env.BAZIS_DATA_DIR, "company"));
  fs.writeFileSync(path.join(env.BAZIS_DATA_DIR, "company", "stamp-abc.png"), "png");
  fs.writeFileSync(path.join(env.BAZIS_UPLOADS_DIR, "photo.webp"), "webp");

  const out = path.join(dir, "copy");
  const snap = await run("snapshot", out);
  assert.equal(snap.code, 0, snap.stdout);
  assert.match(snap.stdout, /^ok$/m);
  assert.match(snap.stdout, /database=postgres/);
  assert.match(snap.stdout, /orders=1 order_items=1 clients=0 products=1/);
  assert.ok(fs.existsSync(path.join(out, "database.json.gz")));
  assert.ok(fs.existsSync(path.join(out, "data", "company", "stamp-abc.png")), "печать в копии");
  assert.equal((await run("verify", out)).code, 0);

  await withStore(async (store) => {
    await store.orders.remove("o1");
    await store.products.insert(normalizeProduct({ id: "p2", title: "Лишний" }));
  });
  fs.rmSync(path.join(env.BAZIS_UPLOADS_DIR, "photo.webp"));
  const notYet = await run("verify-restored", out);
  assert.equal(notYet.code, 1, "до восстановления база и файлы отличаются от копии");

  fs.cpSync(path.join(out, "uploads"), env.BAZIS_UPLOADS_DIR, { recursive: true });
  const restored = await run("restore-db", out);
  assert.equal(restored.code, 0, restored.stdout);
  assert.equal((await run("verify-restored", out)).code, 0);
  await withStore(async (store) => {
    assert.deepEqual((await store.orders.list()).map((o) => o.id), ["o1"]);
    assert.deepEqual((await store.products.list()).map((p) => p.id), ["p1"]);
    assert.equal((await store.products.get("p1")).stock, 2, "остаток — как в момент копии");
  });

  fs.appendFileSync(path.join(out, "uploads", "photo.webp"), "x");
  const broken = await run("verify", out);
  assert.equal(broken.code, 1);
  assert.match(broken.stdout, /photo\.webp отличается/);
});

test("данные ещё в SQLite: снимок берёт bazis.db, а восстановление переносит его в PostgreSQL", async (t) => {
  const { dir, env, run, withStore } = await sandbox(t);
  const { DatabaseSync } = require("node:sqlite");
  const raw = new DatabaseSync(path.join(env.BAZIS_DATA_DIR, "bazis.db"));
  raw.exec(`
    CREATE TABLE products (id TEXT PRIMARY KEY, sort_order INTEGER NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL,
      image TEXT NOT NULL, stock INTEGER);
    CREATE TABLE orders (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, channel TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new');
    CREATE TABLE order_items (order_id TEXT NOT NULL, position INTEGER NOT NULL, product_id TEXT, title TEXT, qty INTEGER,
      reserved INTEGER NOT NULL DEFAULT 0, consumed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (order_id, position));
    INSERT INTO products VALUES ('old_p', 0, 'Из SQLite', 'media', '', 7);
    INSERT INTO orders VALUES ('old_o', '2026-01-01', '2026-01-01', 'whatsapp', 'new');
    INSERT INTO order_items (order_id, position, product_id, title, qty, reserved) VALUES ('old_o', 0, 'old_p', 'Из SQLite', 1, 1);
    PRAGMA user_version = 4;
  `);
  raw.close();

  const out = path.join(dir, "legacy-copy");
  const snap = await run("snapshot", out);
  assert.equal(snap.code, 0, snap.stdout);
  assert.match(snap.stdout, /database=sqlite/);
  assert.match(snap.stdout, /orders=1 order_items=1 clients=0 products=1/);
  assert.ok(fs.existsSync(path.join(out, "data", "bazis.db")));
  assert.equal((await run("verify", out)).code, 0);

  fs.rmSync(path.join(env.BAZIS_DATA_DIR, "bazis.db"));
  const restored = await run("restore-db", out);
  assert.equal(restored.code, 0, restored.stdout);
  assert.equal((await run("verify-restored", out)).code, 0);
  await withStore(async (store) => {
    assert.deepEqual((await store.orders.list()).map((o) => o.id), ["old_o"]);
    assert.equal((await store.products.get("old_p")).stock, 7);
  });
});

test("копия формата 1 (до PostgreSQL) распознаётся и проверяется", async (t) => {
  const { dir, run } = await sandbox(t);
  const out = path.join(dir, "v1");
  fs.mkdirSync(path.join(out, "data"), { recursive: true });
  const { DatabaseSync } = require("node:sqlite");
  const raw = new DatabaseSync(path.join(out, "data", "bazis.db"));
  raw.exec("CREATE TABLE orders (id TEXT PRIMARY KEY); INSERT INTO orders VALUES ('a'), ('b'); PRAGMA user_version = 4;");
  raw.close();
  const file = path.join(out, "data", "bazis.db");
  const sha = require("crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const counts = { orders: 2, order_items: 0, clients: 0, products: 0, documents: 0 };
  fs.writeFileSync(
    path.join(out, "manifest.json"),
    JSON.stringify({ format: 1, createdAt: "2026-01-01T00:00:00.000Z", schemaVersion: 4, counts, files: [{ path: "data/bazis.db", size: 1, sha256: sha }] })
  );
  const result = await run("verify", out);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /database=sqlite/);
  assert.match(result.stdout, /orders=2/);
});
