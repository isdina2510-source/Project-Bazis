import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import AdminApp from "./AdminApp.jsx";
import { setLang } from "../i18n/index.js";
import { installClientErrorReporting } from "../lib/client-errors.js";
import { purgeLegacyLocalCrm } from "../lib/orders-db.js";
import "../styles/admin.css";

setLang("ru");
installClientErrorReporting();
purgeLegacyLocalCrm();

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>
);
