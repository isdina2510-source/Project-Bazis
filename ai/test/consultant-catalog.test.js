const test = require("node:test");
const assert = require("node:assert/strict");
const { createAiCore, loadAiConfig } = require("..");
const { loadFeatures } = require("../features");
const { DEFAULT_PRODUCTS } = require("../lib/catalog");

const FAST = { ...loadAiConfig({}), retryBaseMs: 1, retryMaxMs: 5, deadlineMs: 3000, log: false };

function setup(services) {
  const calls = [];
  const provider = { name: "fake", configured: true, model: "m", chat: async (args) => (calls.push(args), "Ответ") };
  const ai = createAiCore({ provider, features: loadFeatures(), config: FAST, services });
  const system = () => calls.filter((c) => String(c.messages[0].content).startsWith("Ты ИИ-консультант")).at(-1).messages[0].content;
  return { ai, system };
}

function quiet(t) {
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args.join(" ")));
  return errors;
}

const defaultTitles = DEFAULT_PRODUCTS.map((p) => p.title).filter(Boolean);

for (const [name, getProducts] of [
  ["база ещё не открыта (getProducts → null)", () => null],
  [
    "каталог не прочитался (исключение)",
    () => {
      throw new Error("SQLITE_BUSY");
    },
  ],
]) {
  test(`MED-07: ${name} — в промпте нет каталога по умолчанию, есть запрет называть цены; журнал и оповещение`, async (t) => {
    const errors = quiet(t);
    const alerts = [];
    const { ai, system } = setup({ getProducts, notifier: { alert: (key, text) => alerts.push({ key, text }) } });
    await ai.run("consultant", { message: "Сколько стоит аудит?" });
    await ai.run("consultant", { message: "А сайт?" });
    const prompt = system();
    for (const title of defaultTitles) assert.ok(!prompt.includes(title), "в промпте товар по умолчанию: " + title);
    assert.doesNotMatch(prompt, /₸/);
    assert.doesNotMatch(prompt, /Цены называй только из списка/);
    assert.match(prompt, /Актуальные цены и наличие услуг сейчас недоступны/);
    assert.match(prompt, /Не называй никаких цен/);
    assert.match(prompt, /менеджер/);
    assert.equal(errors.length, 1, "в журнал — не чаще раза в минуту: " + errors.join("\n"));
    assert.match(errors[0], /каталог недоступен/);
    assert.equal(alerts.length, 2, "оповещение на каждый запрос, повторы отсекает антиспам notifier.alert");
    assert.equal(alerts[0].key, alerts[1].key);
    assert.match(alerts[0].text, /без цен/);
  });
}

test("MED-07: каталог прочитан — цены из базы, без предупреждений", async (t) => {
  const errors = quiet(t);
  const alerts = [];
  const products = [{ id: "a", title: "Экспресс-аудит бизнеса", price: 150000, currency: "KZT", category: "management" }];
  const { ai, system } = setup({ getProducts: () => products, notifier: { alert: (...args) => alerts.push(args) } });
  await ai.run("consultant", { message: "Сколько стоит аудит?" });
  assert.match(system(), /Цены называй только из списка услуг/);
  assert.match(system(), /Экспресс-аудит бизнеса/);
  assert.deepEqual(errors, []);
  assert.deepEqual(alerts, []);
});
