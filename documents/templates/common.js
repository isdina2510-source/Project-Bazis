/**
 * Общее оформление PDF: фирменные цвета сайта, шрифт Inter, шапка с логотипом, подвал с номерами страниц.
 * Шаблоны — чистые функции: данные (уже с картинками в data-URL) → описание документа pdfmake.
 */
const { formatMoney, currencySymbol } = require("../money");

const COLORS = {
  brand: "#1f6b4a",
  brandDeep: "#18563b",
  ink: "#163528",
  muted: "#5b6f64",
  line: "#cfdcd4",
  soft: "#eef4f0",
  paper: "#faf8f3",
};

const MONTHS_GENITIVE = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

const DASH = "—";

/** Пустое значение реквизита печатается прочерком. */
function dash(value) {
  const text = value == null ? "" : String(value).trim();
  return text || DASH;
}

const pad = (n) => String(n).padStart(2, "0");

/** Даты и год нумерации считаются по часовому поясу компании, а не сервера. */
const TIME_ZONE = process.env.DOCUMENTS_TZ || "Asia/Almaty";
let partsFormat;

/** @returns {{ year: number, month: number, day: number, hour: number, minute: number } | null} month — 1…12 */
function localParts(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  if (!partsFormat) {
    try {
      partsFormat = new Intl.DateTimeFormat("en-GB", {
        timeZone: TIME_ZONE, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23",
      });
    } catch {
      partsFormat = new Intl.DateTimeFormat("en-GB", {
        year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23",
      });
    }
  }
  const parts = {};
  for (const { type, value } of partsFormat.formatToParts(d)) parts[type] = Number(value);
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute };
}

/** 07 октября 2026 г. */
function dateLong(iso) {
  const p = localParts(iso);
  if (!p) return DASH;
  return pad(p.day) + " " + MONTHS_GENITIVE[p.month - 1] + " " + p.year + " г.";
}

/** 07.10.2026 */
function dateShort(iso) {
  const p = localParts(iso);
  if (!p) return DASH;
  return pad(p.day) + "." + pad(p.month) + "." + p.year;
}

function dateTime(iso) {
  const p = localParts(iso);
  if (!p) return DASH;
  return dateShort(iso) + " " + pad(p.hour) + ":" + pad(p.minute);
}

/** Сумма со знаком валюты: 150 000,00 ₸ / $1 200,00 */
function money(minor, currency) {
  const amount = formatMoney(minor);
  return currency === "USD" ? "$" + amount : amount + "\u00a0" + currencySymbol(currency);
}

/** Поле «подпись: значение» в одну строку. */
function labeled(label, value, opts = {}) {
  return {
    text: [{ text: label + ": ", color: COLORS.muted }, { text: dash(value), bold: !!opts.bold }],
    margin: opts.margin || [0, 0, 0, 2],
  };
}

/** Таблица с тонкими горизонтальными линиями и фирменной шапкой. */
const tableLayout = {
  hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0.8 : 0.5),
  vLineWidth: () => 0,
  hLineColor: (i) => (i <= 1 ? COLORS.brand : COLORS.line),
  paddingTop: () => 4,
  paddingBottom: () => 4,
  paddingLeft: () => 4,
  paddingRight: () => 4,
};

/** Сетка с рамками — для банковских реквизитов и бланка Р-1. */
const gridLayout = {
  hLineWidth: () => 0.6,
  vLineWidth: () => 0.6,
  hLineColor: () => COLORS.ink,
  vLineColor: () => COLORS.ink,
  paddingTop: () => 3,
  paddingBottom: () => 3,
  paddingLeft: () => 4,
  paddingRight: () => 4,
};

const th = (text, alignment = "left") => ({ text, style: "th", alignment });

const underline = { border: [false, false, false, true] };
const noBorder = { border: [false, false, false, false] };

/**
 * Строка подписи: должность ___подпись___ ___расшифровка___ с подписями под линиями.
 * Линии — нижние границы ячеек, поэтому подстраиваются под ширину колонки.
 */
function signatureLine({ title, position, name, image }) {
  return {
    stack: [
      title ? { text: title, bold: true, margin: [0, 0, 0, 6] } : { text: "" },
      {
        table: {
          widths: ["30%", "30%", "40%"],
          heights: (row) => (row === 0 ? 30 : "auto"),
          body: [
            [
              { ...underline, text: position || "", fontSize: 8, margin: [0, 16, 0, 0] },
              image ? { ...underline, image, fit: [90, 30], alignment: "center" } : { ...underline, text: "" },
              { ...underline, text: name ? String(name) : "", margin: [0, 16, 0, 0] },
            ],
            [
              { ...noBorder, text: "должность", style: "small" },
              { ...noBorder, text: "подпись", style: "small", alignment: "center" },
              { ...noBorder, text: "расшифровка подписи", style: "small" },
            ],
          ],
        },
        layout: {
          hLineWidth: () => 0.6,
          vLineWidth: () => 0,
          hLineColor: () => COLORS.ink,
          paddingLeft: () => 2,
          paddingRight: () => 6,
          paddingTop: () => 1,
          paddingBottom: () => 1,
        },
      },
    ],
  };
}

/** Шапка: логотип слева, контакты организации справа. */
function brandHeader(data) {
  const company = data.company || {};
  const contacts = [company.address, company.phone, company.email].filter((v) => v && String(v).trim());
  return {
    columns: [
      data.logo ? { image: data.logo, width: 120 } : { text: dash(company.name), style: "brandName", width: 200 },
      {
        width: "*",
        alignment: "right",
        stack: [
          { text: dash(company.name), bold: true, color: COLORS.ink },
          ...contacts.map((line) => ({ text: line, style: "meta" })),
        ],
      },
    ],
    columnGap: 16,
    margin: [0, 0, 0, 10],
  };
}

/** Ширина области текста A4 при полях baseDoc по умолчанию. */
const CONTENT_WIDTH = { portrait: 595.28 - 72, landscape: 841.89 - 72 };

function rule(width = CONTENT_WIDTH.portrait, margin = [0, 6, 0, 10]) {
  return {
    canvas: [{ type: "line", x1: 0, y1: 0, x2: width, y2: 0, lineWidth: 1.2, lineColor: COLORS.brand }],
    margin,
  };
}

/**
 * @param {{ title: string, content: object[], landscape?: boolean, footerLeft?: string, margins?: number[], watermark?: string }} opts
 */
function baseDoc(opts) {
  const margins = opts.margins || [36, 34, 36, 44];
  return {
    pageSize: "A4",
    pageOrientation: opts.landscape ? "landscape" : "portrait",
    pageMargins: margins,
    info: { title: opts.title, creator: "Базис CRM", producer: "Базис CRM" },
    defaultStyle: { font: "Inter", fontSize: 9, lineHeight: 1.18, color: COLORS.ink },
    styles: {
      brandName: { fontSize: 18, bold: true, color: COLORS.brand },
      title: { fontSize: 15, bold: true, color: COLORS.ink },
      h2: { fontSize: 11.5, bold: true, color: COLORS.brand, margin: [0, 10, 0, 6] },
      meta: { fontSize: 8, color: COLORS.muted },
      small: { fontSize: 7.5, color: COLORS.muted },
      th: { bold: true, fontSize: 8, color: COLORS.brandDeep },
      gridTh: { bold: true, fontSize: 7, alignment: "center" },
      total: { bold: true, fontSize: 10 },
    },
    content: opts.content,
    ...(opts.watermark
      ? { watermark: { text: opts.watermark, font: "Inter", bold: true, color: "#b42318", opacity: 0.18, angle: -30 } }
      : {}),
    footer: (current, total) => ({
      columns: [
        { text: opts.footerLeft || "", style: "small" },
        { text: "Страница " + current + " из " + total, style: "small", alignment: "right" },
      ],
      margin: [margins[0], 14, margins[2], 0],
    }),
  };
}

module.exports = {
  COLORS, CONTENT_WIDTH, DASH, TIME_ZONE, localParts, dash, dateLong, dateShort, dateTime, money, labeled, tableLayout, gridLayout, th, brandHeader,
  signatureLine, rule, baseDoc,
};
