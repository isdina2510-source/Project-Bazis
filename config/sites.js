/**
 * Адреса и домены сайтов из shared/sites.json и .env. Общие для сервера (выбор сайта по Host),
 * сборки (canonical, ссылки между сайтами) и генератора конфигов прокси (scripts/deploy-config.mjs).
 *
 * Для публикации достаточно SITE_DOMAIN=bazis.kz: сайт без subdomain в shared/sites.json получает
 * https://bazis.kz и www.bazis.kz, сайт с "subdomain": "media" — https://media.bazis.kz.
 * Адрес отдельного сайта можно задать явно (SITE_URL, MEDIA_SITE_URL или url в shared/sites.json) — он важнее SITE_DOMAIN.
 */
const { URL, domainToASCII } = require("url");
const net = require("net");

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Имя переменной с адресом сайта: SITE_URL для основного, <ID>_SITE_URL для остальных. */
function urlEnvName(id, defaultId) {
  return id === defaultId ? "SITE_URL" : id.toUpperCase() + "_SITE_URL";
}

/** Адреса этого компьютера: по ним сайт открывается локально, в интернет они не публикуются. */
function isLocalHostname(host) {
  const value = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value.endsWith(".localhost") || value === "::1" || /^127\./.test(value) || value === "0.0.0.0";
}

/** Домен в ASCII (кириллица — в punycode) или "" , если это не домен в интернете. */
function toPublicHostname(raw) {
  const value = String(raw || "").trim().toLowerCase().replace(/\.$/, "");
  if (!value || net.isIP(value) || isLocalHostname(value)) return "";
  const ascii = domainToASCII(value);
  const labels = ascii.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL_RE.test(label)) || /^\d+$/.test(labels[labels.length - 1])) {
    return "";
  }
  return ascii;
}

/**
 * SITE_DOMAIN: { ok: true, domain } (domain "" — не задан) или { ok: false, error }.
 * Принимает и «https://www.bazis.kz/» — схема, путь и www. отбрасываются.
 */
function parseSiteDomain(raw) {
  const source = String(raw == null ? "" : raw).trim();
  if (!source) return { ok: true, domain: "" };
  const bare = source.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/[/?#].*$/, "");
  const fail = (why) => ({
    ok: false,
    error: `SITE_DOMAIN=${source} — ${why}. Укажите только домен сайта, например SITE_DOMAIN=bazis.kz.`,
  });
  if (/:\d*$/.test(bare)) return fail("порт указывать не нужно (сайт открывается через прокси на 443)");
  const host = toPublicHostname(bare);
  if (!host) return fail("это не домен в интернете");
  return { ok: true, domain: host.replace(/^www\./, "") };
}

/** Адрес сайта (SITE_URL, url в shared/sites.json): origin вида https://bazis.kz или null, если адрес неверный. */
function parseSiteUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
  return url.origin;
}

/**
 * Итоговые адреса всех сайтов.
 * @param {{ default: string, sites: Record<string, { label: string, hosts: string[], url?: string, subdomain?: string }> }} sitesConfig
 * @param {Record<string, string | undefined>} env
 * @returns {{ ok: boolean, errors: string[], domain: string, sites: Array<{ id: string, label: string, url: string,
 *   urlSource: string, hosts: string[], publicHosts: string[] }> }}
 */
function resolveSites(sitesConfig, env = {}) {
  const errors = [];
  const domainCheck = parseSiteDomain(env.SITE_DOMAIN);
  if (!domainCheck.ok) errors.push(domainCheck.error);
  const domain = domainCheck.ok ? domainCheck.domain : "";

  const sites = Object.entries(sitesConfig.sites).map(([id, site]) => {
    const envName = urlEnvName(id, sitesConfig.default);
    let url = "";
    let urlSource = "";
    for (const [value, from] of [
      [env[envName], envName],
      [site.url, `url сайта ${id} в shared/sites.json`],
    ]) {
      if (!String(value || "").trim()) continue;
      const origin = parseSiteUrl(value);
      if (!origin) {
        errors.push(`${from}=${value} — нужен адрес сайта без пути, например https://bazis.kz`);
        continue;
      }
      url = origin;
      urlSource = from;
      break;
    }
    if (!url && domain) {
      url = "https://" + (site.subdomain ? site.subdomain + "." : "") + domain;
      urlSource = "SITE_DOMAIN";
    }

    const hosts = new Set(site.hosts.map((host) => String(host).toLowerCase()));
    if (url) {
      const host = new URL(url).hostname;
      hosts.add(host);
      // У основного сайта посетители часто набирают www. — открываем тот же сайт.
      if (!site.subdomain && toPublicHostname(host) && !host.startsWith("www.")) hosts.add("www." + host);
    }
    const all = [...hosts];
    return { id, label: site.label, url, urlSource, hosts: all, publicHosts: all.filter((host) => toPublicHostname(host)) };
  });

  const owner = new Map();
  for (const site of sites) {
    for (const host of site.hosts) {
      if (owner.has(host) && owner.get(host) !== site.id) {
        errors.push(`Домен ${host} указан и у сайта ${owner.get(host)}, и у сайта ${site.id} — сервер не сможет выбрать, какой показать.`);
      }
      owner.set(host, site.id);
    }
  }

  return { ok: errors.length === 0, errors, domain, sites };
}

module.exports = { urlEnvName, isLocalHostname, parseSiteDomain, parseSiteUrl, resolveSites };
