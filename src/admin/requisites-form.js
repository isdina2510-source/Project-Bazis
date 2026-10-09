/** Проверка реквизита в форме — те же правила, что на сервере (documents/requisites.js). */
import requisitesSchema from "../../shared/requisites.json";

const EMAIL_RE = new RegExp(requisitesSchema.EMAIL_PATTERN);

export function validateField(field, raw) {
  let value = String(raw == null ? "" : raw).trim();
  if (!value) return "";
  if (field.pattern) value = value.replace(/\s+/g, "");
  if (field.upper) value = value.toUpperCase();
  if (value.length > (field.max || 200)) return field.label + ": не длиннее " + (field.max || 200) + " символов";
  if (field.pattern && !new RegExp(field.pattern).test(value)) return field.label + ": " + (field.patternHint || "неверный формат");
  if (field.type === "email" && !EMAIL_RE.test(value)) return field.label + ": неверный адрес";
  return "";
}
