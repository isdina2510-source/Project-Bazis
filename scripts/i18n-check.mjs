/**
 * npm run i18n:check
 *  - ключи kk.json и ru.json совпадают;
 *  - тексты отдельных сайтов (locales/sites/*.json) переопределяют только существующие ключи;
 *  - все строки — валидный ICU MessageFormat, плейсхолдеры в переводе те же, что в ru;
 *  - в коде публичного сайта (src/, кроме админки) нет захардкоженной кириллицы в строках и JSX
 *    (комментарии не считаются; осознанные исключения — пометка i18n-ignore в строке
 *    или блок i18n-ignore-start … i18n-ignore-end);
 *  - каждый ключ, который код называет строкой ("cart.status.error"), есть в словаре — иначе в продакшене
 *    посетитель увидел бы сам ключ вместо текста;
 *  - отчёт: сколько строк ещё TODO(kk) и у каких товаров нет title_kk / description_kk.
 * Код выхода 1 — есть ошибки. Запускается в npm test и перед npm run build.
 * --root <папка> — проверить другую копию проекта (для тестов).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { IntlMessageFormat } from "intl-messageformat";
import { parseAst } from "vite";

const rootArg = process.argv.indexOf("--root");
const ROOT = rootArg > 0 ? path.resolve(process.argv[rootArg + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const TODO_PREFIX = "TODO(kk):";
const CYRILLIC = /[\u0400-\u04FF]/;
/** Строка, похожая на ключ словаря: cart.status.error, catalog.category.media.title. */
const KEY_LIKE = /^[a-z][a-z0-9_]*(\.[a-z0-9_-]+)+$/i;
const verbose = process.argv.includes("--verbose");

/** Не переводятся в рамках задачи: админка (только ru), офлайн-ответы чат-бота и тесты. */
const EXCLUDED = ["admin/", "chat/consult.js", "locales/", "generated/", "test/"];

const errors = [];
const warnings = [];
const rel = (file) => path.relative(ROOT, file).replace(/\\/g, "/");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function flatten(node, prefix = "", out = {}) {
  Object.entries(node).forEach(([key, value]) => {
    const full = prefix ? prefix + "." + key : key;
    if (value && typeof value === "object") flatten(value, full, out);
    else out[full] = value;
  });
  return out;
}

/** Имена аргументов ICU ({name}, {count, plural, …}, <tag>…</tag>). */
function argNames(elements, out = new Set()) {
  elements.forEach((el) => {
    if (el.type >= 1 && el.type <= 6) out.add(el.value);
    if (el.type === 8) out.add("<" + el.value + ">");
    if (el.options) Object.values(el.options).forEach((opt) => argNames(opt.value, out));
    if (el.children) argNames(el.children, out);
  });
  return out;
}

function checkDictionaries() {
  const dicts = {
    ru: flatten(readJson(path.join(SRC, "locales/ru.json"))),
    kk: flatten(readJson(path.join(SRC, "locales/kk.json"))),
  };
  const locales = { ru: "ru-RU", kk: "kk-KZ" };
  const asts = { ru: {}, kk: {} };

  Object.keys(dicts.ru).forEach((key) => {
    if (!(key in dicts.kk)) errors.push(`kk.json: нет ключа ${key}`);
  });
  Object.keys(dicts.kk).forEach((key) => {
    if (!(key in dicts.ru)) errors.push(`ru.json: лишний ключ в kk.json — ${key}`);
  });

  ["ru", "kk"].forEach((lang) => {
    Object.entries(dicts[lang]).forEach(([key, value]) => {
      if (typeof value !== "string") {
        errors.push(`${lang}.json: ${key} — значение должно быть строкой`);
        return;
      }
      if (lang === "kk" && value.startsWith(TODO_PREFIX)) return;
      try {
        asts[lang][key] = argNames(new IntlMessageFormat(value, locales[lang]).getAst());
      } catch (err) {
        errors.push(`${lang}.json: ${key} — неверный ICU: ${err.message}`);
      }
    });
  });

  Object.entries(asts.kk).forEach(([key, names]) => {
    const expected = asts.ru[key];
    if (!expected) return;
    const a = [...names].sort().join(",");
    const b = [...expected].sort().join(",");
    if (a !== b) errors.push(`kk.json: ${key} — плейсхолдеры {${a}} не совпадают с ru {${b}}`);
  });

  const todo = Object.entries(dicts.kk).filter(([, value]) => String(value).startsWith(TODO_PREFIX));
  checkSiteOverrides(dicts, asts, locales);
  return { total: Object.keys(dicts.ru).length, todo, keys: Object.keys(dicts.ru) };
}

/** Ключи, которые код называет строкой, но которых нет в ru.json (и которые не префикс существующих ключей). */
function createKeyChecker(keys) {
  const known = new Set(keys);
  const prefixes = new Set();
  const namespaces = new Set();
  keys.forEach((key) => {
    const parts = key.split(".");
    namespaces.add(parts[0]);
    for (let i = 1; i < parts.length; i++) prefixes.add(parts.slice(0, i).join("."));
  });
  return (text) => KEY_LIKE.test(text) && namespaces.has(text.split(".")[0]) && !known.has(text) && !prefixes.has(text);
}

/** locales/sites/<сайт>.<язык>.json — только ключи общего словаря с теми же плейсхолдерами. */
function checkSiteOverrides(base, baseAsts, locales) {
  const dir = path.join(SRC, "locales/sites");
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((name) => /^[a-z0-9-]+\.(ru|kk)\.json$/.test(name));
  const bySite = {};
  files.forEach((name) => {
    const [site, lang] = name.split(".");
    (bySite[site] ||= {})[lang] = flatten(readJson(path.join(dir, name)));
  });
  Object.entries(bySite).forEach(([site, langs]) => {
    ["ru", "kk"].forEach((lang) => {
      if (!langs[lang]) errors.push(`sites/${site}.${lang}.json: файла нет`);
    });
    if (!langs.ru || !langs.kk) return;
    Object.keys(langs.ru).forEach((key) => {
      if (!(key in langs.kk)) errors.push(`sites/${site}.kk.json: нет ключа ${key}`);
    });
    Object.keys(langs.kk).forEach((key) => {
      if (!(key in langs.ru)) errors.push(`sites/${site}.ru.json: лишний ключ в kk — ${key}`);
    });
    ["ru", "kk"].forEach((lang) => {
      Object.entries(langs[lang]).forEach(([key, value]) => {
        const file = `sites/${site}.${lang}.json`;
        if (!(key in base[lang])) {
          errors.push(`${file}: ключа ${key} нет в общем словаре ${lang}.json`);
          return;
        }
        if (typeof value !== "string") {
          errors.push(`${file}: ${key} — значение должно быть строкой`);
          return;
        }
        if (lang === "kk" && value.startsWith(TODO_PREFIX)) return;
        try {
          const names = [...argNames(new IntlMessageFormat(value, locales[lang]).getAst())].sort().join(",");
          const expected = baseAsts.ru[key] ? [...baseAsts.ru[key]].sort().join(",") : names;
          if (names !== expected) errors.push(`${file}: ${key} — плейсхолдеры {${names}} не совпадают с ru {${expected}}`);
        } catch (err) {
          errors.push(`${file}: ${key} — неверный ICU: ${err.message}`);
        }
      });
    });
  });
}

function listSourceFiles(dir, out = []) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    const inSrc = path.relative(SRC, full).replace(/\\/g, "/") + (entry.isDirectory() ? "/" : "");
    if (EXCLUDED.some((prefix) => inSrc.startsWith(prefix))) return;
    if (entry.isDirectory()) listSourceFiles(full, out);
    else if (/\.(jsx?|mjs)$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name)) out.push(full);
  });
  return out;
}

function ignoredLines(lines) {
  const ignored = new Set();
  let block = false;
  lines.forEach((line, index) => {
    if (line.includes("i18n-ignore-start")) block = true;
    if (block || /i18n-ignore(?!-)/.test(line)) ignored.add(index + 1);
    if (line.includes("i18n-ignore-end")) block = false;
  });
  return ignored;
}

/** Обход ESTree: строки, шаблоны, регэкспы и текст JSX с кириллицей; строковые литералы — неизвестные ключи. */
function findCyrillic(node, hits, missingKeys, isMissingKey) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((child) => findCyrillic(child, hits, missingKeys, isMissingKey));
    return;
  }
  let text = null;
  if (node.type === "Literal") text = node.regex ? node.regex.pattern : typeof node.value === "string" ? node.value : null;
  else if (node.type === "TemplateElement") text = node.value && (node.value.cooked ?? node.value.raw);
  else if (node.type === "JSXText") text = node.value;
  if (text && CYRILLIC.test(text)) hits.push({ start: node.start, text: text.trim() });
  if (node.type === "Literal" && !node.regex && typeof node.value === "string" && isMissingKey(node.value)) {
    missingKeys.push({ start: node.start, text: node.value });
  }
  Object.entries(node).forEach(([key, value]) => {
    if (key !== "type" && value && typeof value === "object") findCyrillic(value, hits, missingKeys, isMissingKey);
  });
}

function checkSources(isMissingKey) {
  let count = 0;
  listSourceFiles(SRC).forEach((file) => {
    const code = fs.readFileSync(file, "utf8");
    const lines = code.split(/\r?\n/);
    const lineStarts = [0];
    for (let i = 0; i < code.length; i++) if (code[i] === "\n") lineStarts.push(i + 1);
    const lineOf = (offset) => {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };
    let ast;
    try {
      ast = parseAst(code, { lang: file.endsWith(".jsx") ? "jsx" : "js" });
    } catch (err) {
      errors.push(`${rel(file)}: не удалось разобрать файл — ${err.message}`);
      return;
    }
    const ignored = ignoredLines(lines);
    const hits = [];
    const missingKeys = [];
    findCyrillic(ast, hits, missingKeys, isMissingKey);
    hits.forEach(({ start, text }) => {
      const line = lineOf(start);
      if (ignored.has(line)) return;
      count += 1;
      errors.push(`${rel(file)}:${line} — строка не из словаря: «${text.slice(0, 70)}»`);
    });
    missingKeys.forEach(({ start, text }) => {
      const line = lineOf(start);
      if (ignored.has(line)) return;
      errors.push(`${rel(file)}:${line} — ключа ${text} нет в словаре ru.json/kk.json`);
    });
  });
  return count;
}

/**
 * Каталог из базы сайта — только если DATABASE_URL задан в окружении (postgres://…): без него, при недоступной
 * базе или в базе без таблиц сайта товары из базы не проверяются (отчёт по ним — лишь предупреждение).
 */
async function readDbProducts() {
  const url = process.env.DATABASE_URL || "";
  if (!/^postgres(ql)?:\/\//i.test(url)) return [];
  let db;
  try {
    const require = createRequire(import.meta.url);
    const { openDatabase } = require(path.join(ROOT, "db", "connection.js"));
    db = await openDatabase(url, { waitMs: 0, log: { warn() {}, log() {}, error() {} } });
    const { rows } = await db.query(
      "SELECT id, title, description, title_kk, description_kk FROM products ORDER BY sort_order, row_no"
    );
    return rows;
  } catch (err) {
    console.warn(`⚠ Не удалось прочитать товары из базы: ${err.message}`);
    return [];
  } finally {
    if (db) await db.close().catch(() => {});
  }
}

async function checkContent() {
  const catalogFile = path.join(ROOT, "shared/catalog.json");
  const sources = [
    [rel(catalogFile), fs.existsSync(catalogFile) ? readJson(catalogFile).DEFAULT_PRODUCTS || [] : []],
    ["база (DATABASE_URL)", await readDbProducts()],
  ];
  const missing = [];
  sources.forEach(([where, list]) => {
    list.forEach((item) => {
      const fields = ["title", "description"].filter((field) => item[field] && !String(item[field + "_kk"] || "").trim());
      if (fields.length) missing.push(`${where}: ${item.id} «${item.title}» — нет ${fields.map((f) => f + "_kk").join(", ")}`);
    });
  });
  return missing;
}

const dict = checkDictionaries();
const hardcoded = checkSources(createKeyChecker(dict.keys));
const content = await checkContent();

if (dict.todo.length) {
  warnings.push(`TODO(kk): ${dict.todo.length} из ${dict.total} строк словаря без казахского перевода (сайт показывает русский).`);
  if (verbose) dict.todo.forEach(([key, value]) => warnings.push(`  ${key}: ${String(value).slice(TODO_PREFIX.length).trim()}`));
}
if (content.length) {
  warnings.push(`TODO(kk): ${content.length} позиций каталога без перевода (title_kk / description_kk).`);
  if (verbose) content.forEach((line) => warnings.push("  " + line));
}

warnings.forEach((line) => console.log("! " + line));
errors.forEach((line) => console.error("✗ " + line));
console.log(
  errors.length
    ? `\ni18n:check — ошибок: ${errors.length} (захардкоженных строк: ${hardcoded}).`
    : "\ni18n:check — ок: словари согласованы, строк вне словаря нет." + (warnings.length ? " Подробно: --verbose" : "")
);
process.exit(errors.length ? 1 : 0);
