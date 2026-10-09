import { responsiveSources } from "../lib/images.js";

/**
 * Адаптивная картинка: srcset + sizes, width/height против сдвига вёрстки.
 * priority — главная картинка первого экрана: без lazy, с fetchpriority="high".
 */
export default function ResponsiveImage({
  src,
  alt,
  width,
  height,
  sizes,
  widths,
  ratio,
  priority = false,
  className,
}) {
  const { src: fallback, srcSet, sources } = responsiveSources(src, { widths, ratio });
  const img = (
    <img
      className={className}
      src={fallback}
      srcSet={srcSet}
      sizes={srcSet ? sizes : undefined}
      alt={alt}
      width={width}
      height={height}
      loading={priority ? undefined : "lazy"}
      decoding={priority ? undefined : "async"}
      fetchPriority={priority ? "high" : undefined}
    />
  );

  if (!sources.length) return img;
  return (
    <picture>
      {sources.map((source) => (
        <source key={source.type} type={source.type} srcSet={source.srcSet} sizes={sizes} />
      ))}
      {img}
    </picture>
  );
}
