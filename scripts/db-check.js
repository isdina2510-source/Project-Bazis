/**
 * Проверка файла базы при переносе данных (scripts/switch-data.ps1): целостность и число записей.
 * Строка «counts …» сравнивается до и после копирования — перенос засчитывается, только если она совпала.
 * Запуск: node --no-warnings scripts/db-check.js <путь к bazis.db>; код выхода 1 — база повреждена или не открылась.
 */
const { DatabaseSync } = require("node:sqlite");

const TABLES = ["orders", "order_items", "clients", "products", "documents"];

try {
  const db = new DatabaseSync(process.argv[2], { readOnly: true });
  const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
  const counts = TABLES.map((table) => `${table}=${db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n}`);
  db.close();
  console.log(`integrity=${integrity}`);
  console.log(`counts ${counts.join(" ")}`);
  process.exit(integrity === "ok" ? 0 : 1);
} catch (err) {
  console.log(`error=${err.message}`);
  process.exit(1);
}
