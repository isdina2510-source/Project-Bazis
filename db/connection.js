/**
 * Подключение к PostgreSQL по адресу DATABASE_URL.
 *
 *   postgres://user:password@host:5432/dbname — рабочий сервер PostgreSQL 16+ (драйвер pg, пул соединений);
 *   pglite:<папка> или pglite:memory          — PostgreSQL внутри процесса (@electric-sql/pglite) для тестов
 *                                                и разработки; одно соединение, для работы сайта не предназначен.
 *
 * Оба варианта дают одинаковый интерфейс:
 *   query(text, params) → { rows, rowCount }, exec(sql) — несколько команд без параметров,
 *   withClient(fn) — fn получает отдельное соединение (для транзакции), close().
 */

const MIN_SERVER_VERSION = 160000;
const CONNECT_TIMEOUT_MS = 10000;
const POOL_SIZE = 10;
const STATEMENT_TIMEOUT_MS = 60000;

/**
 * Разбор DATABASE_URL без подключения.
 * @returns {{ ok: true, kind: "postgres" | "pglite", url: string, display: string } | { ok: false, error: string }}
 */
function parseDatabaseUrl(raw) {
  const url = String(raw || "").trim();
  if (!url) {
    return {
      ok: false,
      error:
        "Не задан DATABASE_URL — адрес базы PostgreSQL. Добавьте в .env строку " +
        "DATABASE_URL=postgres://bazis:пароль@127.0.0.1:5432/bazis (в Docker адрес задаёт docker-compose.yml).",
    };
  }
  if (/^pglite:/i.test(url)) {
    const target = url.slice("pglite:".length).replace(/^\/\//, "");
    return { ok: true, kind: "pglite", url, display: "PGlite (" + (target && target !== "memory" ? target : "в памяти") + ")" };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "DATABASE_URL не похож на адрес: нужен вид postgres://пользователь:пароль@сервер:5432/база." };
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return { ok: false, error: `DATABASE_URL: неизвестная схема «${parsed.protocol}» — нужен postgres://…` };
  }
  if (!parsed.hostname || parsed.pathname.length < 2) {
    return { ok: false, error: "DATABASE_URL: укажите сервер и имя базы — postgres://пользователь:пароль@сервер:5432/база." };
  }
  const user = parsed.username ? decodeURIComponent(parsed.username) + "@" : "";
  const display = `PostgreSQL ${user}${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}`;
  return { ok: true, kind: "postgres", url, display };
}

/** Очередь «по одному»: у PGlite одно соединение, транзакция не должна перемешаться с чужими запросами. */
function createMutex() {
  let tail = Promise.resolve();
  return function lock() {
    let release;
    const next = new Promise((resolve) => (release = resolve));
    const acquired = tail.then(() => release);
    tail = tail.then(() => next);
    return acquired;
  };
}

async function openPglite(target, log) {
  let PGlite;
  try {
    ({ PGlite } = require("@electric-sql/pglite"));
  } catch (err) {
    throw new Error("DATABASE_URL=pglite:… работает только с пакетом @electric-sql/pglite (для тестов и разработки): " + err.message);
  }
  const fs = require("fs");
  const dir = target && target !== "memory" ? target : null;
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const db = dir ? new PGlite(dir) : new PGlite();
  await db.waitReady;
  const lock = createMutex();
  const run = async (text, params) => {
    const result = await db.query(text, params || []);
    return { rows: result.rows, rowCount: result.affectedRows || 0 };
  };
  const exec = async (sql) => {
    await db.exec(sql);
  };
  return {
    kind: "pglite",
    async query(text, params) {
      const release = await lock();
      try {
        return await run(text, params);
      } finally {
        release();
      }
    },
    async exec(sql) {
      const release = await lock();
      try {
        await exec(sql);
      } finally {
        release();
      }
    },
    async withClient(fn) {
      const release = await lock();
      try {
        return await fn({ query: run, exec, broken: () => {} });
      } finally {
        release();
      }
    },
    async close() {
      const release = await lock();
      try {
        if (!db.closed) await db.close();
      } finally {
        release();
      }
    },
    log,
  };
}

async function openPostgres(url, log) {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: url,
    max: POOL_SIZE,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: 30000,
    application_name: "bazis-site",
    // Повисший запрос или брошенная транзакция держали бы блокировку записи (pg_advisory_xact_lock),
    // и все остальные изменения ждали бы бесконечно; сервер PostgreSQL сам прервёт их.
    statement_timeout: STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: STATEMENT_TIMEOUT_MS,
    keepAlive: true,
  });
  // Обрыв простаивающего соединения (перезапуск PostgreSQL): без обработчика процесс упал бы.
  pool.on("error", (err) => log.error("PostgreSQL: соединение в пуле оборвалось:", err.message));
  return {
    kind: "postgres",
    async query(text, params) {
      const result = await pool.query(text, params);
      return { rows: result.rows, rowCount: result.rowCount || 0 };
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async withClient(fn) {
      const client = await pool.connect();
      let broken = null;
      try {
        return await fn({
          async query(text, params) {
            const result = await client.query(text, params);
            return { rows: result.rows, rowCount: result.rowCount || 0 };
          },
          async exec(sql) {
            await client.query(sql);
          },
          broken: (err) => (broken = err || new Error("connection broken")),
        });
      } finally {
        // Соединение с незавершённой транзакцией в пул не возвращается — pg его закроет.
        client.release(broken || undefined);
      }
    },
    close: () => pool.end(),
    log,
  };
}

/** Ошибки «PostgreSQL недоступен» (а не ошибка в запросе): сервер не запущен, перезапускается, оборвалась связь. */
function isConnectionError(err) {
  if (!err) return false;
  const code = String(err.code || "");
  if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "EHOSTUNREACH"].includes(code)) return true;
  // 08 — ошибки соединения, 57P01..57P03 — сервер останавливается или ещё запускается.
  if (/^08/.test(code) || /^57P0[123]$/.test(code)) return true;
  return /Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error/i.test(
    String(err.message || "")
  );
}

/**
 * Открыть базу и дождаться, пока она ответит (PostgreSQL в Docker может запускаться позже сайта).
 * @param {string} url DATABASE_URL
 * @param {{ log?: Pick<Console, "log" | "warn" | "error">, waitMs?: number }} [options]
 */
async function openDatabase(url, options = {}) {
  const log = options.log || console;
  const parsed = parseDatabaseUrl(url);
  if (!parsed.ok) throw new Error(parsed.error);
  const db =
    parsed.kind === "pglite"
      ? await openPglite(parsed.url.slice("pglite:".length).replace(/^\/\//, ""), log)
      : await openPostgres(parsed.url, log);
  db.display = parsed.display;

  const waitMs = options.waitMs == null ? 60000 : options.waitMs;
  const until = Date.now() + waitMs;
  let warned = false;
  for (;;) {
    try {
      const { rows } = await db.query("SELECT current_setting('server_version_num')::int AS v");
      if (rows[0].v < MIN_SERVER_VERSION) {
        await db.close().catch(() => {});
        throw Object.assign(new Error(`Нужен PostgreSQL 16 или новее, а у ${parsed.display} — версия ${rows[0].v}.`), { fatal: true });
      }
      break;
    } catch (err) {
      if (err.fatal || !isConnectionError(err) || Date.now() >= until) {
        await db.close().catch(() => {});
        if (err.fatal) throw err;
        throw new Error(`Не удалось подключиться к базе ${parsed.display}: ${err.message}`);
      }
      if (!warned) {
        log.warn(`${parsed.display} пока не отвечает (${err.message}) — жду до ${Math.round(waitMs / 1000)} с...`);
        warned = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  return db;
}

module.exports = { openDatabase, parseDatabaseUrl, isConnectionError, MIN_SERVER_VERSION };
