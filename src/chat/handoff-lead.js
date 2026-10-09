/**
 * Заявка в CRM, когда посетитель уходит из ИИ-чата в WhatsApp или Telegram.
 * Сохраняется переписка, номер обращения (он же в тексте сообщения WhatsApp — так менеджер
 * найдёт диалог в CRM) и телефон, если клиент назвал его в чате.
 */
import { newOrderId, submitPublicOrder } from "../lib/orders-db.js";
import { SITE_ID } from "../site.js";
import { buildTranscript, chatCodeFor, clientRequest, findPhone, hasClientMessages } from "./handoff-transcript.js";

export { hasClientMessages };

/** Одна заявка на один разговор: повторное нажатие отправляет тот же id, дубля в CRM не будет. */
export function createChatLeadSession() {
  const id = newOrderId();
  return { id, code: id ? chatCodeFor(id) : "", sent: false, sending: null };
}

/**
 * Отправить заявку в фоне, не мешая переходу в мессенджер. Ошибки посетителю не показываются:
 * он уже пишет менеджеру, а заявка нужна для учёта.
 */
export function sendChatLead(session, { history, channel, direction }) {
  if (session.sent || session.sending || !hasClientMessages(history)) return session.sending;
  const body = {
    id: session.id,
    channel: "chat",
    handoff: channel === "telegram" ? "telegram" : "whatsapp",
    customerName: "",
    customerPhone: findPhone(history),
    lead: { direction: direction || "", comment: clientRequest(history) },
    // i18n-ignore-start: текст для CRM
    message: "Диалог из ИИ-чата" + (session.code ? " (обращение " + session.code + ")" : "") + "\n\n" + buildTranscript(history),
    // i18n-ignore-end
    sourcePage: window.location.pathname,
    site: SITE_ID,
  };
  const attempt = () => submitPublicOrder(body, { keepalive: true });
  session.sending = attempt()
    .catch((err) => {
      // Сбой сети — ещё одна попытка через несколько секунд; лимиты и отказы сервера не повторяем.
      if (err && err.code === "network") return new Promise((resolve) => setTimeout(resolve, 5000)).then(attempt);
      throw err;
    })
    .then(() => {
      session.sent = true;
    })
    .catch((err) => console.warn("Заявка из чата не сохранена в CRM", err)) // i18n-ignore: лог для разработчика
    .finally(() => {
      session.sending = null;
    });
  return session.sending;
}
