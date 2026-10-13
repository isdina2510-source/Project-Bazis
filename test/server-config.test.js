const test = require("node:test");
const assert = require("node:assert/strict");
const { createSandbox, runServer } = require("./server-sandbox");

const EXIT_CONFIG_ERROR = 4;
const RATE_SETTINGS = ["CHAT_RATE_LIMIT", "CHAT_RATE_WINDOW_MS", "ADMIN_RATE_LIMIT", "ADMIN_RATE_WINDOW_MS"];

const PORTFOLIO_STOCK = 'export const PORTFOLIO = [{ id: "w1", image: "https://images.unsplash.com/photo-1?w=900" }];\n';
const PORTFOLIO_OWN = 'export const PORTFOLIO = [{ id: "w1", image: "images/portfolio/w1.jpg" }];\n';
const catalogWith = (username) => `export const CONTACT_PHONE = "77000000000";\nexport const CONTACT_TELEGRAM = "${username}";\n`;

let sandbox;
test.before(() => {
  sandbox = createSandbox();
});
test.after(() => sandbox.cleanup());

test("MED-01: лимит запросов не числом — старт прерывается с кодом 4 и именем переменной", async () => {
  for (const name of RATE_SETTINGS) {
    const result = await runServer(sandbox, ["--check-config"], { [name]: "30/min" });
    assert.equal(result.code, EXIT_CONFIG_ERROR, `${name}: код выхода\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, new RegExp(name), name);
  }
});

test("MED-01: лимит меньше допустимого (0) — тоже ошибка .env", async () => {
  const result = await runServer(sandbox, ["--check-config"], { ADMIN_RATE_LIMIT: "0" });
  assert.equal(result.code, EXIT_CONFIG_ERROR);
  assert.match(result.stderr, /ADMIN_RATE_LIMIT/);
});

test("MED-01: пустые и верные значения лимитов — сервер принимает", async () => {
  const empty = await runServer(sandbox, ["--check-config"], Object.fromEntries(RATE_SETTINGS.map((name) => [name, ""])));
  assert.equal(empty.code, 0, empty.stderr);
  const valid = await runServer(sandbox, ["--check-config"], {
    CHAT_RATE_LIMIT: "15",
    CHAT_RATE_WINDOW_MS: "60000",
    ADMIN_RATE_LIMIT: " 30 ",
    ADMIN_RATE_WINDOW_MS: "120000",
  });
  assert.equal(valid.code, 0, valid.stderr);
});

test("MED-05: неверный DOCUMENTS_TZ — старт прерывается с кодом 4", async () => {
  const result = await runServer(sandbox, ["--check-config"], { DOCUMENTS_TZ: "Asia/Almati" });
  assert.equal(result.code, EXIT_CONFIG_ERROR, result.stdout + result.stderr);
  assert.match(result.stderr, /DOCUMENTS_TZ/);
});

test("MED-05: верный или пустой DOCUMENTS_TZ — сервер принимает", async () => {
  for (const value of ["Asia/Almaty", "Europe/Moscow", ""]) {
    const result = await runServer(sandbox, ["--check-config"], { DOCUMENTS_TZ: value });
    assert.equal(result.code, 0, `${value}: ${result.stderr}`);
  }
});

test("LOW-21: check:prod сообщает о ключе ИИ, оповещениях, стоковом портфолио и заглушке Telegram", async () => {
  const content = createSandbox({ "src/content/portfolio.js": PORTFOLIO_STOCK, "src/lib/catalog.js": catalogWith("bazis") });
  try {
    const result = await runServer(content, ["--check-config", "--production"], {
      SITE_DOMAIN: "example.kz",
      MEDIA_SITE_ENABLED: "true",
      OPENAI_API_KEY: "",
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_CHAT_ID: "",
    });
    assert.equal(result.code, EXIT_CONFIG_ERROR);
    assert.match(result.stderr, /OPENAI_API_KEY/);
    assert.match(result.stderr, /TELEGRAM_BOT_TOKEN/);
    assert.match(result.stderr, /portfolio\.js/);
    assert.match(result.stderr, /CONTACT_TELEGRAM/);
  } finally {
    content.cleanup();
  }
});

test("LOW-21: медиасайт без домена (не опубликован) — о стоковом портфолио не предупреждаем", async () => {
  const content = createSandbox({ "src/content/portfolio.js": PORTFOLIO_STOCK, "src/lib/catalog.js": catalogWith("Dinara_888888") });
  try {
    const result = await runServer(content, ["--check-config", "--production"]);
    assert.match(result.stderr, /Домен сайта не задан/);
    assert.doesNotMatch(result.stderr, /portfolio\.js/);
  } finally {
    content.cleanup();
  }
});

test("HIGH-09: медиасайт выключен (MEDIA_SITE_ENABLED не задан) — даже с доменом стоковое портфолио не проверяется", async () => {
  const content = createSandbox({ "src/content/portfolio.js": PORTFOLIO_STOCK, "src/lib/catalog.js": catalogWith("Dinara_888888") });
  try {
    const off = await runServer(content, ["--check-config", "--production"], { SITE_DOMAIN: "example.kz" });
    assert.doesNotMatch(off.stderr, /portfolio\.js/);
    assert.match(off.stdout, /^Медиасайт: выключен$/m);
    assert.doesNotMatch(off.stdout, /Dinara BILab Медиа/);
    const on = await runServer(content, ["--check-config", "--production"], { SITE_DOMAIN: "example.kz", MEDIA_SITE_ENABLED: "true" });
    assert.match(on.stderr, /portfolio\.js/);
    assert.match(on.stdout, /^Медиасайт: включён$/m);
    assert.match(on.stdout, /Сайт «Dinara BILab Медиа»: https:\/\/media\.example\.kz/);
  } finally {
    content.cleanup();
  }
});

test("HIGH-09: MEDIA_SITE_ENABLED не true/false — старт прерывается с кодом 4 и именем переменной", async () => {
  for (const value of ["1", "yes", "вкл"]) {
    const result = await runServer(sandbox, ["--check-config"], { MEDIA_SITE_ENABLED: value });
    assert.equal(result.code, EXIT_CONFIG_ERROR, `${value}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /MEDIA_SITE_ENABLED=/, value);
  }
  for (const value of ["", "false", "TRUE"]) {
    const result = await runServer(sandbox, ["--check-config"], { MEDIA_SITE_ENABLED: value });
    assert.equal(result.code, 0, `${value}: ${result.stderr}`);
  }
});

test("MED-04: sharp не загружается — check:prod сообщает причину", async () => {
  const broken = createSandbox({
    "node_modules/sharp/package.json": '{ "name": "sharp", "main": "index.js" }',
    "node_modules/sharp/index.js": 'throw new Error("simulated: sharp binary is missing");',
  });
  try {
    const result = await runServer(broken, ["--check-config", "--production"]);
    assert.equal(result.code, EXIT_CONFIG_ERROR);
    assert.match(result.stderr, /Модуль sharp не загружается \(simulated/);
  } finally {
    broken.cleanup();
  }
});

test("LOW-21: пустой CONTACT_TELEGRAM — тоже предупреждение", async () => {
  const content = createSandbox({ "src/content/portfolio.js": PORTFOLIO_OWN, "src/lib/catalog.js": catalogWith("") });
  try {
    const result = await runServer(content, ["--check-config", "--production"]);
    assert.match(result.stderr, /CONTACT_TELEGRAM/);
    assert.doesNotMatch(result.stderr, /portfolio\.js/);
  } finally {
    content.cleanup();
  }
});

test("LOW-21: всё задано — новых предупреждений нет", async () => {
  const content = createSandbox({ "src/content/portfolio.js": PORTFOLIO_OWN, "src/lib/catalog.js": catalogWith("Dinara_888888") });
  try {
    const result = await runServer(content, ["--check-config", "--production"], {
      OPENAI_API_KEY: "sk-test",
      TELEGRAM_BOT_TOKEN: "123:abc",
      TELEGRAM_CHAT_ID: "-100",
    });
    for (const word of ["OPENAI_API_KEY", "TELEGRAM_BOT_TOKEN", "portfolio.js", "CONTACT_TELEGRAM", "sharp"]) {
      assert.doesNotMatch(result.stderr, new RegExp(word.replace(".", "\\.")), word);
    }
  } finally {
    content.cleanup();
  }
});
