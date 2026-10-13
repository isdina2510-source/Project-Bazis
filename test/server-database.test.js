const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createSandbox, startServer, runServer, ADMIN_PASSWORD } = require("./server-sandbox");

const admin = { "X-Admin-Password": ADMIN_PASSWORD };

test("без DATABASE_URL или с неверным адресом сервер не запускается: код 4 и понятная причина", async () => {
  const sandbox = createSandbox();
  try {
    const missing = await runServer(sandbox, [], { PORT: "0", DATABASE_URL: "" });
    assert.equal(missing.code, 4, missing.stdout + missing.stderr);
    assert.match(missing.stderr, /DATABASE_URL/);

    const wrong = await runServer(sandbox, [], { PORT: "0", DATABASE_URL: "mysql://user:secret-pass@host/db" });
    assert.equal(wrong.code, 4, wrong.stdout + wrong.stderr);
    assert.match(wrong.stderr, /DATABASE_URL/);
    assert.doesNotMatch(wrong.stdout + wrong.stderr, /secret-pass/, "пароль из адреса не попадает в журнал");
  } finally {
    sandbox.cleanup();
  }
});

test("--check-config показывает базу без пароля", async () => {
  const sandbox = createSandbox();
  try {
    const { code, stdout } = await runServer(sandbox, ["--check-config"], {
      DATABASE_URL: "postgres://bazis:very-secret@db.example:5432/bazis",
    });
    assert.equal(code, 0, stdout);
    assert.match(stdout, /База: PostgreSQL bazis@db\.example:5432\/bazis/);
    assert.doesNotMatch(stdout, /very-secret/);
  } finally {
    sandbox.cleanup();
  }
});

test("первый запуск переносит заказы из data/bazis.db (SQLite) в PostgreSQL; повторный запуск их не дублирует", async () => {
  const sandbox = createSandbox();
  const dataDir = path.join(sandbox.dir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const { DatabaseSync } = require("node:sqlite");
  const raw = new DatabaseSync(path.join(dataDir, "bazis.db"));
  raw.exec(`
    CREATE TABLE products (id TEXT PRIMARY KEY, sort_order INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      title_kk TEXT NOT NULL DEFAULT '', description_kk TEXT NOT NULL DEFAULT '', price REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'KZT', kind TEXT NOT NULL DEFAULT 'service', category TEXT NOT NULL, image TEXT NOT NULL,
      stock INTEGER);
    CREATE TABLE orders (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, channel TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new', customer_name TEXT NOT NULL DEFAULT '', customer_phone TEXT NOT NULL DEFAULT '',
      client_id TEXT, total_text TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '', source_page TEXT NOT NULL DEFAULT '',
      note TEXT, lead_direction TEXT, lead_comment TEXT, extra TEXT);
    CREATE TABLE order_items (order_id TEXT NOT NULL, position INTEGER NOT NULL, product_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', qty INTEGER NOT NULL DEFAULT 1, price REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'KZT', line_total REAL, kind TEXT NOT NULL DEFAULT 'service',
      reserved INTEGER NOT NULL DEFAULT 0, consumed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (order_id, position));
    INSERT INTO products (id, sort_order, title, price, kind, category, image, stock)
      VALUES ('p_old', 0, 'Перенесённый товар', 5000, 'product', 'media', '', 4);
    INSERT INTO orders (id, created_at, updated_at, channel, status, customer_name, customer_phone, total_text)
      VALUES ('ord_sqlite', '2026-05-01T10:00:00.000Z', '2026-05-01T10:00:00.000Z', 'whatsapp', 'in_progress', 'Из SQLite',
        '+7 701 555 44 33', '5 000 ₸');
    INSERT INTO order_items (order_id, position, product_id, title, qty, price, kind, reserved)
      VALUES ('ord_sqlite', 0, 'p_old', 'Перенесённый товар', 1, 5000, 'product', 1);
    PRAGMA user_version = 4;
  `);
  raw.close();

  try {
    let server = await startServer(sandbox);
    try {
      assert.match(server.output(), /Перенос из SQLite \(схема 4\)/);
      const orders = await (await fetch(server.url + "/api/orders", { headers: admin })).json();
      assert.deepEqual(orders.map((o) => o.id), ["ord_sqlite"]);
      const products = await (await fetch(server.url + "/api/products")).json();
      const moved = products.find((p) => p.id === "p_old");
      assert.ok(moved, "товар из SQLite в каталоге");
      assert.equal(moved.stock, 4);
      assert.equal(fs.existsSync(path.join(dataDir, "bazis.db")), false, "файл SQLite отложен");
      assert.equal(fs.readdirSync(path.join(dataDir, "legacy-sqlite")).length, 1);
    } finally {
      await server.stop();
    }

    server = await startServer(sandbox);
    try {
      assert.doesNotMatch(server.output(), /Перенос из SQLite/);
      const orders = await (await fetch(server.url + "/api/orders", { headers: admin })).json();
      assert.deepEqual(orders.map((o) => o.id), ["ord_sqlite"], "данные в PostgreSQL пережили перезапуск, без повторов");
    } finally {
      await server.stop();
    }
  } finally {
    sandbox.cleanup();
  }
});
