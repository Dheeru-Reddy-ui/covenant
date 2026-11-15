import { describe, expect, it } from 'vitest';
import { formatMoney, parseMoney, totalByCurrency, yearlyMinor } from '../src/money';

const ok = (text: string) => {
  const r = parseMoney(text);
  if (!r.ok) throw new Error(`${text}: ${r.reason}`);
  return r.value;
};

describe('parseMoney', () => {
  it('reads an amount with a currency code or symbol, in minor units', () => {
    expect(ok('EUR 120,000')).toEqual({ minor: 12_000_000, currency: 'EUR' });
    expect(ok('€120,000.50')).toEqual({ minor: 12_000_050, currency: 'EUR' });
    expect(ok('$48,000')).toEqual({ minor: 4_800_000, currency: 'USD' });
    expect(ok('US$ 1,250.75')).toEqual({ minor: 125_075, currency: 'USD' });
    expect(ok('£9,500 per month')).toEqual({ minor: 950_000, currency: 'GBP' });
    expect(ok('12 500 EUR')).toEqual({ minor: 1_250_000, currency: 'EUR' });
    expect(ok('INR 2,50,000')).toEqual({ minor: 25_000_000, currency: 'INR' });
    expect(ok('1.250.000,00 EUR')).toEqual({ minor: 125_000_000, currency: 'EUR' });
    expect(ok('forty-eight thousand euros (EUR 48,000)')).toEqual({ minor: 4_800_000, currency: 'EUR' });
  });

  it('refuses rather than guesses', () => {
    expect(parseMoney('120,000')).toEqual({ ok: false, reason: 'no_currency' });
    expect(parseMoney('EUR')).toEqual({ ok: false, reason: 'no_amount' });
    expect(parseMoney('forty-eight thousand euros')).toEqual({ ok: false, reason: 'no_amount' });
    // A lone dot before three digits could be thousands or a decimal.
    expect(parseMoney('EUR 1.250')).toEqual({ ok: false, reason: 'ambiguous_separator' });
    expect(parseMoney('EUR 100 or USD 110')).toEqual({ ok: false, reason: 'several_currencies' });
    expect(parseMoney('EUR 100 plus 20')).toEqual({ ok: false, reason: 'several_amounts' });
    expect(parseMoney('EUR 2 million')).toEqual({ ok: false, reason: 'scale_word' });
  });
});

describe('yearlyMinor', () => {
  it('scales a periodic amount to a year, and leaves one-off amounts alone', () => {
    expect(yearlyMinor(1_000_000, 'month')).toBe(12_000_000);
    expect(yearlyMinor(1_000_000, 'quarter')).toBe(4_000_000);
    expect(yearlyMinor(1_000_000, 'year')).toBe(1_000_000);
    expect(yearlyMinor(1_000_000, 'one_time')).toBeNull();
    expect(yearlyMinor(1_000_000, 'term')).toBeNull();
  });
});

describe('totalByCurrency', () => {
  it('adds within a currency and never across currencies', () => {
    expect(
      totalByCurrency([
        { minor: 12_000_000, currency: 'EUR' },
        { minor: 4_800_000, currency: 'USD' },
        { minor: 50, currency: 'EUR' },
      ]),
    ).toEqual([
      { currency: 'EUR', minor: 12_000_050, count: 2 },
      { currency: 'USD', minor: 4_800_000, count: 1 },
    ]);
    expect(totalByCurrency([])).toEqual([]);
  });
});

describe('formatMoney', () => {
  it('writes the code and grouped digits, with cents only when there are some', () => {
    expect(formatMoney({ minor: 12_000_000, currency: 'EUR' })).toBe('EUR 120,000');
    expect(formatMoney({ minor: 125_075, currency: 'USD' })).toBe('USD 1,250.75');
    expect(formatMoney({ minor: 5, currency: 'GBP' })).toBe('GBP 0.05');
  });
});
