const test = require("node:test");
const assert = require("node:assert/strict");
const {
  COOKIE_NAME,
  createAdminSessions,
  cookieSecureFlag,
  sessionCookieHeader,
  clearSessionCookieHeader,
  readSessionToken,
  cookieRequestOriginOk,
  parseCookies,
} = require("../admin-session");

test("сессия создаётся, touch обновляет, destroy удаляет", () => {
  let now = 1_000_000;
  const sessions = createAdminSessions({ now: () => now, absoluteTtlMs: 10_000, idleTtlMs: 5_000 });
  const token = sessions.create();
  assert.equal(sessions.touch(token), true);
  assert.equal(sessions.touch("wrong"), false);
  assert.equal(sessions.destroy(token), true);
  assert.equal(sessions.touch(token), false);
});

test("idle TTL истекает без активности", () => {
  let now = 1_000_000;
  const sessions = createAdminSessions({ now: () => now, absoluteTtlMs: 60_000, idleTtlMs: 1_000 });
  const token = sessions.create();
  now += 1_001;
  assert.equal(sessions.touch(token), false);
});

test("absolute TTL истекает даже при активности", () => {
  let now = 1_000_000;
  const sessions = createAdminSessions({ now: () => now, absoluteTtlMs: 2_000, idleTtlMs: 60_000 });
  const token = sessions.create();
  now += 1_500;
  assert.equal(sessions.touch(token), true);
  now += 600;
  assert.equal(sessions.touch(token), false);
});

test("cookie: Secure на localhost и HTTPS, парсинг токена", () => {
  assert.equal(cookieSecureFlag({ localHost: true, https: false }), true);
  assert.equal(cookieSecureFlag({ localHost: false, https: true }), true);
  assert.equal(cookieSecureFlag({ localHost: false, https: false }), false);

  const set = sessionCookieHeader("tok_abc", { secure: true, maxAgeSec: 3600 });
  assert.match(set, new RegExp(`^${COOKIE_NAME}=`));
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  assert.match(set, /Secure/);
  assert.match(set, /Max-Age=3600/);

  const clear = clearSessionCookieHeader({ secure: false });
  assert.match(clear, /Max-Age=0/);
  assert.doesNotMatch(clear, /Secure/);

  const req = { headers: { cookie: `${COOKIE_NAME}=tok_abc; lang=kk` } };
  assert.equal(readSessionToken(req), "tok_abc");
  assert.equal(parseCookies(`${COOKIE_NAME}=a%2Fb`)[COOKIE_NAME], "a/b");
});

test("Origin: свой хост — ок, чужой — нет", () => {
  const req = (extra) => ({ headers: { host: "bazis.kz", ...extra } });
  assert.equal(cookieRequestOriginOk(req({ origin: "https://bazis.kz" }), {}), true);
  assert.equal(cookieRequestOriginOk(req({ origin: "https://evil.test" }), {}), false);
  assert.equal(cookieRequestOriginOk(req({ referer: "https://bazis.kz/admin.html" }), {}), true);
  assert.equal(cookieRequestOriginOk(req({}), {}), true);
});
