import {
  Box,
  Button,
  Heading,
  Inline,
  Label,
  Link,
  LoadingButton,
  Lozenge,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTransition,
  SectionMessage,
  Select,
  Stack,
  Strong,
  Text,
  TextArea,
  User,
  xcss,
} from '@forge/react';
import { invoke } from '@forge/bridge';
import React, { useState } from 'react';
import type { BriefView, ClauseView, ContextView, Reply } from '../shared/panel';

/**
 * The renewal decision brief in the issue panel: the notice deadline and
 * countdown, the terms, the clauses that govern renewal, the decisions made so
 * far, and marking the contract renewed with a preview of what moves.
 */

/** Runs a resolver and reloads the panel. Resolves to null on success, or the error to show. */
export type RunAction = (key: string, payload: Record<string, unknown>, success?: (data: unknown) => string | null) => Promise<string | null>;

function ErrorText({ error }: { error: string | null }) {
  return error === null ? null : (
    <SectionMessage appearance="error">
      <Text>{error}</Text>
    </SectionMessage>
  );
}

const card = xcss({ borderColor: 'color.border', borderWidth: 'border.width', borderStyle: 'solid', borderRadius: 'radius.medium', padding: 'space.200' });
const quoteBox = xcss({ backgroundColor: 'color.background.neutral', padding: 'space.100', borderRadius: 'radius.medium' });

type Appearance = 'default' | 'inprogress' | 'moved' | 'new' | 'removed' | 'success';

const WINDOW_LABEL: Record<BriefView['window']['status'], [string, Appearance] | null> = {
  due: ['Decision due', 'moved'],
  later: ['Not due yet', 'default'],
  passed: ['Notice deadline passed', 'removed'],
  undated: ['No deadline yet', 'moved'],
  no_notice_rule: null,
};

const OUTCOMES = [
  { value: 'renew', label: 'Renew' },
  { value: 'renegotiate', label: 'Renegotiate' },
  { value: 'terminate', label: 'Terminate' },
];

const where = (c: ClauseView): string => {
  const place = !c.paginated ? 'Word file' : c.page === c.pageEnd ? `page ${c.page}` : `pages ${c.page} to ${c.pageEnd}`;
  return c.section ? `${c.section}, ${place}` : place;
};
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function Countdown({ brief }: { brief: BriefView }) {
  const w = brief.window;
  if (w.status === 'no_notice_rule' || w.status === 'undated') return <Text>{w.note}</Text>;
  const left =
    w.daysLeft === null ? '' : w.daysLeft < 0 ? `passed ${-w.daysLeft} day${w.daysLeft === -1 ? '' : 's'} ago` : w.daysLeft === 0 ? 'today' : `${w.daysLeft} day${w.daysLeft === 1 ? '' : 's'} left`;
  return (
    <Stack space="space.050">
      <Text>
        <Strong>Notice deadline:</Strong> {w.deadline} ({left})
      </Text>
      {w.timing && <Text size="small">Rule: {w.timing}. A decision falls due {brief.leadDays} days before the deadline{w.decisionOpensOn ? `, from ${w.decisionOpensOn}` : ''}.</Text>}
    </Stack>
  );
}

function RecordDecisionModal({ contractId, onClose, run }: { contractId: string; onClose: () => void; run: RunAction }) {
  const [outcome, setOutcome] = useState('renew');
  const [rationale, setRationale] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setSaving(true);
    const failed = await run('decision.record', { contractId, outcome, rationale }, (data) => {
      const d = data as { commentedOn: string | null };
      return `Decision recorded${d.commentedOn ? ` and added to ${d.commentedOn}` : ''}.`;
    });
    setSaving(false);
    if (failed === null) onClose();
    else setError(failed);
  };
  return (
    <Modal onClose={onClose}>
      <ModalHeader>
        <ModalTitle>Record the renewal decision</ModalTitle>
      </ModalHeader>
      <ModalBody>
        <Stack space="space.200">
          <Text>Covenant keeps the decision, your reasons, and a snapshot of this brief as it stands now.</Text>
          <Stack space="space.050">
            <Label labelFor="decision-outcome">Decision</Label>
            <Select
              inputId="decision-outcome"
              options={OUTCOMES}
              value={OUTCOMES.find((o) => o.value === outcome)}
              onChange={(o: { value: string }) => setOutcome(o.value)}
            />
          </Stack>
          <Stack space="space.050">
            <Label labelFor="decision-rationale">Why</Label>
            <TextArea id="decision-rationale" value={rationale} onChange={(e) => setRationale(String(e.target.value ?? ''))} minimumRows={4} />
          </Stack>
          <ErrorText error={error} />
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button appearance="subtle" onClick={onClose}>
          Cancel
        </Button>
        <LoadingButton appearance="primary" isLoading={saving} onClick={save}>
          Record decision
        </LoadingButton>
      </ModalFooter>
    </Modal>
  );
}

function RenewModal({ contractId, termIndex, brief, onClose, run }: { contractId: string; termIndex: number; brief: BriefView; onClose: () => void; run: RunAction }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = brief.nextTerm;
  if (next === null) return null;
  const confirm = async () => {
    setSaving(true);
    const failed = await run('contract.renew', { contractId, fromTermIndex: termIndex }, (data) => {
      const d = data as { termNumber: number; moved: Array<{ label: string; before: string | null; after: string | null }> };
      const moved = d.moved.map((m) => `${m.label}: ${m.before ?? 'no date'} to ${m.after ?? 'no date'}`).join('; ');
      return `Marked renewed. Term ${d.termNumber} is now current.${moved ? ` Moved: ${moved}.` : ' No dates moved.'}`;
    });
    setSaving(false);
    if (failed === null) onClose();
    else setError(failed);
  };
  return (
    <Modal onClose={onClose}>
      <ModalHeader>
        <ModalTitle>{`Mark renewed: start term ${next.number}`}</ModalTitle>
      </ModalHeader>
      <ModalBody>
        <Stack space="space.200">
          <Text>
            Term {next.number} runs from {next.start} to {next.end}. Every date that hangs from the term moves with it:
          </Text>
          {brief.shifts.length === 0 && <Text>No dates move.</Text>}
          {brief.shifts.map((s) => (
            <Text key={s.obligationId}>
              <Strong>{s.label}</Strong>: {s.before ?? 'no date'} to {s.after ?? 'no date'}
            </Text>
          ))}
          <Text size="small">Approved work items keep their dates until you choose to move them. You can undo this.</Text>
          <ErrorText error={error} />
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button appearance="subtle" onClick={onClose}>
          Cancel
        </Button>
        <LoadingButton appearance="primary" isLoading={saving} onClick={confirm}>
          Mark renewed
        </LoadingButton>
      </ModalFooter>
    </Modal>
  );
}

const ago = (ms: number): string => {
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
};

/** Related work, goals, teams and owner suggestions. Loaded only when asked for, as the person asking. */
function BriefContext({ contractId }: { contractId: string }) {
  const [ctx, setCtx] = useState<ContextView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (refresh: boolean) => {
    setLoading(true);
    try {
      const reply = (await invoke<Reply<ContextView>>('brief.context', { contractId, refresh })) as Reply<ContextView>;
      if (reply.ok) {
        setCtx(reply.data);
        setError(null);
      } else setError(reply.error);
    } catch (e) {
      setError(`Covenant did not answer: ${e instanceof Error ? e.message : String(e)}`);
    }
    setLoading(false);
  };

  if (ctx === null) {
    return (
      <Stack space="space.100">
        <Inline>
          <LoadingButton isLoading={loading} onClick={() => void load(false)}>
            Show related work, goals and suggested owners
          </LoadingButton>
        </Inline>
        <ErrorText error={error} />
      </Stack>
    );
  }

  const incidents = ctx.related.filter((r) => r.incident);
  return (
    <Stack space="space.150">
      <Inline space="space.100" alignBlock="center" shouldWrap>
        <Text size="small">
          Context fetched {ago(ctx.fetchedAtMs)}
          {ctx.cached ? ' (saved copy)' : ''}, as you, from Jira and Teamwork Graph.
        </Text>
        <LoadingButton appearance="subtle" isLoading={loading} onClick={() => void load(true)}>
          Refresh
        </LoadingButton>
      </Inline>
      {ctx.problems.length > 0 && (
        <SectionMessage appearance="warning" title="Some context could not be loaded">
          {ctx.problems.map((p) => (
            <Text key={p}>{p}</Text>
          ))}
          <Text size="small">This is missing information, not an empty result.</Text>
        </SectionMessage>
      )}
      <ErrorText error={error} />

      <Stack space="space.100">
        <Text>
          <Strong>Suggested owners</Strong>
        </Text>
        {ctx.owners.length === 0 && (
          <Text size="small">Nobody yet: no one has worked on, commented on or owned anything linked to this contract. Assign the decision item to whoever owns the supplier.</Text>
        )}
        {ctx.owners.map((o) => (
          <Stack key={o.accountId} space="space.050">
            <Inline space="space.100" alignBlock="center">
              <User accountId={o.accountId} />
              <Text size="small">score {o.score}</Text>
            </Inline>
            {o.evidence.map((e) => (
              <Text key={e} size="small">
                {e}
              </Text>
            ))}
          </Stack>
        ))}
      </Stack>

      <Stack space="space.050">
        <Text>
          <Strong>Related work</Strong> ({ctx.related.length}, {incidents.length} incident{incidents.length === 1 ? '' : 's'})
        </Text>
        {ctx.related.length === 0 && <Text size="small">No work items are linked to this contract's work item.</Text>}
        {ctx.related.map((r) => (
          <Inline key={r.key} space="space.100" alignBlock="center" shouldWrap>
            <Link href={`/browse/${r.key}`}>{r.key}</Link>
            <Text size="small">
              {r.summary} ({r.status}
              {r.assignee ? `, ${r.assignee}` : ', unassigned'})
            </Text>
            {r.incident && <Lozenge appearance="removed">Incident</Lozenge>}
            {r.viaCovenant && <Lozenge>Created by Covenant</Lozenge>}
          </Inline>
        ))}
      </Stack>

      <Stack space="space.050">
        <Text>
          <Strong>Goals</Strong>
        </Text>
        {ctx.goals.length === 0 && !ctx.problems.some((p) => p.includes('goals')) && <Text size="small">No goals are linked to this work item.</Text>}
        {ctx.goals.map((g) => (
          <Text key={`${g.key ?? g.name}`} size="small">
            {g.url ? <Link href={g.url}>{g.key ?? g.name}</Link> : (g.key ?? '')} {g.name}
            {g.due ? `, due ${g.due}` : ''}
            {g.owner ? `, owned by ${g.owner}` : ''}
          </Text>
        ))}
      </Stack>

      {(ctx.teams.length > 0 || !ctx.problems.some((p) => p.includes('teams'))) && (
        <Stack space="space.050">
          <Text>
            <Strong>Teams on this space</Strong>
          </Text>
          {ctx.teams.length === 0 && <Text size="small">No teams are linked to this space.</Text>}
          {ctx.teams.map((t) => (
            <Text key={t.name} size="small">
              {t.url ? <Link href={t.url}>{t.name}</Link> : t.name} ({t.members} member{t.members === 1 ? '' : 's'})
            </Text>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

export function RenewalBrief({
  contractId,
  termIndex,
  brief,
  busy,
  run,
}: {
  contractId: string;
  termIndex: number;
  brief: BriefView;
  busy: boolean;
  run: RunAction;
}) {
  const [recording, setRecording] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const label = WINDOW_LABEL[brief.window.status];

  return (
    <Box xcss={card}>
      <Stack space="space.150">
        <Inline space="space.100" alignBlock="center" shouldWrap>
          <Heading size="xsmall">Renewal decision</Heading>
          {label && <Lozenge appearance={label[1]}>{label[0]}</Lozenge>}
        </Inline>
        <Countdown brief={brief} />
        {brief.currentTerm && (
          <Text>
            <Strong>Term {brief.termNumber}:</Strong> {brief.currentTerm.start} to {brief.currentTerm.end}.{' '}
            {brief.autoRenew ? 'It renews automatically unless notice is given.' : 'It renews only if you decide to renew it.'}
          </Text>
        )}
        {brief.renewedAtMs !== null && <Text size="small">Marked renewed on {day(brief.renewedAtMs)}.</Text>}
        {brief.decisionItemKey && (
          <Text>
            Decision item: <Link href={`/browse/${brief.decisionItemKey}`}>{brief.decisionItemKey}</Link>
          </Text>
        )}
        {brief.clauses.map((c) => (
          <Box key={`${c.label}-${c.clause.page}-${c.clause.quote.slice(0, 20)}`} xcss={quoteBox}>
            <Stack space="space.050">
              <Text size="small">
                <Strong>{c.label}</Strong>: {where(c.clause)}
              </Text>
              <Text>“{c.clause.quote}”</Text>
            </Stack>
          </Box>
        ))}

        <BriefContext contractId={contractId} />

        {brief.decisions.length > 0 && (
          <Stack space="space.100">
            <Text>
              <Strong>Decisions</Strong>
            </Text>
            {brief.decisions.map((d) => (
              <Stack key={d.id} space="space.050">
                <Inline space="space.100" alignBlock="center" shouldWrap>
                  <Lozenge appearance={d.outcome === 'terminate' ? 'removed' : d.outcome === 'renew' ? 'success' : 'moved'}>{d.outcomeLabel}</Lozenge>
                  <Text size="small">
                    term {d.termNumber}, {day(d.decidedAtMs)}, by
                  </Text>
                  {/* Covenant erases a closed account's id, as Atlassian's personal data reporting asks. */}
                  {d.decidedBy === 'erased' ? <Text size="small">a former user</Text> : <User accountId={d.decidedBy} />}
                </Inline>
                <Text>{d.rationale}</Text>
              </Stack>
            ))}
          </Stack>
        )}

        {brief.staleWorkItems.length > 0 && (
          <SectionMessage appearance="warning" title="Work items with old due dates">
            {brief.staleWorkItems.map((s) => (
              <Text key={s.obligationId}>
                {s.workItemKey}: {s.stored ?? 'no date'} in Jira, {s.current ?? 'no date'} by the contract now
              </Text>
            ))}
            <Inline>
              <Button isDisabled={busy} onClick={() => void run('contract.moveDates', { contractId }, (data) => {
                const d = data as { moved: string[]; failed: Array<{ key: string; error: string }> };
                return `Moved ${d.moved.length} work item${d.moved.length === 1 ? '' : 's'}${d.failed.length ? `; could not move ${d.failed.map((f) => f.key).join(', ')}` : ''}.`;
              })}>
                Move them to the new dates
              </Button>
            </Inline>
          </SectionMessage>
        )}

        {brief.rolloverBlocked && <Text size="small">{brief.rolloverBlocked}</Text>}
        <Inline space="space.100" shouldWrap>
          <Button appearance="primary" isDisabled={busy} onClick={() => setRecording(true)}>
            Record decision
          </Button>
          {brief.nextTerm && (
            <Button isDisabled={busy} onClick={() => setRenewing(true)}>
              {`Mark renewed: start term ${brief.nextTerm.number}`}
            </Button>
          )}
          {brief.canUndoRenewal && (
            <Button appearance="subtle" isDisabled={busy} onClick={() => void run('contract.undoRenew', { contractId, fromTermIndex: termIndex }, () => 'Renewal undone.')}>
              Undo renewal
            </Button>
          )}
        </Inline>
      </Stack>

      <ModalTransition>{recording && <RecordDecisionModal contractId={contractId} onClose={() => setRecording(false)} run={run} />}</ModalTransition>
      <ModalTransition>
        {renewing && <RenewModal contractId={contractId} termIndex={termIndex} brief={brief} onClose={() => setRenewing(false)} run={run} />}
      </ModalTransition>
    </Box>
  );
}
