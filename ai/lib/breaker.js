const { AiError } = require("../errors");

/**
 * Автоматический выключатель: после N подряд сбоев провайдера перестаёт его дёргать
 * на cooldownMs и сразу отдаёт 503 (фронтенд в этот момент отвечает офлайн).
 * Затем пропускает один пробный запрос: успех — закрывается, сбой — снова открывается.
 *
 * requestId связывает все вызовы модели одного вопроса (ответ, фильтр темы, описание фото):
 * в полуоткрытом состоянии они проходят вместе, а чужой запрос ждёт. Итог запроса
 * записывается один раз — повторный success/failure с тем же id игнорируется.
 */
function createBreaker({ threshold = 5, cooldownMs = 30000, now = Date.now } = {}) {
  let failures = 0;
  let openedAt = 0;
  let probing = false;
  let probeId = null;
  /** Запросы, которые прошли check() и ещё не сдали итог. */
  const admitted = new Set();

  function state() {
    if (failures < threshold) return "closed";
    return now() - openedAt >= cooldownMs ? "half-open" : "open";
  }

  function ownsProbe(requestId) {
    return !requestId || !probeId || probeId === requestId;
  }

  return {
    check(requestId) {
      const s = state();
      if (s === "closed" || (s === "half-open" && (!probing || (requestId && probeId === requestId)))) {
        if (s === "half-open" && !probing) {
          probing = true;
          probeId = requestId || null;
        }
        if (requestId) admitted.add(requestId);
        return;
      }
      throw new AiError("ai_unavailable", 503, "ИИ временно недоступен. Попробуйте позже.");
    },
    success(requestId) {
      if (requestId && !admitted.delete(requestId)) return;
      if (!ownsProbe(requestId)) return;
      failures = 0;
      probing = false;
      probeId = null;
    },
    failure(requestId) {
      if (requestId && !admitted.delete(requestId)) return;
      if (!ownsProbe(requestId)) return;
      probing = false;
      probeId = null;
      failures++;
      if (failures >= threshold) openedAt = now();
    },
    /** Запрос завершился не по вине провайдера (клиент ушёл) — освободить пробный слот. */
    release(requestId) {
      if (requestId && !admitted.delete(requestId)) return;
      if (!ownsProbe(requestId)) return;
      probing = false;
      probeId = null;
    },
    stats: () => ({ state: state(), failures }),
  };
}

module.exports = { createBreaker };
