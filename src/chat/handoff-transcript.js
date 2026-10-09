/**
 * Текст заявки из ИИ-чата для CRM: переписка, запрос клиента, телефон из сообщений, номер обращения.
 * Без зависимостей — проверяется автотестами (antispam/test/handoff.test.js).
 */
// i18n-ignore-start: текст для CRM, посетителю не показывается

const MAX_TRANSCRIPT_CHARS = 7500;
const MAX_COMMENT_CHARS = 1900;
/** Казахстанский/российский номер в свободном тексте: +7 701 123 45 67, 8(701)1234567 и т.п. */
const PHONE_RE = /(?:\+\s*7|\b8|\b7)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}(?!\d)/;

/** Номер обращения — первые 6 символов id заказа (сервер вычисляет так же, см. chatCodeFor в server.js). */
export function chatCodeFor(orderId) {
  return String(orderId || "").replace(/^ord_/, "").replace(/-/g, "").slice(0, 6).toUpperCase();
}

function messageText(m) {
  const files = (m.attachments || []).map((f) => "«" + f.name + "»").join(", ");
  return [String(m.text || "").trim(), files && "[файлы: " + files + "]"].filter(Boolean).join(" ");
}

export function hasClientMessages(history) {
  return (history || []).some((m) => m && m.role === "user" && messageText(m));
}

/** Переписка для CRM: если не помещается — без самых ранних реплик. */
export function buildTranscript(history) {
  const lines = (history || [])
    .filter((m) => m && (m.role === "user" || m.role === "bot") && messageText(m))
    .map((m) => (m.role === "user" ? "Клиент: " : "Консультант: ") + messageText(m));
  let total = 0;
  let start = lines.length;
  while (start > 0 && total + lines[start - 1].length + 2 <= MAX_TRANSCRIPT_CHARS) {
    total += lines[start - 1].length + 2;
    start--;
  }
  return (start > 0 ? "…(начало диалога не поместилось)\n\n" : "") + lines.slice(start).join("\n\n");
}

/** Последний телефон, который клиент написал в чате. */
export function findPhone(history) {
  for (const m of [...(history || [])].reverse()) {
    if (!m || m.role !== "user") continue;
    const match = String(m.text || "").match(PHONE_RE);
    if (match) return match[0].replace(/\s+/g, " ").trim();
  }
  return "";
}

/** Что спрашивал клиент — коротко для карточки заявки. */
export function clientRequest(history) {
  const text = (history || [])
    .filter((m) => m && m.role === "user")
    .map(messageText)
    .filter(Boolean)
    .join("\n");
  return text.length > MAX_COMMENT_CHARS ? "…" + text.slice(-MAX_COMMENT_CHARS) : text;
}
// i18n-ignore-end
