const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createStore } = require("../../db/store");
const { createDocuments } = require("..");
const { createRenderer } = require("../render");
const { createSender } = require("../send");

const ROOT = path.resolve(__dirname, "..", "..");
const silent = { log() {}, warn() {}, error() {} };
const normalizePhone = (raw) => String(raw || "").replace(/\D/g, "");
const normalizeProduct = (raw) => ({
  id: raw.id,
  title: String(raw.title || ""),
  description: String(raw.description || ""),
  price: Number(raw.price) || 0,
  currency: raw.currency || "KZT",
  kind: raw.kind === "product" ? "product" : "service",
  category: raw.category || "management",
  image: raw.image || "",
  stock: raw.stock == null ? null : raw.stock,
});
const PRODUCTS = [
  { id: "p1", title: "Аудит", description: "Диагностика", price: 150000, category: "management" },
  { id: "p2", title: "Пригласительные", description: "Той", price: 3000, kind: "product", category: "media", stock: 5 },
];
/** 1×1 PNG */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const renderer = createRenderer();
test.after(() => renderer.close());

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bazis-docs-"));
  const store = createStore({ dataDir, normalizePhone, normalizeProduct, defaultProducts: PRODUCTS, log: silent });
  const documents = createDocuments({ store, rootDir: ROOT, dataDir, log: silent, renderer });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { store, documents, dataDir };
}

function order(store, overrides = {}) {
  const now = new Date().toISOString();
  return store.orders.insert({
    id: "ord_" + Math.random().toString(36).slice(2),
    createdAt: now,
    updatedAt: now,
    channel: "whatsapp",
    status: "new",
    customerName: "Айгерим",
    customerPhone: "+7 701 000 00 01",
    items: [{ id: "p1", title: "Аудит", qty: 1, price: 150000, currency: "KZT", kind: "service" }],
    totalText: "",
    message: "",
    sourcePage: "",
    ...overrides,
  });
}

const year = () => Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Almaty", year: "numeric" }).format(new Date()));

test("счёт: номер по году с 1, повторный запрос не тратит номер, PDF кэшируется", async (t) => {
  const { store, documents, dataDir } = setup(t);
  documents.saveCompany({ name: "ИП «Базис»", invoicePrefix: "СЧ-" });
  const o = order(store);
  const [doc] = documents.issueForOrder(o.id, "invoice");
  assert.equal(doc.number, "СЧ-" + year() + "-0001");
  assert.equal(doc.title, "Счёт № " + doc.number);
  assert.equal(doc.outdated, false);
  assert.equal(doc.snapshot, undefined);
  assert.equal(documents.issueForOrder(o.id, "invoice")[0].id, doc.id);

  const [act] = documents.issueForOrder(o.id, "act");
  assert.equal(act.number, year() + "-0001");

  const pdf = await documents.documentPdf(doc.id);
  assert.equal(pdf.buffer.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.match(pdf.fileName, /^Счёт № СЧ-\d{4}-0001\.pdf$/);
  const cached = path.join(dataDir, "documents", String(doc.year), doc.id + ".pdf");
  assert.ok(fs.existsSync(cached));
  assert.ok((await documents.documentPdf(act.id)).buffer.length > 1000);
});

test("снимок не меняется вслед за заказом; перевыпуск аннулирует старый номер", async (t) => {
  const { store, documents } = setup(t);
  const o = order(store);
  const [first] = documents.issueForOrder(o.id, "invoice");
  store.orders.patch(o.id, { discount: 10000, delivery: 2000 });
  const [listed] = documents.listForOrder(o.id);
  assert.equal(listed.outdated, true);
  assert.equal(store.documents.get(first.id).snapshot.totals.total, 15000000);

  const second = documents.reissue(first.id);
  assert.equal(second.seq, 2);
  assert.equal(second.outdated, false);
  assert.equal(store.documents.get(second.id).snapshot.totals.total, 14200000);
  const old = documents.listForOrder(o.id).find((doc) => doc.id === first.id);
  assert.equal(old.status, "annulled");
  assert.equal(old.replacedBy, second.id);
  assert.throws(() => documents.reissue(first.id), { code: "document_annulled" });
  const annulledPdf = await documents.documentPdf(first.id);
  assert.match(annulledPdf.fileName, /аннулирован/);
});

test("заказ в двух валютах — отдельный счёт на каждую", (t) => {
  const { store, documents } = setup(t);
  const o = order(store, {
    items: [
      { id: "p1", title: "Аудит", qty: 1, price: 150000, currency: "KZT", kind: "service" },
      { id: "x", title: "Лицензия", qty: 1, price: 100, currency: "USD", kind: "product" },
    ],
  });
  const docs = documents.issueForOrder(o.id, "invoice");
  assert.deepEqual(docs.map((doc) => doc.currency).sort(), ["KZT", "USD"]);
  assert.deepEqual(docs.map((doc) => doc.seq).sort(), [1, 2]);
});

test("заявки, отменённые и пустые заказы документов не получают", (t) => {
  const { store, documents } = setup(t);
  const lead = order(store, { channel: "site", items: [] });
  assert.throws(() => documents.issueForOrder(lead.id, "invoice"), { code: "lead_has_no_documents" });
  const cancelled = order(store);
  store.orders.patch(cancelled.id, { status: "cancelled" });
  assert.throws(() => documents.issueForOrder(cancelled.id, "act"), { code: "order_cancelled" });
  assert.throws(() => documents.issueForOrder("ord_none", "invoice"), { code: "not_found", status: 404 });
  assert.throws(() => documents.issueForOrder(cancelled.id, "waybill"), { code: "invalid_kind" });
});

test("покупатель берётся из реквизитов клиента", (t) => {
  const { store, documents } = setup(t);
  const client = store.clients.upsert({
    name: "Айгерим",
    phone: "+7 701 000 00 01",
    requisites: { type: "company", legalName: "ТОО «Ромашка»", bin: "123456789012", contract: "№ 5" },
  });
  const o = order(store, { clientId: client.id });
  const [doc] = documents.issueForOrder(o.id, "invoice");
  const buyer = store.documents.get(doc.id).snapshot.buyer;
  assert.equal(buyer.name, "ТОО «Ромашка»");
  assert.equal(buyer.bin, "123456789012");
  assert.equal(buyer.type, "company");
  assert.equal(buyer.contract, "№ 5");
});

test("реквизиты компании: проверка, печать и подпись по хешу содержимого", async (t) => {
  const { documents, dataDir } = setup(t);
  assert.throws(() => documents.saveCompany({ bin: "12" }), { code: "invalid_requisites" });
  const saved = documents.saveCompany({ name: "ИП «Базис»", bin: "880101300123" });
  assert.equal(saved.fields.bin, "880101300123");
  assert.equal(saved.stamp, null);

  const withStamp = await documents.setCompanyImage("stamp", PNG);
  assert.match(withStamp.stamp, /^stamp-[0-9a-f]{20}\.png$/);
  assert.equal(withStamp.fields.name, "ИП «Базис»");
  const files = fs.readdirSync(path.join(dataDir, "company"));
  assert.equal(files.length, 1);
  assert.match(files[0], /^stamp-[0-9a-f]{20}\.png$/);
  assert.equal(documents.companyImage("stamp").mime, "image/png");
  await assert.rejects(() => documents.setCompanyImage("stamp", "data:image/gif;base64,R0lGODlh"), { code: "invalid_image" });
  assert.equal((await documents.setCompanyImage("stamp", null)).stamp, null);
  assert.equal(fs.readdirSync(path.join(dataDir, "company")).length, 1, "файл остаётся для выпущенных документов");
});

test("каталог по выбранным товарам, карточка товара и заявки", async (t) => {
  const { store, documents } = setup(t);
  const all = await documents.catalogPdf({});
  assert.equal(all.buffer.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.match(all.fileName, /^Каталог \d{4}-\d{2}-\d{2}\.pdf$/);
  const one = await documents.catalogPdf({ ids: ["p2"], showStock: true });
  assert.ok(one.buffer.length > 1000);
  await assert.rejects(() => documents.catalogPdf({ ids: ["nope"] }), { code: "empty_catalog" });
  assert.equal((await documents.productPdf("p1")).fileName, "Аудит.pdf");
  const lead = order(store, { channel: "site", items: [], lead: { direction: "management", comment: "Позвоните" } });
  assert.ok((await documents.leadPdf(lead.id)).buffer.length > 1000);
  await assert.rejects(() => documents.leadPdf(order(store).id), { code: "not_a_lead" });
});

test("отправка: e-mail через SMTP-транспорт и Telegram без утечки токена", async () => {
  const mails = [];
  const sender = createSender({
    env: { SMTP_HOST: "smtp.test", SMTP_FROM: "docs@test.kz", TELEGRAM_BOT_TOKEN: "123:SECRET", TELEGRAM_CHAT_ID: "-100" },
    createTransport: () => ({ sendMail: async (mail) => mails.push(mail) }),
    fetchImpl: async (url) => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: "Bad Request: chat not found for " + url }),
    }),
  });
  assert.deepEqual(sender.channels(), { email: true, telegram: true });
  const buffer = Buffer.from("%PDF-1.4");
  await sender.sendEmail({ to: "client@mail.kz", subject: "Счёт", text: "Во вложении", fileName: "Счёт.pdf", buffer });
  assert.equal(mails[0].to, "client@mail.kz");
  assert.equal(mails[0].attachments[0].filename, "Счёт.pdf");
  await assert.rejects(() => sender.sendEmail({ to: "a@b.kz\r\nBcc: x@y.z", subject: "", text: "", fileName: "a.pdf", buffer }), {
    code: "invalid_email",
  });
  await assert.rejects(
    () => sender.sendTelegram({ caption: "Счёт", fileName: "Счёт.pdf", buffer }),
    (err) => err.code === "send_failed" && !err.message.includes("SECRET")
  );
  assert.deepEqual(createSender({ env: {} }).channels(), { email: false, telegram: false });
});
