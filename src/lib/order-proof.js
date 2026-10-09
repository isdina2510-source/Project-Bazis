/**
 * Защита формы заказа от спама (см. antispam/order-guard.js на сервере):
 * одноразовый токен + подбор nonce, при котором SHA-256(seed + nonce) начинается с `bits` нулевых бит.
 * Считается в фоне, пока посетитель заполняет форму: warmOrderProof() — при открытии формы,
 * takeOrderProof() — при отправке (токен одноразовый, после него готовится следующий).
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const W = new Uint32Array(64);

/** Первое 32-битное слово SHA-256 для ASCII-строки до 55 символов (одного блока хватает). */
export function sha256FirstWord(text) {
  W.fill(0);
  for (let i = 0; i < text.length; i++) W[i >> 2] |= text.charCodeAt(i) << (24 - (i % 4) * 8);
  W[text.length >> 2] |= 0x80 << (24 - (text.length % 4) * 8);
  W[15] = text.length * 8;
  for (let i = 16; i < 64; i++) {
    const a = W[i - 15];
    const b = W[i - 2];
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
  }
  let a = 0x6a09e667, b = 0xbb67ae85, c = 0x3c6ef372, d = 0xa54ff53a;
  let e = 0x510e527f, f = 0x9b05688c, g = 0x1f83d9ab, h = 0x5be0cd19;
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  return (0x6a09e667 + a) >>> 0;
}

/** Подбор nonce порциями, чтобы не подвешивать страницу. bits ≤ 28 — хватает первого слова хеша. */
export async function solve(seed, bits) {
  const limit = bits >= 32 ? 0 : 2 ** (32 - bits);
  for (let nonce = 0; ; ) {
    const end = nonce + 20000;
    for (; nonce < end; nonce++) {
      if (sha256FirstWord(seed + nonce) < limit) return String(nonce);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchProof() {
  const res = await fetch("/api/orders/challenge", { cache: "no-store" });
  if (!res.ok) {
    let data = {};
    try {
      data = await res.json();
    } catch {
      // тело не JSON
    }
    const err = new Error(data.message || "challenge_failed");
    err.code = data.error || "challenge_failed";
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const receivedAt = Date.now();
  const nonce = await solve(String(data.seed), Number(data.bits) || 0);
  return {
    proof: { token: data.token, nonce },
    readyAt: receivedAt + (Number(data.minDelayMs) || 0) + 300,
    expiresAt: receivedAt + (Number(data.ttlMs) || 0) * 0.8,
  };
}

let pending = null;

/** Начать готовить токен заранее (открытие формы, фокус в поле). Ошибки проявятся при отправке. */
export function warmOrderProof() {
  if (!pending) {
    pending = fetchProof();
    pending.catch(() => {
      pending = null;
    });
  }
  return pending;
}

/** Готовый одноразовый токен для POST /api/orders (ждёт, если его ещё считают). */
export async function takeOrderProof() {
  let entry = await warmOrderProof();
  if (Date.now() > entry.expiresAt) {
    pending = null;
    entry = await warmOrderProof();
  }
  pending = null;
  if (Date.now() < entry.readyAt) await sleep(entry.readyAt - Date.now());
  return entry.proof;
}

/** Ответы сервера, после которых стоит один раз повторить отправку со свежим токеном. */
export function isProofError(code) {
  return typeof code === "string" && code.startsWith("challenge_");
}
