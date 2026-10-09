/**
 * Оповещения в рабочий чат Telegram (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID — те же, что для отправки PDF):
 * новые заказы и заявки, ошибки 500, запуск и падение сервера, неудачный бэкап, ИИ-консультант без связи.
 *
 * Отправка идёт в фоне по очереди; сбой Telegram только пишется в журнал и не мешает основной работе.
 * Оповещения о сбоях с одинаковым ключом — не чаще раза в 10 минут. Время последней отправки хранится
 * в файле, чтобы цикл перезапусков сервера не засыпал чат сообщениями о каждом запуске.
 */
const fs = require("fs");
const path = require("path");

const ALERT_INTERVAL_MS = 10 * 60 * 1000;
const STATE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS = 15;
const MAX_TEXT = 300;

const PHONE_RE = /\+?\d[\d\s()-]{8,}\d/g;
const EMAIL_RE = /[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}/gi;

/** Текст ошибки для чата: без телефонов, e-mail и секретов (hideSecrets), не длиннее 300 символов. */
function scrub(text, hideSecrets = (value) => value) {
  return hideSecrets(String(text || ""))
    .replace(EMAIL_RE, "[e-mail]")
    .replace(PHONE_RE, "[номер]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT);
}

/** Путь без строки запроса и с обезличенными идентификаторами: /api/orders/ord_… → /api/orders/:id. */
function routeOf(rawUrl) {
  const pathname = String(rawUrl || "/").split(/[?#]/)[0];
  return pathname
    .split("/")
    .map((part) => (/\d/.test(part) && part.length >= 8 ? ":id" : part))
    .join("/")
    .slice(0, 120);
}

function clip(text, max = MAX_TEXT) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

/** Сообщение о новом заказе или заявке: тип, имя, телефон, состав, ссылка на CRM. */
function formatOrder(order, crmUrl) {
  const items = Array.isArray(order.items) ? order.items : [];
  const lines = [];
  if (order.leadSource === "chat") {
    lines.push("💬 Заявка из ИИ-чата" + (order.handoff ? " (клиент ушёл в " + (order.handoff === "telegram" ? "Telegram" : "WhatsApp") + ")" : ""));
  } else if (order.channel === "site") {
    lines.push("📝 Заявка с формы на сайте");
  } else {
    lines.push("🛒 Новый заказ (" + (order.channel === "telegram" ? "Telegram" : "WhatsApp") + ")");
  }
  lines.push("Имя: " + (clip(order.customerName, 120) || "не указано"));
  lines.push("Телефон: " + (clip(order.customerPhone, 32) || "не указан"));
  if (order.channel === "site") {
    if (items[0] && items[0].title) lines.push("Направление: " + clip(items[0].title, 120));
    const comment = order.lead && order.lead.comment;
    if (comment) lines.push("Комментарий: " + clip(comment));
    if (order.chatCode) lines.push("Код обращения: " + order.chatCode);
  } else {
    lines.push("Состав:");
    items.slice(0, MAX_ITEMS).forEach((item) => lines.push("• " + clip(item.title || "Позиция", 120) + " × " + (item.qty || 1)));
    if (items.length > MAX_ITEMS) lines.push("• … и ещё " + (items.length - MAX_ITEMS));
    if (order.totalText) lines.push("Итого: " + clip(order.totalText, 200));
  }
  if (crmUrl) lines.push("CRM: " + crmUrl);
  return lines.join("\n");
}

/**
 * @param {{ sender: { channels(): { telegram: boolean }, sendTelegramText(text: string): Promise<unknown>,
 *   hideSecrets?: (text: string) => string }, stateFile?: string | null, crmUrl?: string,
 *   log?: Pick<Console, "warn">, now?: () => number, intervalMs?: number }} options
 */
function createNotifier(options) {
  const { sender, stateFile = null, crmUrl = "" } = options;
  const log = options.log || console;
  const now = options.now || Date.now;
  const intervalMs = options.intervalMs || ALERT_INTERVAL_MS;
  const hideSecrets = (sender && sender.hideSecrets) || ((value) => value);
  const enabled = !!(sender && sender.channels().telegram);
  let state = loadState();
  let queue = Promise.resolve();

  function loadState() {
    if (!stateFile || !fs.existsSync(stateFile)) return { alerts: {} };
    try {
      const value = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      return value && typeof value.alerts === "object" ? value : { alerts: {} };
    } catch (err) {
      log.warn("Оповещения: файл состояния повреждён, начинаю заново: " + err.message);
      return { alerts: {} };
    }
  }

  function saveState() {
    if (!stateFile) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(state));
    } catch (err) {
      log.warn("Оповещения: не удалось сохранить состояние: " + err.message);
    }
  }

  function send(text) {
    if (!enabled) return Promise.resolve(false);
    const task = queue.then(() => sender.sendTelegramText(text)).then(
      () => true,
      (err) => {
        log.warn("Оповещение в Telegram не отправлено: " + hideSecrets((err && err.message) || String(err)));
        return false;
      }
    );
    queue = task;
    return task;
  }

  /** Оповещение о сбое; повтор с тем же ключом раньше чем через 10 минут только считается. */
  function alert(key, text) {
    if (!enabled) return Promise.resolve(false);
    const at = now();
    const alerts = state.alerts;
    const previous = alerts[key];
    if (previous && at - previous.at < intervalMs) {
      previous.skipped = (previous.skipped || 0) + 1;
      saveState();
      return Promise.resolve(false);
    }
    for (const [name, entry] of Object.entries(alerts)) {
      if (at - entry.at > STATE_TTL_MS) delete alerts[name];
    }
    alerts[key] = { at, skipped: 0 };
    saveState();
    const repeats = previous && previous.skipped ? "\n(с прошлого оповещения повторилось ещё " + previous.skipped + " раз)" : "";
    return send("⚠️ " + text + repeats);
  }

  return {
    enabled,

    /** Новый заказ, заявка с формы или из ИИ-чата — без ограничения частоты. */
    order(order) {
      return send(formatOrder(order, crmUrl));
    },

    alert,

    serverError(method, rawUrl, err) {
      const route = routeOf(rawUrl);
      const message = scrub(err && err.message ? (err.name || "Error") + ": " + err.message : err, hideSecrets);
      return alert("500:" + method + " " + route + ":" + message.slice(0, 80), "Ошибка 500: " + method + " " + route + "\n" + message);
    },

    /** Запуск сервера; если перед этим он упал — с причиной падения. */
    started(details) {
      const failure = state.lastFailure;
      delete state.lastFailure;
      const text = failure
        ? "Сервер перезапущен после сбоя: " + failure.reason + " (" + new Date(failure.at).toLocaleString("ru-RU") + ")"
        : "Сервер запущен";
      return alert("start", text + (details ? "\n" + details : ""));
    },

    /** Сервер падает или не может запуститься: запомнить причину для следующего запуска и сообщить. */
    failed(kind, err) {
      const reason = scrub(kind + ": " + ((err && err.message) || err), hideSecrets);
      state.lastFailure = { at: now(), reason };
      return alert("fail:" + reason.slice(0, 80), "Сервер остановлен — " + reason);
    },

    /** Дождаться отправки (перед выходом процесса), но не дольше timeoutMs. */
    flush(timeoutMs = 5000) {
      saveState();
      return Promise.race([queue, new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())]);
    },
  };
}

module.exports = { createNotifier, formatOrder, routeOf, scrub, ALERT_INTERVAL_MS };
