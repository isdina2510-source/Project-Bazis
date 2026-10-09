/** Одна строка в консоль на каждый вызов ИИ: id, фича, итог, время, модель, попытки. */
function createLoggerPlugin({ log = console.log, error = console.warn } = {}) {
  const line = (call, outcome) =>
    `[ai] ${call.id.slice(0, 8)} ${call.feature} ${outcome} ${call.durationMs}ms` +
    (call.model ? ` model=${call.model}` : "") +
    (call.attempts > 1 ? ` attempts=${call.attempts}` : "");

  return {
    name: "logger",
    onSuccess(call) {
      log(line(call, "ok"));
    },
    onError(call, err) {
      const code = (err && err.code) || "server_error";
      if (code === "client_closed") return log(line(call, code));
      const detail = err && err.detail ? " " + String(err.detail).replace(/\s+/g, " ").slice(0, 200) : "";
      error(line(call, "error=" + code) + detail);
    },
  };
}

module.exports = { createLoggerPlugin };
