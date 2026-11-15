import { Box, Heading, Inline, LoadingButton, Lozenge, SectionMessage, Stack, Strong, Text, xcss } from '@forge/react';
import React from 'react';
import type { EvidenceCheckView, EvidenceFindingView, EvidenceView } from '../shared/evidence';
import type { ClauseView } from '../shared/panel';
import type { RunAction } from './brief';

/**
 * The panel on a work item Covenant created for an approved obligation. A
 * certificate or report attached here is checked against the obligation's
 * clause: pass, fail or needs review, with quotes from both documents. A fail
 * comes with a drafted chase message, which a person may add as a comment.
 * Covenant never sends anything to the supplier.
 */

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

const VERDICT: Record<NonNullable<EvidenceCheckView['verdict']>, [string, 'success' | 'removed' | 'moved']> = {
  pass: ['Pass', 'success'],
  fail: ['Fail', 'removed'],
  needs_review: ['Needs review', 'moved'],
};

const RESULT: Record<EvidenceFindingView['result'], [string, 'success' | 'removed' | 'moved']> = {
  met: ['Met', 'success'],
  not_met: ['Not met', 'removed'],
  not_shown: ['Not shown', 'moved'],
};

const clauseWhere = (c: ClauseView): string => {
  const pages = c.page === c.pageEnd ? `page ${c.page}` : `pages ${c.page} to ${c.pageEnd}`;
  if (c.section) return `${c.section}, ${c.paginated ? pages : 'Word file'}`;
  return c.paginated ? pages : 'Word file (no page numbers)';
};

function Quoted({ label, text, where }: { label: string; text: string; where: string | null }) {
  return (
    <Box xcss={quoteBox}>
      <Stack space="space.050">
        <Text size="small">
          <Strong>{label}</Strong>
          {where ? ` (${where})` : ''}
        </Text>
        <Text>“{text}”</Text>
      </Stack>
    </Box>
  );
}

function CheckResult({ check, clauseWhereText, runAction }: { check: EvidenceCheckView; clauseWhereText: string; runAction: RunAction }) {
  if (check.status === 'queued' || check.status === 'running') return <Text>Checking {check.fileName} against the clause…</Text>;
  if (check.status === 'failed') {
    return (
      <SectionMessage appearance="warning" title="The check did not finish">
        <Text>{check.error ?? 'Try again.'}</Text>
      </SectionMessage>
    );
  }
  const page = (p: number | null) => (check.paginated && p !== null ? `page ${p}` : null);
  return (
    <Stack space="space.150">
      <Inline space="space.100" alignBlock="center" shouldWrap>
        {check.verdict && <Lozenge appearance={VERDICT[check.verdict][1]}>{VERDICT[check.verdict][0]}</Lozenge>}
        {check.documentKind && <Text>Read as: {check.documentKind}</Text>}
        {check.source === 'attachment' && <Text size="small">Checked when the file arrived.</Text>}
      </Inline>
      {check.error && <Text>{check.error}</Text>}
      {check.reasons.length > 0 && (
        <Stack space="space.050">
          {check.reasons.map((r) => (
            <Text key={r}>• {r}</Text>
          ))}
        </Stack>
      )}

      {check.party && (
        <Stack space="space.075">
          <Inline space="space.100" alignBlock="center" shouldWrap>
            <Strong>Named party</Strong>
            {check.party.matches === true && <Lozenge appearance="success">Matches</Lozenge>}
            {check.party.matches === false && <Lozenge appearance="removed">Different party</Lozenge>}
            {check.party.matches === null && <Lozenge appearance="moved">Not compared</Lozenge>}
          </Inline>
          <Text>
            The document names {check.party.nameText}
            {check.party.expected ? `; the clause binds ${check.party.expected}.` : '.'}
          </Text>
          <Quoted label="The document says" text={check.party.quote} where={page(check.party.page)} />
        </Stack>
      )}

      {check.expiry && (
        <Stack space="space.075">
          <Inline space="space.100" alignBlock="center" shouldWrap>
            <Strong>Valid until</Strong>
            {check.expiry.expired === false && <Lozenge appearance="success">Covers the period</Lozenge>}
            {check.expiry.expired === true && <Lozenge appearance="removed">Too short</Lozenge>}
            {check.expiry.expired === null && <Lozenge appearance="moved">Date unclear</Lozenge>}
          </Inline>
          <Text>
            {check.expiry.date ? `The document is valid until ${check.expiry.date}` : `The document says "${check.expiry.dateText}", which Covenant will not guess at`}
            {`; it must be valid through ${check.expiry.requiredUntil}.`}
          </Text>
          <Quoted label="The document says" text={check.expiry.quote} where={page(check.expiry.page)} />
        </Stack>
      )}

      {check.findings.map((f, i) => (
        <Stack key={`${check.id}-${i}`} space="space.075">
          <Inline space="space.100" alignBlock="center" shouldWrap>
            <Lozenge appearance={RESULT[f.result][1]}>{RESULT[f.result][0]}</Lozenge>
            <Text>{f.requirement}</Text>
          </Inline>
          <Quoted label="The contract says" text={f.clauseQuote} where={clauseWhereText} />
          {f.evidenceQuote ? (
            <Quoted label="The document says" text={f.evidenceQuote} where={page(f.evidencePage)} />
          ) : (
            <Text size="small">The document does not mention this.</Text>
          )}
          {f.notes.map((n) => (
            <Text key={n} size="small">
              {n}
            </Text>
          ))}
        </Stack>
      ))}

      {check.chase.length > 0 && (
        <Stack space="space.100">
          <Heading size="xxsmall">Drafted chase message</Heading>
          <Box xcss={quoteBox}>
            <Stack space="space.050">
              {check.chase.map((line, i) => (
                <Text key={`${check.id}-chase-${i}`}>{line === '' ? ' ' : line}</Text>
              ))}
            </Stack>
          </Box>
          {check.commented ? (
            <Text size="small">This draft is on the work item as a comment. Covenant has not sent it to anyone.</Text>
          ) : (
            <Inline space="space.100" alignBlock="center" shouldWrap>
              <LoadingButton
                appearance="default"
                onClick={() => void runAction('evidence.postChase', { checkId: check.id }, () => 'Added the draft as a comment. Covenant has not sent it to anyone.')}
              >
                Add the draft as a comment
              </LoadingButton>
              <Text size="small">Copy it into an email to the supplier yourself; Covenant never sends it.</Text>
            </Inline>
          )}
        </Stack>
      )}
    </Stack>
  );
}

export function EvidenceSection({ view, busy, runAction }: { view: EvidenceView; busy: string | null; runAction: RunAction }) {
  const clauseWhereText = view.clause ? clauseWhere(view.clause) : 'the contract';
  const files = view.attachments.filter((a) => a.supported);
  return (
    <Stack space="space.200">
      <Stack space="space.100">
        <Heading size="xsmall">Evidence for this obligation</Heading>
        <Text>
          {view.kindLabel}: {view.summary} Responsible: {view.party}. From {view.contractFile} on {view.contractKey}.
        </Text>
        {view.clause && <Quoted label="The clause" text={view.clause.quote} where={clauseWhereText} />}
        <Text size="small">
          {view.expectsDocument
            ? 'Attach the certificate or report the other party sent, and Covenant checks it against this clause when it arrives. You can also check a file here.'
            : 'This obligation does not usually come with a document, but you can check a file against its clause here.'}
          {view.requiredUntil ? ` A document must be valid through ${view.requiredUntil}, the next date this clause asks for one.` : ''}
          {view.expectedParty ? ` It should name ${view.expectedParty}.` : ' Covenant does not know the bound party’s name yet: confirm the parties on the contract’s work item.'}
        </Text>
      </Stack>

      {files.length === 0 && <Text>No PDF or Word file is attached to this work item yet.</Text>}
      {view.sampleCertificates && (
        <Box xcss={card}>
          <Stack space="space.100">
            <Text>
              <Strong>Try it with the sample workspace.</Strong> Attach an invented certificate to this work item and Covenant checks it: one should pass, the other names
              another company, has a lower limit and runs out too soon.
            </Text>
            <Inline space="space.100" shouldWrap>
              <LoadingButton
                isLoading={busy === 'action:evidence.attachSample'}
                isDisabled={busy !== null}
                onClick={() => void runAction('evidence.attachSample', { variant: 'valid' }, () => 'Attached the sample certificate. Covenant is checking it.')}
              >
                Attach a certificate that should pass
              </LoadingButton>
              <LoadingButton
                isDisabled={busy !== null}
                onClick={() => void runAction('evidence.attachSample', { variant: 'problems' }, () => 'Attached the sample certificate with problems. Covenant is checking it.')}
              >
                Attach one with problems
              </LoadingButton>
            </Inline>
          </Stack>
        </Box>
      )}
      {files.map((a) => (
        <Box key={a.id} xcss={card}>
          <Stack space="space.150">
            <Inline space="space.100" alignBlock="center" shouldWrap>
              <Strong>{a.fileName}</Strong>
              {a.tooLarge ? (
                <Text size="small">Too large: Covenant reads files up to 15 MB.</Text>
              ) : (
                (a.check === null || a.check.status === 'failed') && (
                  <LoadingButton
                    appearance={a.check === null ? 'primary' : 'default'}
                    isLoading={busy === 'action:evidence.check'}
                    isDisabled={busy !== null}
                    onClick={() => void runAction('evidence.check', { attachmentId: a.id }, () => `Checking ${a.fileName} against the clause.`)}
                  >
                    {a.check === null ? 'Check against the clause' : 'Try again'}
                  </LoadingButton>
                )
              )}
            </Inline>
            {a.check && <CheckResult check={a.check} clauseWhereText={clauseWhereText} runAction={runAction} />}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}
