import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import StorefrontApp from "./StorefrontApp.jsx";
import { installClientErrorReporting } from "./lib/client-errors.js";
import { purgeLegacyLocalCrm } from "./lib/orders-db.js";
import "./styles/styles.css";
import "./styles/media.css";

installClientErrorReporting();
purgeLegacyLocalCrm();

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <StorefrontApp />
    </BrowserRouter>
  </StrictMode>
);
