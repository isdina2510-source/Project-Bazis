import { useEffect, useRef, useState } from "react";
import { imageSrc } from "../lib/catalog.js";
import { MAX_VIDEO_BYTES, PORTFOLIO_KINDS, VIDEO_TYPES, uploadPortfolioFile } from "../lib/portfolio-api.js";
import { MAX_PHOTO_BYTES, compressImageFile } from "./image.js";

export const KIND_LABELS = {
  video: "Видео",
  cartoon: "Мультфильмы",
  photo: "ИИ-фото",
  invite: "Пригласительные",
  site: "Сайты",
};

const PHOTO_ERRORS = {
  unsupported_format:
    "Этот формат фото браузер не открывает (например, HEIC с iPhone). Сохраните фото как JPG или PNG и выберите снова.",
  image_too_large: `Фото слишком большое: даже после сжатия больше ${(MAX_PHOTO_BYTES / 1024 / 1024).toFixed(1)} МБ.`,
};

const MAX_VIDEO_MB = Math.round(MAX_VIDEO_BYTES / 1024 / 1024);

function initialForm(work) {
  return {
    kind: (work && work.kind) || "video",
    title: (work && work.title) || "",
    title_kk: (work && work.title_kk) || "",
    terms: (work && work.terms) || "",
    terms_kk: (work && work.terms_kk) || "",
    image: (work && work.image) || "",
    video: (work && work.video) || "",
  };
}

/** data:-URL от сжатия фото → Blob для загрузки (fetch(data:) запрещён CSP сайта). */
function dataUrlToBlob(dataUrl) {
  const [head, body] = dataUrl.split(",");
  const mime = (head.match(/^data:([^;]+)/) || [])[1] || "image/jpeg";
  const bytes = atob(body);
  const buffer = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) buffer[i] = bytes.charCodeAt(i);
  return new Blob([buffer], { type: mime });
}

/** Тип видео, если браузер его не указал (бывает на Windows): по расширению имени. */
function videoBlob(file) {
  if (VIDEO_TYPES.includes(file.type)) return file;
  const ext = String(file.name || "").toLowerCase().split(".").pop();
  const type = { mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime" }[ext];
  return type ? new Blob([file], { type }) : null;
}

/** work: null — новая работа, объект — правка. onSave(work) сохраняет весь список и бросает ошибку при неудаче. */
export default function PortfolioModal({ work, onClose, onSave }) {
  const isEdit = !!work;
  const [form, setForm] = useState(() => initialForm(work));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploads, setUploads] = useState({});
  const [dragOver, setDragOver] = useState(false);
  const titleRef = useRef(null);
  const abortRef = useRef(new AbortController());

  useEffect(() => {
    titleRef.current?.focus();
    const controller = abortRef.current;
    return () => controller.abort();
  }, []);

  const set = (name) => (event) => setForm((prev) => ({ ...prev, [name]: event.target.value }));
  const busyUploading = Object.values(uploads).some((value) => value != null);

  const upload = async (field, blob) => {
    setError("");
    setUploads((prev) => ({ ...prev, [field]: 0 }));
    try {
      const path = await uploadPortfolioFile(blob, {
        signal: abortRef.current.signal,
        onProgress: (share) => setUploads((prev) => ({ ...prev, [field]: share })),
      });
      setForm((prev) => ({ ...prev, [field]: path }));
    } catch (err) {
      if (err && (err.code === "aborted" || err.code === "unauthorized")) return;
      setError(String((err && err.message) || "Не удалось загрузить файл"));
    } finally {
      setUploads((prev) => ({ ...prev, [field]: null }));
    }
  };

  const applyPhoto = async (file) => {
    if (!file) return;
    let dataUrl;
    try {
      dataUrl = await compressImageFile(file);
    } catch (err) {
      setError(PHOTO_ERRORS[err && err.message] || "Не удалось прочитать файл фото. Попробуйте другой файл.");
      return;
    }
    await upload("image", dataUrlToBlob(dataUrl));
  };

  const applyVideo = async (file) => {
    if (!file) return;
    const blob = videoBlob(file);
    if (!blob) {
      setError("Видео должно быть в формате MP4, WebM или MOV.");
      return;
    }
    if (blob.size > MAX_VIDEO_BYTES) {
      setError(`Видео больше ${MAX_VIDEO_MB} МБ. Сожмите его (например, в 1080p) и загрузите снова.`);
      return;
    }
    await upload("video", blob);
  };

  const submit = async (event) => {
    event.preventDefault();
    if (saving || busyUploading) return;
    const title = form.title.trim();
    if (!title) {
      setError("Укажите название");
      return;
    }
    if (!form.image && !form.video) {
      setError("Добавьте фото или видео");
      return;
    }
    setError("");
    setSaving(true);
    try {
      await onSave({
        ...(work || {}),
        kind: form.kind,
        title,
        title_kk: form.title_kk.trim(),
        terms: form.terms.trim(),
        terms_kk: form.terms_kk.trim(),
        image: form.image,
        video: form.video,
      });
    } catch (err) {
      if (err && err.code === "unauthorized") return;
      setError(String((err && err.message) || "Не удалось сохранить. Проверьте сервер и пароль."));
      setSaving(false);
    }
  };

  const progressText = (field) =>
    uploads[field] != null ? `Загрузка… ${Math.round(uploads[field] * 100)}%` : "";

  return (
    <div className="product-modal">
      <div className="product-modal-backdrop" onClick={onClose} />
      <div className="product-modal-panel" role="dialog" aria-modal="true" aria-labelledby="work-form-title">
        <header className="product-modal-head">
          <h2 id="work-form-title">{isEdit ? "Редактировать работу" : "Новая работа"}</h2>
          <button type="button" className="product-modal-close" onClick={onClose} aria-label="Закрыть">
            ×
          </button>
        </header>

        <form className="dash-form modal-form" onSubmit={submit}>
          <label>
            Тип работы
            <select name="kind" value={form.kind} onChange={set("kind")}>
              {PORTFOLIO_KINDS.map((id) => (
                <option key={id} value={id}>
                  {KIND_LABELS[id]}
                </option>
              ))}
            </select>
          </label>

          <label>
            Название
            <input
              ref={titleRef}
              type="text"
              required
              maxLength={120}
              placeholder="Например: Рекламный ролик для кофейни"
              value={form.title}
              onChange={set("title")}
            />
          </label>
          <label>
            Название на казахском (необязательно)
            <input type="text" maxLength={120} value={form.title_kk} onChange={set("title_kk")} />
          </label>

          <div className="photo-field">
            <span>Фото (обложка)</span>
            <label
              className={"photo-drop" + (dragOver ? " is-dragover" : "")}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragOver(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragOver(false);
                applyPhoto(event.dataTransfer?.files?.[0]);
              }}
            >
              <input
                type="file"
                accept="image/*"
                hidden
                disabled={uploads.image != null}
                onChange={(event) => {
                  applyPhoto(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
              {uploads.image != null ? (
                <span>{progressText("image")}</span>
              ) : form.image ? (
                <img src={imageSrc(form.image)} alt="" />
              ) : (
                <span>Нажмите или перетащите изображение</span>
              )}
            </label>
            {form.image && uploads.image == null && (
              <button type="button" className="dash-btn" onClick={() => setForm((prev) => ({ ...prev, image: "" }))}>
                Убрать фото
              </button>
            )}
          </div>

          <div className="photo-field">
            <span>Видео (MP4, WebM или MOV, до {MAX_VIDEO_MB} МБ)</span>
            {form.video && uploads.video == null ? (
              <video
                className="portfolio-video-preview"
                src={imageSrc(form.video)}
                poster={form.image ? imageSrc(form.image) : undefined}
                controls
                preload="metadata"
              />
            ) : (
              <label className="photo-drop">
                <input
                  type="file"
                  accept="video/mp4,video/webm,video/quicktime,.mp4,.m4v,.webm,.mov"
                  hidden
                  disabled={uploads.video != null}
                  onChange={(event) => {
                    applyVideo(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
                <span>{uploads.video != null ? progressText("video") : "Нажмите, чтобы выбрать видео"}</span>
                {uploads.video != null && (
                  <progress className="portfolio-progress" max={1} value={uploads.video} />
                )}
              </label>
            )}
            {form.video && uploads.video == null && (
              <button type="button" className="dash-btn" onClick={() => setForm((prev) => ({ ...prev, video: "" }))}>
                Убрать видео
              </button>
            )}
            <p className="admin-hint">Без фото обложкой станет первый кадр видео.</p>
          </div>

          <label>
            Условия
            <textarea
              rows={5}
              maxLength={2000}
              placeholder={"Например:\nСтоимость — от 30 000 ₸\nСрок — 3–5 дней\nДве правки бесплатно"}
              value={form.terms}
              onChange={set("terms")}
            />
          </label>
          <label>
            Условия на казахском (необязательно)
            <textarea rows={4} maxLength={2000} value={form.terms_kk} onChange={set("terms_kk")} />
          </label>

          {error && (
            <p className="form-inline-error admin-error" role="alert">
              {error}
            </p>
          )}

          <div className="dash-form-actions">
            <button type="submit" className="dash-btn dash-btn-fill" disabled={saving || busyUploading}>
              {saving ? "Сохраняем…" : busyUploading ? "Ждём загрузку…" : isEdit ? "Обновить" : "Сохранить"}
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
