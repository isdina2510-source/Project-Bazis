const { createOpenAiProvider } = require("./openai");

/**
 * Реестр провайдеров. Новый провайдер — фабрика (env) => { name, configured, model, chat }.
 * chat({ messages, model, temperature, maxTokens, json, signal, onUsage }) => текст ответа.
 * onUsage(totalTokens) — фактический расход для суточного бюджета; ошибки, за которые
 * провайдер не берёт денег (HTTP 4xx/5xx), помечаются notBilled: true.
 * Выбирается переменной AI_PROVIDER в .env (по умолчанию openai).
 */
const PROVIDERS = {
  openai: createOpenAiProvider,
};

function createProvider(env) {
  const name = String(env.AI_PROVIDER || "openai").trim().toLowerCase();
  const factory = PROVIDERS[name];
  if (!factory) {
    throw new Error(`Неизвестный AI_PROVIDER "${name}". Доступны: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return factory(env);
}

module.exports = { createProvider, PROVIDERS };
