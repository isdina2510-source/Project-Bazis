const { AiError } = require("../errors");

/**
 * Суточный бюджет токенов на все вызовы модели (сутки по UTC — так их считает OpenAI).
 * Перед вызовом резервируется оценка сверху (вход + max_tokens), после — списывается фактический usage.
 * Параллельные запросы видят резервы друг друга, поэтому всплеск не проскакивает выше лимита.
 * Состояние переживает перезапуск сервера через storage { load(), save(state) }.
 */

/** Русский текст — около 2–3 символов на токен; берём с запасом. */
const CHARS_PER_TOKEN = 2;
/** Служебные токены на каждое сообщение. */
const TOKENS_PER_MESSAGE = 8;

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function estimateTokens(messages, maxOutputTokens, { imageTokensLow, imageTokensHigh }) {
  let chars = 0;
  let tokens = 0;
  for (const m of messages || []) {
    tokens += TOKENS_PER_MESSAGE;
    const content = m && m.content;
    if (typeof content === "string") {
      chars += content.length;
      continue;
    }
    for (const part of Array.isArray(content) ? content : []) {
      if (!part) continue;
      if (part.type === "image_url") {
        tokens += part.image_url && part.image_url.detail === "low" ? imageTokensLow : imageTokensHigh;
      } else {
        chars += String(part.text || "").length;
      }
    }
  }
  return tokens + Math.ceil(chars / CHARS_PER_TOKEN) + (Number(maxOutputTokens) || 0);
}

function exceeded() {
  return new AiError(
    "ai_budget_exceeded",
    503,
    "ИИ-консультант на сегодня исчерпал лимит. Ответим по каталогу или напишите нам в WhatsApp."
  );
}

function createBudget({ dailyTokens = 0, storage = null, now = Date.now } = {}) {
  let state = null;
  let reserved = 0;

  function fresh(day) {
    return { day, spent: 0, calls: 0, rejected: 0 };
  }

  /** Состояние текущих суток; хранилище читается лениво — база открывается позже ядра. */
  function current() {
    const day = utcDay(now());
    if (!state) {
      let saved = null;
      try {
        saved = storage && typeof storage.load === "function" ? storage.load() : null;
      } catch (err) {
        console.error("AI-бюджет: не удалось прочитать расход:", err.message);
      }
      state =
        saved && saved.day === day && Number.isFinite(Number(saved.spent))
          ? { ...fresh(day), spent: Number(saved.spent), calls: Number(saved.calls) || 0, rejected: Number(saved.rejected) || 0 }
          : fresh(day);
    }
    if (state.day !== day) state = fresh(day);
    return state;
  }

  function persist() {
    if (!storage || typeof storage.save !== "function") return;
    try {
      storage.save({ ...state });
    } catch (err) {
      console.error("AI-бюджет: не удалось сохранить расход:", err.message);
    }
  }

  /**
   * Резерв перед вызовом модели. enforce=false — вызов учитывается, но не блокируется
   * (админские инструменты не должны отключаться из-за трафика на сайте).
   */
  function reserve(estimate, { enforce = true } = {}) {
    const s = current();
    const amount = Math.max(0, Math.ceil(Number(estimate) || 0));
    if (enforce && dailyTokens > 0 && s.spent + reserved + amount > dailyTokens) {
      s.rejected++;
      throw exceeded();
    }
    reserved += amount;
    return { day: s.day, amount, settled: false };
  }

  /** Быстрый отказ до разбора запроса, если лимит суток уже выбран. */
  function ensureAvailable({ enforce = true } = {}) {
    const s = current();
    if (enforce && dailyTokens > 0 && s.spent + reserved >= dailyTokens) {
      s.rejected++;
      throw exceeded();
    }
  }

  /** Списание по факту; tokens=null — расход неизвестен, списывается резерв целиком. */
  function settle(ticket, tokens) {
    if (!ticket || ticket.settled) return;
    ticket.settled = true;
    reserved = Math.max(0, reserved - ticket.amount);
    const s = current();
    if (ticket.day !== s.day) return;
    const used = tokens == null ? ticket.amount : Math.max(0, Math.ceil(Number(tokens) || 0));
    if (!used) return;
    s.spent += used;
    s.calls++;
    persist();
  }

  function stats() {
    const s = current();
    return {
      day: s.day,
      limit: dailyTokens || null,
      spent: s.spent,
      reserved,
      remaining: dailyTokens > 0 ? Math.max(0, dailyTokens - s.spent - reserved) : null,
      calls: s.calls,
      rejected: s.rejected,
    };
  }

  return { reserve, ensureAvailable, settle, stats };
}

module.exports = { createBudget, estimateTokens };
