import { describe, expect, it } from 'vitest';
import { moneyHeadline } from '../../src/shared/register-text';

const base = { days: 90, totals: [] as string[], contracts: 0, unvalued: 0, valuesAwaiting: 0 };

describe('moneyHeadline', () => {
  it('says nothing renews when no contract is in the window', () => {
    expect(moneyHeadline(base)).toEqual({ heading: 'Nothing', text: 'No contract renews by itself with a notice deadline in the next 90 days.' });
  });

  it('puts the total in the heading and the contracts in the sentence', () => {
    expect(moneyHeadline({ ...base, totals: ['£84,000.00 a year'], contracts: 2 })).toEqual({
      heading: '£84,000.00 a year',
      text: 'renews by itself unless notice is given in the next 90 days, across 2 contracts.',
    });
  });

  it('says which contracts are left out of a total', () => {
    expect(moneyHeadline({ ...base, totals: ['£84,000.00 a year', '$12,000.00 a year'], contracts: 3, unvalued: 1 })).toEqual({
      heading: '£84,000.00 a year and $12,000.00 a year',
      text: 'renews by itself unless notice is given in the next 90 days, across 3 contracts. 1 of them has no confirmed value and is not in the total.',
    });
  });

  it('starts the sentence with the contracts when no value is confirmed', () => {
    expect(moneyHeadline({ ...base, contracts: 4, unvalued: 4 })).toEqual({
      heading: 'Value not confirmed',
      text: '4 contracts renew by themselves unless notice is given in the next 90 days. None has a confirmed value yet, so there is no total.',
    });
  });

  it('uses the singular for one unvalued contract', () => {
    expect(moneyHeadline({ ...base, contracts: 1, unvalued: 1 })).toEqual({
      heading: 'Value not confirmed',
      text: '1 contract renews by itself unless notice is given in the next 90 days. It has no confirmed value yet, so there is no total.',
    });
  });
});
