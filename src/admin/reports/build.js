import { ALL_CATEGORIES as CATEGORIES, getCategoryLabel, normalizeCurrency } from "../../lib/catalog.js";
import { clientKey, formatPhoneDisplay } from "../../lib/phone.js";
import { buildClientViews } from "../client-views.js";
import { STATUS_LABELS, isLead, kindLabel, orderSourceLabel, statusLabel } from "../format.js";

export const REPORT_TYPES = [
  { id: "orders", label: "Заказы", hint: "Подробный список заказов за период" },
  { id: "items", label: "Товары и услуги", hint: "Что и на какую сумму продано" },
  { id: "clients", label: "Клиенты", hint: "Сколько заказал каждый клиент" },
  { id: "periods", label: "Динамика", hint: "Заказы и выручка по дням, неделям или месяцам" },
  { id: "statuses", label: "Статусы и каналы", hint: "Распределение заказов по статусам и каналам" },
  { id: "leads", label: "Заявки с сайта", hint: "Заявки из формы «Контакты»: направления и статусы" },
];

/** Каналы заказов из корзины; заявки с формы живут в отдельном отчёте. */
export const CHANNELS = { whatsapp: "WhatsApp", telegram: "Telegram" };

const channelOf = (order) =>
  order.channel === "telegram" || order.channel === "site" ? order.channel : "whatsapp";
export const KINDS = { service: "Услуги", product: "Товары" };
export const GROUPINGS = { day: "По дням", week: "По неделям", month: "По месяцам" };

export const PERIOD_PRESETS = [
  { id: "today", label: "Сегодня" },
  { id: "7d", label: "7 дней" },
  { id: "30d", label: "30 дней" },
  { id: "month", label: "Этот месяц" },
  { id: "prev_month", label: "Прошлый месяц" },
  { id: "year", label: "Этот год" },
  { id: "all", label: "Всё время" },
];

const MONTHS = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

function pad(n) {
  return String(n).padStart(2, "0");
}

/** Дата в формате input[type=date] по локальному времени. */
export function toInputDate(date) {
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

export function presetRange(id, now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const daysAgo = (n) => new Date(y, m, now.getDate() - n);
  switch (id) {
    case "today":
      return { from: toInputDate(now), to: toInputDate(now) };
    case "7d":
      return { from: toInputDate(daysAgo(6)), to: toInputDate(now) };
    case "30d":
      return { from: toInputDate(daysAgo(29)), to: toInputDate(now) };
    case "month":
      return { from: toInputDate(new Date(y, m, 1)), to: toInputDate(now) };
    case "prev_month":
      return { from: toInputDate(new Date(y, m - 1, 1)), to: toInputDate(new Date(y, m, 0)) };
    case "year":
      return { from: toInputDate(new Date(y, 0, 1)), to: toInputDate(now) };
    default:
      return { from: "", to: "" };
  }
}

export function defaultFilters() {
  return {
    type: "orders",
    ...presetRange("30d"),
    statuses: Object.keys(STATUS_LABELS),
    channels: Object.keys(CHANNELS),
    kind: "all",
    currency: "",
    search: "",
    grouping: "day",
  };
}

function formatDay(date) {
  return pad(date.getDate()) + "." + pad(date.getMonth() + 1) + "." + date.getFullYear();
}

function parseInputDate(value, endOfDay) {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return null;
  return endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d);
}

export function currenciesOf(orders) {
  const set = new Set();
  orders.forEach((order) =>
    (order.items || []).forEach((item) => set.add(normalizeCurrency(item.currency)))
  );
  return Array.from(set);
}

/** Сумма позиции за вычетом её скидки. */
function itemAmount(item) {
  const gross = item.lineTotal != null ? Number(item.lineTotal) || 0 : (Number(item.price) || 0) * (Number(item.qty) || 1);
  return Math.max(0, gross - (Number(item.discount) || 0));
}

/**
 * Сумма заказа в отчёте. Без фильтра по типу — итог заказа (со скидкой на заказ и доставкой, как в карточке);
 * с фильтром «товары»/«услуги» — только подходящие позиции: скидку на заказ и доставку к типу не отнести.
 */
function orderAmount(order, items, filters) {
  if (filters.kind === "all" && Array.isArray(order.totals) && order.totals.length) {
    return order.totals
      .filter((bucket) => !filters.currency || normalizeCurrency(bucket.currency) === filters.currency)
      .reduce((sum, bucket) => sum + (Number(bucket.total) || 0), 0);
  }
  return items.reduce((sum, item) => sum + itemAmount(item), 0);
}

/**
 * Заказы, попавшие под фильтры. Позиции заказа урезаются до выбранного типа и валюты,
 * поэтому сумма заказа в отчёте — сумма только подходящих позиций.
 */
export function filterOrders(orders, filters) {
  const from = parseInputDate(filters.from, false);
  const to = parseInputDate(filters.to, true);
  const statuses = new Set(filters.statuses);
  const channels = new Set(filters.channels);
  const query = filters.search.trim().toLowerCase();
  const queryDigits = query.replace(/\D/g, "");

  const result = [];
  orders.forEach((order) => {
    const created = new Date(order.createdAt);
    if (Number.isNaN(created.getTime())) return;
    if (from && created < from) return;
    if (to && created > to) return;
    if (!statuses.has(order.status || "new")) return;
    if (!channels.has(channelOf(order))) return;
    if (query) {
      const name = String(order.customerName || "").toLowerCase();
      const phoneDigits = String(order.customerPhone || "").replace(/\D/g, "");
      if (!name.includes(query) && !(queryDigits && phoneDigits.includes(queryDigits))) return;
    }

    const allItems = Array.isArray(order.items) ? order.items : [];
    const items = allItems.filter(
      (item) =>
        (filters.kind === "all" || (item.kind === "product" ? "product" : "service") === filters.kind) &&
        (!filters.currency || normalizeCurrency(item.currency) === filters.currency)
    );
    if (allItems.length && !items.length) return;
    if (!allItems.length && filters.kind !== "all") return;

    const amount = orderAmount(order, items, filters);
    const qty = items.reduce((sum, item) => sum + (Number(item.qty) || 1), 0);
    result.push({ ...order, items, amount, qty, created });
  });
  return result.sort((a, b) => b.created - a.created);
}

/** Число разных клиентов; заказы без имени и телефона не считаются. */
function countClients(orders) {
  const keys = new Set();
  orders.forEach((order) => {
    const key = order.clientId || clientKey(order.customerName, order.customerPhone);
    if (key) keys.add(key);
  });
  return keys.size;
}

function sumBy(list, key) {
  return list.reduce((sum, row) => sum + (Number(row[key]) || 0), 0);
}

function revenueOf(orders) {
  return orders.filter((order) => (order.status || "new") !== "cancelled").reduce((s, o) => s + o.amount, 0);
}

function buildOrdersReport(orders) {
  const columns = [
    { key: "date", label: "Дата", type: "date", width: 16 },
    { key: "client", label: "Клиент", type: "text", width: 22 },
    { key: "phone", label: "Телефон", type: "text", width: 18 },
    { key: "channel", label: "Канал", type: "text", width: 11 },
    { key: "status", label: "Статус", type: "text", width: 11 },
    { key: "items", label: "Состав", type: "text", width: 40, wrap: true },
    { key: "qty", label: "Кол-во", type: "number", width: 9 },
    { key: "amount", label: "Сумма", type: "money", width: 14 },
  ];
  const rows = orders.map((order) => ({
    date: order.created,
    client: order.customerName || "Без имени",
    phone: order.customerPhone ? formatPhoneDisplay(order.customerPhone) : "—",
    channel: orderSourceLabel(order),
    status: statusLabel(order.status || "new"),
    items: order.items.map((item) => (item.title || "Позиция") + " × " + (item.qty || 1)).join(", ") || "—",
    qty: order.qty,
    amount: order.amount,
  }));
  return {
    columns,
    rows,
    totals: { date: "Итого", qty: sumBy(rows, "qty"), amount: sumBy(rows, "amount") },
  };
}

function buildItemsReport(orders, products) {
  const productById = new Map(products.map((p) => [p.id, p]));
  const groups = new Map();
  orders.forEach((order) => {
    const cancelled = (order.status || "new") === "cancelled";
    order.items.forEach((item) => {
      const key = item.id || item.title || "—";
      if (!groups.has(key)) {
        const product = productById.get(item.id);
        groups.set(key, {
          title: item.title || (product && product.title) || "Позиция",
          kind: kindLabel(item.kind === "product" ? "product" : "service"),
          category: product ? getCategoryLabel(product.category) : "—",
          orderIds: new Set(),
          qty: 0,
          amount: 0,
          cancelled: 0,
        });
      }
      const group = groups.get(key);
      group.orderIds.add(order.id);
      if (cancelled) {
        group.cancelled += Number(item.qty) || 1;
        return;
      }
      group.qty += Number(item.qty) || 1;
      group.amount += itemAmount(item);
    });
  });

  const rows = Array.from(groups.values())
    .map(({ orderIds, ...rest }) => ({
      ...rest,
      orders: orderIds.size,
      avg: rest.qty ? Math.round(rest.amount / rest.qty) : 0,
    }))
    .sort((a, b) => b.amount - a.amount);
  const total = sumBy(rows, "amount");
  rows.forEach((row) => (row.share = total ? row.amount / total : 0));

  return {
    columns: [
      { key: "title", label: "Позиция", type: "text", width: 30, wrap: true },
      { key: "kind", label: "Тип", type: "text", width: 10 },
      { key: "category", label: "Категория", type: "text", width: 24 },
      { key: "orders", label: "Заказов", type: "number", width: 10 },
      { key: "qty", label: "Продано, шт.", type: "number", width: 12 },
      { key: "cancelled", label: "Отменено, шт.", type: "number", width: 13 },
      { key: "avg", label: "Средняя цена", type: "money", width: 14 },
      { key: "amount", label: "Выручка", type: "money", width: 14 },
      { key: "share", label: "Доля", type: "percent", width: 9 },
    ],
    rows,
    totals: {
      title: "Итого",
      qty: sumBy(rows, "qty"),
      cancelled: sumBy(rows, "cancelled"),
      amount: total,
      share: total ? 1 : 0,
    },
  };
}

function buildClientsReport(orders, clients) {
  const views = buildClientViews(clients, orders).filter((view) => view.orders.length);
  const rows = views
    .map((view) => {
      const sorted = view.orders.slice().sort((a, b) => a.created - b.created);
      const active = view.orders.filter((o) => (o.status || "new") !== "cancelled");
      const amount = active.reduce((s, o) => s + o.amount, 0);
      return {
        client: view.name || "Без имени",
        phone: view.phone ? formatPhoneDisplay(view.phone) : "—",
        orders: view.orders.length,
        done: view.orders.filter((o) => o.status === "done").length,
        cancelled: view.orders.length - active.length,
        amount,
        avg: active.length ? Math.round(amount / active.length) : 0,
        first: sorted[0].created,
        last: sorted[sorted.length - 1].created,
      };
    })
    .sort((a, b) => b.amount - a.amount || b.orders - a.orders);

  return {
    columns: [
      { key: "client", label: "Клиент", type: "text", width: 24 },
      { key: "phone", label: "Телефон", type: "text", width: 18 },
      { key: "orders", label: "Заказов", type: "number", width: 10 },
      { key: "done", label: "Готово", type: "number", width: 9 },
      { key: "cancelled", label: "Отмена", type: "number", width: 9 },
      { key: "avg", label: "Средний чек", type: "money", width: 14 },
      { key: "amount", label: "Сумма", type: "money", width: 14 },
      { key: "first", label: "Первый заказ", type: "date", width: 16 },
      { key: "last", label: "Последний заказ", type: "date", width: 16 },
    ],
    rows,
    totals: {
      client: "Итого",
      orders: sumBy(rows, "orders"),
      done: sumBy(rows, "done"),
      cancelled: sumBy(rows, "cancelled"),
      amount: sumBy(rows, "amount"),
    },
  };
}

function periodKey(date, grouping) {
  if (grouping === "month") {
    return {
      key: date.getFullYear() + "-" + pad(date.getMonth() + 1),
      label: MONTHS[date.getMonth()] + " " + date.getFullYear(),
    };
  }
  if (grouping === "week") {
    const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7));
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    return { key: toInputDate(monday), label: formatDay(monday) + " – " + formatDay(sunday) };
  }
  return { key: toInputDate(date), label: formatDay(date) };
}

function buildPeriodsReport(orders, grouping) {
  const groups = new Map();
  orders.forEach((order) => {
    const { key, label } = periodKey(order.created, grouping);
    if (!groups.has(key)) groups.set(key, { key, period: label, list: [] });
    groups.get(key).list.push(order);
  });
  const rows = Array.from(groups.values())
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ period, list }) => {
      const active = list.filter((o) => (o.status || "new") !== "cancelled");
      const amount = revenueOf(list);
      return {
        period,
        orders: list.length,
        new: list.filter((o) => (o.status || "new") === "new").length,
        in_progress: list.filter((o) => o.status === "in_progress").length,
        done: list.filter((o) => o.status === "done").length,
        cancelled: list.length - active.length,
        clients: countClients(list),
        amount,
        avg: active.length ? Math.round(amount / active.length) : 0,
      };
    });
  const activeCount = sumBy(rows, "orders") - sumBy(rows, "cancelled");
  const amount = sumBy(rows, "amount");

  return {
    columns: [
      { key: "period", label: "Период", type: "text", width: 24 },
      { key: "orders", label: "Заказов", type: "number", width: 10 },
      { key: "new", label: "Новые", type: "number", width: 9 },
      { key: "in_progress", label: "В работе", type: "number", width: 10 },
      { key: "done", label: "Готово", type: "number", width: 9 },
      { key: "cancelled", label: "Отмена", type: "number", width: 9 },
      { key: "clients", label: "Клиентов", type: "number", width: 10 },
      { key: "avg", label: "Средний чек", type: "money", width: 14 },
      { key: "amount", label: "Выручка", type: "money", width: 14 },
    ],
    rows,
    totals: {
      period: "Итого",
      orders: sumBy(rows, "orders"),
      new: sumBy(rows, "new"),
      in_progress: sumBy(rows, "in_progress"),
      done: sumBy(rows, "done"),
      cancelled: sumBy(rows, "cancelled"),
      amount,
      avg: activeCount ? Math.round(amount / activeCount) : 0,
    },
  };
}

function buildStatusesReport(orders) {
  const total = orders.length;
  const rows = [];
  const add = (group, label, list) => {
    rows.push({
      group,
      name: label,
      orders: list.length,
      share: total ? list.length / total : 0,
      amount: list.reduce((s, o) => s + o.amount, 0),
    });
  };
  Object.keys(STATUS_LABELS).forEach((status) =>
    add("Статус", STATUS_LABELS[status], orders.filter((o) => (o.status || "new") === status))
  );
  Object.keys(CHANNELS).forEach((channel) =>
    add(
      "Канал",
      CHANNELS[channel],
      orders.filter((o) => channelOf(o) === channel)
    )
  );
  return {
    columns: [
      { key: "group", label: "Разрез", type: "text", width: 12 },
      { key: "name", label: "Значение", type: "text", width: 18 },
      { key: "orders", label: "Заказов", type: "number", width: 10 },
      { key: "share", label: "Доля", type: "percent", width: 9 },
      { key: "amount", label: "Сумма заказов", type: "money", width: 16 },
    ],
    rows,
    totals: null,
  };
}

const NO_DIRECTION = "Не указано";

/** Направление заявки; старые заявки без поля lead — по названию позиции «Заявка: …». */
function leadDirection(order) {
  const id = order.lead && order.lead.direction;
  if (id && CATEGORIES.some((category) => category.id === id)) return getCategoryLabel(id);
  const title = String((order.items && order.items[0] && order.items[0].title) || "");
  const match = title.match(/^Заявка:\s*(.+)$/);
  return match ? match[1] : NO_DIRECTION;
}

function leadComment(order) {
  if (order.lead) return order.lead.comment || "";
  const line = String(order.message || "")
    .split("\n")
    .find((row) => row.startsWith("Комментарий:"));
  return line ? line.replace(/^Комментарий:\s*/, "") : "";
}

function buildLeadsReport(leads) {
  const rows = leads.map((order) => ({
    date: order.created,
    client: order.customerName || "Без имени",
    phone: order.customerPhone ? formatPhoneDisplay(order.customerPhone) : "—",
    direction: leadDirection(order),
    comment: leadComment(order) || "—",
    status: statusLabel(order.status || "new"),
    page: order.sourcePage || "—",
  }));
  return {
    columns: [
      { key: "date", label: "Дата", type: "date", width: 16 },
      { key: "client", label: "Имя", type: "text", width: 20 },
      { key: "phone", label: "Телефон", type: "text", width: 18 },
      { key: "direction", label: "Направление", type: "text", width: 22 },
      { key: "comment", label: "Комментарий", type: "text", width: 40, wrap: true },
      { key: "status", label: "Статус", type: "text", width: 11 },
      { key: "page", label: "Страница", type: "text", width: 16 },
    ],
    rows,
    totals: null,
  };
}

function leadsSummary(leads) {
  const count = (status) => leads.filter((order) => (order.status || "new") === status).length;
  const byDirection = new Map();
  leads.forEach((order) => {
    const direction = leadDirection(order);
    byDirection.set(direction, (byDirection.get(direction) || 0) + 1);
  });
  const top = Array.from(byDirection.entries())
    .filter(([name]) => name !== NO_DIRECTION)
    .sort((a, b) => b[1] - a[1])[0];
  return [
    { label: "Заявок", value: leads.length, type: "number" },
    { label: "Новые", value: count("new"), type: "number" },
    { label: "В работе", value: count("in_progress"), type: "number" },
    { label: "Готово", value: leads.length ? count("done") / leads.length : 0, type: "percent" },
    { label: "Популярное направление", value: top ? top[0] + " · " + top[1] : "—", type: "text" },
  ];
}

function describeFilters(filters) {
  const parts = [];
  if (filters.from || filters.to) {
    const from = parseInputDate(filters.from, false);
    const to = parseInputDate(filters.to, false);
    parts.push("Период: " + (from ? formatDay(from) : "…") + " – " + (to ? formatDay(to) : "…"));
  } else {
    parts.push("Период: всё время");
  }
  const allStatuses = Object.keys(STATUS_LABELS);
  if (filters.statuses.length !== allStatuses.length) {
    parts.push("Статусы: " + filters.statuses.map(statusLabel).join(", "));
  }
  if (filters.type !== "leads" && filters.channels.length !== Object.keys(CHANNELS).length) {
    parts.push("Каналы: " + filters.channels.map((c) => CHANNELS[c]).join(", "));
  }
  if (filters.type !== "leads" && filters.kind !== "all") parts.push("Тип: " + KINDS[filters.kind]);
  if (filters.currency) parts.push("Валюта: " + filters.currency);
  if (filters.search.trim()) parts.push("Клиент: «" + filters.search.trim() + "»");
  if (filters.type === "periods") parts.push("Группировка: " + GROUPINGS[filters.grouping].toLowerCase());
  return parts;
}

/**
 * Готовый отчёт: колонки, строки, итоги и сводка — общий формат для таблицы и экспорта.
 */
export function buildReport({ orders, clients, products, filters }) {
  const type = REPORT_TYPES.find((item) => item.id === filters.type) || REPORT_TYPES[0];
  if (type.id === "leads") {
    const leadFilters = { ...filters, channels: ["site"], kind: "all", currency: "" };
    const leads = filterOrders(orders.filter(isLead), leadFilters);
    return {
      type: type.id,
      title: "Отчёт: заявки с сайта",
      filtersText: describeFilters(leadFilters),
      currency: "KZT",
      generatedAt: new Date(),
      summary: leadsSummary(leads),
      ...buildLeadsReport(leads),
    };
  }

  const shopOrders = orders.filter((order) => !isLead(order));
  const currencies = currenciesOf(shopOrders);
  const currency = filters.currency || currencies[0] || "KZT";
  // При нескольких валютах суммы считаем только в одной, иначе они бессмысленно складываются.
  const effective = { ...filters, currency: currencies.length > 1 ? currency : "" };
  const filtered = filterOrders(shopOrders, effective);

  let body;
  if (type.id === "items") body = buildItemsReport(filtered, products);
  else if (type.id === "clients") body = buildClientsReport(filtered, clients);
  else if (type.id === "periods") body = buildPeriodsReport(filtered, filters.grouping);
  else if (type.id === "statuses") body = buildStatusesReport(filtered);
  else body = buildOrdersReport(filtered);

  const active = filtered.filter((o) => (o.status || "new") !== "cancelled");
  const revenue = revenueOf(filtered);
  const summary = [
    { label: "Заказов", value: filtered.length, type: "number" },
    { label: "Выручка (без отмен)", value: revenue, type: "money" },
    { label: "Средний чек", value: active.length ? Math.round(revenue / active.length) : 0, type: "money" },
    { label: "Клиентов", value: countClients(filtered), type: "number" },
  ];

  return {
    type: type.id,
    title: "Отчёт: " + type.label.toLowerCase(),
    filtersText: describeFilters(effective),
    currency,
    generatedAt: new Date(),
    summary,
    ...body,
  };
}
