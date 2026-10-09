import { useCallback, useEffect, useState } from "react";
import { formatPrice } from "../lib/catalog.js";
import {
  COMPANY_ERROR_CODES,
  KIND_LABELS,
  downloadDocument,
  issueDocuments,
  listOrderDocuments,
  reissueDocument,
  updateOrderAdjustments,
} from "./documents-api.js";
import { formatDate } from "./format.js";
import { confirmAction } from "./dialogs.jsx";
import SendDialog from "./SendDialog.jsx";

const CURRENCIES = ["KZT", "RUB", "USD"];
const CHANNEL_NAMES = { email: "e-mail", telegram: "Telegram" };

const toInput = (value) => (Number(value) ? String(value) : "");

function adjustmentsForm(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  return {
    discount: toInput(order.discount),
    delivery: toInput(order.delivery),
    adjustCurrency: order.adjustCurrency || (items[0] && items[0].currency) || "KZT",
    vatRate: toInput(order.vatRate),
    items: items.map((item) => toInput(item.discount)),
  };
}

/** Скидки по позициям и на заказ, доставка и НДС — попадают в счёт и акт. */
function AdjustmentsForm({ order, onSaved }) {
  const items = Array.isArray(order.items) ? order.items : [];
  const [form, setForm] = useState(() => adjustmentsForm(order));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const currencies = Array.from(new Set(items.map((item) => item.currency || "KZT")));

  useEffect(() => setForm(adjustmentsForm(order)), [order]);

  const set = (name) => (event) => setForm((prev) => ({ ...prev, [name]: event.target.value }));
  const setItem = (index) => (event) =>
    setForm((prev) => ({ ...prev, items: prev.items.map((value, i) => (i === index ? event.target.value : value)) }));

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      const updated = await updateOrderAdjustments(order.id, {
        discount: form.discount,
        delivery: form.delivery,
        adjustCurrency: form.adjustCurrency,
        vatRate: form.vatRate,
        itemDiscounts: form.items.map((discount, position) => ({ position, discount })),
      });
      onSaved(updated);
    } catch (err) {
      if (err.code !== "unauthorized") setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="dash-form doc-adjust" onSubmit={submit}>
      <p className="doc-subtitle">Скидки, доставка, НДС</p>
      {items.map((item, index) => (
        <label key={index} className="doc-adjust-item">
          <span>
            {item.title || "Позиция"} · {item.qty || 1} × {formatPrice(item.price, item.currency)}
          </span>
          <input
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            placeholder="Скидка"
            aria-label={"Скидка на позицию " + (index + 1)}
            value={form.items[index] ?? ""}
            onChange={setItem(index)}
          />
        </label>
      ))}
      <div className="doc-adjust-row">
        <label>
          Скидка на заказ
          <input type="number" min="0" step="0.01" inputMode="decimal" value={form.discount} onChange={set("discount")} />
        </label>
        <label>
          Доставка
          <input type="number" min="0" step="0.01" inputMode="decimal" value={form.delivery} onChange={set("delivery")} />
        </label>
        {currencies.length > 1 && (
          <label>
            Валюта скидки и доставки
            <select value={form.adjustCurrency} onChange={set("adjustCurrency")}>
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          НДС, % (в т.ч.)
          <input
            type="number"
            min="0"
            max="99.99"
            step="0.01"
            inputMode="decimal"
            placeholder="Без НДС"
            value={form.vatRate}
            onChange={set("vatRate")}
          />
        </label>
      </div>
      {error && (
        <p className="form-inline-error admin-error" role="alert">
          {error}
        </p>
      )}
      <div className="dash-form-actions">
        <button type="submit" className="dash-btn" disabled={saving}>
          {saving ? "Сохраняем…" : "Сохранить"}
        </button>
      </div>
    </form>
  );
}

function statusChip(doc) {
  if (doc.status === "annulled") return <span className="crm-chip crm-chip-cancelled">Аннулирован</span>;
  if (doc.outdated) {
    return (
      <span className="crm-chip doc-chip-outdated" title="Заказ или реквизиты покупателя изменились после выпуска">
        Заказ изменён
      </span>
    );
  }
  return <span className="crm-chip crm-chip-done">Действует</span>;
}

function lastSend(doc) {
  const ok = (doc.sends || []).filter((item) => item.ok);
  if (!ok.length) return null;
  const last = ok[0];
  return "Отправлен (" + (CHANNEL_NAMES[last.channel] || last.channel) + ") " + formatDate(last.sentAt);
}

/** Счета и акты заказа: выпуск, скачивание, перевыпуск и отправка. */
export default function OrderDocuments({ order, onOrderChanged, onOpenCompany }) {
  const [docs, setDocs] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [companyError, setCompanyError] = useState(false);
  const [sending, setSending] = useState(null);
  const [showAnnulled, setShowAnnulled] = useState(false);

  const load = useCallback(async () => {
    try {
      setDocs(await listOrderDocuments(order.id));
    } catch (err) {
      if (err.code !== "unauthorized") setError(err.message);
    }
  }, [order.id]);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (key, action) => {
    if (busy) return;
    setBusy(key);
    setError("");
    setCompanyError(false);
    try {
      await action();
    } catch (err) {
      if (err.code !== "unauthorized") {
        setError(err.message);
        setCompanyError(COMPANY_ERROR_CODES.has(err.code));
      }
    } finally {
      setBusy("");
    }
  };

  const issue = (kind) =>
    run(kind, async () => {
      const issued = await issueDocuments(order.id, kind);
      for (const doc of issued) await downloadDocument(doc);
      await load();
    });

  const reissue = async (doc) => {
    const text =
      "Документ будет аннулирован, новый получит следующий номер " +
      "и текущие данные заказа и реквизиты.";
    if (!(await confirmAction(text, { title: "Перевыпустить " + doc.title + "?", confirmLabel: "Перевыпустить" }))) return;
    run("re:" + doc.id, async () => {
      const fresh = await reissueDocument(doc.id);
      await downloadDocument(fresh);
      await load();
    });
  };

  const visible = (docs || []).filter((doc) => showAnnulled || doc.status === "active");
  const annulledCount = (docs || []).filter((doc) => doc.status !== "active").length;
  const cancelled = order.status === "cancelled";

  return (
    <div className="doc-panel">
      <AdjustmentsForm
        order={order}
        onSaved={async (updated) => {
          await onOrderChanged(updated);
          await load();
        }}
      />
      <div className="doc-issue">
        <p className="doc-subtitle">Документы</p>
        <div className="crm-card-actions">
          <button type="button" className="dash-btn" disabled={!!busy || cancelled} onClick={() => issue("invoice")}>
            {busy === "invoice" ? "Готовим…" : "Счёт на оплату"}
          </button>
          <button type="button" className="dash-btn" disabled={!!busy || cancelled} onClick={() => issue("act")}>
            {busy === "act" ? "Готовим…" : "Акт выполненных работ"}
          </button>
        </div>
        {cancelled && <p className="admin-hint">Заказ отменён — новые документы не выписываются.</p>}
      </div>
      {error && (
        <p className="form-inline-error admin-error" role="alert">
          {error}
          {companyError && onOpenCompany && (
            <>
              {" "}
              <button type="button" className="doc-link" onClick={onOpenCompany}>
                Открыть раздел «Реквизиты»
              </button>
            </>
          )}
        </p>
      )}
      {docs && docs.length > 0 && (
        <ul className="doc-list">
          {visible.map((doc) => (
            <li key={doc.id} className={"doc-item" + (doc.status !== "active" ? " is-annulled" : "")}>
              <div className="doc-item-main">
                <strong>{doc.title}</strong>
                <span className="crm-muted">
                  {formatDate(doc.createdAt)} · {formatPrice(doc.total, doc.currency)}
                </span>
                {lastSend(doc) && <span className="crm-muted">{lastSend(doc)}</span>}
              </div>
              <div className="crm-card-actions">
                {statusChip(doc)}
                <button type="button" className="dash-btn" disabled={!!busy} onClick={() => run("dl:" + doc.id, () => downloadDocument(doc))}>
                  PDF
                </button>
                {doc.status === "active" && (
                  <>
                    <button type="button" className="dash-btn" disabled={!!busy} onClick={() => setSending(doc)}>
                      Отправить
                    </button>
                    <button
                      type="button"
                      className={"dash-btn" + (doc.outdated ? " dash-btn-fill" : "")}
                      disabled={!!busy || cancelled}
                      onClick={() => reissue(doc)}
                    >
                      {busy === "re:" + doc.id ? "Перевыпускаем…" : "Перевыпустить"}
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {annulledCount > 0 && (
        <button type="button" className="doc-link" onClick={() => setShowAnnulled((value) => !value)}>
          {showAnnulled ? "Скрыть аннулированные" : "Показать аннулированные (" + annulledCount + ")"}
        </button>
      )}
      {sending && (
        <SendDialog
          title={sending.title}
          target={{ type: "document", id: sending.id }}
          defaultEmail={sending.buyerEmail || ""}
          onClose={() => setSending(null)}
          onSent={load}
        />
      )}
    </div>
  );
}
