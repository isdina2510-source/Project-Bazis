import { Route, Routes } from "react-router-dom";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import StoreErrorScreen from "./components/StoreErrorScreen.jsx";
import { LangGate, NearestSection, RootGate } from "./i18n/routing.jsx";
import ArticlePage from "./pages/ArticlePage.jsx";
import ArticlesPage from "./pages/ArticlesPage.jsx";
import HomePage from "./pages/HomePage.jsx";
import MediaHomePage from "./pages/MediaHomePage.jsx";
import ShopPage from "./pages/ShopPage.jsx";
import { IS_MEDIA } from "./site.js";
import { StoreProvider } from "./store/StoreContext.jsx";

const pages = (
  <>
    <Route index element={IS_MEDIA ? <MediaHomePage /> : <HomePage />} />
    <Route path="shop" element={<ShopPage />} />
    <Route path="articles" element={<ArticlesPage />} />
    <Route path="articles/:slug" element={<ArticlePage />} />
    <Route path="*" element={<NearestSection />} />
  </>
);

/** Витрина внутри роутера (BrowserRouter — в main.jsx, в тестах — MemoryRouter). */
export default function StorefrontApp() {
  return (
    <ErrorBoundary name="store" fallback={() => <StoreErrorScreen />}>
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
    </ErrorBoundary>
  );
}
