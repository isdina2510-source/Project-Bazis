/** Каталог товаров и услуг (выборка или весь список) и карточка одного товара. */
const { COLORS, dash, dateLong, money, brandHeader, rule, baseDoc } = require("./common");

const KIND_LABELS = { product: "Товар", service: "Услуга" };

function stockText(stock) {
  if (stock == null) return "";
  return stock > 0 ? "В наличии: " + stock + " шт." : "Нет в наличии";
}

/** В каталоге раздел уже назван заголовком группы, поэтому categoryTitle передаётся только для карточки. */
function kindLine(item) {
  return [KIND_LABELS[item.kind] || KIND_LABELS.service, item.categoryTitle].filter(Boolean).join(" · ");
}

function priceText(item) {
  return (item.fromPrice ? "от " : "") + money(item.price, item.currency);
}

function itemRow(item, opts) {
  const details = [
    { text: item.title, bold: true, fontSize: 11, color: COLORS.ink },
    { text: kindLine(item), style: "meta", margin: [0, 1, 0, 4] },
    { text: item.description || "", margin: [0, 0, 0, 4] },
  ];
  const bottom = [];
  if (opts.showPrices) bottom.push({ text: priceText(item), bold: true, fontSize: 11, color: COLORS.brand, width: "auto" });
  if (opts.showStock && item.stock != null) bottom.push({ text: stockText(item.stock), style: "meta", width: "*", margin: [10, 2, 0, 0] });
  if (bottom.length) details.push({ columns: bottom });
  return [
    item.image
      ? { image: item.image, fit: [118, 88], alignment: "center" }
      : { text: "Без фото", style: "meta", alignment: "center", fillColor: COLORS.soft, margin: [0, 36, 0, 36] },
    { stack: details },
  ];
}

const rowsLayout = {
  hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0 : 0.5),
  vLineWidth: () => 0,
  hLineColor: () => COLORS.line,
  paddingTop: () => 8,
  paddingBottom: () => 8,
  paddingLeft: (i) => (i === 0 ? 0 : 12),
  paddingRight: () => 0,
};

function catalogDoc(data) {
  const opts = { showPrices: data.showPrices !== false, showStock: !!data.showStock };
  const count = data.groups.reduce((sum, group) => sum + group.items.length, 0);
  const content = [
    brandHeader(data),
    { text: data.title || "Каталог товаров и услуг", style: "title" },
    { text: "Позиций: " + count + " · по состоянию на " + dateLong(data.generatedAt), style: "meta", margin: [0, 2, 0, 0] },
    rule(),
  ];
  data.groups.forEach((group, index) => {
    content.push({
      stack: [
        { text: group.title, style: "h2", margin: [0, index ? 14 : 2, 0, 2] },
        group.lead ? { text: group.lead, style: "meta", margin: [0, 0, 0, 4] } : { text: "" },
      ],
      unbreakable: true,
    });
    content.push({
      table: { widths: [118, "*"], body: group.items.map((item) => itemRow(item, opts)), dontBreakRows: true },
      layout: rowsLayout,
    });
  });
  if (!count) content.push({ text: "Нет позиций для каталога.", style: "meta" });
  if (opts.showPrices) {
    content.push({ text: "Цены указаны на дату формирования каталога. Без НДС.", style: "small", margin: [0, 12, 0, 0] });
  }
  return baseDoc({ title: data.title || "Каталог товаров и услуг", content, footerLeft: dash(data.company && data.company.name) });
}

function productDoc(data) {
  const item = data.item;
  const content = [
    brandHeader(data),
    { text: item.title, style: "title", fontSize: 18 },
    { text: kindLine(item), style: "meta", margin: [0, 2, 0, 0] },
    rule(),
  ];
  if (item.image) content.push({ image: item.image, fit: [523, 300], alignment: "center", margin: [0, 0, 0, 12] });
  content.push({ text: item.description || "", fontSize: 10.5, margin: [0, 0, 0, 12] });
  content.push({
    columns: [
      { text: priceText(item), fontSize: 16, bold: true, color: COLORS.brand, width: "auto" },
      { text: stockText(item.stock), style: "meta", width: "*", margin: [14, 5, 0, 0] },
    ],
  });
  content.push({ text: "Цена на " + dateLong(data.generatedAt) + ". Без НДС.", style: "small", margin: [0, 10, 0, 0] });
  return baseDoc({ title: item.title, content, footerLeft: dash(data.company && data.company.name) });
}

module.exports = { catalogDoc, productDoc };
