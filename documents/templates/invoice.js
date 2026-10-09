/** Счёт на оплату. Данные — снимок документа (documents/index.js) + картинки logo/stamp/signature. */
const { formatQty } = require("../money");
const {
  COLORS, dash, dateLong, dateShort, money, labeled, tableLayout, gridLayout, th, brandHeader, signatureLine, rule, baseDoc,
} = require("./common");

function cellTitle(label, value, opts = {}) {
  return {
    stack: [
      { text: label, style: "small" },
      { text: dash(value), bold: !!opts.bold, fontSize: opts.fontSize || 9 },
    ],
  };
}

function bankBlock(company) {
  return {
    table: {
      widths: ["*", 150, 90],
      body: [
        [
          { stack: [{ text: "Бенефициар:", style: "small" }, { text: dash(company.name), bold: true }, { text: "ИИН/БИН: " + dash(company.bin) }] },
          cellTitle("ИИК", company.iik, { bold: true }),
          cellTitle("Кбе", company.kbe, { bold: true }),
        ],
        [
          cellTitle("Банк бенефициара:", company.bank),
          cellTitle("БИК", company.bik, { bold: true }),
          cellTitle("Код назначения платежа", company.knp, { bold: true }),
        ],
      ],
    },
    layout: gridLayout,
    margin: [0, 0, 0, 12],
  };
}

function partyLine(label, party) {
  const parts = [dash(party.name), "ИИН/БИН " + dash(party.bin), party.address, party.phone ? "тел. " + party.phone : ""]
    .map((v) => (v == null ? "" : String(v).trim()))
    .filter(Boolean);
  return {
    columns: [
      { text: label, width: 80, color: COLORS.muted },
      { text: parts.join(", "), bold: true, width: "*" },
    ],
    margin: [0, 0, 0, 4],
  };
}

function itemsTable(snapshot) {
  const showDiscount = snapshot.lines.some((line) => line.discount > 0);
  const cur = snapshot.currency;
  const header = [th("№", "center"), th("Наименование"), th("Кол-во", "right"), th("Ед."), th("Цена", "right")];
  if (showDiscount) header.push(th("Скидка", "right"));
  header.push(th("Сумма", "right"));
  const widths = [18, "*", 42, 28, 70];
  if (showDiscount) widths.push(60);
  widths.push(78);

  const body = [header];
  snapshot.lines.forEach((line) => {
    const row = [
      { text: String(line.n), alignment: "center" },
      { text: line.title },
      { text: formatQty(line.qty), alignment: "right" },
      { text: line.unit },
      { text: money(line.price, cur), alignment: "right", noWrap: true },
    ];
    if (showDiscount) row.push({ text: line.discount ? "−" + money(line.discount, cur) : "", alignment: "right", noWrap: true });
    row.push({ text: money(line.amount, cur), alignment: "right", noWrap: true });
    body.push(row);
  });
  return { table: { headerRows: 1, widths, body, dontBreakRows: true }, layout: tableLayout, margin: [0, 6, 0, 8] };
}

function totalsBlock(snapshot) {
  const t = snapshot.totals;
  const cur = snapshot.currency;
  const rows = [];
  const net = t.subtotal - t.itemsDiscount;
  if (t.orderDiscount || t.delivery) rows.push(["Итого по позициям:", money(net, cur)]);
  if (t.orderDiscount) rows.push(["Скидка на заказ:", "−" + money(t.orderDiscount, cur)]);
  if (t.delivery) rows.push(["Доставка:", money(t.delivery, cur)]);
  rows.push([{ text: "Итого к оплате:", bold: true }, { text: money(t.total, cur), bold: true }]);
  rows.push(t.vatRate > 0 ? ["В том числе НДС " + String(t.vatRate).replace(".", ",") + "%:", money(t.vat, cur)] : ["Без НДС", ""]);
  return {
    columns: [
      { width: "*", text: "" },
      {
        width: "auto",
        table: { body: rows.map(([a, b]) => [{ text: a, alignment: "right" }, { text: b, alignment: "right", noWrap: true }]) },
        layout: "noBorders",
      },
    ],
    margin: [0, 0, 0, 8],
  };
}

function signatureBlock(data) {
  const company = data.company || {};
  return {
    unbreakable: true,
    margin: [0, 14, 0, 0],
    columns: [
      {
        width: "*",
        stack: [
          signatureLine({
            title: "Исполнитель",
            position: company.directorPosition || "",
            name: company.director,
            image: data.signature,
          }),
        ],
      },
      data.stamp
        ? { image: data.stamp, fit: [100, 100], width: 110 }
        : { text: "М.П.", width: 60, style: "meta", margin: [0, 30, 0, 0] },
    ],
    columnGap: 30,
  };
}

function invoiceDoc(data) {
  const snapshot = data;
  const company = snapshot.company || {};
  const buyer = snapshot.buyer || {};
  const lines = snapshot.lines || [];
  const title = "Счёт на оплату № " + snapshot.number + " от " + dateLong(snapshot.date);
  const content = [
    brandHeader(data),
    {
      text:
        "Внимание! Оплата данного счёта означает согласие с условиями оказания услуг (поставки товара). " +
        "В назначении платежа укажите номер и дату счёта.",
      style: "small",
      margin: [0, 0, 0, 6],
    },
    bankBlock(company),
    { text: title, style: "title" },
    rule(),
    partyLine("Поставщик:", company),
    partyLine("Покупатель:", buyer),
    labeled("Договор", buyer.contract || "Без договора", { margin: [0, 2, 0, 2] }),
    labeled("Основание", "Заказ от " + dateShort(snapshot.order && snapshot.order.createdAt), { margin: [0, 0, 0, 2] }),
    itemsTable(snapshot),
    totalsBlock(snapshot),
    {
      text: "Всего наименований " + lines.length + ", на сумму " + money(snapshot.totals.total, snapshot.currency),
      margin: [0, 0, 0, 2],
    },
    { text: [{ text: "Всего к оплате: ", bold: true }, { text: snapshot.amountInWords, bold: true }], margin: [0, 0, 0, 8] },
  ];
  if (company.invoiceNote) content.push({ text: company.invoiceNote, style: "meta", margin: [0, 0, 0, 6] });
  content.push(rule(undefined, [0, 4, 0, 0]), signatureBlock(data));
  return baseDoc({
    title,
    content,
    footerLeft: "Счёт № " + snapshot.number,
    watermark: data.annulled ? "АННУЛИРОВАН" : undefined,
  });
}

module.exports = { invoiceDoc };
