import { useState } from "react";

export default function RefreshButton({ onRefresh }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="dash-btn"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onRefresh();
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Обновляем…" : "Обновить"}
    </button>
  );
}
