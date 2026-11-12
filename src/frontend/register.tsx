import { invoke } from '@forge/bridge';
import ForgeReconciler, { Button, DynamicTable, Inline, Link, Lozenge, SectionMessage, Spinner, Stack, Strong, Text, User } from '@forge/react';
import React, { useCallback, useEffect, useState } from 'react';
import type { Reply } from '../shared/panel';
import type { RegisterRowView, RegisterView } from '../shared/register';

/** The Covenant register: every obligation on contracts you can see, by due date. */

const WINDOWS: Array<{ days: 30 | 60 | 90 | null; label: string }> = [
  { days: 30, label: 'Next 30 days' },
  { days: 60, label: 'Next 60 days' },
  { days: 90, label: 'Next 90 days' },
  { days: null, label: 'All' },
];

const when = (row: RegisterRowView): string => {
  if (row.due === null) return 'No date yet';
  if (row.daysLeft === null) return row.due;
  if (row.daysLeft === 0) return `${row.due} (today)`;
  return row.daysLeft > 0 ? `${row.due} (in ${row.daysLeft} day${row.daysLeft === 1 ? '' : 's'})` : `${row.due} (${-row.daysLeft} days ago)`;
};

const HEAD = {
  cells: [
    { key: 'due', content: 'Due' },
    { key: 'obligation', content: 'Obligation' },
    { key: 'contract', content: 'Contract' },
    { key: 'owner', content: 'Owner' },
    { key: 'flags', content: 'Flags' },
  ],
};

function rowsOf(view: RegisterView) {
  return view.rows.map((row) => ({
    key: row.obligationId,
    cells: [
      { key: 'due', content: <Text>{when(row)}</Text> },
      {
        key: 'obligation',
        content: (
          <Stack space="space.050">
            <Inline space="space.050" alignBlock="center" shouldWrap>
              <Lozenge>{row.kindLabel}</Lozenge>
              <Text>{row.summary}</Text>
            </Inline>
            <Text size="small">
              {row.party}: {row.timing}
            </Text>
          </Stack>
        ),
      },
      {
        key: 'contract',
        content: (
          <Stack space="space.050">
            <Link href={`/browse/${row.issueKey}`}>{row.issueKey}</Link>
            <Text size="small">{row.fileName}</Text>
          </Stack>
        ),
      },
      {
        key: 'owner',
        content: row.owner ? (
          <Stack space="space.050">
            <User accountId={row.owner.accountId} />
            {row.workItemKey && <Link href={`/browse/${row.workItemKey}`}>{row.workItemKey}</Link>}
          </Stack>
        ) : (
          <Text size="small">{row.workItemKey ? `${row.workItemKey}, unassigned` : 'Not approved yet'}</Text>
        ),
      },
      {
        key: 'flags',
        content: (
          <Inline space="space.050" shouldWrap>
            {row.flags.insideNoticeWindow && <Lozenge appearance="moved">Inside notice window</Lozenge>}
            {row.flags.noOwner && <Lozenge appearance="removed">No owner</Lozenge>}
            {row.flags.overdue && <Lozenge appearance="removed">Overdue</Lozenge>}
          </Inline>
        ),
      },
    ],
  }));
}

const App = () => {
  const [windowDays, setWindowDays] = useState<30 | 60 | 90 | null>(90);
  const [view, setView] = useState<RegisterView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (days: 30 | 60 | 90 | null) => {
    setLoading(true);
    try {
      const reply = (await invoke<Reply<RegisterView>>('register.load', { windowDays: days })) as Reply<RegisterView>;
      if (reply.ok) {
        setView(reply.data);
        setError(null);
      } else setError(reply.error);
    } catch (e) {
      setError(`Covenant did not answer: ${e instanceof Error ? e.message : String(e)}`);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(windowDays);
  }, [load, windowDays]);

  return (
    <Stack space="space.200">
      <Inline space="space.100" shouldWrap>
        {WINDOWS.map((w) => (
          <Button key={w.label} appearance={windowDays === w.days ? 'primary' : 'default'} onClick={() => setWindowDays(w.days)}>
            {w.label}
          </Button>
        ))}
      </Inline>
      {error && (
        <SectionMessage appearance="error" title="The register could not load">
          <Text>{error}</Text>
        </SectionMessage>
      )}
      {view === null && loading && <Spinner />}
      {view && (
        <Stack space="space.150">
          <Text>
            <Strong>{view.counts.contracts}</Strong> contract{view.counts.contracts === 1 ? '' : 's'}. <Strong>{view.counts.insideNoticeWindow}</Strong> notice
            deadline{view.counts.insideNoticeWindow === 1 ? '' : 's'} inside the {view.leadDays}-day decision window, <Strong>{view.counts.noOwner}</Strong>{' '}
            with no owner, <Strong>{view.counts.overdue}</Strong> overdue.
          </Text>
          {view.hiddenContracts > 0 && (
            <Text size="small">
              {view.hiddenContracts} contract{view.hiddenContracts === 1 ? ' is' : 's are'} on work items you cannot see, so {view.hiddenContracts === 1 ? 'it is' : 'they are'} not
              shown.
            </Text>
          )}
          <DynamicTable
            head={HEAD}
            rows={rowsOf(view)}
            isLoading={loading}
            rowsPerPage={25}
            emptyView={
              <Text>
                {view.counts.contracts === 0
                  ? "No contracts yet. Attach one to a work item and click Extract in its Covenant panel, or load the sample workspace from Covenant's admin page."
                  : windowDays === null
                    ? 'Nothing to show.'
                    : `Nothing falls due in the next ${windowDays} days.`}
              </Text>
            }
          />
        </Stack>
      )}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
