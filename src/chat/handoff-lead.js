/**
 * Заявка в CRM, когда посетитель уходит из ИИ-чата в WhatsApp или Telegram.
 * Сохраняется переписка, номер обращения (он же в тексте сообщения WhatsApp — так менеджер
 * найдёт диалог в CRM) и контакты, которые посетитель указал перед переходом.
 */
import { newOrderId, submitPublicOrder } from "../lib/orders-db.js";
import { isValidCustomerName, isValidPhone } from "../lib/phone.js";
import { SITE_ID } from "../site.js";
import { buildTranscript, chatCodeFor, clientRequest, hasClientMessages } from "./handoff-transcript.js";
import { forgetLead, isPermanentRejection, rememberLead } from "./lead-outbox.js";

export { hasClientMessages };

/** Одна заявка на один разговор: повторное нажатие отправляет тот же id, дубля в CRM не будет. */
export function createChatLeadSession() {
  const id = newOrderId();
  return { id, code: id ? chatCodeFor(id) : "", sent: false, sending: null };
}

/**
 * Отправить заявку в фоне, не мешая переходу в мессенджер. Ошибки посетителю не показываются:
 * он уже пишет менеджеру, а заявка нужна для учёта. До ответа сервера заявка лежит в localStorage
 * (lead-outbox.js): если страницу закрыли или отправка не удалась, она уйдёт при следующем визите.
 * Без имени, телефона и согласия на обработку ПД заявка не создаётся — сервер такие запросы отклоняет.
 */
export function sendChatLead(session, { history, channel, direction, customerName, customerPhone, consent }) {
  if (session.sent || session.sending || !hasClientMessages(history)) return session.sending;
  const name = String(customerName || "").trim();
  const phone = String(customerPhone || "").trim();
  if (!isValidCustomerName(name) || !isValidPhone(phone) || consent !== true) return session.sending;
  const body = {
    id: session.id,
    channel: "chat",
    handoff: channel === "telegram" ? "telegram" : "whatsapp",
    customerName: name,
    customerPhone: phone,
    consent: true,
    lead: { direction: direction || "", comment: clientRequest(history) },
    // i18n-ignore-start: текст для CRM
    message: "Диалог из ИИ-чата" + (session.code ? " (обращение " + session.code + ")" : "") + "\n\n" + buildTranscript(history),
    // i18n-ignore-end
    sourcePage: window.location.pathname,
    site: SITE_ID,
  };
  rememberLead(body);
  const attempt = () => submitPublicOrder(body, { keepalive: true });
  session.sending = attempt()
    .catch((err) => {
      // Сбой сети — ещё одна попытка через несколько секунд; лимиты и отказы сервера не повторяем.
      if (err && err.code === "network") return new Promise((resolve) => setTimeout(resolve, 5000)).then(attempt);
      throw err;
    })
    .then(() => {
      session.sent = true;
      forgetLead(body.id);
    })
    .catch((err) => {
      if (isPermanentRejection(err)) forgetLead(body.id);
      console.warn("Заявка из чата не сохранена в CRM", err); // i18n-ignore: лог для разработчика
    })
    .finally(() => {
      session.sending = null;
    });
  return session.sending;
}
