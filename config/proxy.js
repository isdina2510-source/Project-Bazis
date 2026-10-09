/**
 * Сайт за обратным прокси (Caddy / nginx на этом же компьютере).
 *
 * Сервер слушает только 127.0.0.1, поэтому из интернета к нему можно попасть только через локальный прокси,
 * и все запросы приходят с 127.0.0.1. Настоящий адрес посетителя прокси пишет последним в X-Forwarded-For
 * (более ранние значения присылает сам посетитель и может подделать), протокол — в X-Forwarded-Proto.
 * Заголовкам доверяем, только если соединение пришло с этого компьютера: снаружи их подставить нельзя.
 */
const net = require("net");

/**
 * TRUST_PROXY: не задан или 1 — заголовкам прокси доверяем (по умолчанию: сервер доступен только через локальный прокси);
 * private — ещё и от адресов локальных сетей (сервер в Docker: прокси приходит из сети контейнеров);
 * 0 — не доверяем никогда. { ok: true, trust, explicit } или { ok: false, error }; trust — true, false или "private".
 */
function parseTrustProxy(raw) {
  const value = String(raw == null ? "" : raw).trim().toLowerCase();
  if (!value || value === "auto") return { ok: true, trust: true, explicit: false };
  if (["1", "true", "yes", "on"].includes(value)) return { ok: true, trust: true, explicit: true };
  if (value === "private") return { ok: true, trust: "private", explicit: true };
  if (["0", "false", "no", "off"].includes(value)) return { ok: true, trust: false, explicit: true };
  return {
    ok: false,
    error: `TRUST_PROXY=${raw} — допустимо 1 (сайт за Caddy/nginx), private (сайт в Docker) или 0 (прокси нет).`,
  };
}

function isLoopbackAddress(address) {
  const value = String(address || "").toLowerCase().replace(/^::ffff:/, "");
  return value === "::1" || /^127\.\d+\.\d+\.\d+$/.test(value);
}

/** Адреса локальных сетей (RFC 1918 и IPv6 ULA) — из них в контейнер приходят Docker и прокси рядом с ним. */
function isPrivateAddress(address) {
  const value = String(address || "").toLowerCase().replace(/^::ffff:/, "");
  if (net.isIPv4(value)) {
    const [a, b] = value.split(".").map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return net.isIPv6(value) && /^f[cd]/.test(value);
}

function isTrustedPeer(req, trustProxy) {
  const address = req.socket && req.socket.remoteAddress;
  if (!trustProxy) return false;
  return isLoopbackAddress(address) || (trustProxy === "private" && isPrivateAddress(address));
}

function lastHeaderValue(value) {
  const joined = Array.isArray(value) ? value.join(",") : String(value || "");
  const parts = joined.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

/** Запрос пришёл через доверенный прокси на этом компьютере. */
function isProxied(req, trustProxy) {
  return isTrustedPeer(req, trustProxy) && !!req.headers["x-forwarded-for"];
}

/** Адрес посетителя: от доверенного прокси — из X-Forwarded-For, иначе адрес соединения. */
function clientAddress(req, trustProxy) {
  const direct = (req.socket && req.socket.remoteAddress) || "unknown";
  if (!isProxied(req, trustProxy)) return direct;
  const forwarded = lastHeaderValue(req.headers["x-forwarded-for"]);
  return net.isIP(forwarded) ? forwarded : direct;
}

/** Протокол, по которому посетитель пришёл к прокси ("https" / "http"), или "" — прокси не сообщил. */
function forwardedProto(req, trustProxy) {
  if (!isTrustedPeer(req, trustProxy)) return "";
  return lastHeaderValue(req.headers["x-forwarded-proto"]).toLowerCase();
}

module.exports = { parseTrustProxy, isLoopbackAddress, isPrivateAddress, isProxied, clientAddress, forwardedProto };
