/**
 * Фильтр «не по теме» для фич ядра.
 *
 * Отдельный вызов модели-классификатора (параллельно с ответом) оценивает вопрос и каждое вложение
 * и возвращает строгий JSON. Решение и текст отказа — в коде: одинаковые, вежливые, с именами файлов.
 * Если классификатор упал или ответил мусором — запрос пропускается (лучше ответить, чем ложно отказать).
 */

const CLASSIFIER_DOC_CHARS = 1500;
const CLASSIFIER_HISTORY = 4;

function classifierPrompt(scope) {
  return (
    "Ты фильтр входящих сообщений чата на сайте. Деятельность сайта: " + scope + ".\n" +
    "Оцени отдельно вопрос клиента и каждое вложение: относится ли оно к деятельности сайта.\n\n" +
    "ON (по теме): вопросы об услугах, ценах, сроках, заказе, контактах, о компании и консультанте; " +
    "приветствия, благодарности, короткие ответы вроде «да», «давайте», «а подробнее?» в продолжение диалога; " +
    "любые задачи и проблемы бизнеса клиента (сотрудники, продажи, процессы, хаос, выручка, делегирование); " +
    "документы о компании клиента (структура, отчёты, регламенты, планы, ТЗ, брифы) — даже без названий услуг; " +
    "материалы для сайта, видео, мультфильма, пригласительных; фото людей, портреты, старые снимки, " +
    "фото событий — это исходники для оживления фото, ИИ-фотосессии, генерации или пригласительных.\n" +
    "OFF (не по теме): просьбы, не связанные с услугами — рецепты, переводы, домашние задания, курсовые, код, медицина, " +
    "политика, погода, гороскопы, общие вопросы к ИИ; документы и картинки без связи с бизнесом клиента и услугами " +
    "(учебные работы, мемы, чеки, скриншоты игр); вопросы о картинке, не связанные с услугами («какая это порода собаки»).\n" +
    "Сомневаешься — ставь ON. Каждое вложение оценивай только по его собственному содержимому, независимо от соседних.\n\n" +
    "Ответь JSON. Сначала коротко обоснуй (why), потом вынеси вердикт (topic):\n" +
    '{"question": {"why": "...", "topic": "on" | "off" | "neutral" | "empty"}, ' +
    '"attachments": [{"name": "<имя как во входе>", "why": "...", "topic": "on" | "off"}]}\n' +
    '"neutral" — у вопроса нет своей темы, он только просит посмотреть или оценить вложения («посмотрите файл», «что скажете?»); ' +
    '"empty" — если клиент не написал текста. В attachments перечисли все вложения из входа.\n\n' +
    "Пример. Вопрос: «Посмотрите, что скажете?»; вложение «реферат.docx»: история Древнего Рима; вложение «штат.xlsx»: 8 сотрудников, 2 отдела. Ответ:\n" +
    '{"question": {"why": "своей темы нет, просит посмотреть вложения", "topic": "neutral"}, "attachments": [' +
    '{"name": "реферат.docx", "why": "учебная работа по истории, к бизнесу клиента не относится", "topic": "off"}, ' +
    '{"name": "штат.xlsx", "why": "структура компании клиента", "topic": "on"}]}'
  );
}

/** Вежливые и служебные реплики — всегда по теме, модель тут не нужна. */
const SOCIAL_RE =
  /^(здравствуй|здравствуйте|привет|добрый (день|вечер|утро)|доброе утро|доброго|салем|сәлем|hello|hi|спасибо|благодарю|рахмет|да|нет|ок|окей|хорошо|давайте|понятно|ясно|подробнее|а подробнее)[\s!.,?)]*$/i;

/** Вход классификатора: последние реплики (для «да»/«подробнее»), вопрос и краткое содержимое вложений. */
function buildClassifierMessages(scope, input) {
  const content = [];
  const history = (input.history || [])
    .slice(-CLASSIFIER_HISTORY)
    .map((m) => (m.role === "assistant" ? "Консультант: " : "Клиент: ") + String(m.content).slice(0, 300))
    .join("\n");
  const lines = [];
  if (history) lines.push("Предыдущие реплики:\n" + history);
  lines.push("Вопрос клиента: " + (String(input.message || "").trim() || "(пусто)"));
  const images = [];
  for (const f of input.attachments || []) {
    if (!f || f.kind === "error") continue;
    if (f.kind === "text") {
      lines.push(
        "Вложение «" + f.name + "» (документ):\n" +
          (String(f.text || "").slice(0, CLASSIFIER_DOC_CHARS) || "(без текста)") +
          ((f.images || []).length ? "\n[внутри изображения, первое ниже]" : "")
      );
      if ((f.images || [])[0]) images.push(f.images[0].dataUrl);
    } else if (f.kind === "image") {
      lines.push("Вложение «" + f.name + "» (изображение, ниже).");
      images.push(f.dataUrl);
    } else {
      lines.push("Вложение «" + f.name + "»: " + String(f.summary || "файл"));
    }
  }
  content.push({ type: "text", text: lines.join("\n\n") });
  for (const url of images) content.push({ type: "image_url", image_url: { url, detail: "low" } });
  return [
    { role: "system", content: classifierPrompt(scope) },
    { role: "user", content },
  ];
}

/** Запускает классификатор; промис никогда не отклоняется (null — нет вердикта). */
function startTopicCheck(ctx, scope, input) {
  if (!ctx || typeof ctx.complete !== "function") return Promise.resolve(null);
  const hasFiles = (input.attachments || []).some((f) => f && f.kind !== "error");
  if (!hasFiles && SOCIAL_RE.test(String(input.message || "").trim())) {
    return Promise.resolve({ question: "on", offFiles: [], onFiles: [] });
  }
  return ctx
    .complete(buildClassifierMessages(scope, input), { temperature: 0, maxTokens: 500, json: true })
    .then((raw) => parseClassifierAnswer(raw, input.attachments, input.message))
    .catch(() => null);
}

const norm = (s) => String(s || "").trim().toLowerCase().replace(/^[«"']|[»"']$/g, "");

function parseClassifierAnswer(raw, attachments = [], message = "") {
  let data;
  try {
    data = JSON.parse(String(raw || "").replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const rawQuestion = data.question && typeof data.question === "object" ? data.question.topic : data.question;
  let question = ["on", "off", "neutral", "empty"].includes(rawQuestion) ? rawQuestion : "on";
  if (SOCIAL_RE.test(String(message || "").trim())) question = "on";
  const verdicts = new Map(
    (Array.isArray(data.attachments) ? data.attachments : [])
      .filter((a) => a && typeof a === "object")
      .map((a) => [norm(a.name), a.topic === "off" ? "off" : "on"])
  );
  const judged = (attachments || []).filter((f) => f && f.kind !== "error");
  const offFiles = judged.filter((f) => verdicts.get(norm(f.name)) === "off").map((f) => f.name);
  const onFiles = judged.filter((f) => verdicts.get(norm(f.name)) !== "off").map((f) => f.name);
  return { question, offFiles, onFiles };
}

/** Правила: отказ — если ничего не по теме; иначе пометка о посторонних вложениях. */
function decideTopic(verdict) {
  if (!verdict) return { offTopic: false, offTopicFiles: [] };
  const somethingOn = verdict.question === "on" || verdict.onFiles.length > 0;
  const somethingOff = verdict.question === "off" || verdict.offFiles.length > 0;
  const result = { offTopic: !somethingOn && somethingOff, offTopicFiles: verdict.offFiles };
  if (verdict.question === "off") result.questionOff = true;
  return result;
}

const quote = (names) => names.map((n) => "«" + n + "»").join(", ");

function describeFiles(names, attachments) {
  const byName = new Map((attachments || []).map((f) => [f && f.name, f]));
  const allImages = names.every((n) => byName.get(n) && byName.get(n).kind === "image");
  if (names.length === 1) {
    return (allImages ? "Изображение " : "Вложенный файл ") + quote(names) + " не относится к услугам сайта";
  }
  return (allImages ? "Изображения " : "Вложенные файлы ") + quote(names) + " не относятся к услугам сайта";
}

/** Названия разделов из каталога, который прислал клиент (строки вида «Раздел:»). */
function sectionsFromCatalog(catalog) {
  const titles = String(catalog || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /:$/.test(line) && !/^\d+\./.test(line))
    .map((line) => line.slice(0, -1).trim())
    .filter(Boolean);
  return titles.length ? titles : ["управление бизнесом", "создание сайта", "видео и ИИ-фото", "пригласительные"];
}

/** Полный отказ: запрос целиком не по теме. */
function offTopicReplyText({ message, attachments, offTopicFiles, questionOff, catalog }) {
  const files = offTopicFiles || [];
  const lead = files.length
    ? describeFiles(files, attachments) +
      ((questionOff == null ? String(message || "").trim() : questionOff) ? ", как и сам вопрос" : "") +
      ", поэтому разобрать " + (files.length > 1 ? "их" : "его") + " не смогу."
    : "Спасибо за сообщение! Этот вопрос не относится к услугам Dinara BILab, поэтому подсказать по нему не смогу.";
  const sections = sectionsFromCatalog(catalog)
    .map((s) => s.charAt(0).toLowerCase() + s.slice(1))
    .join(", ");
  return (
    lead +
    "\n\nЯ консультирую только по услугам сайта: " + sections + ". " +
    "Подскажите, что из этого вам интересно, — или пришлите материалы по вашей задаче."
  );
}

/** Частичный отказ: вопрос по теме, но некоторые вложения нет — пометка перед ответом. */
function offTopicFilesNote(offTopicFiles, attachments) {
  if (!offTopicFiles || !offTopicFiles.length) return "";
  return "Обратите внимание: " + describeFiles(offTopicFiles, attachments).replace(/^./, (c) => c.toLowerCase()) +
    ", " + (offTopicFiles.length > 1 ? "их" : "его") + " я не учитывала.";
}

module.exports = {
  startTopicCheck,
  parseClassifierAnswer,
  decideTopic,
  offTopicReplyText,
  offTopicFilesNote,
  buildClassifierMessages,
};
