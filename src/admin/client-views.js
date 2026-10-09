import { formatPrice, normalizeCurrency } from "../lib/catalog.js";
import { getClientWhatsAppUrl, whatsappUrl } from "../lib/messages.js";
import { clientKey, normalizePhone } from "../lib/phone.js";

/**
 * Карточки клиентов для CRM: сохранённые клиенты + клиенты, «собранные» из заказов
 * по телефону/имени. Заказы без контакта уходят в карточку «Без контакта».
 */
export function buildClientViews(clients, orders) {
  const views = new Map();
  const byClientId = new Map();

  function ensure(key, seed) {
    if (!views.has(key)) {
      views.set(key, {
        key,
        id: seed.id || key,
        name: seed.name || "",
        phone: seed.phone || "",
        note: seed.note || "",
        stored: !!seed.stored,
        requisites: seed.requisites || null,
        source: seed.source || "order",
        createdAt: seed.createdAt || "",
        updatedAt: seed.updatedAt || "",
        orders: [],
      });
    }
    const view = views.get(key);
    if (seed.name && !view.name) view.name = seed.name;
    if (seed.phone && !view.phone) view.phone = seed.phone;
    if (seed.note) view.note = seed.note;
    if (seed.stored) {
      view.stored = true;
      view.id = seed.id;
      view.requisites = seed.requisites || null;
    }
    if (seed.id && !view.stored) view.id = seed.id;
    return view;
  }

  clients.forEach((client) => {
    const key = clientKey(client.name, client.phone) || "id:" + client.id;
    const view = ensure(key, {
      id: client.id,
      name: client.name,
      phone: client.phone,
      note: client.note,
      requisites: client.requisites,
      stored: true,
      source: client.source || "manual",
      createdAt: client.createdAt,
      updatedAt: client.updatedAt,
    });
    byClientId.set(client.id, view);
  });

  const guests = [];
  orders.forEach((order) => {
    if (order.clientId && byClientId.has(order.clientId)) {
      const view = byClientId.get(order.clientId);
      view.orders.push(order);
      if (!view.name && order.customerName) view.name = order.customerName;
      if (!view.phone && order.customerPhone) view.phone = order.customerPhone;
      return;
    }

    const key = clientKey(order.customerName, order.customerPhone);
    if (!key) {
      guests.push(order);
      return;
    }
    const view = ensure(key, {
      id: order.clientId || undefined,
      name: order.customerName,
      phone: order.customerPhone,
      source: "order",
    });
    view.orders.push(order);
    if (order.clientId) byClientId.set(order.clientId, view);
  });

  if (guests.length) {
    const view = ensure("guest", { id: "guest", name: "Без контакта", phone: "", source: "order" });
    view.orders.push(...guests);
  }

  const byCreatedDesc = (a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  views.forEach((view) => view.orders.sort(byCreatedDesc));

  const lastActivity = (v) => (v.orders.length ? v.orders[0].createdAt : v.updatedAt || v.createdAt || "");
  return Array.from(views.values()).sort((a, b) => String(lastActivity(b)).localeCompare(String(lastActivity(a))));
}

export function filterClientViews(views, search) {
  const query = search.trim().toLowerCase();
  if (!query) return views;
  const queryDigits = query.replace(/\D/g, "");
  return views.filter((client) => {
    const name = String(client.name || "").toLowerCase();
    const phone = String(client.phone || "");
    const note = String(client.note || "").toLowerCase();
    return (
      name.includes(query) ||
      phone.toLowerCase().includes(query) ||
      note.includes(query) ||
      (queryDigits && normalizePhone(phone).includes(queryDigits))
    );
  });
}

/** Сумма заказов клиента по валютам — по итогам заказов (со скидками и доставкой), как в их карточках. */
export function clientTotalText(orders) {
  const sums = new Map();
  const add = (currency, amount) => {
    const code = normalizeCurrency(currency);
    sums.set(code, (sums.get(code) || 0) + (Number(amount) || 0));
  };
  (orders || []).forEach((order) => {
    if (Array.isArray(order.totals)) {
      order.totals.forEach((bucket) => add(bucket.currency, bucket.total));
      return;
    }
    (order.items || []).forEach((item) => {
      if (item.lineTotal != null) add(item.currency, Number(item.lineTotal) - (Number(item.discount) || 0));
    });
  });
  if (!sums.size) return "—";
  return Array.from(sums, ([code, sum]) => formatPrice(sum, code)).join(" + ");
}

export function getClientCardWhatsAppUrl(client) {
  const phone = normalizePhone(client.phone);
  if (!phone) return "";
  if (client.orders && client.orders.length) {
    return getClientWhatsAppUrl({ ...client.orders[0], customerName: client.name, customerPhone: client.phone });
  }
  const name = String(client.name || "").trim();
  const text =
    (name ? "Здравствуйте, " + name + "!" : "Здравствуйте!") +
    "\n\nПишу вам из ИП «Базис». Готова обсудить ваш запрос и следующие шаги.";
  return whatsappUrl(text, phone);
}

/** id клиента для формы редактирования (сохранённый или привязанный к заказу). */
export function editableClientId(client) {
  if (client.stored) return client.id;
  const linked = (client.orders || []).find((order) => order.clientId);
  if (linked) return linked.clientId;
  if (client.id && client.id !== "guest" && String(client.id).startsWith("cli_")) return client.id;
  return "";
}
