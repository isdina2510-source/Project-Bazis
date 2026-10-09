const crypto = require("crypto");

/**
 * Подпись реплик ИИ, которые браузер хранит и присылает обратно в истории диалога.
 * Без подписи реплику «консультанта» можно сочинить в браузере (например, с выдуманной ценой),
 * и модель продолжит разговор так, будто сама это сказала.
 * getSecret() — строка или Buffer; вызывается лениво, т.к. секрет может жить в базе.
 */

/** Ровно столько символов реплики попадает в историю — подпись считается по той же строке. */
const HISTORY_CONTENT_CHARS = 4000;

const normalizeContent = (content) => String(content || "").trim().slice(0, HISTORY_CONTENT_CHARS);

function createHistorySigner(getSecret) {
  let cached = null;

  function key() {
    if (cached) return cached;
    const secret = typeof getSecret === "function" ? getSecret() : getSecret;
    if (!secret || String(secret).length < 16) return null;
    cached = Buffer.from(String(secret));
    return cached;
  }

  function digest(content) {
    const k = key();
    if (!k) return null;
    return crypto.createHmac("sha256", k).update("assistant\n" + normalizeContent(content)).digest("base64url");
  }

  return {
    sign(content) {
      return digest(content);
    },
    verify(content, sig) {
      const expected = digest(content);
      if (!expected || typeof sig !== "string" || sig.length !== expected.length) return false;
      const given = Buffer.from(sig);
      const want = Buffer.from(expected);
      // Длина строки в символах и в байтах совпадает только у ASCII. Иначе timingSafeEqual бросает,
      // и один кривой sig в истории роняет весь запрос с 500 вместо тихого отбрасывания реплики.
      if (given.length !== want.length) return false;
      return crypto.timingSafeEqual(given, want);
    },
  };
}

module.exports = { createHistorySigner, normalizeContent, HISTORY_CONTENT_CHARS };
