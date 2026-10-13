/**
 * PostgreSQL для тестов без отдельного сервера — PGlite (тот же PostgreSQL, собранный в WebAssembly).
 *
 * sharedDatabase() — одна база в памяти на файл тестов; reset() стирает всё, что создали прошлые тесты.
 * BAZIS_TEST_DATABASE_URL=postgres://… — те же тесты на настоящем сервере PostgreSQL (база будет стёрта: только отдельная!);
 *   запускать с --test-concurrency=1, иначе файлы тестов стирают общую базу друг у друга.
 * pgliteTemplate() — папка с уже инициализированной базой: сервер в песочнице получает её копию
 * (открыть готовую папку — доли секунды, инициализировать новую — несколько секунд).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDatabase } = require("../db/connection");

let shared = null;

async function sharedDatabase() {
  if (!shared) {
    shared = openDatabase(process.env.BAZIS_TEST_DATABASE_URL || "pglite:memory", { waitMs: 0 }).then((db) => ({
      db,
      async reset() {
        await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      },
    }));
  }
  return shared;
}

let template = null;
const TEMPLATE_MARK = "bazis-template.json";

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : entry.name === TEMPLATE_MARK ? 0 : 1;
  }
  return n;
}

/** Шаблон цел: отметка записана после создания, и файлов столько же (папку во временных могли почистить частично). */
function templateIntact(dir) {
  try {
    const mark = JSON.parse(fs.readFileSync(path.join(dir, TEMPLATE_MARK), "utf8"));
    return mark.files === countFiles(dir);
  } catch {
    return false;
  }
}

/** Путь к шаблонной папке PGlite; создаётся один раз и переиспользуется всеми процессами тестов. */
async function pgliteTemplate() {
  if (!template) {
    template = (async () => {
      const { version } = JSON.parse(
        fs.readFileSync(path.join(path.dirname(require.resolve("@electric-sql/pglite")), "..", "package.json"), "utf8")
      );
      const dir = path.join(os.tmpdir(), `bazis-pglite-template-${version}`);
      if (templateIntact(dir)) return dir;
      const staging = fs.mkdtempSync(path.join(os.tmpdir(), "bazis-pglite-staging-"));
      const db = await openDatabase("pglite:" + staging, { waitMs: 0 });
      await db.close();
      fs.writeFileSync(path.join(staging, TEMPLATE_MARK), JSON.stringify({ files: countFiles(staging) }));
      // Повреждённый шаблон убираем; если его в это же время заменил параллельный процесс, rename не удастся.
      if (fs.existsSync(dir) && !templateIntact(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      try {
        fs.renameSync(staging, dir);
      } catch {
        // Шаблон уже создал параллельный процесс тестов — берём его, иначе остаёмся на своей папке.
        if (!templateIntact(dir)) return staging;
        fs.rmSync(staging, { recursive: true, force: true });
      }
      return dir;
    })();
  }
  return template;
}

/** Копия шаблона в target; возвращает DATABASE_URL для неё. */
async function pgliteCopy(target) {
  fs.cpSync(await pgliteTemplate(), target, { recursive: true, filter: (src) => path.basename(src) !== TEMPLATE_MARK });
  return "pglite:" + target;
}

module.exports = { sharedDatabase, pgliteTemplate, pgliteCopy };
