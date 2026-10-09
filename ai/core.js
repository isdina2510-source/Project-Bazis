const crypto = require("crypto");
const { AiError, fromAbortReason } = require("./errors");
const { loadAiConfig } = require("./config");
const { withRetry } = require("./lib/retry");
const { createLimiter } = require("./lib/limiter");
const { createBreaker } = require("./lib/breaker");
const { countImages, prepareVisionMessages } = require("./lib/vision");
const { createBudget, estimateTokens } = require("./lib/budget");

/**
 * Контракт фичи:
 *   name           уникальное имя, часть URL /api/ai/:name
 *   buildMessages  (input, ctx) => messages для провайдера (обязательно); null — без вызова модели,
 *                  formatResult получит пустой text (например, фича сама решила отказать)
 *   parseInput     (body, ctx) => input; бросает AiError при невалидных данных
 *   formatResult   (text, input, ctx) => объект ответа; по умолчанию { text }
 *   В ctx есть complete(messages, { temperature, maxTokens, json }) — дополнительный вызов модели;
 *   json: true просит у провайдера ответ строго в JSON.
 *   Картинки (content-part image_url) ядро готовит само: detail, отдельная модель, отключение зрения.
 *   access         "public" | "admin" (по умолчанию "public")
 *   model, fallbackModels, temperature, maxTokens, timeoutMs, maxBodyBytes,
 *   rateLimit: { limit, windowMs }
 *   В ctx.services — зависимости от сервера (каталог из базы, подпись истории), см. createAi().
 *
 * Каждая попытка вызова модели проходит через суточный бюджет токенов (config.dailyTokens);
 * вызовы admin-фич учитываются, но не блокируются.
 *
 * Контракт плагина (все методы необязательны, ошибки в них не ломают запрос):
 *   name, onStart(call), onSuccess(call, result), onError(call, err), snapshot()
 */
function createAiCore({
  provider,
  features = [],
  plugins = [],
  config = loadAiConfig({}),
  budgetStorage = null,
  services = {},
}) {
  /** @type {Map<string, object>} */
  const registry = new Map();
  const pluginList = [];
  const limiter = createLimiter(config);
  const breaker = createBreaker({ threshold: config.breakerThreshold, cooldownMs: config.breakerCooldownMs });
  const budget = createBudget({ dailyTokens: config.dailyTokens, storage: budgetStorage });

  function register(feature) {
    if (!feature || typeof feature.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(feature.name)) {
      throw new Error("AI-фича должна иметь name из [a-z0-9-]");
    }
    if (typeof feature.buildMessages !== "function") {
      throw new Error(`AI-фича "${feature.name}": нет buildMessages()`);
    }
    if (feature.access && feature.access !== "public" && feature.access !== "admin") {
      throw new Error(`AI-фича "${feature.name}": access должен быть "public" или "admin"`);
    }
    if (registry.has(feature.name)) throw new Error(`AI-фича "${feature.name}" уже зарегистрирована`);
    registry.set(feature.name, Object.freeze({ access: "public", ...feature }));
  }

  function use(plugin) {
    if (!plugin || typeof plugin !== "object") throw new Error("AI-плагин должен быть объектом");
    pluginList.push(plugin);
  }

  features.forEach(register);
  plugins.forEach(use);

  function emit(hook, ...args) {
    for (const plugin of pluginList) {
      if (typeof plugin[hook] !== "function") continue;
      try {
        plugin[hook](...args);
      } catch (err) {
        console.error(`AI-плагин ${plugin.name || "?"}.${hook}:`, err);
      }
    }
  }

  function assertConfigured() {
    if (!provider.configured) {
      throw new AiError("ai_not_configured", 503, provider.notConfiguredMessage || "ИИ не настроен на сервере");
    }
  }

  function countsAsProviderFailure(err) {
    return Boolean(err && (err.retryable || err.code === "timeout"));
  }

  /** Промис завершается не позже сигнала, даже если провайдер сигнал игнорирует. */
  function untilAborted(promise, signal) {
    if (signal.aborted) return Promise.reject(fromAbortReason(signal.reason));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(fromAbortReason(signal.reason));
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  /** Одна попытка вызова модели: таймаут попытки + отмена клиентом. */
  async function attempt(call, feature, messages, model, deadline, signal) {
    if (signal && signal.aborted) throw fromAbortReason(signal.reason);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new AiError("timeout", 504, "Таймаут ответа ИИ");
    const maxTokens = feature.maxTokens || config.maxOutputTokens;
    const ticket = budget.reserve(estimateTokens(messages, maxTokens, config), { enforce: feature.access !== "admin" });
    let usedTokens = null;
    call.attempts++;
    call.model = model;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new AiError("timeout", 504, "Таймаут ответа ИИ")), remaining);
    const attemptSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      const pending = Promise.resolve().then(() =>
        provider.chat({
          messages,
          model,
          temperature: feature.temperature,
          maxTokens,
          json: feature.json,
          signal: attemptSignal,
          onUsage: (tokens) => {
            usedTokens = tokens;
          },
        })
      );
      const text = await untilAborted(pending, attemptSignal);
      if (typeof text !== "string" || !text) {
        throw new AiError("ai_upstream_error", 502, "Не удалось получить ответ от ИИ", "empty_answer");
      }
      return text;
    } catch (err) {
      // Обрыв или таймаут: запрос мог дойти до провайдера и быть оплачен — списываем резерв целиком.
      if (usedTokens == null && err && err.notBilled) usedTokens = 0;
      throw err;
    } finally {
      clearTimeout(timer);
      budget.settle(ticket, usedTokens);
    }
  }

  /**
   * Выключатель считает вопрос пользователя целиком, а не каждый вызов модели:
   * повтор, фильтр темы и описание картинок делят один requestId.
   * check() только пропускает или сразу отдаёт 503; итог пишется в конце run().
   */
  async function callModel(call, feature, messages, deadline, signal) {
    if (signal && signal.aborted) throw fromAbortReason(signal.reason);
    breaker.check(call.requestId);
    return callModelWithFallback(call, feature, messages, deadline, signal);
  }

  /** Один итог на вопрос. Повторный вызов с тем же id выключатель игнорирует. */
  function settleBreaker(requestId, err) {
    if (!err) {
      breaker.success(requestId);
      return;
    }
    if (countsAsProviderFailure(err)) breaker.failure(requestId);
    else if (err.code === "client_closed" || err.code === "ai_budget_exceeded") breaker.release(requestId);
    else breaker.success(requestId);
  }

  /** Повторы по каждой модели, затем переключение на резервные модели. */
  async function callModelWithFallback(call, feature, messages, deadline, signal) {
    const primary = (call.images > 0 && config.visionModel) || feature.model || provider.model;
    const models = [...new Set([primary, ...(feature.fallbackModels || config.fallbackModels)].filter(Boolean))];
    let lastErr;
    for (const model of models) {
      try {
        return await withRetry(() => attempt(call, feature, messages, model, deadline, signal), {
          retries: config.retries,
          baseMs: config.retryBaseMs,
          maxMs: config.retryMaxMs,
          deadline,
          signal,
        });
      } catch (err) {
        lastErr = err;
        const canFallback = err && (err.retryable || err.modelUnavailable);
        if (!canFallback || Date.now() >= deadline) throw err;
      }
    }
    throw lastErr;
  }

  async function run(name, body, ctx = {}) {
    const feature = registry.get(name);
    if (!feature) throw new AiError("feature_not_found", 404);
    assertConfigured();
    budget.ensureAvailable({ enforce: feature.access !== "admin" });

    const requestId = ctx.requestId || crypto.randomUUID();
    const call = {
      id: requestId,
      requestId,
      feature: name,
      ip: ctx.ip || null,
      startedAt: Date.now(),
      durationMs: 0,
      attempts: 0,
      model: null,
    };
    emit("onStart", call);
    const deadline = call.startedAt + (feature.timeoutMs || config.deadlineMs);
    const runModel = (target, rawMessages, overrides = {}) => {
      const messages = prepareVisionMessages(rawMessages, config);
      target.images = config.vision !== false ? countImages(messages) : 0;
      const { signal: overrideSignal, ...featureOverrides } = overrides;
      const signal =
        overrideSignal && ctx.signal ? AbortSignal.any([ctx.signal, overrideSignal]) : overrideSignal || ctx.signal;
      return limiter.run(
        () => callModel(target, { ...feature, ...featureOverrides }, messages, deadline, signal),
        signal,
        deadline - Date.now()
      );
    };
    /** Дополнительный вызов модели из фичи (те же очередь, повторы и выключатель); не попадает в метрики. */
    const featureCtx = {
      ...ctx,
      services,
      complete: (messages, overrides) =>
        runModel({ attempts: 0, model: null, images: 0, requestId }, messages, overrides),
    };
    try {
      const input = feature.parseInput ? await feature.parseInput(body || {}, featureCtx) : body || {};
      const messages = await feature.buildMessages(input, featureCtx);
      const text = messages == null ? "" : await runModel(call, messages);
      const result = feature.formatResult ? await feature.formatResult(text, input, featureCtx) : { text };
      call.durationMs = Date.now() - call.startedAt;
      settleBreaker(requestId, null);
      emit("onSuccess", call, result);
      return result;
    } catch (err) {
      call.durationMs = Date.now() - call.startedAt;
      settleBreaker(requestId, err);
      emit("onError", call, err);
      throw err;
    }
  }

  function status() {
    return {
      configured: provider.configured,
      provider: provider.name,
      model: provider.configured ? provider.model : null,
      vision: config.vision !== false,
      features: [...registry.values()].map((f) => ({
        name: f.name,
        description: f.description || "",
        access: f.access,
      })),
    };
  }

  /** Подробное состояние для мониторинга (только для админа). */
  function health() {
    const pluginsState = {};
    for (const plugin of pluginList) {
      if (plugin.name && typeof plugin.snapshot === "function") pluginsState[plugin.name] = plugin.snapshot();
    }
    return {
      ...status(),
      breaker: breaker.stats(),
      limiter: limiter.stats(),
      budget: budget.stats(),
      fallbackModels: config.fallbackModels,
      visionModel: config.visionModel || null,
      imageDetail: config.imageDetail,
      ...pluginsState,
    };
  }

  return {
    register,
    use,
    run,
    status,
    health,
    assertConfigured,
    get: (name) => registry.get(name) || null,
    provider,
    config,
    services,
  };
}

module.exports = { createAiCore };
