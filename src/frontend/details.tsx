import { invoke } from '@forge/bridge';
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
  SectionMessage,
  Select,
  Spinner,
  Stack,
  Strong,
  Text,
  Textfield,
  xcss,
} from '@forge/react';
import React, { useState } from 'react';
import type { DetailBase, DetailsView, NoticeDraftView, SupplierRecordView } from '../shared/details';
import type { BriefView, ClauseView, Reply } from '../shared/panel';
import type { RunAction } from './brief';

/**
 * The second reading in the panel: who the parties are, where and how to give
 * notice with the latest send date per method, what the contract is worth,
 * and the supplier's record against the contract's own service levels.
 * Every item shows its clause, and a person can confirm or reject each one.
 */

const card = xcss({ borderColor: 'color.border', borderWidth: 'border.width', borderStyle: 'solid', borderRadius: 'radius.medium', padding: 'space.200' });
const quoteBox = xcss({ backgroundColor: 'color.background.neutral', padding: 'space.100', borderRadius: 'radius.medium' });

const where = (c: ClauseView): string => {
  const place = !c.paginated ? 'Word file' : c.page === c.pageEnd ? `page ${c.page}` : `pages ${c.page} to ${c.pageEnd}`;
  return c.section ? `${c.section}, ${place}` : place;
};

const timeZone = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
};

async function call<T>(key: string, payload: Record<string, unknown>): Promise<Reply<T>> {
  try {
    return (await invoke<Reply<T>>(key, payload)) as Reply<T>;
  } catch (error) {
    return { ok: false, error: `Covenant did not answer: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function Clause({ clause }: { clause: ClauseView }) {
  return (
    <Box xcss={quoteBox}>
      <Stack space="space.050">
        <Text>“{clause.quote}”</Text>
        <Text size="small">{where(clause)}</Text>
      </Stack>
    </Box>
  );
}

/** The clause, any warning, and Confirm, Reject or Undo for one item. */
function Reviewed({ item, contractId, run, busy }: { item: DetailBase; contractId: string; run: RunAction; busy: boolean }) {
  const decide = (decision: 'pending' | 'confirmed' | 'rejected') => void run('details.decide', { contractId, detailId: item.id, decision });
  return (
    <Stack space="space.050">
      <Clause clause={item.clause} />
      {item.needsReview && item.review.map((line) => (
        <Text key={line} size="small">
          Check this: {line}
        </Text>
      ))}
      <Inline space="space.100" alignBlock="center">
        {item.decision === 'confirmed' && <Lozenge appearance="success">Confirmed</Lozenge>}
        {item.decision === 'rejected' && <Lozenge appearance="removed">Rejected</Lozenge>}
        {item.decision === 'pending' && item.needsReview && <Lozenge appearance="moved">Needs review</Lozenge>}
        {item.decision === 'pending' ? (
          <>
            <Button spacing="compact" isDisabled={busy} onClick={() => decide('confirmed')}>
              Confirm
            </Button>
            <Button spacing="compact" appearance="subtle" isDisabled={busy} onClick={() => decide('rejected')}>
              Reject
            </Button>
          </>
        ) : (
          <Button spacing="compact" appearance="subtle" isDisabled={busy} onClick={() => decide('pending')}>
            Undo
          </Button>
        )}
      </Inline>
    </Stack>
  );
}

function DraftModal({ contractId, kind, onClose }: { contractId: string; kind: 'non_renewal' | 'renewal'; onClose: () => void }) {
  const [draft, setDraft] = useState<NoticeDraftView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  if (!asked) {
    setAsked(true);
    void call<NoticeDraftView>('details.noticeDraft', { contractId, kind, timeZone: timeZone() }).then((reply) => (reply.ok ? setDraft(reply.data) : setError(reply.error)));
  }
  return (
    <Modal onClose={onClose} width="large">
      <ModalHeader>
        <ModalTitle>{draft?.title ?? 'Drafted notice'}</ModalTitle>
      </ModalHeader>
      <ModalBody>
        <Stack space="space.100">
          {draft === null && error === null && <Spinner />}
          {error !== null && (
            <SectionMessage appearance="error">
              <Text>{error}</Text>
            </SectionMessage>
          )}
          {draft?.lines.map((l, i) =>
            l.style === 'banner' ? (
              <SectionMessage key={`${i}-b`} appearance="warning">
                <Text>{l.text}</Text>
              </SectionMessage>
            ) : l.style === 'heading' ? (
              <Text key={`${i}-h`}>
                <Strong>{l.text}</Strong>
              </Text>
            ) : l.style === 'quote' ? (
              <Box key={`${i}-q`} xcss={quoteBox}>
                <Text>“{l.text}”</Text>
              </Box>
            ) : (
              <Text key={`${i}-t`} size={l.style === 'note' ? 'small' : 'medium'}>
                {l.text}
              </Text>
            ),
          )}
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button onClick={onClose}>Close</Button>
      </ModalFooter>
    </Modal>
  );
}

function Notices({ contractId, details, brief, run, busy }: { contractId: string; details: DetailsView; brief: BriefView; run: RunAction; busy: boolean }) {
  const [drafting, setDrafting] = useState(false);
  const partyOptions = details.parties.filter((p) => p.decision !== 'rejected').map((p) => ({ label: `${p.label} (${p.name})`, value: p.label }));
  const liveMethods = details.methods.filter((m) => m.decision !== 'rejected');
  const liveAddresses = details.addresses.filter((a) => a.decision !== 'rejected');
  const kind = brief.autoRenew ? 'non_renewal' : 'renewal';
  return (
    <Box xcss={card}>
      <Stack space="space.150">
        <Inline space="space.100" alignBlock="center" spread="space-between" shouldWrap>
          <Heading size="xsmall">Giving notice</Heading>
          <Button appearance="subtle" onClick={() => setDrafting(true)} isDisabled={details.deadline === null}>
            Preview the drafted notice
          </Button>
        </Inline>
        {details.noticeItemKey && (
          <Inline space="space.100" alignBlock="center" shouldWrap>
            <Text>
              Notice work item, with the drafted letter: <Link href={`/browse/${details.noticeItemKey}`}>{details.noticeItemKey}</Link>
            </Text>
            <Button
              spacing="compact"
              appearance="subtle"
              isDisabled={busy || details.deadline === null}
              onClick={() =>
                void run('details.refreshNoticeItem', { contractId, timeZone: timeZone() }, (data) => {
                  const r = data as { key: string; dueDateSet: boolean };
                  return `Put the current letter and send-by date on ${r.key}.${r.dueDateSet ? '' : ' Its due date could not be set: that work type leaves Due date off its edit screen.'}`;
                })
              }
            >
              Update the letter
            </Button>
          </Inline>
        )}
        {details.deadline !== null && liveMethods.length > 0 && (
          <Text>
            <Strong>Must be received by {details.deadline}.</Strong>
            {details.sendBy ? ` To be safe by any listed method, send by ${details.sendBy}.` : ''}
          </Text>
        )}
        {liveMethods.length === 0 && liveAddresses.length === 0 && (
          <Text>
            Covenant found no notices clause in this contract, so it shows only the deadline{details.deadline ? ` (${details.deadline})` : ''}. Check the contract for how and
            where notice must be given.
          </Text>
        )}

        {partyOptions.length > 0 && (
          <Stack space="space.050">
            <Label labelFor={`party-${contractId}`}>Which party are you? The drafted notice goes to the other one.</Label>
            <Select
              inputId={`party-${contractId}`}
              options={partyOptions}
              value={partyOptions.find((o) => o.value === details.ourParty)}
              placeholder="Choose your organisation"
              onChange={(o: { value: string }) => void run('details.setParty', { contractId, label: o.value })}
            />
          </Stack>
        )}

        {details.methods.map((m) => (
          <Stack key={m.id} space="space.050">
            <Text>
              <Strong>{m.label}:</Strong> {m.latest ? `send by ${m.latest}` : 'no send-by date'}. {m.rule}
            </Text>
            {m.steps.length > 0 && <Text size="small">{m.steps.join(' → ')}</Text>}
            <Reviewed item={m} contractId={contractId} run={run} busy={busy} />
          </Stack>
        ))}
        {details.addresses.map((a) => (
          <Stack key={a.id} space="space.050">
            <Text>
              <Strong>Address for notices to {a.party}</Strong>
            </Text>
            <Reviewed item={a} contractId={contractId} run={run} busy={busy} />
          </Stack>
        ))}
        {details.parties.length > 0 && (
          <Text size="small">
            Parties: {details.parties.filter((p) => p.decision !== 'rejected').map((p) => `${p.name} ("${p.label}")`).join(', ')}.
          </Text>
        )}
      </Stack>
      {drafting && <DraftModal contractId={contractId} kind={kind} onClose={() => setDrafting(false)} />}
    </Box>
  );
}

function Value({ contractId, details, run, busy }: { contractId: string; details: DetailsView; run: RunAction; busy: boolean }) {
  return (
    <Box xcss={card}>
      <Stack space="space.150">
        <Heading size="xsmall">Contract value</Heading>
        {details.values.length === 0 && <Text>Covenant found no stated fee or price in this contract.</Text>}
        {details.values.map((v) => (
          <Stack key={v.id} space="space.050">
            <Text>
              <Strong>{v.amount ?? `"${v.amountText}" (not read with certainty)`}</Strong>
              {v.period === 'one_time' ? ', one payment' : v.period === 'term' ? ' for the whole term' : ` each ${v.period}`}: {v.description}
              {v.yearly ? `. That is ${v.yearly}.` : '.'}
            </Text>
            <Reviewed item={v} contractId={contractId} run={run} busy={busy} />
          </Stack>
        ))}
        {details.values.some((v) => v.decision === 'pending') && (
          <Text size="small">Only a confirmed value is counted in the register's totals and used to work out service credits. Code does the sums.</Text>
        )}
      </Stack>
    </Box>
  );
}

function SupplierRecord({ contractId, details, run, busy }: { contractId: string; details: DetailsView; run: RunAction; busy: boolean }) {
  const [record, setRecord] = useState<SupplierRecordView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jql, setJql] = useState(details.supplierJql);
  const [claiming, setClaiming] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const reply = await call<SupplierRecordView>('details.supplierRecord', { contractId, timeZone: timeZone() });
    setLoading(false);
    setRecord(reply.ok ? reply.data : null);
    setError(reply.ok ? null : reply.error);
  };
  const saveFilter = async () => {
    const failed = await run('details.setFilter', { contractId, jql }, () => 'Supplier filter saved.');
    if (failed === null) await load();
    else setError(failed);
  };
  const claim = async (detailId: string, breachKey: string) => {
    setClaiming(`${detailId}:${breachKey}`);
    const reply = await call<{ key: string; created: boolean }>('details.openClaim', { contractId, detailId, breachKey, timeZone: timeZone() });
    setClaiming(null);
    if (reply.ok) await load();
    else setError(reply.error);
  };

  return (
    <Box xcss={card}>
      <Stack space="space.150">
        <Inline space="space.100" alignBlock="center" spread="space-between" shouldWrap>
          <Heading size="xsmall">Supplier record this term</Heading>
          <LoadingButton isLoading={loading} onClick={() => void load()} isDisabled={details.serviceLevels.length === 0}>
            {record ? 'Check Jira again' : 'Check against Jira'}
          </LoadingButton>
        </Inline>
        {details.serviceLevels.length === 0 && <Text>Covenant found no measurable service levels in this contract.</Text>}
        {details.serviceLevels.map((s) => (
          <Stack key={s.id} space="space.050">
            <Inline space="space.100" alignBlock="center" shouldWrap>
              <Text>
                <Strong>{s.commitment}.</Strong> {s.summary}
              </Text>
              {!s.measurable && <Lozenge>Cannot be measured here</Lozenge>}
            </Inline>
            <Reviewed item={s} contractId={contractId} run={run} busy={busy} />
            {s.credit && (
              <Text size="small">
                Service credit{s.credit.terms ? `: ${s.credit.terms}` : ''}: “{s.credit.clause.quote}” ({where(s.credit.clause)})
              </Text>
            )}
            {s.claim && (
              <Text size="small">
                Claim deadline: {s.claim.terms}: “{s.claim.clause.quote}” ({where(s.claim.clause)})
              </Text>
            )}
          </Stack>
        ))}

        {error !== null && (
          <SectionMessage appearance="error">
            <Text>{error}</Text>
          </SectionMessage>
        )}
        {record && (
          <Stack space="space.150">
            {record.problems.map((p) => (
              <SectionMessage key={p} appearance="warning">
                <Text>{p}</Text>
              </SectionMessage>
            ))}
            <Text size="small">
              The filter matched {record.matched} work item{record.matched === 1 ? '' : 's'}, {record.incidents} of them incidents
              {record.term ? `, measured over term ${record.term.number} (${record.term.start} to ${record.term.end})` : ''}. Code counted them; items Covenant
              created are left out.
            </Text>
            {record.incidents === 0 && record.problems.length === 0 && (
              <Text size="small">No history yet: no incidents match this supplier's filter. Link incidents to this work item, or change the filter below.</Text>
            )}
            {record.records.map((r) => (
              <Stack key={r.detailId} space="space.050">
                <Inline space="space.100" alignBlock="center" shouldWrap>
                  <Text>
                    <Strong>{r.summary}</Strong> ({r.where})
                  </Text>
                  {r.status === 'cannot_measure' ? (
                    <Lozenge>Cannot be measured here</Lozenge>
                  ) : r.breaches.length > 0 ? (
                    <Lozenge appearance="removed">{r.breaches.length === 1 ? '1 breach' : `${r.breaches.length} breaches`}</Lozenge>
                  ) : (
                    <Lozenge appearance="success">Met</Lozenge>
                  )}
                </Inline>
                <Text size="small">{r.observed}</Text>
                {r.breaches.map((b) => (
                  <Inline key={b.key} space="space.100" alignBlock="center" shouldWrap>
                    <Text size="small">
                      {b.detail}{' '}
                      {b.workItems.map((k) => (
                        <Link key={k} href={`/browse/${k}`}>
                          {k}{' '}
                        </Link>
                      ))}
                      {b.claimBy ? (b.claimOpen ? `Claim by ${b.claimBy}.` : `The claim window closed on ${b.claimBy}.`) : 'The contract sets no claim deadline.'}
                    </Text>
                    {b.claimItemKey ? (
                      <Link href={`/browse/${b.claimItemKey}`}>Claim item {b.claimItemKey}</Link>
                    ) : (
                      b.claimOpen !== false && (
                        <LoadingButton spacing="compact" isLoading={claiming === `${r.detailId}:${b.key}`} onClick={() => void claim(r.detailId, b.key)}>
                          Open a claim work item
                        </LoadingButton>
                      )
                    )}
                  </Inline>
                ))}
                {r.credit && (
                  <Text size="small">
                    <Strong>Service credit: {r.credit}.</Strong> {r.creditNote}
                  </Text>
                )}
                {!r.credit && r.creditNote && <Text size="small">{r.creditNote}</Text>}
              </Stack>
            ))}
            {record.leverage && (
              <Box xcss={quoteBox}>
                <Stack space="space.050">
                  {record.leverage.filter((l) => l.trim() !== '').map((l, i) => (
                    <Text key={`${i}-${l}`} size="small">
                      {l}
                    </Text>
                  ))}
                </Stack>
              </Box>
            )}
          </Stack>
        )}

        <Stack space="space.050">
          <Label labelFor={`jql-${contractId}`}>Work involving this supplier (a Jira filter in JQL)</Label>
          <Inline space="space.100" alignBlock="center">
            <Textfield id={`jql-${contractId}`} value={jql} onChange={(e) => setJql(String(e.target.value ?? ''))} />
            <Button onClick={() => void saveFilter()} isDisabled={busy || jql.trim() === details.supplierJql}>
              Save filter
            </Button>
          </Inline>
          <Text size="small">By default: everything linked to this work item. Incidents are work items of type Incident, Bug or Problem, or labelled "incident".</Text>
        </Stack>
      </Stack>
    </Box>
  );
}

export function DetailsSection({ contractId, details, brief, run, busy }: { contractId: string; details: DetailsView; brief: BriefView; run: RunAction; busy: boolean }) {
  if (details.status === 'queued' || details.status === 'running') {
    return (
      <Box xcss={card}>
        <Inline space="space.100" alignBlock="center">
          <Spinner size="small" />
          <Text>Reading the notices clause, the contract value and the service levels…</Text>
        </Inline>
      </Box>
    );
  }
  if (details.status === 'none' || details.status === 'failed') {
    return (
      <Box xcss={card}>
        <Stack space="space.100">
          <Heading size="xsmall">Notices, value and service levels</Heading>
          <Text>
            {details.status === 'failed'
              ? `The second reading did not finish. ${details.error ?? ''}`
              : 'This contract was extracted before Covenant read notice addresses, delivery methods, contract value and service levels. One more model call reads them.'}
          </Text>
          <Inline>
            <Button onClick={() => void run('details.read', { contractId }, () => 'Reading the details. This takes a few seconds.')} isDisabled={busy}>
              {details.status === 'failed' ? 'Try again' : 'Read them now'}
            </Button>
          </Inline>
        </Stack>
      </Box>
    );
  }
  return (
    <Stack space="space.200">
      <Notices contractId={contractId} details={details} brief={brief} run={run} busy={busy} />
      <Value contractId={contractId} details={details} run={run} busy={busy} />
      <SupplierRecord contractId={contractId} details={details} run={run} busy={busy} />
      {details.grounding && (
        <Text size="small">
          Second reading: {details.grounding.verified} of {details.grounding.returned} quotes were found word for word in the contract
          {details.grounding.rejected > 0 ? `; ${details.grounding.rejected} ${details.grounding.rejected === 1 ? 'item that failed' : 'items that failed'} Covenant's checks ${details.grounding.rejected === 1 ? 'was' : 'were'} dropped` : ''}.
        </Text>
      )}
    </Stack>
  );
}
