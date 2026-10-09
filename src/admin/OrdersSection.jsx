import { useCallback, useEffect, useRef, useState } from "react";
import { formatPrice } from "../lib/catalog.js";
import { getClientWhatsAppUrl } from "../lib/messages.js";
import { ORDER_STATUSES, listOrdersPage, removeOrder, updateOrderStatus } from "../lib/orders-db.js";
import { formatPhoneDisplay } from "../lib/phone.js";
import { downloadLeadPdf } from "./documents-api.js";
import { FILTER_LABELS, formatDate, isChatLead, orderSiteId, orderSourceLabel, siteLabel, statusLabel } from "./format.js";
import OrderDocuments from "./OrderDocuments.jsx";
import RefreshButton from "./RefreshButton.jsx";
import { confirmAction, notify } from "./dialogs.jsx";

export function WhatsAppButton({ url }) {
  return url ? (
    <a className="dash-btn crm-btn-wa" href={url} target="_blank" rel="noopener noreferrer">
      WhatsApp
    </a>
  ) : (
    <span className="dash-btn crm-btn-wa is-disabled" title="Нет телефона клиента">
      WhatsApp
    </span>
  );
}

/** Разбивка итога, если админ добавил скидки или доставку; итог по валютам — в подвале карточки. */
function OrderTotalsBreakdown({ totals }) {
  const rows = [];
  for (const bucket of totals) {
    const money = (value) => formatPrice(value, bucket.currency);
    if (!(bucket.itemsDiscount || bucket.orderDiscount || bucket.delivery)) continue;
    rows.push(["Сумма позиций", money(bucket.subtotal), bucket.currency + "-sub"]);
    if (bucket.itemsDiscount) rows.push(["Скидки на позиции", "−" + money(bucket.itemsDiscount), bucket.currency + "-items"]);
    if (bucket.orderDiscount) rows.push(["Скидка на заказ", "−" + money(bucket.orderDiscount), bucket.currency + "-order"]);
    if (bucket.delivery) rows.push(["Доставка", "+" + money(bucket.delivery), bucket.currency + "-delivery"]);
  }
  if (!rows.length) return null;
  return (
    <dl className="crm-order-breakdown">
      {rows.map(([label, value, key]) => (
        <div key={key}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function orderTotalLabel(order) {
  const totals = Array.isArray(order.totals) ? order.totals : null;
  if (!totals || !totals.length) return order.totalText || "—";
  return totals.map((bucket) => formatPrice(bucket.total, bucket.currency)).join(" + ");
}

function OrderCard({ order, onReload, onOpenCompany }) {
  const [pending, setPending] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);
  const items = Array.isArray(order.items) ? order.items : [];
  const status = order.status || "new";
  const isLead = order.channel === "site";
  const fromChat = isChatLead(order);
  const siteId = orderSiteId(order);

  const changeStatus = async (next) => {
    setPending(true);
    try {
      await updateOrderStatus(order.id, next);
    } catch (err) {
      if (err && err.code === "unauthorized") return;
      console.warn(err);
      notify(
        err && err.code === "out_of_stock"
          ? "Нельзя вернуть заказ из отмены: " + (err.message || "товара недостаточно на складе") +
              ". Пополните остаток в разделе «Товары» и попробуйте снова."
          : "Не удалось изменить статус заказа. Проверьте сервер и попробуйте ещё раз."
      );
    } finally {
      setPending(false);
    }
    await onReload();
  };

  const leadPdf = async () => {
    setPending(true);
    try {
      await downloadLeadPdf(order.id);
    } catch (err) {
      if (err && err.code !== "unauthorized") notify(err.message || "Не удалось сформировать PDF.");
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    const what = isLead ? "заявку" : "заказ";
    const ok = await confirmAction(
      `Удалить ${what} ${order.customerName ? "«" + order.customerName + "» " : ""}из CRM? Это действие нельзя отменить.`,
      { title: isLead ? "Удаление заявки" : "Удаление заказа", confirmLabel: "Удалить", danger: true }
    );
    if (!ok) return;
    setPending(true);
    try {
      await removeOrder(order.id);
      await onReload();
    } catch (err) {
      if (err && err.code === "unauthorized") return;
      notify(`Не удалось удалить ${what}. Проверьте сервер и попробуйте ещё раз.`);
    } finally {
      setPending(false);
    }
  };

  return (
    <article className={"crm-card crm-order" + (docsOpen ? " is-expanded" : "")}>
      <header className="crm-card-head">
        <div className="crm-card-who">
          <h3>{order.customerName || (fromChat ? "Посетитель ИИ-чата" : "Без имени")}</h3>
          {order.customerPhone ? (
            <p className="crm-card-phone">{formatPhoneDisplay(order.customerPhone)}</p>
          ) : (
            <p className="crm-muted">
              {fromChat ? "Телефон придёт в мессенджере — впишите его в карточку клиента" : "Телефон не указан"}
            </p>
          )}
          {fromChat && order.chatCode ? <p className="crm-muted">Обращение № {order.chatCode}</p> : null}
        </div>
        <div className="crm-card-meta">
          <span className={"crm-chip crm-chip-site-" + siteId} title="С какого сайта пришёл заказ">
            {siteLabel(siteId)}
          </span>
          <span className={"crm-chip crm-chip-" + (order.channel || "whatsapp")}>{orderSourceLabel(order)}</span>
          <span className={"crm-chip crm-chip-" + status}>{statusLabel(status)}</span>
        </div>
      </header>
      <p className="crm-card-date">{formatDate(order.createdAt)}</p>
      {items.length ? (
        <ul className="crm-order-items">
          {items.map((item, i) => (
            <li key={item.id || i}>
              <span className="crm-item-title">{item.title || "Позиция"}</span>
              <span className="crm-item-side">
                {"× " + (item.qty || 1)}
                {item.lineTotal != null && !isLead && " · " + formatPrice(item.lineTotal, item.currency)}
                {!isLead && Number(item.discount) > 0 && (
                  <span className="crm-item-discount">{" · скидка −" + formatPrice(item.discount, item.currency)}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="crm-muted">Состав заказа пуст</p>
      )}
      {isLead && (order.lead?.comment || (!order.lead && order.message)) ? (
        <p className="crm-order-note">{order.lead ? order.lead.comment : order.message}</p>
      ) : null}
      {fromChat && order.message ? (
        <details className="crm-chat-transcript">
          <summary>Переписка с ИИ-консультантом</summary>
          <p className="crm-order-note">{order.message}</p>
        </details>
      ) : null}
      {isLead && order.sourcePage ? <p className="crm-muted">Страница: {order.sourcePage}</p> : null}
      {!isLead && Array.isArray(order.totals) ? <OrderTotalsBreakdown totals={order.totals} /> : null}
      <footer className="crm-card-foot">
        <p className="crm-order-total">{isLead ? order.totalText || "—" : orderTotalLabel(order)}</p>
        <div className="crm-card-actions">
          <label className="crm-status">
            <span className="visually-hidden">Статус</span>
            <select
              aria-label="Статус заказа"
              value={status}
              disabled={pending}
              onChange={(event) => changeStatus(event.target.value)}
            >
              {ORDER_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {statusLabel(value)}
                </option>
              ))}
            </select>
          </label>
          <WhatsAppButton url={getClientWhatsAppUrl(order)} />
          {isLead ? (
            <button type="button" className="dash-btn" disabled={pending} onClick={leadPdf}>
              PDF
            </button>
          ) : (
            <button
              type="button"
              className={"dash-btn" + (docsOpen ? " is-active" : "")}
              aria-expanded={docsOpen}
              onClick={() => setDocsOpen((value) => !value)}
            >
              Документы
            </button>
          )}
          <button type="button" className="dash-btn crm-btn-danger" disabled={pending} onClick={remove}>
            Удалить
          </button>
        </div>
      </footer>
      {docsOpen && !isLead && <OrderDocuments order={order} onOrderChanged={onReload} onOpenCompany={onOpenCompany} />}
    </article>
  );
}

const TEXTS = {
  orders: {
    id: "crm-section",
    title: "Заказы",
    hint: "Заказы появляются при оформлении корзины в WhatsApp или Telegram.",
    filterLabel: "Фильтр заказов",
    loadError: "Не удалось загрузить заказы. Проверьте сервер и нажмите «Обновить».",
    empty: "Пока нет заказов с этим фильтром.",
  },
  leads: {
    id: "leads-section",
    title: "Заявки",
    hint: "Заявки из формы в разделе «Контакты» на сайте. Отчёт по ним — во вкладке «Отчёты» → «Заявки с сайта».",
    filterLabel: "Фильтр заявок",
    loadError: "Не удалось загрузить заявки. Проверьте сервер и нажмите «Обновить».",
    empty: "Пока нет заявок с этим фильтром.",
  },
};

const PAGE_SIZE = 50;
/** Больше сервер за один запрос не отдаёт. */
const SERVER_PAGE_MAX = 200;
const EMPTY_COUNTS = { all: 0, new: 0, in_progress: 0, done: 0, cancelled: 0 };
const SEARCH_DELAY_MS = 350;

/** Дата из поля «с»/«по» (ГГГГ-ММ-ДД, местное время) → граница периода в ISO; «по» включает весь день. */
function dayBoundary(value, endOfDay) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day + (endOfDay ? 1 : 0));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Значение, которое обновляется только после паузы во вводе. */
function useDebounced(value, delay) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Заказы или заявки страницами по PAGE_SIZE: фильтр по статусу и счётчики считает сервер. */
export default function OrdersSection({ variant = "orders", onChanged, onOpenCompany }) {
  const text = TEXTS[variant] || TEXTS.orders;
  const kind = variant === "leads" ? "leads" : "orders";
  const [filter, setFilter] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const search = useDebounced(searchInput.trim(), SEARCH_DELAY_MS);
  const from = dayBoundary(dateFrom, false);
  const to = dayBoundary(dateTo, true);
  const searching = Boolean(search || from || to);
  const [list, setList] = useState([]);
  const [counts, setCounts] = useState(EMPTY_COUNTS);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const requestRef = useRef(0);

  /** Первая страница (или столько, сколько уже открыто, — чтобы после правки список не схлопывался). */
  const load = useCallback(
    async (size = PAGE_SIZE) => {
      const requestId = ++requestRef.current;
      const want = Math.max(PAGE_SIZE, size);
      try {
        let items = [];
        let next = null;
        let pageCounts = {};
        do {
          const page = await listOrdersPage({
            kind,
            status: filter,
            cursor: next,
            limit: Math.min(SERVER_PAGE_MAX, want - items.length),
            q: search,
            from,
            to,
          });
          if (requestId !== requestRef.current) return;
          items = items.concat(page.items);
          next = page.nextCursor;
          pageCounts = page.counts;
        } while (next && items.length < want);
        setList(items);
        setCursor(next);
        setCounts({ ...EMPTY_COUNTS, ...pageCounts });
        setLoadError(false);
      } catch (err) {
        if (requestId !== requestRef.current || (err && err.code === "unauthorized")) return;
        console.warn(err);
        setLoadError(true);
      } finally {
        if (requestId === requestRef.current) setLoading(false);
      }
    },
    [kind, filter, search, from, to]
  );

  useEffect(() => {
    setLoading(true);
    setLoadError(false);
    setList([]);
    load();
  }, [load]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    const requestId = requestRef.current;
    setLoadingMore(true);
    try {
      const page = await listOrdersPage({ kind, status: filter, cursor, limit: PAGE_SIZE, q: search, from, to });
      if (requestId !== requestRef.current) return;
      setList((prev) => {
        const seen = new Set(prev.map((order) => order.id));
        return [...prev, ...page.items.filter((order) => !seen.has(order.id))];
      });
      setCursor(page.nextCursor);
      setCounts({ ...EMPTY_COUNTS, ...page.counts });
    } catch (err) {
      if (err && err.code === "unauthorized") return;
      console.warn(err);
      notify("Не удалось загрузить следующие записи. Нажмите «Обновить».");
    } finally {
      setLoadingMore(false);
    }
  };

  const reload = async () => {
    await load(list.length);
    if (onChanged) onChanged();
  };

  let content;
  if (loadError) {
    content = <p className="crm-empty">{text.loadError}</p>;
  } else if (loading) {
    content = <p className="crm-empty">Загружаем…</p>;
  } else if (!list.length) {
    content = (
      <p className="crm-empty">
        {searching
          ? from && to && from >= to
            ? "Дата «с» позже даты «по» — проверьте период."
            : "Ничего не найдено. Измените запрос или период."
          : text.empty}
      </p>
    );
  } else {
    content = list.map((order) => <OrderCard key={order.id} order={order} onReload={reload} onOpenCompany={onOpenCompany} />);
  }

  return (
    <section id={text.id} className="dash-card dash-card-full">
      <div className="crm-toolbar">
        <div>
          <h2>
            {text.title} · {counts.all}
          </h2>
          <p className="admin-hint">{text.hint}</p>
        </div>
        <RefreshButton onRefresh={reload} />
      </div>
      <div className="crm-filters" role="tablist" aria-label={text.filterLabel}>
        {Object.keys(FILTER_LABELS).map((key) => (
          <button
            key={key}
            type="button"
            className={"crm-filter" + (filter === key ? " is-active" : "")}
            onClick={() => setFilter(key)}
          >
            {FILTER_LABELS[key]} · {counts[key] || 0}
          </button>
        ))}
      </div>
      <div className="crm-order-search" role="search">
        <label className="crm-search">
          <span className="visually-hidden">{kind === "leads" ? "Поиск заявок" : "Поиск заказов"}</span>
          <input
            type="search"
            placeholder="Имя, телефон или № обращения"
            autoComplete="off"
            maxLength={100}
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </label>
        <label className="crm-date">
          <span>с</span>
          <input
            type="date"
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(event) => setDateFrom(event.target.value)}
          />
        </label>
        <label className="crm-date">
          <span>по</span>
          <input
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(event) => setDateTo(event.target.value)}
          />
        </label>
        {searching || searchInput ? (
          <button
            type="button"
            className="dash-btn"
            onClick={() => {
              setSearchInput("");
              setDateFrom("");
              setDateTo("");
            }}
          >
            Сбросить
          </button>
        ) : null}
      </div>
      <div className="crm-orders">{content}</div>
      {!loadError && !loading && cursor && (
        <div className="crm-more">
          <button type="button" className="dash-btn" disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? "Загружаем…" : `Показать ещё (показано ${list.length} из ${counts[filter] ?? counts.all})`}
          </button>
        </div>
      )}
    </section>
  );
}
