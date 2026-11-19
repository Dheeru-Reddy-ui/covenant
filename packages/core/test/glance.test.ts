import { describe, expect, it } from 'vitest';
import { type GlanceInput, type GlanceObligation, contractGlance } from '../src/glance';

const obligation = (over: Partial<GlanceObligation> = {}): GlanceObligation => ({
  summary: 'Pay the monthly fee',
  decision: 'pending',
  needsReview: false,
  due: '2026-12-01',
  upcoming: true,
  notice: false,
  ...over,
});

const input = (over: Partial<GlanceInput> = {}): GlanceInput => ({
  window: { status: 'later', deadline: '2027-02-01', daysLeft: 75, decisionOpensOn: '2026-12-03' },
  decided: null,
  obligations: [],
  termsToCheck: 0,
  valueAwaiting: false,
  sendBy: null,
  ...over,
});

describe('contractGlance: the deadline line', () => {
  it('counts the days left to a notice deadline that is not due yet', () => {
    const g = contractGlance(input());
    expect(g.deadline).toEqual({ text: 'Notice deadline 2027-02-01 (75 days left)', label: 'Not due yet', tone: 'calm' });
  });

  it('marks a deadline inside the lead time as a decision due', () => {
    const g = contractGlance(input({ window: { status: 'due', deadline: '2026-12-08', daysLeft: 1, decisionOpensOn: '2026-10-09' } }));
    expect(g.deadline).toEqual({ text: 'Notice deadline 2026-12-08 (1 day left)', label: 'Decision due', tone: 'urgent' });
  });

  it('says today, and counts back once a deadline has passed', () => {
    expect(contractGlance(input({ window: { status: 'due', deadline: '2026-11-20', daysLeft: 0, decisionOpensOn: null } })).deadline.text).toBe(
      'Notice deadline 2026-11-20 (today)',
    );
    expect(contractGlance(input({ window: { status: 'passed', deadline: '2026-11-10', daysLeft: -9, decisionOpensOn: null } })).deadline).toEqual({
      text: 'Notice deadline 2026-11-10 (passed 9 days ago)',
      label: 'Passed',
      tone: 'missed',
    });
  });

  it('shows the decision instead of the window once one is recorded', () => {
    const g = contractGlance(
      input({
        window: { status: 'due', deadline: '2026-12-08', daysLeft: 19, decisionOpensOn: null },
        decided: { outcomeLabel: 'Renew', followUp: 'none', next: 'Nothing more to do.' },
      }),
    );
    expect(g.deadline).toEqual({ text: 'Notice deadline 2026-12-08 (19 days left)', label: 'Decided: Renew', tone: 'settled' });
  });

  it('says plainly when there is no notice deadline, or no date for it yet', () => {
    expect(contractGlance(input({ window: { status: 'no_notice_rule', deadline: null, daysLeft: null, decisionOpensOn: null } })).deadline).toEqual({
      text: 'No renewal notice deadline in this contract',
      label: null,
      tone: 'none',
    });
    expect(contractGlance(input({ window: { status: 'undated', deadline: null, daysLeft: null, decisionOpensOn: null } })).deadline).toEqual({
      text: 'The notice deadline has no date yet',
      label: 'No date yet',
      tone: 'urgent',
    });
  });
});

describe('contractGlance: the one next step', () => {
  const due = { status: 'due' as const, deadline: '2026-12-08', daysLeft: 19, decisionOpensOn: '2026-10-09' };

  it('puts a renewal decision that is due first, ahead of obligations still waiting', () => {
    const g = contractGlance(input({ window: due, obligations: [obligation()] }));
    expect(g.next).toMatchObject({ section: 'decision', title: 'Decide by 2026-12-08: renew, renegotiate or terminate', action: 'Open the renewal decision', tone: 'urgent' });
    expect(g.next.detail).toMatch(/^19 days left\./);
  });

  it('asks for the notice to be sent when the decision needs one, with the earliest send-by date', () => {
    const g = contractGlance(
      input({ window: due, decided: { outcomeLabel: 'Terminate', followUp: 'send_notice', next: 'Notice must reach the supplier by 2026-12-08.' }, sendBy: '2026-12-03' }),
    );
    expect(g.next).toEqual({
      section: 'decision',
      title: 'Send the notice by 2026-12-03',
      detail: 'Notice must reach the supplier by 2026-12-08.',
      action: 'Open the renewal decision',
      tone: 'urgent',
    });
  });

  it('falls back to the deadline when no send-by date is known', () => {
    const g = contractGlance(input({ window: due, decided: { outcomeLabel: 'Terminate', followUp: 'send_notice', next: 'x' } }));
    expect(g.next.title).toBe('Send the notice by 2026-12-08');
  });

  it('says when notice was needed but the deadline has passed', () => {
    const g = contractGlance(
      input({
        window: { status: 'passed', deadline: '2026-11-10', daysLeft: -9, decisionOpensOn: null },
        decided: { outcomeLabel: 'Terminate', followUp: 'too_late', next: 'The contract renews unless the supplier agrees otherwise.' },
      }),
    );
    expect(g.next).toMatchObject({ section: 'decision', title: 'Notice was needed, but the deadline has passed', tone: 'urgent' });
    expect(g.next.detail).toBe('The contract renews unless the supplier agrees otherwise.');
  });

  it('keeps a binding deadline in front of a renegotiation still under way', () => {
    const g = contractGlance(input({ window: due, decided: { outcomeLabel: 'Renegotiate', followUp: 'watch_deadline', next: 'If talks fail, notice is still due.' } }));
    expect(g.next).toMatchObject({ section: 'decision', title: 'Talks are open: the notice deadline 2026-12-08 still binds', tone: 'urgent' });
  });

  it('flags a deadline that passed with no decision recorded', () => {
    const g = contractGlance(input({ window: { status: 'passed', deadline: '2026-11-10', daysLeft: -9, decisionOpensOn: null } }));
    expect(g.next).toMatchObject({ section: 'decision', title: 'The notice deadline passed on 2026-11-10', tone: 'urgent' });
  });

  it('asks for contract terms to be checked before obligations, since every date depends on them', () => {
    const g = contractGlance(input({ termsToCheck: 2, obligations: [obligation()] }));
    expect(g.next).toMatchObject({ section: 'terms', title: 'Check 2 contract terms', action: 'Show the contract terms', tone: 'calm' });
    expect(contractGlance(input({ termsToCheck: 1 })).next.title).toBe('Check 1 contract term');
  });

  it('asks for the obligations to be reviewed, and says how many need a closer look', () => {
    const g = contractGlance(input({ obligations: [obligation(), obligation({ decision: 'edited', needsReview: true }), obligation({ decision: 'approved' })] }));
    expect(g.next).toMatchObject({ section: 'obligations', title: 'Review 2 obligations', action: 'Show the obligations', tone: 'calm' });
    expect(g.next.detail).toMatch(/^1 of them needs a closer look\./);
    expect(contractGlance(input({ obligations: [obligation()] })).next.title).toBe('Review 1 obligation');
  });

  it('asks for the contract value once everything else is reviewed', () => {
    const g = contractGlance(input({ obligations: [obligation({ decision: 'approved' })], valueAwaiting: true }));
    expect(g.next).toMatchObject({ section: 'details', title: 'Confirm the contract value', action: 'Show notices and value', tone: 'calm' });
  });

  it('says nothing needs a person when all is done, and when the decision opens', () => {
    const g = contractGlance(input({ obligations: [obligation({ decision: 'approved' })] }));
    expect(g.next).toEqual({
      section: null,
      title: 'Nothing needs you right now',
      detail: 'The renewal decision opens on 2026-12-03. Next date is 2026-12-01: Pay the monthly fee.',
      action: null,
      tone: 'done',
    });
  });

  it('never sends a person to a decision that is settled', () => {
    const g = contractGlance(input({ window: due, decided: { outcomeLabel: 'Renew', followUp: 'none', next: 'Nothing more to do.' } }));
    expect(g.next.section).toBeNull();
  });
});

describe('contractGlance: counts and the next date', () => {
  it('counts approving as approved and edited as waiting', () => {
    const g = contractGlance(
      input({
        obligations: [
          obligation({ decision: 'approved' }),
          obligation({ decision: 'approving' }),
          obligation({ decision: 'edited', needsReview: true }),
          obligation({ decision: 'pending' }),
          obligation({ decision: 'rejected' }),
        ],
      }),
    );
    expect(g.counts).toEqual({ approved: 2, waiting: 2, rejected: 1, needsReview: 1 });
  });

  it('finds the earliest upcoming date, leaving out rejected and past obligations', () => {
    const g = contractGlance(
      input({
        obligations: [
          obligation({ summary: 'Rejected one', decision: 'rejected', due: '2026-11-25' }),
          obligation({ summary: 'Already past', due: '2026-11-01', upcoming: false }),
          obligation({ summary: 'Undated', due: null }),
          obligation({ summary: 'Later', due: '2027-01-15' }),
          obligation({ summary: 'Soonest', due: '2026-12-01', decision: 'approved' }),
        ],
      }),
    );
    expect(g.nextDate).toEqual({ summary: 'Soonest', due: '2026-12-01' });
    expect(contractGlance(input()).nextDate).toBeNull();
  });

  it('leaves the renewal notice out of the next date, since the deadline line already shows it', () => {
    const g = contractGlance(
      input({
        obligations: [
          obligation({ summary: 'Give written notice of non-renewal to the other party.', due: '2026-11-30', notice: true, decision: 'approved' }),
          obligation({ summary: 'Deliver the quarterly report.', due: '2027-01-15', decision: 'approved' }),
        ],
      }),
    );
    expect(g.nextDate).toEqual({ summary: 'Deliver the quarterly report.', due: '2027-01-15' });
    // The summary's own full stop is not doubled.
    expect(g.next.detail).toBe('The renewal decision opens on 2026-12-03. Next date is 2027-01-15: Deliver the quarterly report.');
  });
});
