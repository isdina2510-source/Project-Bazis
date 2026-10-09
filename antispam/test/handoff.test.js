const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const load = () => import(pathToFileURL(path.join(__dirname, "../../src/chat/handoff-transcript.js")).href);

const history = [
  { role: "bot", text: "Здравствуйте! Я ИИ-консультант Дина.", attachments: [] },
  { role: "user", text: "Нужен аудит бизнеса", attachments: [{ name: "оргструктура.docx" }] },
  { role: "bot", text: "Экспресс-аудит — от 150 000 ₸.", attachments: [] },
  { role: "user", text: "Мой номер 8 (701) 123-45-67, перезвоните", attachments: [] },
];

test("заявка из чата: переписка, запрос клиента, телефон и номер обращения", async () => {
  const { buildTranscript, clientRequest, findPhone, chatCodeFor, hasClientMessages } = await load();
  const transcript = buildTranscript(history);
  assert.match(transcript, /^Консультант: Здравствуйте!/);
  assert.match(transcript, /Клиент: Нужен аудит бизнеса \[файлы: «оргструктура\.docx»\]/);
  assert.match(clientRequest(history), /Нужен аудит бизнеса[\s\S]*перезвоните/);
  assert.equal(findPhone(history), "8 (701) 123-45-67");
  assert.equal(findPhone([{ role: "user", text: "заказ 1234567, сумма 150000" }]), "");
  assert.equal(chatCodeFor("ord_a7f3c2d1-0000-4000-8000-000000000000"), "A7F3C2");
  assert.equal(hasClientMessages([history[0]]), false);
  assert.equal(hasClientMessages(history), true);
});

test("длинная переписка обрезается с начала, последние реплики сохраняются", async () => {
  const { buildTranscript } = await load();
  const long = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? "bot" : "user", text: "реплика " + i + " " + "x".repeat(200) }));
  const transcript = buildTranscript(long);
  assert.ok(transcript.length <= 7600);
  assert.match(transcript, /^…\(начало диалога не поместилось\)/);
  assert.match(transcript, /реплика 59/);
});
