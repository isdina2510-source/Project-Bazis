/** Общие помощники для сборки сообщений — переиспользуются разными фичами. */
const { normalizeContent } = require("./history-sign");

/** Картинок в одном сообщении модели: больше — дорого и медленно. */
const MAX_IMAGE_PARTS = 4;
/** Вся история в символах: длинная история — это деньги на каждом следующем запросе. */
const MAX_HISTORY_CHARS = 16000;

/**
 * История диалога из браузера. Реплики «assistant» принимаются только с подписью сервера
 * (verifyAssistant(content, sig)); без проверки или с неверной подписью они отбрасываются.
 */
function sanitizeHistory(raw, limit = 12, { verifyAssistant = null } = {}) {
  if (!Array.isArray(raw)) return [];
  const out = raw
    .slice(-limit)
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const content = normalizeContent(item.content);
      if (!content) return null;
      if (item.role !== "assistant") return { role: "user", content };
      if (typeof verifyAssistant !== "function" || !verifyAssistant(content, item.sig)) return null;
      return { role: "assistant", content };
    })
    .filter(Boolean);
  let total = 0;
  let start = out.length;
  while (start > 0 && total + out[start - 1].content.length <= MAX_HISTORY_CHARS) {
    total += out[start - 1].content.length;
    start--;
  }
  return out.slice(start);
}

/**
 * Текст пользователя + вложения в формате content-parts.
 * attachments — результат parseAttachments() из ./attachments (уже разобранные и проверенные).
 */
function buildUserContent(message, attachments, options = {}) {
  const prefix = options.prefix == null ? "Вопрос клиента: " : options.prefix;
  const maxImages = options.maxImages == null ? MAX_IMAGE_PARTS : options.maxImages;
  const textParts = [];
  const userText = String(message || "").trim().slice(0, 4000);
  if (userText) textParts.push(prefix + userText);

  const images = [];
  const addImage = (dataUrl) => {
    if (images.length >= maxImages) return false;
    images.push({ type: "image_url", image_url: { url: dataUrl } });
    return true;
  };
  const list = Array.isArray(attachments) ? attachments : [];
  for (const f of list) {
    if (!f || typeof f !== "object") continue;
    const name = String(f.name || "файл");
    if (f.kind === "text" && (f.text || (f.images && f.images.length))) {
      const docImages = (f.images || []).filter((img) => addImage(img.dataUrl));
      textParts.push(
        "Содержимое вложения: " + f.summary + "." +
          (f.text
            ? " Текст уже извлечён, опирайся на него" + (f.truncated ? " (показано начало документа)" : "") +
              ":\n<<<\n" + f.text + "\n>>>"
            : "") +
          (docImages.length
            ? "\nИзображения из этого документа (" + docImages.map((img) => img.name).join(", ") + ") приложены ниже — рассмотри их."
            : "")
      );
    } else if (f.kind === "image" && f.dataUrl) {
      textParts.push(
        addImage(f.dataUrl)
          ? "Приложено изображение «" + name + "» — оно ниже."
          : "Изображение «" + name + "» не передано: слишком много картинок в одном сообщении."
      );
    } else if (f.kind === "error") {
      textParts.push(f.summary + ". Сообщи клиенту, что файл не прочитан, и предложи, как прислать иначе.");
    } else {
      textParts.push(String(f.summary || "Вложение «" + name + "»"));
    }
  }

  const content = [
    {
      type: "text",
      text: textParts.join("\n\n") || "Пользователь прислал вложения без текста. Разбери их, если возможно.",
    },
  ];
  return content.concat(images);
}

module.exports = { sanitizeHistory, buildUserContent, MAX_IMAGE_PARTS, MAX_HISTORY_CHARS };
