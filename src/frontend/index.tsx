import { invoke } from '@forge/bridge';
import ForgeReconciler, { Button, CodeBlock, Heading, Inline, Lozenge, SectionMessage, Stack, Text } from '@forge/react';
import React, { useState } from 'react';

// The Phase 0 spike panel. Throwaway: Phase 2 replaces it with the real Extract and review panel.

interface Outcome {
  ok: boolean;
  ms: number;
  result?: unknown;
  error?: { name: string; message: string };
}

const SPIKES: Array<{ key: string; title: string; passes: string }> = [
  { key: 'spike.s0', title: 'S0 Core package inside Forge', passes: 'matches is true.' },
  {
    key: 'spike.s1',
    title: 'S1 Attachment text',
    passes: 'For each file, bytesSha256 and textSha256 equal what "npm run spike:local" prints for the same file on disk.',
  },
  { key: 'spike.s2', title: 'S2 Forge LLM with a tool schema', passes: 'schemaValid and quoteVerified are true, and resolvedDate is 2026-11-30.' },
  {
    key: 'spike.s2b',
    title: 'S2b Phase 1 extractor through Forge LLM',
    passes: 'status is ok, effectiveDate is 2025-03-01, noticeDate is 2026-11-30, grounding is all verified, and repairCall has toolCalled and validJson true.',
  },
  { key: 'spike.s3', title: 'S3 Teamwork Graph as you', passes: 'No error, and rows equals the number of work items assigned to you.' },
  { key: 'spike.s5', title: 'S5 Forge SQL', passes: 'roundTrip is true.' },
];

const App = () => {
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [running, setRunning] = useState<string | null>(null);

  const run = async (key: string) => {
    setRunning(key);
    const started = Date.now();
    try {
      // Without the metadata argument, invoke resolves to the resolver's return value itself.
      const outcome = (await invoke<Outcome>(key)) as Outcome;
      setOutcomes((previous) => ({ ...previous, [key]: outcome }));
    } catch (error) {
      // The invoke itself failed: a timeout, a missing scope, or a crash before the resolver could answer.
      const message = error instanceof Error ? error.message : String(error);
      setOutcomes((previous) => ({
        ...previous,
        [key]: { ok: false, ms: Date.now() - started, error: { name: 'InvokeError', message } },
      }));
    } finally {
      setRunning(null);
    }
  };

  return (
    <Stack space="space.300">
      <SectionMessage appearance="information" title="Phase 0 spikes">
        <Text>
          Run each spike on a work item that has a 30-page PDF and a DOCX attached. S4 (MCP) has no button: it passes when an outside
          MCP client lists and calls the covenant-ping tool. Results show counts and hashes only, never document text.
        </Text>
      </SectionMessage>
      {SPIKES.map((spike) => {
        const outcome = outcomes[spike.key];
        return (
          <Stack key={spike.key} space="space.100">
            <Inline space="space.150" alignBlock="center">
              <Heading size="xsmall">{spike.title}</Heading>
              {outcome && (
                <Lozenge appearance={outcome.ok ? 'success' : 'removed'}>{outcome.ok ? `ran in ${outcome.ms} ms` : 'failed'}</Lozenge>
              )}
            </Inline>
            <Text>Passes when: {spike.passes}</Text>
            <Inline>
              <Button onClick={() => run(spike.key)} isDisabled={running !== null}>
                {running === spike.key ? 'Running…' : 'Run'}
              </Button>
            </Inline>
            {outcome && <CodeBlock language="json" text={JSON.stringify(outcome.ok ? outcome.result : outcome.error, null, 2)} />}
          </Stack>
        );
      })}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
