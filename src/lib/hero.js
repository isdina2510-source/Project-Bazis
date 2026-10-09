import { IMAGE_WIDTHS } from "./images.js";

/** Главная картинка первого экрана; по этим же параметрам vite.config.mjs пишет preload в index.html. */
export const HERO_IMAGE = {
  src: "https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=1400&q=80",
  width: 1400,
  height: 1750,
  ratio: 4 / 5,
  widths: IMAGE_WIDTHS,
  sizes: "(max-width: 900px) calc(100vw - 2.4rem), 520px",
};
