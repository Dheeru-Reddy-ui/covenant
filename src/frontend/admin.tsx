import { invoke } from '@forge/bridge';
import ForgeReconciler, {
  Box,
  Button,
  Checkbox,
  Heading,
  Inline,
  Label,
  Link,
  LoadingButton,
  Lozenge,
  SectionMessage,
  Select,
  Spinner,
  Stack,
  Strong,
  Text,
  Textfield,
  xcss,
} from '@forge/react';
import React, { useCallback, useEffect, useState } from 'react';
import type { AdminView, CheckStatus, PreflightCheck, SampleStatus } from '../shared/admin';
import type { Reply } from '../shared/panel';

/** Covenant's admin page: preflight checks, the decision lead time, the daily check, and the sample workspace. */

const card = xcss({ borderColor: 'color.border', borderWidth: 'border.width', borderStyle: 'solid', borderRadius: 'radius.medium', padding: 'space.200' });

const STATUS: Record<CheckStatus, [string, 'success' | 'moved' | 'removed' | 'new']> = {
  pass: ['Pass', 'success'],
  warn: ['Warning', 'moved'],
  fail: ['Fail', 'removed'],
  manual: ['Check by hand', 'new'],
};

async function call<T>(key: string, payload?: Record<string, unknown>): Promise<Reply<T>> {
  try {
    return (await invoke<Reply<T>>(key, payload)) as Reply<T>;
  } catch (error) {
    return { ok: false, error: `Covenant did not answer: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const stamp = (ms: number): string => `${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)} UTC`;

function Preflight() {
  const [checks, setChecks] = useState<PreflightCheck[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async () => {
    setRunning(true);
    const reply = await call<PreflightCheck[]>('admin.preflight');
    setRunning(false);
    if (reply.ok) {
      setChecks(reply.data);
      setError(null);
    } else setError(reply.error);
  }, []);
  useEffect(() => {
    void run();
  }, [run]);

  return (
    <Box xcss={card}>
      <Stack space="space.150">
        <Inline space="space.100" alignBlock="center" spread="space-between">
          <Heading size="small">Preflight</Heading>
          <LoadingButton isLoading={running} onClick={() => void run()}>
            Run checks again
          </LoadingButton>
        </Inline>
        {error && (
          <SectionMessage appearance="error">
            <Text>{error}</Text>
          </SectionMessage>
        )}
        {checks === null && running && <Spinner />}
        {checks?.map((c) => (
          <Stack key={c.key} space="space.050">
            <Inline space="space.100" alignBlock="center">
              <Lozenge appearance={STATUS[c.status][1]}>{STATUS[c.status][0]}</Lozenge>
              <Strong>{c.title}</Strong>
            </Inline>
            <Text>{c.detail}</Text>
            {c.fix && <Text size="small">{c.fix}</Text>}
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}

function Settings({ view, reload }: { view: AdminView; reload: () => void }) {
  const [days, setDays] = useState(String(view.leadDays));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async () => {
    setSaving(true);
    const reply = await call<null>('admin.saveLeadDays', { days: Number.parseInt(days, 10) });
    setSaving(false);
    setMessage(reply.ok ? { ok: true, text: 'Saved.' } : { ok: false, text: reply.error });
    if (reply.ok) reload();
  };
  return (
    <Box xcss={card}>
      <Stack space="space.150">
        <Heading size="small">Decision lead time</Heading>
        <Text>
          The daily check opens a "Decision due" work item this many days before a contract's notice deadline, and the register flags notice deadlines inside this
          window.
        </Text>
        <Inline space="space.100" alignBlock="end">
          <Stack space="space.050">
            <Label labelFor="lead-days">{`Days (${view.minLeadDays} to ${view.maxLeadDays})`}</Label>
            <Textfield id="lead-days" type="number" width={100} value={days} onChange={(e) => setDays(String(e.target.value ?? ''))} />
          </Stack>
          <LoadingButton appearance="primary" isLoading={saving} onClick={() => void save()}>
            Save
          </LoadingButton>
        </Inline>
        {message && <Text size="small">{message.text}</Text>}
      </Stack>
    </Box>
  );
}

function DailyCheck({ view, reload }: { view: AdminView; reload: () => void }) {
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const run = async () => {
    setRunning(true);
    const reply = await call<{ contracts: number; due: number; opened: string[]; failed: number }>('admin.runDaily');
    setRunning(false);
    setMessage(
      reply.ok
        ? `Checked ${reply.data.contracts} contracts: ${reply.data.due} with a decision due, ${reply.data.opened.length} decision items opened${reply.data.opened.length ? ` (${reply.data.opened.join(', ')})` : ''}, ${reply.data.failed} failed.`
        : reply.error,
    );
    if (reply.ok) reload();
  };
  const last = view.lastDailyRun;
  return (
    <Box xcss={card}>
      <Stack space="space.150">
        <Heading size="small">Daily decision check</Heading>
        <Text>
          Once a day Covenant recomputes every contract's notice window and opens one "Decision due" work item per contract and term when the deadline comes inside
          the lead time. It runs as the app and does not read Teamwork Graph.
        </Text>
        <Text size="small">
          {last
            ? `Last run ${stamp(last.atMs)} (${last.source}): ${last.contracts} contracts, ${last.due} due, ${last.opened.length} opened, ${last.failed} failed.`
            : 'It has not run yet.'}
        </Text>
        <Inline>
          <LoadingButton isLoading={running} onClick={() => void run()}>
            Run the daily check now
          </LoadingButton>
        </Inline>
        {message && <Text size="small">{message}</Text>}
      </Stack>
    </Box>
  );
}

function SampleWorkspace({ view, reload }: { view: AdminView; reload: () => void }) {
  const options = view.projects.map((p) => ({ label: `${p.name} (${p.key})`, value: p.id }));
  const [projectId, setProjectId] = useState<string | null>(options[0]?.value ?? null);
  const [again, setAgain] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sample: SampleStatus | null = view.sample;
  const loading = sample !== null && (sample.status === 'queued' || sample.status === 'running');

  useEffect(() => {
    if (!loading) return undefined;
    const timer = setTimeout(reload, 3000);
    return () => clearTimeout(timer);
  }, [loading, sample, reload]);

  const start = async () => {
    if (projectId === null) return;
    setStarting(true);
    const reply = await call<SampleStatus>('admin.loadSample', { projectId, again });
    setStarting(false);
    setError(reply.ok ? null : reply.error);
    reload();
  };

  return (
    <Box xcss={card}>
      <Stack space="space.150">
        <Heading size="small">Sample workspace</Heading>
        <Text>
          Creates three fictional contracts as work items in a project you choose, each with its Word file attached, plus related work and incidents linked to them,
          and queues each contract for extraction. Their notice deadlines fall about 20, 50 and 85 days from today. Extraction uses a few cents of model tokens.
        </Text>
        {options.length === 0 ? (
          <Text>You cannot create work items in any project yet. Create a project (any template), then reload this page.</Text>
        ) : (
          <Inline space="space.100" alignBlock="end" shouldWrap>
            <Stack space="space.050">
              <Label labelFor="sample-project">Project</Label>
              <Select
                inputId="sample-project"
                options={options}
                value={options.find((o) => o.value === projectId)}
                onChange={(o: { value: string }) => setProjectId(o.value)}
              />
            </Stack>
            <LoadingButton appearance="primary" isLoading={starting} isDisabled={loading || projectId === null} onClick={() => void start()}>
              Load sample workspace
            </LoadingButton>
          </Inline>
        )}
        {sample?.status === 'done' && <Checkbox label="Load again (creates a second copy)" isChecked={again} onChange={(e) => setAgain(Boolean(e.target.checked))} />}
        {error && (
          <SectionMessage appearance="error">
            <Text>{error}</Text>
          </SectionMessage>
        )}
        {sample && (
          <Stack space="space.100">
            <Inline space="space.100" alignBlock="center">
              <Lozenge appearance={sample.status === 'done' ? 'success' : sample.status === 'failed' ? 'removed' : 'inprogress'}>{sample.status}</Lozenge>
              <Text size="small">
                {sample.projectKey}, started {stamp(sample.startedAtMs)}. {sample.step}
              </Text>
              {loading && <Spinner size="small" />}
            </Inline>
            {sample.error && <Text>{sample.error}</Text>}
            {sample.contracts.map((c) => (
              <Text key={c.key}>
                <Link href={`/browse/${c.key}`}>{c.key}</Link> {c.summary} (extraction {c.extraction})
              </Text>
            ))}
            {sample.related.length > 0 && <Text size="small">Related work: {sample.related.join(', ')}</Text>}
          </Stack>
        )}
      </Stack>
    </Box>
  );
}

const App = () => {
  const [view, setView] = useState<AdminView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const reply = await call<AdminView>('admin.load');
    if (reply.ok) {
      setView(reply.data);
      setError(null);
    } else setError(reply.error);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const reload = useCallback(() => void load(), [load]);

  if (error) {
    return (
      <SectionMessage appearance="error" title="Covenant's admin page could not load">
        <Text>{error}</Text>
      </SectionMessage>
    );
  }
  if (view === null) return <Spinner />;
  return (
    <Stack space="space.300">
      <Preflight />
      <SampleWorkspace view={view} reload={reload} />
      <DailyCheck view={view} reload={reload} />
      <Settings view={view} reload={reload} />
      <Text size="small">
        Covenant reads contracts with Forge LLMs, stores what it finds in Forge SQL, and calls no outside service. App id {view.appId}.
      </Text>
      <Button appearance="subtle" onClick={reload}>
        Reload
      </Button>
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
