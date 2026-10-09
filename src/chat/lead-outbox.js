/**
 * Заявки из ИИ-чата, которые не дошли до сервера (посетитель ушёл в мессенджер, вкладку закрыли, сбой сети).
 * Заявка кладётся сюда до отправки и убирается после ответа сервера; при следующем визите досылается
 * с тем же id — сервер считает повтор дублем и второй заявки не создаёт. Хранится не дольше 7 дней.
 */
import { submitPublicOrder } from "../lib/orders-db.js";

const OUTBOX_KEY = "bazis_chat_lead_outbox";
export const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 20;

/** @returns {Record<string, { body: object, savedAt: number }>} */
function readOutbox() {
  try {
    const parsed = JSON.parse(localStorage.getItem(OUTBOX_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeOutbox(outbox) {
  try {
    if (Object.keys(outbox).length) localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
    else localStorage.removeItem(OUTBOX_KEY);
  } catch (err) {
    // Хранилище переполнено или запрещено — заявка уйдёт только в этот раз.
    console.warn("Заявка из чата не сохранена для повторной отправки", err); // i18n-ignore: лог для разработчика
  }
}

/** Отложить заявку до подтверждения сервером. Без id не храним: повтор без него создал бы дубль. */
export function rememberLead(body, now = Date.now()) {
  if (!body || !body.id) return;
  const outbox = readOutbox();
  outbox[body.id] = { body, savedAt: (outbox[body.id] && outbox[body.id].savedAt) || now };
  const ids = Object.keys(outbox).sort((a, b) => outbox[a].savedAt - outbox[b].savedAt);
  ids.slice(0, Math.max(0, ids.length - MAX_ENTRIES)).forEach((id) => delete outbox[id]);
  writeOutbox(outbox);
}

export function forgetLead(id) {
  const outbox = readOutbox();
  if (!(id in outbox)) return;
  delete outbox[id];
  writeOutbox(outbox);
}

/** Сервер отказал по существу (4xx, кроме лимитов и антиспам-токена) — повтор не поможет. */
export function isPermanentRejection(err) {
  const status = err && err.status;
  return Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429 && status !== 403;
}

let flushing = null;

/**
 * Дослать заявки, отложенные в прошлые визиты. Просроченные (старше 7 дней) удаляются без отправки;
 * при сбое сети или лимите заявка остаётся до следующего визита.
 */
export function flushLeadOutbox({ now = Date.now(), send = (body) => submitPublicOrder(body) } = {}) {
  if (flushing) return flushing;
  flushing = (async () => {
    const outbox = readOutbox();
    for (const [id, entry] of Object.entries(outbox)) {
      if (!entry || !entry.body || !(now - Number(entry.savedAt) < OUTBOX_TTL_MS)) {
        console.warn("Заявка из чата не отправлена за 7 дней и удалена", id); // i18n-ignore: лог для разработчика
        forgetLead(id);
        continue;
      }
      try {
        await send(entry.body);
        forgetLead(id);
      } catch (err) {
        if (isPermanentRejection(err)) {
          console.warn("Сервер отклонил отложенную заявку из чата", id, err); // i18n-ignore: лог для разработчика
          forgetLead(id);
        } else if (err && err.code === "network") {
          break;
        }
      }
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}
