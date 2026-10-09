const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createNotifier, routeOf, scrub } = require("../index");
const { createSender } = require("../../documents/send");

const TOKEN = "123456:SECRET_TOKEN_VALUE";

function fakeSender({ fail = false, enabled = true } = {}) {
  const sent = [];
  return {
    sent,
    channels: () => ({ telegram: enabled }),
    hideSecrets: (text) => String(text).split(TOKEN).join("***"),
    sendTelegramText: async (text) => {
      if (fail) throw new Error("Telegram недоступен: timeout");
      sent.push(text);
    },
  };
}

function silentLog() {
  const warnings = [];
  return { warnings, warn: (msg) => warnings.push(msg) };
}

test("заказ из корзины: тип, имя, телефон, состав, итог и ссылка на CRM", async () => {
  const sender = fakeSender();
  const notifier = createNotifier({ sender, crmUrl: "https://bazis.kz/admin.html" });
  await notifier.order({
    channel: "whatsapp",
    customerName: "Айгуль",
    customerPhone: "+7 701 000 00 00",
    items: [{ title: "Аудит бизнеса", qty: 1 }, { title: "Камера", qty: 2 }],
    totalText: "150 000 ₸",
  });
  const text = sender.sent[0];
  assert.match(text, /Новый заказ \(WhatsApp\)/);
  assert.match(text, /Имя: Айгуль/);
  assert.match(text, /Телефон: \+7 701 000 00 00/);
  assert.match(text, /• Камера × 2/);
  assert.match(text, /Итого: 150 000 ₸/);
  assert.match(text, /CRM: https:\/\/bazis\.kz\/admin\.html/);
});

test("заявка с формы и заявка из ИИ-чата различаются", async () => {
  const sender = fakeSender();
  const notifier = createNotifier({ sender });
  await notifier.order({
    channel: "site",
    customerName: "Ержан",
    customerPhone: "77010000001",
    items: [{ title: "Заявка: Инфраструктура" }],
    lead: { comment: "Нужны камеры на склад" },
  });
  await notifier.order({ channel: "site", leadSource: "chat", handoff: "telegram", chatCode: "K7Q2", items: [] });
  assert.match(sender.sent[0], /Заявка с формы/);
  assert.match(sender.sent[0], /Комментарий: Нужны камеры на склад/);
  assert.match(sender.sent[1], /Заявка из ИИ-чата \(клиент ушёл в Telegram\)/);
  assert.match(sender.sent[1], /Имя: не указано/);
  assert.match(sender.sent[1], /Код обращения: K7Q2/);
});

test("одинаковое оповещение — не чаще раза в 10 минут, затем с числом повторов", async () => {
  let clock = 1_000_000;
  const sender = fakeSender();
  const notifier = createNotifier({ sender, now: () => clock });
  await notifier.alert("backup", "Бэкап не сделан");
  await notifier.alert("backup", "Бэкап не сделан");
  await notifier.alert("other", "Другая ошибка");
  assert.equal(sender.sent.length, 2);
  clock += 10 * 60 * 1000;
  await notifier.alert("backup", "Бэкап не сделан");
  assert.equal(sender.sent.length, 3);
  assert.match(sender.sent[2], /повторилось ещё 1 раз/);
});

test("сбой Telegram не выбрасывает исключение — только запись в журнал", async () => {
  const log = silentLog();
  const notifier = createNotifier({ sender: fakeSender({ fail: true }), log });
  const ok = await notifier.order({ channel: "whatsapp", items: [] });
  assert.equal(ok, false);
  assert.equal(log.warnings.length, 1);
  assert.match(log.warnings[0], /Оповещение в Telegram не отправлено/);
});

test("без настроек Telegram ничего не отправляется", async () => {
  const sender = fakeSender({ enabled: false });
  const notifier = createNotifier({ sender });
  assert.equal(notifier.enabled, false);
  assert.equal(await notifier.alert("x", "y"), false);
  assert.equal(sender.sent.length, 0);
});

test("ошибка 500: путь без запроса и id, текст без телефонов, e-mail и токена", async () => {
  const sender = fakeSender();
  const notifier = createNotifier({ sender });
  const err = new TypeError(`bad ${TOKEN} for +7 701 123 45 67 and client@mail.kz`);
  await notifier.serverError("GET", "/api/orders/ord_1234567890abcdef?q=Иванов", err);
  const text = sender.sent[0];
  assert.match(text, /Ошибка 500: GET \/api\/orders\/:id\n/);
  assert.match(text, /TypeError: bad \*\*\* for \[номер\] and \[e-mail\]/);
  assert.doesNotMatch(text, /Иванов|SECRET|701 123|client@/);
});

test("состояние в файле: цикл перезапусков не засыпает чат, причина падения приходит при запуске", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-"));
  const stateFile = path.join(dir, "notify-state.json");
  try {
    const first = fakeSender();
    const a = createNotifier({ sender: first, stateFile });
    await a.started("ИИ: выключен");
    await a.failed("сбой процесса", new Error("boom"));
    await a.flush(100);

    const second = fakeSender();
    const b = createNotifier({ sender: second, stateFile });
    await b.started();
    await b.failed("сбой процесса", new Error("boom"));
    assert.equal(second.sent.length, 0);

    const later = fakeSender();
    const c = createNotifier({ sender: later, stateFile, now: () => Date.now() + 11 * 60 * 1000 });
    await c.started();
    assert.match(later.sent[0], /Сервер перезапущен после сбоя: сбой процесса: boom/);
    assert.match(later.sent[0], /повторилось ещё 1 раз/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("routeOf и scrub", () => {
  assert.equal(routeOf("/api/products/p1700000000000/pdf?x=1"), "/api/products/:id/pdf");
  assert.equal(routeOf("/api/orders"), "/api/orders");
  assert.equal(scrub("звонить 8 (701) 000-00-00"), "звонить [номер]");
});

test("sendTelegramText: sendMessage с текстом, токен скрыт в ошибке", async () => {
  const calls = [];
  const sender = createSender({
    env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "-100500" },
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: false, status: 401, json: async () => ({ ok: false, description: "Unauthorized " + TOKEN }) };
    },
  });
  await assert.rejects(sender.sendTelegramText("Привет"), (err) => {
    assert.equal(err.code, "send_failed");
    assert.doesNotMatch(err.message, /SECRET/);
    return true;
  });
  assert.match(calls[0].url, /\/sendMessage$/);
  assert.equal(calls[0].body.chat_id, "-100500");
  assert.equal(calls[0].body.text, "Привет");
});
