import { invoke } from '@forge/bridge';
import ForgeReconciler, { Box, Button, Heading, Inline, Link, LoadingButton, Lozenge, ModalTransition, SectionMessage, Spinner, Stack, Strong, Text, xcss } from '@forge/react';
import React, { useCallback, useEffect, useState } from 'react';
import type { ApproveReply, ContractView, FactView, ObligationView, PanelView, Reply, RunStatusView, RunView, StartReply } from '../shared/panel';
import { type RunAction, RenewalBrief } from './brief';
import { HolidayCalendar } from './calendar';
import { DetailsSection } from './details';
import { EvidenceSection } from './evidence';
import { EditObligationModal, EditTermsModal } from './forms';

/**
 * The Covenant issue panel: extract, review, approve. Nothing reaches Jira
 * until a person clicks Approve on an obligation.
 */

const POLL_MS = 3000;

const card = xcss({
  borderColor: 'color.border',
  borderWidth: 'border.width',
  borderStyle: 'solid',
  borderRadius: 'radius.medium',
  padding: 'space.200',
});
const quoteBox = xcss({
  backgroundColor: 'color.background.neutral',
  padding: 'space.100',
  borderRadius: 'radius.medium',
});

type LozengeAppearance = 'default' | 'inprogress' | 'moved' | 'new' | 'removed' | 'success';

const RUN_LABEL: Record<RunStatusView, [string, LozengeAppearance]> = {
  queued: ['Queued', 'new'],
  running: ['Reading', 'inprogress'],
  needs_review: ['Needs review', 'moved'],
  approved: ['Approved', 'success'],
  failed: ['Failed', 'removed'],
};

const FACT_LABEL: Record<FactView['status'], [string, LozengeAppearance]> = {
  ready: ['From the contract', 'default'],
  needs_review: ['Needs review', 'moved'],
  missing: ['Not found', 'removed'],
  edited: ['Set by a person', 'new'],
};

const kb = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const seconds = (ms: number): string => `${Math.max(0, Math.round(ms / 1000))} s`;
/** The viewer's time zone, so "days left" follows their calendar. Undefined lets the server use UTC. */
const browserTimeZone = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
};

const where = (c: { page: number; pageEnd: number; paginated: boolean; section?: string | null }): string => {
  const place = !c.paginated ? 'Word file' : c.page === c.pageEnd ? `page ${c.page}` : `pages ${c.page} to ${c.pageEnd}`;
  return c.section ? `${c.section}, ${place}` : place;
};

async function call<T>(key: string, payload?: Record<string, unknown>): Promise<Reply<T>> {
  try {
    return (await invoke<Reply<T>>(key, payload)) as Reply<T>;
  } catch (error) {
    return {
      ok: false,
      error: `Covenant did not answer: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function Quote({ clause }: { clause: NonNullable<ObligationView['clause']> }) {
  return (
    <Box xcss={quoteBox}>
      <Stack space="space.050">
        <Text>“{clause.quote}”</Text>
        <Text size="small">
          {where(clause)}
          {clause.ambiguous ? '. This wording appears more than once in the contract.' : ''}
        </Text>
      </Stack>
    </Box>
  );
}

const whyBox = xcss({
  backgroundColor: 'color.background.neutral',
  padding: 'space.100',
  borderRadius: 'radius.medium',
  width: '100%',
});

function DueLine({ item }: { item: ObligationView }) {
  const s = item.schedule;
  const [why, setWhy] = useState(false);
  if (s.status === 'undated') {
    return (
      <Text>
        <Strong>Due:</Strong> no date yet. {s.note}
      </Text>
    );
  }
  return (
    <Inline space="space.100" alignBlock="center" shouldWrap>
      <Text>
        <Strong>Due:</Strong> {s.due}
        {s.later.length > 0 ? `, then ${s.later.join(', ')}` : ''}
      </Text>
      {s.status === 'past' && <Lozenge appearance="removed">Passed</Lozenge>}
      <Button appearance="subtle" spacing="compact" onClick={() => setWhy(!why)}>
        {why ? 'Hide the working' : 'Why this date'}
      </Button>
      {why && (
        <Box xcss={whyBox}>
          <Stack space="space.050">
            <Text size="small">
              <Strong>Rule from the clause:</Strong> {item.timing}
            </Text>
            {s.trace.map((step, i) => (
              <Text key={`${i}-${step}`} size="small">
                {i + 1}. {step}
              </Text>
            ))}
            <Text size="small">Code worked this out from the rule and the contract terms. The model read the clause and did not compute the date.</Text>
          </Stack>
        </Box>
      )}
    </Inline>
  );
}

interface ObligationActions {
  busy: string | null;
  approve: (item: ObligationView) => void;
  reject: (item: ObligationView) => void;
  reopen: (item: ObligationView) => void;
  edit: (item: ObligationView) => void;
}

function ObligationCard({ item, actions }: { item: ObligationView; actions: ObligationActions }) {
  const busy = actions.busy === item.id;
  const waiting = item.decision === 'pending' || item.decision === 'edited';
  return (
    <Box xcss={card}>
      <Stack space="space.100">
        <Inline space="space.100" alignBlock="center" shouldWrap>
          <Lozenge>{item.kindLabel}</Lozenge>
          {item.decision === 'approved' && <Lozenge appearance="success">Approved</Lozenge>}
          {item.decision === 'rejected' && <Lozenge appearance="removed">Rejected</Lozenge>}
          {item.decision === 'edited' && <Lozenge appearance="new">Checked by a person</Lozenge>}
          {item.decision === 'approving' && <Lozenge appearance="inprogress">Creating work item</Lozenge>}
          {item.needsReview && <Lozenge appearance="moved">Needs review</Lozenge>}
          {item.confidence !== 'high' && waiting && <Lozenge>{`${item.confidence} confidence`}</Lozenge>}
        </Inline>
        <Text>
          <Strong>{item.summary}</Strong>
        </Text>
        <Text>
          <Strong>Who:</Strong> {item.party}. <Strong>When:</Strong> {item.timing}.
        </Text>
        <DueLine item={item} />
        {item.instructionSigns.length > 0 && (
          <SectionMessage appearance="warning" title="This clause reads like an instruction to an AI">
            <Text>
              It {item.instructionSigns.join(', and ')}. Covenant treats contract text as text to quote, never as instructions, and did not act on it. Check why the clause is in
              the contract before approving anything based on it.
            </Text>
          </SectionMessage>
        )}
        {item.needsReview && (
          <SectionMessage appearance="warning" title="Check this before approving">
            {item.review.map((line) => (
              <Text key={line}>{line}</Text>
            ))}
            {item.secondReading && <Text>The second reading said: {item.secondReading}</Text>}
            <Text>Open it with Edit, correct anything that is wrong, and save.</Text>
          </SectionMessage>
        )}
        {item.clause && <Quote clause={item.clause} />}
        {item.lastError && (
          <SectionMessage appearance="error">
            <Text>{item.lastError}</Text>
          </SectionMessage>
        )}
        {item.decision === 'approved' && item.workItemKey && (
          <Text>
            Work item: <Link href={`/browse/${item.workItemKey}`}>{item.workItemKey}</Link>
          </Text>
        )}
        {item.decision === 'rejected' && (
          <Inline>
            <Button appearance="subtle" isDisabled={actions.busy !== null} onClick={() => actions.reopen(item)}>
              Undo rejection
            </Button>
          </Inline>
        )}
        {waiting && (
          <Inline space="space.100">
            <LoadingButton appearance="primary" isLoading={busy} isDisabled={!item.canApprove || (actions.busy !== null && !busy)} onClick={() => actions.approve(item)}>
              Approve and create work item
            </LoadingButton>
            <Button isDisabled={actions.busy !== null} onClick={() => actions.edit(item)}>
              Edit
            </Button>
            <Button appearance="subtle" isDisabled={actions.busy !== null} onClick={() => actions.reject(item)}>
              Reject
            </Button>
          </Inline>
        )}
      </Stack>
    </Box>
  );
}

function Facts({ run, onEdit }: { run: RunView; onEdit: () => void }) {
  return (
    <Box xcss={card}>
      <Stack space="space.150">
        <Inline space="space.100" alignBlock="center" spread="space-between">
          <Heading size="xsmall">Contract terms</Heading>
          <Button appearance="subtle" onClick={onEdit}>
            Edit terms
          </Button>
        </Inline>
        {run.facts.map((fact) => {
          const [label, appearance] = FACT_LABEL[fact.status];
          return (
            <Stack key={fact.key} space="space.050">
              <Inline space="space.100" alignBlock="center" shouldWrap>
                <Text>
                  <Strong>{fact.label}:</Strong> {fact.value}
                </Text>
                <Lozenge appearance={appearance}>{label}</Lozenge>
              </Inline>
              {fact.status === 'needs_review' &&
                fact.review.map((line) => (
                  <Text key={line} size="small">
                    {line}
                  </Text>
                ))}
              {fact.status === 'needs_review' && fact.secondReading && <Text size="small">The second reading said: {fact.secondReading}</Text>}
              {fact.clause && <Quote clause={fact.clause} />}
            </Stack>
          );
        })}
        {run.terms?.currentTerm && (
          <Text size="small">
            Current term {run.terms.currentTerm.number}: {run.terms.currentTerm.start} to {run.terms.currentTerm.end}. A term ends the day before its anniversary, which puts every
            notice deadline a day early rather than a day late.
          </Text>
        )}
      </Stack>
    </Box>
  );
}

type Glance = NonNullable<RunView['glance']>;
type FoldKey = 'decision' | 'obligations' | 'details' | 'terms' | 'calendar';

const glanceBox = xcss({
  borderColor: 'color.border.brand',
  borderWidth: 'border.width.selected',
  borderStyle: 'solid',
  borderRadius: 'radius.medium',
  padding: 'space.200',
  backgroundColor: 'color.background.accent.blue.subtlest',
});

const TONE: Record<Glance['deadline']['tone'], LozengeAppearance> = {
  urgent: 'moved',
  calm: 'default',
  settled: 'success',
  missed: 'removed',
  none: 'default',
};

const countsText = (c: Glance['counts']): string => `${c.approved} approved, ${c.waiting} waiting, ${c.rejected} rejected`;

/** The contract at a glance: the deadline, the one next step with its button, and the counts. */
function GlanceCard({ glance, onGo }: { glance: Glance; onGo: (section: FoldKey) => void }) {
  const { deadline, next, counts, nextDate } = glance;
  return (
    <Box xcss={glanceBox}>
      <Stack space="space.150">
        <Inline space="space.100" alignBlock="center" shouldWrap>
          <Text>
            <Strong>{deadline.text}</Strong>
          </Text>
          {deadline.label && <Lozenge appearance={TONE[deadline.tone]}>{deadline.label}</Lozenge>}
        </Inline>
        <Stack space="space.050">
          <Text size="small">Next step</Text>
          <Heading size="small">{next.title}</Heading>
          <Text>{next.detail}</Text>
        </Stack>
        <Inline space="space.200" alignBlock="center" shouldWrap>
          {next.action && next.section && (
            <Button appearance="primary" onClick={() => onGo(next.section as FoldKey)}>
              {next.action}
            </Button>
          )}
          <Text size="small">
            Obligations: {countsText(counts)}
            {nextDate ? `. Next date ${nextDate.due}.` : '.'}
          </Text>
        </Inline>
      </Stack>
    </Box>
  );
}

/** A section folded to one line, with what it holds, until a person opens it. */
function Fold({ title, summary, open, onToggle, children }: { title: string; summary: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  if (!open) {
    return (
      <Box xcss={card}>
        <Inline space="space.100" alignBlock="center" spread="space-between">
          <Stack space="space.025">
            <Text>
              <Strong>{title}</Strong>
            </Text>
            <Text size="small">{summary}</Text>
          </Stack>
          <Button appearance="subtle" onClick={onToggle}>
            Show
          </Button>
        </Inline>
      </Box>
    );
  }
  return (
    <Stack space="space.050">
      <Inline alignInline="end">
        <Button appearance="subtle" spacing="compact" onClick={onToggle}>
          {`Hide ${title.toLowerCase()}`}
        </Button>
      </Inline>
      {children}
    </Stack>
  );
}

/** Only the section the next step points at starts open. Without a glance, everything does, as before. */
const initialOpen = (glance: RunView['glance']): Record<FoldKey, boolean> => {
  const all = glance === null;
  const section = glance?.next.section ?? null;
  return {
    decision: all || section === 'decision',
    obligations: all || section === 'obligations',
    details: all || section === 'details',
    terms: all || section === 'terms',
    calendar: all,
  };
};

function detailsSummary(details: NonNullable<RunView['details']>): string {
  if (details.status === 'queued' || details.status === 'running') return 'Reading the notices clause, the contract value and the service levels.';
  if (details.status !== 'done') return 'Not read yet.';
  const parts = [details.sendBy ? `Latest send-by date ${details.sendBy}` : 'Delivery methods and send-by dates', 'the drafted notice', 'the contract value', "the supplier's record"];
  return `${parts.join(', ')}.`;
}

function RunPanel({
  contract,
  run,
  nowMs,
  actions,
  runAction,
  onEditTerms,
  onExtract,
}: {
  contract: ContractView;
  run: RunView;
  nowMs: number;
  actions: ObligationActions;
  runAction: RunAction;
  onEditTerms: () => void;
  onExtract: () => void;
}) {
  const [label, appearance] = RUN_LABEL[run.status];
  const took = run.finishedAtMs !== null && run.startedAtMs !== null ? run.finishedAtMs - run.startedAtMs : null;
  const [open, setOpen] = useState<Record<FoldKey, boolean>>(() => initialOpen(run.glance));
  const toggle = (key: FoldKey) => setOpen((o) => ({ ...o, [key]: !o[key] }));
  const show = (key: FoldKey) => setOpen((o) => ({ ...o, [key]: true }));
  const termsToCheck = run.facts.filter((f) => f.status === 'needs_review').length;
  return (
    <Stack space="space.200">
      <Inline space="space.100" alignBlock="center" shouldWrap>
        <Heading size="small">{contract.fileName}</Heading>
        <Lozenge appearance={appearance}>{label}</Lozenge>
      </Inline>

      {run.status === 'queued' && (
        <Inline space="space.100" alignBlock="center">
          <Spinner size="small" />
          <Text>Queued. Covenant starts reading in a moment.</Text>
        </Inline>
      )}
      {run.status === 'running' && (
        <Inline space="space.100" alignBlock="center">
          <Spinner size="small" />
          <Text>
            Reading the contract
            {run.startedAtMs !== null ? ` (${seconds(nowMs - run.startedAtMs)} so far)` : ''}. A 30-page contract usually takes under a minute.
          </Text>
        </Inline>
      )}
      {run.status === 'failed' && (
        <SectionMessage appearance="error" title="Extraction failed">
          <Text>{run.errorMessage ?? 'The extraction failed.'}</Text>
          <Inline>
            <Button onClick={onExtract}>Extract again</Button>
          </Inline>
        </SectionMessage>
      )}

      {(run.status === 'needs_review' || run.status === 'approved') && (
        <Stack space="space.200">
          {run.glance && <GlanceCard glance={run.glance} onGo={show} />}
          <Text size="small">
            {!run.paginated ? 'Read the Word file' : run.pages === null ? 'Read the file' : `Read ${run.pages} page${run.pages === 1 ? '' : 's'}`}
            {took !== null ? ` in ${seconds(took)}` : ''} with {run.model}: {run.llmCalls} model {run.llmCalls === 1 ? 'call' : 'calls'}, {run.inputTokens.toLocaleString('en')}{' '}
            input and {run.outputTokens.toLocaleString('en')} output tokens. {run.quotesVerified} of {run.quotesReturned} quotes were found word for word in the contract
            {run.rejectedCount > 0 ? `; ${run.rejectedCount} ${run.rejectedCount === 1 ? 'item that failed' : 'items that failed'} Covenant's checks ${run.rejectedCount === 1 ? 'was' : 'were'} dropped` : ''}.
          </Text>
          {run.brief && (
            <Fold
              title="Renewal decision"
              summary={run.glance ? `${run.glance.deadline.text}.${run.glance.deadline.label ? ` ${run.glance.deadline.label}.` : ''}` : 'The notice deadline and the decision.'}
              open={open.decision}
              onToggle={() => toggle('decision')}
            >
              <RenewalBrief contractId={contract.id} termIndex={contract.termIndex} brief={run.brief} busy={actions.busy !== null} run={runAction} />
            </Fold>
          )}
          <Fold
            title="Obligations"
            summary={run.counts.total === 0 ? 'No dated obligations were found.' : `${run.glance ? countsText(run.glance.counts) : `${run.counts.total} found`}.`}
            open={open.obligations}
            onToggle={() => toggle('obligations')}
          >
            <Stack space="space.200">
              <Heading size="xsmall">
                {run.counts.total === 0
                  ? 'No dated obligations were found'
                  : `Obligations: ${run.counts.approved} approved, ${run.counts.rejected} rejected, ${run.counts.waiting} waiting`}
              </Heading>
              {run.obligations.map((item) => (
                <ObligationCard key={item.id} item={item} actions={actions} />
              ))}
            </Stack>
          </Fold>
          {run.brief && run.details && (
            <Fold title="Notices, value and supplier record" summary={detailsSummary(run.details)} open={open.details} onToggle={() => toggle('details')}>
              <DetailsSection contractId={contract.id} details={run.details} brief={run.brief} run={runAction} busy={actions.busy !== null} />
            </Fold>
          )}
          <Fold
            title="Contract terms"
            summary={
              termsToCheck > 0
                ? `${termsToCheck} waiting for a person to check.`
                : run.terms?.currentTerm
                  ? `Term ${run.terms.currentTerm.number}: ${run.terms.currentTerm.start} to ${run.terms.currentTerm.end}.`
                  : 'Effective date, term and renewal.'
            }
            open={open.terms}
            onToggle={() => toggle('terms')}
          >
            <Facts run={run} onEdit={onEditTerms} />
          </Fold>
          <Fold
            title="Business days"
            summary={`${contract.calendar.name}${contract.calendar.usedBy > 0 ? `, used by ${contract.calendar.usedBy} obligation${contract.calendar.usedBy === 1 ? '' : 's'}` : ''}.`}
            open={open.calendar}
            onToggle={() => toggle('calendar')}
          >
            <HolidayCalendar contractId={contract.id} calendar={contract.calendar} run={runAction} />
          </Fold>
        </Stack>
      )}
    </Stack>
  );
}

const App = () => {
  const [view, setView] = useState<PanelView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    kind: 'info' | 'error';
    text: string;
  } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<ObligationView | null>(null);
  const [editingTerms, setEditingTerms] = useState<RunView | null>(null);

  const load = useCallback(async () => {
    const reply = await call<PanelView>('panel.load', {
      timeZone: browserTimeZone(),
    });
    if (reply.ok) {
      setView(reply.data);
      setLoadError(null);
    } else setLoadError(reply.error);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const working = (s: string | undefined) => s === 'queued' || s === 'running';
  const active =
    (view?.contracts.some((c) => working(c.run?.status) || working(c.run?.details?.status)) ?? false) ||
    (view?.evidence?.attachments.some((a) => working(a.check?.status)) ?? false);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(timer);
  }, [active, view, load]);

  const extract = async (attachmentId: string) => {
    setBusy(`extract:${attachmentId}`);
    setNotice(null);
    const reply = await call<StartReply>('extract.start', { attachmentId });
    setBusy(null);
    if (!reply.ok) {
      setNotice({ kind: 'error', text: reply.error });
      return;
    }
    setSelected(reply.data.contractId);
    if (reply.data.outcome === 'existing') {
      setNotice({
        kind: 'info',
        text: 'Covenant has already read this file with the current extractor, so nothing new was created.',
      });
    }
    await load();
  };

  const act = async (item: ObligationView, key: string, success?: (data: unknown) => string | null) => {
    setBusy(item.id);
    setNotice(null);
    const reply = await call<unknown>(key, { obligationId: item.id });
    setBusy(null);
    if (!reply.ok) setNotice({ kind: 'error', text: reply.error });
    else if (success) {
      const text = success(reply.data);
      if (text) setNotice({ kind: 'info', text });
    }
    await load();
  };

  const runAction: RunAction = async (key, payload, success) => {
    setBusy(`action:${key}`);
    setNotice(null);
    const reply = await call<unknown>(key, payload);
    setBusy(null);
    if (!reply.ok) {
      setNotice({ kind: 'error', text: reply.error });
      return reply.error;
    }
    const text = success?.(reply.data);
    if (text) setNotice({ kind: 'info', text });
    await load();
    return null;
  };

  const actions: ObligationActions = {
    busy,
    approve: (item) =>
      void act(item, 'obligation.approve', (data) => {
        const d = data as ApproveReply;
        if (d.dueDate !== null && !d.dueDateSet) {
          return `Created ${d.workItemKey}. This project's screens would not take a due date, so the date ${d.dueDate} is in its description.`;
        }
        return `Created ${d.workItemKey}${d.dueDate ? `, due ${d.dueDate}` : ', with no due date'}.`;
      }),
    reject: (item) => void act(item, 'obligation.reject'),
    reopen: (item) => void act(item, 'obligation.reopen'),
    edit: (item) => setEditing(item),
  };

  if (view === null) {
    return loadError ? (
      <SectionMessage appearance="error" title="Covenant could not load">
        <Text>{loadError}</Text>
      </SectionMessage>
    ) : (
      <Spinner />
    );
  }

  const supported = view.attachments.filter((a) => a.supported);
  const current = view.contracts.find((c) => c.id === selected) ?? view.contracts[0] ?? null;

  return (
    <Stack space="space.300">
      {notice && (
        <SectionMessage appearance={notice.kind === 'error' ? 'error' : 'information'}>
          <Text>{notice.text}</Text>
        </SectionMessage>
      )}

      {view.evidence && <EvidenceSection view={view.evidence} busy={busy} runAction={runAction} />}

      {(view.evidence === null || view.contracts.length > 0) && (
        <Stack space="space.100">
          <Heading size="xsmall">Contract files on {view.issueKey}</Heading>
          {supported.length === 0 && (
            <Text>
              Attach a contract to this work item (a text PDF or a Word .docx file, up to 15 MB and about 100 pages), then click Extract.
              {view.attachments.length > 0 ? ' The files attached here are not PDF or Word files, so Covenant cannot read them.' : ''}
            </Text>
          )}
          {supported.map((a) => {
            const contract = view.contracts.find((c) => c.id === a.contractId);
            const status = contract?.run?.status;
            return (
              <Inline key={a.id} space="space.100" alignBlock="center" shouldWrap>
                <Text>
                  {a.fileName} ({kb(a.size)})
                </Text>
                {status && <Lozenge appearance={RUN_LABEL[status][1]}>{RUN_LABEL[status][0]}</Lozenge>}
                {a.tooLarge ? (
                  <Text size="small">Too large: Covenant reads files up to 15 MB.</Text>
                ) : (
                  <LoadingButton
                    appearance={contract ? 'subtle' : 'primary'}
                    isLoading={busy === `extract:${a.id}`}
                    isDisabled={busy !== null && busy !== `extract:${a.id}`}
                    onClick={() => void extract(a.id)}
                  >
                    Extract
                  </LoadingButton>
                )}
                {contract && current?.id !== contract.id && (
                  <Button appearance="subtle" onClick={() => setSelected(contract.id)}>
                    Show
                  </Button>
                )}
              </Inline>
            );
          })}
        </Stack>
      )}

      {current?.run && (
        <RunPanel
          key={current.id}
          contract={current}
          run={current.run}
          nowMs={view.nowMs}
          actions={actions}
          runAction={runAction}
          onEditTerms={() => setEditingTerms(current.run)}
          onExtract={() => void extract(current.attachmentId)}
        />
      )}

      <ModalTransition>
        {editing && (
          <EditObligationModal
            item={editing}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              void load();
            }}
          />
        )}
      </ModalTransition>
      <ModalTransition>
        {editingTerms && (
          <EditTermsModal
            run={editingTerms}
            onClose={() => setEditingTerms(null)}
            onSaved={() => {
              setEditingTerms(null);
              void load();
            }}
          />
        )}
      </ModalTransition>
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
