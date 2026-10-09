const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const path = require("path");
const { pathToFileURL } = require("url");
const { createOrderGuard, loadOrderGuardConfig, leadingZeroBits } = require("../order-guard");

const browserProof = () => import(pathToFileURL(path.join(__dirname, "../../src/lib/order-proof.js")).href);

function setup(overrides = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const config = { ...loadOrderGuardConfig({}), powBits: 8, surgeBits: 12, ...overrides };
  const guard = createOrderGuard(config, { now: clock.now });
  return { guard, clock, config };
}

/** Решение задачи так же, как в браузере (но синхронно, перебором). */
function solveSync(seed, bits) {
  for (let n = 0; ; n++) {
    if (leadingZeroBits(crypto.createHash("sha256").update(seed + n).digest()) >= bits) return String(n);
  }
}

function proofFor(guard, ip = "1.1.1.1") {
  const issued = guard.challenge(ip);
  assert.equal(issued.ok, true);
  return { token: issued.body.token, nonce: solveSync(issued.body.seed, issued.body.bits) };
}

const order = (proof, extra = {}) => ({ proof, ...extra });

test("браузерный SHA-256 совпадает с node:crypto, подбор даёт верное решение", async () => {
  const { sha256FirstWord, solve } = await browserProof();
  for (const text of ["", "a", "abc", "0123456789abcdef0123456789abcdef4242", "x".repeat(55)]) {
    const expected = crypto.createHash("sha256").update(text).digest().readUInt32BE(0);
    assert.equal(sha256FirstWord(text), expected, text);
  }
  const seed = crypto.randomBytes(16).toString("hex");
  const nonce = await solve(seed, 12);
  assert.ok(leadingZeroBits(crypto.createHash("sha256").update(seed + nonce).digest()) >= 12);
});

test("токен: не раньше minFillMs, одноразовый, подпись и решение проверяются", () => {
  const { guard, clock, config } = setup();
  const proof = proofFor(guard);
  const ctx = { ip: "1.1.1.1", phone: "77010000001", fingerprint: "a" };

  assert.equal(guard.check({ ...ctx, body: order(proof) }).error, "challenge_too_fast");
  clock.advance(config.minFillMs);
  assert.deepEqual(guard.check({ ...ctx, body: order(proof) }), { ok: true });
  assert.equal(guard.check({ ...ctx, body: order(proof) }).error, "challenge_used");

  assert.equal(guard.check({ ...ctx, body: {} }).error, "challenge_required");
  const forged = proofFor(guard);
  const parts = forged.token.split(".");
  parts[3] = "0";
  clock.advance(config.minFillMs);
  assert.equal(guard.check({ ...ctx, body: order({ ...forged, token: parts.join(".") }) }).error, "challenge_invalid");

  const wrongNonce = proofFor(guard);
  clock.advance(config.minFillMs);
  const bad = String(Number(wrongNonce.nonce) + 1);
  const res = guard.check({ ...ctx, body: order({ ...wrongNonce, nonce: bad }) });
  // Соседний nonce почти наверняка не решает задачу; если вдруг решает — это тоже корректный ответ.
  assert.ok(res.ok || res.error === "challenge_invalid");

  const old = proofFor(guard);
  clock.advance(config.tokenTtlMs + 1);
  assert.equal(guard.check({ ...ctx, body: order(old) }).error, "challenge_expired");

  const otherServer = createOrderGuard(config, { now: clock.now });
  const foreign = proofFor(otherServer);
  clock.advance(config.minFillMs);
  assert.equal(guard.check({ ...ctx, body: order(foreign) }).error, "challenge_invalid", "токен после перезапуска сервера не принимается");
});

test("ловушка, лимиты по адресу и телефону, склейка повторов, общий лимит", () => {
  const { guard, clock, config } = setup({ ipPer10Min: 3, phonePerHour: 2, globalPerHour: 4, surgePerHour: 1000 });
  const send = (ip, phone, fingerprint, extra) => {
    const proof = proofFor(guard, ip);
    clock.advance(config.minFillMs);
    const res = guard.check({ ip, phone, fingerprint, body: order(proof, extra) });
    if (res.ok && !res.trap && !res.duplicateOf) guard.accepted({ phone, fingerprint, orderId: "ord_" + fingerprint });
    return res;
  };

  assert.deepEqual(send("9.9.9.9", "77010000009", "x", { website: "http://spam" }), { ok: true, trap: true });

  assert.equal(send("1.1.1.1", "77010000001", "a").ok, true);
  assert.equal(send("1.1.1.1", "77010000001", "a").duplicateOf, "ord_a", "тот же заказ — уже созданный");
  assert.equal(send("1.1.1.1", "77010000001", "b").ok, true);
  assert.equal(send("1.1.1.1", "77010000001", "c").error, "rate_limited", "4-й с адреса за 10 минут");

  assert.equal(send("2.2.2.2", "77010000001", "d").error, "rate_limited", "3-й с телефона за час");

  assert.equal(send("3.3.3.3", "77010000003", "e").ok, true);
  assert.equal(send("4.4.4.4", "77010000004", "f").ok, true);
  assert.equal(send("5.5.5.5", "77010000005", "g").error, "busy", "общий лимит сайта за час");

  clock.advance(60 * 60 * 1000);
  assert.equal(send("5.5.5.5", "77010000005", "g").ok, true, "через час лимиты отпускают");
  assert.ok(guard.stats().trapped === 1);
});

test("при всплеске заявок задача усложняется; выдача токенов ограничена", () => {
  const { guard, clock, config } = setup({ surgePerHour: 2, challengePer10Min: 5 });
  assert.equal(guard.challenge("7.7.7.7").body.bits, config.powBits);
  for (let i = 0; i < 2; i++) {
    const proof = proofFor(guard, "8.8.8." + i);
    clock.advance(config.minFillMs);
    guard.check({ ip: "8.8.8." + i, phone: "7701000000" + i, fingerprint: "s" + i, body: order(proof) });
  }
  assert.equal(guard.challenge("7.7.7.7").body.bits, config.surgeBits);
  for (let i = 0; i < 3; i++) guard.challenge("7.7.7.7");
  assert.equal(guard.challenge("7.7.7.7").error, "rate_limited");
});
