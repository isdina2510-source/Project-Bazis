/**
 * HTTP API документов (только для админки):
 *   GET  /api/settings/company                 реквизиты компании
 *   PUT  /api/settings/company                 сохранить реквизиты
 *   GET  /api/settings/company/stamp|signature картинка печати или подписи
 *   PUT  /api/settings/company/stamp|signature { image: data-URL | null }
 *   GET  /api/orders/:id/documents             выпущенные счета и акты заказа
 *   POST /api/orders/:id/documents             { kind: "invoice" | "act" } — выпустить (или вернуть действующие)
 *   GET  /api/orders/:id/lead.pdf              карточка заявки
 *   GET  /api/documents/:id/pdf                PDF счёта или акта
 *   POST /api/documents/:id/reissue            перевыпуск с новым номером
 *   GET  /api/documents/channels               какие каналы отправки настроены
 *   POST /api/documents/send                   { target, channel, to?, comment? }
 *   POST /api/products/catalog.pdf             { ids?, showPrices?, showStock? }
 *   GET  /api/products/:id/pdf                 карточка товара
 */
const MAX_SETTINGS_BODY_BYTES = 64 * 1024;
const MAX_IMAGE_BODY_BYTES = 1.5 * 1024 * 1024;
const MAX_CATALOG_IDS = 1000;
const MAX_COMMENT = 1000;

const ERROR_MESSAGES = {
  not_found: "Не найдено",
  invalid_kind: "Неизвестный вид документа",
  lead_has_no_documents: "Для заявки с формы счёт и акт не выписываются",
  order_cancelled: "Заказ отменён — документы по нему не выписываются",
  empty_order: "В заказе нет позиций для документа",
  document_annulled: "Документ уже аннулирован",
  currency_gone: "В заказе больше нет позиций в валюте документа",
  not_a_lead: "Это не заявка с формы",
  empty_catalog: "Не выбрано ни одного товара",
  invalid_requisites: "Проверьте реквизиты",
  invalid_image: "Нужна картинка PNG или JPEG",
  image_too_large: "Картинка больше 1 МБ",
  invalid_target: "Не указано, что отправлять",
  invalid_channel: "Неизвестный канал отправки",
};

/**
 * @param {() => ReturnType<typeof import("./index").createDocuments>} getDocuments модуль появляется вместе с базой
 * @param {ReturnType<typeof import("./send").createSender>} sender
 * @param {{ sendJson: Function, readJsonObject: Function, requireAdmin: Function,
 *   corsHeaders: (req: object) => object, log?: Pick<Console, "warn" | "error"> }} deps
 */
function createDocumentsHttpHandler(getDocuments, sender, deps) {
  const { sendJson, readJsonObject, requireAdmin, corsHeaders } = deps;
  const log = deps.log || console;
  let documents = null;

  function sendError(res, req, err) {
    const code = (err && err.code) || "server_error";
    const status = (err && Number.isInteger(err.status) && err.status) || (ERROR_MESSAGES[code] ? 400 : null);
    if (!status) throw err;
    const body = { error: code, message: ERROR_MESSAGES[code] || err.message };
    if (Array.isArray(err.errors)) body.errors = err.errors;
    sendJson(res, status, body, req);
  }

  /** filename* — для кириллицы, filename — латинская замена для старых клиентов. */
  function sendPdf(res, req, { buffer, fileName }) {
    const ascii = fileName.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_");
    res.writeHead(200, {
      ...corsHeaders(req),
      "Content-Type": "application/pdf",
      "Content-Length": buffer.length,
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Expose-Headers": "Content-Disposition",
    });
    res.end(buffer);
  }

  const methodNotAllowed = (res, req) => sendJson(res, 405, { error: "method_not_allowed" }, req);

  async function companyRoute(req, res, sub) {
    if (!sub) {
      if (req.method === "GET") return sendJson(res, 200, documents.getCompany(), req);
      if (req.method === "PUT") {
        const body = await readJsonObject(req, MAX_SETTINGS_BODY_BYTES);
        return sendJson(res, 200, documents.saveCompany(body.fields || body), req);
      }
      return methodNotAllowed(res, req);
    }
    if (sub !== "stamp" && sub !== "signature") return sendJson(res, 404, { error: "not_found" }, req);
    if (req.method === "GET") {
      const image = documents.companyImage(sub);
      if (!image) return sendJson(res, 404, { error: "not_found" }, req);
      res.writeHead(200, {
        ...corsHeaders(req),
        "Content-Type": image.mime,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(image.buffer);
      return;
    }
    if (req.method === "PUT") {
      const body = await readJsonObject(req, MAX_IMAGE_BODY_BYTES);
      return sendJson(res, 200, await documents.setCompanyImage(sub, body.image || null), req);
    }
    return methodNotAllowed(res, req);
  }

  async function orderRoute(req, res, orderId, sub) {
    if (sub === "documents") {
      if (req.method === "GET") return sendJson(res, 200, documents.listForOrder(orderId), req);
      if (req.method === "POST") {
        const body = await readJsonObject(req);
        return sendJson(res, 201, documents.issueForOrder(orderId, String(body.kind || "")), req);
      }
      return methodNotAllowed(res, req);
    }
    if (sub === "lead.pdf") {
      if (req.method !== "GET") return methodNotAllowed(res, req);
      return sendPdf(res, req, await documents.leadPdf(orderId));
    }
    return sendJson(res, 404, { error: "not_found" }, req);
  }

  function catalogOptions(body) {
    const ids = Array.isArray(body.ids) ? body.ids.slice(0, MAX_CATALOG_IDS).map((id) => String(id).slice(0, 80)) : [];
    return { ids, showPrices: body.showPrices !== false, showStock: !!body.showStock };
  }

  /** Что отправлять: выпущенный документ или каталог. */
  async function buildAttachment(target) {
    if (target && target.type === "document" && target.id) {
      const pdf = await documents.documentPdf(String(target.id));
      return { ...pdf, documentId: pdf.doc.id, subject: pdf.doc.title };
    }
    if (target && target.type === "catalog") {
      const pdf = await documents.catalogPdf(catalogOptions(target));
      return { ...pdf, documentId: null, subject: "Каталог товаров и услуг" };
    }
    throw Object.assign(new Error("invalid_target"), { code: "invalid_target", status: 400 });
  }

  async function sendRoute(req, res) {
    const body = await readJsonObject(req);
    const channel = String(body.channel || "");
    if (channel !== "email" && channel !== "telegram") {
      throw Object.assign(new Error("invalid_channel"), { code: "invalid_channel", status: 400 });
    }
    const attachment = await buildAttachment(body.target);
    const comment = String(body.comment || "").trim().slice(0, MAX_COMMENT);
    const company = documents.getCompany().fields;
    const signature = [company.name, company.phone, company.email].filter(Boolean).join("\n");
    let result;
    try {
      result =
        channel === "email"
          ? await sender.sendEmail({
            to: body.to,
            subject: attachment.subject + (company.name ? " — " + company.name : ""),
            text: [comment || "Здравствуйте! Документ во вложении.", signature].filter(Boolean).join("\n\n"),
            fileName: attachment.fileName,
            buffer: attachment.buffer,
          })
          : await sender.sendTelegram({
            caption: [attachment.subject, comment].filter(Boolean).join("\n"),
            fileName: attachment.fileName,
            buffer: attachment.buffer,
          });
    } catch (err) {
      if (attachment.documentId) {
        documents.logSend({ documentId: attachment.documentId, channel, recipient: String(body.to || ""), ok: false, error: err.message });
      }
      log.warn("PDF: отправка не удалась: " + err.message);
      throw err;
    }
    if (attachment.documentId) {
      documents.logSend({ documentId: attachment.documentId, channel, recipient: result.recipient, ok: true });
    }
    return sendJson(res, 200, { ok: true, ...result }, req);
  }

  async function documentsRoute(req, res, docId, sub) {
    if (docId === "channels" && !sub) {
      if (req.method !== "GET") return methodNotAllowed(res, req);
      return sendJson(res, 200, sender.channels(), req);
    }
    if (docId === "send" && !sub) {
      if (req.method !== "POST") return methodNotAllowed(res, req);
      return sendRoute(req, res);
    }
    if (docId && sub === "pdf") {
      if (req.method !== "GET") return methodNotAllowed(res, req);
      return sendPdf(res, req, await documents.documentPdf(docId));
    }
    if (docId && sub === "reissue") {
      if (req.method !== "POST") return methodNotAllowed(res, req);
      return sendJson(res, 201, documents.reissue(docId), req);
    }
    return sendJson(res, 404, { error: "not_found" }, req);
  }

  async function productsRoute(req, res, productId, sub) {
    if (productId === "catalog.pdf" && !sub) {
      if (req.method !== "POST") return methodNotAllowed(res, req);
      const body = await readJsonObject(req);
      return sendPdf(res, req, await documents.catalogPdf(catalogOptions(body)));
    }
    if (productId && sub === "pdf") {
      if (req.method !== "GET") return methodNotAllowed(res, req);
      return sendPdf(res, req, await documents.productPdf(productId));
    }
    return sendJson(res, 404, { error: "not_found" }, req);
  }

  /** Маршрут документов для пути /api/…; false — не наш, пусть обрабатывает server.js. */
  function matches(parts) {
    if (parts[1] === "settings" && parts[2] === "company") return true;
    if (parts[1] === "documents") return true;
    if (parts[1] === "orders" && parts[2] && parts[3]) return true;
    if (parts[1] === "products" && (parts[2] === "catalog.pdf" || (parts[2] && parts[3] === "pdf"))) return true;
    return false;
  }

  async function handle(req, res, parts) {
    if (!requireAdmin(req, res)) return;
    documents = getDocuments();
    let section, id, sub, extra;
    try {
      [, section, id, sub, extra] = parts.map((value) => decodeURIComponent(value));
    } catch {
      return sendJson(res, 404, { error: "not_found" }, req);
    }
    try {
      if (extra) return sendJson(res, 404, { error: "not_found" }, req);
      if (section === "settings") return await companyRoute(req, res, sub);
      if (section === "orders") return await orderRoute(req, res, id, sub);
      if (section === "documents") return await documentsRoute(req, res, id, sub);
      if (section === "products") return await productsRoute(req, res, id, sub);
      return sendJson(res, 404, { error: "not_found" }, req);
    } catch (err) {
      return sendError(res, req, err);
    }
  }

  return { matches, handle };
}

module.exports = { createDocumentsHttpHandler };
