/**
 * Деньги в документах: все расчёты в целых минимальных единицах (тиын, копейка, цент),
 * чтобы не копить ошибки округления дробных чисел.
 */

const CURRENCIES = {
  KZT: { symbol: "₸", major: ["тенге", "тенге", "тенге"], majorFemale: false, minor: ["тиын", "тиына", "тиын"], minorFemale: false },
  RUB: { symbol: "₽", major: ["рубль", "рубля", "рублей"], majorFemale: false, minor: ["копейка", "копейки", "копеек"], minorFemale: true },
  USD: { symbol: "$", major: ["доллар США", "доллара США", "долларов США"], majorFemale: false, minor: ["цент", "цента", "центов"], minorFemale: false },
};

const toMinor = (value) => Math.round((Number(value) || 0) * 100);

/** 1 234 567,89 — пробелы в разрядах неразрывные, чтобы сумма не переносилась. */
function formatMoney(minor) {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(Math.round(minor));
  const major = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  return sign + major + "," + String(abs % 100).padStart(2, "0");
}

function formatQty(qty) {
  return String(qty).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
}

function currencySymbol(currency) {
  return (CURRENCIES[currency] || CURRENCIES.KZT).symbol;
}

/**
 * Итоги заказа отдельно по каждой валюте позиций.
 * Скидка на заказ и доставка относятся к валюте order.adjustCurrency; скидка не больше суммы позиций.
 * НДС (order.vatRate, %) уже включён в цены — выделяется из итога.
 * @returns {Array<{ currency: string, lines: object[], subtotal: number, itemsDiscount: number,
 *   orderDiscount: number, delivery: number, total: number, vatRate: number, vat: number }>}
 */
function orderTotals(order) {
  const buckets = new Map();
  const bucket = (currency) => {
    if (!buckets.has(currency)) buckets.set(currency, { currency, lines: [] });
    return buckets.get(currency);
  };
  (Array.isArray(order.items) ? order.items : []).forEach((item, position) => {
    const qty = Math.max(1, Math.floor(Number(item.qty) || 1));
    const price = Math.max(0, toMinor(item.price));
    const gross = price * qty;
    const discount = Math.min(gross, Math.max(0, toMinor(item.discount)));
    bucket(String(item.currency || "KZT")).lines.push({
      position,
      productId: String(item.id || ""),
      title: String(item.title || "Позиция"),
      kind: item.kind === "product" ? "product" : "service",
      unit: item.kind === "product" ? "шт." : "усл.",
      qty,
      price,
      gross,
      discount,
      amount: gross - discount,
    });
  });

  const adjustCurrency = String(order.adjustCurrency || "KZT");
  const orderDiscountRaw = Math.max(0, toMinor(order.discount));
  const deliveryRaw = Math.max(0, toMinor(order.delivery));
  if ((orderDiscountRaw || deliveryRaw) && !buckets.size) bucket(adjustCurrency);
  const vatRate = Math.min(99.99, Math.max(0, Number(order.vatRate) || 0));

  return Array.from(buckets.values(), (b) => {
    const subtotal = b.lines.reduce((sum, line) => sum + line.gross, 0);
    const itemsDiscount = b.lines.reduce((sum, line) => sum + line.discount, 0);
    const net = subtotal - itemsDiscount;
    const own = b.currency === adjustCurrency;
    const orderDiscount = own ? Math.min(net, orderDiscountRaw) : 0;
    const delivery = own ? deliveryRaw : 0;
    const total = net - orderDiscount + delivery;
    const vat = vatRate > 0 ? Math.round((total * vatRate) / (100 + vatRate)) : 0;
    return { currency: b.currency, lines: b.lines, subtotal, itemsDiscount, orderDiscount, delivery, total, vatRate, vat };
  });
}

const NBSP = "\u00a0";

/** «150 000 ₸», «$1 200,5» — как цены на сайте; minor — в минимальных единицах. */
function formatPriceMinor(minor, currency) {
  const amount = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 })
    .format((Math.round(Number(minor) || 0)) / 100)
    .replace(/\s/g, NBSP);
  const symbol = currencySymbol(currency);
  return currency === "USD" ? symbol + amount : amount + NBSP + symbol;
}

/**
 * Итоги для карточки заказа и API: по валютам, в обычных единицах (не в тиынах).
 * @returns {Array<{ currency: string, subtotal: number, itemsDiscount: number, orderDiscount: number,
 *   delivery: number, total: number, vatRate: number, vat: number }>}
 */
function orderTotalsSummary(order) {
  return orderTotals(order).map((b) => ({
    currency: b.currency,
    subtotal: b.subtotal / 100,
    itemsDiscount: b.itemsDiscount / 100,
    orderDiscount: b.orderDiscount / 100,
    delivery: b.delivery / 100,
    total: b.total / 100,
    vatRate: b.vatRate,
    vat: b.vat / 100,
  }));
}

/** Итог заказа строкой с учётом скидок и доставки: «150 000 ₸ + $100». */
function orderTotalText(order) {
  const buckets = orderTotals(order);
  if (!buckets.length) return formatPriceMinor(0, "KZT");
  return buckets.map((b) => formatPriceMinor(b.total, b.currency)).join(" + ");
}

/* ---------- сумма прописью ---------- */

const ONES = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const ONES_FEMALE = ["", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const TEENS = [
  "десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать",
  "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать",
];
const TENS = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"];
const HUNDREDS = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот"];
const SCALES = [
  null,
  { forms: ["тысяча", "тысячи", "тысяч"], female: true },
  { forms: ["миллион", "миллиона", "миллионов"], female: false },
  { forms: ["миллиард", "миллиарда", "миллиардов"], female: false },
  { forms: ["триллион", "триллиона", "триллионов"], female: false },
];

/** Форма слова для числа: 1 рубль, 2 рубля, 5 рублей, 11 рублей, 21 рубль. */
function plural(n, forms) {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return forms[2];
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
}

function triadWords(n, female) {
  const words = [HUNDREDS[Math.floor(n / 100)]];
  const rest = n % 100;
  if (rest >= 10 && rest < 20) words.push(TEENS[rest - 10]);
  else words.push(TENS[Math.floor(rest / 10)], (female ? ONES_FEMALE : ONES)[rest % 10]);
  return words.filter(Boolean);
}

/** Целое число словами; female — род единиц (одна тысяча, две копейки). */
function integerWords(value, female) {
  let n = Math.floor(Math.abs(value));
  if (n === 0) return "ноль";
  const words = [];
  for (let scale = 0; n > 0; scale++) {
    const triad = n % 1000;
    n = Math.floor(n / 1000);
    if (!triad) continue;
    if (scale >= SCALES.length) throw new RangeError("Слишком большая сумма");
    const info = SCALES[scale];
    const part = triadWords(triad, info ? info.female : female);
    if (info) part.push(plural(triad, info.forms));
    words.unshift(...part);
  }
  return words.join(" ");
}

/** «Сто пятьдесят тысяч тенге 00 тиын» — как в счетах 1С. */
function amountInWords(minor, currency) {
  const info = CURRENCIES[currency] || CURRENCIES.KZT;
  const abs = Math.abs(Math.round(minor));
  const major = Math.floor(abs / 100);
  const cents = abs % 100;
  const text =
    (minor < 0 ? "минус " : "") +
    integerWords(major, info.majorFemale) + " " + plural(major, info.major) + " " +
    String(cents).padStart(2, "0") + " " + plural(cents, info.minor);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

module.exports = {
  CURRENCIES,
  toMinor,
  formatMoney,
  formatQty,
  currencySymbol,
  formatPriceMinor,
  orderTotals,
  orderTotalsSummary,
  orderTotalText,
  integerWords,
  amountInWords,
};
