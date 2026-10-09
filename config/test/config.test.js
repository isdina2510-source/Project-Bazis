const test = require("node:test");
const assert = require("node:assert/strict");
const { parseSiteDomain, resolveSites } = require("../sites");
const { parseTrustProxy, clientAddress, forwardedProto, isProxied } = require("../proxy");
const { readNumber, readTimeZone } = require("../values");
const { integrationProblems, contentProblems } = require("../production");
const sitesConfig = require("../../shared/sites.json");

const site = (id) => (resolved) => resolved.sites.find((item) => item.id === id);
const bazis = site("bazis");
const media = site("media");

test("SITE_DOMAIN: схема, путь, www. и регистр отбрасываются", () => {
  for (const raw of ["bazis.kz", "BAZIS.KZ", "https://bazis.kz/", "http://www.bazis.kz/shop?x=1", " bazis.kz. "]) {
    assert.deepEqual(parseSiteDomain(raw), { ok: true, domain: "bazis.kz" }, raw);
  }
  assert.deepEqual(parseSiteDomain(""), { ok: true, domain: "" });
  assert.deepEqual(parseSiteDomain(undefined), { ok: true, domain: "" });
});

test("SITE_DOMAIN: кириллический домен переводится в punycode", () => {
  const result = parseSiteDomain("базис.қаз");
  assert.equal(result.ok, true);
  assert.match(result.domain, /^xn--/);
});

test("SITE_DOMAIN: не домен — понятная ошибка", () => {
  for (const raw of ["localhost", "media.localhost", "127.0.0.1", "bazis", "bazis.kz:8787", "-bad-.kz", "bazis..kz", "10.0.0.1"]) {
    const result = parseSiteDomain(raw);
    assert.equal(result.ok, false, raw);
    assert.match(result.error, /SITE_DOMAIN/);
  }
});

test("без домена: только локальные адреса, ошибок нет", () => {
  const resolved = resolveSites(sitesConfig, {});
  assert.equal(resolved.ok, true);
  assert.equal(bazis(resolved).url, "");
  assert.deepEqual(bazis(resolved).publicHosts, []);
  assert.ok(media(resolved).hosts.includes("media.localhost"));
});

test("SITE_DOMAIN: основной сайт на домене и www., медиа — на поддомене", () => {
  const resolved = resolveSites(sitesConfig, { SITE_DOMAIN: "bazis.kz" });
  assert.equal(resolved.ok, true);
  assert.equal(bazis(resolved).url, "https://bazis.kz");
  assert.deepEqual(bazis(resolved).publicHosts.sort(), ["bazis.kz", "www.bazis.kz"]);
  assert.equal(media(resolved).url, "https://media.bazis.kz");
  assert.deepEqual(media(resolved).publicHosts, ["media.bazis.kz"]);
  // Локальные адреса продолжают работать.
  assert.ok(bazis(resolved).hosts.includes("127.0.0.1"));
});

test("явный MEDIA_SITE_URL важнее SITE_DOMAIN", () => {
  const resolved = resolveSites(sitesConfig, { SITE_DOMAIN: "bazis.kz", MEDIA_SITE_URL: "https://bazis-media.kz/" });
  assert.equal(resolved.ok, true);
  assert.equal(media(resolved).url, "https://bazis-media.kz");
  assert.equal(media(resolved).urlSource, "MEDIA_SITE_URL");
  assert.equal(bazis(resolved).url, "https://bazis.kz");
});

test("неверный адрес и один домен у двух сайтов — ошибки", () => {
  assert.equal(resolveSites(sitesConfig, { SITE_URL: "bazis.kz" }).ok, false);
  assert.equal(resolveSites(sitesConfig, { SITE_URL: "https://bazis.kz/shop" }).ok, false);
  const clash = resolveSites(sitesConfig, { SITE_URL: "https://bazis.kz", MEDIA_SITE_URL: "https://bazis.kz" });
  assert.equal(clash.ok, false);
  assert.match(clash.errors.join("\n"), /bazis\.kz/);
});

test("TRUST_PROXY: по умолчанию включён, 0 выключает, мусор — ошибка", () => {
  assert.deepEqual(parseTrustProxy(undefined), { ok: true, trust: true, explicit: false });
  assert.deepEqual(parseTrustProxy(""), { ok: true, trust: true, explicit: false });
  assert.equal(parseTrustProxy("1").trust, true);
  assert.equal(parseTrustProxy("true").trust, true);
  assert.equal(parseTrustProxy("0").trust, false);
  assert.equal(parseTrustProxy("off").trust, false);
  assert.equal(parseTrustProxy("private").trust, "private");
  assert.equal(parseTrustProxy("maybe").ok, false);
});

test("TRUST_PROXY=private: прокси из сети Docker — да, из интернета — нет", () => {
  const fromDocker = req("172.18.0.1", { "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https" });
  assert.equal(clientAddress(fromDocker, "private"), "203.0.113.7");
  assert.equal(forwardedProto(fromDocker, "private"), "https");
  assert.equal(clientAddress(fromDocker, true), "172.18.0.1");
  assert.equal(clientAddress(req("::ffff:10.0.0.2", { "x-forwarded-for": "198.51.100.2" }), "private"), "198.51.100.2");
  assert.equal(clientAddress(req("fd00::5", { "x-forwarded-for": "198.51.100.2" }), "private"), "198.51.100.2");
  assert.equal(clientAddress(req("172.32.0.1", { "x-forwarded-for": "198.51.100.2" }), "private"), "172.32.0.1");
  assert.equal(clientAddress(req("8.8.8.8", { "x-forwarded-for": "198.51.100.2" }), "private"), "8.8.8.8");
});

function req(remoteAddress, headers = {}) {
  return { socket: { remoteAddress }, headers };
}

test("адрес посетителя: от локального прокси — последний в X-Forwarded-For", () => {
  // Посетитель подставил свой X-Forwarded-For, прокси дописал настоящий адрес в конец.
  const viaProxy = req("127.0.0.1", { "x-forwarded-for": "1.2.3.4, 203.0.113.7" });
  assert.equal(clientAddress(viaProxy, true), "203.0.113.7");
  assert.equal(clientAddress(req("::ffff:127.0.0.1", { "x-forwarded-for": "2001:db8::1" }), true), "2001:db8::1");
  assert.equal(clientAddress(req("::1", { "x-forwarded-for": "198.51.100.2" }), true), "198.51.100.2");
  assert.equal(isProxied(viaProxy, true), true);
});

test("адрес посетителя: заголовку не доверяем без прокси, при TRUST_PROXY=0 и от чужого адреса", () => {
  assert.equal(clientAddress(req("127.0.0.1"), true), "127.0.0.1");
  assert.equal(clientAddress(req("127.0.0.1", { "x-forwarded-for": "203.0.113.7" }), false), "127.0.0.1");
  assert.equal(clientAddress(req("192.168.1.5", { "x-forwarded-for": "203.0.113.7" }), true), "192.168.1.5");
  assert.equal(clientAddress(req("127.0.0.1", { "x-forwarded-for": "not-an-ip" }), true), "127.0.0.1");
});

test("readNumber: пусто — по умолчанию, число в границах — оно, иначе ошибка с именем переменной", () => {
  assert.deepEqual(readNumber({}, "X_LIMIT", 20, { min: 1 }), { ok: true, value: 20 });
  assert.deepEqual(readNumber({ X_LIMIT: "  " }, "X_LIMIT", 20, { min: 1 }), { ok: true, value: 20 });
  assert.deepEqual(readNumber({ X_LIMIT: " 45 " }, "X_LIMIT", 20, { min: 1 }), { ok: true, value: 45 });
  for (const bad of ["30/min", "30 шт", "1 000", "abc", "Infinity", "0", "101"]) {
    const result = readNumber({ X_LIMIT: bad }, "X_LIMIT", 20, { min: 1, max: 100 });
    assert.equal(result.ok, false, bad);
    assert.equal(result.value, 20, bad);
    assert.match(result.error, /^X_LIMIT=/, bad);
  }
});

test("readTimeZone: пусто — по умолчанию, известный пояс — он, опечатка — ошибка", () => {
  assert.deepEqual(readTimeZone({}, "TZ_X", "Asia/Almaty"), { ok: true, value: "Asia/Almaty" });
  assert.deepEqual(readTimeZone({ TZ_X: "Europe/Moscow" }, "TZ_X", "Asia/Almaty"), { ok: true, value: "Europe/Moscow" });
  const bad = readTimeZone({ TZ_X: "Asia/Almati" }, "TZ_X", "Asia/Almaty");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /TZ_X=Asia\/Almati/);
});

test("integrationProblems: ключ ИИ и оба параметра Telegram", () => {
  assert.equal(integrationProblems({ OPENAI_API_KEY: "k", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1" }).length, 0);
  const missing = integrationProblems({ OPENAI_API_KEY: " ", TELEGRAM_BOT_TOKEN: "t" }).join("\n");
  assert.match(missing, /OPENAI_API_KEY/);
  assert.match(missing, /TELEGRAM_CHAT_ID/);
});

test("contentProblems: стоковое портфолио, пустой или заглушечный CONTACT_TELEGRAM; нет файлов — нет проверки", () => {
  const telegram = (value) => contentProblems({ portfolio: null, catalog: `export const CONTACT_TELEGRAM = "${value}";` });
  assert.equal(telegram("Dinara_888888").length, 0);
  assert.equal(telegram("bazis").length, 1);
  assert.equal(telegram("@Bazis").length, 1);
  assert.equal(telegram("").length, 1);
  assert.equal(contentProblems({ portfolio: null, catalog: "// без константы" }).length, 1);
  const stock = 'image: "https://images.unsplash.com/x"';
  assert.equal(contentProblems({ portfolio: stock, catalog: null, mediaPublished: true }).length, 1);
  assert.equal(contentProblems({ portfolio: 'image: "images/w1.jpg"', catalog: null, mediaPublished: true }).length, 0);
  assert.equal(contentProblems({ portfolio: null, catalog: null, mediaPublished: true }).length, 0);
});

test("contentProblems: медиасайт не опубликован — стоковое портфолио не проблема", () => {
  const stock = 'image: "https://images.unsplash.com/x"';
  assert.equal(contentProblems({ portfolio: stock, catalog: null, mediaPublished: false }).length, 0);
  assert.equal(contentProblems({ portfolio: stock, catalog: null }).length, 0);
});

test("протокол от прокси: последний в X-Forwarded-Proto и только с этого компьютера", () => {
  assert.equal(forwardedProto(req("127.0.0.1", { "x-forwarded-proto": "https" }), true), "https");
  assert.equal(forwardedProto(req("127.0.0.1", { "x-forwarded-proto": "https, http" }), true), "http");
  assert.equal(forwardedProto(req("127.0.0.1", { "x-forwarded-proto": "https" }), false), "");
  assert.equal(forwardedProto(req("10.0.0.2", { "x-forwarded-proto": "https" }), true), "");
});
