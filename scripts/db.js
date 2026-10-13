/**
 * Обслуживание базы PostgreSQL сайта (адрес — DATABASE_URL из окружения или .env, как у сервера):
 *
 *   node scripts/db.js counts               — версия схемы и число записей по таблицам (npm run db:counts);
 *   node scripts/db.js dump [файл]          — копия базы в файл .json.gz (npm run db:dump);
 *                                             без имени — data/backups/bazis-manual-<время>.json.gz;
 *   node scripts/db.js restore <файл> --yes — заменить все данные копией (npm run db:restore -- <файл> --yes).
 *                                             Перед этим текущие данные сохраняются в data/backups/bazis-before-restore-<время>.json.gz.
 *                                             Сайт на время восстановления остановите.
 *
 * Копии — тот же формат, что и ежедневные data/backups/bazis-ГГГГ-ММ-ДД.json.gz (db/dump.js).
 * Код выхода 1 — ошибка (текст в stderr).
 */
const path = require("path");
const { loadEnvFile } = require("../config/env");
const { openDatabase } = require("../db/connection");
const { dumpDatabase, restoreDatabase, readDumpFile, writeDumpFile, tableCounts, schemaVersionOf } = require("../db/dump");

const ROOT = path.join(__dirname, "..");
loadEnvFile(path.join(ROOT, ".env"));
const BACKUP_DIR = path.join(ROOT, "data", "backups");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const countsLine = (counts) => "counts " + Object.entries(counts).map(([table, n]) => `${table}=${n}`).join(" ");

async function main() {
  const [command, fileArg, ...flags] = process.argv.slice(2);
  if (!["counts", "dump", "restore"].includes(command)) {
    throw new Error("Использование: node scripts/db.js counts | dump [файл] | restore <файл> --yes");
  }
  if (command === "restore" && !fileArg) throw new Error("Укажите файл копии: node scripts/db.js restore <файл> --yes");
  if (command === "restore" && !flags.includes("--yes")) {
    throw new Error("Восстановление заменит все данные в базе. Остановите сайт и повторите с --yes.");
  }

  const db = await openDatabase(process.env.DATABASE_URL, { waitMs: 15000 });
  try {
    console.log(`База: ${db.display}`);
    if (command === "counts") {
      const counts = await tableCounts(db);
      if (!counts) {
        console.log("Таблиц сайта нет — база пустая (сайт создаст их при первом запуске).");
        return;
      }
      console.log(`schema=${await db.withClient((client) => schemaVersionOf(client))}`);
      console.log(countsLine(counts));
      return;
    }
    if (command === "dump") {
      const file = path.resolve(fileArg || path.join(BACKUP_DIR, `bazis-manual-${stamp()}.json.gz`));
      const dump = await dumpDatabase(db);
      await writeDumpFile(file, dump);
      await readDumpFile(file);
      console.log(`Копия сохранена и проверена: ${file}`);
      console.log(countsLine(dump.counts));
      return;
    }

    const dump = await readDumpFile(path.resolve(fileArg));
    if (await tableCounts(db)) {
      const safety = path.join(BACKUP_DIR, `bazis-before-restore-${stamp()}.json.gz`);
      await writeDumpFile(safety, await dumpDatabase(db));
      console.log(`Текущие данные сохранены: ${safety}`);
    }
    const counts = await restoreDatabase(db, dump);
    console.log(`Восстановлено из ${path.resolve(fileArg)} (копия от ${dump.createdAt})`);
    console.log(countsLine(counts));
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(`Ошибка: ${err.message}`);
  process.exit(1);
});
