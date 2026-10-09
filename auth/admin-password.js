/**
 * Пароль админки: проверка значения ADMIN_PASSWORD при запуске и сравнение с паролем из запроса.
 * Регистр учитывается. Пробелы по краям отбрасываются, Unicode приводится к NFC
 * (одна и та же «й» с разных клавиатур может прийти разными байтами).
 */
const crypto = require("crypto");

const MIN_LENGTH = 8;
/** Пароли, которые подбирают первыми; сравнение без учёта регистра. «bazis» — бывший пароль по умолчанию. */
const WEAK_PASSWORDS = new Set([
  "bazis",
  "bazis123",
  "admin",
  "admin123",
  "administrator",
  "password",
  "password1",
  "qwerty",
  "qwerty123",
  "12345678",
  "123456789",
  "1234567890",
  "11111111",
  "00000000",
  "пароль",
  "йцукенгш",
]);

function normalizePassword(value) {
  return String(value == null ? "" : value).trim().normalize("NFC");
}

/** { ok: true, password } или { ok: false, error } — текст ошибки для журнала запуска. */
function checkAdminPassword(raw) {
  if (raw == null) {
    return { ok: false, error: "ADMIN_PASSWORD не задан." };
  }
  const password = normalizePassword(raw);
  if (!password) {
    return { ok: false, error: "ADMIN_PASSWORD пустой." };
  }
  if (Array.from(password).length < MIN_LENGTH) {
    return { ok: false, error: `ADMIN_PASSWORD короче ${MIN_LENGTH} символов.` };
  }
  if (WEAK_PASSWORDS.has(password.toLowerCase())) {
    return { ok: false, error: "ADMIN_PASSWORD слишком простой (из списка самых частых паролей)." };
  }
  return { ok: true, password };
}

function digest(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

/** Сравнение за постоянное время: хеши одной длины, поэтому длина пароля по времени ответа не угадывается. */
function passwordMatches(candidate, expected) {
  if (!expected) return false;
  return crypto.timingSafeEqual(digest(normalizePassword(candidate)), digest(expected));
}

/**
 * Заголовок X-Admin-Password: админка шлёт пароль через encodeURIComponent (заголовки — только Latin-1),
 * старые вкладки — как есть. Совпасть должен хотя бы один вариант.
 */
function headerMatchesPassword(header, expected) {
  const raw = String(header || "").trim();
  if (!raw || !expected) return false;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // не URI-кодировка — сравниваем как есть
  }
  const decodedOk = passwordMatches(decoded, expected);
  const rawOk = passwordMatches(raw, expected);
  return decodedOk || rawOk;
}

module.exports = { MIN_LENGTH, checkAdminPassword, passwordMatches, headerMatchesPassword, normalizePassword };
