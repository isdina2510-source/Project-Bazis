/**
 * Офлайн-консультант по каталогу (используется, когда облачный ИИ недоступен)
 * и общие правила темы для облачного режима.
 */
import { CATEGORIES, formatFromPrice, getCategoryLabel, isOutOfStock } from "../lib/catalog.js";
import { SIBLING, SIBLING_ID, SITE, siteHasCategory, siteUrl } from "../site.js";

export const CHIP_LABELS = {
  "Экспресс-аудит бизнеса": "Аудит",
  "Карта процессов компании": "Карта процессов",
  "Регламенты под ключ": "Регламенты",
  "Выход из микроменеджмента": "Микроменеджмент",
  "Менторство владельца": "Менторство",
  "Запуск управленческого контура": "Контур управления",
  "Создание сайта": "Создание сайта",
  "Видеоролик под ключ": "Видеоролик",
  "Мультфильм на заказ": "Мультфильм",
  "Генерация фото": "Генерация фото",
  "ИИ-фотосессия": "ИИ-фотосессия",
  "Оживление фото": "Оживление фото",
  "Пригласительные на мероприятия": "Пригласительные",
};

export const BACK_REPLY = "Выберите раздел ниже — открою услуги внутри.";
export const GREETING =
  "Здравствуйте! Я ИИ-консультант Дина.\nВыберите раздел ниже — открою услуги внутри. Можно также написать вопрос.";

const SOFT_CTA =
  "\n\nЕсли захотите обсудить подбор под вашу задачу — напишите «Связаться» или нажмите кнопку WhatsApp внизу.";

export function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .trim();
}

export function productPrice(product) {
  return formatFromPrice(product.price, product.currency);
}

export function getCatalogGroups(products) {
  return CATEGORIES.map((cat) => ({
    id: cat.id,
    title: cat.title,
    eyebrow: cat.eyebrow || "",
    lead: cat.lead || "",
    items: products.filter((p) => p.category === cat.id),
  })).filter((group) => group.items.length);
}

export function getCatalogLines(products) {
  const lines = [];
  getCatalogGroups(products).forEach((group) => {
    lines.push(group.title + ":");
    group.items.forEach((p, i) =>
      lines.push(i + 1 + ". " + p.title + " (" + productPrice(p) + ")" + (isOutOfStock(p) ? " — нет в наличии" : ""))
    );
  });
  return lines;
}

export function serviceCountLabel(n) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  let word = "услуг";
  if (abs < 11 || abs > 19) {
    if (last === 1) word = "услуга";
    else if (last >= 2 && last <= 4) word = "услуги";
  }
  return n + " " + word;
}

export function cheapestPrice(items) {
  if (!items || !items.length) return "";
  const cheapest = items.slice().sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0))[0];
  return productPrice(cheapest);
}

function sectionsText() {
  return CATEGORIES.map((cat) => cat.title.charAt(0).toLowerCase() + cat.title.slice(1)).join(", ");
}

function formatCatalogMessage(products) {
  const lines = [SITE.label + ": все услуги и цены.", ""];
  getCatalogGroups(products).forEach((group) => {
    lines.push("### " + group.title);
    group.items.forEach((p) => lines.push("• **" + p.title + "** — " + productPrice(p)));
    lines.push("");
  });
  lines.push("Нажмите услугу ниже — расскажу, что входит. Или напишите «Связаться».");
  return lines.join("\n");
}

function formatCategoryMessage(products, catId) {
  const group = getCatalogGroups(products).find((item) => item.id === catId);
  if (!group) return formatCatalogMessage(products);
  const lines = ["### " + group.title];
  if (group.lead) lines.push(group.lead);
  lines.push("");
  group.items.forEach((p) => lines.push("• **" + p.title + "** — " + productPrice(p)));
  lines.push("", "Нажмите конкретную услугу — расскажу подробнее.");
  return lines.join("\n");
}

function formatProductReply(product) {
  const category = getCategoryLabel(product.category);
  return [
    "### " + product.title,
    "**" + productPrice(product) + "**" + (category ? " · " + category : ""),
    "",
    product.description || "",
    "",
    "Если формат подходит — оформите в разделе «Услуги» или напишите «Связаться».",
  ].join("\n");
}

export function findProductByQuery(products, q) {
  if (!products.length) return null;
  const quoted = q.match(/«([^»]+)»/);
  if (quoted) {
    const needle = normalize(quoted[1]);
    const exact = products.find((p) => normalize(p.title) === needle || (p.title_kk && normalize(p.title_kk) === needle));
    if (exact) return exact;
    const partial = products.find((p) => {
      const title = normalize(p.title);
      return title.includes(needle) || needle.includes(title);
    });
    if (partial) return partial;
  }
  let best = null;
  products.forEach((p) => {
    const title = normalize(p.title);
    if (title.length >= 8 && q.includes(title)) {
      if (!best || title.length > normalize(best.title).length) best = p;
    }
  });
  return best;
}

function findCategoryByQuery(q) {
  return CATEGORIES.find((cat) => q.includes(normalize(cat.title))) || null;
}

export function isBackQuery(q) {
  return /^(обратно|назад|к разделам|в меню|в начало)[.!]?$/.test(normalize(q));
}

export function wantsHandoff(q) {
  if (/^(да|давайте|хочу|ок|хорошо|согласен|согласна)[.!]?$/.test(q)) return true;
  if (/хочу (связаться|написать|поговорить|консультац)/.test(q)) return true;
  if (
    /(связаться|свяжитесь|свяжите|напишите мне|написать вам|переведите|перевести|в whatsapp|в ватсап|в телеграм|whatsapp|ватсап|вацап|telegram|телеграм|динара|к динар)/.test(
      q
    )
  ) {
    return true;
  }
  return /(^|\s)контакт(ы|а)?(\s|$)/.test(q);
}

/** Ключевые слова темы; совпадение только с начала слова («рост», но не «просто»). */
const ON_TOPIC_RE = new RegExp(
  "(?:^|[^а-яёa-z0-9])(?:" +
    [
      "базис", "дин[аы]", "сайт", "лендинг", "магазин", "услуг", "пакет", "цен[аыу]", "стоим", "прайс", "аудит", "диагност",
      "процесс", "регламент", "систем", "операцион", "микроменедж", "ментор", "настав", "делегир", "собственник", "владел",
      "бизнес", "компани", "консульт", "команд", "сотрудник", "персонал", "отдел", "продаж", "финанс", "kpi", "кпи", "хаос",
      "порядок", "управл", "руковод", "лидер", "рол[иья]", "кто вы", "о вас", "чем занима", "чем помо", "что предлага",
      "что прода", "что есть", "каталог", "товар", "заказ", "клиент", "ип(?![а-яё])", "тоо(?![а-яё])", "ооо(?![а-яё])",
      "рост", "масштабир", "узк", "слив", "спасибо", "благодар", "инфраструктур", "видеоролик", "ролик", "мультфильм",
      "мультик", "анимац", "фотосесс", "пригласительн", "приглашен", "оживлен", "оживить", "генераци", "ии.?фото",
      "фото", "видео", "логотип", "бренд", "реклам",
    ].join("|") +
    ")"
);

/** Запрос по теме сайта / консалтинга Базис */
export function isOnTopic(q) {
  if (!q) return false;
  if (wantsHandoff(q) || isBackQuery(q)) return true;
  if (/^(привет|здравствуй|добрый день|добрый вечер|доброе утро|hello|hi)\b/.test(q)) return true;
  return ON_TOPIC_RE.test(q);
}

/** Явно не по теме: вёрстка сайта, CSS, погода и т.п. */
export function isClearlyOffTopic(q) {
  if (!q || isOnTopic(q)) return false;
  return /цвет(ов|овую|ая)?\s*гамм|css|html|javascript|верстк|код\b|программ|погод|рецепт|политик|крипт|нейросет|chatgpt|как изменить (цвет|дизайн|шрифт)|дизайн сайт|поменять цвет|фон сайт|layout|frontend|backend/.test(
    q
  );
}

const quoteNames = (files) => files.map((f) => "«" + f.name + "»").join(", ");

function describeOffTopicFiles(files) {
  const images = files.every((f) => f.kind === "image");
  if (files.length === 1) return (images ? "Изображение " : "Вложенный файл ") + quoteNames(files) + " не относится к услугам сайта";
  return (images ? "Изображения " : "Вложенные файлы ") + quoteNames(files) + " не относятся к услугам сайта";
}

/** Отказ «не по теме» — те же формулировки, что у ИИ-ядра (ai/lib/topic.js). */
export function offTopicReply({ message = "", files = [] } = {}) {
  const lead = files.length
    ? describeOffTopicFiles(files) +
      (String(message).trim() ? ", как и сам вопрос" : "") +
      ", поэтому разобрать " + (files.length > 1 ? "их" : "его") + " не смогу."
    : "Спасибо за сообщение! Этот вопрос не относится к услугам ИП «Базис», поэтому подсказать по нему не смогу.";
  return {
    text:
      lead +
      "\n\nЯ консультирую только по услугам сайта: " + sectionsText() + ". " +
      "Подскажите, что из этого вам интересно, — или пришлите материалы по вашей задаче.",
    handoff: false,
    offTopic: true,
  };
}

function offTopicFilesNote(files) {
  if (!files.length) return "";
  return "Обратите внимание: " + describeOffTopicFiles(files).replace(/^./, (c) => c.toLowerCase()) +
    ", " + (files.length > 1 ? "их" : "его") + " я не учитывала.\n\n";
}

const textIsOnTopic = (text) => isOnTopic(normalize(text));

function consultTextOnly(products, userText) {
  const q = normalize(userText);
  const catalogBlock = "\n\n" + formatCatalogMessage(products);

  if (!q) {
    return {
      text: "Напишите вопрос или приложите файл/фото через «+» — разберу и подскажу по услугам.",
      handoff: false,
    };
  }

  if (isBackQuery(q)) return { text: BACK_REPLY, handoff: false };

  if (wantsHandoff(q)) {
    return {
      text:
        "Отлично. Перевожу вас к живому контакту ИП «Базис». Нажмите зелёную кнопку «Продолжить в WhatsApp» или Telegram — откроется чат с готовым текстом вашего запроса.",
      handoff: true,
    };
  }

  if (/^(привет|здравствуй|добрый|hello|hi)\b/.test(q)) {
    return {
      text:
        "Здравствуйте! Я ИИ-консультант Дина.\nВыберите раздел ниже — открою услуги внутри. Можно также написать вопрос — или прикрепить файл через «+».",
      handoff: false,
    };
  }

  const matchedProduct = findProductByQuery(products, q);
  if (matchedProduct) return { text: formatProductReply(matchedProduct), handoff: false };

  if (
    /продае|продаёт|продаж|услуг|товар|каталог|что есть|чем занима|что предлага|какие пакет|какие услуг|прайс|цен|стоим|сколько сто|все услуг/.test(
      q
    )
  ) {
    return { text: formatCatalogMessage(products), handoff: false };
  }

  const matchedCategory = findCategoryByQuery(q);
  if (matchedCategory && /раздел|направлен|что входит/.test(q)) {
    return { text: formatCategoryMessage(products, matchedCategory.id), handoff: false };
  }

  if (/создан.*сайт|разработ.*сайт|нужен сайт|сделать сайт|инфраструктур/.test(q)) {
    return categoryAnswer(products, "infrastructure");
  }

  if (/видеоролик|ролик|мультфильм|анимац|фотосесс|пригласительн|приглашен|оживлен|\bфото\b|\bвидео\b|генераци|визуал/.test(q)) {
    return categoryAnswer(products, "media");
  }

  if (/аудит|диагност|узк|слив/.test(q)) {
    return categoryAnswer(
      products,
      "management",
      "Аудит — стартовая точка: за короткое время разбираем операционку, находим узкие места и «сливы» времени владельца, даём приоритетный список правок.\n\n"
    );
  }

  if (/процесс|регламент|систем|операцион|хаос|порядок|роль|kpi|кпи/.test(q)) {
    return categoryAnswer(
      products,
      "management",
      "Если компания держится на вас, выстраиваем процессы, роли и точки контроля — чтобы работа шла без ежедневного ручного микроменеджмента.\n\n",
      "\n\nНапишите, пожалуйста: ИП или ТОО и примерно сколько человек в команде — подскажу, с чего логичнее начать."
    );
  }

  if (/лидер|управл|ментор|настав|делегир|микроменедж|собственник|владел/.test(q)) {
    return categoryAnswer(
      products,
      "management",
      "С собственником работаем точечно: делегирование, контроль без ручного управления, управленческое мышление.\n\n"
    );
  }

  if (/кто вы|о вас|базис|о компан|чем вы/.test(q)) {
    return {
      text: SITE.label + " — " + sectionsText() + ".\n\n" + formatCatalogMessage(products),
      handoff: false,
    };
  }

  if (isClearlyOffTopic(q) || !isOnTopic(q)) return offTopicReply({ message: userText });

  return {
    text:
      "Поняла ваш запрос. Могу рассказать про любую услугу сайта «" + SITE.label + "»: " + sectionsText() + "." +
      catalogBlock +
      "\n\nУточните, что вам ближе." +
      SOFT_CTA,
    handoff: false,
  };
}

/** Ответ по разделу; если раздел живёт на втором сайте — даём ссылку туда. */
function categoryAnswer(products, catId, intro = "", outro = SOFT_CTA) {
  if (siteHasCategory(catId)) {
    return { text: intro + formatCategoryMessage(products, catId) + outro, handoff: false };
  }
  const url = SIBLING_ID ? siteUrl(SIBLING_ID) : "";
  const label = SIBLING ? SIBLING.label : "";
  return {
    text:
      "Направлением «" + getCategoryLabel(catId) + "» занимается наш второй сайт" +
      (label ? " «" + label + "»" : "") + (url ? ": " + url : "") + ".\n\n" +
      formatCatalogMessage(products),
    handoff: false,
  };
}

/** Офлайн-ответ с учётом вложений. */
export function consultOffline(products, userText, files = []) {
  if (!files.length) return consultTextOnly(products, userText);

  const q = normalize(userText);
  const catalogBlock = "\n\n" + formatCatalogMessage(products);

  // Тема без ИИ: документы проверяем по тексту; картинки офлайн не видны — судим по вопросу клиента.
  const docs = files.filter((f) => f.kind === "text" && f.text);
  const offDocs = docs.filter((f) => !textIsOnTopic(f.text));
  const questionOff = !!q && !isOnTopic(q);
  const anyDocOn = docs.length > offDocs.length;
  if ((questionOff || !q) && !anyDocOn && (offDocs.length || questionOff)) {
    const images = questionOff ? files.filter((f) => f.kind === "image") : [];
    return offTopicReply({ message: userText, files: [...offDocs, ...images] });
  }
  const offNames = new Set(offDocs.map((f) => f.name));
  const note = offTopicFilesNote(offDocs);
  files = files.filter((f) => !offNames.has(f.name));
  if (!files.length) {
    const base = consultTextOnly(products, userText);
    return { ...base, text: note + base.text };
  }

  const parts = [];
  let hasImage = false;
  let hasText = false;
  let textBlob = "";

  files.forEach((f) => {
    if (f.kind === "error") {
      parts.push("• " + f.name + ": " + f.error);
    } else if (f.kind === "image") {
      hasImage = true;
      parts.push("• Картинка «" + f.name + "»" + (f.width ? " (" + f.width + "×" + f.height + ")" : "") + " — приняла.");
    } else if (f.kind === "text" && !f.text) {
      parts.push(
        "• «" + f.name + "» — текста нет, только изображения. Их я рассмотрю, когда заработает облачный ИИ; пока можно отправить файл в WhatsApp."
      );
    } else if (f.kind === "text") {
      hasText = true;
      textBlob += "\n\n--- " + f.name + " ---\n" + (f.text || "");
      const pics = f.images && f.images.length ? " (картинки внутри посмотрю в облачном режиме)" : "";
      parts.push("• Файл «" + f.name + "» — прочитала текст" + pics + ".");
    } else {
      parts.push("• «" + f.name + "» — вижу вложение, но это не текст/фото для авторазбора.");
    }
  });

  let reply =
    note + (files.length > 1 ? "Получила вложения (" + files.length + ")" : "Получила вложение") + ":\n" + parts.join("\n");

  if (hasText) {
    const tq = normalize(textBlob + " " + userText);
    if (siteHasCategory("management") && /аудит|диагност|процесс|регламент|хаос|микроменедж|kpi|сотрудник|отдел|продаж|финанс|бизнес|управл/.test(tq)) {
      reply +=
        "\n\nПо тексту вижу тему про операционку/управление. Для таких задач у «Базис» обычно подходят аудит, карта процессов или выход из микроменеджмента." +
        catalogBlock;
    } else {
      reply +=
        "\n\nКратко по файлу: я учла содержимое в контексте услуг «" + SITE.label + "». " +
        (siteHasCategory("management")
          ? "Уточните, что разобрать: процессы, роли или выбор пакета."
          : "Уточните, что нужно создать и к какому сроку — подберу услугу.");
    }
    if (textBlob.length > 400) {
      reply += "\n\nФрагмент, на который опираюсь:\n«" + textBlob.trim().slice(0, 380) + "…»";
    }
  }

  if (hasImage && !hasText) {
    reply +=
      "\n\nИзображение открыла. Если это про ваш бизнес (процессы, схема, отчёт) — кратко напишите, что нужно понять. Вопросы не по теме сайта (например, как поменять дизайн страницы) лучше переформулировать: что интересует из услуг или какой процесс требует консультанта?";
  }

  if (!q && !hasText && !hasImage) return { text: reply + SOFT_CTA, handoff: false };

  if (wantsHandoff(q)) {
    reply += "\n\nПеревожу к живому контакту: нажмите WhatsApp — удобно сразу переслать те же файлы Динаре.";
    return { text: reply, handoff: true };
  }

  if (q && !hasText) {
    const base = consultTextOnly(products, userText);
    return { text: reply + "\n\n" + base.text, handoff: base.handoff };
  }

  return { text: reply + SOFT_CTA, handoff: false };
}
