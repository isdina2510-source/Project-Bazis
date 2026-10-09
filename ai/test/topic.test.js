const test = require("node:test");
const assert = require("node:assert/strict");
const { createAiCore, loadAiConfig } = require("..");
const { loadFeatures } = require("../features");
const { parseClassifierAnswer, decideTopic } = require("../lib/topic");

const FAST = { ...loadAiConfig({}), retryBaseMs: 1, retryMaxMs: 5, deadlineMs: 3000, log: false };
const CATALOG = "Управление бизнесом:\n1. Экспресс-аудит (от 150 000 ₸)\nИнфраструктура:\n1. Создание сайта (от 50 000 ₸)";
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const docs = [
  { kind: "text", name: "курсовая.docx", text: "Курсовая по биологии: строение клетки" },
  { kind: "text", name: "оргструктура.docx", text: "Отдел продаж: 5 менеджеров" },
];

const isClassifier = (args) => String(args.messages[0].content).startsWith("Ты фильтр");

/** Фейковая модель: классификатору отдаёт verdict (объект или строку), консультанту — answer. */
function consultant(verdict, answer = "Ответ по сути") {
  const calls = [];
  const provider = {
    name: "fake",
    configured: true,
    model: "m",
    chat: async (args) => {
      calls.push(args);
      if (isClassifier(args)) return typeof verdict === "string" ? verdict : JSON.stringify(verdict);
      return answer;
    },
  };
  return { ai: createAiCore({ provider, features: loadFeatures(), config: FAST }), calls };
}

test("вердикт классификатора: имена сверяются со вложениями, мусор — нет вердикта", () => {
  const v = parseClassifierAnswer(
    JSON.stringify({ question: "on", attachments: [{ name: "«курсовая.docx»", topic: "off" }, { name: "выдумка.pdf", topic: "off" }] }),
    docs
  );
  assert.deepEqual(v, { question: "on", offFiles: ["курсовая.docx"], onFiles: ["оргструктура.docx"] });
  assert.equal(parseClassifierAnswer("не json", docs), null);
  assert.deepEqual(decideTopic(null), { offTopic: false, offTopicFiles: [] });
  assert.equal(decideTopic({ question: "off", offFiles: [], onFiles: [] }).offTopic, true);
  assert.equal(decideTopic({ question: "empty", offFiles: ["a"], onFiles: [] }).offTopic, true);
  assert.equal(decideTopic({ question: "off", offFiles: [], onFiles: ["b"] }).offTopic, false, "подходящий файл спасает запрос");
});

test("вердикт с обоснованиями (why) и вежливые реплики", async () => {
  const v = parseClassifierAnswer(
    JSON.stringify({
      question: { why: "приветствие", topic: "off" },
      attachments: [{ name: "курсовая.docx", why: "учёба", topic: "off" }, { name: "оргструктура.docx", why: "компания", topic: "on" }],
    }),
    docs,
    "Здравствуйте!"
  );
  assert.equal(v.question, "on", "приветствие не может быть «не по теме»");
  assert.deepEqual(v.offFiles, ["курсовая.docx"]);
  const { ai, calls } = consultant({ question: { topic: "off" }, attachments: [] }, "Здравствуйте! Чем помочь?");
  const result = await ai.run("consultant", { message: "Здравствуйте!" });
  assert.equal(result.offTopic, undefined);
  assert.equal(calls.filter(isClassifier).length, 0, "для приветствия без файлов классификатор не вызывается");
});

test("классификатор получает вопрос, текст документов, картинки и просит JSON", async () => {
  const { ai, calls } = consultant({ question: "on", attachments: [] });
  await ai.run("consultant", { message: "оцените", attachments: [docs[1], { kind: "image", name: "фото.png", dataUrl: PNG }] });
  const cls = calls.find(isClassifier);
  assert.equal(cls.json, true);
  assert.equal(cls.temperature, 0);
  const text = cls.messages[1].content[0].text;
  assert.match(text, /Вопрос клиента: оцените/);
  assert.match(text, /Отдел продаж: 5 менеджеров/);
  assert.equal(cls.messages[1].content.filter((p) => p.type === "image_url").length, 1);
});

test("вопрос не по теме — стандартный отказ с разделами из каталога", async () => {
  const { ai } = consultant({ question: "off", attachments: [] });
  const result = await ai.run("consultant", { message: "Какая завтра погода?", catalog: CATALOG });
  assert.equal(result.offTopic, true);
  assert.equal(result.handoff, false);
  assert.match(result.text, /не относится к услугам ИП «Базис»/);
  assert.match(result.text, /управление бизнесом, инфраструктура/);
});

test("файл не по теме — отказ называет конкретный файл, основная модель не вызывается", async () => {
  const { ai, calls } = consultant({ question: "empty", attachments: [{ name: "курсовая.docx", topic: "off" }] });
  const result = await ai.run("consultant", { message: "", attachments: [docs[0]] });
  assert.equal(result.offTopic, true);
  assert.match(result.text, /^Вложенный файл «курсовая\.docx» не относится к услугам сайта, поэтому разобрать его не смогу/);
  assert.equal(calls.length, 1, "только классификатор");
});

test("нейтральная просьба «посмотрите файл» не спасает постороннее вложение", async () => {
  const { ai } = consultant({ question: { topic: "neutral" }, attachments: [{ name: "курсовая.docx", topic: "off" }] });
  const result = await ai.run("consultant", { message: "Посмотрите файл", attachments: [docs[0]] });
  assert.equal(result.offTopic, true);
  assert.match(result.text, /^Вложенный файл «курсовая\.docx» не относится к услугам сайта, поэтому разобрать его не смогу/);
});

test("картинка не по теме вместе с вопросом", async () => {
  const { ai } = consultant({ question: "off", attachments: [{ name: "пёс.png", topic: "off" }] });
  const result = await ai.run("consultant", { message: "какая это порода?", attachments: [{ kind: "image", name: "пёс.png", dataUrl: PNG }] });
  assert.match(result.text, /^Изображение «пёс\.png» не относится к услугам сайта, как и сам вопрос/);
});

test("часть вложений не по теме — пометка перед ответом по сути", async () => {
  const { ai, calls } = consultant(
    { question: "on", attachments: [{ name: "курсовая.docx", topic: "off" }, { name: "оргструктура.docx", topic: "on" }] },
    "Для отдела продаж подойдёт аудит."
  );
  const result = await ai.run("consultant", { message: "что посоветуете?", attachments: docs });
  const mainText = calls.find((c) => !isClassifier(c)).messages.at(-1).content[0].text;
  assert.doesNotMatch(mainText, /строение клетки/, "текст постороннего файла не уходит в основную модель");
  assert.match(mainText, /Отдел продаж/);
  assert.equal(result.offTopic, undefined);
  assert.deepEqual(result.offTopicFiles, ["курсовая.docx"]);
  assert.match(result.text, /^Обратите внимание: вложенный файл «курсовая\.docx» не относится к услугам сайта, его я не учитывала\.\n\nДля отдела продаж/);
});

test("классификатор сломался — ответ по сути без ложного отказа", async () => {
  const { ai } = consultant("{oops", "Сайт стоит от 50 000 ₸");
  const result = await ai.run("consultant", { message: "цена сайта" });
  assert.deepEqual(result, { text: "Сайт стоит от 50 000 ₸", handoff: false });
});
