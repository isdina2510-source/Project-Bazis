const { AiError, fromAbortReason } = require("../errors");

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function parseRetryAfter(header) {
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function upstreamError(status, detail, extra = {}) {
  const err = new AiError("ai_upstream_error", status, "Не удалось получить ответ от ИИ", detail);
  return Object.assign(err, extra);
}

/**
 * OpenAI-совместимый провайдер (/v1/chat/completions).
 * Подходит и для совместимых API (OpenRouter, локальные LLM) через BAZIS_AI_URL.
 * Таймауты, повторы и отмена — забота ядра: провайдер только уважает signal
 * и помечает временные ошибки флагом retryable.
 */
function createOpenAiProvider(env) {
  const apiKey = String(env.OPENAI_API_KEY || "").trim();
  const defaultModel = String(env.BAZIS_AI_MODEL || env.OPENAI_MODEL || "gpt-4o-mini").trim();
  const url = String(env.BAZIS_AI_URL || "https://api.openai.com/v1/chat/completions").trim();

  async function chat({ messages, model, temperature, maxTokens, json, signal, onUsage }) {
    const body = {
      model: model || defaultModel,
      temperature: temperature == null ? 0.4 : temperature,
      messages,
    };
    if (maxTokens) body.max_tokens = maxTokens;
    if (json) body.response_format = { type: "json_object" };

    let res;
    let raw;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
        },
        body: JSON.stringify(body),
        signal,
      });
      raw = await res.text();
    } catch (err) {
      if (signal && signal.aborted) throw fromAbortReason(signal.reason);
      throw upstreamError(502, err && err.message, { retryable: true });
    }

    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const status = res.status >= 400 && res.status < 600 ? res.status : 502;
      throw upstreamError(status, raw.slice(0, 240), {
        retryable: RETRYABLE_STATUS.has(res.status),
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
        modelUnavailable: res.status === 404,
        notBilled: true,
      });
    }
    const usage = data && data.usage;
    if (typeof onUsage === "function" && usage && Number.isFinite(Number(usage.total_tokens))) {
      onUsage(Number(usage.total_tokens));
    }
    const choice = data && data.choices && data.choices[0];
    const answer = choice && choice.message && choice.message.content;
    if (!answer) {
      // Обычно это фильтр контента или обрезка по токенам — повтор даст то же самое.
      throw upstreamError(502, "empty_answer finish_reason=" + ((choice && choice.finish_reason) || "?"));
    }
    return String(answer).trim();
  }

  return {
    name: "openai",
    configured: Boolean(apiKey),
    model: defaultModel,
    notConfiguredMessage: "OPENAI_API_KEY не задан в .env",
    chat,
  };
}

module.exports = { createOpenAiProvider };
