const { AiError } = require("../errors");
const { CATEGORIES } = require("../../shared/catalog.json");

/** Черновик описания товара для админки (POST /api/ai/product-description, нужен пароль админки). */
module.exports = {
  name: "product-description",
  description: "Генерация описания товара/услуги для каталога",
  access: "admin",
  temperature: 0.7,
  maxTokens: 300,

  parseInput(body) {
    const title = String(body.title || "").trim().slice(0, 120);
    if (!title) throw new AiError("title_required", 400, "Укажите название");
    const category = CATEGORIES.find((c) => c.id === body.category);
    return {
      title,
      category: category ? category.title : "",
      kind: body.kind === "product" ? "товар" : "услуга",
      notes: String(body.notes || "").trim().slice(0, 1000),
    };
  },

  buildMessages(input) {
    const facts = [
      "Название: " + input.title,
      "Тип: " + input.kind,
      input.category && "Раздел: " + input.category,
      input.notes && "Пожелания: " + input.notes,
    ].filter(Boolean);
    return [
      {
        role: "system",
        content:
          "Ты копирайтер Dinara BILab. Пиши по-русски продающее, но честное описание для карточки в каталоге: " +
          "2–3 коротких предложения, до 450 символов, без цены, без эмодзи и без markdown.",
      },
      { role: "user", content: facts.join("\n") },
    ];
  },

  formatResult(text) {
    return { text: text.slice(0, 500) };
  },
};
