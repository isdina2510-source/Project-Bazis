import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { LangGate, NearestSection, RootGate } from "./i18n/routing.jsx";
import ArticlePage from "./pages/ArticlePage.jsx";
import ArticlesPage from "./pages/ArticlesPage.jsx";
import HomePage from "./pages/HomePage.jsx";
import MediaHomePage from "./pages/MediaHomePage.jsx";
import ShopPage from "./pages/ShopPage.jsx";
import { purgeLegacyLocalCrm } from "./lib/orders-db.js";
import { IS_MEDIA } from "./site.js";
import { StoreProvider } from "./store/StoreContext.jsx";
import "./styles/styles.css";
import "./styles/media.css";

purgeLegacyLocalCrm();

const pages = (
  <>
    <Route index element={IS_MEDIA ? <MediaHomePage /> : <HomePage />} />
    <Route path="shop" element={<ShopPage />} />
    <Route path="articles" element={<ArticlesPage />} />
    <Route path="articles/:slug" element={<ArticlePage />} />
    <Route path="*" element={<NearestSection />} />
  </>
);

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <StoreProvider>
        <Routes>
          <Route path=":lang" element={<LangGate />}>
            {pages}
          </Route>
          <Route path="/" element={<RootGate />}>
            {pages}
          </Route>
        </Routes>
      </StoreProvider>
    </BrowserRouter>
  </StrictMode>
);
