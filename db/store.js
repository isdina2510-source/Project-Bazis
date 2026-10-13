/**
 * Хранилище CRM и каталога: PostgreSQL (адрес — DATABASE_URL, см. db/connection.js).
 *
 * При первом запуске на пустой базе создаётся схема и переносятся прежние данные: из SQLite (data/bazis.db),
 * а если её нет — из data/orders.json и data/products.json. Старые файлы откладываются, а не удаляются.
 *
 * Все методы асинхронные. Пишущие транзакции выполняются по очереди (pg_advisory_xact_lock), поэтому параллельные
 * запросы не перемешиваются: проверка остатка и списание, поиск клиента и создание карточки, номер документа.
 * Несколько связанных изменений объединяйте в store.tx(async () => …) — либо применятся все, либо ни одного;
 * методы хранилища, вызванные внутри, входят в эту же транзакцию.
 */
const fs = require("fs");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");
const { openDatabase } = require("./connection");
const { SCHEMA, SCHEMA_VERSION, WRITE_LOCK, UPGRADES } = require("./schema");
const { dumpDatabase, writeDumpFile, schemaVersionOf } = require("./dump");
const { importSqliteFile, moveSqliteFiles, SQLITE_FILE } = require("./sqlite-import");

const BACKUP_KEEP_DAYS = 14;
const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BACKUP_FILE_RE = /^bazis-\d{4}-\d{2}-\d{2}\.json\.gz$/;

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

/** Строка для поиска без учёта регистра: «Ёлкин» и «елкин» совпадают (в базе то же делает bz_fold). */
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
      "bz_fold(bz_json_field(extra, 'chatCode')) LIKE ? ESCAPE '\\'",
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

/** Запрос с «?» → с $1, $2… (знаков «?» внутри строковых литералов в запросах хранилища нет). */
const placeholderCache = new Map();
function toPg(text) {
  let converted = placeholderCache.get(text);
  if (converted === undefined) {
    let n = 0;
    converted = text.replace(/\?/g, () => "$" + ++n);
    if (placeholderCache.size < 500) placeholderCache.set(text, converted);
  }
  return converted;
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
 *   databaseUrl?: string,
 *   normalizePhone: (raw: string) => string,
 *   normalizeProduct: (raw: object) => object,
 *   defaultProducts: object[],
 *   orderTotalText?: (order: object) => string,
 *   log?: Pick<Console, "log" | "warn" | "error">,
 *   onBackupError?: (err: Error) => void,
 *   backups?: boolean,
 *   connectWaitMs?: number,
 *   db?: Awaited<ReturnType<typeof openDatabase>>,
 * }} options
 */
async function createStore(options) {
  const { dataDir, normalizePhone, normalizeProduct, defaultProducts, onBackupError } = options;
  /** Итог заказа строкой с учётом скидок и доставки; без функции total_text после создания не меняется. */
  const orderTotalText = typeof options.orderTotalText === "function" ? options.orderTotalText : null;
  const log = options.log || console;
  const databaseUrl = options.databaseUrl != null ? options.databaseUrl : process.env.DATABASE_URL;
  const backupDir = path.join(dataDir, "backups");
  const legacyDir = path.join(dataDir, "legacy-json");
  fs.mkdirSync(dataDir, { recursive: true });

  /** options.db — уже открытое подключение (тесты); его закрывает тот, кто открыл. */
  const ownsDb = !options.db;
  const db = options.db || (await openDatabase(databaseUrl, { log, waitMs: options.connectWaitMs }));
  /** Соединение текущей транзакции (или снимка для чтения); вне них — пул. */
  const als = new AsyncLocalStorage();
  let importedOrders = 0;

  /**
   * Контекст наследуют и задачи, запущенные изнутри транзакции без await (таймеры, промисы): после COMMIT
   * соединение уже в пуле и может принадлежать чужой транзакции, поэтому такие задачи идут мимо него, в пул.
   */
  const current = () => {
    const scope = als.getStore();
    return scope && !scope.done ? scope.client : null;
  };
  const conn = () => current() || db;
  const q = (text, params = []) => conn().query(toPg(text), params);
  const all = async (text, params) => (await q(text, params)).rows;
  const one = async (text, params) => (await q(text, params)).rows[0] || null;
  const run = async (text, params) => (await q(text, params)).rowCount;

  async function inTransaction(begin, fn, lock) {
    return db.withClient(async (client) => {
      const scope = { client, done: false };
      await client.query(begin);
      try {
        if (lock) await client.query("SELECT pg_advisory_xact_lock($1)", [WRITE_LOCK]);
        const result = await als.run(scope, fn);
        scope.done = true;
        await client.query("COMMIT");
        return result;
      } catch (err) {
        scope.done = true;
        await client.query("ROLLBACK").catch((rollbackErr) => client.broken(rollbackErr));
        throw err;
      }
    });
  }

  /** Транзакция: при исключении откатывается целиком. Вложенные вызовы входят во внешнюю транзакцию. */
  function tx(fn) {
    if (current()) return fn();
    return inTransaction("BEGIN", fn, true);
  }

  /** Несколько запросов на чтение видят базу в один момент (заказ и его позиции не разъедутся из-за чужой записи). */
  function read(fn) {
    if (current()) return fn();
    return inTransaction("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", fn, false);
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

  /* ---------- запросы ---------- */

  const productById = (id) => one("SELECT * FROM products WHERE id = ?", [id]);
  const orderById = (id) => one("SELECT * FROM orders WHERE id = ?", [id]);
  const clientById = (id) => one("SELECT * FROM clients WHERE id = ?", [id]);
  const itemsByOrder = (orderId) => all("SELECT * FROM order_items WHERE order_id = ? ORDER BY position", [orderId]);
  const orderExists = async (id) => !!(await one("SELECT 1 AS found FROM orders WHERE id = ?", [id]));
  const setItemReserved = (qty, orderId, position) =>
    run("UPDATE order_items SET reserved = ? WHERE order_id = ? AND position = ?", [qty, orderId, position]);
  const setTotalText = (text, id) => run("UPDATE orders SET total_text = ? WHERE id = ?", [text, id]);

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

  async function findClientRowByKey(name, phone) {
    const { phoneKey, nameKey } = keyParts(name, phone);
    if (phoneKey) return one("SELECT * FROM clients WHERE phone_key = ? ORDER BY created_at DESC, row_no DESC LIMIT 1", [phoneKey]);
    if (nameKey) {
      return one("SELECT * FROM clients WHERE phone_key = '' AND name_key = ? ORDER BY created_at DESC, row_no DESC LIMIT 1", [nameKey]);
    }
    return null;
  }

  /* ---------- товары ---------- */

  function insertProductRow(product, sortOrder) {
    return run(
      `INSERT INTO products
        (id, sort_order, title, description, title_kk, description_kk, price, currency, kind, category, image, stock)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        product.id, sortOrder, product.title, product.description, product.title_kk || "", product.description_kk || "",
        product.price, product.currency, product.kind, product.category, product.image, stockValue(product.stock),
      ]
    );
  }

  const products = {
    list: async () => (await all("SELECT * FROM products ORDER BY sort_order, row_no")).map(productFromRow),
    async get(id) {
      const row = await productById(str(id));
      return row ? productFromRow(row) : null;
    },
    /** Новый товар — первым в каталоге. */
    insert(product) {
      return tx(async () => {
        const { v } = await one("SELECT COALESCE(MIN(sort_order), 0)::int AS v FROM products");
        await insertProductRow(product, v - 1);
        return products.get(product.id);
      });
    },
    update(product) {
      return tx(async () => {
        const existing = await products.get(product.id);
        if (!existing) return null;
        // Выключение учёта при живом резерве обнулило бы его при отмене: штуки пропали бы из склада.
        if (product.stock == null && existing.stock != null && (await heldQty(product.id)) > 0) {
          const err = new Error("stock_held");
          err.code = "stock_held";
          throw err;
        }
        const changed = await run(
          `UPDATE products SET
            title = ?, description = ?, title_kk = ?, description_kk = ?, price = ?, currency = ?,
            kind = ?, category = ?, image = ?, stock = ? WHERE id = ?`,
          [
            product.title, product.description, product.title_kk || "", product.description_kk || "", product.price,
            product.currency, product.kind, product.category, product.image, stockValue(product.stock), product.id,
          ]
        );
        return changed ? products.get(product.id) : null;
      });
    },
    /** @returns удалённый товар или null. Открытый резерв удалить нельзя — его некуда вернуть. */
    remove(id) {
      return tx(async () => {
        const existing = await products.get(id);
        if (!existing) return null;
        if ((await heldQty(existing.id)) > 0) {
          const err = new Error("product_reserved");
          err.code = "product_reserved";
          throw err;
        }
        await run("DELETE FROM products WHERE id = ?", [existing.id]);
        return existing;
      });
    },
  };

  /* ---------- заказы ---------- */

  async function insertOrderRow(order) {
    const lead = order.lead && typeof order.lead === "object" ? order.lead : null;
    await run(
      `INSERT INTO orders
        (id, created_at, updated_at, channel, status, customer_name, customer_phone, client_id,
         total_text, message, source_page, note, lead_direction, lead_comment, extra,
         discount, delivery, adjust_currency, vat_rate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
        Math.min(99.99, Math.max(0, num(order.vatRate))),
      ]
    );
    const items = Array.isArray(order.items) ? order.items : [];
    for (let position = 0; position < items.length; position++) {
      const item = items[position] && typeof items[position] === "object" ? items[position] : {};
      await run(
        `INSERT INTO order_items
          (order_id, position, product_id, title, qty, price, currency, line_total, kind, discount)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          str(order.id),
          position,
          str(item.id),
          str(item.title),
          Math.max(1, Math.floor(num(item.qty, 1))),
          num(item.price),
          str(item.currency) || "KZT",
          item.lineTotal != null && Number.isFinite(Number(item.lineTotal)) ? Number(item.lineTotal) : null,
          str(item.kind) || "service",
          Math.max(0, num(item.discount)),
        ]
      );
    }
  }

  function firstItemCurrency(order) {
    const first = Array.isArray(order.items) && order.items[0];
    return (first && str(first.currency)) || "KZT";
  }

  /** Позиции заказов списком строк → Map(order_id → строки), для каждого id из orderIds — хотя бы пустой список. */
  function groupItems(itemRows, orderIds) {
    const byOrder = new Map(orderIds.map((id) => [id, []]));
    for (const row of itemRows) {
      if (!byOrder.has(row.order_id)) byOrder.set(row.order_id, []);
      byOrder.get(row.order_id).push(row);
    }
    return byOrder;
  }

  const orders = {
    list() {
      return read(async () => {
        const rows = await all("SELECT * FROM orders ORDER BY created_at DESC, row_no DESC");
        const itemRows = await all("SELECT * FROM order_items ORDER BY order_id, position");
        const byOrder = groupItems(itemRows, rows.map((row) => row.id));
        return rows.map((row) => orderFromRow(row, byOrder.get(row.id)));
      });
    },
    get(id) {
      return read(async () => {
        const row = await orderById(str(id));
        return row ? orderFromRow(row, await itemsByOrder(row.id)) : null;
      });
    },
    exists: (id) => orderExists(str(id)),
    /**
     * Страница списка: новые сверху, по limit штук. cursor — значение nextCursor предыдущей страницы.
     * kind: "orders" — заказы из корзины, "leads" — заявки с формы (channel = site), иначе все.
     * q, from, to — поиск (см. orderSearchWhere).
     * counts — сколько записей этого вида в каждом статусе (для фильтров) с учётом поиска, без учёта status и cursor.
     */
    async page({ kind, status, cursor, limit = ORDERS_PAGE_DEFAULT, q: query, from, to } = {}) {
      const size = Math.min(ORDERS_PAGE_MAX, Math.max(1, Math.floor(num(limit, ORDERS_PAGE_DEFAULT))));
      const kindWhere = kind === "leads" ? "channel = 'site'" : kind === "orders" ? "channel <> 'site'" : "TRUE";
      const search = orderSearchWhere({ q: query, from, to });
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
        where.push("(created_at, id) < (?::text, ?::text)");
        params.push(after.createdAt, after.id);
      }
      return read(async () => {
        const rows = await all(
          `SELECT * FROM orders WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
          [...params, size + 1]
        );
        const hasMore = rows.length > size;
        if (hasMore) rows.pop();

        const ids = rows.map((row) => row.id);
        const itemRows = ids.length
          ? await all("SELECT * FROM order_items WHERE order_id = ANY(?::text[]) ORDER BY order_id, position", [ids])
          : [];
        const byOrder = groupItems(itemRows, ids);

        const counts = { all: 0, new: 0, in_progress: 0, done: 0, cancelled: 0 };
        const countRows = await all(
          `SELECT status, COUNT(*)::int AS n FROM orders WHERE ${[kindWhere, ...search.where].join(" AND ")} GROUP BY status`,
          search.params
        );
        for (const row of countRows) {
          counts.all += row.n;
          counts[row.status] = (counts[row.status] || 0) + row.n;
        }

        const last = rows[rows.length - 1];
        return {
          items: rows.map((row) => orderFromRow(row, byOrder.get(row.id))),
          nextCursor: hasMore ? encodeCursor(last) : null,
          counts,
        };
      });
    },
    /** Новый заказ со списанием остатков; при нехватке — исключение out_of_stock, ничего не сохраняется. */
    insert(order) {
      return tx(async () => {
        await insertOrderRow(order);
        if (str(order.status) !== CANCELLED) await reserveStock(order.id);
        if (str(order.status) === DONE) await consumeStock(order.id);
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
      return tx(async () => {
        const row = await orderById(str(id));
        if (!row) return null;
        if (fields.status !== undefined && fields.status !== row.status) {
          await applyStockForStatus(row.id, row.status, fields.status);
        }
        for (const { position, discount } of fields.itemDiscounts || []) {
          await run("UPDATE order_items SET discount = ? WHERE order_id = ? AND position = ?", [discount, row.id, position]);
        }
        const updated = await patchOrderRow(row.id, fields);
        return (await syncTotalText(updated)) || updated;
      });
    },
    /**
     * Пересчитать total_text у всех заказов (не заявок) — для записей, сохранённых до учёта скидок и доставки.
     * updated_at не меняется: содержимое заказа то же. Возвращает число исправленных записей.
     */
    async recomputeTotals() {
      if (!orderTotalText) return 0;
      return tx(async () => {
        let fixed = 0;
        for (const order of await orders.list()) {
          if (order.channel === "site") continue;
          const text = orderTotalText(order);
          if (text && text !== order.totalText) {
            await setTotalText(text, order.id);
            fixed++;
          }
        }
        return fixed;
      });
    },
    /** Удаление невыполненного заказа возвращает товар на склад; выполненного — нет (товар уже у покупателя). */
    remove(id) {
      return tx(async () => {
        const row = await orderById(str(id));
        if (!row) return false;
        if (STOCK_HELD.has(row.status)) await releaseStock(row.id);
        await run("DELETE FROM orders WHERE id = ?", [row.id]);
        return true;
      });
    },
  };

  async function heldQty(productId) {
    return (await one("SELECT COALESCE(SUM(reserved), 0)::int AS qty FROM order_items WHERE product_id = ?", [str(productId)])).qty;
  }

  /**
   * Склад при смене статуса.
   * Выдача (done) переводит удержанное в consumed: отмена после выдачи товар не возвращает.
   * Возврат из done в новый или в работу снова удерживает те же штуки, повторно не списывая.
   * Отмена до выдачи возвращает удержанное. Снятие отмены списывает заново, уже выданное — нет.
   */
  async function applyStockForStatus(orderId, prev, next) {
    if (prev === CANCELLED) await reserveStock(orderId);
    if (next === DONE) await consumeStock(orderId);
    else if (prev === DONE && next !== CANCELLED) await reopenStock(orderId);
    else if (next === CANCELLED && prev !== DONE) await releaseStock(orderId);
  }

  /**
   * Списать остатки по позициям, которые ещё не удержаны и не выданы.
   * Позиции без учёта остатка пропускаются.
   * Нехватка хотя бы по одной позиции — исключение со списком { id, title, available }; транзакция откатится.
   */
  async function reserveStock(orderId) {
    const shortages = [];
    for (const item of await itemsByOrder(orderId)) {
      if (item.reserved > 0 || item.consumed > 0) continue;
      const product = await productById(item.product_id);
      if (!product || product.stock == null) continue;
      // Списание только при достаточном остатке: проверка и изменение — один запрос.
      const taken = await run("UPDATE products SET stock = stock - ? WHERE id = ? AND stock IS NOT NULL AND stock >= ?", [
        item.qty, product.id, item.qty,
      ]);
      if (taken) {
        await setItemReserved(item.qty, orderId, item.position);
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
  async function consumeStock(orderId) {
    await run(
      "UPDATE order_items SET consumed = consumed + reserved, reserved = 0 WHERE order_id = ? AND reserved > 0",
      [orderId]
    );
  }

  /** Заказ снова открыт до выдачи: те же штуки опять удержаны, доступный остаток не меняется. */
  async function reopenStock(orderId) {
    await run(
      "UPDATE order_items SET reserved = reserved + consumed, consumed = 0 WHERE order_id = ? AND consumed > 0",
      [orderId]
    );
  }

  /**
   * Вернуть на склад всё удержанное по заказу.
   * Учёт выключен — резерв не сбрасываем: иначе повторное включение учёта потеряет эти штуки.
   * Товара уже нет — возвращать некуда, резерв снимаем.
   */
  async function releaseStock(orderId) {
    for (const item of await itemsByOrder(orderId)) {
      if (item.reserved <= 0) continue;
      const product = await productById(item.product_id);
      if (!product) {
        await setItemReserved(0, orderId, item.position);
        continue;
      }
      if (product.stock == null) continue;
      if (await run("UPDATE products SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL", [item.reserved, product.id])) {
        await setItemReserved(0, orderId, item.position);
      }
    }
  }

  async function patchOrderRow(id, fields) {
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
    const changed = await run("UPDATE orders SET " + sets.join(", ") + " WHERE id = ?", [...values, str(id)]);
    return changed ? orders.get(id) : null;
  }

  /** У заявок (channel = site) в total_text подпись, а не сумма — её не трогаем. */
  async function syncTotalText(order) {
    if (!order || !orderTotalText || order.channel === "site") return null;
    const text = orderTotalText(order);
    if (!text || text === order.totalText) return null;
    await setTotalText(text, order.id);
    return { ...order, totalText: text };
  }

  /* ---------- клиенты ---------- */

  function insertClientRow(client) {
    const { phoneKey, nameKey } = keyParts(client.name, client.phone);
    return run(
      `INSERT INTO clients
        (id, created_at, updated_at, name, phone, phone_key, name_key, note, source, extra, requisites)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
        requisitesJson(client.requisites),
      ]
    );
  }

  function saveClientRow(client) {
    const { phoneKey, nameKey } = keyParts(client.name, client.phone);
    return run(
      "UPDATE clients SET updated_at = ?, name = ?, phone = ?, phone_key = ?, name_key = ?, note = ?, requisites = ? WHERE id = ?",
      [client.updatedAt, client.name, client.phone, phoneKey, nameKey, client.note, requisitesJson(client.requisites), client.id]
    );
  }

  /** Реквизиты уже проверены сервером; пустой набор не храним. */
  function requisitesJson(requisites) {
    if (!requisites || typeof requisites !== "object") return null;
    const filled = Object.entries(requisites).filter(([, value]) => value !== "" && value != null);
    return filled.length ? JSON.stringify(Object.fromEntries(filled)) : null;
  }

  /** Привязать/обновить заказы клиента по clientId или старому ключу контакта. */
  async function syncOrdersForClient(client, previousKey) {
    if (!client || !client.id) return;
    const now = nowIso();
    const currentKey = clientKey(client.name, client.phone);
    const rows = await all(
      `SELECT id, customer_name, customer_phone, client_id FROM orders
        WHERE client_id = ? OR client_id IS NULL OR client_id = ''`,
      [client.id]
    );
    for (const row of rows) {
      const byId = row.client_id === client.id;
      const orderKey = clientKey(row.customer_name, row.customer_phone);
      const byPrevious = !!previousKey && !row.client_id && orderKey === previousKey;
      const byCurrent = !row.client_id && !!orderKey && orderKey === currentKey;
      if (!byId && !byPrevious && !byCurrent) continue;
      await run("UPDATE orders SET client_id = ?, customer_name = ?, customer_phone = ?, updated_at = ? WHERE id = ?", [
        client.id,
        client.name || row.customer_name,
        client.phone || row.customer_phone,
        now,
        row.id,
      ]);
    }
  }

  const clients = {
    list: async () => (await all("SELECT * FROM clients ORDER BY updated_at DESC, created_at DESC, row_no DESC")).map(clientFromRow),
    async get(id) {
      const row = await clientById(str(id));
      return row ? clientFromRow(row) : null;
    },
    key: clientKey,

    /** Существующая карточка по телефону (или имени без телефона); ничего не создаёт. */
    async findByContact(name, phone) {
      const row = await findClientRowByKey(str(name).trim(), str(phone).trim());
      return row ? clientFromRow(row) : null;
    },

    /**
     * Найти клиента (по id, затем по телефону/имени) и обновить, либо создать.
     * Контакт из заказа (source: "order") только дополняет пустые поля существующей карточки.
     */
    upsert(fields) {
      return tx(async () => {
        const name = str(fields.name).trim();
        const phone = str(fields.phone).trim();
        const note = fields.note != null ? str(fields.note).trim() : undefined;
        if (!name && !normalizePhone(phone)) return null;

        let row = fields.id ? await clientById(str(fields.id)) : null;
        if (!row) row = await findClientRowByKey(name, phone);

        if (row) {
          const existing = clientFromRow(row);
          const fromOrder = fields.source === "order";
          if (name && (!fromOrder || !existing.name)) existing.name = name;
          if (phone && (!fromOrder || !existing.phone)) existing.phone = phone;
          if (note !== undefined) existing.note = note;
          if (fields.requisites !== undefined && !fromOrder) existing.requisites = fields.requisites;
          existing.updatedAt = nowIso();
          await saveClientRow(existing);
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
        await insertClientRow(client);
        return clients.get(client.id);
      });
    },

    /** Правка карточки из CRM; заказы клиента получают новое имя/телефон. */
    patch(id, fields) {
      return tx(async () => {
        const row = await clientById(str(id));
        if (!row) return null;
        const client = clientFromRow(row);
        const previousKey = clientKey(client.name, client.phone);
        if (fields.name !== undefined) client.name = fields.name;
        if (fields.phone !== undefined) client.phone = fields.phone;
        if (fields.note !== undefined) client.note = fields.note;
        if (fields.requisites !== undefined) client.requisites = fields.requisites;
        client.updatedAt = nowIso();
        await saveClientRow(client);
        await syncOrdersForClient(client, previousKey);
        return clients.get(client.id);
      });
    },

    syncOrders: (client, previousKey) => tx(() => syncOrdersForClient(client, previousKey)),

    exists: async (id) => !!(await clientById(str(id))),

    /** Убрать у заказов ссылки на карточки, которых больше нет (удалены до того, как удаление стало отвязывать заказы). */
    unlinkMissing: () =>
      tx(() =>
        run(`UPDATE orders SET client_id = NULL
          WHERE client_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = orders.client_id)`)
      ),

    /** Удаление карточки; её заказы остаются, но больше на неё не ссылаются. */
    remove(id) {
      return tx(async () => {
        if (!(await run("DELETE FROM clients WHERE id = ?", [str(id)]))) return false;
        await run("UPDATE orders SET client_id = NULL WHERE client_id = ?", [str(id)]);
        return true;
      });
    },

    /**
     * Проставить недостающие clientId и досоздать карточки для заказов, взятых в работу.
     * Новые и отменённые заказы только привязываются к уже существующей карточке:
     * публичная форма не должна плодить карточки (спам), их создаёт переход заказа в работу.
     */
    backfill() {
      return tx(async () => {
        let changed = false;
        const unlinked = await all(`SELECT o.id, o.status, o.customer_name, o.customer_phone, o.client_id FROM orders o
          LEFT JOIN clients c ON c.id = o.client_id WHERE c.id IS NULL ORDER BY o.row_no`);
        for (const row of unlinked) {
          if (!clientKey(row.customer_name, row.customer_phone)) continue;
          let client = await findClientRowByKey(row.customer_name, row.customer_phone);
          if (!client && (row.status === "new" || row.status === "cancelled")) continue;
          if (!client) {
            client = await clients.upsert({ name: row.customer_name, phone: row.customer_phone, source: "order" });
            changed = true;
          }
          if (client && row.client_id !== client.id) {
            await run("UPDATE orders SET client_id = ? WHERE id = ?", [client.id, row.id]);
            changed = true;
          }
        }
        return changed;
      });
    },
  };

  /* ---------- настройки ---------- */

  const settings = {
    /** @returns {Promise<object | null>} значение, сохранённое как JSON */
    async get(key) {
      const row = await one("SELECT value FROM settings WHERE key = ?", [str(key)]);
      if (!row) return null;
      try {
        return JSON.parse(row.value);
      } catch {
        return null;
      }
    },
    async set(key, value) {
      await run(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [str(key), JSON.stringify(value), nowIso()]
      );
      return settings.get(key);
    },
  };

  /* ---------- учётные документы ---------- */

  const documents = {
    async get(id, withSnapshot = true) {
      const row = await one("SELECT * FROM documents WHERE id = ?", [str(id)]);
      return row ? documentFromRow(row, withSnapshot) : null;
    },
    listByOrder: async (orderId) =>
      (await all("SELECT * FROM documents WHERE order_id = ? ORDER BY created_at DESC, seq DESC", [str(orderId)])).map((row) =>
        documentFromRow(row)
      ),
    /** Действующий документ этого вида по заказу и валюте или null. */
    async active(orderId, kind, currency) {
      const row = await one(
        "SELECT * FROM documents WHERE order_id = ? AND kind = ? AND currency = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
        [str(orderId), str(kind), str(currency)]
      );
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
      return tx(async () => {
        const { last: seq } = await one(
          `INSERT INTO doc_counters (kind, year, last) VALUES (?, ?, 1)
            ON CONFLICT (kind, year) DO UPDATE SET last = doc_counters.last + 1 RETURNING last`,
          [input.kind, input.year]
        );
        const number = input.formatNumber(seq);
        const { snapshot, total, sourceHash } = await input.build(number);
        const id = "doc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
        const now = nowIso();
        await run(
          `INSERT INTO documents
            (id, kind, year, seq, number, order_id, currency, status, created_at, total, source_hash, snapshot)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
          [id, input.kind, input.year, seq, number, str(input.orderId), str(input.currency), now, total, sourceHash, JSON.stringify(snapshot)]
        );
        if (input.replaces) {
          await run("UPDATE documents SET status = 'annulled', annulled_at = ?, replaced_by = ? WHERE id = ? AND status = 'active'", [
            now, id, str(input.replaces),
          ]);
        }
        return documents.get(id);
      });
    },
    async logSend({ documentId, channel, recipient, ok, error }) {
      await run("INSERT INTO document_sends (document_id, channel, recipient, sent_at, ok, error) VALUES (?, ?, ?, ?, ?, ?)", [
        str(documentId), str(channel), str(recipient), nowIso(), !!ok, error ? str(error) : null,
      ]);
    },
    sends: async (documentId) =>
      (await all("SELECT * FROM document_sends WHERE document_id = ? ORDER BY sent_at DESC, id DESC", [str(documentId)])).map((row) => ({
        channel: row.channel,
        recipient: row.recipient,
        sentAt: row.sent_at,
        ok: !!row.ok,
        error: row.error,
      })),
  };

  /* ---------- перенос из JSON ---------- */

  function readLegacyJson(fileName, listKeys) {
    const filePath = path.join(dataDir, fileName);
    if (!fs.existsSync(filePath)) return null;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    } catch (err) {
      throw new Error(`Не удалось перенести ${filePath} в базу: файл повреждён (${err.message}). Исправьте его и запустите снова.`);
    }
    const out = {};
    for (const key of listKeys) {
      const value = data && data[key];
      if (value != null && !Array.isArray(value)) {
        throw new Error(`Не удалось перенести ${filePath} в базу: поле «${key}» должно быть списком.`);
      }
      out[key] = value || [];
    }
    return out;
  }

  /**
   * Записи без id или с id, который уже есть в базе, пропускаются — повторный импорт ничего не дублирует.
   * mergeByContact: клиент с тем же телефоном (или именем без телефона), что и в базе, не заводится повторно,
   * его заказы привязываются к существующей карточке.
   */
  async function importOrdersAndClients(legacyOrders, stats, mergeByContact = false) {
    const now = nowIso();
    const clientIdMap = new Map();
    for (const raw of legacyOrders.clients) {
      const client = raw && typeof raw === "object" ? raw : {};
      const id = str(client.id).trim();
      if (!id || (await clientById(id))) {
        stats.skipped += 1;
        continue;
      }
      const same = mergeByContact ? await findClientRowByKey(client.name, client.phone) : null;
      if (same) {
        clientIdMap.set(id, same.id);
        continue;
      }
      await insertClientRow({ ...client, id, createdAt: client.createdAt || now, updatedAt: client.updatedAt || client.createdAt || now });
      stats.clients += 1;
    }
    for (const raw of legacyOrders.orders) {
      const order = raw && typeof raw === "object" ? raw : {};
      const id = str(order.id).trim();
      if (!id || (await orderExists(id))) {
        stats.skipped += 1;
        continue;
      }
      const createdAt = order.createdAt || order.updatedAt || now;
      const clientId = clientIdMap.get(str(order.clientId)) || order.clientId;
      await insertOrderRow({ ...order, id, clientId, createdAt, updatedAt: order.updatedAt || createdAt });
      stats.orders += 1;
      importedOrders += 1;
    }
  }

  /** Новая база: стартовый каталог или данные из старых JSON-файлов (если нет базы SQLite). */
  async function seedFromJson(stats) {
    const legacyOrders = readLegacyJson("orders.json", ["orders", "clients"]);
    const legacyProducts = readLegacyJson("products.json", ["products"]);
    const productList = legacyProducts ? legacyProducts.products : defaultProducts;
    const seenProducts = new Set();
    for (let index = 0; index < productList.length; index++) {
      const raw = productList[index];
      const source = raw && typeof raw === "object" ? raw : {};
      const product = normalizeProduct({ ...source, id: str(source.id).trim() || "p_import_" + index });
      if (!product.title || seenProducts.has(product.id)) {
        stats.skipped += 1;
        continue;
      }
      seenProducts.add(product.id);
      await insertProductRow(product, index);
      stats.products += 1;
    }
    if (legacyOrders) await importOrdersAndClients(legacyOrders, stats);
    return !!(legacyOrders || legacyProducts);
  }

  /**
   * JSON-файлы рядом с уже перенесённой базой появляются, если после переноса успел поработать старый сервер.
   * Новые заказы и клиенты из них дозагружаем, каталог — нет (старый сервер пересоздаёт его из стартового).
   */
  async function importLateJson() {
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
    if (legacyOrders) await tx(() => importOrdersAndClients(legacyOrders, stats, true));
    const target = moveLegacyFiles();
    log.warn(
      `⚠ Найдены JSON-файлы, созданные после перехода на базу данных (похоже, работал старый сервер). ` +
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

  /* ---------- схема и первый запуск ---------- */

  const sqliteFile = path.join(dataDir, SQLITE_FILE);

  async function migrate() {
    const found = await schemaVersionOf(db);
    if (found > SCHEMA_VERSION) {
      throw new Error(`База ${db.display} создана более новой версией сайта (схема ${found}). Обновите сайт.`);
    }
    if (found > 0 && found < SCHEMA_VERSION) await upgrade(found);

    const stats = { products: 0, clients: 0, orders: 0, skipped: 0 };
    const created = await tx(async () => {
      // Повторная проверка под блокировкой: два одновременно запущенных сервера не создадут схему дважды.
      if ((await schemaVersionOf(conn())) > 0) return null;
      await conn().exec(SCHEMA);
      await q("INSERT INTO schema_meta (id, version, created_at) VALUES (1, ?, ?)", [SCHEMA_VERSION, nowIso()]);
      if (fs.existsSync(sqliteFile)) {
        return { from: "sqlite", result: await importSqliteFile(conn(), sqliteFile) };
      }
      return { from: "json", imported: await seedFromJson(stats) };
    });

    if (created && created.from === "sqlite") {
      const { counts, sqliteVersion, skipped } = created.result;
      log.log(
        `Перенос из SQLite (схема ${sqliteVersion}) в ${db.display}: товаров ${counts.products}, клиентов ${counts.clients}, ` +
          `заказов ${counts.orders}, документов ${counts.documents}` +
          (skipped ? `, пропущено позиций без заказа: ${skipped}` : "")
      );
      log.log(`Файл SQLite больше не используется и перемещён в ${moveSqliteFiles(dataDir, log)}`);
      return;
    }
    if (created && created.imported) {
      log.log(
        `Перенос из JSON: товаров ${stats.products}, клиентов ${stats.clients}, заказов ${stats.orders}` +
          (stats.skipped ? `, пропущено записей без id или с повтором id: ${stats.skipped}` : "")
      );
      moveLegacyFiles();
      return;
    }
    if (created) return;

    if (fs.existsSync(sqliteFile)) {
      const target = moveSqliteFiles(dataDir, log);
      log.warn(
        `⚠ Рядом с рабочей базой ${db.display} найден файл SQLite ${sqliteFile}. В PostgreSQL уже есть данные, ` +
          `поэтому он не переносился и отложен в ${target}. Если в нём заказы, которых нет в CRM, перенесите их вручную.`
      );
    }
    await importLateJson();
  }

  /** Обновить схему до текущей версии; перед этим — отдельная копия базы, которую ротация копий не удаляет. */
  async function upgrade(fromVersion) {
    const copy = path.join(backupDir, `bazis-before-v${SCHEMA_VERSION}-${nowIso().replace(/[:.]/g, "-")}.json.gz`);
    await writeDumpFile(copy, await dumpDatabase(db));
    await tx(async () => {
      const current = await schemaVersionOf(conn());
      for (let next = current + 1; next <= SCHEMA_VERSION; next++) {
        await conn().exec(UPGRADES[next]);
        await q("UPDATE schema_meta SET version = ? WHERE id = 1", [next]);
      }
    });
    log.log(`База: схема обновлена с версии ${fromVersion} до ${SCHEMA_VERSION}, копия до обновления: ${copy}`);
  }

  /* ---------- резервные копии ---------- */

  let backupRunning = null;

  /**
   * Одна копия в день (по местной дате): создаётся при запуске, а если сервер работает непрерывно — проверкой раз в 6 часов.
   * Снимок согласованный даже во время работы (db/dump.js); хранятся последние 14 копий.
   */
  function backup() {
    if (!backupRunning) {
      backupRunning = runBackup().finally(() => {
        backupRunning = null;
      });
    }
    return backupRunning;
  }

  async function runBackup() {
    try {
      const d = new Date();
      const day = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
      const target = path.join(backupDir, "bazis-" + day + ".json.gz");
      if (!fs.existsSync(target)) await writeDumpFile(target, await dumpDatabase(db));
      const files = fs.readdirSync(backupDir).filter((name) => BACKUP_FILE_RE.test(name)).sort();
      for (const name of files.slice(0, Math.max(0, files.length - BACKUP_KEEP_DAYS))) {
        fs.unlinkSync(path.join(backupDir, name));
      }
    } catch (err) {
      log.error("Не удалось сделать резервную копию базы:", err.message);
      if (typeof onBackupError === "function") onBackupError(err);
    }
  }

  try {
    await migrate();
  } catch (err) {
    if (ownsDb) await db.close().catch(() => {});
    throw err;
  }

  let backupTimer = null;
  if (options.backups !== false) {
    await backup();
    backupTimer = setInterval(() => backup(), BACKUP_INTERVAL_MS);
    backupTimer.unref();
  }

  let closed = false;
  return {
    /** Где база — для журнала (без пароля). */
    location: db.display,
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
    /** База отвечает (для GET /api/health): без обращения к таблицам. */
    ping: async () => (await db.query("SELECT 1 AS ok")).rows[0].ok === 1,
    async close() {
      if (closed) return;
      closed = true;
      if (backupTimer) clearInterval(backupTimer);
      if (backupRunning) await backupRunning;
      if (ownsDb) await db.close();
    },
  };
}

module.exports = { createStore, foldSearch };
