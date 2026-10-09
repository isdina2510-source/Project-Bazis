import { useMemo, useState } from "react";
import { LOW_STOCK_THRESHOLD, formatFromPrice, getCategoryLabel, imageSrc } from "../lib/catalog.js";
import { removeFromStoredCart } from "../lib/cart-storage.js";
import { deleteProduct } from "../lib/products-api.js";
import { downloadCatalog, downloadProductPdf } from "./documents-api.js";
import { confirmAction, notify } from "./dialogs.jsx";
import { kindLabel } from "./format.js";
import LoadErrorBanner from "./LoadErrorBanner.jsx";
import SendDialog from "./SendDialog.jsx";

function TrashIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

function StockLine({ stock }) {
  if (stock == null) return <p className="admin-product-stock">Остаток не учитывается</p>;
  if (stock <= 0) return <p className="admin-product-stock is-out">Нет в наличии</p>;
  const low = stock <= LOW_STOCK_THRESHOLD;
  return <p className={"admin-product-stock" + (low ? " is-low" : "")}>Остаток: {stock} шт.</p>;
}

/** 09.10.2026, 14:05 — дата копии каталога в браузере. */
export function formatCopyDate(savedAt) {
  if (!Number.isFinite(savedAt)) return "неизвестной даты";
  return new Date(savedAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * status: loading | ready | stale (сервер не ответил, показана копия от savedAt) | error (копии нет).
 * Пока данные не свежие (не ready), товары нельзя создавать, менять и удалять: правка поверх старой копии
 * затёрла бы чужие изменения цен и остатков.
 */
export default function ProductsSection({ products, status = "ready", savedAt = null, onRetry, retrying = false, onEdit, onDeleted }) {
  const readOnly = status !== "ready";
  const [selected, setSelected] = useState(() => new Set());
  const [showPrices, setShowPrices] = useState(true);
  const [showStock, setShowStock] = useState(false);
  const [busy, setBusy] = useState("");
  const [sending, setSending] = useState(false);

  // Удалённые товары не остаются в выборке.
  const selectedIds = useMemo(() => products.filter((p) => selected.has(p.id)).map((p) => p.id), [products, selected]);
  const allSelected = products.length > 0 && selectedIds.length === products.length;

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(products.map((p) => p.id)));

  const run = async (key, action) => {
    if (busy) return;
    setBusy(key);
    try {
      await action();
    } catch (err) {
      if (err && err.code !== "unauthorized") notify(err.message || "Не удалось сформировать PDF.");
    } finally {
      setBusy("");
    }
  };

  const catalogTarget = { type: "catalog", ids: selectedIds, showPrices, showStock };
  const catalogLabel = selectedIds.length ? "Каталог (" + selectedIds.length + ")" : "Каталог (все)";

  const remove = async (product) => {
    if (readOnly) return;
    const ok = await confirmAction(`Удалить «${product.title || "позицию"}» из каталога? Это действие нельзя отменить.`, {
      title: "Удаление товара",
      confirmLabel: "Удалить",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteProduct(product.id);
      removeFromStoredCart(product.id);
      onDeleted(product.id);
    } catch (err) {
      if (err && err.code === "unauthorized") return;
      notify(String((err && err.message) || "Не удалось удалить товар"));
    }
  };

  return (
    <section id="products-section" className="dash-card dash-card-full">
      <div className="crm-toolbar">
        <div>
          <h2>Товары</h2>
          <p className="admin-hint">
            Позиции магазина хранятся на сервере и видны всем посетителям. Отметьте товары, чтобы собрать из них
            PDF-каталог; без отметок в каталог попадут все.
          </p>
        </div>
      </div>
      {status === "error" && (
        <LoadErrorBanner
          text="Не удалось загрузить товары с сервера. Список не показан, пока загрузка не пройдёт."
          onRetry={onRetry}
          retrying={retrying}
        />
      )}
      {status === "stale" && (
        <LoadErrorBanner
          text={
            "Данные не загружены, показана копия от " + formatCopyDate(savedAt) +
            ". Создание, изменение и удаление товаров недоступны, пока загрузка не пройдёт."
          }
          onRetry={onRetry}
          retrying={retrying}
        />
      )}
      {status !== "error" && products.length > 0 && (
        <div className="catalog-bar">
          <label className="catalog-check">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} />
            {allSelected ? "Снять выбор" : "Выбрать все"}
          </label>
          <span className="crm-muted">Выбрано: {selectedIds.length}</span>
          <label className="catalog-check">
            <input type="checkbox" checked={showPrices} onChange={(event) => setShowPrices(event.target.checked)} />
            Цены
          </label>
          <label className="catalog-check">
            <input type="checkbox" checked={showStock} onChange={(event) => setShowStock(event.target.checked)} />
            Остатки
          </label>
          <div className="crm-card-actions catalog-bar-actions">
            <button
              type="button"
              className="dash-btn dash-btn-fill"
              disabled={!!busy}
              onClick={() => run("catalog", () => downloadCatalog(catalogTarget))}
            >
              {busy === "catalog" ? "Готовим PDF…" : "Скачать " + catalogLabel.toLowerCase()}
            </button>
            <button type="button" className="dash-btn" disabled={!!busy} onClick={() => setSending(true)}>
              Отправить
            </button>
          </div>
        </div>
      )}
      <div className="admin-products">
        {status === "error" ? null : products.length ? (
          products.map((product) => (
            <article className={"admin-product" + (selected.has(product.id) ? " is-selected" : "")} key={product.id}>
              <label className="admin-product-select">
                <input
                  type="checkbox"
                  checked={selected.has(product.id)}
                  onChange={() => toggle(product.id)}
                  aria-label={"В каталог: " + product.title}
                />
              </label>
              <img src={imageSrc(product.image)} alt="" />
              <div>
                <p className="admin-product-kind">
                  {kindLabel(product.kind)} · {getCategoryLabel(product.category)}
                </p>
                <h3>{product.title}</h3>
                <p>{product.description}</p>
                <p className="admin-product-price">{formatFromPrice(product.price, product.currency)}</p>
                <StockLine stock={product.stock} />
              </div>
              <div className="admin-product-actions">
                <button type="button" className="btn btn-ghost" disabled={readOnly} onClick={() => onEdit(product)}>
                  Выбрать
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={!!busy}
                  title="PDF-карточка товара"
                  onClick={() => run("p:" + product.id, () => downloadProductPdf(product.id))}
                >
                  {busy === "p:" + product.id ? "…" : "PDF"}
                </button>
                <button
                  type="button"
                  className="btn btn-primary admin-btn-icon"
                  aria-label="Удалить"
                  title="Удалить"
                  disabled={readOnly}
                  onClick={() => remove(product)}
                >
                  <TrashIcon />
                </button>
              </div>
            </article>
          ))
        ) : (
          <p className="admin-hint">{status === "ready" ? "Пока нет товаров — нажмите «+ Новый товар»." : "Загружаем…"}</p>
        )}
      </div>
      {sending && (
        <SendDialog title={catalogLabel} target={catalogTarget} onClose={() => setSending(false)} />
      )}
    </section>
  );
}
