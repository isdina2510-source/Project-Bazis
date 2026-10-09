// Адаптивные варианты локальных фото: images/** → images/optimized/<имя>-<ширина>.{avif,webp,jpg}
// и манифест src/generated/images-manifest.json для компонента <ResponsiveImage>.
// Запускается перед dev/build; пересобирает только изменённые файлы.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, extname } from "node:path";
import sharp from "sharp";

const ROOT = resolve(import.meta.dirname, "..");
const SRC_DIR = resolve(ROOT, "images");
const OUT_DIR = resolve(SRC_DIR, "optimized");
const MANIFEST = resolve(ROOT, "src/generated/images-manifest.json");

export const WIDTHS = [360, 480, 768, 1080, 1440, 1920];
const INPUT_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const FORMATS = {
  avif: (img) => img.avif({ quality: 50, effort: 4 }),
  webp: (img) => img.webp({ quality: 72 }),
  jpg: (img) => img.jpeg({ quality: 75, mozjpeg: true, progressive: true }),
};
const HEAVY_BYTES = 200 * 1024;

function listSources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full !== OUT_DIR) out.push(...listSources(full));
    } else if (INPUT_EXT.has(extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

/** Латиница, нижний регистр, через дефис. */
function slug(relPath) {
  return relPath
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function pickWidths(original) {
  const widths = WIDTHS.filter((w) => w <= original);
  const top = Math.min(original, WIDTHS[WIDTHS.length - 1]);
  if (!widths.length || widths[widths.length - 1] < top) widths.push(top);
  return widths;
}

const kb = (bytes) => (bytes / 1024).toFixed(1) + " КБ";

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(resolve(MANIFEST, ".."), { recursive: true });

const manifest = {};
const produced = new Set();

for (const file of listSources(SRC_DIR)) {
  const key = relative(ROOT, file).replace(/\\/g, "/");
  const name = slug(relative(SRC_DIR, file).replace(/\\/g, "/"));
  const srcStat = statSync(file);

  let meta;
  try {
    meta = await sharp(file).rotate().metadata();
  } catch (err) {
    console.warn(`⚠ ${key}: не удалось прочитать (${err.message}) — пропускаю`);
    continue;
  }
  const swap = (meta.orientation || 1) >= 5;
  const width = swap ? meta.height : meta.width;
  const height = swap ? meta.width : meta.height;
  const widths = pickWidths(width);

  let built = 0;
  const sizes = [];
  for (const w of widths) {
    for (const [ext, encode] of Object.entries(FORMATS)) {
      const outName = `${name}-${w}.${ext}`;
      const outPath = join(OUT_DIR, outName);
      produced.add(outName);
      if (!existsSync(outPath) || statSync(outPath).mtimeMs < srcStat.mtimeMs) {
        await encode(sharp(file).rotate().resize({ width: w, withoutEnlargement: true })).toFile(outPath);
        built++;
      }
      if (ext === "avif") sizes.push(`${w}:${kb(statSync(outPath).size)}`);
    }
  }

  manifest[key] = { width, height, widths, base: `/images/optimized/${name}` };
  const heavy = srcStat.size > HEAVY_BYTES ? ` (исходник ${kb(srcStat.size)} > 200 КБ)` : "";
  console.log(`${built ? "→" : "✓"} ${key} ${width}×${height}${heavy}; avif ${sizes.join(", ")}`);
}

for (const old of readdirSync(OUT_DIR)) {
  if (!produced.has(old)) rmSync(join(OUT_DIR, old));
}

writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Манифест: ${relative(ROOT, MANIFEST)} (${Object.keys(manifest).length} изобр.)`);
