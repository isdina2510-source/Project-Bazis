const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createSandbox, startServer, ADMIN_PASSWORD } = require("./server-sandbox");

const PRODUCT = { title: "Тестовый товар", description: "Описание", price: 1000, category: "infrastructure" };
const PNG_DATA_URL =
  "data:image/png;base64," + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]).toString("base64");
const LEGACY_DEFAULT_IMAGE = "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?auto=format&fit=crop&w=900&q=80";
/** Антиспам заказов без задержки и без доказательства работы: проверяется логика заказа, а не токен. */
const ORDER_ENV = {
  ORDER_POW_BITS: "0",
  ORDER_MIN_FILL_MS: "0",
  ORDER_RATE_LIMIT: "100",
  ORDER_DAILY_LIMIT_PER_IP: "100",
  ORDER_PHONE_HOURLY_LIMIT: "100",
  ORDER_PHONE_DAILY_LIMIT: "100",
  ORDER_CHALLENGE_LIMIT: "100",
  ORDER_DEDUP_MS: "0",
};

let sandbox;
let server;
test.before(async () => {
  // Сеть для картинок недоступна: сохранение товара без фото не должно от неё зависеть.
  sandbox = createSandbox({
    "offline-dns.js": "require('node:dns').promises.lookup = async () => { const e = new Error('offline'); e.code = 'ENOTFOUND'; throw e; };",
  });
  const inject = path.join(sandbox.dir, "offline-dns.js").replace(/\\/g, "/");
  server = await startServer(sandbox, { ...ORDER_ENV, NODE_OPTIONS: `--require "${inject}"` });
});
test.after(async () => {
  if (server) await server.stop();
  sandbox.cleanup();
});

function admin(method, urlPath, body) {
  return fetch(server.url + urlPath, {
    method,
    headers: { "Content-Type": "application/json", "X-Admin-Password": ADMIN_PASSWORD },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function postOrder(body) {
  const challenge = await (await fetch(server.url + "/api/orders/challenge")).json();
  return fetch(server.url + "/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, proof: { token: challenge.token, nonce: "0" } }),
  });
}

const cartOrder = (items) =>
  postOrder({ channel: "whatsapp", customerName: "Айгерим", customerPhone: "+7 701 123 45 67", consent: true, items });

test("LOW-02: неизвестная валюта или раздел — 400 invalid_currency / invalid_category, а не KZT / «management»", async () => {
  for (const [body, error] of [
    [{ ...PRODUCT, currency: "EUR" }, "invalid_currency"],
    [{ ...PRODUCT, category: "removed" }, "invalid_category"],
    [{ ...PRODUCT, category: undefined }, "invalid_category"],
  ]) {
    const res = await admin("POST", "/api/products", body);
    const data = await res.json();
    assert.equal(res.status, 400, JSON.stringify(data));
    assert.equal(data.error, error);
    assert.ok(data.message, "есть понятный текст для админки");
  }

  const created = await admin("POST", "/api/products", { ...PRODUCT, currency: "usd" });
  assert.equal(created.status, 201);
  const product = await created.json();
  assert.equal(product.currency, "USD");

  const patch = await admin("PATCH", "/api/products/" + product.id, { currency: "EUR" });
  assert.equal(patch.status, 400);
  assert.equal((await patch.json()).error, "invalid_currency");
  const kept = await (await fetch(server.url + "/api/products/" + product.id)).json();
  assert.equal(kept.currency, "USD", "товар не изменился");
});

test("LOW-03: неверный статус в PATCH /api/orders/:id — 400 invalid_status, статус прежний", async () => {
  const created = await cartOrder([{ id: "p7", qty: 1 }]);
  const order = await created.json();
  assert.equal(created.status, 201, JSON.stringify(order));

  const res = await admin("PATCH", "/api/orders/" + order.id, { status: "completed" });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_status");
  const current = await (await admin("GET", "/api/orders/" + order.id)).json();
  assert.equal(current.status, "new");

  const ok = await admin("PATCH", "/api/orders/" + order.id, { status: "in_progress" });
  assert.equal(ok.status, 200);
});

test("LOW-04: количество вне диапазона — 400 qty_out_of_range, а не молчаливая замена на 1 или максимум", async () => {
  for (const qty of [1000, 0, -1, 1.5, "abc", undefined]) {
    const res = await cartOrder([{ id: "p7", qty }]);
    const data = await res.json();
    assert.equal(res.status, 400, `qty=${qty}: ${JSON.stringify(data)}`);
    assert.equal(data.error, "qty_out_of_range");
  }
  // Одна позиция двумя строками: сумма тоже не больше предела.
  const split = await cartOrder([{ id: "p7", qty: 600 }, { id: "p7", qty: 600 }]);
  assert.equal((await split.json()).error, "qty_out_of_range");

  const ok = await cartOrder([{ id: "p7", qty: 3 }]);
  const order = await ok.json();
  assert.equal(ok.status, 201, JSON.stringify(order));
  const saved = await (await admin("GET", "/api/orders/" + order.id)).json();
  assert.equal(saved.items[0].qty, 3);
});

test("MED-14: товар без фото хранит пустое значение; сеть для этого не нужна", async () => {
  const noImage = await admin("POST", "/api/products", PRODUCT);
  assert.equal(noImage.status, 201);
  assert.equal((await noImage.json()).image, "");

  // Старая вкладка админки подставляет стоковую картинку — сервер не качает её (сети нет) и сохраняет «без фото».
  const legacy = await admin("POST", "/api/products", { ...PRODUCT, image: LEGACY_DEFAULT_IMAGE });
  const legacyBody = await legacy.json();
  assert.equal(legacy.status, 201, JSON.stringify(legacyBody));
  assert.equal(legacyBody.image, "");

  // Фото можно убрать: файл удаляется, у товара пустое значение.
  const withPhoto = await (await admin("POST", "/api/products", { ...PRODUCT, image: PNG_DATA_URL })).json();
  assert.match(withPhoto.image, /^images\/uploads\/img_/);
  const file = path.join(sandbox.dir, withPhoto.image);
  assert.ok(fs.existsSync(file));
  const cleared = await admin("PATCH", "/api/products/" + withPhoto.id, { image: "" });
  assert.equal((await cleared.json()).image, "");
  assert.equal(fs.existsSync(file), false);

  // Поле не прислали — картинка прежняя.
  const again = await (await admin("POST", "/api/products", { ...PRODUCT, image: PNG_DATA_URL })).json();
  const renamed = await (await admin("PATCH", "/api/products/" + again.id, { title: "Новое название" })).json();
  assert.equal(renamed.image, again.image);
});

test("MED-14: слишком большая встроенная картинка в старых данных — console.warn с id товара, без стоковой подмены", async () => {
  const huge = "data:image/png;base64," + "A".repeat(2_200_000);
  const legacy = createSandbox({
    "data/products.json": JSON.stringify({ products: [{ id: "big-photo", title: "Старый товар", description: "Описание", price: 1, category: "media", image: huge }] }),
  });
  const legacyServer = await startServer(legacy);
  try {
    assert.match(legacyServer.output(), /Картинка товара big-photo в старых данных больше \d+ байт/);
    const product = await (await fetch(legacyServer.url + "/api/products/big-photo")).json();
    assert.equal(product.image, "");
  } finally {
    await legacyServer.stop();
    legacy.cleanup();
  }
});
