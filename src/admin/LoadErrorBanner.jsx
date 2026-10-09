/** Данные не загрузились: текст и «Повторить» вместо пустого списка. */
export default function LoadErrorBanner({ text, onRetry, retrying = false }) {
  return (
    <div className="admin-load-banner" role="alert">
      <p>{text}</p>
      {onRetry && (
        <button type="button" className="dash-btn" onClick={onRetry} disabled={retrying}>
          {retrying ? "Загружаем…" : "Повторить"}
        </button>
      )}
    </div>
  );
}
