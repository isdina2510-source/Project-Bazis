/** Цифры телефона в формате для wa.me (7XXXXXXXXXX). */
export function normalizePhone(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("8")) digits = "7" + digits.slice(1);
  if (digits.length === 10) digits = "7" + digits;
  return digits;
}

/** Те же границы проверяет сервер при приёме заказа. */
export function isValidPhone(raw) {
  const length = normalizePhone(raw).length;
  return length >= 11 && length <= 15;
}

/** Имя для заявки/заказа: минимум 2 символа после trim. */
export function isValidCustomerName(raw) {
  return String(raw || "").trim().length >= 2;
}

/**
 * «+7 (777) 123-45-67» по мере ввода. Номер в Казахстане сам начинается с 7, поэтому первая 7 —
 * это код страны, только если поле уже начинается с «+» или цифр больше десяти; ведущая 8 — всегда префикс.
 */
export function maskPhone(raw) {
  const value = String(raw || "").trim();
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("8") || (value.startsWith("+") && digits.startsWith("7"))) digits = digits.slice(1);
  if (digits.length > 10 && (digits.startsWith("7") || digits.startsWith("8"))) digits = digits.slice(1);
  digits = digits.slice(0, 10);
  if (!digits) return "";
  let out = "+7 (" + digits.slice(0, 3);
  if (digits.length >= 3) out += ")";
  if (digits.length > 3) out += " " + digits.slice(3, 6);
  if (digits.length > 6) out += "-" + digits.slice(6, 8);
  if (digits.length > 8) out += "-" + digits.slice(8, 10);
  return out;
}

export function formatPhoneDisplay(raw) {
  const digits = normalizePhone(raw);
  if (digits.length === 11 && digits.startsWith("7")) {
    return (
      "+7 " +
      digits.slice(1, 4) +
      " " +
      digits.slice(4, 7) +
      " " +
      digits.slice(7, 9) +
      " " +
      digits.slice(9)
    );
  }
  return String(raw || "").trim();
}

/** Ключ дедупликации клиента: по телефону, иначе по имени. */
export function clientKey(name, phone) {
  const p = normalizePhone(phone);
  if (p) return "p:" + p;
  const n = String(name || "").trim().toLowerCase();
  if (n) return "n:" + n;
  return "";
}
