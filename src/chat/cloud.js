import { t } from "../i18n/index.js";
import { MAX_ATTACHMENTS, MAX_TEXT_CHARS } from "./attachments.js";
import { normalize, wantsHandoff } from "./consult.js";
import { SITE_ID } from "../site.js";

const CLOUD_TIMEOUT_MS = 50000;
/** Сервер принимает до 8 МБ на запрос чата; оставляем запас. */
const MAX_PAYLOAD_BYTES = 7.5 * 1024 * 1024;

/** Реплика для истории: ответы консультанта сервер принимает только со своей подписью (sig). */
function historyItem(item) {
  const content = [item.text, item.context].filter(Boolean).join("\n\n").slice(0, 4000);
  if (item.role !== "bot") return { role: "user", content };
  return item.sig ? { role: "assistant", content, sig: item.sig } : null;
}

/**
 * Ответ облачного ИИ через /api/chat. Каталог с ценами сервер берёт из своей базы.
 * null — ИИ не настроен на сервере (нужно отвечать офлайн).
 */
export async function consultCloud(userText, attachments, priorHistory) {
  // Тему (текст, документы, картинки) оценивает ИИ-ядро: ключевые слова дают ложные отказы.
  const files = attachments || [];

  const payload = {
    message: String(userText || "").trim(),
    site: SITE_ID,
    history: (priorHistory || [])
      .filter((item) => item && (item.role === "user" || item.role === "bot") && (item.text || item.context))
      .slice(-10)
      .map(historyItem)
      .filter(Boolean),
    attachments: files.slice(0, MAX_ATTACHMENTS).map((f) => {
      const out = { kind: f.kind, name: f.name, type: f.type, size: f.size };
      if (f.kind === "text") out.text = String(f.text || "").slice(0, MAX_TEXT_CHARS);
      if (f.kind === "text" && Array.isArray(f.images) && f.images.length) out.images = f.images;
      if (f.kind === "image" && f.dataUrl) out.dataUrl = f.dataUrl;
      if (f.summary) out.summary = String(f.summary).slice(0, 1000);
      if (f.error) out.error = String(f.error).slice(0, 500);
      return out;
    }),
  };

  const body = JSON.stringify(payload);
  if (new Blob([body]).size > MAX_PAYLOAD_BYTES) {
    const sizeErr = new Error(t("chat.error.too_large"));
    sizeErr.code = "body_too_large";
    throw sizeErr;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLOUD_TIMEOUT_MS);

  let res;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err && err.name === "AbortError";
    const netErr = new Error(
      aborted ? t("chat.error.timeout") : t("chat.error.network")
    );
    netErr.code = aborted ? "timeout" : "network";
    throw netErr;
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (res.status === 503 && data && data.error === "ai_not_configured") return null;

  if (!res.ok) {
    const apiErr = new Error(
      res.status === 413
        ? t("chat.error.too_large")
        : (data && data.message) ||
          (res.status === 429 ? t("chat.error.rate_limit") : t("chat.error.unavailable"))
    );
    apiErr.code = (data && data.error) || "http_" + res.status;
    apiErr.status = res.status;
    throw apiErr;
  }

  if (!data || !data.text) return null;
  const answer = String(data.text).trim();
  const handoff =
    !data.offTopic && (!!data.handoff || (wantsHandoff(normalize(answer)) && /whatsapp|телеграм|кнопк/i.test(answer) /* i18n-ignore: разбор ответа ИИ */));
  return {
    text: answer,
    handoff,
    offTopic: !!data.offTopic,
    imageNotes: String(data.imageNotes || ""),
    sig: typeof data.sig === "string" ? data.sig : "",
  };
}
