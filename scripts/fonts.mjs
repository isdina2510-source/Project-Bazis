// Сабсет шрифтов: исходники в assets-src/fonts → WOFF2 в public/fonts
// и статические TTF для PDF-документов в documents/fonts (pdfkit не умеет вариативные шрифты).
// Перед сабсетом проверяет, что во всех начертаниях есть глифы тестовой строки
// и что у букв с диакритикой знак действительно нарисован (Ğ ≠ G).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import * as fontkit from "fontkit";
import subsetFont from "subset-font";

const ROOT = resolve(import.meta.dirname, "..");
const OUT_DIR = resolve(ROOT, "public/fonts");
const PDF_OUT_DIR = resolve(ROOT, "documents/fonts");

export const TEST_STRING =
  "Әә Ғғ Ққ Ңң Өө Ұұ Үү Һһ Іі — Ää Ğğ Ññ Öö Şş Ūū Üü İı — 12 500 ₸ — «Қазақстан Республикасы»";

const range = (from, to) => {
  let s = "";
  for (let c = from; c <= to; c++) s += String.fromCodePoint(c);
  return s;
};

const SUBSET_TEXT = [
  range(0x20, 0x7e), // Basic Latin
  range(0xa0, 0xff), // Latin-1: « » неразрывный пробел
  range(0x100, 0x17f), // Latin Extended-A (казахская латиница: Ğ Ş Ū İ ı)
  range(0x218, 0x21b),
  range(0x400, 0x45f), // кириллица
  range(0x490, 0x493), // Ґ ґ Ғ ғ
  "ҚқҢңҮүҰұҺһӘәӨө",
  range(0x2010, 0x2027), // тире, кавычки, многоточие
  "\u2009\u202f№₸₽€™−×→←↑↓",
].join("");

const FONTS = [
  {
    src: "assets-src/fonts/Inter-Variable.ttf",
    out: "inter-var.woff2",
    axes: { wght: { min: 400, max: 700 }, opsz: 14 },
    checkWeights: [400, 500, 600, 700],
    pdf: [
      { wght: 400, out: "Inter-Regular.ttf" },
      { wght: 700, out: "Inter-Bold.ttf" },
    ],
  },
];

function missingGlyphs(font, text) {
  const chars = [...new Set([...text])].filter((ch) => ch.trim());
  return chars.filter((ch) => !font.hasGlyphForCodePoint(ch.codePointAt(0)));
}

/** Буквы, у которых глиф совпадает с базовой буквой без диакритики. */
function lostDiacritics(font, text) {
  const outline = (ch) => font.layout(ch).glyphs.map((g) => g.path.toSVG()).join("|");
  return [...new Set([...text])].filter((ch) => {
    const base = ch.normalize("NFD")[0];
    return base !== ch && /\p{L}/u.test(base) && outline(ch) === outline(base);
  });
}

let failed = false;
mkdirSync(OUT_DIR, { recursive: true });

for (const cfg of FONTS) {
  const buffer = readFileSync(resolve(ROOT, cfg.src));
  const font = fontkit.create(buffer);

  for (const wght of cfg.checkWeights) {
    const instance = font.variationAxes?.wght ? font.getVariation({ ...pinned(cfg.axes), wght }) : font;
    const missing = missingGlyphs(instance, TEST_STRING);
    const lost = lostDiacritics(instance, TEST_STRING);
    if (missing.length || lost.length) {
      failed = true;
      if (missing.length) console.error(`✗ ${cfg.src} wght=${wght}: нет глифов: ${missing.join(" ")}`);
      if (lost.length) console.error(`✗ ${cfg.src} wght=${wght}: нет диакритики: ${lost.join(" ")}`);
    } else {
      console.log(`✓ ${cfg.src} wght=${wght}: тестовая строка — все глифы и диакритика на месте`);
    }
  }

  const woff2 = await subsetFont(buffer, SUBSET_TEXT, {
    targetFormat: "woff2",
    variationAxes: cfg.axes,
  });
  writeFileSync(resolve(OUT_DIR, cfg.out), woff2);
  console.log(`→ public/fonts/${cfg.out}: ${(woff2.length / 1024).toFixed(1)} КБ`);

  for (const pdf of cfg.pdf || []) {
    const ttf = await subsetFont(buffer, SUBSET_TEXT, {
      targetFormat: "sfnt",
      variationAxes: { ...pinned(cfg.axes), wght: pdf.wght },
    });
    const instance = fontkit.create(ttf);
    const missing = missingGlyphs(instance, TEST_STRING);
    if (missing.length || Object.keys(instance.variationAxes || {}).length) {
      failed = true;
      console.error(`✗ documents/fonts/${pdf.out}: ` + (missing.length ? "нет глифов: " + missing.join(" ") : "шрифт остался вариативным"));
      continue;
    }
    mkdirSync(PDF_OUT_DIR, { recursive: true });
    writeFileSync(resolve(PDF_OUT_DIR, pdf.out), ttf);
    console.log(`→ documents/fonts/${pdf.out}: ${(ttf.length / 1024).toFixed(1)} КБ`);
  }
}

function pinned(axes) {
  return Object.fromEntries(Object.entries(axes).filter(([, v]) => typeof v === "number"));
}

if (failed) process.exit(1);
