/**
 * Money, read by code. The model copies an amount as text from inside a
 * verified quote ("EUR 120,000"); this file parses it, and anything it cannot
 * read with certainty goes to review. Amounts are whole minor units (cents),
 * so sums are exact. Code does every sum: the model never totals money.
 */

export interface Money {
  /** Whole minor units: cents, pence. */
  minor: number;
  /** ISO 4217 code. */
  currency: string;
}

export type MoneyProblem = 'no_currency' | 'several_currencies' | 'no_amount' | 'several_amounts' | 'ambiguous_separator' | 'scale_word' | 'too_large';

export type MoneyParse = { ok: true; value: Money } | { ok: false; reason: MoneyProblem };

const CODES = ['EUR', 'USD', 'GBP', 'INR', 'AUD', 'CAD', 'CHF', 'JPY', 'SEK', 'NOK', 'DKK', 'NZD', 'SGD', 'ZAR', 'AED', 'PLN', 'BRL', 'MXN', 'HKD', 'CNY'];
// Longest first, so "US$" is not read as "$".
const SYMBOLS: Array<[RegExp, string]> = [
  [/US\$/g, 'USD'],
  [/A\$/g, 'AUD'],
  [/C\$/g, 'CAD'],
  [/€/g, 'EUR'],
  [/£/g, 'GBP'],
  [/₹/g, 'INR'],
  [/\$/g, 'USD'],
];
const WORDS: Array<[RegExp, string]> = [
  [/\beuros?\b/gi, 'EUR'],
  [/\b(?:US|U\.S\.) dollars?\b/gi, 'USD'],
  [/\bpounds sterling\b/gi, 'GBP'],
  [/\brupees?\b/gi, 'INR'],
];
const SCALE = /\b(?:thousand|million|billion|lakh|crore|mn|bn|k)\b/i;
const NUMBER = /\d[\d.,'   ]*\d|\d/g;

function currenciesIn(text: string): string[] {
  const found = new Set<string>();
  let rest = text;
  for (const [pattern, code] of SYMBOLS) {
    if (pattern.test(rest)) found.add(code);
    rest = rest.replace(pattern, ' ');
  }
  for (const code of CODES) if (new RegExp(`\\b${code}\\b`).test(rest)) found.add(code);
  for (const [pattern, code] of WORDS) if (pattern.test(rest)) found.add(code);
  return [...found];
}

/** Digits with separators to minor units, or the reason it cannot be read with certainty. */
function numberToMinor(raw: string): number | 'ambiguous_separator' | 'too_large' {
  const s = raw.replace(/[\s  ']/g, '');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let whole = s;
  let fraction = '';
  if (lastDot !== -1 && lastComma !== -1) {
    // Both kinds: the later one is the decimal mark.
    const at = Math.max(lastDot, lastComma);
    whole = s.slice(0, at);
    fraction = s.slice(at + 1);
  } else if (lastDot !== -1 || lastComma !== -1) {
    const mark = lastDot !== -1 ? '.' : ',';
    const parts = s.split(mark);
    const tail = parts[parts.length - 1] ?? '';
    if (parts.length === 2 && tail.length <= 2) {
      whole = parts[0] ?? '';
      fraction = tail;
    } else if (mark === '.' && parts.length === 2 && tail.length === 3) {
      // "1.250": one thousand two hundred and fifty, or one and a quarter. Do not guess.
      return 'ambiguous_separator';
    } else if (parts.slice(1).every((p) => p.length === 3 || p.length === 2)) {
      // Thousands groups, including the Indian 2,50,000 style.
      whole = parts.join('');
    } else {
      return 'ambiguous_separator';
    }
  }
  whole = whole.replace(/[.,]/g, '');
  if (!/^\d+$/.test(whole) || !/^\d{0,2}$/.test(fraction)) return 'ambiguous_separator';
  if (whole.length > 13) return 'too_large';
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0') || '0');
}

export function parseMoney(text: string): MoneyParse {
  const currencies = currenciesIn(text);
  if (currencies.length === 0) return { ok: false, reason: 'no_currency' };
  if (currencies.length > 1) return { ok: false, reason: 'several_currencies' };
  // Bracketed restatements such as "forty-eight thousand euros (EUR 48,000)" give one figure; a scale word beside the figure does not.
  const numbers = text.match(NUMBER) ?? [];
  if (numbers.length === 0) return { ok: false, reason: 'no_amount' };
  const values = new Set<number>();
  for (const n of numbers) {
    const minor = numberToMinor(n.trim());
    if (typeof minor !== 'number') return { ok: false, reason: minor };
    values.add(minor);
  }
  if (values.size > 1) return { ok: false, reason: 'several_amounts' };
  const afterFigure = text.slice(text.search(/\d/)).replace(NUMBER, ' ');
  if (SCALE.test(afterFigure)) return { ok: false, reason: 'scale_word' };
  const [minor] = [...values];
  return { ok: true, value: { minor: minor as number, currency: currencies[0] as string } };
}

export type ValuePeriod = 'month' | 'quarter' | 'year' | 'term' | 'one_time';

/** A periodic amount as a yearly one. One-off and whole-term amounts have no yearly figure. */
export function yearlyMinor(minor: number, period: ValuePeriod): number | null {
  if (period === 'month') return minor * 12;
  if (period === 'quarter') return minor * 4;
  if (period === 'year') return minor;
  return null;
}

export interface CurrencyTotal {
  currency: string;
  minor: number;
  count: number;
}

/** Totals per currency, largest first. Currencies are never added together. */
export function totalByCurrency(items: readonly Money[]): CurrencyTotal[] {
  const totals = new Map<string, CurrencyTotal>();
  for (const m of items) {
    const t = totals.get(m.currency) ?? { currency: m.currency, minor: 0, count: 0 };
    t.minor += m.minor;
    t.count += 1;
    totals.set(m.currency, t);
  }
  return [...totals.values()].sort((a, b) => b.minor - a.minor || a.currency.localeCompare(b.currency));
}

export function formatMoney(m: Money): string {
  const whole = Math.trunc(m.minor / 100);
  const cents = Math.abs(m.minor % 100);
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${m.currency} ${grouped}${cents === 0 ? '' : `.${String(cents).padStart(2, '0')}`}`;
}
