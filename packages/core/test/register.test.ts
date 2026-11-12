import { describe, expect, it } from 'vitest';
import { type RegisterItem, registerRows } from '../src/register';

type Item = RegisterItem & { id: string };

const item = (id: string, over: Partial<Item> = {}): Item => ({
  id,
  kind: 'payment',
  due: '2026-11-20',
  scheduleStatus: 'upcoming',
  hasOwner: true,
  decision: 'approved',
  ...over,
});

const options = { today: '2026-11-12', windowDays: null, noticeLeadDays: 60 };
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe('registerRows', () => {
  it('sorts by due date, with undated items last', () => {
    const rows = registerRows(
      [item('c', { due: '2027-01-05' }), item('none', { due: null, scheduleStatus: 'undated' }), item('a', { due: '2026-11-13' }), item('b', { due: '2026-12-01' })],
      options,
    );
    expect(ids(rows)).toEqual(['a', 'b', 'c', 'none']);
  });

  it('keeps only what falls due within a 30, 60 or 90 day view, counting today', () => {
    const items = [
      item('today', { due: '2026-11-12' }),
      item('d30', { due: '2026-12-12' }),
      item('d31', { due: '2026-12-13' }),
      item('d90', { due: '2027-02-10' }),
      item('past', { due: '2026-11-01', scheduleStatus: 'past' }),
      item('undated', { due: null, scheduleStatus: 'undated' }),
    ];
    expect(ids(registerRows(items, { ...options, windowDays: 30 }))).toEqual(['today', 'd30']);
    expect(ids(registerRows(items, { ...options, windowDays: 90 }))).toEqual(['today', 'd30', 'd31', 'd90']);
    expect(ids(registerRows(items, options))).toEqual(['past', 'today', 'd30', 'd31', 'd90', 'undated']);
  });

  it('leaves rejected obligations off the register', () => {
    expect(ids(registerRows([item('a'), item('r', { decision: 'rejected' })], options))).toEqual(['a']);
  });

  it('counts days left and flags overdue items', () => {
    const [past, soon] = registerRows([item('soon', { due: '2026-11-15' }), item('past', { due: '2026-11-10', scheduleStatus: 'past' })], options);
    expect(past).toMatchObject({ id: 'past', daysLeft: -2, flags: { overdue: true } });
    expect(soon).toMatchObject({ id: 'soon', daysLeft: 3, flags: { overdue: false } });
  });

  it('flags items with nobody responsible', () => {
    const [row] = registerRows([item('a', { hasOwner: false })], options);
    expect(row?.flags.noOwner).toBe(true);
  });

  it('flags renewal notices whose deadline is inside the decision lead time, and only those', () => {
    const rows = registerRows(
      [
        item('notice-soon', { kind: 'renewal_notice', due: '2026-12-20' }),
        item('notice-far', { kind: 'renewal_notice', due: '2027-03-01' }),
        item('payment-soon', { kind: 'payment', due: '2026-12-20' }),
        item('notice-past', { kind: 'renewal_notice', due: '2026-11-01', scheduleStatus: 'past' }),
      ],
      options,
    );
    const flagged = rows.filter((r) => r.flags.insideNoticeWindow).map((r) => r.id);
    expect(flagged).toEqual(['notice-soon']);
  });
});
