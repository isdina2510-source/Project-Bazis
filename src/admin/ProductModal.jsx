import { useEffect, useRef, useState } from "react";
import { imageSrc } from "../lib/catalog.js";
import { createProduct, updateProduct } from "../lib/products-api.js";
import { notify } from "./dialogs.jsx";
import { MAX_PHOTO_BYTES, compressImageFile } from "./image.js";

const PHOTO_ERRORS = {
  unsupported_format:
    "Этот формат фото браузер не открывает (например, HEIC с iPhone). Сохраните фото как JPG или PNG и выберите снова.",
  image_too_large: `Фото слишком большое: даже после сжатия больше ${(MAX_PHOTO_BYTES / 1024 / 1024).toFixed(1)} МБ. Уменьшите разрешение или выберите другой файл.`,
};

function initialForm(product) {
  if (!product) {
    return {
      title: "",
      price: "",
      currency: "KZT",
      trackStock: false,
      stock: "",
      kind: "service",
      category: "management",
      description: "",
      image: "",
      imageUrl: "",
    };
  }
  const image = product.image || "";
  return {
    title: product.title,
    price: String(product.price),
    currency: product.currency || "KZT",
    ...stockFields(product.stock),
    kind: product.kind || "service",
    category: product.category || "management",
    description: product.description,
    image,
    imageUrl: image.startsWith("data:") ? "" : image,
  };
}

function stockFields(stock) {
  return stock == null ? { trackStock: false, stock: "" } : { trackStock: true, stock: String(stock) };
}

/** Значение остатка из формы: null — без учёта, число — остаток, undefined — ошибка ввода. */
function stockFromForm(form) {
  if (!form.trackStock) return null;
  const text = String(form.stock).trim();
  if (!/^\d+$/.test(text) || Number(text) > MAX_STOCK) return undefined;
  return Number(text);
}

const MAX_STOCK = 999999;

/** Те же варианты, что принимает сервер (resolveProductImage): файл, ссылка в интернете или путь к картинке сайта. */
function isAcceptedImage(value) {
  if (value.startsWith("data:image/") || /^https?:\/\/\S+$/i.test(value)) return true;
  const path = value.replace(/\\/g, "/").replace(/^\/+/, "");
  return path.startsWith("images/") && !path.includes("..");
}

/** product: null — создание, объект — редактирование. */
export default function ProductModal({ product, onClose, onSaved }) {
  const isEdit = !!product;
  const [form, setForm] = useState(() => initialForm(product));
  // Остаток, от которого админ отталкивается при правке; обновляется, если сервер сообщил о продажах.
  const [stockBase, setStockBase] = useState(() => (product ? product.stock : null));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const titleRef = useRef(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const set = (name) => (event) => setForm((prev) => ({ ...prev, [name]: event.target.value }));

  const applyPhotoFile = async (file) => {
    if (!file) return;
    try {
      const dataUrl = await compressImageFile(file);
      setForm((prev) => ({ ...prev, image: dataUrl, imageUrl: "" }));
    } catch (err) {
      notify(PHOTO_ERRORS[err && err.message] || "Не удалось прочитать файл фото. Попробуйте другой файл.");
    }
  };

  const onDragEvent = (over) => (event) => {
    event.preventDefault();
    setDragOver(over);
  };

  const submit = async (event) => {
    event.preventDefault();
    if (saving) return;
    setError("");
    const title = form.title.trim();
    const description = form.description.trim();
    if (!title) {
      setError("Укажите название");
      return;
    }
    if (!description) {
      setError("Укажите описание");
      return;
    }
    const stock = stockFromForm(form);
    if (stock === undefined) {
      setError(`Укажите остаток — целое число от 0 до ${MAX_STOCK}`);
      return;
    }

    const image = form.image.trim() || form.imageUrl.trim();
    if (image && !isAcceptedImage(image)) {
      setError("Фото: загрузите файл или укажите ссылку https://... (или путь images/...)");
      return;
    }

    const payload = {
      title,
      description,
      price: form.price || "0",
      currency: form.currency,
      kind: form.kind,
      category: form.category,
      // Пусто — товар без фото: сайт и PDF покажут нейтральную заглушку.
      image,
    };
    // Нетронутый остаток не отправляем: иначе сохранение карточки перезаписало бы продажи, прошедшие за это время.
    if (!isEdit) {
      payload.stock = stock;
    } else if (stock !== stockBase) {
      payload.stock = stock;
      payload.stockBase = stockBase;
    }

    setSaving(true);
    try {
      const saved = isEdit ? await updateProduct(product.id, payload) : await createProduct(payload);
      onSaved(saved);
    } catch (err) {
      if (err && err.code === "unauthorized") return;
      if (err && err.code === "stock_conflict") {
        const current = err.stock == null ? null : Number(err.stock);
        setStockBase(current);
        setForm((prev) => ({ ...prev, ...stockFields(current) }));
        setError(
          "Пока вы редактировали, остаток изменился (продажи или отмены). Сейчас: " +
            (current == null ? "без учёта" : current + " шт") +
            ". Проверьте значение и сохраните снова."
        );
      } else {
        setError(String((err && err.message) || "Не удалось сохранить товар. Проверьте сервер и пароль."));
      }
      setSaving(false);
    }
  };

  const preview = form.image || form.imageUrl;
  const idleLabel = isEdit ? "Обновить" : "Сохранить";

  return (
    <div className="product-modal">
      <div className="product-modal-backdrop" onClick={onClose} />
      <div className="product-modal-panel" role="dialog" aria-modal="true" aria-labelledby="form-title">
        <header className="product-modal-head">
          <h2 id="form-title">{isEdit ? "Редактировать" : "Новый товар"}</h2>
          <button type="button" className="product-modal-close" onClick={onClose} aria-label="Закрыть">
            ×
          </button>
        </header>

        <form className="dash-form modal-form" onSubmit={submit}>
          <label>
            Название
            <input
              ref={titleRef}
              type="text"
              name="title"
              required
              maxLength={120}
              placeholder="Название"
              value={form.title}
              onChange={set("title")}
            />
          </label>

          <div className="price-row">
            <label>
              Цена
              <input
                type="number"
                name="price"
                required
                min="0"
                step="1"
                placeholder="0"
                inputMode="numeric"
                value={form.price}
                onChange={set("price")}
              />
            </label>
            <label>
              Валюта
              <select name="currency" required value={form.currency} onChange={set("currency")}>
                <option value="KZT">Тенге (₸)</option>
                <option value="RUB">Рубли (₽)</option>
                <option value="USD">Доллар ($)</option>
              </select>
            </label>
          </div>

          <div className="price-row">
            <label>
              Остаток, шт.
              <input
                type="number"
                name="stock"
                min="0"
                max={MAX_STOCK}
                step="1"
                inputMode="numeric"
                placeholder={form.trackStock ? "0" : "без учёта"}
                disabled={!form.trackStock}
                value={form.stock}
                onChange={set("stock")}
              />
            </label>
            <label>
              Тип
              <select name="kind" required value={form.kind} onChange={set("kind")}>
                <option value="product">Товар</option>
                <option value="service">Услуга</option>
              </select>
            </label>
          </div>
          <label className="dash-check">
            <input
              type="checkbox"
              name="trackStock"
              checked={form.trackStock}
              onChange={(event) => {
                const checked = event.target.checked;
                setForm((prev) => ({ ...prev, trackStock: checked, stock: checked && prev.stock === "" ? "0" : prev.stock }));
              }}
            />
            Учитывать остаток (заказы списывают со склада, при нуле — «Нет в наличии»)
          </label>

          <label>
            Раздел
            <select name="category" required value={form.category} onChange={set("category")}>
              <option value="management">Управление бизнесом — сайт «Dinara BILab»</option>
              <option value="infrastructure">Инфраструктура — оба сайта</option>
              <option value="media">Визуал и медиа — сайт «Dinara BILab Медиа»</option>
            </select>
          </label>

          <label>
            Описание
            <textarea
              name="description"
              rows={4}
              required
              maxLength={500}
              placeholder="Описание"
              value={form.description}
              onChange={set("description")}
            />
          </label>

          <div className="photo-field">
            <span>Фото</span>
            <label
              className={"photo-drop" + (dragOver ? " is-dragover" : "")}
              onDragEnter={onDragEvent(true)}
              onDragOver={onDragEvent(true)}
              onDragLeave={onDragEvent(false)}
              onDrop={(event) => {
                onDragEvent(false)(event);
                applyPhotoFile(event.dataTransfer?.files?.[0]);
              }}
            >
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={(event) => {
                  applyPhotoFile(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
              {preview ? (
                <img src={imageSrc(preview)} alt="" />
              ) : (
                <span>Нажмите или перетащите изображение</span>
              )}
            </label>
            <input
              type="text"
              inputMode="url"
              name="imageUrl"
              placeholder="или вставьте ссылку https://... или путь images/..."
              value={form.imageUrl}
              onChange={(event) => {
                const value = event.target.value;
                setForm((prev) => ({ ...prev, imageUrl: value, image: value.trim() }));
              }}
            />
            {preview && (
              <button type="button" className="dash-btn" onClick={() => setForm((prev) => ({ ...prev, image: "", imageUrl: "" }))}>
                Убрать фото
              </button>
            )}
          </div>

          {error && (
            <p className="form-inline-error admin-error" role="alert">
              {error}
            </p>
          )}

          <div className="dash-form-actions">
            <button type="submit" className="dash-btn dash-btn-fill" disabled={saving}>
              {saving ? (isEdit ? "Обновляем…" : "Сохраняем…") : idleLabel}
            </button>
            <button type="button" className="dash-btn" onClick={onClose}>
              Отмена
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
