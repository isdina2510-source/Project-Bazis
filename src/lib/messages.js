import { getLang, t } from "../i18n/index.js";
import { ALL_CATEGORIES, CONTACT_PHONE, categoryText, formatPrice, normalizeCurrency, productText } from "./catalog.js";
import { isValidCustomerName, isValidPhone, normalizePhone } from "./phone.js";

export function totalsText(items) {
  const totals = {};
  items.forEach((item) => {
    const code = normalizeCurrency(item.currency);
    totals[code] = (totals[code] || 0) + (Number(item.lineTotal) || 0);
  });
  const parts = Object.keys(totals).map((code) => formatPrice(totals[code], code));
  return parts.length ? parts.join(" + ") : formatPrice(0, "KZT");
}

export function buildRequestMessage(action, items, lang = getLang()) {
  const hello = t(action === "consultation" ? "message.hello_consultation" : "message.hello_order", undefined, lang);

  if (!items.length) return hello;

  const lines = items.map(
    (item, index) =>
      `${index + 1}. ${productText(item, "title", lang)} × ${item.qty} — ${formatPrice(item.lineTotal, item.currency, lang)}`
  );

  return [
    hello,
    "",
    t("message.package", undefined, lang),
    ...lines,
    "",
    t("message.total", { total: totalsText(items) }, lang),
    "",
    t("message.next_steps", undefined, lang),
  ].join("\n");
}

export function buildCartOrderMessage(items, customer, lang = getLang()) {
  const parts = [buildRequestMessage("order", items, lang)];
  const name = String((customer && customer.name) || "").trim();
  const phone = String((customer && customer.phone) || "").trim();
  if (name || phone) {
    parts.push("");
    if (name) parts.push(t("message.name", { name }, lang));
    if (phone) parts.push(t("message.phone", { phone }, lang));
  }
  return parts.join("\n").trim();
}

/** Текст для WhatsApp, когда чат передаёт разговор живому консультанту. */
export function buildHandoffMessage(userText, fileNames = [], lang = getLang(), code = "") {
  return [
    t("message.handoff_hello", undefined, lang),
    t("message.handoff_want", undefined, lang),
    userText ? t("message.handoff_question", { text: userText }, lang) : "",
    fileNames.length ? t("message.handoff_files", { files: fileNames.join(", ") }, lang) : "",
    code ? t("message.handoff_code", { code }, lang) : "",
    t("message.next_steps", undefined, lang),
  ]
    .filter(Boolean)
    .join("\n");
}

export function whatsappUrl(text, phone = CONTACT_PHONE) {
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

export function getWhatsAppConsultationUrl(product) {
  const text = buildRequestMessage("consultation", [
    { ...product, qty: 1, lineTotal: product.price },
  ]);
  return whatsappUrl(text);
}

/** «Хочу так же» из портфолио медиа-сайта. */
export function getPortfolioWhatsAppUrl(title, lang = getLang()) {
  return whatsappUrl([t("message.portfolio", { title }, lang), t("message.next_steps", undefined, lang)].join("\n"));
}

/** Заявка после статьи или теста: что человек прочитал / какой результат получил и какая услуга интересна. */
export function buildArticleMessage({ title, quiz, product }, lang = getLang()) {
  return [
    quiz
      ? t("message.quiz", { title, score: quiz.score, max: quiz.max, result: quiz.result }, lang)
      : t("message.article", { title }, lang),
    product ? t("message.service", { service: productText(product, "title", lang) }, lang) : "",
    t("message.next_steps", undefined, lang),
  ]
    .filter(Boolean)
    .join("\n");
}

export function isCheckoutCustomerValid(customer) {
  return isValidCustomerName(customer && customer.name) && isValidPhone(customer && customer.phone);
}

// i18n-ignore-start: сообщения CRM для админки (только ru)
function formatCrmItemLine(item, index) {
  const title = item.title || "Позиция";
  const qty = item.qty || 1;
  const price = item.lineTotal != null ? " — " + formatPrice(item.lineTotal, item.currency) : "";
  return index + 1 + ". " + title + " × " + qty + price;
}

/** Сообщение клиенту из CRM: напоминание о его заказе или заявке с формы. */
export function buildClientFollowupMessage(order) {
  const name = String(order.customerName || "").trim();
  const greeting = name ? "Здравствуйте, " + name + "!" : "Здравствуйте!";
  const items = Array.isArray(order.items) ? order.items : [];
  const parts = [greeting, ""];

  if (order.channel === "site") {
    // У заявок, сохранённых до появления поля lead, направление есть только в позиции lead-<id>, комментарий — в тексте.
    const leadItem = items.find((item) => String(item.id || "").startsWith("lead-"));
    const directionId = (order.lead && order.lead.direction) || (leadItem ? String(leadItem.id).slice(5) : "");
    const direction = ALL_CATEGORIES.some((item) => item.id === directionId) ? categoryText(directionId, "title", "ru") : "";
    parts.push(
      direction
        ? "Вы оставили заявку на сайте Dinara BILab по направлению «" + direction + "»."
        : "Вы оставили заявку на сайте Dinara BILab."
    );
    const legacyComment = order.lead ? "" : (String(order.message || "").match(/^Комментарий:\s*([\s\S]*)$/m) || [])[1];
    const comment = String((order.lead ? order.lead.comment : legacyComment) || "").trim();
    if (comment) parts.push("", "Ваш комментарий: " + comment);
    parts.push("", "Готовы обсудить детали и следующие шаги.");
    return parts.join("\n");
  }

  if (items.length) {
    parts.push("Вы хотели заказать у нас:", "", ...items.map(formatCrmItemLine));
  } else {
    parts.push("Вы хотели заказать у нас услугу на сайте Dinara BILab.");
  }

  const total = String(order.totalText || "").trim();
  if (total) parts.push("", "Итого: " + total);

  parts.push("", "Готовы обсудить детали и следующие шаги.");
  return parts.join("\n");
}
// i18n-ignore-end

export function getClientWhatsAppUrl(order) {
  const phone = normalizePhone(order.customerPhone);
  if (!phone) return "";
  return whatsappUrl(buildClientFollowupMessage(order), phone);
}
