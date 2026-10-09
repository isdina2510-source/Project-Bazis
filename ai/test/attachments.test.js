const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");
const { parseAttachment, parseAttachments } = require("../lib/attachments");
const { encodePng } = require("../lib/image");

function tinyPng(width = 4, height = 4) {
  return encodePng({ data: new Uint8Array(width * height * 3).fill(128), width, height, channels: 3 });
}
const { createAiCore, loadAiConfig } = require("..");
const { loadFeatures } = require("../features");

function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = zlib.deflateRawSync(Buffer.from(content, "utf8"));
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

function makePdf(text) {
  const content = zlib.deflateSync(Buffer.from("BT /F1 12 Tf 72 720 Td (" + text + ") Tj ET", "latin1"));
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const parts = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets = [];
  let size = parts[0].length;
  objects.forEach((body, i) => {
    offsets.push(size);
    const chunk =
      body === null
        ? Buffer.concat([
            Buffer.from(`${i + 1} 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
            content,
            Buffer.from("\nendstream\nendobj\n", "latin1"),
          ])
        : Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, "latin1");
    parts.push(chunk);
    size += chunk.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`;
  parts.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(parts);
}

const asFile = (name, type, buffer) => ({
  name,
  type,
  size: buffer.length,
  data: "data:" + (type || "application/octet-stream") + ";base64," + buffer.toString("base64"),
});

test("DOCX: абзацы и таблицы", async () => {
  const xml =
    '<w:document><w:body><w:p><w:r><w:t>Аудит отдела продаж</w:t></w:r></w:p>' +
    "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Роль</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>KPI &amp; план</w:t></w:r></w:p></w:tc></w:tr></w:tbl>" +
    "</w:body></w:document>";
  const item = await parseAttachment(asFile("отчёт.docx", "", makeZip({ "word/document.xml": xml })));
  assert.equal(item.kind, "text");
  assert.match(item.text, /Аудит отдела продаж/);
  assert.match(item.text, /Роль\s+KPI & план/);
  assert.match(item.summary, /Документ Word/);
});

test("XLSX: общие строки, числа, имена листов", async () => {
  const zip = makeZip({
    "xl/workbook.xml": '<workbook><sheets><sheet name="Продажи" r:id="rId1"/></sheets></workbook>',
    "xl/sharedStrings.xml": "<sst><si><t>Менеджер</t></si><si><r><t>Выру</t></r><r><t>чка</t></r></si><si><t>Анна</t></si></sst>",
    "xl/worksheets/sheet1.xml":
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>150000</v></c></row></sheetData></worksheet>',
  });
  const item = await parseAttachment(asFile("план.xlsx", "", zip));
  assert.equal(item.kind, "text");
  assert.match(item.text, /Лист «Продажи»/);
  assert.match(item.text, /Менеджер\tВыручка/);
  assert.match(item.text, /Анна\t\t150000/);
});

test("PDF со сжатым потоком читается", async () => {
  const item = await parseAttachment(asFile("brief.pdf", "application/pdf", makePdf("Business process audit brief")));
  assert.equal(item.kind, "text", item.error);
  assert.match(item.text, /Business process audit brief/);
});

test("PDF разбирается и в отдельном потоке (POST /api/ai/_attachments)", async () => {
  const { createAttachmentsPool } = require("../lib/attachments-pool");
  const [item] = await createAttachmentsPool().parse([asFile("brief.pdf", "application/pdf", makePdf("Pool brief"))]);
  assert.equal(item.kind, "text", item.error);
  assert.match(item.text, /Pool brief/);
});

test("RTF с кириллицей (\\'hh и \\u)", async () => {
  const rtf = Buffer.from(
    "{\\rtf1\\ansi\\ansicpg1251{\\fonttbl{\\f0 Times;}}\\f0 \\'cf\\'f0\\'e8\\'e2\\'e5\\'f2\\par \\u1052?\\u1080?\\u1088?}",
    "latin1"
  );
  const item = await parseAttachment(asFile("письмо.rtf", "application/rtf", rtf));
  assert.equal(item.kind, "text");
  assert.equal(item.text, "Привет\nМир");
});

test("текст в windows-1251 декодируется", async () => {
  const buf = Buffer.from([0xd0, 0xe5, 0xe3, 0xeb, 0xe0, 0xec, 0xe5, 0xed, 0xf2]);
  const item = await parseAttachment(asFile("заметка.txt", "text/plain", buf));
  assert.equal(item.text, "Регламент");
});

test("длинный текст обрезается с пометкой", async () => {
  const item = await parseAttachment(asFile("big.txt", "text/plain", Buffer.from("а".repeat(20000))));
  assert.equal(item.text.length, 12000);
  assert.equal(item.truncated, true);
});

test("битый data URL не роняет разбор вложения", async () => {
  const item = await parseAttachment({ kind: "image", name: "a.png", dataUrl: "data:image/png,%E0%A" });
  assert.equal(item.kind, "error");
});

test("изображения проверяются по содержимому, а не по заявленному типу", async () => {
  const heic = await parseAttachment({ kind: "image", name: "IMG.heic", dataUrl: "data:image/heic;base64,AAAA" });
  assert.equal(heic.kind, "error");
  const fake = await parseAttachment({ kind: "image", name: "a.png", dataUrl: "data:image/png;base64,aGVsbG8gd29ybGQh" });
  assert.equal(fake.kind, "error");
  const png = await parseAttachment({ kind: "image", name: "a.jpg", dataUrl: "data:image/jpeg;base64," + tinyPng().toString("base64") });
  assert.equal(png.kind, "image");
  assert.match(png.dataUrl, /^data:image\/png;base64,/, "тип исправлен по сигнатуре");
});

test("битый документ и неизвестный формат не роняют разбор", async () => {
  const broken = await parseAttachment(asFile("x.docx", "", Buffer.from("not a zip")));
  assert.equal(broken.kind, "error");
  const bin = await parseAttachment(asFile("x.bin", "application/octet-stream", Buffer.from([1, 2, 3])));
  assert.equal(bin.kind, "binary");
  const list = await parseAttachments([null, 5, asFile("a.txt", "text/plain", Buffer.from("ok text"))]);
  assert.equal(list.length, 1);
});

test("консультант получает извлечённый текст файла в промпте", async () => {
  const calls = [];
  const provider = { name: "fake", configured: true, model: "m", chat: async (args) => (calls.push(args), "ok") };
  const ai = createAiCore({ provider, features: loadFeatures(), config: { ...loadAiConfig({}), log: false } });
  const docx = makeZip({ "word/document.xml": "<w:p><w:r><w:t>Нужна карта процессов склада</w:t></w:r></w:p>" });
  // Как в браузере: файл разобран через /api/ai/_attachments, в чат уходит готовый текст.
  const [parsed] = await parseAttachments([asFile("задача.docx", "", docx)]);
  await ai.run("consultant", { message: "", attachments: [{ kind: "text", name: parsed.name, type: parsed.type, text: parsed.text }] });
  const main = calls.find((c) => String(c.messages[0].content).startsWith("Ты ИИ-консультант"));
  const user = main.messages.at(-1).content[0].text;
  assert.match(user, /Документ Word «задача\.docx»/);
  assert.match(user, /Нужна карта процессов склада/);
});
