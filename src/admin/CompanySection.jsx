import { useEffect, useState } from "react";
import requisitesSchema from "../../shared/requisites.json";
import { companyImageUrl, getChannels, getCompany, saveCompany, setCompanyImage } from "./documents-api.js";
import { confirmAction } from "./dialogs.jsx";
import { validateField } from "./requisites-form.js";

const { COMPANY_FIELDS, COMPANY_GROUPS } = requisitesSchema;
const MAX_IMAGE_BYTES = 1024 * 1024;
const IMAGE_LABELS = { stamp: "Печать", signature: "Подпись" };

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Печать или подпись: PNG с прозрачным фоном выглядит в документе лучше всего.
 * file — имя файла на сервере (меняется вместе с картинкой) или null.
 */
/**
 * Печать или подпись: «Не загружена» — файла нет; если файл есть, но предпросмотр не пришёл с сервера —
 * отдельное состояние с «Повторить», чтобы не принять сбой за отсутствие печати.
 */
export function CompanyImage({ kind, file, onChanged }) {
  const present = !!file;
  const [url, setUrl] = useState("");
  const [previewError, setPreviewError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setUrl("");
    setPreviewError(false);
    if (!present) return undefined;
    let alive = true;
    let objectUrl = "";
    companyImageUrl(kind)
      .then((value) => {
        objectUrl = value;
        if (alive) setUrl(value);
        else URL.revokeObjectURL(value);
      })
      .catch((err) => {
        if (!alive || (err && err.code === "unauthorized")) return;
        console.warn(err);
        setPreviewError(true);
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [kind, file, present, attempt]);

  let preview;
  if (!present) preview = <span>Не загружена</span>;
  else if (url) preview = <img src={url} alt={IMAGE_LABELS[kind]} />;
  else if (previewError) {
    preview = (
      <span role="alert">
        Не удалось загрузить предпросмотр{" "}
        <button type="button" className="dash-btn" onClick={() => setAttempt((n) => n + 1)}>
          Повторить
        </button>
      </span>
    );
  } else preview = <span>Загружаем…</span>;

  const upload = async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    if (!/^image\/(png|jpeg)$/.test(file.type)) {
      setError("Нужен файл PNG или JPEG.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError("Файл больше 1 МБ — уменьшите картинку.");
      return;
    }
    setBusy(true);
    try {
      onChanged(await setCompanyImage(kind, await readAsDataUrl(file)));
    } catch (err) {
      if (err.code !== "unauthorized") setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirmAction(
      "Убрать " + IMAGE_LABELS[kind].toLowerCase() + " из новых документов? Уже выпущенные документы не изменятся.",
      { confirmLabel: "Убрать", danger: true }
    );
    if (!ok) return;
    setBusy(true);
    try {
      onChanged(await setCompanyImage(kind, null));
    } catch (err) {
      if (err.code !== "unauthorized") setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="req-image">
      <p className="doc-subtitle">{IMAGE_LABELS[kind]}</p>
      <div className="req-image-box">{preview}</div>
      <div className="crm-card-actions">
        <label className={"dash-btn" + (busy ? " is-disabled" : "")}>
          {present ? "Заменить" : "Загрузить"}
          <input type="file" accept="image/png,image/jpeg" hidden disabled={busy} onChange={upload} />
        </label>
        {present && (
          <button type="button" className="dash-btn crm-btn-danger" disabled={busy} onClick={remove}>
            Убрать
          </button>
        )}
      </div>
      {error && (
        <p className="form-inline-error admin-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Реквизиты компании для счетов и актов; незаполненное печатается прочерком. */
export default function CompanySection() {
  const [company, setCompany] = useState(null);
  const [form, setForm] = useState({});
  const [channels, setChannels] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getCompany()
      .then((data) => {
        setCompany(data);
        setForm(data.fields);
      })
      .catch((err) => {
        if (err.code !== "unauthorized") setLoadError(err.message);
      });
    getChannels()
      .then(setChannels)
      .catch(() => {});
  }, []);

  const set = (key) => (event) => {
    setSaved(false);
    setForm((prev) => ({ ...prev, [key]: event.target.value }));
  };

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setSaved(false);
    const problems = COMPANY_FIELDS.map((field) => validateField(field, form[field.key])).filter(Boolean);
    if (problems.length) {
      setError(problems.join(". "));
      return;
    }
    setSaving(true);
    try {
      const data = await saveCompany(form);
      setCompany(data);
      setForm(data.fields);
      setSaved(true);
    } catch (err) {
      if (err.code !== "unauthorized") setError(err.errors && err.errors.length ? err.errors.join(". ") : err.message);
    } finally {
      setSaving(false);
    }
  };

  let content;
  if (loadError) content = <p className="crm-empty">{loadError}</p>;
  else if (!company) content = <p className="crm-empty">Загружаем…</p>;
  else {
    content = (
      <>
        <form className="dash-form req-form" onSubmit={submit}>
          {Object.entries(COMPANY_GROUPS).map(([group, title]) => (
            <fieldset key={group} className="req-fieldset">
              <legend>{title}</legend>
              <div className="req-grid">
                {COMPANY_FIELDS.filter((field) => field.group === group).map((field) => (
                  <label key={field.key} className={field.multiline ? "req-wide" : ""}>
                    {field.label}
                    {field.multiline ? (
                      <textarea
                        rows={3}
                        maxLength={field.max}
                        placeholder={field.placeholder || ""}
                        value={form[field.key] || ""}
                        onChange={set(field.key)}
                      />
                    ) : (
                      <input
                        type={field.type === "email" ? "email" : "text"}
                        maxLength={field.max}
                        placeholder={field.placeholder || field.patternHint || ""}
                        value={form[field.key] || ""}
                        onChange={set(field.key)}
                      />
                    )}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          {error && (
            <p className="form-inline-error admin-error" role="alert">
              {error}
            </p>
          )}
          {saved && (
            <p className="doc-success" role="status">
              Сохранено. Новые документы получат эти реквизиты; уже выпущенные не меняются — при необходимости
              перевыпустите их.
            </p>
          )}
          <div className="dash-form-actions">
            <button type="submit" className="dash-btn dash-btn-fill" disabled={saving}>
              {saving ? "Сохраняем…" : "Сохранить реквизиты"}
            </button>
          </div>
        </form>
        <div className="req-images">
          <CompanyImage kind="stamp" file={company.stamp} onChanged={setCompany} />
          <CompanyImage kind="signature" file={company.signature} onChanged={setCompany} />
        </div>
        {channels && (
          <p className="admin-hint">
            Отправка PDF: e-mail — {channels.email ? "настроен" : "не настроен (SMTP_HOST, SMTP_FROM в .env)"}; Telegram —{" "}
            {channels.telegram ? "настроен" : "не настроен (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID в .env)"}.
          </p>
        )}
      </>
    );
  }

  return (
    <section id="company-section" className="dash-card dash-card-full">
      <div className="crm-toolbar">
        <div>
          <h2>Реквизиты компании</h2>
          <p className="admin-hint">
            Печатаются в счетах на оплату и актах выполненных работ. Незаполненные поля выводятся прочерком — их можно
            дописать позже.
          </p>
        </div>
      </div>
      {content}
    </section>
  );
}
