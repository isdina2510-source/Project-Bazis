/**
 * Проверка отдельных значений из .env. Пустое значение — значение по умолчанию; непустое, но неверное — ошибка
 * с именем переменной: сервер собирает такие ошибки и не запускается (код 4), ИИ-ядро только предупреждает.
 * Результат — { ok: true, value } или { ok: false, value: <по умолчанию>, error }.
 */

function rangeText(min, max) {
  if (Number.isFinite(min) && Number.isFinite(max)) return `от ${min} до ${max}`;
  if (Number.isFinite(min)) return `не меньше ${min}`;
  if (Number.isFinite(max)) return `не больше ${max}`;
  return "";
}

/** Число из env[name] в границах min…max. */
function readNumber(env, name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[name];
  const text = raw == null ? "" : String(raw).trim();
  if (!text) return { ok: true, value: fallback };
  const value = Number(text);
  if (Number.isFinite(value) && value >= min && value <= max) return { ok: true, value };
  const range = rangeText(min, max);
  return {
    ok: false,
    value: fallback,
    error: `${name}=${raw} — нужно число${range ? " " + range : ""} (без пробелов и единиц измерения).`,
  };
}

/** Часовой пояс IANA из env[name] (например, Asia/Almaty) — в том виде, в каком его получит Intl. */
function readTimeZone(env, name, fallback) {
  const raw = env[name];
  if (raw == null || raw === "") return { ok: true, value: fallback };
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: raw });
    return { ok: true, value: raw };
  } catch {
    return { ok: false, value: fallback, error: `${name}=${raw} — неизвестный часовой пояс; пример: ${name}=Asia/Almaty.` };
  }
}

module.exports = { readNumber, readTimeZone };
