/**
 * Чтение .env без зависимостей. Общее для сервера и скриптов (scripts/deploy-config.mjs),
 * чтобы файл везде понимался одинаково.
 */
const fs = require("fs");

/** Пары KEY=VALUE из файла; нет файла — пустой объект. Кавычки вокруг значения снимаются. */
function readEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {};
  // Блокнот Windows может сохранить файл с BOM — без его удаления первая переменная не прочитается.
  const lines = fs.readFileSync(envPath, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
  const out = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

/** Переменные из файла дополняют окружение: заданное в системе важнее файла. */
function loadEnvFile(envPath, target = process.env) {
  try {
    for (const [key, val] of Object.entries(readEnvFile(envPath))) {
      if (target[key] == null) target[key] = val;
    }
  } catch (err) {
    console.warn("Не удалось прочитать .env:", err && err.message);
  }
}

module.exports = { readEnvFile, loadEnvFile };
