import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { problemDigest, summariseProblems, tidyArguments } from '../src/arguments';
import { ContractReadingSchema } from '../src/reading';
import { ObligationRuleSchema } from '../src/schema';
import { noticeRule, reading } from './fixtures';

const Item = z.strictObject({
  name: z.string(),
  note: z.string().nullable(),
  size: z.strictObject({ count: z.int(), unit: z.string() }).nullable(),
  tags: z.array(z.string()),
});
const Envelope = z.strictObject({ item: Item.nullable(), items: z.array(Item) });

const withoutKeys = (value: Record<string, unknown>, ...keys: string[]) => Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k)));

describe('tidyArguments: empty fields the model left out', () => {
  it('fills a missing field that may be null with null, and says where', () => {
    const out = tidyArguments(Item, { name: 'a', tags: [] });
    expect(out.value).toEqual({ name: 'a', note: null, size: null, tags: [] });
    expect(out.filledNulls).toEqual(['note', 'size']);
    expect(out.unwrapped).toEqual([]);
  });

  it('leaves a missing required field missing, so the check still rejects it', () => {
    const out = tidyArguments(Item, { note: null, size: null, tags: [] });
    expect(out.value).toEqual({ note: null, size: null, tags: [] });
    expect(Item.safeParse(out.value).success).toBe(false);
  });

  it('works through nullable objects and arrays', () => {
    const out = tidyArguments(Envelope, { item: { name: 'a', tags: [] }, items: [{ name: 'b', note: 'n', size: null, tags: [] }, { name: 'c', tags: [] }] });
    expect(out.filledNulls).toEqual(['item.note', 'item.size', 'items.1.note', 'items.1.size']);
    expect(Envelope.safeParse(out.value).success).toBe(true);
  });

  it('keeps an unexpected key, so a strict check still rejects it', () => {
    const out = tidyArguments(Item, { name: 'a', note: null, size: null, tags: [], dueDate: '2025-04-30' });
    expect(Item.safeParse(out.value).success).toBe(false);
  });

  it('never changes the value it was given', () => {
    const given = { item: { name: 'a', tags: [] }, items: [] };
    const copy = structuredClone(given);
    tidyArguments(Envelope, given);
    expect(given).toEqual(copy);
  });
});

describe('tidyArguments: nested values sent as JSON text', () => {
  it('reads an object sent as JSON text where an object is expected', () => {
    const out = tidyArguments(Envelope, { item: JSON.stringify({ name: 'a', note: null, size: null, tags: [] }), items: [] });
    expect(out.value).toEqual({ item: { name: 'a', note: null, size: null, tags: [] }, items: [] });
    expect(out.unwrapped).toEqual(['item']);
  });

  it('reads an array sent as JSON text, then tidies its items', () => {
    const out = tidyArguments(Envelope, { item: null, items: JSON.stringify([{ name: 'a', tags: [] }]) });
    expect(out.value).toEqual({ item: null, items: [{ name: 'a', note: null, size: null, tags: [] }] });
    expect(out.unwrapped).toEqual(['items']);
    expect(out.filledNulls).toEqual(['items.0.note', 'items.0.size']);
  });

  it('reads the text "null" as null only where an object or null is expected', () => {
    const out = tidyArguments(Item, { name: 'null', note: 'null', size: 'null', tags: [] });
    expect(out.value).toEqual({ name: 'null', note: 'null', size: null, tags: [] });
    expect(out.unwrapped).toEqual(['size']);
  });

  it('never parses a field that should be text, even when it looks like JSON', () => {
    const out = tidyArguments(Item, { name: '{"a": 1}', note: '[1]', size: null, tags: [] });
    expect(out.value).toEqual({ name: '{"a": 1}', note: '[1]', size: null, tags: [] });
    expect(out.unwrapped).toEqual([]);
  });

  it('leaves text that is not JSON, or is the wrong shape, for the check to reject', () => {
    expect(tidyArguments(Envelope, { item: '{not json', items: [] }).value).toEqual({ item: '{not json', items: [] });
    expect(tidyArguments(Envelope, { item: '[1, 2]', items: '{"a": 1}' }).value).toEqual({ item: '[1, 2]', items: '{"a": 1}' });
  });
});

describe('tidyArguments on the real reading', () => {
  it('makes a reading with every null left out pass the strict check unchanged in meaning', () => {
    const full = reading();
    const sparse = {
      effectiveDate: withoutKeys(full.effectiveDate, 'event'),
      term: withoutKeys(full.term, 'endDateText'),
      renewal: full.renewal,
      obligations: full.obligations.map((o) => withoutKeys(o, 'recurrence', ...(o.anchorDescription === null ? ['anchorDescription'] : []))),
    };
    expect(ContractReadingSchema.safeParse(sparse).success).toBe(false);
    const out = tidyArguments(ContractReadingSchema, sparse);
    expect(out.value).toEqual(full);
    expect(ContractReadingSchema.safeParse(out.value).success).toBe(true);
  });

  it('cannot make up a value: a recurring anchor with its recurrence left out is still rejected', () => {
    const periodic = withoutKeys(noticeRule({ anchor: 'period_end' }), 'recurrence');
    const out = tidyArguments(ObligationRuleSchema, periodic);
    expect(ObligationRuleSchema.safeParse(out.value).success).toBe(false);
  });
});

describe('summariseProblems', () => {
  it('folds item numbers together and counts repeats, most common first', () => {
    const summary = summariseProblems([
      'obligations.0.recurrence: invalid_type expected object got undefined',
      'obligations.3.recurrence: invalid_type expected object got undefined',
      'effectiveDate.event: invalid_type expected string got undefined',
      'obligations.12.recurrence: invalid_type expected object got undefined',
    ]);
    expect(summary).toBe('obligations.N.recurrence: invalid_type expected object got undefined x3; effectiveDate.event: invalid_type expected string got undefined x1');
  });

  it('says none for an empty list', () => {
    expect(summariseProblems([])).toBe('none');
  });
});

describe('problemDigest', () => {
  it('names the field, the kind of problem and the type received, never the value', () => {
    const secret = 'Customer shall pay each invoice within thirty (30) days.';
    const input = { name: 7, note: secret, size: { count: 'two', unit: 'year' }, tags: [], extra: secret };
    const parsed = Item.safeParse(input);
    if (parsed.success) throw new Error('expected problems');
    const digest = problemDigest('item', parsed.error, input);
    expect(digest).toEqual(['item.name: invalid_type expected string got number', 'item.size.count: invalid_type expected number got string', 'item: unrecognized_keys extra']);
    expect(digest.join(' ')).not.toContain('Customer');
  });

  it('hides a key name that does not look like a field name', () => {
    const parsed = Item.safeParse({ name: 'a', note: null, size: null, tags: [], 'Customer shall pay': 1 });
    if (parsed.success) throw new Error('expected problems');
    expect(problemDigest('', parsed.error, {})).toEqual(['unrecognized_keys ?']);
  });
});
