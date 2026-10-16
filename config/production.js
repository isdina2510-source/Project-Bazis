/**
 * Что ломается молча, если забыть перед публикацией: ИИ без ключа, оповещения без бота, заглушки в контенте сайта.
 * Дополняет productionProblems() в server.js; каждая строка — что не так и как исправить.
 */

const PLACEHOLDER_TELEGRAM = "bazis";

function filled(value) {
  return String(value == null ? "" : value).trim() !== "";
}

function integrationProblems(env) {
  const problems = [];
  if (!filled(env.OPENAI_API_KEY)) {
    problems.push("Ключ ИИ не задан: добавьте в .env OPENAI_API_KEY — без него консультант в чате отвечает офлайн-ботом.");
  }
  if (!filled(env.TELEGRAM_BOT_TOKEN) || !filled(env.TELEGRAM_CHAT_ID)) {
    problems.push(
      "Оповещения выключены: задайте в .env TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID — иначе о новых заказах, заявках и сбоях никто не узнает."
    );
  }
  return problems;
}

/**
 * Заглушки в исходниках сайта; null — файла нет (в Docker-образе папки src нет, проверка — на компьютере со сборкой).
 * Портфолио показывает только «Dinara BILab Медиа»: пока у медиасайта нет адреса в интернете, стоковые фото никто не видит.
 * @param {{ portfolio: string | null, catalog: string | null, mediaPublished?: boolean }} sources тексты
 *   src/content/portfolio.js и src/lib/catalog.js; mediaPublished — медиасайт включён (MEDIA_SITE_ENABLED=true)
 */
function contentProblems({ portfolio, catalog, mediaPublished = false }) {
  const problems = [];
  if (mediaPublished && portfolio != null && portfolio.includes("images.unsplash.com")) {
    problems.push(
      "В портфолио «Dinara BILab Медиа» стоковые фото images.unsplash.com (src/content/portfolio.js): они видны, пока в админке " +
        "(вкладка «Примеры работ») не сохранена ни одна работа. Добавьте реальные работы там — это предупреждение можно не учитывать."
    );
  }
  if (catalog != null) {
    const match = catalog.match(/export\s+const\s+CONTACT_TELEGRAM\s*=\s*(["'`])(.*?)\1/);
    const username = match ? match[2].trim().replace(/^@+/, "") : "";
    if (!username || username.toLowerCase() === PLACEHOLDER_TELEGRAM) {
      problems.push(
        `Контакт Telegram не задан или заглушка «${username || "пусто"}»: укажите свой username в CONTACT_TELEGRAM (src/lib/catalog.js) и пересоберите сайт.`
      );
    }
  }
  return problems;
}

module.exports = { integrationProblems, contentProblems };
