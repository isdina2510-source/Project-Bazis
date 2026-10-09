// Тесты фронтенда (*.test.js / *.test.jsx в src) в jsdom; серверные тесты — node --test (см. npm test).
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    __SITE_URLS__: JSON.stringify({}),
    __BUILD_ID__: JSON.stringify("test"),
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{js,jsx}"],
    setupFiles: ["src/test/setup.js"],
    restoreMocks: true,
  },
});
