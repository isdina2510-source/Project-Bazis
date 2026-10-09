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
