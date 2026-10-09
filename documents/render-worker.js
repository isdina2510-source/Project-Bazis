/**
 * Поток сборки PDF: pdfmake занимает процессор, поэтому работает вне основного потока сервера.
 * Сообщение: { id, template, data } → ответ { id, ok, pdf } или { id, ok: false, error }.
 */
const { parentPort } = require("worker_threads");
const fs = require("fs");
const path = require("path");
const pdfmake = require("pdfmake");
const { invoiceDoc } = require("./templates/invoice");
const { actDoc } = require("./templates/act");
const { catalogDoc, productDoc } = require("./templates/catalog");
const { leadDoc } = require("./templates/lead");

const TEMPLATES = { invoice: invoiceDoc, act: actDoc, catalog: catalogDoc, product: productDoc, lead: leadDoc };

const FONTS_DIR = path.join(__dirname, "fonts");
pdfmake.virtualfs.writeFileSync("Inter-Regular.ttf", fs.readFileSync(path.join(FONTS_DIR, "Inter-Regular.ttf")));
pdfmake.virtualfs.writeFileSync("Inter-Bold.ttf", fs.readFileSync(path.join(FONTS_DIR, "Inter-Bold.ttf")));
pdfmake.setFonts({
  Inter: {
    normal: "Inter-Regular.ttf",
    bold: "Inter-Bold.ttf",
    italics: "Inter-Regular.ttf",
    bolditalics: "Inter-Bold.ttf",
  },
});
// Картинки приходят готовыми data-URL: ни сеть, ни диск документу не нужны.
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy(() => false);

parentPort.on("message", async ({ id, template, data }) => {
  try {
    const build = TEMPLATES[template];
    if (!build) throw new Error("Неизвестный шаблон: " + template);
    const buffer = await pdfmake.createPdf(build(data)).getBuffer();
    // Buffer из пула Node — это вид на чужой ArrayBuffer. Передавать его нельзя: postMessage
    // отвечает DataCloneError, номер документа уже занят, а файла нет.
    const pdf = new Uint8Array(buffer.byteLength);
    pdf.set(buffer);
    parentPort.postMessage({ id, ok: true, pdf }, [pdf.buffer]);
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String((err && err.stack) || err) });
  }
});
