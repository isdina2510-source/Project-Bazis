/**
 * POST /api/client-errors — ошибки из браузера (ErrorBoundary, window.onerror, unhandledrejection, сбой загрузки каталога).
 * Публичный: лимит по адресу, тело до 8 КБ. Телефоны, e-mail и секреты вырезаются тем же scrub, что и в оповещениях;
 * адрес посетителя не пишется ни в журнал, ни в ответ (ответ — 204 без тела).
 */
const { scrub, routeOf } = require("./index");

const MAX_BODY_BYTES = 8 * 1024;
const MAX_STACK_LINES = 12;
const MAX_STACK_CHARS = 2000;
const MAX_UA_CHARS = 200;
const MAX_BUILD_CHARS = 40;
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 1000;

/** Строка запроса в ссылках (?token=…, ?phone=…) — не нужна для разбора ошибки и может нести личные данные. */
const stripQueries = (text) => String(text || "").replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, "$1");

const clean = (value, hideSecrets) => scrub(stripQueries(value), hideSecrets);

function cleanStack(value, hideSecrets) {
  return String(value || "")
    .split(/\r?\n/)
    .slice(0, MAX_STACK_LINES)
    .map((line) => clean(line, hideSecrets))
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_STACK_CHARS);
}

/**
 * Поля отчёта без личных данных; null — в теле нет текста ошибки.
 * @param {Record<string, unknown>} body
 * @param {{ siteIds: Set<string> | string[], hideSecrets?: (text: string) => string }} options
 */
function sanitizeClientError(body, { siteIds, hideSecrets } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const message = clean(body.message, hideSecrets);
  if (!message) return null;
  const sites = new Set(siteIds || []);
  const site = String(body.site || "");
  const build = String(body.build || "").trim();
  return {
    message,
    stack: cleanStack(body.stack, hideSecrets),
    path: clean(routeOf(String(body.path || "/")), hideSecrets) || "/",
    site: sites.has(site) ? site : "",
    userAgent: clean(body.userAgent, hideSecrets).slice(0, MAX_UA_CHARS),
    build: /^[\w.-]+$/.test(build) ? build.slice(0, MAX_BUILD_CHARS) : "",
  };
}

function formatReport(report) {
  const where = [report.site || "сайт?", report.path, report.build ? "сборка " + report.build : ""].filter(Boolean).join(", ");
  return (
    "Ошибка в браузере (" + where + "): " + report.message +
    (report.userAgent ? "\nБраузер: " + report.userAgent : "") +
    (report.stack ? "\n" + report.stack : "")
  );
}

/**
 * @param {{ readJsonObject: Function, sendJson: Function, isJsonRequest: Function, clientIp: Function,
 *   checkRateLimit: Function, notifier: { alert: Function }, siteIds: Set<string>, hideSecrets?: Function,
 *   log?: Pick<Console, "error">, limit?: number, windowMs?: number }} deps
 */
function createClientErrorsHandler(deps) {
  const { readJsonObject, sendJson, isJsonRequest, clientIp, checkRateLimit, notifier, siteIds, hideSecrets } = deps;
  const log = deps.log || console;
  const limit = deps.limit || RATE_LIMIT;
  const windowMs = deps.windowMs || RATE_WINDOW_MS;
  const buckets = new Map();

  return async function handleClientErrors(req, res) {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed" }, req);
      return;
    }
    if (!isJsonRequest(req)) {
      sendJson(res, 415, { error: "unsupported_media_type" }, req);
      return;
    }
    if (!checkRateLimit(buckets, clientIp(req), limit, windowMs)) {
      sendJson(res, 429, { error: "rate_limited" }, req);
      return;
    }
    const report = sanitizeClientError(await readJsonObject(req, MAX_BODY_BYTES), { siteIds, hideSecrets });
    if (!report) {
      sendJson(res, 400, { error: "message_required" }, req);
      return;
    }
    const text = formatReport(report);
    log.error("[client-error] " + text);
    if (notifier) notifier.alert("client:" + report.site + ":" + report.message.slice(0, 80), text.slice(0, 1000));
    res.writeHead(204, { "Cache-Control": "no-store" });
    res.end();
  };
}

module.exports = { createClientErrorsHandler, sanitizeClientError, MAX_BODY_BYTES };
