import manifest from "../generated/images-manifest.json";
import { imageSrc } from "./catalog.js";

export const IMAGE_WIDTHS = [360, 480, 768, 1080, 1440, 1920];

const UNSPLASH_HOST = "images.unsplash.com";

function unsplashUrl(src, width, ratio) {
  const url = new URL(src);
  const params = url.searchParams;
  // auto=format: CDN сам отдаёт AVIF / WebP / JPEG по заголовку Accept браузера.
  params.set("auto", "format");
  params.set("fit", "crop");
  params.set("q", "60");
  params.set("w", String(width));
  if (ratio) params.set("h", String(Math.round(width / ratio)));
  else params.delete("h");
  return url.toString();
}

/**
 * Источники для <picture>/<img>: srcset по ширинам, форматы AVIF/WebP с JPEG как запасным.
 * ratio — ширина/высота кадра (4/3 для карточек), чтобы CDN кадрировал сам.
 */
export function responsiveSources(rawSrc, { widths = IMAGE_WIDTHS, ratio } = {}) {
  const src = imageSrc(rawSrc);

  if (src.startsWith("https://" + UNSPLASH_HOST + "/")) {
    const srcSet = widths.map((w) => `${unsplashUrl(src, w, ratio)} ${w}w`).join(", ");
    const fallbackWidth = widths[Math.min(widths.length - 1, 2)];
    return { src: unsplashUrl(src, fallbackWidth, ratio), srcSet, sources: [] };
  }

  const entry = manifest[src.replace(/^\//, "")];
  if (entry) {
    const fitting = entry.widths.filter((w) => w <= Math.max(...widths));
    const usable = fitting.length ? fitting : [entry.widths[0]];
    const set = (ext) => usable.map((w) => `${entry.base}-${w}.${ext} ${w}w`).join(", ");
    const fallbackWidth = usable[Math.min(usable.length - 1, 2)];
    return {
      src: `${entry.base}-${fallbackWidth}.jpg`,
      srcSet: set("jpg"),
      sources: [
        { type: "image/avif", srcSet: set("avif") },
        { type: "image/webp", srcSet: set("webp") },
      ],
    };
  }

  return { src, srcSet: undefined, sources: [] };
}
