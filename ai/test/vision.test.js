const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");
const { createAiCore, loadAiConfig } = require("..");
const { loadFeatures } = require("../features");
const { parseAttachment } = require("../lib/attachments");
const { encodePng, sniffImageMime, pixelsToPngDataUrl } = require("../lib/image");

const FAST = { ...loadAiConfig({}), retryBaseMs: 1, retryMaxMs: 5, deadlineMs: 3000, log: false };

/** Шумная картинка: плохо сжимается, поэтому не отсеивается как иконка. */
function pngBuffer(width, height, seed = 90) {
  const data = new Uint8Array(width * height * 3);
  let x = seed;
  for (let i = 0; i < data.length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    data[i] = x >>> 24;
  }
  return encodePng({ data, width, height, channels: 3 });
}

const pngDataUrl = (w = 8, h = 8) => "data:image/png;base64," + pngBuffer(w, h).toString("base64");
const isMain = (call) => String(call.messages[0].content).startsWith("Ты ИИ-консультант");
const isNotes = (call) => String(call.messages[0].content).startsWith("Опиши");

function fakeProvider(answer = (args) => (isNotes(args) ? "1. Схема склада" : "Вижу схему")) {
  const calls = [];
  return { name: "fake", configured: true, model: "main", calls, chat: async (args) => (calls.push(args), answer(args)) };
}

function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = zlib.deflateRawSync(Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** PDF-«скан»: одна страница, на ней только картинка без текста. */
function makeScanPdf(w = 300, h = 400) {
  const raw = Buffer.alloc(w * h);
  for (let i = 0; i < raw.length; i++) raw[i] = (i % w) % 20 < 10 ? 30 : 230;
  const img = zlib.deflateSync(raw);
  const content = Buffer.from("q 500 0 0 700 50 50 cm /Im1 Do Q");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>",
    ["<< /Length " + content.length + " >>", content],
    [`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.length} >>`, img],
  ];
  const parts = [Buffer.from("%PDF-1.4\n")];
  const off = [];
  let size = parts[0].length;
  objs.forEach((o, i) => {
    off.push(size);
    const chunk = Array.isArray(o)
      ? Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${o[0]}\nstream\n`), o[1], Buffer.from("\nendstream\nendobj\n")])
      : Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`);
    parts.push(chunk);
    size += chunk.length;
  });
  parts.push(
    Buffer.from(
      "xref\n0 6\n0000000000 65535 f \n" + off.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("") +
        "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + size + "\n%%EOF\n"
    )
  );
  return Buffer.concat(parts);
}

const asFile = (name, type, buffer) => ({ name, type, size: buffer.length, data: "data:" + type + ";base64," + buffer.toString("base64") });

test("PNG-кодировщик: валидная сигнатура и уменьшение крупных картинок", () => {
  assert.equal(sniffImageMime(pngBuffer(10, 10)), "image/png");
  const big = { data: new Uint8Array(3000 * 2000 * 3).fill(200), width: 3000, height: 2000, channels: 3 };
  const out = pixelsToPngDataUrl(big, { maxSide: 1000 });
  assert.equal(out.width, 1000);
  assert.equal(out.height, 667);
});

test("картинки внутри DOCX уходят вместе с текстом", async () => {
  const zip = makeZip({
    "word/document.xml": "<w:p><w:r><w:t>Схема отдела</w:t></w:r></w:p>",
    "word/media/image1.png": pngBuffer(64, 64),
    "word/media/image2.emf": Buffer.alloc(5000, 1),
  });
  const item = await parseAttachment(asFile("схема.docx", "application/octet-stream", zip));
  assert.equal(item.kind, "text");
  assert.equal(item.images.length, 1, "EMF не поддерживается моделью и пропускается");
  assert.match(item.images[0].dataUrl, /^data:image\/png;base64,/);
  assert.match(item.summary, /изображений внутри: 1/);
});

test("PDF-скан: страницы передаются модели картинками", async () => {
  const item = await parseAttachment(asFile("скан.pdf", "application/pdf", makeScanPdf()));
  assert.equal(item.kind, "text", item.error);
  assert.equal(item.images.length, 1);
  assert.equal(item.images[0].name, "страница 1");
  assert.match(item.summary, /текстового слоя нет/);
});

test("консультант видит фото и картинки документов, а описание возвращается для истории", async () => {
  const provider = fakeProvider();
  const ai = createAiCore({ provider, features: loadFeatures(), config: FAST });
  const result = await ai.run("consultant", {
    message: "что на схеме?",
    attachments: [
      { kind: "image", name: "фото.png", dataUrl: pngDataUrl() },
      { kind: "text", name: "план.docx", text: "План", images: [{ name: "image1.png", dataUrl: pngDataUrl() }] },
    ],
  });
  assert.equal(result.text, "Вижу схему");
  assert.equal(result.imageNotes, "1. Схема склада");
  const main = provider.calls.find(isMain);
  const parts = main.messages.at(-1).content;
  assert.equal(parts.filter((p) => p.type === "image_url").length, 2);
  assert.equal(parts[1].image_url.detail, "auto", "ядро проставляет detail из настроек");
  const notes = provider.calls.find(isNotes);
  assert.equal(notes.messages[1].content[1].image_url.detail, "low");
});

test("AI_VISION_MODEL: запросы с картинками идут в модель со зрением", async () => {
  const provider = fakeProvider(() => "ok");
  const ai = createAiCore({
    provider,
    features: loadFeatures(),
    config: { ...FAST, ...loadAiConfig({ AI_VISION_MODEL: "gpt-4o" }), log: false, deadlineMs: 3000 },
  });
  await ai.run("consultant", { message: "цена сайта" });
  assert.ok(provider.calls.every((c) => c.model === "main"), "без картинок — основная модель");
  const before = provider.calls.length;
  await ai.run("consultant", { message: "фото", attachments: [{ kind: "image", name: "a.png", dataUrl: pngDataUrl() }] });
  assert.ok(provider.calls.slice(before).every((c) => c.model === "gpt-4o"));
});

test("AI_VISION=0: картинки заменяются пометкой, запрос не падает", async () => {
  const provider = fakeProvider(() => "ok");
  const ai = createAiCore({ provider, features: loadFeatures(), config: { ...FAST, vision: false } });
  await ai.run("consultant", { message: "фото", attachments: [{ kind: "image", name: "a.png", dataUrl: pngDataUrl() }] });
  for (const call of provider.calls) {
    const content = call.messages.at(-1).content;
    assert.ok(Array.isArray(content) ? !content.some((p) => p.type === "image_url") : true);
  }
  const main = provider.calls.find(isMain);
  assert.match(JSON.stringify(main.messages.at(-1).content), /просмотр картинок отключён/);
});
