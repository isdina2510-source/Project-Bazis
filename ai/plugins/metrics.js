/** Счётчики в памяти по каждой фиче: вызовы, ошибки по кодам, время ответа. */
function createMetricsPlugin({ maxSamples = 200 } = {}) {
  const startedAt = new Date().toISOString();
  /** @type {Map<string, object>} */
  const byFeature = new Map();

  function entry(name) {
    let item = byFeature.get(name);
    if (!item) {
      item = { calls: 0, ok: 0, errors: {}, retried: 0, durations: [], lastError: null };
      byFeature.set(name, item);
    }
    return item;
  }

  function record(item, call) {
    item.calls++;
    if (call.attempts > 1) item.retried++;
    item.durations.push(call.durationMs);
    if (item.durations.length > maxSamples) item.durations.shift();
  }

  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  }

  return {
    name: "metrics",
    onSuccess(call) {
      const item = entry(call.feature);
      record(item, call);
      item.ok++;
    },
    onError(call, err) {
      const item = entry(call.feature);
      record(item, call);
      const code = (err && err.code) || "server_error";
      item.errors[code] = (item.errors[code] || 0) + 1;
      item.lastError = { code, at: new Date().toISOString() };
    },
    snapshot() {
      const features = {};
      for (const [name, item] of byFeature) {
        const sorted = item.durations.slice().sort((a, b) => a - b);
        features[name] = {
          calls: item.calls,
          ok: item.ok,
          retried: item.retried,
          errors: item.errors,
          lastError: item.lastError,
          p50Ms: percentile(sorted, 0.5),
          p95Ms: percentile(sorted, 0.95),
        };
      }
      return { since: startedAt, features };
    },
  };
}

module.exports = { createMetricsPlugin };
