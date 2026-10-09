/**
 * Отправка PDF: по e-mail через SMTP и в рабочий чат Telegram через бота.
 * Канал считается включённым, когда заданы его переменные окружения:
 *   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM;
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
 */
const { EMAIL_PATTERN } = require("../shared/requisites.json");

const EMAIL_RE = new RegExp(EMAIL_PATTERN);
const TELEGRAM_TIMEOUT_MS = 30000;
const TELEGRAM_TEXT_TIMEOUT_MS = 15000;
const TELEGRAM_MAX_BYTES = 50 * 1024 * 1024;
const CAPTION_MAX = 1024;
const TEXT_MAX = 4096;

function sendError(code, message) {
  return Object.assign(new Error(message || code), { code, status: 400 });
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, log?: Pick<Console, "warn">, fetchImpl?: typeof fetch,
 *   createTransport?: (options: object) => { sendMail: Function } }} [options]
 */
function createSender(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const smtpHost = String(env.SMTP_HOST || "").trim();
  const smtpSecure = /^(1|true|yes)$/i.test(String(env.SMTP_SECURE || ""));
  const smtpPort = Number(env.SMTP_PORT) || (smtpSecure ? 465 : 587);
  const smtpUser = String(env.SMTP_USER || "").trim();
  const smtpFrom = String(env.SMTP_FROM || smtpUser).trim();
  const tgToken = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  const tgChat = String(env.TELEGRAM_CHAT_ID || "").trim();
  let transport = null;

  const channels = () => ({ email: !!(smtpHost && smtpFrom), telegram: !!(tgToken && tgChat) });

  /** Токен бота не должен попасть в журнал или ответ API. */
  const hideSecrets = (text) => (tgToken ? String(text).split(tgToken).join("***") : String(text));

  function getTransport() {
    if (!transport) {
      const createTransport = options.createTransport || require("nodemailer").createTransport;
      transport = createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure,
        auth: smtpUser ? { user: smtpUser, pass: String(env.SMTP_PASS || "") } : undefined,
        connectionTimeout: 15000,
        greetingTimeout: 10000,
        socketTimeout: 30000,
      });
    }
    return transport;
  }

  /**
   * @param {{ to: string, subject: string, text: string, fileName: string, buffer: Buffer }} message
   */
  async function sendEmail(message) {
    if (!channels().email) throw sendError("email_not_configured", "Отправка по e-mail не настроена");
    const to = String(message.to || "").trim();
    if (!EMAIL_RE.test(to) || to.length > 120) throw sendError("invalid_email", "Неверный адрес e-mail");
    try {
      await getTransport().sendMail({
        from: smtpFrom,
        to,
        subject: message.subject,
        text: message.text,
        attachments: [{ filename: message.fileName, content: message.buffer, contentType: "application/pdf" }],
      });
    } catch (err) {
      throw Object.assign(new Error("Письмо не отправлено: " + hideSecrets((err && err.message) || err)), {
        code: "send_failed",
        status: 502,
      });
    }
    return { channel: "email", recipient: to };
  }

  /**
   * @param {{ caption: string, fileName: string, buffer: Buffer }} message
   */
  async function callTelegram(method, init, timeoutMs, rejectedText) {
    let res;
    let body = null;
    try {
      res = await fetchImpl("https://api.telegram.org/bot" + tgToken + "/" + method, {
        method: "POST",
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      body = await res.json().catch(() => null);
    } catch (err) {
      throw Object.assign(new Error("Telegram недоступен: " + hideSecrets((err && err.message) || err)), {
        code: "send_failed",
        status: 502,
      });
    }
    if (!res.ok || !body || !body.ok) {
      const reason = body && body.description ? body.description : "HTTP " + res.status;
      throw Object.assign(new Error(rejectedText + ": " + hideSecrets(reason)), { code: "send_failed", status: 502 });
    }
    return { channel: "telegram", recipient: "chat " + tgChat };
  }

  async function sendTelegram(message) {
    if (!channels().telegram) throw sendError("telegram_not_configured", "Отправка в Telegram не настроена");
    if (message.buffer.length > TELEGRAM_MAX_BYTES) throw sendError("file_too_large", "Файл больше 50 МБ");
    const form = new FormData();
    form.append("chat_id", tgChat);
    form.append("caption", String(message.caption || "").slice(0, CAPTION_MAX));
    form.append("document", new Blob([message.buffer], { type: "application/pdf" }), message.fileName);
    return callTelegram("sendDocument", { body: form }, TELEGRAM_TIMEOUT_MS, "Telegram отклонил файл");
  }

  /** Текстовое сообщение в рабочий чат (оповещения). */
  async function sendTelegramText(text) {
    if (!channels().telegram) throw sendError("telegram_not_configured", "Отправка в Telegram не настроена");
    const body = JSON.stringify({
      chat_id: tgChat,
      text: String(text || "").slice(0, TEXT_MAX),
      disable_web_page_preview: true,
    });
    return callTelegram(
      "sendMessage",
      { headers: { "Content-Type": "application/json" }, body },
      TELEGRAM_TEXT_TIMEOUT_MS,
      "Telegram отклонил сообщение"
    );
  }

  return { channels, sendEmail, sendTelegram, sendTelegramText, hideSecrets };
}

module.exports = { createSender, EMAIL_RE };
