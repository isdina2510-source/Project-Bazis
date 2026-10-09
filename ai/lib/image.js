/** Работа с изображениями без внешних зависимостей: определение формата, уменьшение, кодирование в PNG. */
const zlib = require("zlib");

/** Форматы, которые принимают vision-модели OpenAI-совместимых API. */
function sniffImageMime(buffer) {
  if (!buffer || buffer.length < 12) return "";
  if (buffer[0] === 0x89 && buffer.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.toString("latin1", 0, 4) === "GIF8") return "image/gif";
  if (buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return "";
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf);
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Пиксели { data, width, height, channels: 1 | 3 } → PNG. Фильтр Up хорошо жмёт сканы текста. */
function encodePng({ data, width, height, channels }) {
  const stride = width * channels;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    filtered[row] = y === 0 ? 0 : 2;
    for (let x = 0; x < stride; x++) {
      const cur = data[y * stride + x];
      filtered[row + 1 + x] = y === 0 ? cur : (cur - data[(y - 1) * stride + x]) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 1 ? 0 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(filtered, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Приводит пиксели к 1 (серый) или 3 (RGB) каналам; альфа накладывается на белый фон. */
function toGrayOrRgb({ data, width, height, channels }) {
  const count = width * height;
  if (channels === 1) return { data: Uint8Array.from(data.subarray(0, count)), width, height, channels: 1 };
  const rgb = new Uint8Array(count * 3);
  let colorful = 0;
  for (let i = 0; i < count; i++) {
    const s = i * channels;
    const a = channels === 4 ? data[s + 3] / 255 : 1;
    const r = Math.round(data[s] * a + 255 * (1 - a));
    const g = Math.round(data[s + 1] * a + 255 * (1 - a));
    const b = Math.round(data[s + 2] * a + 255 * (1 - a));
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
    if (Math.abs(r - g) > 16 || Math.abs(g - b) > 16) colorful++;
  }
  if (colorful > count * 0.01) return { data: rgb, width, height, channels: 3 };
  const gray = new Uint8Array(count);
  for (let i = 0; i < count; i++) gray[i] = rgb[i * 3 + 1];
  return { data: gray, width, height, channels: 1 };
}

/** Усреднение блоков до maxSide по большей стороне. */
function downscale(img, maxSide) {
  const { data, width, height, channels } = img;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  if (scale >= 1) return img;
  const nw = Math.max(1, Math.round(width * scale));
  const nh = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(nw * nh * channels);
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor((y * height) / nh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / nh));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor((x * width) / nw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / nw));
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        for (let sy = y0; sy < y1; sy++) {
          for (let sx = x0; sx < x1; sx++) sum += data[(sy * width + sx) * channels + c];
        }
        out[(y * nw + x) * channels + c] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
      }
    }
  }
  return { data: out, width: nw, height: nh, channels };
}

/** Сырые пиксели (например, страница скана из PDF) → data:image/png, не больше maxBytes. */
function pixelsToPngDataUrl(pixels, { maxSide = 1600, maxBytes = 2 * 1024 * 1024 } = {}) {
  let img = downscale(toGrayOrRgb(pixels), maxSide);
  for (let i = 0; i < 4; i++) {
    const png = encodePng(img);
    if (png.length <= maxBytes || Math.max(img.width, img.height) < 400) {
      return { dataUrl: "data:image/png;base64," + png.toString("base64"), width: img.width, height: img.height };
    }
    img = downscale(img, Math.round(Math.max(img.width, img.height) * 0.7));
  }
  return null;
}

module.exports = { sniffImageMime, encodePng, downscale, pixelsToPngDataUrl };
