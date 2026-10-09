import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import StorefrontApp from "./StorefrontApp.jsx";
import { installClientErrorReporting } from "./lib/client-errors.js";
import { purgeLegacyLocalCrm } from "./lib/orders-db.js";
import { flushLeadOutbox } from "./chat/lead-outbox.js";
import "./styles/styles.css";
import "./styles/media.css";

installClientErrorReporting();
purgeLegacyLocalCrm();
// Заявки из чата, не дошедшие в прошлый визит, — после загрузки страницы, чтобы не мешать первому показу.
setTimeout(() => flushLeadOutbox().catch((err) => console.warn("Отложенные заявки из чата:", err)), 3000); // i18n-ignore: лог для разработчика

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <StorefrontApp />
    </BrowserRouter>
  </StrictMode>
);
