const crypto = require("crypto");

/**
 * Защита публичной формы заказов и заявок (POST /api/orders) без сторонней капчи.
 *
 * 1. Одноразовый токен (GET /api/orders/challenge), подписанный HMAC: отправить заказ можно не раньше
 *    чем через minFillMs после выдачи и не позже tokenTtlMs; повторно токен не принимается.
 * 2. Доказательство работы: браузер подбирает nonce, чтобы SHA-256(seed + nonce) начинался с `bits` нулевых бит.
 *    Человеку это незаметно (считается, пока он заполняет форму), а массовая рассылка становится дорогой.
 *    Когда заявок за час слишком много, сложность растёт (surgeBits).
 * 3. Поле-ловушка `website`: люди его не видят, боты заполняют — такой заказ молча не сохраняется.
 * 4. Лимиты: с адреса (за 10 минут и за сутки), на телефон (за час и за сутки), на сайт целиком (за час).
 * 5. Повтор того же заказа с того же телефона в течение dedupMs возвращает уже созданный заказ.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_KEYS = 50000;

function num(value, fallback, min = 0) {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) && n >= min ? n : fallback;
}

function loadOrderGuardConfig(env = process.env) {
  return {
    powBits: Math.min(28, num(env.ORDER_POW_BITS, 17)),
    surgeBits: Math.min(28, num(env.ORDER_POW_SURGE_BITS, 21)),
    surgePerHour: num(env.ORDER_SURGE_PER_HOUR, 30, 1),
    minFillMs: num(env.ORDER_MIN_FILL_MS, 3000),
    tokenTtlMs: num(env.ORDER_TOKEN_TTL_MS, 2 * HOUR, MINUTE),
    challengePer10Min: num(env.ORDER_CHALLENGE_LIMIT, 40, 1),
    ipPer10Min: num(env.ORDER_RATE_LIMIT, 5, 1),
    ipPerDay: num(env.ORDER_DAILY_LIMIT_PER_IP, 20, 1),
    phonePerHour: num(env.ORDER_PHONE_HOURLY_LIMIT, 3, 1),
    phonePerDay: num(env.ORDER_PHONE_DAILY_LIMIT, 10, 1),
    globalPerHour: num(env.ORDER_GLOBAL_HOURLY_LIMIT, 100, 1),
    dedupMs: num(env.ORDER_DEDUP_MS, 30 * MINUTE),
  };
}

/** Скользящее окно: ключ → отметки времени. Отметок не больше лимита, ключей — не больше MAX_KEYS. */
function createWindow(windowMs, now) {
  /** @type {Map<string, number[]>} */
  const buckets = new Map();
  function fresh(key) {
    const start = now() - windowMs;
    const list = (buckets.get(key) || []).filter((t) => t > start);
    if (list.length) buckets.set(key, list);
    else buckets.delete(key);
    return list;
  }
  function prune() {
    if (buckets.size <= MAX_KEYS) return;
    for (const key of [...buckets.keys()]) fresh(key);
    // Всё ещё много живых ключей (атака с тысяч адресов) — старейшие уходят первыми.
    for (const key of buckets.keys()) {
      if (buckets.size <= MAX_KEYS) break;
      buckets.delete(key);
    }
  }
  return {
    count: (key) => fresh(key).length,
    add(key) {
      const list = fresh(key);
      list.push(now());
      buckets.set(key, list);
      prune();
    },
  };
}

function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

const fail = (status, error, message) => ({ ok: false, status, error, message });
const PROOF_RETRY = "Обновите страницу и отправьте форму ещё раз.";

function createOrderGuard(config = loadOrderGuardConfig({}), { now = Date.now, secret = crypto.randomBytes(32) } = {}) {
  const challengesByIp = createWindow(10 * MINUTE, now);
  const ipShort = createWindow(10 * MINUTE, now);
  const ipDay = createWindow(DAY, now);
  const phoneHour = createWindow(HOUR, now);
  const phoneDay = createWindow(DAY, now);
  const globalHour = createWindow(HOUR, now);
  const attemptsHour = createWindow(HOUR, now);
  /** seed → срок, до которого токен считается использованным. */
  const usedTokens = new Map();
  /** телефон + содержимое → { orderId, at } */
  const recent = new Map();
  const stats = { issued: 0, accepted: 0, trapped: 0, badProof: 0, limited: 0, duplicates: 0 };

  const sign = (payload) => crypto.createHmac("sha256", secret).update(payload).digest("base64url");

  function currentBits() {
    return attemptsHour.count("all") >= config.surgePerHour ? Math.max(config.powBits, config.surgeBits) : config.powBits;
  }

  /** GET /api/orders/challenge */
  function challenge(ip) {
    if (challengesByIp.count(ip) >= config.challengePer10Min) {
      stats.limited++;
      return fail(429, "rate_limited", "Слишком много попыток. Подождите несколько минут.");
    }
    challengesByIp.add(ip);
    stats.issued++;
    const seed = crypto.randomBytes(16).toString("hex");
    const payload = ["1", seed, now(), currentBits()].join(".");
    return {
      ok: true,
      body: {
        token: payload + "." + sign(payload),
        seed,
        bits: currentBits(),
        minDelayMs: config.minFillMs,
        ttlMs: config.tokenTtlMs,
      },
    };
  }

  function verifyProof(proof) {
    const token = proof && typeof proof.token === "string" ? proof.token : "";
    const nonce = proof && typeof proof.nonce === "string" ? proof.nonce : "";
    const parts = token.split(".");
    if (parts.length !== 5 || parts[0] !== "1" || !/^\d{1,12}$/.test(nonce)) {
      return fail(403, "challenge_required", PROOF_RETRY);
    }
    const [, seed, tsRaw, bitsRaw, sig] = parts;
    const expected = sign(parts.slice(0, 4).join("."));
    const given = Buffer.from(sig);
    const want = Buffer.from(expected);
    if (sig.length !== expected.length || given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      return fail(403, "challenge_invalid", PROOF_RETRY);
    }
    const age = now() - Number(tsRaw);
    if (!(age >= config.minFillMs)) return fail(403, "challenge_too_fast", "Подождите пару секунд и отправьте ещё раз.");
    if (age > config.tokenTtlMs) return fail(403, "challenge_expired", PROOF_RETRY);
    if (usedTokens.has(seed)) return fail(403, "challenge_used", PROOF_RETRY);
    const digest = crypto.createHash("sha256").update(seed + nonce).digest();
    if (leadingZeroBits(digest) < Number(bitsRaw)) return fail(403, "challenge_invalid", PROOF_RETRY);

    usedTokens.set(seed, Number(tsRaw) + config.tokenTtlMs);
    if (usedTokens.size > MAX_KEYS) {
      const t = now();
      for (const [key, until] of usedTokens) if (until < t) usedTokens.delete(key);
    }
    return { ok: true };
  }

  function dedupKey(phone, fingerprint) {
    return phone + "\n" + fingerprint;
  }

  /**
   * Проверка перед сохранением.
   * @returns {{ ok: true, duplicateOf?: string } | { ok: true, trap: true } | { ok: false, status, error, message }}
   */
  function check({ ip, phone, fingerprint, body }) {
    if (body && body.website != null && String(body.website).trim()) {
      stats.trapped++;
      return { ok: true, trap: true };
    }
    const proof = verifyProof(body && body.proof);
    if (!proof.ok) {
      stats.badProof++;
      return proof;
    }
    attemptsHour.add("all");

    if (ipShort.count(ip) >= config.ipPer10Min || ipDay.count(ip) >= config.ipPerDay) {
      stats.limited++;
      return fail(429, "rate_limited", "Слишком много заказов подряд. Подождите несколько минут или напишите нам в WhatsApp.");
    }
    ipShort.add(ip);
    ipDay.add(ip);

    const previous = recent.get(dedupKey(phone, fingerprint));
    if (previous && now() - previous.at < config.dedupMs) {
      stats.duplicates++;
      return { ok: true, duplicateOf: previous.orderId };
    }
    if (phoneHour.count(phone) >= config.phonePerHour || phoneDay.count(phone) >= config.phonePerDay) {
      stats.limited++;
      return fail(429, "rate_limited", "С этого номера уже отправлено несколько заявок — мы свяжемся с вами. Если срочно, напишите в WhatsApp.");
    }
    if (globalHour.count("all") >= config.globalPerHour) {
      stats.limited++;
      return fail(429, "busy", "Сейчас слишком много заявок. Пожалуйста, напишите нам в WhatsApp.");
    }
    return { ok: true };
  }

  /** Заказ сохранён: учесть в лимитах телефона и сайта и запомнить для склейки повторов. */
  function accepted({ phone, fingerprint, orderId }) {
    stats.accepted++;
    phoneHour.add(phone);
    phoneDay.add(phone);
    globalHour.add("all");
    const t = now();
    recent.set(dedupKey(phone, fingerprint), { orderId, at: t });
    if (recent.size > MAX_KEYS) {
      for (const [key, entry] of recent) if (t - entry.at >= config.dedupMs) recent.delete(key);
    }
  }

  return {
    challenge,
    check,
    accepted,
    stats: () => ({ ...stats, bits: currentBits(), lastHour: globalHour.count("all") }),
    config,
  };
}

module.exports = { createOrderGuard, loadOrderGuardConfig, leadingZeroBits };
