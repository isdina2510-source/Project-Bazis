export const BRAND_NAME = "Dinara BILab";

/** Текст, где название бренда не переводится в верхний регистр (text-transform у подписей): BILab, а не BILAB. */
export default function BrandText({ children }) {
  const text = String(children ?? "");
  const parts = text.split(BRAND_NAME);
  if (parts.length === 1) return text;
  return parts.flatMap((part, i) =>
    i === 0 ? [part] : [<span key={i} className="brand-name">{BRAND_NAME}</span>, part]
  );
}
