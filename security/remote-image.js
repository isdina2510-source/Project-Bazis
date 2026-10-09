"use strict";

/**
 * Скачивание картинки товара по ссылке, которую ввёл админ: сервер сохраняет её у себя,
 * чтобы сайт не зависел от чужого хостинга и не раскрывал посетителей сторонним серверам.
 *
 * Запрос делает сам сервер, поэтому ссылка не должна вести во внутреннюю сеть (SSRF):
 * только https на стандартном порту, все адреса из DNS — публичные, соединение идёт ровно
 * на проверенный адрес (DNS не переспрашивается), каждое перенаправление проверяется заново.
 */

const dns = require("node:dns");
const https = require("node:https");
const net = require("node:net");

const MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const BLOCKED = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  BLOCKED.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]) {
  BLOCKED.addSubnet(address, prefix, "ipv6");
}

function imageError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

/** Адрес из интернета, а не из локальной/служебной сети. IPv4 внутри IPv6 (::ffff:10.0.0.1) проверяется как IPv4. */
function isPublicAddress(address) {
  const family = net.isIP(address);
  if (!family) return false;
  if (family === 6) {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    if (/^::ffff:/i.test(address)) return false;
    return !BLOCKED.check(address, "ipv6");
  }
  return !BLOCKED.check(address, "ipv4");
}

/** Проверка ссылки до запроса: https, без логина/пароля в адресе, порт 443. */
function parseImageUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw imageError("invalid_image_url");
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw imageError("invalid_image_url");
  }
  if (String(value).length > 2000) throw imageError("invalid_image_url");
  return url;
}

/** Все адреса имени должны быть публичными; если хоть один внутренний — отказ (защита от DNS rebinding). */
async function resolvePublic(hostname, lookup) {
  const host = hostname.replace(/^\[|\]$/g, "");
  let addresses;
  if (net.isIP(host)) {
    addresses = [{ address: host, family: net.isIP(host) }];
  } else {
    try {
      addresses = await lookup(host, { all: true, verbatim: true });
    } catch {
      throw imageError("image_fetch_failed");
    }
  }
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw imageError("image_host_blocked");
  }
  return addresses[0];
}

function requestOnce(url, target, { maxBytes, timeoutMs, request }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let timer = null;
    const resolve = (value) => {
      clearTimeout(timer);
      resolvePromise(value);
    };
    const reject = (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    };
    const req = request(
      url,
      {
        method: "GET",
        headers: { Accept: "image/webp,image/png,image/jpeg,image/gif", "User-Agent": "BazisCRM/1.0 (+product image)" },
        // Соединяемся с уже проверенным адресом: повторный DNS-запрос мог бы вернуть внутренний IP.
        lookup: (_hostname, options, callback) => {
          if (options && options.all) callback(null, [{ address: target.address, family: target.family }]);
          else callback(null, target.address, target.family);
        },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ redirect: res.headers.location });
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(imageError("image_fetch_failed"));
          return;
        }
        const mime = String(res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
        if (!MIME_TYPES.has(mime)) {
          res.resume();
          reject(imageError("invalid_image"));
          return;
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          reject(imageError("image_too_large"));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy();
            reject(imageError("image_too_large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ buffer: Buffer.concat(chunks), mime }));
        res.on("error", () => reject(imageError("image_fetch_failed")));
      }
    );
    // Ограничение на весь ответ, а не только на простой сокета: медленная отдача тоже прерывается.
    timer = setTimeout(() => {
      reject(imageError("image_fetch_failed"));
      req.destroy(imageError("image_fetch_failed"));
    }, timeoutMs);
    req.on("timeout", () => req.destroy(imageError("image_fetch_failed")));
    req.on("error", (err) => reject(err && err.code && err.code.startsWith("image_") ? err : imageError("image_fetch_failed")));
    req.end();
  });
}

/**
 * Скачать картинку по https-ссылке. Ошибки — с кодом: invalid_image_url, image_host_blocked,
 * image_fetch_failed, image_too_large, invalid_image (не картинка или неподдерживаемый формат).
 * @param {string} value ссылка
 * @param {{ maxBytes: number, timeoutMs?: number, maxRedirects?: number, lookup?: Function, request?: Function }} options
 * @returns {Promise<{ buffer: Buffer, mime: string }>}
 */
async function fetchRemoteImage(value, options) {
  const {
    maxBytes,
    timeoutMs = 10000,
    maxRedirects = 3,
    lookup = dns.promises.lookup,
    request = https.request,
  } = options;
  const deadline = Date.now() + timeoutMs;
  let url = parseImageUrl(value);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const target = await resolvePublic(url.hostname, lookup);
    const left = deadline - Date.now();
    if (left <= 0) throw imageError("image_fetch_failed");
    const result = await requestOnce(url, target, { maxBytes, timeoutMs: left, request });
    if (!result.redirect) return result;
    try {
      url = parseImageUrl(new URL(result.redirect, url).href);
    } catch {
      throw imageError("invalid_image_url");
    }
  }
  throw imageError("image_fetch_failed");
}

module.exports = { fetchRemoteImage, isPublicAddress, parseImageUrl };
