import { useCallback, useEffect, useState } from "react";
import { imageSrc } from "../lib/catalog.js";
import { fetchPortfolio, savePortfolio } from "../lib/portfolio-api.js";
import { confirmAction, notify } from "./dialogs.jsx";
import LoadErrorBanner from "./LoadErrorBanner.jsx";
import PortfolioModal, { KIND_LABELS } from "./PortfolioModal.jsx";
import RefreshButton from "./RefreshButton.jsx";

function WorkPreview({ work }) {
  if (work.video) {
    return (
      <video
        className="portfolio-admin-media"
        src={imageSrc(work.video)}
        poster={work.image ? imageSrc(work.image) : undefined}
        muted
        playsInline
        preload="metadata"
      />
    );
  }
  return <img className="portfolio-admin-media" src={imageSrc(work.image)} alt="" />;
}

/** «Примеры работ» медиасайта: фото, видео и условия. Список сохраняется целиком после каждой правки. */
export default function PortfolioSection() {
  const [items, setItems] = useState([]);
  const [isDefault, setIsDefault] = useState(false);
  const [status, setStatus] = useState("loading");
  const [retrying, setRetrying] = useState(false);
  const [busy, setBusy] = useState(false);
  // undefined — окно закрыто, null — новая работа, объект — правка
  const [editing, setEditing] = useState(undefined);

  const load = useCallback(async () => {
    try {
      const list = await fetchPortfolio();
      setItems(list || []);
      setIsDefault(list === null);
      setStatus("ready");
    } catch (err) {
      console.warn(err);
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    document.body.classList.toggle("modal-open", editing !== undefined);
    const onKey = (event) => {
      if (event.key === "Escape") setEditing(undefined);
    };
    if (editing !== undefined) document.addEventListener("keydown", onKey);
    return () => {
      document.body.classList.remove("modal-open");
      document.removeEventListener("keydown", onKey);
    };
  }, [editing]);

  const retry = async () => {
    setRetrying(true);
    try {
      await load();
    } finally {
      setRetrying(false);
    }
  };

  const persist = async (next) => {
    const saved = await savePortfolio(next);
    setItems(saved);
    setIsDefault(false);
    return saved;
  };

  /** Перестановка и удаление — без окна: ошибку показываем всплывающим сообщением. */
  const quickSave = async (next) => {
    if (busy) return;
    setBusy(true);
    try {
      await persist(next);
    } catch (err) {
      if (!err || err.code !== "unauthorized") notify(String((err && err.message) || "Не удалось сохранить"));
    } finally {
      setBusy(false);
    }
  };

  const move = (index, shift) => {
    const target = index + shift;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    quickSave(next);
  };

  const remove = async (work) => {
    const ok = await confirmAction(`Удалить «${work.title}» из примеров работ? Фото и видео удалятся с сервера.`, {
      title: "Удаление работы",
      confirmLabel: "Удалить",
      danger: true,
    });
    if (ok) quickSave(items.filter((item) => item.id !== work.id));
  };

  const saveWork = async (work) => {
    const exists = work.id && items.some((item) => item.id === work.id);
    // Новая работа — первой: на сайте она сразу видна в начале списка.
    await persist(exists ? items.map((item) => (item.id === work.id ? work : item)) : [work, ...items]);
    setEditing(undefined);
  };

  return (
    <section className="dash-card dash-card-full">
      <div className="crm-toolbar">
        <div>
          <h2>Примеры работ · {items.length}</h2>
          <p className="admin-hint">
            Блок «Примеры работ» на сайте «Dinara BILab Медиа». Добавьте фото или видео и напишите условия — посетитель
            увидит их, нажав на работу, и сможет заказать похожую в WhatsApp.
          </p>
        </div>
        <div className="crm-card-actions">
          <RefreshButton onRefresh={load} />
          <button
            type="button"
            className="dash-btn dash-btn-fill"
            disabled={status !== "ready"}
            onClick={() => setEditing(null)}
          >
            + Новая работа
          </button>
        </div>
      </div>

      {status === "error" && (
        <LoadErrorBanner text="Не удалось загрузить примеры работ с сервера." onRetry={retry} retrying={retrying} />
      )}
      {status === "ready" && isDefault && (
        <p className="admin-hint portfolio-default-note">
          Сейчас на сайте показываются примеры-заглушки со стоковыми фото. Добавьте первую работу — заглушки исчезнут.
        </p>
      )}

      {status === "loading" && <p className="admin-hint">Загружаем…</p>}
      {status === "ready" && !items.length && !isDefault && (
        <p className="admin-hint">Работ пока нет — нажмите «+ Новая работа». Пока список пуст, блок на сайте скрыт.</p>
      )}

      <div className="admin-products">
        {items.map((work, index) => (
          <article className="admin-product portfolio-admin-card" key={work.id}>
            <div className="portfolio-admin-preview">
              <WorkPreview work={work} />
              {work.video && <span className="portfolio-admin-badge">▶ Видео</span>}
            </div>
            <div>
              <p className="admin-product-kind">{KIND_LABELS[work.kind] || work.kind}</p>
              <h3>{work.title}</h3>
              <p className="portfolio-admin-terms">{work.terms || "Условия не указаны"}</p>
            </div>
            <div className="crm-card-actions">
              <button
                type="button"
                className="dash-btn"
                disabled={busy || index === 0}
                aria-label="Выше"
                title="Показывать раньше"
                onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="dash-btn"
                disabled={busy || index === items.length - 1}
                aria-label="Ниже"
                title="Показывать позже"
                onClick={() => move(index, 1)}
              >
                ↓
              </button>
              <button type="button" className="dash-btn" disabled={busy} onClick={() => setEditing(work)}>
                Изменить
              </button>
              <button type="button" className="dash-btn crm-btn-danger" disabled={busy} onClick={() => remove(work)}>
                Удалить
              </button>
            </div>
          </article>
        ))}
      </div>

      {editing !== undefined && (
        <PortfolioModal work={editing} onClose={() => setEditing(undefined)} onSave={saveWork} />
      )}
    </section>
  );
}
