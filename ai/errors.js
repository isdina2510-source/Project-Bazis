/** Ошибка ИИ-ядра: code уходит клиенту как `error`, status — HTTP-код ответа. */
class AiError extends Error {
  constructor(code, status, message, detail) {
    super(message || code);
    this.name = "AiError";
    this.code = code;
    this.status = status || 500;
    if (detail) this.detail = detail;
  }
}

/** Причина AbortSignal → AiError: таймаут ядра или уход клиента. */
function fromAbortReason(reason) {
  if (reason instanceof AiError) return reason;
  if (reason && reason.name === "TimeoutError") return new AiError("timeout", 504, "Таймаут ответа ИИ");
  return new AiError("client_closed", 499, "Клиент закрыл соединение");
}

module.exports = { AiError, fromAbortReason };
