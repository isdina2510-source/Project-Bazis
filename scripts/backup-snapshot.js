/**
 * Снимок рабочих данных для копии вне Docker (scripts/offsite-backup.ps1). Выполняется во временном контейнере
 * из образа сайта, к которому подключены тома с данными; сайт при этом может работать.
 *
 *   node --no-warnings backup-snapshot.js snapshot <папка>  — база (VACUUM INTO: согласованная копия даже во время записи),
 *                                                            выпущенные документы, загруженные картинки, manifest.json;
 *   node --no-warnings backup-snapshot.js verify <папка>    — проверить копию: целостность базы и контрольные суммы файлов;
 *   node --no-warnings backup-snapshot.js verify-restored <папка> — то же для данных, восстановленных из копии в тома.
 *
 * manifest.json — список файлов с размером и SHA-256 и число записей в таблицах: по нему копия проверяется
 * после переноса в Windows и перед восстановлением. Код выхода 1 — снимок не сделан или копия не прошла проверку.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = "/app/data";
const UPLOADS_DIR = "/app/images/uploads";
const TABLES = ["orders", "order_items", "clients", "products", "documents"];
const FORMAT = 1;

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

function checkDb(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check).join("; ");
    const schemaVersion = db.prepare("PRAGMA user_version").get().user_version;
    const counts = {};
    for (const table of TABLES) counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    return { integrity, schemaVersion, counts };
  } finally {
    db.close();
  }
}

function snapshot(out) {
  const source = path.join(DATA_DIR, "bazis.db");
  if (!fs.existsSync(source)) throw new Error(`Нет базы ${source}`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, "data"), { recursive: true });

  const db = new DatabaseSync(source);
  try {
    db.exec("PRAGMA busy_timeout = 30000");
    db.prepare("VACUUM INTO ?").run(path.join(out, "data", "bazis.db"));
  } finally {
    db.close();
  }

  const documentsDir = path.join(DATA_DIR, "documents");
  if (fs.existsSync(documentsDir)) fs.cpSync(documentsDir, path.join(out, "data", "documents"), { recursive: true });
  fs.mkdirSync(path.join(out, "uploads"), { recursive: true });
  if (fs.existsSync(UPLOADS_DIR)) fs.cpSync(UPLOADS_DIR, path.join(out, "uploads"), { recursive: true });

  const check = checkDb(path.join(out, "data", "bazis.db"));
  if (check.integrity !== "ok") throw new Error(`Копия базы не прошла проверку: ${check.integrity}`);

  const files = listFiles(out).map((rel) => {
    const full = path.join(out, rel);
    return { path: rel, size: fs.statSync(full).size, sha256: sha256(full) };
  });
  const manifest = {
    format: FORMAT,
    createdAt: new Date().toISOString(),
    schemaVersion: check.schemaVersion,
    counts: check.counts,
    files,
  };
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

/** Где лежит файл копии после восстановления в тома: data/… — в /app/data, uploads/… — в /app/images/uploads. */
function restoredPath(rel) {
  if (rel.startsWith("data/")) return path.join(DATA_DIR, rel.slice("data/".length));
  if (rel.startsWith("uploads/")) return path.join(UPLOADS_DIR, rel.slice("uploads/".length));
  throw new Error(`Неизвестный путь в manifest.json: ${rel}`);
}

/** Сверить файлы с manifest.json из dir; restored — проверять не саму копию, а восстановленные из неё тома. */
function verify(dir, restored = false) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8").replace(/^\uFEFF/, ""));
  if (manifest.format !== FORMAT) throw new Error(`Неизвестный формат копии: ${manifest.format}`);
  const locate = (rel) => (restored ? restoredPath(rel) : path.join(dir, rel));
  for (const file of manifest.files) {
    const full = locate(file.path);
    if (!fs.existsSync(full)) throw new Error(`Нет файла ${file.path}`);
    if (sha256(full) !== file.sha256) throw new Error(`Файл ${file.path} отличается от исходного (повреждён)`);
  }
  const check = checkDb(locate("data/bazis.db"));
  if (check.integrity !== "ok") throw new Error(`База в копии повреждена: ${check.integrity}`);
  if (JSON.stringify(check.counts) !== JSON.stringify(manifest.counts)) {
    throw new Error(`Число записей не совпало с manifest.json: ${JSON.stringify(check.counts)}`);
  }
  return manifest;
}

const countsLine = (counts) => "counts " + TABLES.map((table) => `${table}=${counts[table]}`).join(" ");

try {
  const [mode, dir] = process.argv.slice(2);
  if (!dir || !["snapshot", "verify", "verify-restored"].includes(mode)) {
    throw new Error("Использование: backup-snapshot.js snapshot|verify|verify-restored <папка>");
  }
  const manifest = mode === "snapshot" ? snapshot(dir) : verify(dir, mode === "verify-restored");
  console.log("ok");
  console.log(countsLine(manifest.counts));
  console.log(`files=${manifest.files.length}`);
} catch (err) {
  console.log(`error=${err.message}`);
  process.exit(1);
}
