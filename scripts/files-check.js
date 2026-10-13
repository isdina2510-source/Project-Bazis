/**
 * Отпечаток файлов данных для переноса между папкой data и Docker (scripts/switch-data.ps1):
 * число файлов и общий SHA-256 по путям и содержимому. Строка «files=… digest=…» сравнивается до и после копирования —
 * перенос засчитывается, только если она совпала. Отметка DATA-MOVED.txt не учитывается.
 * Запуск: node scripts/files-check.js <папка data> <папка картинок>; код выхода 1 — папку не прочитать.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const IGNORED = new Set(["DATA-MOVED.txt"]);

function listFiles(root, dir = root) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(root, full));
    else if (entry.isFile() && !(dir === root && IGNORED.has(entry.name))) out.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return out.sort();
}

try {
  const roots = process.argv.slice(2);
  if (!roots.length) throw new Error("Использование: node scripts/files-check.js <папка> [папка…]");
  const digest = crypto.createHash("sha256");
  let count = 0;
  roots.forEach((root, index) => {
    for (const rel of listFiles(root)) {
      const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, rel))).digest("hex");
      digest.update(`${index}:${rel}:${sha}\n`);
      count += 1;
    }
  });
  console.log(`files=${count} digest=${digest.digest("hex").slice(0, 16)}`);
} catch (err) {
  console.log(`error=${err.message}`);
  process.exit(1);
}
