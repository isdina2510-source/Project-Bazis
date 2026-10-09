import { useEffect, useRef, useState } from "react";
import requisitesSchema from "../../shared/requisites.json";
import { saveClient } from "../lib/orders-db.js";
import { editableClientId } from "./client-views.js";
import { validateField } from "./requisites-form.js";

const { CLIENT_FIELDS, CLIENT_TYPES } = requisitesSchema;

function initialRequisites(client) {
  const saved = (client && client.requisites) || {};
  const values = { type: saved.type === "company" ? "company" : "person" };
  CLIENT_FIELDS.forEach((field) => {
    values[field.key] = saved[field.key] || "";
  });
  return values;
}

/** client: null — новый клиент, объект (карточка CRM) — редактирование. */
export default function ClientModal({ client, onClose, onSaved }) {
  const isEdit = !!client;
  const [form, setForm] = useState(() => ({
    id: client ? editableClientId(client) : "",
    name: client ? client.name || "" : "",
    phone: client ? client.phone || "" : "",
    note: client ? client.note || "" : "",
  }));
  const [requisites, setRequisites] = useState(() => initialRequisites(client));
  const [requisitesOpen, setRequisitesOpen] = useState(() =>
    CLIENT_FIELDS.some((field) => client && client.requisites && client.requisites[field.key])
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const nameRef = useRef(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const set = (name) => (event) => setForm((prev) => ({ ...prev, [name]: event.target.value }));
  const setReq = (name) => (event) => setRequisites((prev) => ({ ...prev, [name]: event.target.value }));
  const isCompany = requisites.type === "company";
  const fields = CLIENT_FIELDS.filter((field) => isCompany || !field.companyOnly);

  const submit = async (event) => {
    event.preventDefault();
    if (saving) return;
    setError("");
    const name = form.name.trim();
    const phone = form.phone.trim();
    if (!name && !phone) {
      setError("Укажите имя или телефон клиента.");
      return;
    }
    const problems = fields.map((field) => validateField(field, requisites[field.key])).filter(Boolean);
    if (problems.length) {
      setRequisitesOpen(true);
      setError(problems.join(". "));
      return;
    }
    setSaving(true);
    try {
      await saveClient({ id: form.id, name, phone, note: form.note.trim(), source: "manual", requisites });
      onSaved();
    } catch (err) {
      if (err && err.code === "unauthorized") return;
      setError(String((err && err.message) || "Не удалось сохранить клиента."));
      setSaving(false);
    }
  };

  return (
    <div id="client-modal" className="product-modal">
      <div className="product-modal-backdrop" onClick={onClose} />
      <div className="product-modal-panel" role="dialog" aria-modal="true" aria-labelledby="client-form-title">
        <header className="product-modal-head">
          <h2 id="client-form-title">{isEdit ? "Клиент" : "Новый клиент"}</h2>
          <button type="button" className="product-modal-close" onClick={onClose} aria-label="Закрыть">
            ×
          </button>
        </header>

        <form className="dash-form modal-form" onSubmit={submit}>
          <label>
            Имя
            <input
              ref={nameRef}
              type="text"
              name="name"
              maxLength={120}
              placeholder="Имя клиента"
              value={form.name}
              onChange={set("name")}
            />
          </label>
          <label>
            Телефон
            <input
              type="tel"
              name="phone"
              maxLength={32}
              placeholder="+7 7XX XXX XX XX"
              value={form.phone}
              onChange={set("phone")}
            />
          </label>
          <label>
            Заметка
            <textarea
              name="note"
              rows={3}
              maxLength={500}
              placeholder="Комментарий по клиенту"
              value={form.note}
              onChange={set("note")}
            />
          </label>

          <button
            type="button"
            className="doc-link"
            aria-expanded={requisitesOpen}
            onClick={() => setRequisitesOpen((value) => !value)}
          >
            {requisitesOpen ? "▾" : "▸"} Реквизиты для счетов и актов
          </button>
          {requisitesOpen && (
            <fieldset className="req-fieldset">
              <label>
                Тип покупателя
                <select value={requisites.type} onChange={setReq("type")}>
                  {Object.entries(CLIENT_TYPES).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {fields.map((field) => (
                <label key={field.key}>
                  {field.label}
                  <input
                    type={field.type === "email" ? "email" : "text"}
                    maxLength={field.max}
                    placeholder={field.patternHint || field.placeholder || ""}
                    value={requisites[field.key]}
                    onChange={setReq(field.key)}
                  />
                </label>
              ))}
              <p className="admin-hint">Пустые поля печатаются в документах прочерком.</p>
            </fieldset>
          )}

          {error && (
            <p className="form-inline-error admin-error" role="alert">
              {error}
            </p>
          )}
          <div className="dash-form-actions">
            <button type="submit" className="dash-btn dash-btn-fill" disabled={saving}>
              {saving ? "Сохраняем…" : isEdit ? "Обновить" : "Сохранить"}
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
