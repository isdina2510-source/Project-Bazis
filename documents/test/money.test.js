const test = require("node:test");
const assert = require("node:assert/strict");
const { formatMoney, amountInWords, orderTotals, integerWords, orderTotalText, orderTotalsSummary } = require("../money");
const { normalizeCompany, normalizeClientRequisites } = require("../requisites");

const NBSP = "\u00a0";

test("orderTotalText: итог по валютам со скидками и доставкой, как цены на сайте", () => {
  const order = {
    items: [
      { title: "A", qty: 2, price: 50000, currency: "KZT", discount: 5000 },
      { title: "B", qty: 1, price: 99.5, currency: "USD" },
    ],
    discount: 15000,
    delivery: 2500,
    adjustCurrency: "KZT",
  };
  assert.equal(orderTotalText(order), `82${NBSP}500${NBSP}₸ + $99,5`);
  assert.equal(orderTotalText({ items: [] }), `0${NBSP}₸`);
  assert.equal(orderTotalText({ items: [], delivery: 1000, adjustCurrency: "RUB" }), `1${NBSP}000${NBSP}₽`);
  const [kzt] = orderTotalsSummary(order);
  assert.deepEqual(
    { subtotal: kzt.subtotal, itemsDiscount: kzt.itemsDiscount, orderDiscount: kzt.orderDiscount, delivery: kzt.delivery, total: kzt.total },
    { subtotal: 100000, itemsDiscount: 5000, orderDiscount: 15000, delivery: 2500, total: 82500 }
  );
});

test("formatMoney: разряды неразрывными пробелами, всегда две цифры копеек", () => {
  assert.equal(formatMoney(0), "0,00");
  assert.equal(formatMoney(5), "0,05");
  assert.equal(formatMoney(123456789), `1${NBSP}234${NBSP}567,89`);
  assert.equal(formatMoney(-150000), `-1${NBSP}500,00`);
});

test("сумма прописью: род и падежи", () => {
  assert.equal(amountInWords(5200000, "KZT"), "Пятьдесят две тысячи тенге 00 тиын");
  assert.equal(amountInWords(101, "RUB"), "Один рубль 01 копейка");
  assert.equal(amountInWords(2202, "RUB"), "Двадцать два рубля 02 копейки");
  assert.equal(amountInWords(1111, "RUB"), "Одиннадцать рублей 11 копеек");
  assert.equal(amountInWords(2100, "USD"), "Двадцать один доллар США 00 центов");
  assert.equal(amountInWords(0, "KZT"), "Ноль тенге 00 тиын");
  assert.equal(integerWords(1001000, false), "один миллион одна тысяча");
  assert.equal(integerWords(212, false), "двести двенадцать");
});

test("итоги заказа: скидки по позициям, скидка на заказ, доставка и НДС в своей валюте", () => {
  const totals = orderTotals({
    items: [
      { id: "a", title: "Услуга", qty: 1, price: 50000, currency: "KZT", kind: "service", discount: 5000 },
      { id: "b", title: "Товар", qty: 2, price: 3000.5, currency: "KZT", kind: "product" },
      { id: "c", title: "Импорт", qty: 1, price: 100, currency: "USD", kind: "product" },
    ],
    discount: 1000,
    delivery: 2000,
    adjustCurrency: "KZT",
    vatRate: 12,
  });
  assert.equal(totals.length, 2);
  const [kzt, usd] = totals;
  assert.equal(kzt.currency, "KZT");
  assert.equal(kzt.subtotal, 5600100);
  assert.equal(kzt.itemsDiscount, 500000);
  assert.equal(kzt.orderDiscount, 100000);
  assert.equal(kzt.delivery, 200000);
  assert.equal(kzt.total, 5200100);
  assert.equal(kzt.vat, Math.round((5200100 * 12) / 112));
  assert.deepEqual(kzt.lines.map((l) => l.unit), ["усл.", "шт."]);
  assert.equal(usd.total, 10000);
  assert.equal(usd.orderDiscount, 0);
  assert.equal(usd.delivery, 0);
});

test("итоги заказа: скидки не уводят сумму в минус", () => {
  const [kzt] = orderTotals({
    items: [{ id: "a", title: "A", qty: 1, price: 100, currency: "KZT", discount: 500 }],
    discount: 1000,
    adjustCurrency: "KZT",
  });
  assert.equal(kzt.lines[0].amount, 0);
  assert.equal(kzt.orderDiscount, 0);
  assert.equal(kzt.total, 0);
});

test("реквизиты компании: коды без пробелов, IBAN заглавными, ошибки формата", () => {
  const ok = normalizeCompany({ name: "  ИП  «Базис» ", bin: "880 101 300 123", iik: "kz12 3456 7890 1234 5678", bik: "caspkzka" });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.values.name, "ИП «Базис»");
  assert.equal(ok.values.bin, "880101300123");
  assert.equal(ok.values.iik, "KZ123456789012345678");
  assert.equal(ok.values.bik, "CASPKZKA");
  assert.equal(ok.values.director, "");

  const bad = normalizeCompany({ bin: "123", email: "nope", kbe: "1" });
  assert.equal(bad.errors.length, 3);
});

test("реквизиты покупателя: банковские поля только у юрлица", () => {
  const person = normalizeClientRequisites({ type: "person", legalName: "Иванов", iik: "KZ000000000000000000" });
  assert.equal(person.values.type, "person");
  assert.equal(person.values.iik, undefined);
  const company = normalizeClientRequisites({ type: "company", legalName: "ТОО «Ромашка»", kbe: "17" });
  assert.equal(company.values.type, "company");
  assert.equal(company.values.kbe, "17");
  assert.equal(normalizeClientRequisites({ type: "hacker" }).values.type, "person");
});
