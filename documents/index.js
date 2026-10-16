/**
 * Документы в PDF: счёт на оплату и акт выполненных работ по заказу, каталог товаров,
 * карточка товара и карточка заявки.
 *
 * Счёт и акт фиксируются снимком в момент присвоения номера: повторное скачивание отдаёт тот же документ,
 * даже если заказ, клиент или реквизиты потом изменились. Новые данные попадают в документ только
 * через явный перевыпуск — старый номер аннулируется, выдаётся следующий.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { CATEGORIES } = require("../shared/catalog.json");
const { orderTotals, amountInWords, toMinor } = require("./money");
const { normalizeCompany, missingCompanyFields, COMPANY_FIELDS } = require("./requisites");
const { createImageLoader, parseDataUrlImage, sniffMime } = require("./images");
const { createRenderer } = require("./render");
const { localParts } = require("./templates/common");

const KINDS = { invoice: "Счёт", act: "Акт" };
const COMPANY_KEY = "company";
const COMPANY_IMAGES = ["stamp", "signature"];
const COMPANY_IMAGE_NAME_RE = /^(stamp|signature)-[0-9a-f]{20}\.(png|jpg)$/;
const COMPANY_IMAGE_TITLES = { stamp: "печати", signature: "подписи" };
const KIND_GENITIVE = { invoice: "счёта", act: "акта" };
const MAX_COMPANY_IMAGE_BYTES = 1024 * 1024;
const IMAGE_CONCURRENCY = 4;
const STATUS_LABELS = { new: "Новый", in_progress: "В работе", done: "Готово", cancelled: "Отмена" };

function docError(code, status = 400, extra = {}) {
  return Object.assign(new Error(code), { code, status, ...extra });
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

/** Имя файла для Content-Disposition: без символов, запрещённых в Windows. */
function safeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 150) || "document";
}

async function writeAtomic(file, buffer) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + "." + Date.now() + ".tmp";
  await fs.promises.writeFile(tmp, buffer);
  await fs.promises.rename(tmp, file);
}

/** Выполнить fn для всех элементов, не больше limit одновременно. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * @param {{ store: ReturnType<typeof import("../db/store").createStore>, rootDir: string, dataDir: string,
 *   log?: Pick<Console, "warn" | "error">, renderer?: { render: Function, close: Function },
 *   notifier?: { alert: (key: string, text: string) => void } }} options
 */
function createDocuments(options) {
  const { store, rootDir, dataDir } = options;
  const log = options.log || console;
  const notifier = options.notifier || { alert() {} };
  const renderer = options.renderer || createRenderer();
  const companyDir = path.join(dataDir, "company");
  const pdfDir = path.join(dataDir, "documents");
  const images = createImageLoader({ rootDir, cacheDir: path.join(dataDir, "cache", "images"), log });

  /* ---------- реквизиты компании ---------- */

  async function companySettings() {
    const saved = (await store.settings.get(COMPANY_KEY)) || {};
    const { values } = normalizeCompany(saved.fields || {});
    return { fields: values, stamp: saved.stamp || null, signature: saved.signature || null };
  }

  /** Реквизиты для админки: поля и имена файлов печати и подписи (null — не загружены; имя меняется с картинкой). */
  async function getCompany() {
    const settings = await companySettings();
    return { fields: settings.fields, stamp: settings.stamp, signature: settings.signature };
  }

  /** Чтение и запись настройки — в одной транзакции: одновременная загрузка печати не затрёт сохранённые поля. */
  async function saveCompany(raw) {
    const { values, errors } = normalizeCompany(raw && typeof raw === "object" ? raw : {});
    if (errors.length) throw docError("invalid_requisites", 400, { errors });
    await store.tx(async () => {
      const current = await companySettings();
      await store.settings.set(COMPANY_KEY, { ...current, fields: values });
    });
    return getCompany();
  }

  /**
   * Печать или подпись: PNG/JPEG data-URL или null (убрать).
   * Файлы называются по хешу содержимого и не удаляются — выпущенные документы ссылаются на них.
   */
  async function setCompanyImage(kind, dataUrl) {
    if (!COMPANY_IMAGES.includes(kind)) throw docError("not_found", 404);
    let fileName = null;
    if (dataUrl) {
      const { buffer, ext } = parseDataUrlImage(dataUrl, MAX_COMPANY_IMAGE_BYTES);
      fileName = kind + "-" + sha256(buffer).slice(0, 20) + ext;
      const file = path.join(companyDir, fileName);
      if (!fs.existsSync(file)) await writeAtomic(file, buffer);
    }
    await store.tx(async () => {
      const current = await companySettings();
      await store.settings.set(COMPANY_KEY, { ...current, [kind]: fileName });
    });
    return getCompany();
  }

  /** Файл печати или подписи из data/company; имя проверяется, чтобы не выйти за папку. */
  function readCompanyAsset(fileName) {
    if (!fileName || !COMPANY_IMAGE_NAME_RE.test(fileName)) return null;
    try {
      return fs.readFileSync(path.join(companyDir, fileName));
    } catch {
      return null;
    }
  }

  /** Текущая печать или подпись для предпросмотра в админке. */
  async function companyImage(kind) {
    if (!COMPANY_IMAGES.includes(kind)) return null;
    const buffer = readCompanyAsset((await companySettings())[kind]);
    return buffer ? { buffer, mime: sniffMime(buffer) || "application/octet-stream" } : null;
  }

  /**
   * Печать или подпись для документа: null — не задана (документ без неё допустим).
   * Задана, но файл не читается — ошибка: документ без печати бухгалтерия не примет.
   */
  function companyAsset(kind, fileName) {
    if (!fileName) return null;
    const file = path.join(companyDir, path.basename(String(fileName)));
    let reason;
    if (!COMPANY_IMAGE_NAME_RE.test(fileName)) {
      reason = "недопустимое имя файла";
    } else {
      try {
        const buffer = fs.readFileSync(file);
        const mime = sniffMime(buffer);
        if (mime === "image/png" || mime === "image/jpeg") return "data:" + mime + ";base64," + buffer.toString("base64");
        reason = "файл не PNG и не JPEG";
      } catch (err) {
        reason = err.code === "ENOENT" ? "файл не найден" : err.message;
      }
    }
    const title = COMPANY_IMAGE_TITLES[kind];
    log.error(`PDF: файл ${title} не читается (${file}): ${reason}`);
    notifier.alert(
      "company_asset:" + kind,
      `Файл ${title} компании не читается (${file}: ${reason}). Счета и акты не выпускаются, пока его не загрузят заново в разделе «Реквизиты».`
    );
    throw docError("company_asset_unreadable", 409, {
      asset: kind,
      message: `Файл ${title} не найден — загрузите его заново в разделе «Реквизиты».`,
    });
  }

  /** Все заданные картинки компании читаются; иначе — ошибка до присвоения номера. */
  function companyAssets(assets) {
    return { stamp: companyAsset("stamp", assets.stamp), signature: companyAsset("signature", assets.signature) };
  }

  let logoCache;
  function logo() {
    if (logoCache === undefined) {
      logoCache = null;
      for (const dir of ["public", "dist"]) {
        try {
          const buffer = fs.readFileSync(path.join(rootDir, dir, "brand", "logo.png"));
          logoCache = "data:image/png;base64," + buffer.toString("base64");
          break;
        } catch {
          /* следующий вариант */
        }
      }
      if (!logoCache) log.warn("PDF: логотип brand/logo.png не найден ни в public, ни в dist — в документах будет название компании.");
    }
    return logoCache;
  }

  /* ---------- счёт и акт по заказу ---------- */

  async function loadOrder(orderId) {
    const order = await store.orders.get(orderId);
    if (!order) throw docError("not_found", 404);
    return order;
  }

  function assertDocumentable(order) {
    if (order.channel === "site") throw docError("lead_has_no_documents");
    if (order.status === "cancelled") throw docError("order_cancelled");
  }

  /** Покупатель: реквизиты из карточки клиента, а если их нет — имя и телефон из заказа. */
  async function buyerFor(order) {
    const client = order.clientId ? await store.clients.get(order.clientId) : null;
    const req = (client && client.requisites) || {};
    const pick = (key) => (req[key] == null ? "" : String(req[key]));
    return {
      type: req.type === "company" ? "company" : "person",
      name: pick("legalName") || (client && client.name) || order.customerName || "",
      bin: pick("bin"),
      address: pick("address"),
      phone: (client && client.phone) || order.customerPhone || "",
      email: pick("email"),
      bank: pick("bank"),
      iik: pick("iik"),
      bik: pick("bik"),
      kbe: pick("kbe"),
      contract: pick("contract"),
    };
  }

  /** Итоги по валютам, в которых есть что выставлять. */
  function currencyBuckets(order) {
    return orderTotals(order).filter((bucket) => bucket.lines.length || bucket.total > 0);
  }

  /** Содержательная часть документа: при её изменении документ помечается устаревшим. */
  function sourceOf(bucket, buyer) {
    const lines = bucket.lines.map((line, index) => ({
      n: index + 1,
      title: line.title,
      unit: line.unit,
      qty: line.qty,
      price: line.price,
      discount: line.discount,
      amount: line.amount,
    }));
    const totals = {
      subtotal: bucket.subtotal,
      itemsDiscount: bucket.itemsDiscount,
      orderDiscount: bucket.orderDiscount,
      delivery: bucket.delivery,
      total: bucket.total,
      vatRate: bucket.vatRate,
      vat: bucket.vat,
    };
    return { lines, totals, buyer, hash: sha256(JSON.stringify({ lines, totals, buyer })) };
  }

  function formatNumber(kind, year, seq, fields) {
    const prefix = String((kind === "invoice" ? fields.invoicePrefix : fields.actPrefix) || "");
    return prefix + year + "-" + String(seq).padStart(4, "0");
  }

  /** Проверки до присвоения номера: при ошибке номер не расходуется. */
  function assertIssuable(kind, settings) {
    const missing = missingCompanyFields(kind, settings.fields);
    if (missing.length) {
      throw docError("company_requisites_missing", 400, {
        fields: missing.map((field) => field.key),
        message:
          `Для ${KIND_GENITIVE[kind]} не заполнены реквизиты компании: ${missing.map((field) => field.label).join(", ")}. ` +
          "Заполните их в разделе «Реквизиты».",
      });
    }
    companyAssets(settings);
  }

  async function issueOne(order, kind, bucket, replaces) {
    const settings = await companySettings();
    assertIssuable(kind, settings);
    const source = sourceOf(bucket, await buyerFor(order));
    const now = new Date().toISOString();
    const year = localParts(now).year;
    return store.documents.issue({
      kind,
      orderId: order.id,
      currency: bucket.currency,
      year,
      replaces,
      formatNumber: (seq) => formatNumber(kind, year, seq, settings.fields),
      build: (number) => ({
        snapshot: {
          kind,
          number,
          date: now,
          currency: bucket.currency,
          order: { id: order.id, createdAt: order.createdAt },
          company: settings.fields,
          buyer: source.buyer,
          lines: source.lines,
          totals: source.totals,
          amountInWords: amountInWords(source.totals.total, bucket.currency),
          assets: { stamp: settings.stamp, signature: settings.signature },
        },
        total: source.totals.total / 100,
        sourceHash: source.hash,
      }),
    });
  }

  /**
   * Документы заказа с признаком «заказ изменился после выпуска» у действующих.
   * buyerEmail — текущий e-mail покупателя из карточки клиента, чтобы подставить его при отправке.
   */
  async function listForOrder(orderId) {
    const order = await loadOrder(orderId);
    const buyer = await buyerFor(order);
    const hashes = new Map(currencyBuckets(order).map((bucket) => [bucket.currency, sourceOf(bucket, buyer).hash]));
    const docs = await store.documents.listByOrder(order.id);
    const result = [];
    for (const doc of docs) {
      result.push({
        ...publicDoc(doc),
        outdated: doc.status === "active" && hashes.get(doc.currency) !== doc.sourceHash,
        buyerEmail: buyer.email,
        sends: await store.documents.sends(doc.id),
      });
    }
    return result;
  }

  function publicDoc(doc) {
    const { snapshot, sourceHash, ...rest } = doc;
    return { ...rest, title: KINDS[doc.kind] + " № " + doc.number };
  }

  /**
   * Счёт или акт по заказу — по документу на каждую валюту позиций.
   * Если действующий документ уже есть, он возвращается как есть (номер не тратится).
   * Проверка «есть ли действующий» и выпуск — одна транзакция: двойное нажатие не выпустит два документа.
   */
  async function issueForOrder(orderId, kind) {
    if (!KINDS[kind]) throw docError("invalid_kind");
    return store.tx(async () => {
      const order = await loadOrder(orderId);
      assertDocumentable(order);
      const buckets = currencyBuckets(order);
      if (!buckets.length) throw docError("empty_order");
      const ids = new Set();
      for (const bucket of buckets) {
        const doc = (await store.documents.active(order.id, kind, bucket.currency)) || (await issueOne(order, kind, bucket));
        ids.add(doc.id);
      }
      return (await listForOrder(order.id)).filter((doc) => ids.has(doc.id));
    });
  }

  /** Перевыпуск по текущим данным заказа: новый номер, старый документ аннулируется. */
  async function reissue(docId) {
    return store.tx(async () => {
      const doc = await store.documents.get(docId, false);
      if (!doc) throw docError("not_found", 404);
      if (doc.status !== "active") throw docError("document_annulled");
      const order = await loadOrder(doc.orderId);
      assertDocumentable(order);
      const bucket = currencyBuckets(order).find((item) => item.currency === doc.currency);
      if (!bucket) throw docError("currency_gone");
      const fresh = await issueOne(order, doc.kind, bucket, doc.id);
      return (await listForOrder(order.id)).find((item) => item.id === fresh.id);
    });
  }

  /**
   * PDF выпущенного документа: собирается из снимка один раз и дальше берётся из data/documents.
   * Если заданная в снимке печать или подпись не читается — ошибка, а не PDF без неё (и в кэш ничего не пишется).
   */
  async function documentPdf(docId) {
    const doc = await store.documents.get(docId, true);
    if (!doc || !doc.snapshot) throw docError("not_found", 404);
    const annulled = doc.status !== "active";
    const file = path.join(pdfDir, String(doc.year), doc.id + (annulled ? "-annulled" : "") + ".pdf");
    let buffer = null;
    try {
      buffer = await fs.promises.readFile(file);
    } catch {
      const snap = doc.snapshot;
      const assets = companyAssets(snap.assets || {});
      buffer = await renderer.render(doc.kind, { ...snap, logo: logo(), ...assets, annulled });
      await writeAtomic(file, buffer).catch((err) => log.warn("PDF: не удалось сохранить в кэш: " + err.message));
    }
    const suffix = doc.currency !== "KZT" ? " " + doc.currency : "";
    return {
      buffer,
      fileName: safeFileName(KINDS[doc.kind] + " № " + doc.number + suffix + (annulled ? " (аннулирован)" : "") + ".pdf"),
      doc: publicDoc(doc),
    };
  }

  /* ---------- каталог, товар, заявка ---------- */

  /** imageWidth — пиксели картинки: в списке каталога она ~120 pt, в карточке товара — во всю ширину. */
  async function catalogItem(product, { withCategory, imageWidth }) {
    const category = CATEGORIES.find((item) => item.id === product.category);
    return {
      title: product.title,
      description: product.description,
      kind: product.kind === "product" ? "product" : "service",
      categoryTitle: withCategory && category ? category.title : "",
      price: toMinor(product.price),
      currency: product.currency || "KZT",
      fromPrice: true,
      stock: product.stock == null ? null : product.stock,
      image: product.image ? await images.load(product.image, imageWidth) : null,
    };
  }

  /**
   * Каталог: выбранные товары (ids) или весь список, по разделам в порядке витрины.
   * @param {{ ids?: string[], showPrices?: boolean, showStock?: boolean }} opts
   */
  async function catalogPdf(opts = {}) {
    let products = await store.products.list();
    if (Array.isArray(opts.ids) && opts.ids.length) {
      const wanted = new Set(opts.ids.map(String));
      products = products.filter((product) => wanted.has(product.id));
    }
    if (!products.length) throw docError("empty_catalog");
    const items = await mapLimit(products, IMAGE_CONCURRENCY, (product) =>
      catalogItem(product, { withCategory: false, imageWidth: 360 })
    );
    const groups = [];
    const known = new Set(CATEGORIES.map((item) => item.id));
    for (const category of CATEGORIES) {
      const groupItems = items.filter((_, index) => products[index].category === category.id);
      if (groupItems.length) groups.push({ title: category.title, lead: category.lead, items: groupItems });
    }
    const other = items.filter((_, index) => !known.has(products[index].category));
    if (other.length) groups.push({ title: "Прочее", lead: "", items: other });
    const settings = await companySettings();
    const now = new Date().toISOString();
    const buffer = await renderer.render("catalog", {
      company: settings.fields,
      logo: logo(),
      title: products.length === 1 ? "Каталог: 1 позиция" : "Каталог товаров и услуг",
      generatedAt: now,
      showPrices: opts.showPrices !== false,
      showStock: !!opts.showStock,
      groups,
    });
    const p = localParts(now);
    const date = p.year + "-" + String(p.month).padStart(2, "0") + "-" + String(p.day).padStart(2, "0");
    return { buffer, fileName: safeFileName("Каталог " + date + ".pdf") };
  }

  async function productPdf(productId) {
    const product = await store.products.get(productId);
    if (!product) throw docError("not_found", 404);
    const settings = await companySettings();
    const buffer = await renderer.render("product", {
      company: settings.fields,
      logo: logo(),
      generatedAt: new Date().toISOString(),
      item: await catalogItem(product, { withCategory: true, imageWidth: 1000 }),
    });
    return { buffer, fileName: safeFileName(product.title + ".pdf") };
  }

  async function leadPdf(orderId) {
    const order = await loadOrder(orderId);
    if (order.channel !== "site") throw docError("not_a_lead");
    const direction = CATEGORIES.find((item) => item.id === (order.lead && order.lead.direction));
    const settings = await companySettings();
    const buffer = await renderer.render("lead", {
      company: settings.fields,
      logo: logo(),
      generatedAt: new Date().toISOString(),
      lead: {
        id: order.id,
        createdAt: order.createdAt,
        statusLabel: STATUS_LABELS[order.status] || order.status,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        directionTitle: direction ? direction.title : "",
        sourcePage: order.sourcePage,
        note: order.note,
        comment: (order.lead && order.lead.comment) || order.message || "",
        fromChat: order.leadSource === "chat",
        consentAt: order.consentAt || "",
      },
    });
    return { buffer, fileName: safeFileName("Заявка " + (order.customerName || order.id) + ".pdf") };
  }

  return {
    COMPANY_FIELDS,
    getCompany,
    saveCompany,
    setCompanyImage,
    companyImage,
    listForOrder,
    issueForOrder,
    reissue,
    documentPdf,
    catalogPdf,
    productPdf,
    leadPdf,
    logSend: (entry) => store.documents.logSend(entry),
    close: () => renderer.close(),
  };
}

module.exports = { createDocuments, docError, safeFileName };
