import { useMemo, useState } from "react";
import { removeClient } from "../lib/orders-db.js";
import { formatPhoneDisplay } from "../lib/phone.js";
import {
  buildClientViews,
  clientTotalText,
  filterClientViews,
  getClientCardWhatsAppUrl,
} from "./client-views.js";
import { confirmAction, notify } from "./dialogs.jsx";
import { formatDate, ordersCountLabel, statusLabel } from "./format.js";
import { WhatsAppButton } from "./OrdersSection.jsx";
import RefreshButton from "./RefreshButton.jsx";

function ClientCard({ client, expanded, onToggle, onEdit, onDelete }) {
  const isGuest = client.key === "guest";
  const lastDate = client.orders.length
    ? formatDate(client.orders[0].createdAt)
    : formatDate(client.updatedAt || client.createdAt);
  const canDelete = client.stored && !isGuest && !client.orders.length;

  return (
    <article className={"crm-card crm-client" + (isGuest ? " is-guest" : "")}>
      <header className="crm-card-head">
        <div className="crm-card-who">
          <h3>{client.name || "Без имени"}</h3>
          {client.phone ? (
            <p className="crm-card-phone">{formatPhoneDisplay(client.phone)}</p>
          ) : (
            <p className="crm-muted">Телефон не указан</p>
          )}
        </div>
        <div className="crm-card-meta">
          <span className="crm-chip">{ordersCountLabel(client.orders.length)}</span>
        </div>
      </header>
      <div className="crm-stats">
        <span>
          Сумма <strong>{clientTotalText(client.orders)}</strong>
        </span>
        {lastDate && <span>Последний контакт {lastDate}</span>}
      </div>
      {client.note && <p className="crm-client-note">{client.note}</p>}
      <div className="crm-card-actions">
        <WhatsAppButton url={isGuest ? "" : getClientCardWhatsAppUrl(client)} />
        {client.orders.length > 0 && (
          <button type="button" className="dash-btn" onClick={onToggle}>
            {expanded ? "Скрыть" : "Заказы"}
          </button>
        )}
        {!isGuest && (
          <button type="button" className="dash-btn" onClick={onEdit}>
            Изменить
          </button>
        )}
        {canDelete && (
          <button type="button" className="dash-btn crm-btn-danger" onClick={onDelete}>
            Удалить
          </button>
        )}
      </div>
      {expanded && client.orders.length > 0 && (
        <div className="crm-client-orders">
          {client.orders.map((order) => {
            const items = Array.isArray(order.items) ? order.items : [];
            const titles = items.map((item) => (item.title || "Позиция") + " × " + (item.qty || 1)).join(", ");
            const status = order.status || "new";
            return (
              <div className="crm-client-order" key={order.id}>
                <div className="crm-client-order-top">
                  <span className={"crm-chip crm-chip-" + status}>{statusLabel(status)}</span>
                  <span className="crm-card-date">{formatDate(order.createdAt)}</span>
                </div>
                <p>{titles || "Состав заказа пуст"}</p>
                <p className="crm-client-order-sum">{order.totalText || "—"}</p>
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}

export default function ClientsSection({ clients, orders, onRefresh, onEdit }) {
  const [search, setSearch] = useState("");
  const [expandedKey, setExpandedKey] = useState("");

  const views = useMemo(() => buildClientViews(clients, orders), [clients, orders]);
  const list = useMemo(() => filterClientViews(views, search), [views, search]);

  const onDelete = async (client) => {
    const ok = await confirmAction(
      `Удалить карточку клиента${client.name ? " «" + client.name + "»" : ""}? Заказы и заявки останутся в CRM.`,
      { title: "Удаление клиента", confirmLabel: "Удалить", danger: true }
    );
    if (!ok) return;
    try {
      await removeClient(client.id);
    } catch (err) {
      if (err && err.code === "unauthorized") return;
      notify("Не удалось удалить клиента. Проверьте сервер и попробуйте ещё раз.");
    }
    await onRefresh();
  };

  return (
    <section id="clients-section" className="dash-card dash-card-full">
      <div className="crm-toolbar">
        <div>
          <h2>Клиенты · {list.length}</h2>
          <p className="admin-hint">Контакты собираются из заказов. Можно добавить клиента вручную.</p>
        </div>
        <RefreshButton onRefresh={onRefresh} />
      </div>
      <label className="crm-search">
        <span className="visually-hidden">Поиск клиентов</span>
        <input
          type="search"
          placeholder="Имя или телефон"
          autoComplete="off"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <div className="crm-clients">
        {list.length ? (
          list.map((client) => (
            <ClientCard
              key={client.key}
              client={client}
              expanded={expandedKey === client.key}
              onToggle={() => setExpandedKey((key) => (key === client.key ? "" : client.key))}
              onEdit={() => onEdit(client)}
              onDelete={() => onDelete(client)}
            />
          ))
        ) : (
          <p className="crm-empty">
            {search.trim()
              ? "Никого не нашли по этому запросу."
              : "Пока нет клиентов. Они появятся из заказов или по кнопке «+ Новый клиент»."}
          </p>
        )}
      </div>
    </section>
  );
}
