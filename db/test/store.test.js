const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createStore } = require("../store");

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

/** Открытые базы закрываются до удаления папки: на Windows открытый файл не удалить. */
const openStores = new Map();

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazis-store-"));
  openStores.set(dir, []);
  t.after(() => {
    for (const store of openStores.get(dir)) store.close();
    openStores.delete(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function open(t, dataDir, defaultProducts = []) {
  const store = createStore({ dataDir, normalizePhone, normalizeProduct, defaultProducts, log: silent });
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

/** Поля, которые база добавляет к любому заказу и позиции (скидки, доставка, НДС — схема v3). */
const ORDER_DEFAULTS = { discount: 0, delivery: 0, adjustCurrency: "KZT", vatRate: 0 };
const withItemDefaults = (items) => items.map((item) => ({ ...item, discount: 0 }));

test("перенос из JSON: данные совпадают, файлы отложены в legacy-json", (t) => {
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
  const store = open(t, dir);

  assert.deepEqual(store.orders.list(), [{ ...legacyOrder, ...ORDER_DEFAULTS, items: withItemDefaults(legacyOrder.items) }]);
  assert.deepEqual(store.products.list().map((p) => p.id), ["p1", "p2"]);
  assert.equal(store.products.get("p2").title_kk, "Сайт kk");
  assert.equal("title_kk" in store.products.get("p1"), false);
  assert.equal(store.clients.list().length, 1);
  assert.equal(fs.existsSync(path.join(dir, "orders.json")), false);
  assert.equal(fs.readdirSync(path.join(dir, "legacy-json")).length, 1);
  assert.ok(fs.readdirSync(path.join(dir, "backups")).some((name) => /^bazis-.*\.db$/.test(name)));
});

test("повреждённый JSON: база не создаётся, файл остаётся на месте", (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "orders.json"), "{ broken");
  assert.throws(() => createStore({ dataDir: dir, normalizePhone, normalizeProduct, defaultProducts: [], log: silent }), /orders\.json/);
  assert.equal(fs.existsSync(path.join(dir, "orders.json")), true);
});

test("без JSON — стартовый каталог; данные переживают перезапуск", (t) => {
  const dir = tempDir(t);
  const first = createStore({ dataDir: dir, normalizePhone, normalizeProduct, defaultProducts: [{ id: "d1", title: "Старт" }], log: silent });
  first.products.insert(normalizeProduct({ id: "p_new", title: "Новый" }));
  first.close();
  const second = open(t, dir, [{ id: "ignored", title: "Не должен появиться" }]);
  assert.deepEqual(second.products.list().map((p) => p.id), ["p_new", "d1"]);
});

test("tx откатывает всё при ошибке", (t) => {
  const store = open(t, tempDir(t));
  assert.throws(() =>
    store.tx(() => {
      store.clients.upsert({ name: "Анна", phone: "87010000002" });
      throw new Error("boom");
    })
  );
  assert.equal(store.clients.list().length, 0);
});

test("контакт из заказа не перезаписывает карточку, ручная правка — перезаписывает", (t) => {
  const store = open(t, tempDir(t));
  const manual = store.clients.upsert({ name: "Анна Петровна", phone: "+7 701 000 00 02", source: "manual" });
  const fromOrder = store.clients.upsert({ name: "Аня", phone: "87010000002", source: "order" });
  assert.equal(fromOrder.id, manual.id);
  assert.equal(fromOrder.name, "Анна Петровна");
  const edited = store.clients.upsert({ name: "Анна", phone: "87010000002" });
  assert.equal(edited.name, "Анна");
  assert.equal(store.clients.upsert({ name: "", phone: "" }), null);
});

test("правка клиента обновляет его заказы; backfill создаёт карточки", (t) => {
  const store = open(t, tempDir(t));
  store.orders.insert({ ...legacyOrder, id: "ord_a", clientId: undefined, customerName: "Пётр", customerPhone: "87010000003" });
  assert.equal(store.clients.backfill(), true);
  const [client] = store.clients.list();
  assert.equal(store.orders.get("ord_a").clientId, client.id);
  assert.equal(store.clients.backfill(), false);

  store.clients.patch(client.id, { name: "Пётр И.", phone: "87010000004" });
  const order = store.orders.get("ord_a");
  assert.equal(order.customerName, "Пётр И.");
  assert.equal(order.customerPhone, "87010000004");
});

test("новые и отменённые заказы не создают карточек, но привязываются к существующим", (t) => {
  const store = open(t, tempDir(t));
  const known = store.clients.upsert({ name: "Анна", phone: "87010000010" });
  store.orders.insert({ ...legacyOrder, id: "ord_new", status: "new", clientId: undefined, customerName: "Спам", customerPhone: "87010000011" });
  store.orders.insert({ ...legacyOrder, id: "ord_off", status: "cancelled", clientId: undefined, customerName: "Спам", customerPhone: "87010000012" });
  store.orders.insert({ ...legacyOrder, id: "ord_known", status: "new", clientId: undefined, customerName: "Аня", customerPhone: "+7 701 000 00 10" });
  store.clients.backfill();
  assert.deepEqual(store.clients.list().map((c) => c.id), [known.id]);
  assert.equal(store.orders.get("ord_new").clientId, undefined);
  assert.equal(store.orders.get("ord_known").clientId, known.id);
  assert.equal(store.clients.findByContact("кто угодно", "8 701 000 00 10").id, known.id);
  assert.equal(store.clients.findByContact("Спам", "87010000011"), null);
});

test("заказ: позиции по порядку, каскадное удаление, patch", (t) => {
  const store = open(t, tempDir(t));
  const items = [
    { id: "p1", title: "A", qty: 2, price: 10, currency: "KZT", lineTotal: 20, kind: "service" },
    { id: "p2", title: "B", qty: 1, price: 5, currency: "USD", lineTotal: 5, kind: "product" },
  ];
  const saved = store.orders.insert({ ...legacyOrder, id: "ord_b", lead: undefined, note: undefined, legacyFlag: undefined, items });
  assert.deepEqual(saved.items, withItemDefaults(items));
  assert.equal(saved.adjustCurrency, "KZT", "валюта скидки и доставки — по первой позиции");
  assert.equal("lead" in saved, false);
  assert.equal("note" in saved, false);
  assert.ok(store.orders.exists("ord_b"));

  const patched = store.orders.patch("ord_b", { status: "in_progress", note: "ок" });
  assert.equal(patched.status, "in_progress");
  assert.equal(patched.note, "ок");
  assert.equal(store.orders.patch("nope", { status: "done" }), null);

  assert.equal(store.orders.remove("ord_b"), true);
  assert.equal(store.orders.remove("ord_b"), false);
});

test("JSON, созданный после переноса: новые заказы дозагружаются, клиенты не дублируются", (t) => {
  const dir = tempDir(t);
  const first = createStore({ dataDir: dir, normalizePhone, normalizeProduct, defaultProducts: [{ id: "d1", title: "Старт" }], log: silent });
  const anna = first.clients.upsert({ name: "Анна", phone: "87010000002" });
  first.orders.insert({ ...legacyOrder, id: "ord_kept", clientId: anna.id });
  first.close();

  const lateOrder = { ...legacyOrder, id: "ord_late", clientId: "cli_dup", customerName: "Анна", customerPhone: "+7 701 000 00 02" };
  fs.writeFileSync(
    path.join(dir, "orders.json"),
    JSON.stringify({
      orders: [lateOrder, { ...legacyOrder, id: "ord_kept", status: "new" }],
      clients: [{ id: "cli_dup", name: "Анна", phone: "+7 701 000 00 02" }, { id: "cli_new", name: "Борис", phone: "87010000009" }],
    })
  );
  fs.writeFileSync(path.join(dir, "products.json"), JSON.stringify({ products: [{ id: "x", title: "Игнор" }] }));

  const store = open(t, dir);
  assert.equal(store.orders.get("ord_late").clientId, anna.id);
  assert.equal(store.orders.get("ord_kept").status, legacyOrder.status, "существующий заказ не перезаписан");
  assert.deepEqual(store.clients.list().map((c) => c.id).sort(), [anna.id, "cli_new"].sort());
  assert.deepEqual(store.products.list().map((p) => p.id), ["d1"]);
  assert.equal(fs.existsSync(path.join(dir, "orders.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "products.json")), false);

  const again = open(t, dir);
  assert.equal(again.orders.list().length, 2);
});

test("повреждённый поздний JSON не мешает запуску и остаётся на месте", (t) => {
  const dir = tempDir(t);
  createStore({ dataDir: dir, normalizePhone, normalizeProduct, defaultProducts: [], log: silent }).close();
  fs.writeFileSync(path.join(dir, "orders.json"), "{ broken");
  const store = open(t, dir);
  assert.equal(store.orders.list().length, 0);
  assert.equal(fs.existsSync(path.join(dir, "orders.json")), true);
});

/* ---------- остатки ---------- */

function stockStore(t) {
  const store = open(t, tempDir(t));
  store.products.insert(normalizeProduct({ id: "box", title: "Коробка", price: 100, kind: "product", stock: 5 }));
  store.products.insert(normalizeProduct({ id: "svc", title: "Услуга", price: 50 }));
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

test("заказ списывает остаток; позиции без учёта не ограничены", (t) => {
  const store = stockStore(t);
  store.orders.insert(cartOrder("o1", [["box", 2], ["svc", 100]]));
  assert.equal(store.products.get("box").stock, 3);
  assert.equal(store.products.get("svc").stock, null);
  assert.equal("reserved" in store.orders.get("o1").items[0], false, "служебное поле не попадает в API");
});

test("нехватка остатка: заказ не сохраняется, ничего не списано", (t) => {
  const store = stockStore(t);
  store.products.insert(normalizeProduct({ id: "mug", title: "Кружка", price: 10, stock: 1 }));
  assert.throws(() =>
    store.tx(() => {
      store.clients.upsert({ name: "Покупатель", phone: "87010000077", source: "order" });
      store.orders.insert(cartOrder("o2", [["mug", 1], ["box", 6]]));
    })
  );
  assert.equal(store.orders.exists("o2"), false);
  assert.equal(store.products.get("box").stock, 5);
  assert.equal(store.products.get("mug").stock, 1, "успешное списание по другой позиции тоже откатилось");
  assert.equal(store.clients.list().length, 0);
});

test("ошибка out_of_stock содержит позиции и доступное количество", (t) => {
  const store = stockStore(t);
  try {
    store.orders.insert(cartOrder("o3", [["box", 9]]));
    assert.fail("ожидалась ошибка");
  } catch (err) {
    assert.equal(err.code, "out_of_stock");
    assert.deepEqual(err.items, [{ id: "box", title: "Коробка", available: 5 }]);
  }
});

test("последний экземпляр достаётся только одному заказу", (t) => {
  const store = stockStore(t);
  store.orders.insert(cartOrder("first", [["box", 5]]));
  assert.throws(() => store.orders.insert(cartOrder("second", [["box", 1]])), /out_of_stock/);
  assert.equal(store.products.get("box").stock, 0);
});

test("отмена возвращает остаток, снятие отмены списывает снова, повторная отмена не удваивает", (t) => {
  const store = stockStore(t);
  store.orders.insert(cartOrder("o4", [["box", 2]]));
  store.orders.patch("o4", { status: "cancelled" });
  assert.equal(store.products.get("box").stock, 5);
  store.orders.patch("o4", { status: "cancelled" });
  assert.equal(store.products.get("box").stock, 5);
  store.orders.patch("o4", { status: "in_progress" });
  assert.equal(store.products.get("box").stock, 3);
  store.orders.patch("o4", { status: "done" });
  assert.equal(store.products.get("box").stock, 3, "выполнение не меняет остаток");
});

test("снятие отмены при нехватке: статус и остаток не меняются", (t) => {
  const store = stockStore(t);
  store.orders.insert(cartOrder("o5", [["box", 4]]));
  store.orders.patch("o5", { status: "cancelled" });
  store.orders.insert(cartOrder("o6", [["box", 3]]));
  assert.throws(() => store.orders.patch("o5", { status: "new" }), /out_of_stock/);
  assert.equal(store.orders.get("o5").status, "cancelled");
  assert.equal(store.products.get("box").stock, 2);
});

test("удаление: невыполненный заказ возвращает товар, выполненный и отменённый — нет", (t) => {
  const store = stockStore(t);
  store.orders.insert(cartOrder("new1", [["box", 1]]));
  store.orders.insert(cartOrder("done1", [["box", 1]]));
  store.orders.insert(cartOrder("canc1", [["box", 1]]));
  store.orders.patch("done1", { status: "done" });
  store.orders.patch("canc1", { status: "cancelled" });
  assert.equal(store.products.get("box").stock, 3);
  store.orders.remove("done1");
  assert.equal(store.products.get("box").stock, 3);
  store.orders.remove("canc1");
  assert.equal(store.products.get("box").stock, 3);
  store.orders.remove("new1");
  assert.equal(store.products.get("box").stock, 4);
});

test("отмена выполненного заказа не возвращает товар и не списывает его повторно", (t) => {
  const store = stockStore(t);
  store.orders.insert(cartOrder("shipped", [["box", 2]]));
  store.orders.patch("shipped", { status: "done" });
  store.orders.patch("shipped", { status: "cancelled" });
  assert.equal(store.products.get("box").stock, 3, "выданное остаётся у покупателя");
  store.orders.patch("shipped", { status: "in_progress" });
  assert.equal(store.products.get("box").stock, 3, "повторное открытие уже выданного не списывает второй раз");
  store.orders.patch("shipped", { status: "cancelled" });
  assert.equal(store.products.get("box").stock, 3);
});

test("снятие отметки «выполнено» снова удерживает товар, отмена после этого возвращает его", (t) => {
  const store = stockStore(t);
  store.orders.insert(cartOrder("reopen", [["box", 2]]));
  store.orders.patch("reopen", { status: "done" });
  store.orders.patch("reopen", { status: "in_progress" });
  assert.equal(store.products.get("box").stock, 3);
  assert.throws(() => store.products.remove("box"), (err) => err.code === "product_reserved");
  store.orders.patch("reopen", { status: "cancelled" });
  assert.equal(store.products.get("box").stock, 5);
});

test("товар в незакрытом заказе нельзя удалить и нельзя снять с учёта", (t) => {
  const store = stockStore(t);
  store.orders.insert(cartOrder("open", [["box", 2], ["svc", 1]]));
  assert.throws(() => store.products.remove("box"), (err) => err.code === "product_reserved");
  assert.equal(store.products.get("box").stock, 3);
  assert.throws(() => store.products.update({ ...store.products.get("box"), stock: null }), (err) => err.code === "stock_held");
  assert.equal(store.products.get("box").stock, 3);
  assert.ok(store.products.remove("svc"), "без учёта остатка удаление не блокируется");
  store.orders.patch("open", { status: "done" });
  const disabled = store.products.update({ ...store.products.get("box"), stock: null });
  assert.equal(disabled.stock, null);
  assert.ok(store.products.remove("box"));
  store.orders.patch("open", { status: "cancelled" });
  assert.equal(store.orders.get("open").status, "cancelled");
});

test("база старой схемы (v1) обновляется: quantity → stock без учёта, данные целы", (t) => {
  const dir = tempDir(t);
  const { DatabaseSync } = require("node:sqlite");
  const raw = new DatabaseSync(path.join(dir, "bazis.db"));
  raw.exec(`
    CREATE TABLE products (id TEXT PRIMARY KEY, sort_order INTEGER NOT NULL, title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', title_kk TEXT NOT NULL DEFAULT '', description_kk TEXT NOT NULL DEFAULT '',
      price REAL NOT NULL DEFAULT 0 CHECK (price >= 0), currency TEXT NOT NULL DEFAULT 'KZT', kind TEXT NOT NULL DEFAULT 'service',
      category TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1, image TEXT NOT NULL);
    CREATE INDEX products_sort ON products (sort_order);
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
    INSERT INTO orders (id, created_at, updated_at, channel) VALUES ('old', '2026-01-01', '2026-01-01', 'whatsapp');
    INSERT INTO order_items (order_id, position, product_id, title, qty) VALUES ('old', 0, 'p1', 'Старый', 3);
    PRAGMA user_version = 1;
  `);
  raw.close();

  const store = open(t, dir);
  assert.deepEqual(store.products.get("p1"), {
    id: "p1", title: "Старый", description: "описание", price: 100, currency: "KZT",
    kind: "product", category: "media", image: "a.jpg", stock: null,
  });
  assert.equal(store.orders.get("old").items[0].qty, 3);
  store.orders.remove("old");
  assert.equal(store.products.get("p1").stock, null, "старые заказы ничего не списывали — и не возвращают");
  assert.ok(fs.readdirSync(path.join(dir, "backups")).some((name) => name.startsWith("bazis-before-v4-")));
  assert.equal(store.settings.get("company"), null, "таблицы схемы v4 созданы при обновлении");
});

test("схема v3: выданный резерв при обновлении становится выданным и отменой не возвращается", (t) => {
  const dir = tempDir(t);
  const { DatabaseSync } = require("node:sqlite");
  const raw = new DatabaseSync(path.join(dir, "bazis.db"));
  raw.exec(`
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
    PRAGMA user_version = 3;
  `);
  raw.close();

  const store = open(t, dir);
  store.orders.patch("done1", { status: "cancelled" });
  assert.equal(store.products.get("box").stock, 3, "уже выданное до обновления схемы на склад не возвращается");
  store.orders.patch("open1", { status: "cancelled" });
  assert.equal(store.products.get("box").stock, 4, "открытый резерв по-прежнему возвращается");
});

test("страницы заказов: порядок, курсор без пропусков и повторов, фильтры и счётчики", (t) => {
  const store = open(t, tempDir(t));
  const make = (i, channel, status, createdAt) => ({
    ...legacyOrder, id: "ord_" + String(i).padStart(3, "0"), channel, status, createdAt,
    lead: undefined, legacyFlag: undefined, clientId: undefined,
  });
  // 7 заказов с одинаковой датой — курсор должен различать их по id
  for (let i = 0; i < 7; i++) store.orders.insert(make(i, "whatsapp", i % 2 ? "done" : "new", "2026-02-01T00:00:00.000Z"));
  for (let i = 7; i < 12; i++) store.orders.insert(make(i, "whatsapp", "new", `2026-02-0${i - 5}T00:00:00.000Z`));
  for (let i = 12; i < 15; i++) store.orders.insert(make(i, "site", "new", "2026-03-01T00:00:00.000Z"));

  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = store.orders.page({ kind: "orders", cursor, limit: 5 });
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

  const leads = store.orders.page({ kind: "leads", limit: 50 });
  assert.equal(leads.items.length, 3);
  assert.equal(leads.nextCursor, null);
  assert.equal(leads.counts.all, 3);

  const done = store.orders.page({ kind: "orders", status: "done", limit: 2 });
  assert.ok(done.items.every((order) => order.status === "done"));
  assert.equal(done.items.length, 2);
  assert.ok(done.nextCursor);

  assert.throws(() => store.orders.page({ cursor: "мусор" }), (err) => err.code === "invalid_cursor");
  assert.equal(store.orders.page({ limit: 100000 }).items.length, 15, "лимит обрезается до разумного, а не ломает запрос");
});

test("испорченный файл базы — понятная ошибка", (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "bazis.db"), "это не SQLite ".repeat(500));
  assert.throws(
    () => createStore({ dataDir: dir, normalizePhone, normalizeProduct, defaultProducts: [], log: silent }),
    /повреждена|SQLite/
  );
});

test("скидки, доставка и НДС сохраняются; скидка на несуществующую позицию игнорируется", (t) => {
  const store = open(t, tempDir(t));
  const items = [
    { id: "p1", title: "A", qty: 2, price: 10, currency: "USD", lineTotal: 20, kind: "service" },
    { id: "p2", title: "B", qty: 1, price: 5, currency: "KZT", lineTotal: 5, kind: "product" },
  ];
  store.orders.insert({ ...legacyOrder, id: "ord_m", lead: undefined, items });
  assert.equal(store.orders.get("ord_m").adjustCurrency, "USD");
  const patched = store.orders.patch("ord_m", {
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

test("реквизиты клиента: ручная карточка хранит, контакт из заказа не трогает", (t) => {
  const store = open(t, tempDir(t));
  const requisites = { type: "company", legalName: "ТОО «Ромашка»", bin: "123456789012", email: "a@b.kz", address: "" };
  const client = store.clients.upsert({ name: "Анна", phone: "87010000002", requisites });
  assert.deepEqual(client.requisites, { type: "company", legalName: "ТОО «Ромашка»", bin: "123456789012", email: "a@b.kz" });
  store.clients.upsert({ name: "Аня", phone: "87010000002", source: "order", requisites: { bin: "1" } });
  assert.equal(store.clients.get(client.id).requisites.bin, "123456789012");
  const edited = store.clients.patch(client.id, { requisites: { type: "person", iin: "900101300123" } });
  assert.deepEqual(edited.requisites, { type: "person", iin: "900101300123" });
  assert.deepEqual(store.clients.patch(client.id, { requisites: {} }).requisites, {});
});

test("настройки: значение хранится как JSON и переживает перезапуск", (t) => {
  const dir = tempDir(t);
  const first = createStore({ dataDir: dir, normalizePhone, normalizeProduct, defaultProducts: [], log: silent });
  first.settings.set("company", { name: "ИП «Базис»", bin: "" });
  first.close();
  assert.deepEqual(open(t, dir).settings.get("company"), { name: "ИП «Базис»", bin: "" });
});

test("документы: номера по видам и годам с 1, перевыпуск аннулирует прежний", (t) => {
  const store = open(t, tempDir(t));
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

  const first = issue("invoice", 2026, "ord_1", "KZT");
  assert.equal(first.number, "2026-0001");
  assert.deepEqual(first.snapshot, { number: "2026-0001", orderId: "ord_1" });
  assert.equal(issue("invoice", 2026, "ord_2", "KZT").number, "2026-0002");
  assert.equal(issue("act", 2026, "ord_1", "KZT").number, "2026-0001", "у актов своя нумерация");
  assert.equal(issue("invoice", 2027, "ord_3", "KZT").number, "2027-0001", "новый год — снова с 1");

  assert.equal(store.documents.active("ord_1", "invoice", "KZT").id, first.id);
  assert.equal(store.documents.active("ord_1", "invoice", "USD"), null);
  const replacement = issue("invoice", 2026, "ord_1", "KZT", first.id);
  assert.equal(replacement.number, "2026-0003");
  const old = store.documents.get(first.id);
  assert.equal(old.status, "annulled");
  assert.equal(old.replacedBy, replacement.id);
  assert.equal(store.documents.active("ord_1", "invoice", "KZT").id, replacement.id);
  assert.equal(store.documents.listByOrder("ord_1").length, 3);

  assert.throws(() =>
    store.documents.issue({
      kind: "invoice", year: 2026, orderId: "ord_x", currency: "KZT",
      formatNumber: String,
      build: () => {
        throw new Error("boom");
      },
    })
  );
  assert.equal(issue("invoice", 2026, "ord_4", "KZT").number, "2026-0004", "сбой при выпуске не съедает номер");

  store.documents.logSend({ documentId: first.id, channel: "email", recipient: "a@b.kz", ok: false, error: "smtp" });
  assert.deepEqual(store.documents.sends(first.id).map((s) => [s.channel, s.ok, s.error]), [["email", false, "smtp"]]);
});

function openWithTotals(t, dataDir) {
  const { orderTotalText } = require("../../documents/money");
  const store = createStore({ dataDir, normalizePhone, normalizeProduct, defaultProducts: [], log: silent, orderTotalText });
  openStores.get(dataDir).push(store);
  return store;
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

test("итог заказа пересчитывается после скидок и доставки; у заявок подпись не трогается", (t) => {
  const store = openWithTotals(t, tempDir(t));
  store.orders.insert(adminOrder("ord_t"));
  const patched = store.orders.patch("ord_t", { discount: 15000, delivery: 2500, itemDiscounts: [{ position: 0, discount: 5000 }] });
  assert.equal(patched.totalText, "82\u00a0500\u00a0₸");
  assert.equal(store.orders.get("ord_t").totalText, "82\u00a0500\u00a0₸", "сохранено в базе");
  assert.equal(store.orders.patch("ord_t", { discount: 0, delivery: 0, itemDiscounts: [{ position: 0, discount: 0 }] }).totalText, "100\u00a0000\u00a0₸");

  store.orders.insert({ ...legacyOrder, id: "lead_t", lead: undefined });
  assert.equal(store.orders.patch("lead_t", { status: "in_progress" }).totalText, "Заявка с формы");
});

test("разовый пересчёт итогов: старые заказы со скидками исправляются, updatedAt не меняется", (t) => {
  const store = openWithTotals(t, tempDir(t));
  store.orders.insert(adminOrder("ord_old_total", { discount: 10000, updatedAt: "2026-03-02T10:00:00.000Z" }));
  store.orders.insert(adminOrder("ord_ok"));
  assert.equal(store.orders.get("ord_old_total").totalText, "100\u00a0000\u00a0₸", "до пересчёта — как при создании");
  assert.equal(store.orders.recomputeTotals(), 1);
  const fixed = store.orders.get("ord_old_total");
  assert.equal(fixed.totalText, "90\u00a0000\u00a0₸");
  assert.equal(fixed.updatedAt, "2026-03-02T10:00:00.000Z");
  assert.equal(store.orders.recomputeTotals(), 0, "повторный запуск ничего не меняет");
});

test("поиск по заказам: имя без учёта регистра, телефон в любом формате, код чата, период", (t) => {
  const store = open(t, tempDir(t));
  store.orders.insert(adminOrder("s1", { customerName: "Ёлкин Пётр", customerPhone: "8 (701) 111-22-33", createdAt: "2026-03-01T10:00:00.000Z" }));
  store.orders.insert(adminOrder("s2", { customerName: "Анна", customerPhone: "+7 702 999 00 00", createdAt: "2026-03-05T10:00:00.000Z", status: "done" }));
  store.orders.insert(adminOrder("s3", { customerName: "100% клиент_1", customerPhone: "", createdAt: "2026-03-09T10:00:00.000Z" }));
  store.orders.insert({ ...legacyOrder, id: "lead_s", lead: undefined, chatCode: "AB12CD", customerName: "", customerPhone: "" });
  const ids = (params) => store.orders.page({ kind: "orders", ...params }).items.map((o) => o.id).sort();

  assert.deepEqual(ids({ q: "елкин" }), ["s1"]);
  assert.deepEqual(ids({ q: "ПЁТР" }), ["s1"]);
  assert.deepEqual(ids({ q: "+7 701 111 22 33" }), ["s1"], "+7 и 8 — один номер");
  assert.deepEqual(ids({ q: "87011112233" }), ["s1"]);
  assert.deepEqual(ids({ q: "999" }), ["s2"]);
  assert.deepEqual(ids({ q: "100%" }), ["s3"], "% и _ ищутся буквально");
  assert.deepEqual(ids({ q: "_" }), ["s3"]);
  assert.deepEqual(ids({ from: "2026-03-02T00:00:00.000Z", to: "2026-03-09T00:00:00.000Z" }), ["s2"]);
  assert.deepEqual(store.orders.page({ kind: "leads", q: "ab12" }).items.map((o) => o.id), ["lead_s"]);

  const found = store.orders.page({ kind: "orders", q: "анна" });
  assert.deepEqual(found.counts, { all: 1, new: 0, in_progress: 0, done: 1, cancelled: 0 }, "счётчики — по найденному");
  assert.equal(store.orders.page({ kind: "orders" }).counts.all, 3);

  const first = store.orders.page({ kind: "orders", q: "к", limit: 1 });
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  const second = store.orders.page({ kind: "orders", q: "к", limit: 5, cursor: first.nextCursor });
  assert.equal(second.items.length, 1, "курсор работает вместе с поиском");
});

test("удаление клиента отвязывает его заказы; exists проверяет карточку", (t) => {
  const store = open(t, tempDir(t));
  const client = store.clients.upsert({ name: "Пётр", phone: "87011112233" });
  store.orders.insert(adminOrder("ord_c", { clientId: client.id, status: "done" }));
  assert.equal(store.clients.exists(client.id), true);
  assert.equal(store.clients.exists("cli_missing"), false);
  assert.equal(store.clients.remove(client.id), true);
  assert.equal(store.orders.get("ord_c").clientId, undefined);
  assert.equal(store.clients.remove(client.id), false);

  store.orders.insert(adminOrder("ord_ghost", { clientId: "cli_gone" }));
  store.orders.insert(adminOrder("ord_live", { clientId: store.clients.upsert({ name: "Анна", phone: "87020000000" }).id }));
  assert.equal(store.clients.unlinkMissing(), 1);
  assert.equal(store.orders.get("ord_ghost").clientId, undefined);
  assert.ok(store.orders.get("ord_live").clientId, "живая привязка не тронута");
});
