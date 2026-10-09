const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "i18n-check.mjs");
const DICT = { cart: { status: { error: "Ошибка", saving: "Сохраняем" } } };

function project(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bazis-i18n-"));
  fs.mkdirSync(path.join(dir, "src", "locales"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "locales", "ru.json"), JSON.stringify(DICT));
  fs.writeFileSync(path.join(dir, "src", "locales", "kk.json"), JSON.stringify(DICT));
  fs.writeFileSync(path.join(dir, "src", "page.js"), code);
  return dir;
}

function check(dir) {
  return spawnSync(process.execPath, [SCRIPT, "--root", dir], { encoding: "utf8" });
}

test("LOW-12: ключ, которого нет в словаре, — ошибка проверки (иначе посетитель увидел бы сам ключ)", () => {
  const dir = project('const MAP = { busy: "cart.status.busy" };\nexport const text = (t) => t("cart.status.error") + t(MAP.busy);\n');
  try {
    const res = check(dir);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /page\.js:1 — ключа cart\.status\.busy нет в словаре/);
    assert.doesNotMatch(res.stderr, /cart\.status\.error/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("LOW-12: все ключи есть, префиксы и посторонние строки с точками не считаются ошибкой", () => {
  const dir = project('export const text = (t, k) => t("cart.status.saving") + t(`cart.status.${k}`) + t("cart.status") + "file.name.js";\n');
  try {
    const res = check(dir);
    assert.equal(res.status, 0, res.stdout + res.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("LOW-12: проверка подключена к npm test и к сборке (prebuild)", () => {
  const { scripts } = require("../package.json");
  assert.match(scripts.test, /node scripts\/i18n-check\.mjs/);
  assert.match(scripts.prebuild, /i18n:check/);
});
