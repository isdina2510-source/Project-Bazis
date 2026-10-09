/**
 * ИИ-ядро: провайдер (OpenAI и т.п.) + реестр фич + плагины + HTTP-слой.
 *
 * Добавить новую функцию: создать файл в ai/features/ (см. consultant.js) —
 * он подключится автоматически и станет доступен по POST /api/ai/<name>.
 * Добавить провайдера: фабрика в ai/providers/ + запись в providers/index.js.
 * Добавить сквозную логику (аудит, учёт расходов): плагин в ai/plugins/ и ai.use().
 */
const { createAiCore } = require("./core");
const { loadAiConfig } = require("./config");
const { createProvider } = require("./providers");
const { loadFeatures } = require("./features");
const { createAiHttpHandler } = require("./http");
const { createLoggerPlugin } = require("./plugins/logger");
const { createMetricsPlugin } = require("./plugins/metrics");
const { AiError } = require("./errors");
const { createHistorySigner } = require("./lib/history-sign");

/**
 * Зависимости от сервера (все необязательны, вызываются лениво — база открывается позже ядра):
 *   budgetStorage   { load(), save(state) } — расход суточного бюджета переживает перезапуск
 *   getProducts     () => товары из базы — каталог для промпта консультанта
 *   historySecret   () => строка ≥ 16 символов — ключ подписи реплик консультанта в истории
 *   notifier        { alert(key, text) } — оповещение о сбоях (например, каталог для консультанта не прочитался)
 */
function createAi(env = process.env, { budgetStorage = null, getProducts = null, historySecret = null, notifier = null } = {}) {
  const config = loadAiConfig(env);
  const plugins = [createMetricsPlugin()];
  if (config.log) plugins.push(createLoggerPlugin());
  const services = {
    getProducts,
    notifier,
    historySigner: historySecret ? createHistorySigner(historySecret) : null,
  };
  return createAiCore({ provider: createProvider(env), features: loadFeatures(), plugins, config, budgetStorage, services });
}

module.exports = { createAi, createAiCore, createAiHttpHandler, loadAiConfig, AiError };
