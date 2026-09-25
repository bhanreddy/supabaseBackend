/**
 * Exact decimal arithmetic for payroll.
 * Values stay as reduced rational numbers (bigint numerator / denominator).
 * Currency is never stored or combined with binary floating point.
 */

function gcd(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x === 0n ? 1n : x;
}

export function rat(numerator, denominator = 1n) {
  if (denominator === 0n) {
    throw new Error('Division by zero');
  }
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

export const ZERO = rat(0n, 1n);
export const ONE = rat(1n, 1n);

export function fromDecimal(value) {
  const text = String(value).trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(text)) {
    throw new Error(`Invalid decimal amount: ${value}`);
  }
  const negative = text.startsWith('-');
  const body = text.replace(/^[+-]/, '');
  const [whole, fraction = ''] = body.split('.');
  const scale = fraction.length;
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, '') || '0';
  const numerator = BigInt(digits) * (negative ? -1n : 1n);
  const denominator = 10n ** BigInt(scale);
  return rat(numerator, denominator);
}

export function add(a, b) {
  return rat(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function sub(a, b) {
  return add(a, rat(-b.n, b.d));
}

export function mul(a, b) {
  return rat(a.n * b.n, a.d * b.d);
}

export function div(a, b) {
  if (b.n === 0n) throw new Error('Division by zero');
  return rat(a.n * b.d, a.d * b.n);
}

export function compare(a, b) {
  const left = a.n * b.d;
  const right = b.n * a.d;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function eq(a, b) {
  return compare(a, b) === 0;
}

export function isZero(value) {
  return value.n === 0n;
}

export function isNegative(value) {
  return value.n < 0n;
}

export function isPositive(value) {
  return value.n > 0n;
}

export function minRat(a, b) {
  return compare(a, b) <= 0 ? a : b;
}

export function maxRat(a, b) {
  return compare(a, b) >= 0 ? a : b;
}

/** Round half away from zero to a fixed number of decimal places. */
export function roundHalfUp(value, places) {
  const scale = 10n ** BigInt(places);
  const numerator = value.n * scale;
  const denominator = value.d;
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  const rounded = quotient + (remainder * 2n >= denominator ? 1n : 0n);
  return rat(negative ? -rounded : rounded, scale);
}

export function toDecimal(value, places) {
  const rounded = roundHalfUp(value, places);
  const scale = 10n ** BigInt(places);
  const minor = (rounded.n * scale) / rounded.d;
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

function groupIndian(whole) {
  if (whole.length <= 3) return whole;
  const last3 = whole.slice(-3);
  let rest = whole.slice(0, -3);
  const parts = [];
  while (rest.length > 2) {
    parts.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) parts.unshift(rest);
  return `${parts.join(',')},${last3}`;
}

export function formatInr(decimal) {
  const negative = String(decimal).startsWith('-');
  const [whole, fraction = '00'] = String(decimal).replace('-', '').split('.');
  const frac = fraction.padEnd(2, '0').slice(0, 2);
  return `${negative ? '-' : ''}₹${groupIndian(whole)}.${frac}`;
}

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function wordsBelow1000(value) {
  const amount = Number(value);
  if (!Number.isInteger(amount) || amount < 0 || amount > 999) {
    throw new Error('Amount chunk is out of range');
  }
  if (amount === 0) return '';
  const hundreds = Math.floor(amount / 100);
  const rest = amount % 100;
  const parts = [];
  if (hundreds) parts.push(`${ONES[hundreds]} Hundred`);
  if (rest >= 20) {
    const ones = rest % 10;
    parts.push(ones ? `${TENS[Math.floor(rest / 10)]} ${ONES[ones]}` : TENS[Math.floor(rest / 10)]);
  } else if (rest) {
    parts.push(ONES[rest]);
  }
  return parts.join(' ');
}

function integerWords(value) {
  if (value < 0n) throw new Error('Negative integer words are not supported');
  if (value === 0n) return 'Zero';
  const scales = [
    [10000000n, 'Crore'],
    [100000n, 'Lakh'],
    [1000n, 'Thousand'],
  ];
  let rest = value;
  const parts = [];
  for (const [divisor, label] of scales) {
    const quotient = rest / divisor;
    if (quotient > 0n) {
      parts.push(`${integerWords(quotient)} ${label}`);
      rest %= divisor;
    }
  }
  if (rest > 0n) parts.push(wordsBelow1000(rest));
  return parts.join(' ');
}

/** Indian English amount in words for a 2-decimal currency string. */
export function amountInWords(decimal) {
  const text = toDecimal(fromDecimal(decimal), 2);
  const negative = text.startsWith('-');
  const [whole, fraction] = text.replace('-', '').split('.');
  const rupees = BigInt(whole);
  const paise = Number(fraction);
  const rupeeWords = rupees === 0n ? null : `${integerWords(rupees)} Rupee${rupees === 1n ? '' : 's'}`;
  const paiseWords = paise === 0 ? null : `${wordsBelow1000(BigInt(paise))} Paise`;
  const body = [rupeeWords, paiseWords].filter(Boolean).join(' and ') || 'Zero Rupees';
  return `${negative ? 'Minus ' : ''}${body} Only`;
}
