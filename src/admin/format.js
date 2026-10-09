import sites from "../../shared/sites.json";

export const STATUS_LABELS = {
  new: "Новый",
  in_progress: "В работе",
  done: "Готово",
  cancelled: "Отмена",
};

export const FILTER_LABELS = {
  all: "Все",
  new: "Новые",
  in_progress: "В работе",
  done: "Готово",
  cancelled: "Отмена",
};

export function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

/** Заявка из формы «Контакты» на сайте, а не заказ из корзины. */
export function isLead(order) {
  return order.channel === "site";
}

export function channelLabel(channel) {
  if (channel === "telegram") return "Telegram";
  if (channel === "site") return "Форма на сайте";
  return "WhatsApp";
}

/** Заявка, созданная переходом из ИИ-чата в мессенджер. */
export function isChatLead(order) {
  return !!order && order.channel === "site" && order.leadSource === "chat";
}

/** Откуда заказ: канал, а для заявок из ИИ-чата — куда клиент ушёл писать. */
export function orderSourceLabel(order) {
  if (isChatLead(order)) return "ИИ-чат → " + (order.handoff === "telegram" ? "Telegram" : "WhatsApp");
  return channelLabel(order && order.channel);
}

/** Сайт заказа; у заказов, сделанных до разделения сайтов, метки нет — это основной сайт. */
export function orderSiteId(order) {
  const id = String((order && order.site) || "");
  return sites.sites[id] ? id : sites.default;
}

export function siteLabel(id) {
  return (sites.sites[id] || sites.sites[sites.default]).label;
}

export function kindLabel(kind) {
  return kind === "product" ? "Товар" : "Услуга";
}

export function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function ordersCountLabel(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return n + " заказ";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return n + " заказа";
  return n + " заказов";
}
