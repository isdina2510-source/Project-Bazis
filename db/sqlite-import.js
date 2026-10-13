/**
 * Перенос данных из прежней базы SQLite (data/bazis.db) в PostgreSQL.
 * Выполняется один раз — при первом запуске на пустой базе PostgreSQL, внутри транзакции, создающей схему:
 * если что-то не перенеслось, PostgreSQL остаётся пустым, а файл SQLite — на месте.
 *
 * Понимает все прежние версии схемы SQLite (1–4): недостающие столбцы получают значения по умолчанию,
 * а обновление версии 4 (выданный товар отделён от удержанного) применяется при переносе.
 */
const fs = require("fs");
const path = require("path");
const { insertRows } = require("./dump");

const SQLITE_FILE = "bazis.db";
const SQLITE_COMPANIONS = ["-wal", "-shm", "-journal"];
const LATEST_SQLITE_SCHEMA = 4;

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
    throw new Error("Для переноса старой базы SQLite нужен Node.js 22.13 или новее (модуль node:sqlite): " + err.message);
  } finally {
    process.emitWarning = emitWarning;
  }
}

const CURRENCIES = new Set(["KZT", "RUB", "USD"]);
const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const nonNegative = (value) => Math.max(0, num(value));
const text = (value, fallback = "") => (value == null ? fallback : String(value));
const nullableText = (value) => (value == null ? null : String(value));

/** Открыть файл SQLite и проверить, что он цел. */
function openSqlite(file) {
  const { DatabaseSync } = loadSqlite();
  let db;
  try {
    db = new DatabaseSync(file);
    const check = db.prepare("PRAGMA quick_check").all();
    if (!(check.length === 1 && check[0].quick_check === "ok")) throw new Error(check.map((row) => row.quick_check).join("; "));
    return db;
  } catch (err) {
    if (db) db.close();
    throw new Error(
      `Старая база ${file} повреждена или не является SQLite (${err.message}) — перенос в PostgreSQL невозможен. ` +
        `Замените файл последней копией из data/backups (bazis-ГГГГ-ММ-ДД.db) и запустите снова.`
    );
  }
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function readTable(db, table, orderBy) {
  const columns = tableColumns(db, table);
  if (!columns.size) return { columns, rows: [] };
  return { columns, rows: db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all() };
}

/**
 * Перенести всё из файла SQLite через соединение client (транзакция уже открыта, схема PostgreSQL создана).
 * @returns {Promise<{ sqliteVersion: number, counts: Record<string, number>, skipped: number }>}
 */
async function importSqliteFile(client, file) {
  const db = openSqlite(file);
  try {
    const sqliteVersion = db.prepare("PRAGMA user_version").get().user_version;
    if (sqliteVersion > LATEST_SQLITE_SCHEMA) {
      throw new Error(`Старая база ${file} создана более новой версией сайта (схема SQLite ${sqliteVersion}).`);
    }
    if (sqliteVersion < 1) throw new Error(`Файл ${file} не похож на базу сайта (нет версии схемы).`);
    const counts = {};
    let skipped = 0;

    const products = readTable(db, "products", "rowid");
    const productRows = products.rows.map((row) => [
      text(row.id),
      Math.trunc(num(row.sort_order)),
      text(row.title),
      text(row.description),
      text(row.title_kk),
      text(row.description_kk),
      nonNegative(row.price),
      CURRENCIES.has(row.currency) ? row.currency : "KZT",
      row.kind === "product" ? "product" : "service",
      text(row.category, "management"),
      text(row.image),
      // В схеме 1 вместо остатка было «количество в заказе по умолчанию» — учёт остатков тогда не вёлся.
      products.columns.has("stock") && row.stock != null && num(row.stock, -1) >= 0 ? Math.trunc(num(row.stock)) : null,
    ]);
    await insertRows(client, "products", [
      "id", "sort_order", "title", "description", "title_kk", "description_kk", "price", "currency", "kind", "category", "image", "stock",
    ], productRows);
    counts.products = productRows.length;

    const clients = readTable(db, "clients", "rowid");
    const clientRows = clients.rows.map((row) => [
      text(row.id),
      text(row.created_at),
      text(row.updated_at, text(row.created_at)),
      text(row.name),
      text(row.phone),
      text(row.phone_key),
      text(row.name_key),
      text(row.note),
      text(row.source, "manual"),
      nullableText(row.extra),
      clients.columns.has("requisites") ? nullableText(row.requisites) : null,
    ]);
    await insertRows(client, "clients", [
      "id", "created_at", "updated_at", "name", "phone", "phone_key", "name_key", "note", "source", "extra", "requisites",
    ], clientRows);
    counts.clients = clientRows.length;

    const orders = readTable(db, "orders", "rowid");
    const orderStatus = new Map();
    const orderRows = orders.rows.map((row) => {
      orderStatus.set(text(row.id), text(row.status, "new"));
      return [
        text(row.id),
        text(row.created_at),
        text(row.updated_at, text(row.created_at)),
        text(row.channel, "whatsapp"),
        text(row.status, "new"),
        text(row.customer_name),
        text(row.customer_phone),
        nullableText(row.client_id),
        text(row.total_text),
        text(row.message),
        text(row.source_page),
        nullableText(row.note),
        nullableText(row.lead_direction),
        nullableText(row.lead_comment),
        nullableText(row.extra),
        nonNegative(row.discount),
        nonNegative(row.delivery),
        text(row.adjust_currency, "KZT") || "KZT",
        Math.min(99.99, nonNegative(row.vat_rate)),
      ];
    });
    await insertRows(client, "orders", [
      "id", "created_at", "updated_at", "channel", "status", "customer_name", "customer_phone", "client_id", "total_text", "message",
      "source_page", "note", "lead_direction", "lead_comment", "extra", "discount", "delivery", "adjust_currency", "vat_rate",
    ], orderRows);
    counts.orders = orderRows.length;

    const items = readTable(db, "order_items", "order_id, position");
    const itemRows = [];
    for (const row of items.rows) {
      const status = orderStatus.get(text(row.order_id));
      if (status === undefined) {
        skipped += 1;
        continue;
      }
      let reserved = Math.max(0, Math.trunc(num(row.reserved)));
      let consumed = Math.max(0, Math.trunc(num(row.consumed)));
      // Обновление схемы 4: у выполненных заказов удержанное уже выдано покупателю.
      if (sqliteVersion < 4 && status === "done" && reserved > 0) {
        consumed = reserved;
        reserved = 0;
      }
      itemRows.push([
        text(row.order_id),
        Math.trunc(num(row.position)),
        text(row.product_id),
        text(row.title),
        Math.max(1, Math.trunc(num(row.qty, 1))),
        num(row.price),
        text(row.currency, "KZT"),
        row.line_total == null ? null : num(row.line_total),
        text(row.kind, "service"),
        reserved,
        consumed,
        nonNegative(row.discount),
      ]);
    }
    await insertRows(client, "order_items", [
      "order_id", "position", "product_id", "title", "qty", "price", "currency", "line_total", "kind", "reserved", "consumed", "discount",
    ], itemRows);
    counts.order_items = itemRows.length;

    const settings = readTable(db, "settings", "key");
    const settingRows = settings.rows.map((row) => [text(row.key), text(row.value), text(row.updated_at)]);
    await insertRows(client, "settings", ["key", "value", "updated_at"], settingRows);
    counts.settings = settingRows.length;

    const counters = readTable(db, "doc_counters", "kind, year");
    const counterRows = counters.rows.map((row) => [text(row.kind), Math.trunc(num(row.year)), Math.trunc(num(row.last))]);
    await insertRows(client, "doc_counters", ["kind", "year", "last"], counterRows);
    counts.doc_counters = counterRows.length;

    const documents = readTable(db, "documents", "rowid");
    const documentRows = documents.rows.map((row) => [
      text(row.id),
      text(row.kind),
      Math.trunc(num(row.year)),
      Math.trunc(num(row.seq)),
      text(row.number),
      text(row.order_id),
      text(row.currency),
      text(row.status, "active"),
      text(row.created_at),
      nullableText(row.annulled_at),
      nullableText(row.replaced_by),
      num(row.total),
      text(row.source_hash),
      text(row.snapshot),
    ]);
    await insertRows(client, "documents", [
      "id", "kind", "year", "seq", "number", "order_id", "currency", "status", "created_at", "annulled_at", "replaced_by", "total",
      "source_hash", "snapshot",
    ], documentRows);
    counts.documents = documentRows.length;

    const sends = readTable(db, "document_sends", "id");
    const sendRows = sends.rows.map((row) => [
      text(row.document_id),
      text(row.channel),
      text(row.recipient),
      text(row.sent_at),
      !!num(row.ok),
      nullableText(row.error),
    ]);
    await insertRows(client, "document_sends", ["document_id", "channel", "recipient", "sent_at", "ok", "error"], sendRows);
    counts.document_sends = sendRows.length;

    // Сверка: в PostgreSQL ровно столько записей, сколько прочитано из SQLite.
    for (const [table, expected] of Object.entries(counts)) {
      const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
      if (rows[0].n !== expected) throw new Error(`Перенос из SQLite: в таблице ${table} ${rows[0].n} записей вместо ${expected}`);
    }
    return { sqliteVersion, counts, skipped };
  } finally {
    db.close();
  }
}

/** Файл SQLite и его служебные файлы (журнал WAL) — в data/legacy-sqlite/<время>/; ничего не удаляется. */
function moveSqliteFiles(dataDir, log) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(dataDir, "legacy-sqlite", stamp);
  fs.mkdirSync(target, { recursive: true });
  for (const name of [SQLITE_FILE, ...SQLITE_COMPANIONS.map((suffix) => SQLITE_FILE + suffix)]) {
    const from = path.join(dataDir, name);
    if (!fs.existsSync(from)) continue;
    try {
      fs.renameSync(from, path.join(target, name));
    } catch (err) {
      log.warn(`Не удалось переместить ${from} в ${target}: ${err.message}. Файл больше не используется — удалите или перенесите его вручную.`);
    }
  }
  return target;
}

module.exports = { importSqliteFile, moveSqliteFiles, SQLITE_FILE };
