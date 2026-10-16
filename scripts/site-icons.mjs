// Растровые иконки сайта из его favicon.svg: favicon.ico (16/32/48), apple-touch-icon.png, icon-192/512.png.
// Фавикон = знак «D» из логотипа шапки (brand/logo-mark.svg или mark из logo-media.svg).
// Запуск: node scripts/site-icons.mjs [public|public-media]
// Без аргумента — обе папки подряд.
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";

const root = resolve(import.meta.dirname, "..");
const targets = process.argv[2] ? [process.argv[2]] : ["public", "public-media"];

/** Знак «D» из полного логотипа (viewBox 288×64 → квадрат 64×64). */
function markFromLogo(svg, title) {
  const defs = svg.match(/<defs>[\s\S]*?<\/defs>/)?.[0] || "";
  const rect = svg.match(/<rect[^>]*\/>/)?.[0];
  const letter = svg.match(/<g fill="[^"]*" transform="[^"]*">[\s\S]*?<\/g>/)?.[0];
  if (!rect || !letter) throw new Error("Не удалось вырезать знак «D» из логотипа");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n  <title>${title}</title>\n  ${defs}${rect}\n  ${letter}\n</svg>\n`;
}

/** ICO с PNG внутри — так его читают все браузеры, начиная с Windows Vista. */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

async function buildIcons(dirName) {
  const dir = resolve(root, dirName);
  const faviconPath = resolve(dir, "favicon.svg");

  if (dirName === "public") {
    // Тот же знак, что в шапке слева от «Dinara BILab» (width/height только у корневого svg).
    await copyFile(resolve(root, "public/brand/logo-mark.svg"), faviconPath);
    let svg = await readFile(faviconPath, "utf8");
    svg = svg.replace(/^(<svg[^>]*?)\s+width="[^"]*"([^>]*>)/m, "$1$2");
    svg = svg.replace(/^(<svg[^>]*?)\s+height="[^"]*"([^>]*>)/m, "$1$2");
    await writeFile(faviconPath, svg.endsWith("\n") ? svg : svg + "\n");
  } else if (dirName === "public-media") {
    const logo = await readFile(resolve(root, "public/brand/logo-media.svg"), "utf8");
    await writeFile(faviconPath, markFromLogo(logo, "Dinara BILab Media"));
  }

  const svg = await readFile(faviconPath);
  const png = (size) => sharp(svg, { density: Math.ceil((72 * size) / 64) * 2 }).resize(size, size).png().toBuffer();

  const icoSizes = [16, 32, 48];
  const icoImages = await Promise.all(icoSizes.map(async (size) => ({ size, data: await png(size) })));
  await writeFile(resolve(dir, "favicon.ico"), ico(icoImages));
  await writeFile(resolve(dir, "apple-touch-icon.png"), await png(180));
  await writeFile(resolve(dir, "icon-192.png"), await png(192));
  await writeFile(resolve(dir, "icon-512.png"), await png(512));
  console.log("Иконки готовы:", dir);
}

for (const dir of targets) await buildIcons(dir);
