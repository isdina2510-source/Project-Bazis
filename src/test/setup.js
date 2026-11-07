import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { retryPolicy } from "../lib/api.js";

// Повторы запросов идут, но без пауз — иначе findBy* не дождётся ответа.
retryPolicy.delaysMs = [0, 0];

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
