/**
 * Хранилище CRM и каталога: SQLite через встроенный модуль node:sqlite (Node.js 22.13+), без зависимостей.
 * Файл базы — data/bazis.db. При первом запуске данные переносятся из data/orders.json и data/products.json,
 * сами файлы откладываются в data/legacy-json/.
 *
 * Модуль синхронный: Node выполняет каждый вызов целиком, поэтому параллельные запросы не перемешиваются.
 * Несколько связанных изменений объединяйте в store.tx(() => …) — либо применятся все, либо ни одного.
 */
const fs = require("fs");
const path = require("path");

const SCHEMA_VERSION = 4;
const BACKUP_KEEP_DAYS = 14;
const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BACKUP_FILE_RE = /^bazis-\d{4}-\d{2}-\d{2}\.db$/;

function loadSqlite() {
  // node:sqlite помечен экспериментальным и печатает предупреждение при каждом запуске — его скрываем, остальные нет.
  const emitWarning = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const type = typeof rest[0] === "string" ? rest[0] : rest[0] && rest[0].type;
    if (type === "ExperimentalWarning" && /sqlite/i.test(String(warning))) return;
    return emitWarning.call(process, warning, ...rest);
  };
  try {
    return require("node:sqlite");
  } catch (err) {
    throw new Error("Нужен Node.js 22.13 или новее (встроенный модуль node:sqlite): " + err.message);
  } finally {
    process.emitWarning = emitWarning;
  }
}

const { DatabaseSync } = loadSqlite();

/**
 * Учётные документы (счета, акты). snapshot — все данные документа на момент выпуска:
 * PDF всегда строится из него, поэтому повторное скачивание даёт тот же документ.
 * order_id без внешнего ключа: выпущенный документ остаётся и после удаления заказа.
 */
const DOCUMENTS_SCHEMA = `
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE doc_counters (
  kind TEXT NOT NULL,
  year INTEGER NOT NULL,
  last INTEGER NOT NULL,
  PRIMARY KEY (kind, year)
);

CREATE TABLE documents (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('invoice', 'act')),
  year        INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  number      TEXT NOT NULL,
  order_id    TEXT NOT NULL,
  currency    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'annulled')),
  created_at  TEXT NOT NULL,
  annulled_at TEXT,
  replaced_by TEXT,
  total       REAL NOT NULL,
  source_hash TEXT NOT NULL,
  snapshot    TEXT NOT NULL,
  UNIQUE (kind, year, seq)
);
CREATE INDEX documents_order ON documents (order_id, kind, currency, status);

CREATE TABLE document_sends (
  id          INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL,
  channel     TEXT NOT NULL,
  recipient   TEXT NOT NULL DEFAULT '',
  sent_at     TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  error       TEXT
);
CREATE INDEX document_sends_doc ON document_sends (document_id);
`;

const SCHEMA = `
CREATE TABLE products (
  id             TEXT PRIMARY KEY,
  sort_order     INTEGER NOT NULL,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  title_kk       TEXT NOT NULL DEFAULT '',
  description_kk TEXT NOT NULL DEFAULT '',
  price          REAL NOT NULL DEFAULT 0 CHECK (price >= 0),
  currency       TEXT NOT NULL DEFAULT 'KZT' CHECK (currency IN ('KZT', 'RUB', 'USD')),
  kind           TEXT NOT NULL DEFAULT 'service' CHECK (kind IN ('service', 'product')),
  category       TEXT NOT NULL,
  image          TEXT NOT NULL,
  stock          INTEGER CHECK (stock IS NULL OR stock >= 0)
);
CREATE INDEX products_sort ON products (sort_order);

CREATE TABLE clients (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT '',
  phone_key  TEXT NOT NULL DEFAULT '',
  name_key   TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT 'manual',
  extra      TEXT,
  requisites TEXT
);
CREATE INDEX clients_phone_key ON clients (phone_key);
CREATE INDEX clients_name_key ON clients (name_key);

-- client_id без внешнего ключа: карточку клиента можно удалить, заказы при этом остаются.
CREATE TABLE orders (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  channel        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'new',
  customer_name  TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  client_id      TEXT,
  total_text     TEXT NOT NULL DEFAULT '',
  message        TEXT NOT NULL DEFAULT '',
  source_page    TEXT NOT NULL DEFAULT '',
  note           TEXT,
  lead_direction TEXT,
  lead_comment   TEXT,
  extra          TEXT,
  discount        REAL NOT NULL DEFAULT 0 CHECK (discount >= 0),
  delivery        REAL NOT NULL DEFAULT 0 CHECK (delivery >= 0),
  adjust_currency TEXT NOT NULL DEFAULT 'KZT',
  vat_rate        REAL NOT NULL DEFAULT 0 CHECK (vat_rate >= 0 AND vat_rate < 100)
);
CREATE INDEX orders_created ON orders (created_at);
CREATE INDEX orders_client ON orders (client_id);

CREATE TABLE order_items (
  order_id   TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  product_id TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  qty        INTEGER NOT NULL DEFAULT 1,
  price      REAL NOT NULL DEFAULT 0,
  currency   TEXT NOT NULL DEFAULT 'KZT',
  line_total REAL,
  kind       TEXT NOT NULL DEFAULT 'service',
  reserved   INTEGER NOT NULL DEFAULT 0,
  consumed   INTEGER NOT NULL DEFAULT 0,
  discount   REAL NOT NULL DEFAULT 0 CHECK (discount >= 0),
  PRIMARY KEY (order_id, position)
);
${DOCUMENTS_SCHEMA}`;
// products.stock: NULL — остаток не учитывается (продаётся без ограничений), число — сколько можно продать.
// order_items.reserved: сколько штук сейчас удержано за незакрытым заказом (вычтено из stock).
// order_items.consumed: сколько штук уже выдано покупателю. На склад само не возвращается.
// order_items.discount — скидка на позицию суммой в валюте позиции.
// orders.discount / orders.delivery — скидка на заказ и доставка суммой в валюте orders.adjust_currency.
// orders.vat_rate — ставка НДС в процентах, уже включённого в цены; 0 — «Без НДС».
// clients.requisites — JSON с реквизитами покупателя (юрлицо, БИН/ИИН, адрес, банк, e-mail).

/** Обновления схемы: ключ — версия, до которой обновляем. Каждое выполняется в транзакции. */
const UPGRADES = {
  2: `
ALTER TABLE products ADD COLUMN stock INTEGER CHECK (stock IS NULL OR stock >= 0);
ALTER TABLE products DROP COLUMN quantity;
ALTER TABLE order_items ADD COLUMN reserved INTEGER NOT NULL DEFAULT 0;
`,
  3: `
ALTER TABLE clients ADD COLUMN requisites TEXT;
ALTER TABLE orders ADD COLUMN discount REAL NOT NULL DEFAULT 0 CHECK (discount >= 0);
ALTER TABLE orders ADD COLUMN delivery REAL NOT NULL DEFAULT 0 CHECK (delivery >= 0);
ALTER TABLE orders ADD COLUMN adjust_currency TEXT NOT NULL DEFAULT 'KZT';
ALTER TABLE orders ADD COLUMN vat_rate REAL NOT NULL DEFAULT 0 CHECK (vat_rate >= 0 AND vat_rate < 100);
ALTER TABLE order_items ADD COLUMN discount REAL NOT NULL DEFAULT 0 CHECK (discount >= 0);
${DOCUMENTS_SCHEMA}`,
  4: `
ALTER TABLE order_items ADD COLUMN consumed INTEGER NOT NULL DEFAULT 0;
UPDATE order_items SET consumed = reserved, reserved = 0
WHERE reserved > 0 AND order_id IN (SELECT id FROM orders WHERE status = 'done');
`,
};

const ORDER_KEYS = new Set([
  "id", "createdAt", "updatedAt", "channel", "status", "customerName", "customerPhone", "clientId",
  "totalText", "message", "sourcePage", "note", "lead", "items",
  "discount", "delivery", "adjustCurrency", "vatRate",
]);
const CLIENT_KEYS = new Set(["id", "createdAt", "updatedAt", "name", "phone", "note", "source", "requisites"]);

/** Поля, которых нет в схеме (например, из старых версий), хранятся как JSON и возвращаются как были. */
function extraJson(record, knownKeys) {
  const extra = {};
  for (const [key, value] of Object.entries(record)) {
    if (!knownKeys.has(key) && value !== undefined) extra[key] = value;
  }
  return Object.keys(extra).length ? JSON.stringify(extra) : null;
}

function parseExtra(text) {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

const CANCELLED = "cancelled";
const DONE = "done";
/** Статусы, в которых товар ещё удержан заказом и вернётся на склад при отмене или удалении. */
const STOCK_HELD = new Set(["new", "in_progress"]);

const ORDERS_PAGE_DEFAULT = 50;
const ORDERS_PAGE_MAX = 200;

/** Строка для поиска без учёта регистра: «Ёлкин» и «елкин» совпадают. */
function foldSearch(value) {
  return String(value ?? "")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е");
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (ch) => "\\" + ch);
}

/**
 * Условия поиска по списку заказов: q — часть имени, телефона (по цифрам) или кода обращения из чата;
 * from/to — границы created_at в ISO (from включительно, to — нет).
 * @returns {{ where: string[], params: Array<string> }}
 */
function orderSearchWhere({ q, from, to } = {}) {
  const where = [];
  const params = [];
  const text = foldSearch(q).trim().slice(0, 100);
  if (text) {
    const alternatives = [
      "bz_fold(customer_name) LIKE ? ESCAPE '\\'",
      "bz_fold(CASE WHEN json_valid(extra) THEN json_extract(extra, '$.chatCode') END) LIKE ? ESCAPE '\\'",
    ];
    params.push("%" + escapeLike(text) + "%", "%" + escapeLike(text) + "%");
    let digits = text.replace(/\D/g, "");
    // +7 701… и 8 701… — один номер: ищем по последним 10 цифрам.
    if (digits.length >= 11) digits = digits.slice(-10);
    if (digits.length >= 3) {
      alternatives.push("bz_digits(customer_phone) LIKE ?");
      params.push("%" + digits + "%");
    }
    where.push("(" + alternatives.join(" OR ") + ")");
  }
  if (from) {
    where.push("created_at >= ?");
    params.push(from);
  }
  if (to) {
    where.push("created_at < ?");
    params.push(to);
  }
  return { where, params };
}

/** Курсор страницы — дата и id последней показанной записи; непрозрачная строка для браузера. */
function encodeCursor(row) {
  return Buffer.from(JSON.stringify([row.created_at, row.id]), "utf8").toString("base64url");
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    return typeof createdAt === "string" && typeof id === "string" ? { createdAt, id } : null;
  } catch {
    return null;
  }
}

const str = (value) => (value == null ? "" : String(value));
const stockValue = (value) => (value == null ? null : value);
const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const nowIso = () => new Date().toISOString();

function newClientId() {
  return "cli_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

/**
 * @param {{
 *   dataDir: string,
 *   normalizePhone: (raw: string) => string,
 *   normalizeProduct: (raw: object) => object,
 *   defaultProducts: object[],
 *   log?: Pick<Console, "log" | "warn" | "error">,
 * }} options
 */
function createStore(options) {
  const { dataDir, normalizePhone, normalizeProduct, defaultProducts } = options;
  /** Итог заказа строкой с учётом скидок и доставки; без функции total_text после создания не меняется. */
  const orderTotalText = typeof options.orderTotalText === "function" ? options.orderTotalText : null;
  const log = options.log || console;
  const dbPath = path.join(dataDir, "bazis.db");
  const backupDir = path.join(dataDir, "backups");
  const legacyDir = path.join(dataDir, "legacy-json");
  fs.mkdirSync(dataDir, { recursive: true });

  const db = new DatabaseSync(dbPath);
  let txDepth = 0;
  let importedOrders = 0;

  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA foreign_keys = ON");
    // Встроенные lower()/LIKE SQLite регистр кириллицы не сворачивают — поиск по имени идёт через свою функцию.
    db.function("bz_fold", { deterministic: true }, foldSearch);
    db.function("bz_digits", { deterministic: true }, (value) => String(value ?? "").replace(/\D/g, ""));
    const check = db.prepare("PRAGMA quick_check").all();
    if (!(check.length === 1 && check[0].quick_check === "ok")) {
      throw new Error(check.map((row) => row.quick_check).join("; "));
    }
  } catch (err) {
    db.close();
    throw new Error(
      `База ${dbPath} повреждена или не является SQLite (${err.message}). ` +
        `Остановите сервер и замените файл последней копией из ${backupDir}.`
    );
  }

  /** Транзакция: при исключении откатывается целиком. Вложенные вызовы входят во внешнюю транзакцию. */
  function tx(fn) {
    if (txDepth > 0) return fn();
    db.exec("BEGIN IMMEDIATE");
    txDepth = 1;
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // транзакция уже откатилась
      }
      throw err;
    } finally {
      txDepth = 0;
    }
  }

  /** Подготовленные запросы; создаются, когда таблицы уже есть (при первом запуске — внутри миграции). */
  let sql = null;
  try {
    migrate();
    if (!sql) prepareStatements();
  } catch (err) {
    db.close();
    throw err;
  }

  function prepareStatements() {
    // Индексы под постраничный список заказов; IF NOT EXISTS — безопасно и для новой, и для уже существующей базы.
    db.exec(`
      CREATE INDEX IF NOT EXISTS orders_created_id ON orders (created_at, id);
      CREATE INDEX IF NOT EXISTS orders_status_created ON orders (status, created_at, id);
      CREATE INDEX IF NOT EXISTS orders_channel_status ON orders (channel, status, created_at, id);
    `);
    sql = {
      productsAll: db.prepare("SELECT * FROM products ORDER BY sort_order, rowid"),
      productById: db.prepare("SELECT * FROM products WHERE id = ?"),
      productMinSort: db.prepare("SELECT COALESCE(MIN(sort_order), 0) AS v FROM products"),
      productInsert: db.prepare(`INSERT INTO products
        (id, sort_order, title, description, title_kk, description_kk, price, currency, kind, category, image, stock)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      productUpdate: db.prepare(`UPDATE products SET
        title = ?, description = ?, title_kk = ?, description_kk = ?, price = ?, currency = ?,
        kind = ?, category = ?, image = ?, stock = ? WHERE id = ?`),
      productDelete: db.prepare("DELETE FROM products WHERE id = ?"),
      // Списание только при достаточном остатке: проверка и изменение — один атомарный запрос.
      stockTake: db.prepare("UPDATE products SET stock = stock - ? WHERE id = ? AND stock IS NOT NULL AND stock >= ?"),
      stockReturn: db.prepare("UPDATE products SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL"),
      itemSetReserved: db.prepare("UPDATE order_items SET reserved = ? WHERE order_id = ? AND position = ?"),
      itemConsume: db.prepare(
        "UPDATE order_items SET consumed = consumed + reserved, reserved = 0 WHERE order_id = ? AND position = ? AND reserved > 0"
      ),
      itemReopen: db.prepare(
        "UPDATE order_items SET reserved = reserved + consumed, consumed = 0 WHERE order_id = ? AND position = ? AND consumed > 0"
      ),
      heldByProduct: db.prepare("SELECT COALESCE(SUM(reserved), 0) AS qty FROM order_items WHERE product_id = ?"),

      ordersAll: db.prepare("SELECT * FROM orders ORDER BY created_at DESC, rowid DESC"),
      orderById: db.prepare("SELECT * FROM orders WHERE id = ?"),
      orderSetTotalText: db.prepare("UPDATE orders SET total_text = ? WHERE id = ?"),
      orderExists: db.prepare("SELECT 1 AS found FROM orders WHERE id = ?"),
      orderCountsByChannel: db.prepare("SELECT channel, status, COUNT(*) AS n FROM orders GROUP BY channel, status"),
      itemsAll: db.prepare("SELECT * FROM order_items ORDER BY order_id, position"),
      itemsByOrder: db.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY position"),
      orderInsert: db.prepare(`INSERT INTO orders
        (id, created_at, updated_at, channel, status, customer_name, customer_phone, client_id,
         total_text, message, source_page, note, lead_direction, lead_comment, extra,
         discount, delivery, adjust_currency, vat_rate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      itemInsert: db.prepare(`INSERT INTO order_items
        (order_id, position, product_id, title, qty, price, currency, line_total, kind, discount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      itemSetDiscount: db.prepare("UPDATE order_items SET discount = ? WHERE order_id = ? AND position = ?"),
      orderDelete: db.prepare("DELETE FROM orders WHERE id = ?"),
      ordersUnlinked: db.prepare(`SELECT o.id, o.status, o.customer_name, o.customer_phone, o.client_id FROM orders o
        LEFT JOIN clients c ON c.id = o.client_id WHERE c.id IS NULL`),
      ordersForClientSync: db.prepare(`SELECT id, customer_name, customer_phone, client_id FROM orders
        WHERE client_id = ? OR client_id IS NULL OR client_id = ''`),
      orderSyncClient: db.prepare(
        "UPDATE orders SET client_id = ?, customer_name = ?, customer_phone = ?, updated_at = ? WHERE id = ?"
      ),
      orderSetClient: db.prepare("UPDATE orders SET client_id = ? WHERE id = ?"),
      ordersUnlinkClient: db.prepare("UPDATE orders SET client_id = NULL WHERE client_id = ?"),
      ordersUnlinkMissing: db.prepare(`UPDATE orders SET client_id = NULL
        WHERE client_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = orders.client_id)`),

      clientsAll: db.prepare("SELECT * FROM clients ORDER BY updated_at DESC, created_at DESC, rowid DESC"),
      clientById: db.prepare("SELECT * FROM clients WHERE id = ?"),
      clientByPhoneKey: db.prepare("SELECT * FROM clients WHERE phone_key = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"),
      clientByNameKey: db.prepare(
        "SELECT * FROM clients WHERE phone_key = '' AND name_key = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"
      ),
      clientInsert: db.prepare(`INSERT INTO clients
        (id, created_at, updated_at, name, phone, phone_key, name_key, note, source, extra, requisites)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      clientUpdate: db.prepare(
        "UPDATE clients SET updated_at = ?, name = ?, phone = ?, phone_key = ?, name_key = ?, note = ?, requisites = ? WHERE id = ?"
      ),
      clientDelete: db.prepare("DELETE FROM clients WHERE id = ?"),

      settingGet: db.prepare("SELECT value FROM settings WHERE key = ?"),
      settingSet: db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`),

      counterNext: db.prepare(`INSERT INTO doc_counters (kind, year, last) VALUES (?, ?, 1)
        ON CONFLICT (kind, year) DO UPDATE SET last = last + 1 RETURNING last`),
      documentInsert: db.prepare(`INSERT INTO documents
        (id, kind, year, seq, number, order_id, currency, status, created_at, total, source_hash, snapshot)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`),
      documentById: db.prepare("SELECT * FROM documents WHERE id = ?"),
      documentsByOrder: db.prepare("SELECT * FROM documents WHERE order_id = ? ORDER BY created_at DESC, seq DESC"),
      documentActive: db.prepare(
        "SELECT * FROM documents WHERE order_id = ? AND kind = ? AND currency = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
      ),
      documentAnnul: db.prepare(
        "UPDATE documents SET status = 'annulled', annulled_at = ?, replaced_by = ? WHERE id = ? AND status = 'active'"
      ),
      sendInsert: db.prepare(`INSERT INTO document_sends (document_id, channel, recipient, sent_at, ok, error)
        VALUES (?, ?, ?, ?, ?, ?)`),
      sendsByDocument: db.prepare("SELECT * FROM document_sends WHERE document_id = ? ORDER BY sent_at DESC, id DESC"),
    };
  }

  /* ---------- преобразование строк ---------- */

  function productFromRow(row) {
    const product = {
      id: row.id,
      title: row.title,
      description: row.description,
      price: row.price,
      currency: row.currency,
      kind: row.kind,
      category: row.category,
      image: row.image,
      stock: row.stock,
    };
    if (row.title_kk) product.title_kk = row.title_kk;
    if (row.description_kk) product.description_kk = row.description_kk;
    return product;
  }

  function itemFromRow(row) {
    const item = {
      id: row.product_id,
      title: row.title,
      qty: row.qty,
      price: row.price,
      currency: row.currency,
    };
    if (row.line_total != null) item.lineTotal = row.line_total;
    item.kind = row.kind;
    item.discount = row.discount;
    return item;
  }

  function orderFromRow(row, items) {
    const order = {
      ...parseExtra(row.extra),
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      channel: row.channel,
      status: row.status,
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      items: items.map(itemFromRow),
      totalText: row.total_text,
      message: row.message,
      sourcePage: row.source_page,
      discount: row.discount,
      delivery: row.delivery,
      adjustCurrency: row.adjust_currency,
      vatRate: row.vat_rate,
    };
    if (row.lead_direction != null || row.lead_comment != null) {
      order.lead = { direction: row.lead_direction || "", comment: row.lead_comment || "" };
    }
    if (row.client_id) order.clientId = row.client_id;
    if (row.note != null) order.note = row.note;
    return order;
  }

  function clientFromRow(row) {
    return {
      ...parseExtra(row.extra),
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      name: row.name,
      phone: row.phone,
      note: row.note,
      source: row.source,
      requisites: parseExtra(row.requisites),
    };
  }

  function documentFromRow(row, withSnapshot = false) {
    const doc = {
      id: row.id,
      kind: row.kind,
      year: row.year,
      seq: row.seq,
      number: row.number,
      orderId: row.order_id,
      currency: row.currency,
      status: row.status,
      createdAt: row.created_at,
      annulledAt: row.annulled_at,
      replacedBy: row.replaced_by,
      total: row.total,
      sourceHash: row.source_hash,
    };
    if (withSnapshot) doc.snapshot = parseExtra(row.snapshot);
    return doc;
  }

  /* ---------- ключ клиента: телефон, иначе имя ---------- */

  function keyParts(name, phone) {
    return { phoneKey: normalizePhone(phone), nameKey: str(name).trim().toLowerCase() };
  }

  function clientKey(name, phone) {
    const { phoneKey, nameKey } = keyParts(name, phone);
    if (phoneKey) return "p:" + phoneKey;
    if (nameKey) return "n:" + nameKey;
    return "";
  }

  function findClientRowByKey(name, phone) {
    const { phoneKey, nameKey } = keyParts(name, phone);
    if (phoneKey) return sql.clientByPhoneKey.get(phoneKey) || null;
    if (nameKey) return sql.clientByNameKey.get(nameKey) || null;
    return null;
  }

  /* ---------- товары ---------- */

  function insertProductRow(product, sortOrder) {
    sql.productInsert.run(
      product.id, sortOrder, product.title, product.description, product.title_kk || "", product.description_kk || "",
      product.price, product.currency, product.kind, product.category, product.image, stockValue(product.stock)
    );
  }

  const products = {
    list: () => sql.productsAll.all().map(productFromRow),
    get(id) {
      const row = sql.productById.get(str(id));
      return row ? productFromRow(row) : null;
    },
    /** Новый товар — первым в каталоге. */
    insert(product) {
      return tx(() => {
        insertProductRow(product, sql.productMinSort.get().v - 1);
        return products.get(product.id);
      });
    },
    update(product) {
      return tx(() => {
        const existing = products.get(product.id);
        if (!existing) return null;
        // Выключение учёта при живом резерве обнулило бы его при отмене: штуки пропали бы из склада.
        if (product.stock == null && existing.stock != null && heldQty(product.id) > 0) {
          const err = new Error("stock_held");
          err.code = "stock_held";
          throw err;
        }
        const result = sql.productUpdate.run(
          product.title, product.description, product.title_kk || "", product.description_kk || "", product.price,
          product.currency, product.kind, product.category, product.image, stockValue(product.stock), product.id
        );
        return result.changes ? products.get(product.id) : null;
      });
    },
    /** @returns удалённый товар или null. Открытый резерв удалить нельзя — его некуда вернуть. */
    remove(id) {
      return tx(() => {
        const existing = products.get(id);
        if (!existing) return null;
        if (heldQty(existing.id) > 0) {
          const err = new Error("product_reserved");
          err.code = "product_reserved";
          throw err;
        }
        sql.productDelete.run(existing.id);
        return existing;
      });
    },
  };

  /* ---------- заказы ---------- */

  function insertOrderRow(order) {
    const lead = order.lead && typeof order.lead === "object" ? order.lead : null;
    sql.orderInsert.run(
      str(order.id),
      str(order.createdAt),
      str(order.updatedAt || order.createdAt),
      str(order.channel) || "whatsapp",
      str(order.status) || "new",
      str(order.customerName),
      str(order.customerPhone),
      order.clientId ? str(order.clientId) : null,
      str(order.totalText),
      str(order.message),
      str(order.sourcePage),
      order.note != null ? str(order.note) : null,
      lead ? str(lead.direction) : null,
      lead ? str(lead.comment) : null,
      extraJson(order, ORDER_KEYS),
      Math.max(0, num(order.discount)),
      Math.max(0, num(order.delivery)),
      str(order.adjustCurrency) || firstItemCurrency(order),
      Math.min(99.99, Math.max(0, num(order.vatRate)))
    );
    (Array.isArray(order.items) ? order.items : []).forEach((rawItem, position) => {
      const item = rawItem && typeof rawItem === "object" ? rawItem : {};
      sql.itemInsert.run(
        str(order.id),
        position,
        str(item.id),
        str(item.title),
        Math.max(1, Math.floor(num(item.qty, 1))),
        num(item.price),
        str(item.currency) || "KZT",
        item.lineTotal != null && Number.isFinite(Number(item.lineTotal)) ? Number(item.lineTotal) : null,
        str(item.kind) || "service",
        Math.max(0, num(item.discount))
      );
    });
  }

  function firstItemCurrency(order) {
    const first = Array.isArray(order.items) && order.items[0];
    return (first && str(first.currency)) || "KZT";
  }

  const orders = {
    list() {
      const itemsByOrder = new Map();
      for (const row of sql.itemsAll.all()) {
        if (!itemsByOrder.has(row.order_id)) itemsByOrder.set(row.order_id, []);
        itemsByOrder.get(row.order_id).push(row);
      }
      return sql.ordersAll.all().map((row) => orderFromRow(row, itemsByOrder.get(row.id) || []));
    },
    get(id) {
      const row = sql.orderById.get(str(id));
      return row ? orderFromRow(row, sql.itemsByOrder.all(row.id)) : null;
    },
    exists: (id) => !!sql.orderExists.get(str(id)),
    /**
     * Страница списка: новые сверху, по limit штук. cursor — значение nextCursor предыдущей страницы.
     * kind: "orders" — заказы из корзины, "leads" — заявки с формы (channel = site), иначе все.
     * q, from, to — поиск (см. orderSearchWhere).
     * counts — сколько записей этого вида в каждом статусе (для фильтров) с учётом поиска, без учёта status и cursor.
     */
    page({ kind, status, cursor, limit = ORDERS_PAGE_DEFAULT, q, from, to } = {}) {
      const size = Math.min(ORDERS_PAGE_MAX, Math.max(1, Math.floor(num(limit, ORDERS_PAGE_DEFAULT))));
      // «<> 'site'» записано двумя диапазонами: так SQLite использует индекс по channel, а не перебирает всю таблицу.
      const kindWhere =
        kind === "leads" ? "channel = 'site'" : kind === "orders" ? "(channel < 'site' OR channel > 'site')" : "1 = 1";
      const search = orderSearchWhere({ q, from, to });
      const where = [kindWhere, ...search.where];
      const params = [...search.params];
      if (status) {
        where.push("status = ?");
        params.push(str(status));
      }
      const after = decodeCursor(cursor);
      if (cursor && !after) {
        const err = new Error("invalid_cursor");
        err.code = "invalid_cursor";
        throw err;
      }
      if (after) {
        where.push("(created_at < ? OR (created_at = ? AND id < ?))");
        params.push(after.createdAt, after.createdAt, after.id);
      }
      const rows = db
        .prepare(`SELECT * FROM orders WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(...params, size + 1);
      const hasMore = rows.length > size;
      if (hasMore) rows.pop();

      const itemsByOrder = new Map(rows.map((row) => [row.id, []]));
      if (rows.length) {
        const marks = rows.map(() => "?").join(", ");
        for (const item of db
          .prepare(`SELECT * FROM order_items WHERE order_id IN (${marks}) ORDER BY order_id, position`)
          .all(...rows.map((row) => row.id))) {
          itemsByOrder.get(item.order_id).push(item);
        }
      }

      // Группировка по (channel, status) читает только индекс orders_channel_status, не трогая строки таблицы.
      const counts = { all: 0, new: 0, in_progress: 0, done: 0, cancelled: 0 };
      if (search.where.length) {
        const countRows = db
          .prepare(
            `SELECT status, COUNT(*) AS n FROM orders WHERE ${[kindWhere, ...search.where].join(" AND ")} GROUP BY status`
          )
          .all(...search.params);
        for (const row of countRows) {
          counts.all += row.n;
          counts[row.status] = (counts[row.status] || 0) + row.n;
        }
      } else {
        for (const row of sql.orderCountsByChannel.all()) {
          if (kind === "leads" ? row.channel !== "site" : kind === "orders" && row.channel === "site") continue;
          counts.all += row.n;
          counts[row.status] = (counts[row.status] || 0) + row.n;
        }
      }

      const last = rows[rows.length - 1];
      return {
        items: rows.map((row) => orderFromRow(row, itemsByOrder.get(row.id))),
        nextCursor: hasMore ? encodeCursor(last) : null,
        counts,
      };
    },
    /** Новый заказ со списанием остатков; при нехватке — исключение out_of_stock, ничего не сохраняется. */
    insert(order) {
      return tx(() => {
        insertOrderRow(order);
        if (str(order.status) !== CANCELLED) reserveStock(order.id);
        if (str(order.status) === DONE) consumeStock(order.id);
        return orders.get(order.id);
      });
    },
    /**
     * Частичное обновление; поля уже проверены сервером.
     * Отмена нового или взятого в работу заказа возвращает удержанное на склад.
     * «Выполнено» фиксирует выдачу: отмена после этого товар не возвращает.
     * Снятие отметки «выполнено» (обратно в новый или в работу) снова удерживает товар без повторного списания.
     * Снятие отмены списывает снова (при нехватке — out_of_stock), уже выданное повторно не списывается.
     * itemDiscounts — скидки на позиции: [{ position, discount }], позиции, которых нет в заказе, пропускаются.
     * @param {{ status?: string, customerName?: string, customerPhone?: string, note?: string, clientId?: string,
     *   discount?: number, delivery?: number, adjustCurrency?: string, vatRate?: number,
     *   itemDiscounts?: Array<{ position: number, discount: number }> }} fields
     */
    patch(id, fields) {
      return tx(() => {
        const row = sql.orderById.get(str(id));
        if (!row) return null;
        if (fields.status !== undefined && fields.status !== row.status) {
          applyStockForStatus(row.id, row.status, fields.status);
        }
        for (const { position, discount } of fields.itemDiscounts || []) {
          sql.itemSetDiscount.run(discount, row.id, position);
        }
        const updated = patchOrderRow(row.id, fields);
        return syncTotalText(updated) || updated;
      });
    },
    /**
     * Пересчитать total_text у всех заказов (не заявок) — для записей, сохранённых до учёта скидок и доставки.
     * updated_at не меняется: содержимое заказа то же. Возвращает число исправленных записей.
     */
    recomputeTotals() {
      if (!orderTotalText) return 0;
      return tx(() => {
        let fixed = 0;
        for (const order of orders.list()) {
          if (order.channel === "site") continue;
          const text = orderTotalText(order);
          if (text && text !== order.totalText) {
            sql.orderSetTotalText.run(text, order.id);
            fixed++;
          }
        }
        return fixed;
      });
    },
    /** Удаление невыполненного заказа возвращает товар на склад; выполненного — нет (товар уже у покупателя). */
    remove(id) {
      return tx(() => {
        const row = sql.orderById.get(str(id));
        if (!row) return false;
        if (STOCK_HELD.has(row.status)) releaseStock(row.id);
        sql.orderDelete.run(row.id);
        return true;
      });
    },
  };

  function heldQty(productId) {
    return sql.heldByProduct.get(str(productId)).qty;
  }

  /**
   * Склад при смене статуса.
   * Выдача (done) переводит удержанное в consumed: отмена после выдачи товар не возвращает.
   * Возврат из done в новый или в работу снова удерживает те же штуки, повторно не списывая.
   * Отмена до выдачи возвращает удержанное. Снятие отмены списывает заново, уже выданное — нет.
   */
  function applyStockForStatus(orderId, prev, next) {
    if (prev === CANCELLED) reserveStock(orderId);
    if (next === DONE) consumeStock(orderId);
    else if (prev === DONE && next !== CANCELLED) reopenStock(orderId);
    else if (next === CANCELLED && prev !== DONE) releaseStock(orderId);
  }

  /**
   * Списать остатки по позициям, которые ещё не удержаны и не выданы.
   * Позиции без учёта остатка пропускаются.
   * Нехватка хотя бы по одной позиции — исключение со списком { id, title, available }; транзакция откатится.
   */
  function reserveStock(orderId) {
    const shortages = [];
    for (const item of sql.itemsByOrder.all(orderId)) {
      if (item.reserved > 0 || item.consumed > 0) continue;
      const product = sql.productById.get(item.product_id);
      if (!product || product.stock == null) continue;
      if (sql.stockTake.run(item.qty, product.id, item.qty).changes) {
        sql.itemSetReserved.run(item.qty, orderId, item.position);
      } else {
        shortages.push({ id: product.id, title: product.title, available: product.stock });
      }
    }
    if (shortages.length) {
      const err = new Error("out_of_stock");
      err.code = "out_of_stock";
      err.items = shortages;
      throw err;
    }
  }

  /** Выдано покупателю: удержание снимается, на склад штуки не возвращаются. */
  function consumeStock(orderId) {
    for (const item of sql.itemsByOrder.all(orderId)) {
      if (item.reserved <= 0) continue;
      sql.itemConsume.run(orderId, item.position);
    }
  }

  /** Заказ снова открыт до выдачи: те же штуки опять удержаны, доступный остаток не меняется. */
  function reopenStock(orderId) {
    for (const item of sql.itemsByOrder.all(orderId)) {
      if (item.consumed <= 0) continue;
      sql.itemReopen.run(orderId, item.position);
    }
  }

  /**
   * Вернуть на склад всё удержанное по заказу.
   * Учёт выключен — резерв не сбрасываем: иначе повторное включение учёта потеряет эти штуки.
   * Товара уже нет — возвращать некуда, резерв снимаем.
   */
  function releaseStock(orderId) {
    for (const item of sql.itemsByOrder.all(orderId)) {
      if (item.reserved <= 0) continue;
      const product = sql.productById.get(item.product_id);
      if (!product) {
        sql.itemSetReserved.run(0, orderId, item.position);
        continue;
      }
      if (product.stock == null) continue;
      if (sql.stockReturn.run(item.reserved, product.id).changes) {
        sql.itemSetReserved.run(0, orderId, item.position);
      }
    }
  }

  function patchOrderRow(id, fields) {
    const columns = {
      status: "status",
      customerName: "customer_name",
      customerPhone: "customer_phone",
      note: "note",
      clientId: "client_id",
      discount: "discount",
      delivery: "delivery",
      adjustCurrency: "adjust_currency",
      vatRate: "vat_rate",
    };
    const sets = ["updated_at = ?"];
    const values = [nowIso()];
    for (const [key, column] of Object.entries(columns)) {
      if (fields[key] === undefined) continue;
      sets.push(column + " = ?");
      values.push(fields[key]);
    }
    const result = db.prepare("UPDATE orders SET " + sets.join(", ") + " WHERE id = ?").run(...values, str(id));
    return result.changes ? orders.get(id) : null;
  }

  /** У заявок (channel = site) в total_text подпись, а не сумма — её не трогаем. */
  function syncTotalText(order) {
    if (!order || !orderTotalText || order.channel === "site") return null;
    const text = orderTotalText(order);
    if (!text || text === order.totalText) return null;
    sql.orderSetTotalText.run(text, order.id);
    return { ...order, totalText: text };
  }

  /* ---------- клиенты ---------- */

  function insertClientRow(client) {
    const { phoneKey, nameKey } = keyParts(client.name, client.phone);
    sql.clientInsert.run(
      str(client.id),
      str(client.createdAt),
      str(client.updatedAt || client.createdAt),
      str(client.name),
      str(client.phone),
      phoneKey,
      nameKey,
      str(client.note),
      client.source === "order" ? "order" : "manual",
      extraJson(client, CLIENT_KEYS),
      requisitesJson(client.requisites)
    );
  }

  function saveClientRow(client) {
    const { phoneKey, nameKey } = keyParts(client.name, client.phone);
    sql.clientUpdate.run(
      client.updatedAt, client.name, client.phone, phoneKey, nameKey, client.note, requisitesJson(client.requisites), client.id
    );
  }

  /** Реквизиты уже проверены сервером; пустой набор не храним. */
  function requisitesJson(requisites) {
    if (!requisites || typeof requisites !== "object") return null;
    const filled = Object.entries(requisites).filter(([, value]) => value !== "" && value != null);
    return filled.length ? JSON.stringify(Object.fromEntries(filled)) : null;
  }

  /** Привязать/обновить заказы клиента по clientId или старому ключу контакта. */
  function syncOrdersForClient(client, previousKey) {
    if (!client || !client.id) return;
    const now = nowIso();
    const currentKey = clientKey(client.name, client.phone);
    for (const row of sql.ordersForClientSync.all(client.id)) {
      const byId = row.client_id === client.id;
      const orderKey = clientKey(row.customer_name, row.customer_phone);
      const byPrevious = !!previousKey && !row.client_id && orderKey === previousKey;
      const byCurrent = !row.client_id && !!orderKey && orderKey === currentKey;
      if (!byId && !byPrevious && !byCurrent) continue;
      sql.orderSyncClient.run(
        client.id,
        client.name || row.customer_name,
        client.phone || row.customer_phone,
        now,
        row.id
      );
    }
  }

  const clients = {
    list: () => sql.clientsAll.all().map(clientFromRow),
    get(id) {
      const row = sql.clientById.get(str(id));
      return row ? clientFromRow(row) : null;
    },
    key: clientKey,

    /** Существующая карточка по телефону (или имени без телефона); ничего не создаёт. */
    findByContact(name, phone) {
      const row = findClientRowByKey(str(name).trim(), str(phone).trim());
      return row ? clientFromRow(row) : null;
    },

    /**
     * Найти клиента (по id, затем по телефону/имени) и обновить, либо создать.
     * Контакт из заказа (source: "order") только дополняет пустые поля существующей карточки.
     */
    upsert(fields) {
      return tx(() => {
        const name = str(fields.name).trim();
        const phone = str(fields.phone).trim();
        const note = fields.note != null ? str(fields.note).trim() : undefined;
        if (!name && !normalizePhone(phone)) return null;

        let row = fields.id ? sql.clientById.get(str(fields.id)) : null;
        if (!row) row = findClientRowByKey(name, phone);

        if (row) {
          const existing = clientFromRow(row);
          const fromOrder = fields.source === "order";
          if (name && (!fromOrder || !existing.name)) existing.name = name;
          if (phone && (!fromOrder || !existing.phone)) existing.phone = phone;
          if (note !== undefined) existing.note = note;
          if (fields.requisites !== undefined && !fromOrder) existing.requisites = fields.requisites;
          existing.updatedAt = nowIso();
          saveClientRow(existing);
          return clients.get(existing.id);
        }

        const now = nowIso();
        const client = {
          id: str(fields.id) || newClientId(),
          createdAt: now,
          updatedAt: now,
          name,
          phone,
          note: note || "",
          source: fields.source === "order" ? "order" : "manual",
          requisites: fields.source === "order" ? null : fields.requisites,
        };
        insertClientRow(client);
        return clients.get(client.id);
      });
    },

    /** Правка карточки из CRM; заказы клиента получают новое имя/телефон. */
    patch(id, fields) {
      return tx(() => {
        const row = sql.clientById.get(str(id));
        if (!row) return null;
        const client = clientFromRow(row);
        const previousKey = clientKey(client.name, client.phone);
        if (fields.name !== undefined) client.name = fields.name;
        if (fields.phone !== undefined) client.phone = fields.phone;
        if (fields.note !== undefined) client.note = fields.note;
        if (fields.requisites !== undefined) client.requisites = fields.requisites;
        client.updatedAt = nowIso();
        saveClientRow(client);
        syncOrdersForClient(client, previousKey);
        return clients.get(client.id);
      });
    },

    syncOrders: (client, previousKey) => tx(() => syncOrdersForClient(client, previousKey)),

    exists: (id) => !!sql.clientById.get(str(id)),

    /** Убрать у заказов ссылки на карточки, которых больше нет (удалены до того, как удаление стало отвязывать заказы). */
    unlinkMissing: () => Number(sql.ordersUnlinkMissing.run().changes),

    /** Удаление карточки; её заказы остаются, но больше на неё не ссылаются. */
    remove(id) {
      return tx(() => {
        if (!sql.clientDelete.run(str(id)).changes) return false;
        sql.ordersUnlinkClient.run(str(id));
        return true;
      });
    },

    /**
     * Проставить недостающие clientId и досоздать карточки для заказов, взятых в работу.
     * Новые и отменённые заказы только привязываются к уже существующей карточке:
     * публичная форма не должна плодить карточки (спам), их создаёт переход заказа в работу.
     */
    backfill() {
      return tx(() => {
        let changed = false;
        for (const row of sql.ordersUnlinked.all()) {
          if (!clientKey(row.customer_name, row.customer_phone)) continue;
          let client = findClientRowByKey(row.customer_name, row.customer_phone);
          if (!client && (row.status === "new" || row.status === "cancelled")) continue;
          if (!client) {
            client = clients.upsert({ name: row.customer_name, phone: row.customer_phone, source: "order" });
            changed = true;
          }
          if (client && row.client_id !== client.id) {
            sql.orderSetClient.run(client.id, row.id);
            changed = true;
          }
        }
        return changed;
      });
    },
  };

  /* ---------- настройки ---------- */

  const settings = {
    /** @returns {object | null} значение, сохранённое как JSON */
    get(key) {
      const row = sql.settingGet.get(str(key));
      if (!row) return null;
      try {
        return JSON.parse(row.value);
      } catch {
        return null;
      }
    },
    set(key, value) {
      sql.settingSet.run(str(key), JSON.stringify(value), nowIso());
      return settings.get(key);
    },
  };

  /* ---------- учётные документы ---------- */

  const documents = {
    get(id, withSnapshot = true) {
      const row = sql.documentById.get(str(id));
      return row ? documentFromRow(row, withSnapshot) : null;
    },
    listByOrder: (orderId) => sql.documentsByOrder.all(str(orderId)).map((row) => documentFromRow(row)),
    /** Действующий документ этого вида по заказу и валюте или null. */
    active(orderId, kind, currency) {
      const row = sql.documentActive.get(str(orderId), str(kind), str(currency));
      return row ? documentFromRow(row, true) : null;
    },
    /**
     * Выпустить документ со следующим номером года: счётчик и запись меняются в одной транзакции,
     * поэтому номера не повторяются и не пропускаются.
     * @param {{ kind: "invoice" | "act", orderId: string, currency: string, year: number,
     *   formatNumber: (seq: number) => string, build: (number: string) => { snapshot: object, total: number, sourceHash: string },
     *   replaces?: string }} input
     */
    issue(input) {
      return tx(() => {
        const seq = sql.counterNext.get(input.kind, input.year).last;
        const number = input.formatNumber(seq);
        const { snapshot, total, sourceHash } = input.build(number);
        const id = "doc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
        const now = nowIso();
        sql.documentInsert.run(
          id, input.kind, input.year, seq, number, str(input.orderId), str(input.currency), now, total, sourceHash,
          JSON.stringify(snapshot)
        );
        if (input.replaces) sql.documentAnnul.run(now, id, str(input.replaces));
        return documents.get(id);
      });
    },
    logSend({ documentId, channel, recipient, ok, error }) {
      sql.sendInsert.run(str(documentId), str(channel), str(recipient), nowIso(), ok ? 1 : 0, error ? str(error) : null);
    },
    sends: (documentId) =>
      sql.sendsByDocument.all(str(documentId)).map((row) => ({
        channel: row.channel,
        recipient: row.recipient,
        sentAt: row.sent_at,
        ok: !!row.ok,
        error: row.error,
      })),
  };

  /* ---------- миграция из JSON ---------- */

  function readLegacyJson(fileName, listKeys) {
    const filePath = path.join(dataDir, fileName);
    if (!fs.existsSync(filePath)) return null;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    } catch (err) {
      throw new Error(`Не удалось перенести ${filePath} в SQLite: файл повреждён (${err.message}). Исправьте его и запустите снова.`);
    }
    const out = {};
    for (const key of listKeys) {
      const value = data && data[key];
      if (value != null && !Array.isArray(value)) {
        throw new Error(`Не удалось перенести ${filePath} в SQLite: поле «${key}» должно быть списком.`);
      }
      out[key] = value || [];
    }
    return out;
  }

  function migrate() {
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (version > SCHEMA_VERSION) {
      throw new Error(`База ${dbPath} создана более новой версией сайта (схема ${version}). Обновите сайт.`);
    }
    if (version > 0) {
      if (version < SCHEMA_VERSION) upgrade(version);
      prepareStatements();
      importLateJson();
      return;
    }

    const legacyOrders = readLegacyJson("orders.json", ["orders", "clients"]);
    const legacyProducts = readLegacyJson("products.json", ["products"]);
    const stats = { products: 0, clients: 0, orders: 0, skipped: 0 };

    tx(() => {
      db.exec(SCHEMA);
      prepareStatements();

      const productList = legacyProducts ? legacyProducts.products : defaultProducts;
      const seenProducts = new Set();
      productList.forEach((raw, index) => {
        const source = raw && typeof raw === "object" ? raw : {};
        const product = normalizeProduct({ ...source, id: str(source.id).trim() || "p_import_" + index });
        if (!product.title || seenProducts.has(product.id)) {
          stats.skipped += 1;
          return;
        }
        seenProducts.add(product.id);
        insertProductRow(product, index);
        stats.products += 1;
      });

      if (legacyOrders) importOrdersAndClients(legacyOrders, stats);

      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });

    if (legacyOrders || legacyProducts) {
      log.log(
        `SQLite: перенесено товаров ${stats.products}, клиентов ${stats.clients}, заказов ${stats.orders}` +
          (stats.skipped ? `, пропущено записей без id или с повтором id: ${stats.skipped}` : "")
      );
      moveLegacyFiles();
    }
  }

  /** Обновить схему до текущей версии; перед этим — отдельная копия базы, которую ротация копий не удаляет. */
  function upgrade(fromVersion) {
    fs.mkdirSync(backupDir, { recursive: true });
    const copy = path.join(backupDir, `bazis-before-v${SCHEMA_VERSION}-${nowIso().replace(/[:.]/g, "-")}.db`);
    db.prepare("VACUUM INTO ?").run(copy);
    tx(() => {
      for (let next = fromVersion + 1; next <= SCHEMA_VERSION; next++) {
        db.exec(UPGRADES[next]);
        db.exec(`PRAGMA user_version = ${next}`);
      }
    });
    log.log(`SQLite: схема обновлена с версии ${fromVersion} до ${SCHEMA_VERSION}, копия до обновления: ${copy}`);
  }

  /**
   * Записи без id или с id, который уже есть в базе, пропускаются — повторный импорт ничего не дублирует.
   * mergeByContact: клиент с тем же телефоном (или именем без телефона), что и в базе, не заводится повторно,
   * его заказы привязываются к существующей карточке.
   */
  function importOrdersAndClients(legacyOrders, stats, mergeByContact = false) {
    const now = nowIso();
    const clientIdMap = new Map();
    for (const raw of legacyOrders.clients) {
      const client = raw && typeof raw === "object" ? raw : {};
      const id = str(client.id).trim();
      if (!id || sql.clientById.get(id)) {
        stats.skipped += 1;
        continue;
      }
      const same = mergeByContact ? findClientRowByKey(client.name, client.phone) : null;
      if (same) {
        clientIdMap.set(id, same.id);
        continue;
      }
      insertClientRow({ ...client, id, createdAt: client.createdAt || now, updatedAt: client.updatedAt || client.createdAt || now });
      stats.clients += 1;
    }
    for (const raw of legacyOrders.orders) {
      const order = raw && typeof raw === "object" ? raw : {};
      const id = str(order.id).trim();
      if (!id || sql.orderExists.get(id)) {
        stats.skipped += 1;
        continue;
      }
      const createdAt = order.createdAt || order.updatedAt || now;
      const clientId = clientIdMap.get(str(order.clientId)) || order.clientId;
      insertOrderRow({ ...order, id, clientId, createdAt, updatedAt: order.updatedAt || createdAt });
      stats.orders += 1;
      importedOrders += 1;
    }
  }

  /**
   * JSON-файлы рядом с уже перенесённой базой появляются, если после переноса успел поработать старый сервер.
   * Новые заказы и клиенты из них дозагружаем, каталог — нет (старый сервер пересоздаёт его из стартового).
   */
  function importLateJson() {
    const ordersFile = path.join(dataDir, "orders.json");
    const productsFile = path.join(dataDir, "products.json");
    if (!fs.existsSync(ordersFile) && !fs.existsSync(productsFile)) return;

    let legacyOrders;
    try {
      legacyOrders = readLegacyJson("orders.json", ["orders", "clients"]);
    } catch (err) {
      log.warn(`⚠ ${err.message} Файл оставлен на месте, в базу из него ничего не добавлено.`);
      return;
    }
    const stats = { products: 0, clients: 0, orders: 0, skipped: 0 };
    if (legacyOrders) tx(() => importOrdersAndClients(legacyOrders, stats, true));
    const target = moveLegacyFiles();
    log.warn(
      `⚠ Найдены JSON-файлы, созданные после перехода на SQLite (похоже, работал старый сервер). ` +
        `Добавлено новых заказов: ${stats.orders}, клиентов: ${stats.clients}. ` +
        `Правки каталога из products.json не переносятся — при необходимости сверьте вручную: ${target}`
    );
  }

  /** После успешного переноса JSON-файлы больше не используются: откладываем их, а не удаляем. */
  function moveLegacyFiles() {
    const stamp = nowIso().replace(/[:.]/g, "-");
    const target = path.join(legacyDir, stamp);
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(dataDir)) {
      if (!/^(orders|products)\.json(\.bak|\.tmp)?$/.test(name)) continue;
      try {
        fs.renameSync(path.join(dataDir, name), path.join(target, name));
      } catch (err) {
        log.warn(`Не удалось переместить ${name} в ${target}: ${err.message}. Файл больше не используется.`);
      }
    }
    log.log(`Старые JSON-файлы перемещены в ${target}`);
    return target;
  }

  /* ---------- резервные копии ---------- */

  /**
   * Одна копия в день (по местной дате): создаётся при запуске, а если сервер работает непрерывно — проверкой раз в 6 часов.
   * VACUUM INTO даёт согласованный снимок даже во время работы; хранятся последние 14 копий.
   */
  function backup() {
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      const d = new Date();
      const day = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
      const target = path.join(backupDir, "bazis-" + day + ".db");
      if (!fs.existsSync(target)) {
        const tmp = target + ".tmp";
        fs.rmSync(tmp, { force: true });
        db.prepare("VACUUM INTO ?").run(tmp);
        fs.renameSync(tmp, target);
      }
      const files = fs.readdirSync(backupDir).filter((name) => BACKUP_FILE_RE.test(name)).sort();
      for (const name of files.slice(0, Math.max(0, files.length - BACKUP_KEEP_DAYS))) {
        fs.unlinkSync(path.join(backupDir, name));
      }
    } catch (err) {
      log.error("Не удалось сделать резервную копию базы:", err.message);
    }
  }

  backup();
  const backupTimer = setInterval(backup, BACKUP_INTERVAL_MS);
  backupTimer.unref();

  return {
    path: dbPath,
    backupDir,
    tx,
    products,
    orders,
    clients,
    settings,
    documents,
    backup,
    /** При этом запуске в базу добавлены заказы из старых JSON-файлов — их нужно привязать к карточкам. */
    importedOrders: () => importedOrders,
    close() {
      clearInterval(backupTimer);
      db.close();
    },
  };
}

module.exports = { createStore };
