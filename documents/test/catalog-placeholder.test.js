const test = require("node:test");
const assert = require("node:assert/strict");
const { catalogDoc } = require("../templates/catalog");

test("MED-14: товар без фото в PDF-каталоге — нейтральная заглушка «Без фото», а не пустая клетка", () => {
  const doc = catalogDoc({
    title: "Каталог",
    generatedAt: "2026-10-09T10:00:00Z",
    company: { name: "ИП Базис" },
    groups: [{ title: "Инфраструктура", items: [{ title: "Сайт", description: "", price: 1, currency: "KZT", kind: "service", image: null }] }],
  });
  const json = JSON.stringify(doc.content);
  assert.match(json, /"text":"Без фото"/);
  assert.doesNotMatch(json, /unsplash/);
});
