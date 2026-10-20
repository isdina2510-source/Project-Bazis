// Картинки превью ссылок (og:image, twitter:image) 1200×630 — их показывают мессенджеры и соцсети:
//   Dinara BILab        — портрет первого экрана images/hero/dinara.jpeg → public/og/dinara.jpg;
//   Dinara BILab Медиа  — логотип и услуги, без чужих фото → public-media/og/media.jpg.
// Логотипы — из SVG (контуры), текст — шрифтом Inter из documents/fonts: картинка одинаковая на Windows
// и в Docker-образе, где системных шрифтов нет. Пересобирается, только если исходники новее готового файла.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import sharp from "sharp";

const ROOT = resolve(import.meta.dirname, "..");
const WIDTH = 1200;
const HEIGHT = 630;
const LEFT = 80;
const FONTS = {
  regular: { name: "Inter", file: "documents/fonts/Inter-Regular.ttf" },
  bold: { name: "Inter Bold", file: "documents/fonts/Inter-Bold.ttf" },
};
const SHARED_INPUTS = ["scripts/og-image.mjs", FONTS.regular.file, FONTS.bold.file];

const escapeXml = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Строка текста прозрачным PNG; size — в пикселях. */
async function textLine(text, { size, color, weight = "regular" }) {
  const font = FONTS[weight];
  const input = await sharp({
    text: {
      text: `<span foreground="${color}">${escapeXml(text)}</span>`,
      font: `${font.name} ${size}`,
      fontfile: resolve(ROOT, font.file),
      dpi: 72,
      rgba: true,
    },
  })
    .png()
    .toBuffer();
  const { width } = await sharp(input).metadata();
  if (!width) throw new Error(`Не удалось отрисовать текст «${text}»`);
  return input;
}

async function logo(file, width) {
  return sharp(resolve(ROOT, file), { density: 144 }).resize({ width }).png().toBuffer();
}

async function lines(items) {
  return Promise.all(items.map(async ({ top, ...line }) => ({ input: await textLine(line.text, line), left: LEFT, top })));
}

async function bazisCard() {
  const photoWidth = 500;
  const ink = "#163528";
  const photo = await sharp(resolve(ROOT, "images/hero/dinara.jpeg"))
    .rotate()
    .resize({ width: photoWidth, height: HEIGHT, fit: "cover", position: "top" })
    .toBuffer();
  return sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: "#f3efe6" } }).composite([
    { input: await logo("public/brand/logo.svg", 270), left: LEFT, top: 150 },
    ...(await lines([
      { top: 250, size: 76, weight: "bold", color: ink, text: "Порядок" },
      { top: 335, size: 76, weight: "bold", color: ink, text: "в бизнесе." },
      { top: 445, size: 28, color: "#3f5c4d", text: "Консалтинг для владельцев бизнеса" },
    ])),
    { input: photo, left: WIDTH - photoWidth, top: 0 },
  ]);
}

async function mediaCard() {
  const background = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
  <defs>
    <radialGradient id="warm" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#ff3d7f" stop-opacity="0.85"/>
      <stop offset="0.45" stop-color="#ff7a45" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#7b5cff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="cool" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#7b5cff" stop-opacity="0.8"/>
      <stop offset="1" stop-color="#7b5cff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="#140f24"/>
  <circle cx="1030" cy="150" r="380" fill="url(#warm)"/>
  <circle cx="900" cy="600" r="300" fill="url(#cool)"/>
</svg>`;
  return sharp(Buffer.from(background)).composite([
    { input: await logo("public/brand/logo-media.svg", 432), left: LEFT, top: 120 },
    ...(await lines([
      { top: 255, size: 72, weight: "bold", color: "#faf8f3", text: "Видео, ИИ-фото" },
      { top: 337, size: 72, weight: "bold", color: "#faf8f3", text: "и сайты под ключ" },
      { top: 452, size: 28, color: "#c9c2dc", text: "Мультфильмы, пригласительные, оживление фото" },
    ])),
  ]);
}

const CARDS = [
  { out: "public/og/dinara.jpg", inputs: ["images/hero/dinara.jpeg", "public/brand/logo.svg"], build: bazisCard },
  { out: "public-media/og/media.jpg", inputs: ["public/brand/logo-media.svg"], build: mediaCard },
];

for (const { out, inputs, build } of CARDS) {
  const outPath = resolve(ROOT, out);
  const newest = Math.max(...[...SHARED_INPUTS, ...inputs].map((file) => statSync(resolve(ROOT, file)).mtimeMs));
  if (existsSync(outPath) && statSync(outPath).mtimeMs >= newest) {
    console.log(`✓ ${out}`);
    continue;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  const image = await build();
  await image.flatten().jpeg({ quality: 82, mozjpeg: true, progressive: true }).toFile(outPath);
  const meta = await sharp(outPath).metadata();
  if (meta.width !== WIDTH || meta.height !== HEIGHT) {
    throw new Error(`${relative(ROOT, outPath)}: ${meta.width}×${meta.height} вместо ${WIDTH}×${HEIGHT}`);
  }
  console.log(`→ ${out} ${WIDTH}×${HEIGHT}`);
}
