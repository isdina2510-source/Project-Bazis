/**
 * Проверка реквизитов компании и покупателя. Описание полей — shared/requisites.json (его же читает админка).
 * Все поля необязательные: незаполненное печатается в документах прочерком.
 */
const { COMPANY_FIELDS, CLIENT_FIELDS, CLIENT_TYPES, EMAIL_PATTERN } = require("../shared/requisites.json");

const EMAIL_RE = new RegExp(EMAIL_PATTERN);

/** Коды (ИИН, ИИК, БИК…) — без пробелов, IBAN и БИК — заглавными; многострочные поля сохраняют переносы. */
function cleanValue(field, raw) {
  const text = String(raw == null ? "" : raw);
  let value = field.multiline ? text.replace(/\r\n?/g, "\n").trim() : text.replace(/\s+/g, " ").trim();
  if (field.pattern) value = value.replace(/\s+/g, "");
  if (field.upper) value = value.toUpperCase();
  return value;
}

function fieldError(field, value) {
  if (!value) return null;
  if (value.length > (field.max || 200)) return `${field.label}: не длиннее ${field.max || 200} символов`;
  if (field.pattern && !new RegExp(field.pattern).test(value)) return `${field.label}: ${field.patternHint || "неверный формат"}`;
  if (field.type === "email" && !EMAIL_RE.test(value)) return `${field.label}: неверный адрес`;
  return null;
}

/**
 * @param {object} raw
 * @param {Array} fields
 * @returns {{ values: Record<string, string>, errors: string[] }}
 */
function normalizeFields(raw, fields) {
  const source = raw && typeof raw === "object" ? raw : {};
  const values = {};
  const errors = [];
  for (const field of fields) {
    const value = cleanValue(field, source[field.key]);
    const error = fieldError(field, value);
    if (error) errors.push(error);
    values[field.key] = value.slice(0, field.max || 200);
  }
  return { values, errors };
}

function normalizeCompany(raw) {
  return normalizeFields(raw, COMPANY_FIELDS);
}

/** Реквизиты покупателя: type — person или company; банковские поля только у юрлица. */
function normalizeClientRequisites(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const type = Object.prototype.hasOwnProperty.call(CLIENT_TYPES, source.type) ? source.type : "person";
  const fields = CLIENT_FIELDS.filter((field) => type === "company" || !field.companyOnly);
  const { values, errors } = normalizeFields(source, fields);
  return { values: { type, ...values }, errors };
}

module.exports = { COMPANY_FIELDS, CLIENT_FIELDS, normalizeCompany, normalizeClientRequisites };
