/**
 * Акт выполненных работ (оказанных услуг), форма Р-1
 * (приложение 50 к приказу Министра финансов РК от 20 декабря 2012 года № 562).
 */
const { formatQty } = require("../money");
const { COLORS, dash, dateShort, money, gridLayout, signatureLine, baseDoc } = require("./common");

const FORM_NOTE =
  "Приложение 50 к приказу Министра финансов Республики Казахстан от 20 декабря 2012 года № 562";

function partyRow(label, party) {
  const details = [dash(party.name), party.address, party.phone ? "тел. " + party.phone : ""]
    .map((v) => (v == null ? "" : String(v).trim()))
    .filter(Boolean)
    .join(", ");
  return [
    { text: label, color: COLORS.muted, border: [false, false, false, false] },
    { text: details, bold: true, border: [false, false, false, true] },
    { text: "ИИН/БИН", style: "small", alignment: "right", border: [false, false, false, false] },
    { text: dash(party.bin), alignment: "center", bold: true, border: [true, true, true, true] },
  ];
}

function headerBlock(snapshot) {
  const company = snapshot.company || {};
  const buyer = snapshot.buyer || {};
  return [
    {
      columns: [
        { width: "*", text: "" },
        { width: 260, stack: [{ text: FORM_NOTE, style: "small", alignment: "right" }, { text: "Форма Р-1", bold: true, alignment: "right", margin: [0, 2, 0, 0] }] },
      ],
      margin: [0, 0, 0, 8],
    },
    {
      table: {
        widths: [110, "*", 50, 90],
        body: [
          partyRow("Заказчик", buyer),
          partyRow("Исполнитель", company),
          [
            { text: "Договор (контракт)", color: COLORS.muted, border: [false, false, false, false] },
            { text: buyer.contract || "Без договора", border: [false, false, false, true] },
            { text: "", border: [false, false, false, false] },
            { text: "", border: [false, false, false, false] },
          ],
        ],
      },
      layout: { ...gridLayout, paddingTop: () => 3, paddingBottom: () => 3 },
      margin: [0, 0, 0, 6],
    },
    {
      columns: [
        { width: 180, text: "" },
        { width: "*", text: "АКТ ВЫПОЛНЕННЫХ РАБОТ (ОКАЗАННЫХ УСЛУГ)", style: "title", fontSize: 14, alignment: "center", margin: [0, 10, 0, 0] },
        {
          width: 180,
          table: {
            widths: ["*", "*"],
            body: [
              [{ text: "Номер документа", style: "gridTh" }, { text: "Дата составления", style: "gridTh" }],
              [{ text: snapshot.number, alignment: "center", bold: true }, { text: dateShort(snapshot.date), alignment: "center", bold: true }],
            ],
          },
          layout: gridLayout,
        },
      ],
      margin: [0, 0, 0, 8],
    },
  ];
}

function worksTable(snapshot) {
  const cur = snapshot.currency;
  const t = snapshot.totals;
  const gth = (text) => ({ text, style: "gridTh" });
  const head1 = [
    { ...gth("Номер по порядку"), rowSpan: 2 },
    { ...gth("Наименование работ (услуг) (в разрезе их подвидов в соответствии с технической спецификацией, заданием, графиком выполнения работ (услуг) при их наличии)"), rowSpan: 2 },
    { ...gth("Дата выполнения работ (оказания услуг)"), rowSpan: 2 },
    { ...gth("Сведения об отчёте о научных исследованиях, маркетинговых, консультационных и прочих услугах (дата, номер, количество страниц) (при их наличии)"), rowSpan: 2 },
    { ...gth("Единица измерения"), rowSpan: 2 },
    { ...gth("Выполнено работ (оказано услуг)"), colSpan: 3 },
    {},
    {},
  ];
  const head2 = [{}, {}, {}, {}, {}, gth("количество"), gth("цена за единицу"), gth("стоимость")];
  const numbers = ["1", "2", "3", "4", "5", "6", "7", "8"].map((n) => ({ text: n, style: "small", alignment: "center" }));

  const body = [head1, head2, numbers];
  const workDate = dateShort(snapshot.date);
  let n = 0;
  snapshot.lines.forEach((line) => {
    n += 1;
    body.push([
      { text: String(n), alignment: "center" },
      { text: line.title + (line.discount ? "\nскидка −" + money(line.discount, cur) : "") },
      { text: workDate, alignment: "center" },
      { text: "", alignment: "center" },
      { text: line.unit, alignment: "center" },
      { text: formatQty(line.qty), alignment: "right" },
      { text: money(line.price, cur), alignment: "right", noWrap: true },
      { text: money(line.amount, cur), alignment: "right", noWrap: true },
    ]);
  });
  if (t.delivery) {
    n += 1;
    body.push([
      { text: String(n), alignment: "center" },
      { text: "Доставка" },
      { text: workDate, alignment: "center" },
      { text: "" },
      { text: "усл.", alignment: "center" },
      { text: "1", alignment: "right" },
      { text: money(t.delivery, cur), alignment: "right", noWrap: true },
      { text: money(t.delivery, cur), alignment: "right", noWrap: true },
    ]);
  }
  if (t.orderDiscount) {
    body.push([
      { text: "" },
      { text: "Скидка на заказ" },
      { text: "" },
      { text: "" },
      { text: "" },
      { text: "" },
      { text: "" },
      { text: "−" + money(t.orderDiscount, cur), alignment: "right", noWrap: true },
    ]);
  }
  const totalQty = snapshot.lines.reduce((sum, line) => sum + line.qty, 0) + (t.delivery ? 1 : 0);
  body.push([
    { text: "Итого", bold: true, colSpan: 5, alignment: "right" },
    {},
    {},
    {},
    {},
    { text: formatQty(totalQty), bold: true, alignment: "right" },
    { text: "x", alignment: "center" },
    { text: money(t.total, cur), bold: true, alignment: "right", noWrap: true },
  ]);

  return {
    table: {
      headerRows: 3,
      widths: [36, "*", 66, 120, 54, 54, 82, 90],
      // pdfmake не растягивает строки под ячейки с rowSpan — высоту двух строк шапки задаём сами.
      heights: (row) => (row === 0 ? 22 : row === 1 ? 30 : "auto"),
      body,
      dontBreakRows: true,
    },
    layout: gridLayout,
    fontSize: 8.5,
    margin: [0, 0, 0, 6],
  };
}

function stampCell(stamp) {
  return stamp
    ? { width: 64, image: stamp, fit: [64, 64] }
    : { width: 40, text: "М.П.", style: "meta", margin: [0, 22, 0, 0] };
}

function actDoc(data) {
  const snapshot = data;
  const company = snapshot.company || {};
  const t = snapshot.totals;
  const title = "Акт выполненных работ № " + snapshot.number + " от " + dateShort(snapshot.date);
  const vatLine =
    t.vatRate > 0
      ? "В том числе НДС " + String(t.vatRate).replace(".", ",") + "%: " + money(t.vat, snapshot.currency)
      : "Без НДС";
  const content = [
    ...headerBlock(snapshot),
    worksTable(snapshot),
    { text: [{ text: "Сумма прописью: ", color: COLORS.muted }, { text: snapshot.amountInWords, bold: true }, "   ", { text: vatLine }], margin: [0, 0, 0, 6] },
    { text: "Сведения об использовании запасов, полученных от заказчика: —", style: "meta", margin: [0, 0, 0, 2] },
    {
      text:
        "Приложение: Перечень документации, в том числе отчёт(ы) о маркетинговых, научных исследованиях, " +
        "консультационных и прочих услугах (обязательны при его (их) наличии) на ____ страниц",
      style: "meta",
      margin: [0, 0, 0, 10],
    },
    {
      unbreakable: true,
      columns: [
        {
          width: "*",
          columns: [
            {
              width: "*",
              stack: [
                signatureLine({
                  title: "Сдал (Исполнитель)",
                  position: company.directorPosition || "Исполнитель",
                  name: company.director,
                  image: data.signature,
                }),
              ],
            },
            stampCell(data.stamp),
          ],
          columnGap: 8,
        },
        {
          width: "*",
          stack: [
            {
              columns: [
                { width: "*", stack: [signatureLine({ title: "Принял (Заказчик)", position: "", name: "", image: null })] },
                stampCell(null),
              ],
              columnGap: 8,
            },
            { text: "Дата подписания (принятия) работ (услуг) «____» ______________ 20___ г.", style: "meta", margin: [0, 6, 0, 0] },
          ],
        },
      ],
      columnGap: 30,
    },
  ];
  return baseDoc({
    title,
    content,
    landscape: true,
    footerLeft: "Акт № " + snapshot.number,
    margins: [36, 30, 36, 40],
    watermark: data.annulled ? "АННУЛИРОВАН" : undefined,
  });
}

module.exports = { actDoc };
