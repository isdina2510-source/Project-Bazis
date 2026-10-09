import { formatPrice } from "../../lib/catalog.js";
import { downloadBlob } from "../../lib/download.js";
import { notify } from "../dialogs.jsx";

// В шрифте Roboto, встроенном в pdfmake, нет знака тенге — в PDF пишем валюту буквами.
const PDF_CURRENCY = { KZT: "тг", RUB: "руб.", USD: "$" };
const EXCEL_MONEY_FORMAT = { KZT: '#,##0 "₸"', RUB: '#,##0 "₽"', USD: '"$"#,##0' };

function pad(n) {
  return String(n).padStart(2, "0");
}

function formatDateTime(date) {
  return (
    pad(date.getDate()) + "." + pad(date.getMonth() + 1) + "." + date.getFullYear() +
    " " + pad(date.getHours()) + ":" + pad(date.getMinutes())
  );
}

/** Текстовое значение ячейки. `plain` — без символов валют, которых может не быть в шрифте. */
export function formatCell(value, type, currency, plain = false) {
  if (value == null || value === "") return "";
  if (type === "date") return value instanceof Date ? formatDateTime(value) : String(value);
  if (type === "number") return new Intl.NumberFormat("ru-RU").format(Number(value) || 0);
  if (type === "percent") return (Math.round((Number(value) || 0) * 1000) / 10).toLocaleString("ru-RU") + "%";
  if (type === "money") {
    if (!plain) return formatPrice(value, currency);
    const amount = new Intl.NumberFormat("ru-RU").format(Number(value) || 0).replace(/\u00a0|\u202f/g, " ");
    return currency === "USD" ? "$" + amount : amount + " " + (PDF_CURRENCY[currency] || currency);
  }
  return String(value);
}

function fileBase(report) {
  const d = report.generatedAt;
  return "report-" + report.type + "-" + d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

/** Ленивый чанк не загрузился — обычно вкладка открыта до пересборки сайта и ссылается на старые файлы. */
export class StaleBuildError extends Error {
  constructor(cause) {
    super("Не удалось загрузить модуль экспорта", { cause });
    this.name = "StaleBuildError";
  }
}

const CHUNK_ERROR_RE = /dynamically imported module|Importing a module script failed|error loading dynamically|Failed to fetch|Unable to preload/i;

async function lazyImport(load) {
  try {
    return await load();
  } catch (err) {
    throw CHUNK_ERROR_RE.test(String(err && err.message)) ? new StaleBuildError(err) : err;
  }
}

/* ---------- Excel ---------- */

/** exceljs пишет даты как UTC — сдвигаем, чтобы в Excel было местное время. */
function excelDate(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000);
}

function excelValue(value, type) {
  if (value == null || value === "") return null;
  if (type === "date") return value instanceof Date ? excelDate(value) : value;
  if (type === "number" || type === "money" || type === "percent") return Number(value) || 0;
  return value;
}

export async function exportXlsx(report) {
  const excelModule = await lazyImport(() => import("exceljs"));
  const ExcelJS = excelModule.default || excelModule;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Базис CRM";
  workbook.created = report.generatedAt;

  const sheet = workbook.addWorksheet("Отчёт");
  const columnCount = report.columns.length;
  sheet.columns = report.columns.map((col) => ({ key: col.key, width: col.width || 14 }));

  const titleRow = sheet.addRow([report.title]);
  titleRow.font = { bold: true, size: 14 };
  sheet.mergeCells(titleRow.number, 1, titleRow.number, columnCount);
  [...report.filtersText, "Сформирован: " + formatDateTime(report.generatedAt)].forEach((line) => {
    const row = sheet.addRow([line]);
    row.font = { color: { argb: "FF666666" } };
    sheet.mergeCells(row.number, 1, row.number, columnCount);
  });
  sheet.addRow([]);

  report.summary.forEach((item) => {
    const row = sheet.addRow([item.label, excelValue(item.value, item.type)]);
    row.getCell(1).font = { bold: true };
    if (item.type === "money") row.getCell(2).numFmt = EXCEL_MONEY_FORMAT[report.currency] || "#,##0";
    row.getCell(2).alignment = { horizontal: "left" };
  });
  sheet.addRow([]);

  const header = sheet.addRow(report.columns.map((col) => col.label));
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE85D3A" } };
    cell.alignment = { vertical: "middle", wrapText: true };
    cell.border = { bottom: { style: "thin", color: { argb: "FFB23F22" } } };
  });
  header.height = 22;
  const headerRowNumber = header.number;

  const styleCells = (row) => {
    report.columns.forEach((col, i) => {
      const cell = row.getCell(i + 1);
      if (col.type === "money") cell.numFmt = EXCEL_MONEY_FORMAT[report.currency] || "#,##0";
      else if (col.type === "percent") cell.numFmt = "0.0%";
      else if (col.type === "date") cell.numFmt = "dd.mm.yyyy hh:mm";
      else if (col.type === "number") cell.numFmt = "#,##0";
      cell.alignment = { vertical: "top", wrapText: !!col.wrap };
    });
  };

  report.rows.forEach((data) => {
    styleCells(sheet.addRow(report.columns.map((col) => excelValue(data[col.key], col.type))));
  });

  if (report.totals && report.rows.length) {
    const row = sheet.addRow(report.columns.map((col) => excelValue(report.totals[col.key], col.type)));
    styleCells(row);
    row.font = { bold: true };
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = { top: { style: "thin" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F3F3" } };
    });
  }

  sheet.views = [{ state: "frozen", ySplit: headerRowNumber }];
  if (report.rows.length) {
    sheet.autoFilter = {
      from: { row: headerRowNumber, column: 1 },
      to: { row: headerRowNumber + report.rows.length, column: columnCount },
    };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    fileBase(report) + ".xlsx"
  );
}

/* ---------- PDF ---------- */

let pdfMakePromise = null;

function loadPdfMake() {
  if (!pdfMakePromise) {
    pdfMakePromise = lazyImport(() =>
      Promise.all([import("pdfmake/build/pdfmake"), import("pdfmake/build/vfs_fonts")])
    ).then(
      ([pdfModule, fontsModule]) => {
        const pdfMake = pdfModule.default || pdfModule;
        pdfMake.addVirtualFileSystem(fontsModule.default || fontsModule);
        return pdfMake;
      }
    );
    pdfMakePromise.catch(() => (pdfMakePromise = null));
  }
  return pdfMakePromise;
}

export async function exportPdf(report) {
  const pdfMake = await loadPdfMake();
  const landscape = report.columns.length > 5;
  const margin = 32;
  const usable = (landscape ? 842 : 595) - margin * 2;
  const weight = report.columns.reduce((sum, col) => sum + (col.width || 14), 0);
  const widths = report.columns.map((col) => ((col.width || 14) / weight) * usable);
  const isNumeric = (type) => type === "number" || type === "money" || type === "percent";

  const body = [
    report.columns.map((col) => ({
      text: col.label,
      style: "th",
      alignment: isNumeric(col.type) ? "right" : "left",
    })),
    ...report.rows.map((row) =>
      report.columns.map((col) => ({
        text: formatCell(row[col.key], col.type, report.currency, true),
        alignment: isNumeric(col.type) ? "right" : "left",
      }))
    ),
  ];
  if (report.totals && report.rows.length) {
    body.push(
      report.columns.map((col) => ({
        text: formatCell(report.totals[col.key], col.type, report.currency, true),
        bold: true,
        fillColor: "#f3f3f3",
        alignment: isNumeric(col.type) ? "right" : "left",
      }))
    );
  }

  const summary = {
    columns: report.summary.map((item) => ({
      stack: [
        { text: item.label, style: "summaryLabel" },
        { text: formatCell(item.value, item.type, report.currency, true), style: "summaryValue" },
      ],
    })),
    columnGap: 12,
    margin: [0, 10, 0, 14],
  };

  const doc = {
    pageSize: "A4",
    pageOrientation: landscape ? "landscape" : "portrait",
    pageMargins: [margin, margin, margin, margin + 8],
    info: { title: report.title, creator: "Базис CRM" },
    defaultStyle: { font: "Roboto", fontSize: 8.5, lineHeight: 1.15 },
    styles: {
      title: { fontSize: 16, bold: true, color: "#1b1b1b" },
      meta: { fontSize: 8.5, color: "#666666" },
      th: { bold: true, color: "#ffffff", fillColor: "#e85d3a" },
      summaryLabel: { fontSize: 8, color: "#777777" },
      summaryValue: { fontSize: 13, bold: true, color: "#1b1b1b" },
    },
    content: [
      { text: report.title, style: "title" },
      { text: report.filtersText.join("   ·   "), style: "meta", margin: [0, 4, 0, 0] },
      { text: "Сформирован: " + formatDateTime(report.generatedAt), style: "meta" },
      summary,
      report.rows.length
        ? {
            table: { headerRows: 1, widths, body, dontBreakRows: true },
            layout: {
              hLineWidth: (i) => (i === 0 ? 0 : 0.5),
              vLineWidth: () => 0,
              hLineColor: () => "#dddddd",
              paddingTop: () => 4,
              paddingBottom: () => 4,
              fillColor: (i) => (i > 0 && i % 2 === 0 ? "#fafafa" : null),
            },
          }
        : { text: "Нет данных по выбранным параметрам.", style: "meta" },
    ],
    footer: (current, total) => ({
      columns: [
        { text: "ИП «Базис» · CRM", style: "meta" },
        { text: current + " / " + total, style: "meta", alignment: "right" },
      ],
      margin: [margin, 8, margin, 0],
    }),
  };

  const blob = await pdfMake.createPdf(doc).getBlob();
  downloadBlob(blob, fileBase(report) + ".pdf");
}

/* ---------- CSV ---------- */

function csvEscape(value) {
  const text = String(value ?? "");
  return /[";\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/** CSV для русского Excel: разделитель «;», BOM для UTF-8, числа без пробелов. */
export function exportCsv(report) {
  const raw = (value, type) => {
    if (value == null || value === "") return "";
    if (type === "date") return value instanceof Date ? formatDateTime(value) : value;
    if (type === "percent") return String(Math.round((Number(value) || 0) * 1000) / 10).replace(".", ",");
    if (type === "number" || type === "money") return String(Number(value) || 0).replace(".", ",");
    return value;
  };
  const lines = [
    report.columns.map((col) => csvEscape(col.label + (col.type === "money" ? ", " + report.currency : ""))).join(";"),
    ...report.rows.map((row) => report.columns.map((col) => csvEscape(raw(row[col.key], col.type))).join(";")),
  ];
  if (report.totals && report.rows.length) {
    lines.push(report.columns.map((col) => csvEscape(raw(report.totals[col.key], col.type))).join(";"));
  }
  downloadBlob(new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }), fileBase(report) + ".csv");
}

/* ---------- Печать ---------- */

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

export function printReport(report) {
  const win = window.open("", "_blank");
  if (!win) {
    notify("Браузер заблокировал окно печати. Разрешите всплывающие окна для этого сайта.");
    return;
  }
  const numeric = (type) => type === "number" || type === "money" || type === "percent";
  const cell = (tag, value, col, extra = "") =>
    "<" + tag + (numeric(col.type) ? ' class="num"' : "") + extra + ">" +
    escapeHtml(formatCell(value, col.type, report.currency)) + "</" + tag + ">";

  const head = report.columns.map((col) => "<th" + (numeric(col.type) ? ' class="num"' : "") + ">" + escapeHtml(col.label) + "</th>").join("");
  const rows = report.rows.map((row) => "<tr>" + report.columns.map((col) => cell("td", row[col.key], col)).join("") + "</tr>").join("");
  const totals =
    report.totals && report.rows.length
      ? '<tr class="total">' + report.columns.map((col) => cell("td", report.totals[col.key], col)).join("") + "</tr>"
      : "";
  const summary = report.summary
    .map((item) => "<div><span>" + escapeHtml(item.label) + "</span><b>" + escapeHtml(formatCell(item.value, item.type, report.currency)) + "</b></div>")
    .join("");

  win.document.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(report.title)}</title>
<style>
  @page { size: ${report.columns.length > 5 ? "A4 landscape" : "A4"}; margin: 12mm; }
  body { font-family: "Segoe UI", Arial, sans-serif; color: #1b1b1b; font-size: 12px; margin: 0; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #666; margin: 0 0 2px; }
  .summary { display: flex; gap: 24px; margin: 14px 0; }
  .summary span { display: block; color: #777; font-size: 11px; }
  .summary b { font-size: 17px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #e85d3a; color: #fff; text-align: left; padding: 6px; }
  td { padding: 5px 6px; border-bottom: 1px solid #ddd; vertical-align: top; }
  .num { text-align: right; white-space: nowrap; }
  tr.total td { font-weight: 700; background: #f3f3f3; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
</style></head><body>
<h1>${escapeHtml(report.title)}</h1>
${report.filtersText.map((line) => '<p class="meta">' + escapeHtml(line) + "</p>").join("")}
<p class="meta">Сформирован: ${escapeHtml(formatDateTime(report.generatedAt))}</p>
<div class="summary">${summary}</div>
${report.rows.length ? `<table><thead><tr>${head}</tr></thead><tbody>${rows}${totals}</tbody></table>` : '<p class="meta">Нет данных по выбранным параметрам.</p>'}
</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
}
