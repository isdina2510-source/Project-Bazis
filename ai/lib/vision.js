/** Зрение ядра: подготовка картинок в сообщениях под настройки (вкл/выкл, detail). */

const isImagePart = (part) => part && part.type === "image_url" && part.image_url && part.image_url.url;

function countImages(messages) {
  let n = 0;
  for (const m of messages || []) {
    if (Array.isArray(m && m.content)) n += m.content.filter(isImagePart).length;
  }
  return n;
}

/**
 * vision=false (модель без зрения) — картинки заменяются текстовой пометкой, чтобы запрос не упал с 400.
 * Иначе проставляется detail из настроек, если фича не задала свой.
 */
function prepareVisionMessages(messages, { vision = true, imageDetail = "auto" } = {}) {
  return (messages || []).map((m) => {
    if (!m || !Array.isArray(m.content) || !m.content.some(isImagePart)) return m;
    if (!vision) {
      const skipped = m.content.filter(isImagePart).length;
      const content = m.content.filter((part) => !isImagePart(part));
      content.push({
        type: "text",
        text: "[Клиент приложил изображений: " + skipped + ", но просмотр картинок отключён. Попроси описать словами, что на них.]",
      });
      return { ...m, content };
    }
    return {
      ...m,
      content: m.content.map((part) =>
        isImagePart(part) && !part.image_url.detail
          ? { ...part, image_url: { ...part.image_url, detail: imageDetail } }
          : part
      ),
    };
  });
}

module.exports = { countImages, prepareVisionMessages };
