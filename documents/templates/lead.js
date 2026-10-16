/** Карточка заявки с формы «Контакты». */
const { COLORS, dash, dateTime, tableLayout, brandHeader, rule, baseDoc } = require("./common");

function leadDoc(data) {
  const lead = data.lead;
  const rows = [
    ["Дата заявки", dateTime(lead.createdAt)],
    ["Статус", lead.statusLabel],
    ["Клиент", lead.customerName],
    ["Телефон", lead.customerPhone],
    ["Направление", lead.directionTitle],
    ["Страница сайта", lead.sourcePage],
    ["Заметка менеджера", lead.note],
  ];
  rows.push(["Согласие на обработку ПД", lead.consentAt ? "Дано " + dateTime(lead.consentAt) : "Не зафиксировано"]);
  const content = [
    brandHeader(data),
    { text: "Заявка с сайта", style: "title" },
    { text: "Номер в CRM: " + lead.id, style: "meta", margin: [0, 2, 0, 0] },
    rule(),
    {
      table: {
        widths: [140, "*"],
        body: rows.map(([label, value]) => [{ text: label, color: COLORS.muted }, { text: dash(value), bold: true }]),
      },
      layout: { ...tableLayout, hLineColor: () => COLORS.line },
      margin: [0, 0, 0, 12],
    },
    { text: "Комментарий клиента", style: "h2" },
    {
      table: { widths: ["*"], body: [[{ text: dash(lead.comment), margin: [4, 4, 4, 4] }]] },
      layout: { hLineWidth: () => 0, vLineWidth: () => 0, fillColor: () => COLORS.soft },
    },
    { text: "Сформировано " + dateTime(data.generatedAt), style: "small", margin: [0, 16, 0, 0] },
  ];
  return baseDoc({ title: "Заявка с сайта — " + dash(lead.customerName), content, footerLeft: dash(data.company && data.company.name) });
}

module.exports = { leadDoc };
