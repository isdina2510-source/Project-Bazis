import ErrorBoundary from "../components/ErrorBoundary.jsx";

function AdminErrorScreen({ error, reset }) {
  const text = String((error && error.message) || error || "неизвестная ошибка");
  return (
    <section className="dash-card dash-card-full admin-crash" role="alert">
      <h2>Раздел не открылся из-за ошибки</h2>
      <p className="admin-crash-text">{text}</p>
      <p className="admin-hint">Данные на сервере не пострадали. Если ошибка повторяется — обновите страницу целиком.</p>
      <button type="button" className="dash-btn dash-btn-fill" onClick={reset}>
        Обновить раздел
      </button>
    </section>
  );
}

/** Ошибка в разделе админки не роняет остальные разделы: вместо него — текст ошибки и «Обновить раздел». */
export default function AdminErrorBoundary({ name, children }) {
  return (
    <ErrorBoundary name={"admin:" + name} fallback={(props) => <AdminErrorScreen {...props} />}>
      {children}
    </ErrorBoundary>
  );
}
