/**
 * Снимок рабочих данных для копии вне Docker (scripts/offsite-backup.ps1). Выполняется во временном контейнере
 * сайта (docker compose run): база — по DATABASE_URL, файлы — в томах /app/data и /app/images/uploads; сайт может работать.
 *
 *   node --no-warnings backup-snapshot.js snapshot <папка>        — копия базы, выпущенные документы, печать и подпись,
 *                                                                  загруженные картинки, manifest.json;
 *   node --no-warnings backup-snapshot.js verify <папка>          — проверить копию: контрольные суммы и содержимое копии базы;
 *   node --no-warnings backup-snapshot.js restore-db <папка>      — заменить данные в PostgreSQL копией (одна транзакция);
 *   node --no-warnings backup-snapshot.js verify-restored <папка> — файлы на местах и число записей в базе как в копии.
 *
 * База в копии — database.json.gz (db/dump.js). Пока данные ещё не перенесены из SQLite (сайт старой версии или первый
 * запуск новой не состоялся), копируется файл data/bazis.db — так же, как в копиях до перехода на PostgreSQL (формат 1).
 * Такие копии восстанавливаются переносом в PostgreSQL (db/sqlite-import.js).
 *
 * manifest.json — список файлов с размером и SHA-256 и число записей в таблицах: по нему копия проверяется
 * после переноса в Windows и перед восстановлением. Код выхода 1 — снимок не сделан или копия не прошла проверку.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/** В контейнере скрипт лежит отдельно от кода сайта (/scripts), модули базы — в /app. */
const APP_DIR = fs.existsSync("/app/server.js") ? "/app" : path.join(__dirname, "..");
/** В образе версии до PostgreSQL модулей базы нет — тогда копируется только файл SQLite. */
const HAS_PG = fs.existsSync(path.join(APP_DIR, "db", "connection.js"));
const appModule = (name) => require(path.join(APP_DIR, "db", name));

const DATA_DIR = process.env.BAZIS_DATA_DIR || "/app/data";
const UPLOADS_DIR = process.env.BAZIS_UPLOADS_DIR || "/app/images/uploads";
/** Файлы из data, которые нужны вместе с базой: PDF выпущенных документов и печать с подписью. */
const DATA_FOLDERS = ["documents", "company"];
const DUMP_FILE = "database.json.gz";
const SQLITE_REL = "data/bazis.db";
const SQLITE_TABLES = ["orders", "order_items", "clients", "products", "documents"];
const FORMAT = 2;

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Все файлы папки — пути относительно root через «/». */
function listFiles(root, dir = root) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(root, full));
    else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return out.sort();
}

const sameCounts = (actual, expected) => Object.keys(expected).every((table) => actual[table] === expected[table]);

async function withDatabase(fn) {
  const { openDatabase } = appModule("connection");
  const db = await openDatabase(process.env.DATABASE_URL, { waitMs: 60000, log: { warn() {}, log() {}, error() {} } });
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

/* ---------- SQLite (данные до переноса в PostgreSQL) ---------- */

function sqliteModule() {
  const emitWarning = process.emitWarning;
  process.emitWarning = () => {};
  try {
    return require("node:sqlite");
  } finally {
    process.emitWarning = emitWarning;
  }
}

function checkSqlite(file) {
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check).join("; ");
    if (integrity !== "ok") throw new Error(`База SQLite в копии повреждена: ${integrity}`);
    const counts = {};
    for (const table of SQLITE_TABLES) {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      counts[table] = exists ? db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n : 0;
    }
    return counts;
  } finally {
    db.close();
  }
}

/** Согласованная копия работающей базы SQLite (VACUUM INTO не мешает записи). */
function copySqlite(target) {
  const { DatabaseSync } = sqliteModule();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(path.join(DATA_DIR, "bazis.db"));
  try {
    db.exec("PRAGMA busy_timeout = 30000");
    db.prepare("VACUUM INTO ?").run(target);
  } finally {
    db.close();
  }
  return checkSqlite(target);
}

/* ---------- режимы ---------- */

/** Какая база сейчас рабочая: PostgreSQL со схемой сайта или ещё не перенесённый файл SQLite. */
async function liveDatabase() {
  const legacy = fs.existsSync(path.join(DATA_DIR, "bazis.db"));
  if (!HAS_PG) {
    if (!legacy) throw new Error(`Нет базы ${path.join(DATA_DIR, "bazis.db")}`);
    return "sqlite";
  }
  const { tableCounts } = appModule("dump");
  const counts = await withDatabase((db) => tableCounts(db));
  if (counts) return "postgres";
  if (legacy) return "sqlite";
  throw new Error("В PostgreSQL нет таблиц сайта и нет файла SQLite — копировать нечего (сайт ещё не запускался?)");
}

async function snapshot(out) {
  // Папку очищаем, а не пересоздаём: в контейнере это точка подключения папки Windows, её саму удалить нельзя.
  fs.mkdirSync(out, { recursive: true });
  for (const name of fs.readdirSync(out)) fs.rmSync(path.join(out, name), { recursive: true, force: true });

  const database = await liveDatabase();
  let counts;
  let schemaVersion = null;
  if (database === "postgres") {
    const { dumpDatabase, writeDumpFile, readDumpFile } = appModule("dump");
    const dump = await withDatabase((db) => dumpDatabase(db));
    await writeDumpFile(path.join(out, DUMP_FILE), dump);
    // Копия читается обратно до того, как снимок засчитан: недописанный или испорченный файл здесь и всплывёт.
    if (!sameCounts((await readDumpFile(path.join(out, DUMP_FILE))).counts, dump.counts)) {
      throw new Error("Копия базы не совпала с базой после записи");
    }
    counts = dump.counts;
    schemaVersion = dump.schemaVersion;
  } else {
    counts = copySqlite(path.join(out, SQLITE_REL));
  }

  for (const folder of DATA_FOLDERS) {
    const source = path.join(DATA_DIR, folder);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(out, "data", folder), { recursive: true });
  }
  fs.mkdirSync(path.join(out, "uploads"), { recursive: true });
  if (fs.existsSync(UPLOADS_DIR)) fs.cpSync(UPLOADS_DIR, path.join(out, "uploads"), { recursive: true });

  const files = listFiles(out).map((rel) => {
    const full = path.join(out, rel);
    return { path: rel, size: fs.statSync(full).size, sha256: sha256(full) };
  });
  const manifest = { format: FORMAT, createdAt: new Date().toISOString(), database, schemaVersion, counts, files };
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

function readManifest(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8").replace(/^\uFEFF/, ""));
  if (manifest.format === 1) return { ...manifest, database: "sqlite" };
  if (manifest.format !== FORMAT) throw new Error(`Неизвестный формат копии: ${manifest.format}`);
  return manifest;
}

/** Сверить копию в dir с её manifest.json: файлы и содержимое копии базы. */
async function verify(dir) {
  const manifest = readManifest(dir);
  for (const file of manifest.files) {
    const full = path.join(dir, file.path);
    if (!fs.existsSync(full)) throw new Error(`Нет файла ${file.path}`);
    if (sha256(full) !== file.sha256) throw new Error(`Файл ${file.path} отличается от исходного (повреждён)`);
  }
  if (manifest.database === "sqlite") {
    const counts = checkSqlite(path.join(dir, SQLITE_REL));
    if (!sameCounts(counts, manifest.counts)) throw new Error(`Число записей в копии не совпало с manifest.json: ${JSON.stringify(counts)}`);
    return manifest;
  }
  const dump = await appModule("dump").readDumpFile(path.join(dir, DUMP_FILE));
  if (!sameCounts(dump.counts, manifest.counts)) {
    throw new Error(`Число записей в копии базы не совпало с manifest.json: ${JSON.stringify(dump.counts)}`);
  }
  return manifest;
}

/** Копия времён SQLite → PostgreSQL: все данные заменяются перенесёнными из файла, в одной транзакции. */
async function restoreFromSqlite(db, file) {
  const { SCHEMA, SCHEMA_VERSION, WRITE_LOCK, DATA_TABLES } = appModule("schema");
  const { schemaVersionOf } = appModule("dump");
  const { importSqliteFile } = appModule("sqlite-import");
  return db.withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock($1)", [WRITE_LOCK]);
      const current = await schemaVersionOf(client);
      if (!current) {
        await client.exec(SCHEMA);
        await client.query("INSERT INTO schema_meta (id, version, created_at) VALUES (1, $1, $2)", [SCHEMA_VERSION, new Date().toISOString()]);
      } else if (current !== SCHEMA_VERSION) {
        throw new Error(`схема базы (${current}) не совпадает с версией сайта (${SCHEMA_VERSION})`);
      }
      await client.query(`TRUNCATE ${DATA_TABLES.join(", ")} RESTART IDENTITY`);
      const result = await importSqliteFile(client, file);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => client.broken(err));
      throw err;
    }
  });
}

async function restoreDb(dir) {
  if (!HAS_PG) throw new Error("В этом образе сайта нет PostgreSQL — сначала обновите сайт (update-site.bat)");
  const manifest = await verify(dir);
  if (manifest.database === "sqlite") {
    await withDatabase((db) => restoreFromSqlite(db, path.join(dir, SQLITE_REL)));
  } else {
    const dump = await appModule("dump").readDumpFile(path.join(dir, DUMP_FILE));
    await withDatabase((db) => appModule("dump").restoreDatabase(db, dump));
  }
  return manifest;
}

/** Где лежит файл копии после восстановления: data/… — в /app/data, uploads/… — в /app/images/uploads. */
function restoredPath(rel) {
  if (rel === SQLITE_REL || rel === DUMP_FILE) return null;
  if (rel.startsWith("data/")) return path.join(DATA_DIR, rel.slice("data/".length));
  if (rel.startsWith("uploads/")) return path.join(UPLOADS_DIR, rel.slice("uploads/".length));
  return null;
}

/** После восстановления: файлы из копии на своих местах, в базе столько же записей, сколько в копии. */
async function verifyRestored(dir) {
  const manifest = readManifest(dir);
  for (const file of manifest.files) {
    const full = restoredPath(file.path);
    if (!full) continue;
    if (!fs.existsSync(full)) throw new Error(`Нет файла ${file.path}`);
    if (sha256(full) !== file.sha256) throw new Error(`Файл ${file.path} отличается от копии`);
  }
  const counts = await withDatabase((db) => appModule("dump").tableCounts(db));
  if (!counts || !sameCounts(counts, manifest.counts)) {
    throw new Error(`Число записей в базе не совпало с копией: ${JSON.stringify(counts)}`);
  }
  return manifest;
}

const countsLine = (counts) => "counts " + SQLITE_TABLES.map((table) => `${table}=${counts[table]}`).join(" ");

const MODES = { snapshot, verify, "restore-db": restoreDb, "verify-restored": verifyRestored };

(async () => {
  const [mode, dir] = process.argv.slice(2);
  if (!dir || !MODES[mode]) throw new Error("Использование: backup-snapshot.js snapshot|verify|restore-db|verify-restored <папка>");
  const manifest = await MODES[mode](dir);
  console.log("ok");
  console.log(`database=${manifest.database}`);
  console.log(countsLine(manifest.counts));
  console.log(`files=${manifest.files.length}`);
})().catch((err) => {
  console.log(`error=${err.message}`);
  process.exit(1);
});
