import {
  EXTRACT_SYSTEM,
  RECORD_CONTRACT_TOOL,
  type SourceDocument,
  extractContract,
  renderContract,
  resolveRule,
} from '../../../packages/core/src';
import { ForgeLlmClient } from '../llm/forge-llm-client';

/**
 * S2b: the Phase 1 extractor inside Forge, through the production adapter.
 *
 * Passes when: status is "ok", effectiveDate is 2025-03-01, noticeDate is
 * 2026-11-30, every returned quote verified, and repairCall.toolCalled is
 * true with valid JSON. The last part sends the adapter's repair turn (a
 * replayed tool call plus an error result) to Forge LLM for the first time.
 *
 * The contract below is invented. The result holds counts and dates only.
 */

const SAMPLE: SourceDocument = {
  pages: [
    {
      page: 1,
      text: [
        'MASTER SERVICES AGREEMENT between Northwind Logistics Ltd ("Customer") and Halden Software BV ("Supplier").',
        '2.1 Term. This Agreement commences on 1 March 2025 (the "Effective Date") and continues for an initial term of two (2) years.',
        '2.2 Renewal. This Agreement renews automatically for successive periods of one (1) year unless either party gives the other written notice of non-renewal at least ninety (90) days before the end of the then-current term.',
        '4.1 Payment. Customer shall pay each invoice within thirty (30) days after the date of the invoice.',
      ].join('\n'),
    },
  ],
};

export async function runExtractorSpike() {
  const llm = new ForgeLlmClient();
  const outcome = await extractContract(SAMPLE, llm);

  let summary: Record<string, unknown>;
  if (outcome.status === 'ok') {
    const notice = outcome.obligations.find((o) => o.rule.kind === 'renewal_notice' && o.status === 'ready');
    const resolution = notice ? resolveRule(notice.rule, { terms: outcome.contractTerms, termIndex: 0 }) : null;
    summary = {
      status: 'ok',
      effectiveDate: outcome.effectiveDate?.value ?? null,
      term: outcome.term?.value ?? null,
      renewal: outcome.renewal?.value ?? null,
      obligations: outcome.obligations.map((o) => ({ kind: o.rule.kind, status: o.status, offset: o.rule.offset, confidence: o.rule.confidence })),
      noticeDate: resolution?.status === 'resolved' ? (resolution.occurrences[0]?.date ?? null) : (resolution?.status ?? 'no notice rule'),
      rejected: outcome.rejected.map((r) => `${r.item}:${r.reason}`),
      grounding: outcome.grounding,
      secondPasses: outcome.secondPasses,
      repaired: outcome.repaired,
    };
  } else {
    summary = { status: 'failed', reason: outcome.reason, detail: outcome.detail };
  }

  // Force one repair turn so the replayed call and error result reach Forge LLM.
  const repair = await llm.callTool({
    system: EXTRACT_SYSTEM,
    prompt: `Contract text:\n\n${renderContract(SAMPLE)}`,
    tool: RECORD_CONTRACT_TOOL,
    maxOutputTokens: 4000,
    repair: {
      previousArguments: '{"effectiveDate":null,"term":null,"renewal":null,"obligations":[{"kind":"renewal_notice"}]}',
      problems: ['obligations.0: missing every field except kind'],
    },
  });
  let validJson = false;
  try {
    JSON.parse(repair.argumentsJson ?? '');
    validJson = true;
  } catch {
    validJson = false;
  }

  return {
    model: llm.modelId,
    ...summary,
    calls: outcome.calls,
    usage: outcome.usage,
    repairCall: { toolCalled: repair.argumentsJson !== null, validJson, stopReason: repair.stopReason, usage: repair.usage },
  };
}
