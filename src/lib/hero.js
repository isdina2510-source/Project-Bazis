import { IMAGE_WIDTHS } from "./images.js";

/** Главная картинка первого экрана; по этим же параметрам vite.config.mjs пишет preload в index.html. */
export const HERO_IMAGE = {
  src: "images/hero/dinara.jpeg",
  width: 694,
  height: 1248,
  ratio: 4 / 5,
  widths: IMAGE_WIDTHS,
  sizes: "(max-width: 900px) calc(100vw - 2.4rem), 520px",
};
