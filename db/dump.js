/**
 * Копия базы в один файл (JSON, сжатый gzip) и восстановление из неё. Без pg_dump: работает одинаково
 * с PostgreSQL в Docker, на Windows и с PGlite, а файл можно открыть и проверить обычными средствами.
 *
 * Снимок делается в транзакции REPEATABLE READ — согласованная копия даже во время работы сайта.
 * Восстановление заменяет все данные целиком в одной транзакции: либо копия загружена полностью, либо база не тронута.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { promisify } = require("util");
const { SCHEMA, SCHEMA_VERSION, WRITE_LOCK, DATA_TABLES, COLUMNS, ORDER_BY } = require("./schema");

const FORMAT = "bazis-pg-dump";
const FORMAT_VERSION = 1;
/** Параметров в одном INSERT не больше лимита протокола (65535) — с запасом. */
const MAX_PARAMS = 30000;

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

async function schemaVersionOf(client) {
  const { rows } = await client.query("SELECT to_regclass('schema_meta') IS NOT NULL AS ok");
  if (!rows[0].ok) return 0;
  const meta = await client.query("SELECT version FROM schema_meta WHERE id = 1");
  return meta.rows.length ? meta.rows[0].version : 0;
}

async function countRows(client) {
  const counts = {};
  for (const table of DATA_TABLES) {
    counts[table] = (await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;
  }
  return counts;
}

/** Число записей в таблицах (для проверок копий и переноса); база без схемы — null. */
async function tableCounts(db) {
  return db.withClient(async (client) => ((await schemaVersionOf(client)) ? countRows(client) : null));
}

/** Согласованный снимок всех таблиц. */
async function dumpDatabase(db) {
  return db.withClient(async (client) => {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const schemaVersion = await schemaVersionOf(client);
      if (!schemaVersion) throw new Error("в базе нет таблиц сайта — копировать нечего");
      const tables = {};
      const counts = {};
      for (const table of DATA_TABLES) {
        const columns = COLUMNS[table];
        const { rows } = await client.query(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${ORDER_BY[table]}`);
        tables[table] = { columns, rows: rows.map((row) => columns.map((column) => row[column])) };
        counts[table] = rows.length;
      }
      await client.query("COMMIT");
      return { format: FORMAT, formatVersion: FORMAT_VERSION, schemaVersion, createdAt: new Date().toISOString(), counts, tables };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => client.broken(err));
      throw err;
    }
  });
}

function validateDump(dump) {
  if (!dump || dump.format !== FORMAT) throw new Error("это не копия базы сайта (нет отметки формата)");
  if (dump.formatVersion !== FORMAT_VERSION) throw new Error(`неизвестная версия формата копии: ${dump.formatVersion}`);
  if (!Number.isInteger(dump.schemaVersion) || dump.schemaVersion < 1) throw new Error("в копии не указана версия схемы");
  if (dump.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`копия сделана более новой версией сайта (схема ${dump.schemaVersion}, у этой — ${SCHEMA_VERSION}); обновите сайт`);
  }
  for (const table of DATA_TABLES) {
    const data = dump.tables && dump.tables[table];
    if (!data || !Array.isArray(data.columns) || !Array.isArray(data.rows)) throw new Error(`в копии нет таблицы ${table}`);
    const unknown = data.columns.filter((column) => !COLUMNS[table].includes(column));
    if (unknown.length) throw new Error(`в копии у таблицы ${table} неизвестные столбцы: ${unknown.join(", ")}`);
    if (dump.counts && dump.counts[table] !== data.rows.length) {
      throw new Error(`копия повреждена: в таблице ${table} ${data.rows.length} записей вместо ${dump.counts[table]}`);
    }
  }
}

async function insertRows(client, table, columns, rows) {
  if (!rows.length) return;
  const perInsert = Math.max(1, Math.floor(MAX_PARAMS / columns.length));
  for (let start = 0; start < rows.length; start += perInsert) {
    const chunk = rows.slice(start, start + perInsert);
    const params = [];
    const values = chunk.map((row) => {
      if (!Array.isArray(row) || row.length !== columns.length) throw new Error(`копия повреждена: неверная запись в таблице ${table}`);
      const marks = row.map((value) => {
        params.push(value);
        return "$" + params.length;
      });
      return "(" + marks.join(", ") + ")";
    });
    await client.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values.join(", ")}`, params);
  }
}

/**
 * Заменить все данные содержимым копии. Пустая база получает схему; база другой версии схемы — ошибка.
 * @returns {Promise<Record<string, number>>} число записей по таблицам после восстановления
 */
async function restoreDatabase(db, dump) {
  validateDump(dump);
  return db.withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock($1)", [WRITE_LOCK]);
      const current = await schemaVersionOf(client);
      if (!current) {
        await client.exec(SCHEMA);
        await client.query("INSERT INTO schema_meta (id, version, created_at) VALUES (1, $1, $2)", [SCHEMA_VERSION, new Date().toISOString()]);
      } else if (current !== SCHEMA_VERSION) {
        throw new Error(`схема базы (${current}) не совпадает с версией сайта (${SCHEMA_VERSION}) — сначала запустите сайт, чтобы он обновил базу`);
      }
      await client.query(`TRUNCATE ${DATA_TABLES.join(", ")} RESTART IDENTITY`);
      for (const table of DATA_TABLES) {
        const data = dump.tables[table];
        await insertRows(client, table, data.columns, data.rows);
      }
      const counts = await countRows(client);
      for (const table of DATA_TABLES) {
        if (counts[table] !== dump.tables[table].rows.length) {
          throw new Error(`после загрузки в таблице ${table} ${counts[table]} записей вместо ${dump.tables[table].rows.length}`);
        }
      }
      await client.query("COMMIT");
      return counts;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => client.broken(err));
      throw err;
    }
  });
}

/** Записать копию: сначала во временный файл, затем переименовать — недописанный файл не выглядит готовой копией. */
async function writeDumpFile(file, dump) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await fs.promises.writeFile(tmp, await gzip(Buffer.from(JSON.stringify(dump), "utf8")));
  await fs.promises.rename(tmp, file);
}

async function readDumpFile(file) {
  let raw = await fs.promises.readFile(file);
  if (raw[0] === 0x1f && raw[1] === 0x8b) raw = await gunzip(raw);
  let dump;
  try {
    dump = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
  } catch (err) {
    throw new Error(`файл ${file} повреждён: ${err.message}`);
  }
  validateDump(dump);
  return dump;
}

module.exports = {
  dumpDatabase,
  restoreDatabase,
  tableCounts,
  writeDumpFile,
  readDumpFile,
  validateDump,
  schemaVersionOf,
  insertRows,
  FORMAT,
};
