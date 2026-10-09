const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { fetchRemoteImage, isPublicAddress, parseImageUrl } = require("../remote-image");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

/**
 * Поддельный https.request: ответы по адресу; запоминает, к какому IP шло соединение.
 * routes[href] = { status, headers, body } | { redirect }
 */
function fakeRequest(routes, calls) {
  return (url, options, onResponse) => {
    const req = new EventEmitter();
    req.destroy = (err) => setImmediate(() => req.emit("error", err || new Error("destroyed")));
    req.end = () => {
      options.lookup(url.hostname, {}, (err, address) => {
        calls.push({ href: url.href, address });
        const route = routes[url.href];
        const res = new PassThrough();
        if (!route) {
          res.statusCode = 404;
          res.headers = {};
        } else if (route.redirect) {
          res.statusCode = 302;
          res.headers = { location: route.redirect };
        } else {
          res.statusCode = route.status || 200;
          res.headers = route.headers || {};
        }
        onResponse(res);
        if (route && route.hang) return;
        res.end(route && route.body ? route.body : undefined);
      });
    };
    return req;
  };
}

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("адреса внутренней сети не считаются публичными", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
  assert.equal(isPublicAddress("not-an-ip"), false);
});

test("ссылка: только https на стандартном порту, без логина в адресе", () => {
  assert.equal(parseImageUrl("https://cdn.example.com/a.png").hostname, "cdn.example.com");
  for (const bad of ["http://cdn.example.com/a.png", "https://user:pw@cdn.example.com/a.png", "https://cdn.example.com:8443/a.png", "ftp://x/a.png", "javascript:alert(1)", "/images/a.png"]) {
    assert.throws(() => parseImageUrl(bad), { code: "invalid_image_url" }, bad);
  }
});

test("картинка скачивается; соединение идёт на проверенный IP", async () => {
  const calls = [];
  const result = await fetchRemoteImage("https://cdn.example.com/a.png", {
    maxBytes: 1000,
    lookup: publicLookup,
    request: fakeRequest({ "https://cdn.example.com/a.png": { headers: { "content-type": "image/png" }, body: PNG } }, calls),
  });
  assert.equal(result.mime, "image/png");
  assert.deepEqual(result.buffer, PNG);
  assert.deepEqual(calls, [{ href: "https://cdn.example.com/a.png", address: "93.184.216.34" }]);
});

test("имя, которое указывает во внутреннюю сеть, отклоняется до запроса", async () => {
  const calls = [];
  const request = fakeRequest({}, calls);
  await assert.rejects(
    fetchRemoteImage("https://evil.example.com/a.png", {
      maxBytes: 1000,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }],
      request,
    }),
    { code: "image_host_blocked" }
  );
  await assert.rejects(fetchRemoteImage("https://169.254.169.254/latest", { maxBytes: 1000, lookup: publicLookup, request }), {
    code: "image_host_blocked",
  });
  assert.equal(calls.length, 0);
});

test("перенаправление проверяется заново: на http и во внутреннюю сеть нельзя", async () => {
  const calls = [];
  const routes = {
    "https://cdn.example.com/to-http": { redirect: "http://cdn.example.com/a.png" },
    "https://cdn.example.com/to-local": { redirect: "https://localhost.example/a.png" },
    "https://cdn.example.com/ok": { redirect: "/a.png" },
    "https://cdn.example.com/a.png": { headers: { "content-type": "image/png" }, body: PNG },
  };
  const lookup = async (host) =>
    host === "localhost.example" ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "93.184.216.34", family: 4 }];
  const options = { maxBytes: 1000, lookup, request: fakeRequest(routes, calls) };
  await assert.rejects(fetchRemoteImage("https://cdn.example.com/to-http", options), { code: "invalid_image_url" });
  await assert.rejects(fetchRemoteImage("https://cdn.example.com/to-local", options), { code: "image_host_blocked" });
  assert.equal((await fetchRemoteImage("https://cdn.example.com/ok", options)).mime, "image/png");
});

test("не картинка, слишком большой файл и ошибка сервера — понятные коды", async () => {
  const calls = [];
  const routes = {
    "https://cdn.example.com/page": { headers: { "content-type": "text/html" }, body: Buffer.from("<html>") },
    "https://cdn.example.com/big": { headers: { "content-type": "image/png", "content-length": "5000" }, body: PNG },
    "https://cdn.example.com/stream": { headers: { "content-type": "image/png" }, body: Buffer.alloc(5000) },
    "https://cdn.example.com/err": { status: 500, headers: {} },
  };
  const options = { maxBytes: 1000, lookup: publicLookup, request: fakeRequest(routes, calls) };
  await assert.rejects(fetchRemoteImage("https://cdn.example.com/page", options), { code: "invalid_image" });
  await assert.rejects(fetchRemoteImage("https://cdn.example.com/big", options), { code: "image_too_large" });
  await assert.rejects(fetchRemoteImage("https://cdn.example.com/stream", options), { code: "image_too_large" });
  await assert.rejects(fetchRemoteImage("https://cdn.example.com/err", options), { code: "image_fetch_failed" });
});

test("зависший ответ прерывается по общему таймауту", async () => {
  const calls = [];
  const routes = { "https://cdn.example.com/slow": { headers: { "content-type": "image/png" }, hang: true } };
  const started = Date.now();
  await assert.rejects(
    fetchRemoteImage("https://cdn.example.com/slow", { maxBytes: 1000, timeoutMs: 100, lookup: publicLookup, request: fakeRequest(routes, calls) }),
    { code: "image_fetch_failed" }
  );
  assert.ok(Date.now() - started < 2000);
});
