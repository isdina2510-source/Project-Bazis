const test = require("node:test");
const assert = require("node:assert/strict");
const { createSandbox, startServer, ADMIN_PASSWORD } = require("./server-sandbox");

function cookieFrom(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const list = raw.length ? raw : [res.headers.get("set-cookie")].filter(Boolean);
  const line = list.find((item) => String(item).startsWith("bazis_admin_session="));
  if (!line) return "";
  return String(line).split(";")[0];
}

test("админ: login ставит cookie, session и API работают без X-Admin-Password", async () => {
  const sandbox = createSandbox();
  const server = await startServer(sandbox);
  try {
    const base = server.url;
    const login = await fetch(base + "/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    assert.equal(login.status, 200, await login.clone().text());
    const cookie = cookieFrom(login);
    assert.match(cookie, /^bazis_admin_session=/);

    const session = await fetch(base + "/api/admin/session", { headers: { Cookie: cookie } });
    assert.equal(session.status, 200);

    const orders = await fetch(base + "/api/orders?kind=leads&limit=1", {
      headers: { Cookie: cookie, Origin: base },
    });
    assert.equal(orders.status, 200);

    const bad = await fetch(base + "/api/orders?kind=leads&limit=1");
    assert.equal(bad.status, 401);

    const logout = await fetch(base + "/api/admin/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: base },
      body: "{}",
    });
    assert.equal(logout.status, 200);
    const after = await fetch(base + "/api/admin/session", { headers: { Cookie: cookie } });
    assert.equal(after.status, 401);
  } finally {
    await server.stop();
    sandbox.cleanup();
  }
});

test("админ: неверный пароль на login — 401, заголовок X-Admin-Password по-прежнему работает", async () => {
  const sandbox = createSandbox();
  const server = await startServer(sandbox);
  try {
    const base = server.url;
    const wrong = await fetch(base + "/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong-password-123" }),
    });
    assert.equal(wrong.status, 401);

    const headerAuth = await fetch(base + "/api/orders?kind=leads&limit=1", {
      headers: { "X-Admin-Password": ADMIN_PASSWORD },
    });
    assert.equal(headerAuth.status, 200);
  } finally {
    await server.stop();
    sandbox.cleanup();
  }
});
