const test = require("node:test");
const assert = require("node:assert/strict");
const { MIN_LENGTH, checkAdminPassword, passwordMatches, headerMatchesPassword } = require("../admin-password");

test("пароль не задан, пустой или из пробелов — сервер не запускается", () => {
  assert.equal(checkAdminPassword(undefined).ok, false);
  assert.equal(checkAdminPassword(null).ok, false);
  assert.equal(checkAdminPassword("").ok, false);
  assert.equal(checkAdminPassword("   \t ").ok, false);
});

test("короткий и частый пароль отклоняются, бывший пароль по умолчанию — в любом регистре", () => {
  assert.equal(checkAdminPassword("a".repeat(MIN_LENGTH - 1)).ok, false);
  assert.equal(checkAdminPassword("bazis").ok, false);
  assert.equal(checkAdminPassword("BAZIS123").ok, false);
  assert.equal(checkAdminPassword("Password").ok, false);
  assert.equal(checkAdminPassword("12345678").ok, false);
});

test("длина считается в символах, а не в байтах UTF-8", () => {
  assert.equal(checkAdminPassword("ключ123").ok, false);
  assert.equal(checkAdminPassword("ключ1234").ok, true);
});

test("годный пароль: пробелы по краям отброшены, регистр сохранён", () => {
  const result = checkAdminPassword("  Moy-Parol-2026  ");
  assert.equal(result.ok, true);
  assert.equal(result.password, "Moy-Parol-2026");
});

test("сравнение учитывает регистр", () => {
  const { password } = checkAdminPassword("Moy-Parol-2026");
  assert.equal(passwordMatches("Moy-Parol-2026", password), true);
  assert.equal(passwordMatches("moy-parol-2026", password), false);
  assert.equal(passwordMatches("MOY-PAROL-2026", password), false);
  assert.equal(passwordMatches(" Moy-Parol-2026 ", password), true);
  assert.equal(passwordMatches("", password), false);
  assert.equal(passwordMatches("Moy-Parol-2026", ""), false);
});

test("кириллица: регистр учитывается, разные формы Unicode одной буквы совпадают", () => {
  const { password } = checkAdminPassword("Пароль-Йод-77");
  assert.equal(passwordMatches("Пароль-Йод-77", password), true);
  assert.equal(passwordMatches("пароль-йод-77", password), false);
  assert.equal(passwordMatches("Пароль-Йод-77".normalize("NFD"), password), true);
});

test("заголовок X-Admin-Password: URI-кодировка и старый формат «как есть»", () => {
  const { password } = checkAdminPassword("Пароль-Йод-77");
  assert.equal(headerMatchesPassword(encodeURIComponent("Пароль-Йод-77"), password), true);
  assert.equal(headerMatchesPassword(encodeURIComponent("пароль-йод-77"), password), false);
  assert.equal(headerMatchesPassword("", password), false);
  assert.equal(headerMatchesPassword(undefined, password), false);

  const latin = checkAdminPassword("Abc%Zz-2026").password;
  assert.equal(headerMatchesPassword("Abc%Zz-2026", latin), true);
  assert.equal(headerMatchesPassword(encodeURIComponent("Abc%Zz-2026"), latin), true);
  assert.equal(headerMatchesPassword("abc%zz-2026", latin), false);
});
