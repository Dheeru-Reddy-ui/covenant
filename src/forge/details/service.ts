import {
  type Breach,
  type ContractValueData,
  type IsoDate,
  METHOD_LABELS,
  type Money,
  type NoticeAddressData,
  type NoticeDraftInput,
  type NoticeMethodData,
  type PartyData,
  type ServiceLevelData,
  creditAmount,
  describeSection,
  draftAdf,
  draftClaim,
  draftNotice,
  draftText,
  earliestSendBy,
  formatMoney,
  leverageSummary,
  measureServiceLevel,
  sendByDates,
  yearlyMinor,
} from '../../../packages/core/src';
import type { BreachView, DetailBase, DetailsView, NoticeDraftView, ServiceLevelView, SupplierRecordView } from '../../shared/details';
import type { BriefView, ClauseView } from '../../shared/panel';
import type { Bundle } from '../decisions/actions';
import * as repo from '../db/repo';
import { UserFacingError, loggableError, readableError } from '../errors';
import { type FoundIssue, JiraError, asUser, childIssueType, createChild, getIssue, searchIssues } from '../jira';
import type { StoredCitation } from '../pipeline/details';

/**
 * Everything built on the details pass: the notices and value shown in the
 * panel, the drafted notice and its "Send notice by" work item, and the
 * supplier's record against the contract's own service levels. Work items are
 * created only on a person's click, as that person.
 */

export const OUR_PARTY = 'our_party';
export const SUPPLIER_JQL = 'supplier_jql';
const noticeItemSetting = (termIndex: number) => `notice_item:${termIndex}`;
const claimItemSetting = (detailId: string, breachKey: string) => `claim_item:${detailId}:${breachKey}`.slice(0, 64);

const REVIEW_TEXT: Record<string, string> = {
  low_confidence: 'The wording was unclear, so check this reading against the clause.',
  name_not_in_quote: 'The name given is not inside the quoted text.',
  credit_quote_not_found: 'The service credit clause the model quoted is not in the file, so no credit terms are kept.',
  claim_quote_not_found: 'The claim deadline clause the model quoted is not in the file, so no claim deadline is kept.',
  reads_like_instruction: 'This clause reads like an instruction to an AI. Covenant did not act on it; check why it is in the contract.',
};

const AMOUNT_TEXT: Record<string, string> = {
  not_in_quote: 'The amount given is not inside the quoted text.',
  no_currency: 'The amount names no currency.',
  several_currencies: 'The text names more than one currency.',
  no_amount: 'The amount is written in words only.',
  several_amounts: 'The text gives more than one figure.',
  ambiguous_separator: 'The figure could be read two ways (thousands or decimals).',
  scale_word: 'The figure uses a word such as "million".',
  too_large: 'The figure is too large to read safely.',
};

function reviewText(code: string): string {
  if (code.startsWith('amount_unreadable:')) return `Covenant could not read the amount with certainty. ${AMOUNT_TEXT[code.slice('amount_unreadable:'.length)] ?? ''} Check it against the clause.`;
  return REVIEW_TEXT[code] ?? 'Check this against the clause.';
}

const clauseOf = (c: { quote: string; page: number; pageEnd: number; section: repo.DetailRow['section']; ambiguous?: boolean }, paginated: boolean): ClauseView => ({
  quote: c.quote,
  page: c.page,
  pageEnd: c.pageEnd,
  paginated,
  ambiguous: c.ambiguous ?? false,
  section: c.section ? describeSection(c.section) : null,
});

export function whereOf(c: ClauseView): string {
  const pages = c.page === c.pageEnd ? `page ${c.page}` : `pages ${c.page} to ${c.pageEnd}`;
  if (c.section) return `${c.section}, ${c.paginated ? pages : 'Word file'}`;
  return c.paginated ? pages : 'Word file (no page numbers)';
}

const base = (d: repo.DetailRow, paginated: boolean): DetailBase => ({
  id: d.id,
  clause: clauseOf(d, paginated),
  needsReview: d.status === 'needs_review' && d.decision === 'pending',
  review: d.review.map(reviewText),
  decision: d.decision,
});

const UNIT_WORDS: Record<string, [string, string]> = {
  incident: ['incident', 'incidents'],
  hour: ['hour', 'hours'],
  business_hour: ['business hour', 'business hours'],
  day: ['day', 'days'],
  business_day: ['business day', 'business days'],
  percent: ['percent', 'percent'],
};
const amountOf = (count: number, unit: string): string => `${count} ${(UNIT_WORDS[unit] ?? [unit, unit])[count === 1 ? 0 : 1]}`;

function commitmentText(sl: StoredServiceLevel): string {
  const each = sl.period ? ` a ${sl.period}` : '';
  if (sl.metric === 'incident_count') return `At most ${amountOf(sl.threshold.count, sl.threshold.unit)}${each}`;
  if (sl.metric === 'resolution_time') return `Resolved within ${amountOf(sl.threshold.count, sl.threshold.unit)}`;
  if (sl.metric === 'response_time') return `Answered within ${amountOf(sl.threshold.count, sl.threshold.unit)}`;
  if (sl.metric === 'uptime') return `At least ${sl.threshold.count}% available${each}`;
  return `${amountOf(sl.threshold.count, sl.threshold.unit)}${each}`;
}

type StoredServiceLevel = Omit<ServiceLevelData, 'credit' | 'claim'> & {
  credit: (StoredCitation & { percent: number | null; of: 'monthly_fee' | 'quarterly_fee' | 'annual_fee' | 'other' | null; per: 'breach' | 'period' | null }) | null;
  claim: (StoredCitation & { count: number; unit: 'day' | 'business_day'; from: 'incident' | 'period_end' }) | null;
};

const FEE_WORDS = { monthly_fee: 'the monthly fee', quarterly_fee: 'the quarterly fee', annual_fee: 'the annual fee', other: 'another amount' } as const;

function creditTerms(c: NonNullable<StoredServiceLevel['credit']>): string | null {
  if (c.percent === null || c.of === null) return null;
  return `${c.percent}% of ${FEE_WORDS[c.of]}${c.per === 'breach' ? ' for each failure' : c.per === 'period' ? ' for each period missed' : ''}`;
}

const claimTerms = (c: NonNullable<StoredServiceLevel['claim']>): string =>
  `Within ${amountOf(c.count, c.unit)} after ${c.from === 'period_end' ? 'the end of the measurement period' : 'the failure'}`;

/** Details a person has not rejected. Flagged ones are shown with their warning. */
const live = (details: readonly repo.DetailRow[]) => details.filter((d) => d.decision !== 'rejected');

/** The contract's confirmed value as a yearly figure, for sums. Only a value a person confirmed counts. */
export function confirmedYearlyValue(details: readonly repo.DetailRow[]): Money | null {
  for (const d of details) {
    if (d.kind !== 'contract_value' || d.decision !== 'confirmed') continue;
    const v = d.data as ContractValueData;
    if (v.money === null) continue;
    const yearly = yearlyMinor(v.money.minor, v.period);
    if (yearly !== null) return { minor: yearly, currency: v.money.currency };
  }
  return null;
}

export const defaultJql = (issueKey: string): string => `issue in linkedIssues("${issueKey}")`;

export async function detailsView(bundle: Bundle, brief: BriefView): Promise<DetailsView> {
  const { run, contract } = bundle;
  const [detailsRun, details, ourParty, jql, noticeItemKey] = await Promise.all([
    repo.getDetailsRun(run.id),
    repo.listDetails(run.id),
    repo.getContractSetting<string>(contract.id, OUR_PARTY),
    repo.getContractSetting<string>(contract.id, SUPPLIER_JQL),
    repo.getContractSetting<string>(contract.id, noticeItemSetting(contract.termIndex)),
  ]);
  const kept = live(details);
  const deadline = brief.window.deadline;
  const methodRows = kept.filter((d) => d.kind === 'notice_method');
  const sendBy = deadline === null ? [] : sendByDates(deadline, methodRows.map((d) => d.data as NoticeMethodData), contract.holidays);

  return {
    status: detailsRun?.status ?? 'none',
    error: detailsRun?.error ?? null,
    grounding: detailsRun?.status === 'done' ? { returned: detailsRun.quotesReturned, verified: detailsRun.quotesVerified, rejected: detailsRun.rejectedCount } : null,
    parties: details.filter((d) => d.kind === 'party').map((d) => ({ ...base(d, run.paginated), ...(d.data as PartyData) })),
    ourParty,
    addresses: details.filter((d) => d.kind === 'notice_address').map((d) => ({ ...base(d, run.paginated), party: (d.data as NoticeAddressData).party })),
    methods: details
      .filter((d) => d.kind === 'notice_method')
      .map((d) => {
        const data = d.data as NoticeMethodData;
        const s = sendBy[methodRows.indexOf(d)];
        const rule = s?.rule ?? sendByDates('2000-01-03', [data])[0]?.rule ?? '';
        return { ...base(d, run.paginated), method: data.method, label: METHOD_LABELS[data.method], rule, latest: s?.latest ?? null, steps: s?.steps ?? [] };
      }),
    deadline,
    sendBy: earliestSendBy(sendBy),
    values: details
      .filter((d) => d.kind === 'contract_value')
      .map((d) => {
        const v = d.data as ContractValueData;
        const yearly = v.money === null ? null : yearlyMinor(v.money.minor, v.period);
        return {
          ...base(d, run.paginated),
          amountText: v.amountText,
          amount: v.money === null ? null : formatMoney(v.money),
          period: v.period,
          yearly: v.money !== null && yearly !== null && v.period !== 'year' ? `${formatMoney({ minor: yearly, currency: v.money.currency })} a year` : null,
          description: v.description,
        };
      }),
    serviceLevels: details
      .filter((d) => d.kind === 'service_level')
      .map((d): ServiceLevelView => {
        const sl = d.data as StoredServiceLevel;
        const measurable = (sl.metric === 'incident_count' && sl.threshold.unit === 'incident' && sl.period !== null) || (sl.metric === 'resolution_time' && ['hour', 'day', 'business_day'].includes(sl.threshold.unit));
        return {
          ...base(d, run.paginated),
          metric: sl.metric,
          summary: sl.summary,
          commitment: commitmentText(sl),
          measurable,
          credit: sl.credit ? { clause: clauseOf(sl.credit, run.paginated), terms: creditTerms(sl.credit) } : null,
          claim: sl.claim ? { clause: clauseOf(sl.claim, run.paginated), terms: claimTerms(sl.claim) } : null,
        };
      }),
    noticeItemKey,
    supplierJql: jql ?? defaultJql(contract.issueKey),
    defaultJql: defaultJql(contract.issueKey),
  };
}

async function ownedDetail(bundle: Bundle, detailId: string): Promise<repo.DetailRow> {
  const detail = await repo.getDetail(detailId);
  if (detail === null || detail.contractId !== bundle.contract.id) throw new UserFacingError('That item belongs to a different contract. Reload the panel.');
  return detail;
}

export async function decideDetail(bundle: Bundle, detailId: string, decision: repo.DetailDecision, accountId: string): Promise<void> {
  const detail = await ownedDetail(bundle, detailId);
  if (decision === 'confirmed' && detail.kind === 'contract_value' && (detail.data as ContractValueData).money === null) {
    throw new UserFacingError('Covenant could not read this amount with certainty, so it cannot be confirmed and counted. Reject it, or fix the contract text and extract again.');
  }
  await repo.decideDetail(detail.id, decision, accountId, Date.now());
  console.log(`detail ${detail.id} ${decision} kind=${detail.kind} contract=${bundle.contract.id}`);
}

export async function setOurParty(bundle: Bundle, label: string | null, accountId: string): Promise<void> {
  const parties = live(await repo.listDetails(bundle.run.id)).filter((d) => d.kind === 'party').map((d) => (d.data as PartyData).label);
  if (label !== null && !parties.includes(label)) throw new UserFacingError('Choose one of the parties named in the contract.');
  await repo.putContractSetting(bundle.contract.id, OUR_PARTY, label, accountId, Date.now());
}

const JQL_MAX = 600;

export async function setSupplierJql(bundle: Bundle, jql: string, accountId: string): Promise<{ matched: number }> {
  const clean = jql.trim().replace(/\s+/g, ' ');
  if (clean.length > JQL_MAX) throw new UserFacingError(`Keep the filter under ${JQL_MAX} characters.`);
  if (clean === '') {
    await repo.putContractSetting(bundle.contract.id, SUPPLIER_JQL, null, accountId, Date.now());
    return { matched: 0 };
  }
  // Jira checks the filter by running it, as this person.
  let matched: FoundIssue[];
  try {
    matched = await searchIssues(asUser(), clean, 1);
  } catch (error) {
    throw new UserFacingError(`Jira did not accept that filter. ${readableError(error, 'Check the JQL')}`);
  }
  await repo.putContractSetting(bundle.contract.id, SUPPLIER_JQL, clean, accountId, Date.now());
  return { matched: matched.length };
}

/** The drafted notice for the decision in force, built from confirmed and unrejected details. */
export async function noticeDraft(bundle: Bundle, brief: BriefView, kind: NoticeDraftInput['kind'], issueTitle: string): Promise<{ draft: NoticeDraftView; text: string; sendBy: IsoDate | null }> {
  const details = live(await repo.listDetails(bundle.run.id));
  const ourLabel = await repo.getContractSetting<string>(bundle.contract.id, OUR_PARTY);
  const parties = details.filter((d) => d.kind === 'party').map((d) => d.data as PartyData);
  const sender = ourLabel === null ? null : { label: ourLabel, name: parties.find((p) => p.label === ourLabel)?.name ?? null };
  const others = ourLabel === null ? [] : parties.filter((p) => p.label !== ourLabel);
  const recipient = others.length === 1 && others[0] ? { label: others[0].label, name: others[0].name } : null;

  const addressRows = details.filter((d) => d.kind === 'notice_address');
  const forRecipient = recipient === null ? addressRows : addressRows.filter((d) => (d.data as NoticeAddressData).party.toLowerCase() === recipient.label.toLowerCase());
  const methodRows = details.filter((d) => d.kind === 'notice_method');
  const deadline = brief.window.deadline;
  if (deadline === null) throw new UserFacingError('This contract has no dated notice deadline yet, so there is nothing to draft a notice against.');
  const sendBy = sendByDates(deadline, methodRows.map((d) => d.data as NoticeMethodData), bundle.contract.holidays);

  const renewal = brief.clauses[0];
  const draft = draftNotice({
    kind,
    contractTitle: issueTitle,
    fileName: bundle.contract.fileName,
    deadline,
    termEnd: brief.window.termEnd,
    sender,
    recipient,
    renewalClause: renewal ? { quote: renewal.clause.quote, where: whereOf(renewal.clause) } : null,
    addresses: (forRecipient.length > 0 ? forRecipient : addressRows).map((d) => ({ party: (d.data as NoticeAddressData).party, quote: d.quote, where: whereOf(clauseOf(d, bundle.run.paginated)) })),
    methods: methodRows.flatMap((d, i) => {
      const s = sendBy[i];
      return s ? [{ quote: d.quote, where: whereOf(clauseOf(d, bundle.run.paginated)), sendBy: s }] : [];
    }),
  });
  return { draft, text: draftText(draft), sendBy: earliestSendBy(sendBy) };
}

/**
 * Opens the "Send notice by" work item for a decision that needs notice given, once per term.
 * Runs as the person who recorded the decision. Returns the key, or null with the reason it was not opened.
 */
export async function ensureNoticeItem(bundle: Bundle, brief: BriefView, kind: NoticeDraftInput['kind']): Promise<{ key: string | null; created: boolean; note: string | null }> {
  const setting = noticeItemSetting(bundle.contract.termIndex);
  const existing = await repo.getContractSetting<string>(bundle.contract.id, setting);
  if (existing !== null) return { key: existing, created: false, note: null };
  if (brief.window.deadline === null) return { key: null, created: false, note: 'No notice item was opened, because the contract has no dated notice deadline.' };
  try {
    const req = asUser();
    const parent = await getIssue(req, bundle.contract.issueId);
    const { draft, sendBy } = await noticeDraft(bundle, brief, kind, parent.key);
    const type = await childIssueType(req, parent);
    const due = sendBy ?? brief.window.deadline;
    const created = await createChild(req, {
      projectId: parent.projectId,
      parentKey: parent.key,
      issueTypeId: type.id,
      summary: `Send notice by ${due}: ${draft.title.toLowerCase()} for ${bundle.contract.fileName}`.slice(0, 250),
      description: draftAdf(draft),
      dueDate: due,
    });
    await repo.putContractSetting(bundle.contract.id, setting, created.key, null, Date.now());
    await repo.recordCreatedItem(created.key, bundle.contract.id, 'notice', Date.now());
    console.log(`notice item opened contract=${bundle.contract.id} term=${bundle.contract.termIndex} workItem=${created.key} kind=${kind}`);
    return { key: created.key, created: true, note: null };
  } catch (error) {
    console.error(`notice item failed contract=${bundle.contract.id} error=${loggableError(error)}`);
    return { key: null, created: false, note: `The "Send notice" work item could not be opened: ${readableError(error, 'Jira refused')}.` };
  }
}

const isIncident = (i: FoundIssue): boolean => /incident|bug|problem/i.test(i.issueType) || i.labels.some((l) => l.toLowerCase() === 'incident');
const ms = (stamp: string | null): number | null => {
  if (stamp === null) return null;
  // Jira writes offsets as +0000; the standard form has a colon.
  const parsed = Date.parse(stamp.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(parsed) ? null : parsed;
};

const breachKey = (b: Breach): string => (b.periodLabel ?? b.workItems.join('+')).replace(/[^A-Za-z0-9+-]/g, '').slice(0, 24);

interface Measured {
  detail: repo.DetailRow;
  sl: StoredServiceLevel;
  measurement: ReturnType<typeof measureServiceLevel>;
  credit: Money | null;
}

async function measureAll(bundle: Bundle, brief: BriefView, today: IsoDate): Promise<{ measured: Measured[]; matched: number; incidents: number; jql: string; problems: string[]; yearly: Money | null }> {
  const details = live(await repo.listDetails(bundle.run.id));
  const jql = (await repo.getContractSetting<string>(bundle.contract.id, SUPPLIER_JQL)) ?? defaultJql(bundle.contract.issueKey);
  const problems: string[] = [];
  let found: FoundIssue[] = [];
  try {
    found = await searchIssues(asUser(), jql, 300);
  } catch (error) {
    problems.push(error instanceof JiraError ? `Jira could not run the supplier filter: ${error.message}.` : 'Jira could not run the supplier filter.');
  }
  // Covenant's own items are never evidence about the supplier.
  const createdKeys = await repo.listCreatedKeys(bundle.contract.id);
  const incidents = found.filter((i) => isIncident(i) && !createdKeys.has(i.key));
  const facts = incidents.flatMap((i) => {
    const createdMs = ms(i.created);
    return createdMs === null ? [] : [{ key: i.key, createdMs, resolvedMs: ms(i.resolved) }];
  });
  const yearly = confirmedYearlyValue(details);
  const term = brief.currentTerm;
  const measured: Measured[] = [];
  for (const detail of details.filter((d) => d.kind === 'service_level')) {
    const sl = detail.data as StoredServiceLevel;
    const measurement =
      term === null || problems.length > 0
        ? ({ status: 'cannot_measure', reason: term === null ? "The contract's term is not confirmed, so Covenant cannot tell which incidents fall inside it." : 'The supplier filter could not be run.' } as const)
        : measureServiceLevel({ metric: sl.metric, threshold: sl.threshold, period: sl.period, claim: sl.claim as never }, facts, { termStart: term.start, termEnd: term.end, today, nowMs: Date.now(), holidays: bundle.contract.holidays });
    const credit = measurement.status === 'measured' ? creditAmount(sl.credit, measurement.breaches, yearly) : null;
    measured.push({ detail, sl, measurement, credit });
  }
  return { measured, matched: found.length, incidents: incidents.length, jql, problems, yearly };
}

export async function supplierRecord(bundle: Bundle, brief: BriefView, today: IsoDate, issueTitle: string): Promise<SupplierRecordView> {
  const { measured, matched, incidents, jql, problems, yearly } = await measureAll(bundle, brief, today);
  const records: SupplierRecordView['records'] = [];
  for (const m of measured) {
    const where = whereOf(clauseOf(m.detail, bundle.run.paginated));
    const breaches: BreachView[] = [];
    if (m.measurement.status === 'measured') {
      for (const b of m.measurement.breaches) {
        const key = breachKey(b);
        breaches.push({ key, periodLabel: b.periodLabel, workItems: b.workItems, detail: b.detail, claimBy: b.claimBy, claimOpen: b.claimOpen, claimItemKey: await repo.getContractSetting<string>(bundle.contract.id, claimItemSetting(m.detail.id, key)) });
      }
    }
    const hasBreach = breaches.length > 0;
    records.push({
      detailId: m.detail.id,
      summary: m.sl.summary,
      where,
      status: m.measurement.status,
      observed: m.measurement.status === 'measured' ? m.measurement.observed : m.measurement.reason,
      breaches,
      credit: m.credit ? formatMoney(m.credit) : null,
      creditNote: !hasBreach
        ? null
        : m.credit
          ? `Worked out by code: ${creditTerms(m.sl.credit as NonNullable<StoredServiceLevel['credit']>) ?? 'the stated credit'}, on a confirmed fee of ${yearly ? formatMoney(yearly) : ''} a year.`
          : m.sl.credit === null
            ? 'The contract states no service credit for this commitment that Covenant found.'
            : yearly === null
              ? 'No amount is worked out, because the contract value is not confirmed. The claim quotes the formula instead.'
              : 'No amount is worked out, because the credit is not a plain percentage of a fee. The claim quotes the formula instead.',
    });
  }

  let leverage: string[] | null = null;
  if (brief.decided?.outcome === 'renegotiate') {
    leverage = draftText(
      leverageSummary({
        contractTitle: issueTitle,
        deadline: brief.window.deadline,
        daysLeft: brief.window.daysLeft,
        termEnd: brief.window.termEnd,
        yearlyValue: yearly,
        records: measured.map((m) => ({ summary: m.sl.summary, where: whereOf(clauseOf(m.detail, bundle.run.paginated)), measurement: m.measurement, credit: m.credit })),
      }),
    ).split('\n');
  }

  console.log(
    `supplier record contract=${bundle.contract.id} matched=${matched} incidents=${incidents} levels=${measured.length} ` +
      `breaches=${records.reduce((n, r) => n + r.breaches.length, 0)} problems=${problems.length}`,
  );
  return {
    fetchedAtMs: Date.now(),
    jql,
    matched,
    incidents,
    term: brief.currentTerm ? { number: brief.termNumber, start: brief.currentTerm.start, end: brief.currentTerm.end } : null,
    records,
    leverage,
    problems,
  };
}

/** Opens a "Claim service credit by" work item with the drafted claim, once per breach, on a person's click. */
export async function openClaimItem(bundle: Bundle, brief: BriefView, today: IsoDate, detailId: string, key: string, issueTitle: string): Promise<{ key: string; created: boolean }> {
  await ownedDetail(bundle, detailId);
  const setting = claimItemSetting(detailId, key);
  const existing = await repo.getContractSetting<string>(bundle.contract.id, setting);
  if (existing !== null) return { key: existing, created: false };

  const { measured } = await measureAll(bundle, brief, today);
  const m = measured.find((x) => x.detail.id === detailId);
  const breach = m?.measurement.status === 'measured' ? m.measurement.breaches.find((b) => breachKey(b) === key) : undefined;
  if (m === undefined || breach === undefined) throw new UserFacingError('Jira no longer shows that breach. Reload the supplier record.');
  if (breach.claimOpen === false) throw new UserFacingError(`The claim window for this breach closed on ${breach.claimBy}.`);

  const details = live(await repo.listDetails(bundle.run.id));
  const ourLabel = await repo.getContractSetting<string>(bundle.contract.id, OUR_PARTY);
  const others = details.filter((d) => d.kind === 'party').map((d) => d.data as PartyData).filter((p) => ourLabel !== null && p.label !== ourLabel);
  const cite = (c: StoredCitation) => ({ quote: c.quote, where: whereOf(clauseOf(c, bundle.run.paginated)) });
  const draft = draftClaim({
    contractTitle: issueTitle,
    fileName: bundle.contract.fileName,
    supplier: others.length === 1 ? (others[0]?.name ?? null) : null,
    commitment: { quote: m.detail.quote, where: whereOf(clauseOf(m.detail, bundle.run.paginated)) },
    credit: m.sl.credit ? cite(m.sl.credit) : null,
    claimClause: m.sl.claim ? cite(m.sl.claim) : null,
    breaches: [breach],
    amount: creditAmount(m.sl.credit, [breach], confirmedYearlyValue(details)),
    claimBy: breach.claimBy,
  });

  const req = asUser();
  const parent = await getIssue(req, bundle.contract.issueId);
  const type = await childIssueType(req, parent);
  const created = await createChild(req, {
    projectId: parent.projectId,
    parentKey: parent.key,
    issueTypeId: type.id,
    summary: `Claim service credit${breach.claimBy ? ` by ${breach.claimBy}` : ''}: ${breach.periodLabel ?? breach.workItems.join(', ')} (${bundle.contract.fileName})`.slice(0, 250),
    description: draftAdf(draft),
    dueDate: breach.claimBy,
  });
  await repo.putContractSetting(bundle.contract.id, setting, created.key, null, Date.now());
  await repo.recordCreatedItem(created.key, bundle.contract.id, 'claim', Date.now());
  console.log(`claim item opened contract=${bundle.contract.id} detail=${detailId} workItem=${created.key} claimBy=${breach.claimBy ?? 'none'}`);
  return { key: created.key, created: true };
}

