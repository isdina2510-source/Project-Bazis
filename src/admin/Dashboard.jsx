import { useCallback, useEffect, useState } from "react";
import { normalizeProduct } from "../lib/catalog.js";
import { listClients, listOrders, listOrdersPage } from "../lib/orders-db.js";
import { fetchProducts, readCachedProducts } from "../lib/products-api.js";
import AdminErrorBoundary from "./AdminErrorBoundary.jsx";
import ClientModal from "./ClientModal.jsx";
import ClientsSection from "./ClientsSection.jsx";
import CompanySection from "./CompanySection.jsx";
import OrdersSection from "./OrdersSection.jsx";
import ProductModal from "./ProductModal.jsx";
import ProductsSection from "./ProductsSection.jsx";
import ReportsSection from "./ReportsSection.jsx";

const TABS = [
  { id: "crm", label: "Заказы", title: "CRM" },
  { id: "leads", label: "Заявки", title: "Заявки с сайта" },
  { id: "clients", label: "Клиенты", title: "Клиенты" },
  { id: "products", label: "Товары", title: "Товары" },
  { id: "reports", label: "Отчёты", title: "Отчёты" },
  { id: "company", label: "Реквизиты", title: "Реквизиты" },
];

function isUnauthorized(err) {
  return err && err.code === "unauthorized";
}

/** Товары: копия из браузера (если есть) только как запасной вариант; правка — лишь после загрузки с сервера. */
function initialProducts() {
  const cached = readCachedProducts();
  return { list: cached ? cached.products : [], savedAt: cached ? cached.savedAt : null, status: "loading" };
}

export default function Dashboard({ onLogout }) {
  const [tab, setTab] = useState("crm");
  const [orders, setOrders] = useState([]);
  const [ordersError, setOrdersError] = useState(false);
  const [clients, setClients] = useState([]);
  const [clientsError, setClientsError] = useState(false);
  const [crmLoaded, setCrmLoaded] = useState(false);
  const [productsState, setProductsState] = useState(initialProducts);
  const [productsRetrying, setProductsRetrying] = useState(false);
  const products = productsState.list;
  const productsReady = productsState.status === "ready";
  // undefined — модалка закрыта, null — создание, объект — редактирование
  const [editingProduct, setEditingProduct] = useState(undefined);
  const [editingClient, setEditingClient] = useState(undefined);

  const loadOrders = useCallback(async () => {
    try {
      setOrders(await listOrders());
      setOrdersError(false);
    } catch (err) {
      if (isUnauthorized(err)) return;
      console.warn(err);
      setOrders([]);
      setOrdersError(true);
    }
  }, []);

  const loadClients = useCallback(async () => {
    try {
      setClients(await listClients());
      setClientsError(false);
    } catch (err) {
      if (isUnauthorized(err)) return;
      console.warn(err);
      setClients([]);
      setClientsError(true);
    }
  }, []);

  const loadCrmData = useCallback(async () => {
    await loadOrders();
    await loadClients();
    setCrmLoaded(true);
  }, [loadOrders, loadClients]);

  /** Число новых заявок для значка на вкладке — без загрузки самих заявок. */
  const [newLeads, setNewLeads] = useState(0);
  const loadLeadBadge = useCallback(async () => {
    try {
      const page = await listOrdersPage({ kind: "leads", status: "new", limit: 1 });
      setNewLeads(page.counts.new || 0);
    } catch {
      // значок не критичен
    }
  }, []);

  const loadProducts = useCallback(async () => {
    try {
      const list = await fetchProducts();
      setProductsState({ list, savedAt: Date.now(), status: "ready" });
    } catch (err) {
      if (isUnauthorized(err)) return;
      console.warn(err);
      // Копия (из браузера или от прошлой загрузки) — только для просмотра; без неё — ошибка без списка.
      setProductsState((prev) => ({ ...prev, status: prev.list.length ? "stale" : "error" }));
    }
  }, []);

  const retryProducts = useCallback(async () => {
    setProductsRetrying(true);
    try {
      await loadProducts();
    } finally {
      setProductsRetrying(false);
    }
  }, [loadProducts]);

  const setProducts = (update) => setProductsState((prev) => ({ ...prev, list: update(prev.list) }));

  useEffect(() => {
    loadLeadBadge();
    loadProducts();
  }, [loadLeadBadge, loadProducts]);

  // Полный список заказов нужен только клиентам и отчётам — грузим его при открытии этих вкладок.
  useEffect(() => {
    if (tab === "products") loadProducts();
    if (tab === "clients" || tab === "reports") loadCrmData();
  }, [tab, loadProducts, loadCrmData]);

  const modalOpen = editingProduct !== undefined || editingClient !== undefined;
  useEffect(() => {
    document.body.classList.toggle("modal-open", modalOpen);
    return () => document.body.classList.remove("modal-open");
  }, [modalOpen]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      if (editingClient !== undefined) setEditingClient(undefined);
      else if (editingProduct !== undefined) setEditingProduct(undefined);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editingClient, editingProduct]);

  const activeTab = TABS.find((item) => item.id === tab) || TABS[0];

  return (
    <div className="admin-dashboard">
      <div className="dash">
        <header className="dash-top">
          <div>
            <p className="dash-badge">Админка</p>
            <h1>{activeTab.title}</h1>
          </div>
          <div className="dash-actions">
            {tab === "clients" && (
              <button type="button" className="dash-btn dash-btn-fill" onClick={() => setEditingClient(null)}>
                + Новый клиент
              </button>
            )}
            {tab === "products" && (
              <button
                type="button"
                className="dash-btn dash-btn-fill"
                disabled={!productsReady}
                title={productsReady ? undefined : "Недоступно, пока товары не загружены с сервера"}
                onClick={() => setEditingProduct(null)}
              >
                + Новый товар
              </button>
            )}
            <a className="dash-btn" href="/shop" target="_blank" rel="noopener noreferrer">
              Смотреть магазин
            </a>
            <button type="button" className="dash-btn" onClick={onLogout}>
              Выйти
            </button>
          </div>
        </header>

        <nav className="dash-tabs" aria-label="Разделы админки">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={"dash-tab" + (item.id === tab ? " is-active" : "")}
              onClick={() => setTab(item.id)}
            >
              {item.label}
              {item.id === "leads" && newLeads > 0 && <span className="dash-tab-badge">{newLeads}</span>}
            </button>
          ))}
        </nav>

        {/* key — у каждой вкладки своя граница ошибок: упавший раздел не мешает открыть другой. */}
        <AdminErrorBoundary key={tab} name={tab}>
          {tab === "crm" && (
            <OrdersSection key="orders" variant="orders" onChanged={loadLeadBadge} onOpenCompany={() => setTab("company")} />
          )}
          {tab === "leads" && <OrdersSection key="leads" variant="leads" onChanged={loadLeadBadge} />}
          {tab === "clients" && (
            <ClientsSection
              clients={clients}
              orders={orders}
              loading={!crmLoaded}
              clientsError={clientsError}
              ordersError={ordersError}
              onRefresh={loadCrmData}
              onEdit={(client) => setEditingClient(client)}
            />
          )}
          {tab === "products" && (
            <ProductsSection
              products={products}
              status={productsState.status}
              savedAt={productsState.savedAt}
              onRetry={retryProducts}
              retrying={productsRetrying}
              onEdit={(product) => productsReady && setEditingProduct(product)}
              onDeleted={(id) => setProducts((prev) => prev.filter((item) => item.id !== id))}
            />
          )}
          {tab === "reports" && (
            <ReportsSection
              orders={orders}
              clients={clients}
              products={products}
              loadError={ordersError}
              clientsError={clientsError}
              onRefresh={loadCrmData}
            />
          )}
          {tab === "company" && <CompanySection />}
        </AdminErrorBoundary>
      </div>

      {editingProduct !== undefined && productsReady && (
        <ProductModal
          product={editingProduct}
          onClose={() => setEditingProduct(undefined)}
          onSaved={(saved) => {
            const item = normalizeProduct(saved);
            setProducts((prev) =>
              prev.some((p) => p.id === item.id) ? prev.map((p) => (p.id === item.id ? item : p)) : [item, ...prev]
            );
            setEditingProduct(undefined);
            loadProducts();
          }}
        />
      )}

      {editingClient !== undefined && (
        <ClientModal
          client={editingClient}
          onClose={() => setEditingClient(undefined)}
          onSaved={() => {
            setEditingClient(undefined);
            loadCrmData();
          }}
        />
      )}
    </div>
  );
}
