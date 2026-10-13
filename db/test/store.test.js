const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createStore } = require("../store");
const { dumpDatabase, restoreDatabase, readDumpFile, writeDumpFile, schemaVersionOf, tableCounts } = require("../dump");
const { sharedDatabase } = require("../../test/pg");

const normalizePhone = (raw) => {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) digits = "7" + digits.slice(1);
  return digits;
};
const normalizeProduct = (raw) => ({
  id: raw.id,
  title: String(raw.title || ""),
  description: String(raw.description || ""),
  ...(raw.title_kk ? { title_kk: raw.title_kk } : {}),
  price: Number(raw.price) || 0,
  currency: raw.currency || "KZT",
  kind: raw.kind === "product" ? "product" : "service",
  category: raw.category || "management",
  image: raw.image || "img.jpg",
  stock: raw.stock == null ? null : raw.stock,
});
const silent = { log() {}, warn() {}, error() {} };

/** Одна база PostgreSQL (PGlite в памяти) на файл; перед каждым тестом она пустая. */
let shared;
test.before(async () => {
  shared = await sharedDatabase();
});
test.beforeEach(async () => {
  await shared.reset();
});
test.after(async () => {
  await shared.db.close();
});

const openStores = new Map();

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazis-store-"));
  openStores.set(dir, []);
  t.after(async () => {
    for (const store of openStores.get(dir)) await store.close();
    openStores.delete(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function open(t, dataDir, defaultProducts = [], extra = {}) {
  const store = await createStore({ dataDir, normalizePhone, normalizeProduct, defaultProducts, log: silent, db: shared.db, ...extra });
  openStores.get(dataDir).push(store);
  return store;
}

const legacyOrder = {
  id: "ord_old",
  createdAt: "2026-01-02T10:00:00.000Z",
  updatedAt: "2026-01-03T10:00:00.000Z",
  channel: "site",
  status: "done",
  customerName: "Иван",
  customerPhone: "+7 701 000 00 01",
  clientId: "cli_1",
  items: [{ id: "lead", title: "Заявка", qty: 1, price: 0, currency: "KZT", kind: "service" }],
  totalText: "Заявка с формы",
  message: "Привет",
  sourcePage: "home",
  note: "перезвонить",
  lead: { direction: "management", comment: "аудит" },
  legacyFlag: { a: 1 },
};

/** Поля, которые база добавляет к любому заказу и позиции (скидки, доставка, НДС). */
const ORDER_DEFAULTS = { discount: 0, delivery: 0, adjustCurrency: "KZT", vatRate: 0 };
const withItemDefaults = (items) => items.map((item) => ({ ...item, discount: 0 }));

test("перенос из JSON: данные совпадают, файлы отложены в legacy-json, сделана копия", async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(
    path.join(dir, "orders.json"),
    "\uFEFF" +
      JSON.stringify({
        orders: [legacyOrder, { ...legacyOrder }, { id: "" }],
        clients: [{ id: "cli_1", createdAt: "2026-01-01T00:00:00.000Z", name: "Иван", phone: "+7 701 000 00 01", note: "", source: "order" }],
      })
  );
  fs.writeFileSync(
    path.join(dir, "products.json"),
    JSON.stringify({ products: [{ id: "p1", title: "Аудит", price: 100 }, { id: "p2", title: "Сайт", price: 50, title_kk: "Сайт kk" }] })
  );
  const store = await open(t, dir);

  assert.deepEqual(await store.orders.list(), [{ ...legacyOrder, ...ORDER_DEFAULTS, items: withItemDefaults(legacyOrder.items) }]);
  assert.deepEqual((await store.products.list()).map((p) => p.id), ["p1", "p2"]);
  assert.equal((await store.products.get("p2")).title_kk, "Сайт kk");
  assert.equal("title_kk" in (await store.products.get("p1")), false);
  assert.equal((await store.clients.list()).length, 1);
  assert.equal(fs.existsSync(path.join(dir, "orders.json")), false);
  assert.equal(fs.readdirSync(path.join(dir, "legacy-json")).length, 1);
  const backup = fs.readdirSync(path.join(dir, "backups")).find((name) => /^bazis-\d{4}-\d{2}-\d{2}\.json\.gz$/.test(name));
  assert.ok(backup, "копия базы сделана при запуске");
  assert.equal((await readDumpFile(path.join(dir, "backups", backup))).counts.orders, 1);
});

test("повреждённый JSON: схема не создаётся, файл остаётся на месте", async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "orders.json"), "{ broken");
  await assert.rejects(open(t, dir), /orders\.json/);
  assert.equal(fs.existsSync(path.join(dir, "orders.json")), true);
  assert.equal(await schemaVersionOf(shared.db), 0, "транзакция создания схемы откатилась");
});

test("без JSON — стартовый каталог; данные переживают перезапуск", async (t) => {
  const dir = tempDir(t);
  const first = await open(t, dir, [{ id: "d1", title: "Старт" }]);
  await first.products.insert(normalizeProduct({ id: "p_new", title: "Новый" }));
  await first.close();
  const second = await open(t, dir, [{ id: "ignored", title: "Не должен появиться" }]);
  assert.deepEqual((await second.products.list()).map((p) => p.id), ["p_new", "d1"]);
});

test("tx откатывает всё при ошибке", async (t) => {
  const store = await open(t, tempDir(t));
  await assert.rejects(
    store.tx(async () => {
      await store.clients.upsert({ name: "Анна", phone: "87010000002" });
      throw new Error("boom");
    }),
    /boom/
  );
  assert.equal((await store.clients.list()).length, 0);
});

test("задача, запущенная из транзакции без await, после COMMIT открывает свою транзакцию", async (t) => {
  const store = await open(t, tempDir(t));
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let late;
  await store.tx(async () => {
    late = gate.then(() =>
      store.tx(async () => {
        await store.clients.upsert({ name: "Поздний", phone: "87010000003" });
        throw new Error("late boom");
      })
    );
  });
  release();
  await assert.rejects(late, /late boom/);
  assert.equal((await store.clients.list()).length, 0, "поздняя транзакция откатилась целиком");
});

test("контакт из заказа не перезаписывает карточку, ручная правка — перезаписывает", async (t) => {
  const store = await open(t, tempDir(t));
  const manual = await store.clients.upsert({ name: "Анна Петровна", phone: "+7 701 000 00 02", source: "manual" });
  const fromOrder = await store.clients.upsert({ name: "Аня", phone: "87010000002", source: "order" });
  assert.equal(fromOrder.id, manual.id);
  assert.equal(fromOrder.name, "Анна Петровна");
  const edited = await store.clients.upsert({ name: "Анна", phone: "87010000002" });
  assert.equal(edited.name, "Анна");
  assert.equal(await store.clients.upsert({ name: "", phone: "" }), null);
});

test("правка клиента обновляет его заказы; backfill создаёт карточки", async (t) => {
  const store = await open(t, tempDir(t));
  await store.orders.insert({ ...legacyOrder, id: "ord_a", clientId: undefined, customerName: "Пётр", customerPhone: "87010000003" });
  assert.equal(await store.clients.backfill(), true);
  const [client] = await store.clients.list();
  assert.equal((await store.orders.get("ord_a")).clientId, client.id);
  assert.equal(await store.clients.backfill(), false);

  await store.clients.patch(client.id, { name: "Пётр И.", phone: "87010000004" });
  const order = await store.orders.get("ord_a");
  assert.equal(order.customerName, "Пётр И.");
  assert.equal(order.customerPhone, "87010000004");
});

test("новые и отменённые заказы не создают карточек, но привязываются к существующим", async (t) => {
  const store = await open(t, tempDir(t));
  const known = await store.clients.upsert({ name: "Анна", phone: "87010000010" });
  await store.orders.insert({ ...legacyOrder, id: "ord_new", status: "new", clientId: undefined, customerName: "Спам", customerPhone: "87010000011" });
  await store.orders.insert({ ...legacyOrder, id: "ord_off", status: "cancelled", clientId: undefined, customerName: "Спам", customerPhone: "87010000012" });
  await store.orders.insert({ ...legacyOrder, id: "ord_known", status: "new", clientId: undefined, customerName: "Аня", customerPhone: "+7 701 000 00 10" });
  await store.clients.backfill();
  assert.deepEqual((await store.clients.list()).map((c) => c.id), [known.id]);
  assert.equal((await store.orders.get("ord_new")).clientId, undefined);
  assert.equal((await store.orders.get("ord_known")).clientId, known.id);
  assert.equal((await store.clients.findByContact("кто угодно", "8 701 000 00 10")).id, known.id);
  assert.equal(await store.clients.findByContact("Спам", "87010000011"), null);
});

test("заказ: позиции по порядку, каскадное удаление, patch", async (t) => {
  const store = await open(t, tempDir(t));
  const items = [
    { id: "p1", title: "A", qty: 2, price: 10, currency: "KZT", lineTotal: 20, kind: "service" },
    { id: "p2", title: "B", qty: 1, price: 5, currency: "USD", lineTotal: 5, kind: "product" },
  ];
  const saved = await store.orders.insert({ ...legacyOrder, id: "ord_b", lead: undefined, note: undefined, legacyFlag: undefined, items });
  assert.deepEqual(saved.items, withItemDefaults(items));
  assert.equal(saved.adjustCurrency, "KZT", "валюта скидки и доставки — по первой позиции");
  assert.equal("lead" in saved, false);
  assert.equal("note" in saved, false);
  assert.ok(await store.orders.exists("ord_b"));

  const patched = await store.orders.patch("ord_b", { status: "in_progress", note: "ок" });
  assert.equal(patched.status, "in_progress");
  assert.equal(patched.note, "ок");
  assert.equal(await store.orders.patch("nope", { status: "done" }), null);

  assert.equal(await store.orders.remove("ord_b"), true);
  assert.equal(await store.orders.remove("ord_b"), false);
  const { rows } = await shared.db.query("SELECT COUNT(*)::int AS n FROM order_items");
  assert.equal(rows[0].n, 0, "позиции удалены вместе с заказом");
});

test("JSON, созданный после переноса: новые заказы дозагружаются, клиенты не дублируются", async (t) => {
  const dir = tempDir(t);
  const first = await open(t, dir, [{ id: "d1", title: "Старт" }]);
  const anna = await first.clients.upsert({ name: "Анна", phone: "87010000002" });
  await first.orders.insert({ ...legacyOrder, id: "ord_kept", clientId: anna.id });
  await first.close();

  const lateOrder = { ...legacyOrder, id: "ord_late", clientId: "cli_dup", customerName: "Анна", customerPhone: "+7 701 000 00 02" };
  fs.writeFileSync(
    path.join(dir, "orders.json"),
    JSON.stringify({
      orders: [lateOrder, { ...legacyOrder, id: "ord_kept", status: "new" }],
      clients: [{ id: "cli_dup", name: "Анна", phone: "+7 701 000 00 02" }, { id: "cli_new", name: "Борис", phone: "87010000009" }],
    })
  );
  fs.writeFileSync(path.join(dir, "products.json"), JSON.stringify({ products: [{ id: "x", title: "Игнор" }] }));

  const store = await open(t, dir);
  assert.equal((await store.orders.get("ord_late")).clientId, anna.id);
  assert.equal((await store.orders.get("ord_kept")).status, legacyOrder.status, "существующий заказ не перезаписан");
  assert.deepEqual((await store.clients.list()).map((c) => c.id).sort(), [anna.id, "cli_new"].sort());
  assert.deepEqual((await store.products.list()).map((p) => p.id), ["d1"]);
  assert.equal(fs.existsSync(path.join(dir, "orders.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "products.json")), false);

  const again = await open(t, dir);
  assert.equal((await again.orders.list()).length, 2);
});

test("повреждённый поздний JSON не мешает запуску и остаётся на месте", async (t) => {
  const dir = tempDir(t);
  await (await open(t, dir)).close();
  fs.writeFileSync(path.join(dir, "orders.json"), "{ broken");
  const store = await open(t, dir);
  assert.equal((await store.orders.list()).length, 0);
  assert.equal(fs.existsSync(path.join(dir, "orders.json")), true);
});

/* ---------- остатки ---------- */

async function stockStore(t) {
  const store = await open(t, tempDir(t));
  await store.products.insert(normalizeProduct({ id: "box", title: "Коробка", price: 100, kind: "product", stock: 5 }));
  await store.products.insert(normalizeProduct({ id: "svc", title: "Услуга", price: 50 }));
  return store;
}

const cartOrder = (id, items, extra = {}) => ({
  ...legacyOrder,
  id,
  lead: undefined,
  legacyFlag: undefined,
  status: "new",
  items: items.map(([productId, qty]) => ({ id: productId, title: productId, qty, price: 1, currency: "KZT", kind: "product" })),
  ...extra,
});

const stockOf = async (store, id) => (await store.products.get(id)).stock;

test("заказ списывает остаток; позиции без учёта не ограничены", async (t) => {
  const store = await stockStore(t);
  await store.orders.insert(cartOrder("o1", [["box", 2], ["svc", 100]]));
  assert.equal(await stockOf(store, "box"), 3);
  assert.equal(await stockOf(store, "svc"), null);
  assert.equal("reserved" in (await store.orders.get("o1")).items[0], false, "служебное поле не попадает в API");
});

test("нехватка остатка: заказ не сохраняется, ничего не списано", async (t) => {
  const store = await stockStore(t);
  await store.products.insert(normalizeProduct({ id: "mug", title: "Кружка", price: 10, stock: 1 }));
  await assert.rejects(
    store.tx(async () => {
      await store.clients.upsert({ name: "Покупатель", phone: "87010000077", source: "order" });
      await store.orders.insert(cartOrder("o2", [["mug", 1], ["box", 6]]));
    }),
    /out_of_stock/
  );
  assert.equal(await store.orders.exists("o2"), false);
  assert.equal(await stockOf(store, "box"), 5);
  assert.equal(await stockOf(store, "mug"), 1, "успешное списание по другой позиции тоже откатилось");
  assert.equal((await store.clients.list()).length, 0);
});

test("ошибка out_of_stock содержит позиции и доступное количество", async (t) => {
  const store = await stockStore(t);
  await assert.rejects(store.orders.insert(cartOrder("o3", [["box", 9]])), (err) => {
    assert.equal(err.code, "out_of_stock");
    assert.deepEqual(err.items, [{ id: "box", title: "Коробка", available: 5 }]);
    return true;
  });
});

test("последний экземпляр достаётся только одному заказу", async (t) => {
  const store = await stockStore(t);
  await store.orders.insert(cartOrder("first", [["box", 5]]));
  await assert.rejects(store.orders.insert(cartOrder("second", [["box", 1]])), /out_of_stock/);
  assert.equal(await stockOf(store, "box"), 0);
});

test("одновременные заказы: остаток не уходит в минус и не теряется", async (t) => {
  const store = await stockStore(t);
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) => store.orders.insert(cartOrder("race" + i, [["box", 1]])))
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 5);
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.code === "out_of_stock"));
  assert.equal(await stockOf(store, "box"), 0);
  assert.equal((await store.orders.list()).length, 5);
});

test("отмена возвращает остаток, снятие отмены списывает снова, повторная отмена не удваивает", async (t) => {
  const store = await stockStore(t);
  await store.orders.insert(cartOrder("o4", [["box", 2]]));
  await store.orders.patch("o4", { status: "cancelled" });
  assert.equal(await stockOf(store, "box"), 5);
  await store.orders.patch("o4", { status: "cancelled" });
  assert.equal(await stockOf(store, "box"), 5);
  await store.orders.patch("o4", { status: "in_progress" });
  assert.equal(await stockOf(store, "box"), 3);
  await store.orders.patch("o4", { status: "done" });
  assert.equal(await stockOf(store, "box"), 3, "выполнение не меняет остаток");
});

test("снятие отмены при нехватке: статус и остаток не меняются", async (t) => {
  const store = await stockStore(t);
  await store.orders.insert(cartOrder("o5", [["box", 4]]));
  await store.orders.patch("o5", { status: "cancelled" });
  await store.orders.insert(cartOrder("o6", [["box", 3]]));
  await assert.rejects(store.orders.patch("o5", { status: "new" }), /out_of_stock/);
  assert.equal((await store.orders.get("o5")).status, "cancelled");
  assert.equal(await stockOf(store, "box"), 2);
});

test("удаление: невыполненный заказ возвращает товар, выполненный и отменённый — нет", async (t) => {
  const store = await stockStore(t);
  await store.orders.insert(cartOrder("new1", [["box", 1]]));
  await store.orders.insert(cartOrder("done1", [["box", 1]]));
  await store.orders.insert(cartOrder("canc1", [["box", 1]]));
  await store.orders.patch("done1", { status: "done" });
  await store.orders.patch("canc1", { status: "cancelled" });
  assert.equal(await stockOf(store, "box"), 3);
  await store.orders.remove("done1");
  assert.equal(await stockOf(store, "box"), 3);
  await store.orders.remove("canc1");
  assert.equal(await stockOf(store, "box"), 3);
  await store.orders.remove("new1");
  assert.equal(await stockOf(store, "box"), 4);
});

test("отмена выполненного заказа не возвращает товар и не списывает его повторно", async (t) => {
  const store = await stockStore(t);
  await store.orders.insert(cartOrder("shipped", [["box", 2]]));
  await store.orders.patch("shipped", { status: "done" });
  await store.orders.patch("shipped", { status: "cancelled" });
  assert.equal(await stockOf(store, "box"), 3, "выданное остаётся у покупателя");
  await store.orders.patch("shipped", { status: "in_progress" });
  assert.equal(await stockOf(store, "box"), 3, "повторное открытие уже выданного не списывает второй раз");
  await store.orders.patch("shipped", { status: "cancelled" });
  assert.equal(await stockOf(store, "box"), 3);
});

test("снятие отметки «выполнено» снова удерживает товар, отмена после этого возвращает его", async (t) => {
  const store = await stockStore(t);
  await store.orders.insert(cartOrder("reopen", [["box", 2]]));
  await store.orders.patch("reopen", { status: "done" });
  await store.orders.patch("reopen", { status: "in_progress" });
  assert.equal(await stockOf(store, "box"), 3);
  await assert.rejects(store.products.remove("box"), (err) => err.code === "product_reserved");
  await store.orders.patch("reopen", { status: "cancelled" });
  assert.equal(await stockOf(store, "box"), 5);
});

test("товар в незакрытом заказе нельзя удалить и нельзя снять с учёта", async (t) => {
  const store = await stockStore(t);
  await store.orders.insert(cartOrder("open", [["box", 2], ["svc", 1]]));
  await assert.rejects(store.products.remove("box"), (err) => err.code === "product_reserved");
  assert.equal(await stockOf(store, "box"), 3);
  await assert.rejects(store.products.update({ ...(await store.products.get("box")), stock: null }), (err) => err.code === "stock_held");
  assert.equal(await stockOf(store, "box"), 3);
  assert.ok(await store.products.remove("svc"), "без учёта остатка удаление не блокируется");
  await store.orders.patch("open", { status: "done" });
  const disabled = await store.products.update({ ...(await store.products.get("box")), stock: null });
  assert.equal(disabled.stock, null);
  assert.ok(await store.products.remove("box"));
  await store.orders.patch("open", { status: "cancelled" });
  assert.equal((await store.orders.get("open")).status, "cancelled");
});

/* ---------- перенос из SQLite ---------- */

function writeSqlite(dir, sql) {
  const { DatabaseSync } = require("node:sqlite");
  const raw = new DatabaseSync(path.join(dir, "bazis.db"));
  raw.exec(sql);
  raw.close();
}

test("перенос из SQLite схемы 1: quantity → остаток без учёта, данные целы, файл отложен", async (t) => {
  const dir = tempDir(t);
  writeSqlite(dir, `
    CREATE TABLE products (id TEXT PRIMARY KEY, sort_order INTEGER NOT NULL, title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', title_kk TEXT NOT NULL DEFAULT '', description_kk TEXT NOT NULL DEFAULT '',
      price REAL NOT NULL DEFAULT 0 CHECK (price >= 0), currency TEXT NOT NULL DEFAULT 'KZT', kind TEXT NOT NULL DEFAULT 'service',
      category TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1, image TEXT NOT NULL);
    CREATE TABLE clients (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '', phone_key TEXT NOT NULL DEFAULT '', name_key TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual', extra TEXT);
    CREATE TABLE orders (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, channel TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new', customer_name TEXT NOT NULL DEFAULT '', customer_phone TEXT NOT NULL DEFAULT '',
      client_id TEXT, total_text TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '', source_page TEXT NOT NULL DEFAULT '',
      note TEXT, lead_direction TEXT, lead_comment TEXT, extra TEXT);
    CREATE TABLE order_items (order_id TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE, position INTEGER NOT NULL,
      product_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', qty INTEGER NOT NULL DEFAULT 1,
      price REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'KZT', line_total REAL, kind TEXT NOT NULL DEFAULT 'service',
      PRIMARY KEY (order_id, position));
    INSERT INTO products VALUES ('p1', 0, 'Старый', 'описание', '', '', 100, 'KZT', 'product', 'media', 1, 'a.jpg');
    INSERT INTO clients (id, created_at, updated_at, name, phone, phone_key, extra)
      VALUES ('cli_x', '2026-01-01', '2026-01-01', 'Ёлкин', '87010000001', '77010000001', '{"legacy":true}');
    INSERT INTO orders (id, created_at, updated_at, channel, client_id, extra)
      VALUES ('old', '2026-01-01', '2026-01-01', 'whatsapp', 'cli_x', '{"chatCode":"QW12"}');
    INSERT INTO order_items (order_id, position, product_id, title, qty) VALUES ('old', 0, 'p1', 'Старый', 3);
    PRAGMA user_version = 1;
  `);

  const store = await open(t, dir, [{ id: "d1", title: "Стартовый не нужен" }]);
  assert.deepEqual(await store.products.get("p1"), {
    id: "p1", title: "Старый", description: "описание", price: 100, currency: "KZT",
    kind: "product", category: "media", image: "a.jpg", stock: null,
  });
  assert.deepEqual((await store.products.list()).map((p) => p.id), ["p1"], "стартовый каталог не добавлен");
  const order = await store.orders.get("old");
  assert.equal(order.items[0].qty, 3);
  assert.equal(order.chatCode, "QW12", "дополнительные поля перенесены");
  assert.equal((await store.clients.get("cli_x")).legacy, true);
  assert.deepEqual((await store.orders.page({ q: "qw12" })).items.map((o) => o.id), ["old"], "поиск работает по перенесённым данным");
  await store.orders.remove("old");
  assert.equal(await stockOf(store, "p1"), null, "старые заказы ничего не списывали — и не возвращают");
  assert.equal(await store.settings.get("company"), null);

  assert.equal(fs.existsSync(path.join(dir, "bazis.db")), false, "файл SQLite больше не на рабочем месте");
  const [moved] = fs.readdirSync(path.join(dir, "legacy-sqlite"));
  assert.ok(fs.existsSync(path.join(dir, "legacy-sqlite", moved, "bazis.db")), "файл отложен, а не удалён");
});

test("перенос из SQLite схемы 3: выданный резерв становится выданным, документы и настройки переносятся", async (t) => {
  const dir = tempDir(t);
  writeSqlite(dir, `
    CREATE TABLE products (
      id TEXT PRIMARY KEY, sort_order INTEGER NOT NULL, title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', title_kk TEXT NOT NULL DEFAULT '', description_kk TEXT NOT NULL DEFAULT '',
      price REAL NOT NULL DEFAULT 0 CHECK (price >= 0), currency TEXT NOT NULL DEFAULT 'KZT',
      kind TEXT NOT NULL DEFAULT 'service', category TEXT NOT NULL, image TEXT NOT NULL,
      stock INTEGER CHECK (stock IS NULL OR stock >= 0)
    );
    CREATE TABLE clients (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '', phone_key TEXT NOT NULL DEFAULT '', name_key TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual', extra TEXT, requisites TEXT
    );
    CREATE TABLE orders (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, channel TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new', customer_name TEXT NOT NULL DEFAULT '', customer_phone TEXT NOT NULL DEFAULT '',
      client_id TEXT, total_text TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '', source_page TEXT NOT NULL DEFAULT '',
      note TEXT, lead_direction TEXT, lead_comment TEXT, extra TEXT,
      discount REAL NOT NULL DEFAULT 0, delivery REAL NOT NULL DEFAULT 0,
      adjust_currency TEXT NOT NULL DEFAULT 'KZT', vat_rate REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE order_items (
      order_id TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE, position INTEGER NOT NULL,
      product_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', qty INTEGER NOT NULL DEFAULT 1,
      price REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'KZT', line_total REAL,
      kind TEXT NOT NULL DEFAULT 'service', reserved INTEGER NOT NULL DEFAULT 0,
      discount REAL NOT NULL DEFAULT 0, PRIMARY KEY (order_id, position)
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE doc_counters (kind TEXT NOT NULL, year INTEGER NOT NULL, last INTEGER NOT NULL, PRIMARY KEY (kind, year));
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, year INTEGER NOT NULL, seq INTEGER NOT NULL, number TEXT NOT NULL,
      order_id TEXT NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
      annulled_at TEXT, replaced_by TEXT, total REAL NOT NULL, source_hash TEXT NOT NULL, snapshot TEXT NOT NULL,
      UNIQUE (kind, year, seq)
    );
    CREATE TABLE document_sends (
      id INTEGER PRIMARY KEY, document_id TEXT NOT NULL, channel TEXT NOT NULL, recipient TEXT NOT NULL DEFAULT '',
      sent_at TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT
    );
    INSERT INTO products (id, sort_order, title, category, image, stock) VALUES ('box', 0, 'Коробка', 'media', 'a.jpg', 3);
    INSERT INTO orders (id, created_at, updated_at, channel, status) VALUES
      ('done1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'whatsapp', 'done'),
      ('open1', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'whatsapp', 'new');
    INSERT INTO order_items (order_id, position, product_id, title, qty, reserved) VALUES
      ('done1', 0, 'box', 'Коробка', 2, 2),
      ('open1', 0, 'box', 'Коробка', 1, 1);
    INSERT INTO settings VALUES ('company', '{"fields":{"name":"ИП Базис"}}', '2026-01-01');
    INSERT INTO doc_counters VALUES ('invoice', 2026, 7);
    INSERT INTO documents VALUES ('doc_1', 'invoice', 2026, 7, 'СЧ-7', 'done1', 'KZT', 'active', '2026-01-03', NULL, NULL,
      200, 'h', '{"number":"СЧ-7"}');
    INSERT INTO document_sends (document_id, channel, recipient, sent_at, ok, error) VALUES
      ('doc_1', 'email', 'a@b.kz', '2026-01-04', 1, NULL);
    PRAGMA user_version = 3;
  `);

  const store = await open(t, dir);
  await store.orders.patch("done1", { status: "cancelled" });
  assert.equal(await stockOf(store, "box"), 3, "уже выданное до обновления схемы на склад не возвращается");
  await store.orders.patch("open1", { status: "cancelled" });
  assert.equal(await stockOf(store, "box"), 4, "открытый резерв по-прежнему возвращается");

  assert.deepEqual(await store.settings.get("company"), { fields: { name: "ИП Базис" } });
  assert.deepEqual((await store.documents.get("doc_1")).snapshot, { number: "СЧ-7" });
  assert.deepEqual((await store.documents.sends("doc_1")).map((s) => [s.channel, s.ok]), [["email", true]]);
  const next = await store.documents.issue({
    kind: "invoice", year: 2026, orderId: "open1", currency: "KZT",
    formatNumber: (seq) => "СЧ-" + seq,
    build: () => ({ snapshot: {}, total: 1, sourceHash: "h2" }),
  });
  assert.equal(next.number, "СЧ-8", "нумерация документов продолжается с перенесённого счётчика");
});

test("испорченный файл SQLite — понятная ошибка, PostgreSQL остаётся пустым, файл на месте", async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "bazis.db"), "это не SQLite ".repeat(500));
  await assert.rejects(open(t, dir), /повреждена или не является SQLite/);
  assert.equal(await schemaVersionOf(shared.db), 0);
  assert.equal(fs.existsSync(path.join(dir, "bazis.db")), true);
});

test("файл SQLite рядом с уже заполненной базой не переносится, а откладывается", async (t) => {
  const dir = tempDir(t);
  const warnings = [];
  const first = await open(t, dir, [{ id: "d1", title: "Старт" }]);
  await first.close();
  writeSqlite(dir, "CREATE TABLE products (id TEXT PRIMARY KEY); INSERT INTO products VALUES ('zzz'); PRAGMA user_version = 4;");
  const store = await open(t, dir, [], { log: { ...silent, warn: (text) => warnings.push(text) } });
  assert.deepEqual((await store.products.list()).map((p) => p.id), ["d1"]);
  assert.equal(fs.existsSync(path.join(dir, "bazis.db")), false);
  assert.match(warnings.join("\n"), /не переносился/);
});

/* ---------- копии ---------- */

test("копия и восстановление: все таблицы возвращаются как были, восстановление заменяет данные целиком", async (t) => {
  const dir = tempDir(t);
  const store = await open(t, dir, [{ id: "d1", title: "Старт", stock: 4 }]);
  const client = await store.clients.upsert({ name: "Анна", phone: "87010000002", requisites: { bin: "123456789012" } });
  await store.orders.insert(cartOrder("o1", [["d1", 1]], { clientId: client.id, chatCode: "ZX" }));
  await store.settings.set("company", { fields: { name: "Базис" } });
  const doc = await store.documents.issue({
    kind: "act", year: 2026, orderId: "o1", currency: "KZT",
    formatNumber: String, build: (number) => ({ snapshot: { number }, total: 1.5, sourceHash: "h" }),
  });
  await store.documents.logSend({ documentId: doc.id, channel: "telegram", recipient: "chat", ok: false, error: "нет сети" });

  const file = path.join(dir, "copy.json.gz");
  await writeDumpFile(file, await dumpDatabase(shared.db));
  const before = { orders: await store.orders.list(), clients: await store.clients.list(), products: await store.products.list() };

  await store.orders.remove("o1");
  await store.products.insert(normalizeProduct({ id: "extra", title: "Лишний" }));
  const counts = await restoreDatabase(shared.db, await readDumpFile(file));
  assert.equal(counts.orders, 1);
  assert.deepEqual(await tableCounts(shared.db), counts);

  assert.deepEqual(await store.orders.list(), before.orders);
  assert.deepEqual(await store.clients.list(), before.clients);
  assert.deepEqual(await store.products.list(), before.products, "порядок каталога сохранён");
  assert.deepEqual(await store.settings.get("company"), { fields: { name: "Базис" } });
  assert.deepEqual((await store.documents.sends(doc.id)).map((s) => [s.ok, s.error]), [[false, "нет сети"]]);
  await store.documents.logSend({ documentId: doc.id, channel: "email", recipient: "a@b.kz", ok: true });
  assert.equal((await store.documents.sends(doc.id)).length, 2, "счётчик id журнала отправок после восстановления не конфликтует");
});

test("повреждённая копия не восстанавливается и не трогает базу", async (t) => {
  const dir = tempDir(t);
  const store = await open(t, dir, [{ id: "d1", title: "Старт" }]);
  const dump = await dumpDatabase(shared.db);
  dump.tables.products.rows.push(["broken"]);
  dump.counts.products += 1;
  await assert.rejects(restoreDatabase(shared.db, dump), /копия повреждена/);
  assert.deepEqual((await store.products.list()).map((p) => p.id), ["d1"]);

  const truncated = await dumpDatabase(shared.db);
  truncated.counts.products = 5;
  await assert.rejects(restoreDatabase(shared.db, truncated), /вместо 5/);
});

/* ---------- страницы, поиск, документы ---------- */

test("страницы заказов: порядок, курсор без пропусков и повторов, фильтры и счётчики", async (t) => {
  const store = await open(t, tempDir(t));
  const make = (i, channel, status, createdAt) => ({
    ...legacyOrder, id: "ord_" + String(i).padStart(3, "0"), channel, status, createdAt,
    lead: undefined, legacyFlag: undefined, clientId: undefined,
  });
  // 7 заказов с одинаковой датой — курсор должен различать их по id
  for (let i = 0; i < 7; i++) await store.orders.insert(make(i, "whatsapp", i % 2 ? "done" : "new", "2026-02-01T00:00:00.000Z"));
  for (let i = 7; i < 12; i++) await store.orders.insert(make(i, "whatsapp", "new", `2026-02-0${i - 5}T00:00:00.000Z`));
  for (let i = 12; i < 15; i++) await store.orders.insert(make(i, "site", "new", "2026-03-01T00:00:00.000Z"));

  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = await store.orders.page({ kind: "orders", cursor, limit: 5 });
    seen.push(...page.items.map((order) => order.id));
    assert.deepEqual(page.counts, { all: 12, new: 9, in_progress: 0, done: 3, cancelled: 0 });
    assert.ok(page.items.every((order) => order.items.length === 1), "позиции подгружены");
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor);
  assert.equal(pages, 3);
  assert.equal(new Set(seen).size, 12, "без повторов");
  assert.deepEqual(seen.slice(0, 5), ["ord_011", "ord_010", "ord_009", "ord_008", "ord_007"], "новые сверху");
  assert.ok(!seen.some((id) => Number(id.slice(4)) >= 12), "заявки не попали в заказы");

  const leads = await store.orders.page({ kind: "leads", limit: 50 });
  assert.equal(leads.items.length, 3);
  assert.equal(leads.nextCursor, null);
  assert.equal(leads.counts.all, 3);

  const done = await store.orders.page({ kind: "orders", status: "done", limit: 2 });
  assert.ok(done.items.every((order) => order.status === "done"));
  assert.equal(done.items.length, 2);
  assert.ok(done.nextCursor);

  await assert.rejects(store.orders.page({ cursor: "мусор" }), (err) => err.code === "invalid_cursor");
  assert.equal((await store.orders.page({ limit: 100000 })).items.length, 15, "лимит обрезается до разумного, а не ломает запрос");
});

test("скидки, доставка и НДС сохраняются; скидка на несуществующую позицию игнорируется", async (t) => {
  const store = await open(t, tempDir(t));
  const items = [
    { id: "p1", title: "A", qty: 2, price: 10, currency: "USD", lineTotal: 20, kind: "service" },
    { id: "p2", title: "B", qty: 1, price: 5, currency: "KZT", lineTotal: 5, kind: "product" },
  ];
  await store.orders.insert({ ...legacyOrder, id: "ord_m", lead: undefined, items });
  assert.equal((await store.orders.get("ord_m")).adjustCurrency, "USD");
  const patched = await store.orders.patch("ord_m", {
    discount: 3,
    delivery: 1.5,
    adjustCurrency: "KZT",
    vatRate: 12,
    itemDiscounts: [{ position: 1, discount: 2 }, { position: 7, discount: 9 }],
  });
  assert.deepEqual(
    { discount: patched.discount, delivery: patched.delivery, adjustCurrency: patched.adjustCurrency, vatRate: patched.vatRate },
    { discount: 3, delivery: 1.5, adjustCurrency: "KZT", vatRate: 12 }
  );
  assert.deepEqual(patched.items.map((item) => item.discount), [0, 2]);
});

test("реквизиты клиента: ручная карточка хранит, контакт из заказа не трогает", async (t) => {
  const store = await open(t, tempDir(t));
  const requisites = { type: "company", legalName: "ТОО «Ромашка»", bin: "123456789012", email: "a@b.kz", address: "" };
  const client = await store.clients.upsert({ name: "Анна", phone: "87010000002", requisites });
  assert.deepEqual(client.requisites, { type: "company", legalName: "ТОО «Ромашка»", bin: "123456789012", email: "a@b.kz" });
  await store.clients.upsert({ name: "Аня", phone: "87010000002", source: "order", requisites: { bin: "1" } });
  assert.equal((await store.clients.get(client.id)).requisites.bin, "123456789012");
  const edited = await store.clients.patch(client.id, { requisites: { type: "person", iin: "900101300123" } });
  assert.deepEqual(edited.requisites, { type: "person", iin: "900101300123" });
  assert.deepEqual((await store.clients.patch(client.id, { requisites: {} })).requisites, {});
});

test("настройки: значение хранится как JSON и переживает перезапуск", async (t) => {
  const dir = tempDir(t);
  const first = await open(t, dir);
  await first.settings.set("company", { name: "ИП «Базис»", bin: "" });
  await first.close();
  assert.deepEqual(await (await open(t, dir)).settings.get("company"), { name: "ИП «Базис»", bin: "" });
});

test("документы: номера по видам и годам с 1, перевыпуск аннулирует прежний", async (t) => {
  const store = await open(t, tempDir(t));
  const issue = (kind, year, orderId, currency, replaces) =>
    store.documents.issue({
      kind,
      year,
      orderId,
      currency,
      replaces,
      formatNumber: (seq) => year + "-" + String(seq).padStart(4, "0"),
      build: (number) => ({ snapshot: { number, orderId }, total: 100, sourceHash: "h" }),
    });

  const first = await issue("invoice", 2026, "ord_1", "KZT");
  assert.equal(first.number, "2026-0001");
  assert.deepEqual(first.snapshot, { number: "2026-0001", orderId: "ord_1" });
  assert.equal((await issue("invoice", 2026, "ord_2", "KZT")).number, "2026-0002");
  assert.equal((await issue("act", 2026, "ord_1", "KZT")).number, "2026-0001", "у актов своя нумерация");
  assert.equal((await issue("invoice", 2027, "ord_3", "KZT")).number, "2027-0001", "новый год — снова с 1");

  assert.equal((await store.documents.active("ord_1", "invoice", "KZT")).id, first.id);
  assert.equal(await store.documents.active("ord_1", "invoice", "USD"), null);
  const replacement = await issue("invoice", 2026, "ord_1", "KZT", first.id);
  assert.equal(replacement.number, "2026-0003");
  const old = await store.documents.get(first.id);
  assert.equal(old.status, "annulled");
  assert.equal(old.replacedBy, replacement.id);
  assert.equal((await store.documents.active("ord_1", "invoice", "KZT")).id, replacement.id);
  assert.equal((await store.documents.listByOrder("ord_1")).length, 3);

  await assert.rejects(
    store.documents.issue({
      kind: "invoice", year: 2026, orderId: "ord_x", currency: "KZT",
      formatNumber: String,
      build: () => {
        throw new Error("boom");
      },
    }),
    /boom/
  );
  assert.equal((await issue("invoice", 2026, "ord_4", "KZT")).number, "2026-0004", "сбой при выпуске не съедает номер");

  const parallel = await Promise.all(Array.from({ length: 6 }, (_, i) => issue("invoice", 2026, "ord_p" + i, "KZT")));
  assert.deepEqual(parallel.map((doc) => doc.seq).sort((a, b) => a - b), [5, 6, 7, 8, 9, 10], "одновременный выпуск — без повторов и пропусков");

  await store.documents.logSend({ documentId: first.id, channel: "email", recipient: "a@b.kz", ok: false, error: "smtp" });
  assert.deepEqual((await store.documents.sends(first.id)).map((s) => [s.channel, s.ok, s.error]), [["email", false, "smtp"]]);
});

async function openWithTotals(t, dataDir) {
  const { orderTotalText } = require("../../documents/money");
  return open(t, dataDir, [], { orderTotalText });
}

const adminOrder = (id, extra = {}) => ({
  id,
  createdAt: "2026-03-01T10:00:00.000Z",
  channel: "whatsapp",
  status: "new",
  customerName: "Пётр",
  customerPhone: "+7 701 111 22 33",
  items: [{ id: "p1", title: "Сайт", qty: 2, price: 50000, currency: "KZT", lineTotal: 100000, kind: "service" }],
  totalText: "100\u00a0000\u00a0₸",
  ...extra,
});

test("итог заказа пересчитывается после скидок и доставки; у заявок подпись не трогается", async (t) => {
  const store = await openWithTotals(t, tempDir(t));
  await store.orders.insert(adminOrder("ord_t"));
  const patched = await store.orders.patch("ord_t", { discount: 15000, delivery: 2500, itemDiscounts: [{ position: 0, discount: 5000 }] });
  assert.equal(patched.totalText, "82\u00a0500\u00a0₸");
  assert.equal((await store.orders.get("ord_t")).totalText, "82\u00a0500\u00a0₸", "сохранено в базе");
  assert.equal(
    (await store.orders.patch("ord_t", { discount: 0, delivery: 0, itemDiscounts: [{ position: 0, discount: 0 }] })).totalText,
    "100\u00a0000\u00a0₸"
  );

  await store.orders.insert({ ...legacyOrder, id: "lead_t", lead: undefined });
  assert.equal((await store.orders.patch("lead_t", { status: "in_progress" })).totalText, "Заявка с формы");
});

test("разовый пересчёт итогов: старые заказы со скидками исправляются, updatedAt не меняется", async (t) => {
  const store = await openWithTotals(t, tempDir(t));
  await store.orders.insert(adminOrder("ord_old_total", { discount: 10000, updatedAt: "2026-03-02T10:00:00.000Z" }));
  await store.orders.insert(adminOrder("ord_ok"));
  assert.equal((await store.orders.get("ord_old_total")).totalText, "100\u00a0000\u00a0₸", "до пересчёта — как при создании");
  assert.equal(await store.orders.recomputeTotals(), 1);
  const fixed = await store.orders.get("ord_old_total");
  assert.equal(fixed.totalText, "90\u00a0000\u00a0₸");
  assert.equal(fixed.updatedAt, "2026-03-02T10:00:00.000Z");
  assert.equal(await store.orders.recomputeTotals(), 0, "повторный запуск ничего не меняет");
});

test("поиск по заказам: имя без учёта регистра, телефон в любом формате, код чата, период", async (t) => {
  const store = await open(t, tempDir(t));
  await store.orders.insert(adminOrder("s1", { customerName: "Ёлкин Пётр", customerPhone: "8 (701) 111-22-33", createdAt: "2026-03-01T10:00:00.000Z" }));
  await store.orders.insert(adminOrder("s2", { customerName: "Анна", customerPhone: "+7 702 999 00 00", createdAt: "2026-03-05T10:00:00.000Z", status: "done" }));
  await store.orders.insert(adminOrder("s3", { customerName: "100% клиент_1", customerPhone: "", createdAt: "2026-03-09T10:00:00.000Z" }));
  await store.orders.insert({ ...legacyOrder, id: "lead_s", lead: undefined, chatCode: "AB12CD", customerName: "", customerPhone: "" });
  const ids = async (params) => (await store.orders.page({ kind: "orders", ...params })).items.map((o) => o.id).sort();

  assert.deepEqual(await ids({ q: "елкин" }), ["s1"]);
  assert.deepEqual(await ids({ q: "ПЁТР" }), ["s1"]);
  assert.deepEqual(await ids({ q: "+7 701 111 22 33" }), ["s1"], "+7 и 8 — один номер");
  assert.deepEqual(await ids({ q: "87011112233" }), ["s1"]);
  assert.deepEqual(await ids({ q: "999" }), ["s2"]);
  assert.deepEqual(await ids({ q: "100%" }), ["s3"], "% и _ ищутся буквально");
  assert.deepEqual(await ids({ q: "_" }), ["s3"]);
  assert.deepEqual(await ids({ q: "\\" }), [], "обратная косая черта не ломает запрос");
  assert.deepEqual(await ids({ from: "2026-03-02T00:00:00.000Z", to: "2026-03-09T00:00:00.000Z" }), ["s2"]);
  assert.deepEqual((await store.orders.page({ kind: "leads", q: "ab12" })).items.map((o) => o.id), ["lead_s"]);

  const found = await store.orders.page({ kind: "orders", q: "анна" });
  assert.deepEqual(found.counts, { all: 1, new: 0, in_progress: 0, done: 1, cancelled: 0 }, "счётчики — по найденному");
  assert.equal((await store.orders.page({ kind: "orders" })).counts.all, 3);

  const first = await store.orders.page({ kind: "orders", q: "к", limit: 1 });
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  const second = await store.orders.page({ kind: "orders", q: "к", limit: 5, cursor: first.nextCursor });
  assert.equal(second.items.length, 1, "курсор работает вместе с поиском");
});

test("удаление клиента отвязывает его заказы; exists проверяет карточку", async (t) => {
  const store = await open(t, tempDir(t));
  const client = await store.clients.upsert({ name: "Пётр", phone: "87011112233" });
  await store.orders.insert(adminOrder("ord_c", { clientId: client.id, status: "done" }));
  assert.equal(await store.clients.exists(client.id), true);
  assert.equal(await store.clients.exists("cli_missing"), false);
  assert.equal(await store.clients.remove(client.id), true);
  assert.equal((await store.orders.get("ord_c")).clientId, undefined);
  assert.equal(await store.clients.remove(client.id), false);

  await store.orders.insert(adminOrder("ord_ghost", { clientId: "cli_gone" }));
  const anna = await store.clients.upsert({ name: "Анна", phone: "87020000000" });
  await store.orders.insert(adminOrder("ord_live", { clientId: anna.id }));
  assert.equal(await store.clients.unlinkMissing(), 1);
  assert.equal((await store.orders.get("ord_ghost")).clientId, undefined);
  assert.ok((await store.orders.get("ord_live")).clientId, "живая привязка не тронута");
});

test("ping отвечает true, пока база доступна", async (t) => {
  const store = await open(t, tempDir(t), [], { backups: false });
  assert.equal(await store.ping(), true);
});
