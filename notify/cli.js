/**
 * Оповещение владельцу из скриптов: node notify/cli.js "текст"
 * Использует тот же модуль notify и те же переменные (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID), что и сервер:
 * из окружения или из .env рядом с server.js. Одинаковый текст — не чаще раза в 10 минут (общий с сервером файл
 * data/notify-state.json). Watchdog Docker вызывает его так: docker compose run --rm --no-deps -T bazis node notify/cli.js "…".
 *
 * Код выхода: 0 — отправлено или пропущено антиспамом, 1 — Telegram не принял сообщение,
 * 2 — не передан текст, 3 — оповещения выключены (не заданы переменные).
 */
const path = require("path");
const { loadEnvFile } = require("../config/env");
const { createSender } = require("../documents/send");
const { createNotifier } = require("./index");

const ROOT = path.join(__dirname, "..");

/**
 * @param {string[]} args аргументы после имени скрипта
 * @param {{ env?: NodeJS.ProcessEnv, root?: string, fetchImpl?: typeof fetch, log?: Pick<Console, "log" | "warn" | "error"> }} [options]
 * @returns {Promise<number>} код выхода
 */
async function runCli(args, options = {}) {
  const env = options.env || process.env;
  const root = options.root || ROOT;
  const log = options.log || console;
  const text = args.join(" ").trim();
  if (!text) {
    log.error('Использование: node notify/cli.js "текст оповещения"');
    return 2;
  }
  loadEnvFile(path.join(root, ".env"), env);
  let failed = false;
  const sender = createSender({ env, fetchImpl: options.fetchImpl });
  const notifier = createNotifier({
    sender,
    stateFile: path.join(root, "data", "notify-state.json"),
    log: {
      warn: (message) => {
        if (String(message).startsWith("Оповещение в Telegram не отправлено")) failed = true;
        log.warn(message);
      },
    },
  });
  if (!notifier.enabled) {
    log.warn("Оповещения выключены — задайте TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в .env");
    return 3;
  }
  const sent = await notifier.alert("cli:" + text.slice(0, 80), text);
  await notifier.flush();
  if (sent) {
    log.log("Оповещение отправлено");
    return 0;
  }
  if (failed) return 1;
  log.log("Такое оповещение уже было меньше 10 минут назад — пропущено");
  return 0;
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error("Оповещение не отправлено:", err);
      process.exit(1);
    }
  );
}

module.exports = { runCli };
