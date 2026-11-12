import type { LlmClient, ToolCallRequest, ToolCallResponse } from '../src/llm';
import type { SourceDocument } from '../src/verify';

/**
 * A scripted model. `respond` sees each request and returns the tool's
 * arguments (an object, raw JSON text, or undefined for "no tool call"), or an
 * Error to throw. Every request is kept for assertions.
 */
export class ScriptedLlm implements LlmClient {
  readonly modelId = 'scripted-model';
  readonly requests: ToolCallRequest[] = [];

  constructor(private readonly respond: (request: ToolCallRequest, callIndex: number) => unknown) {}

  async callTool(request: ToolCallRequest): Promise<ToolCallResponse> {
    this.requests.push(request);
    const out = this.respond(request, this.requests.length - 1);
    if (out instanceof Error) throw out;
    return {
      argumentsJson: out === undefined ? null : typeof out === 'string' ? out : JSON.stringify(out),
      usage: { inputTokens: 100, outputTokens: 10 },
      model: this.modelId,
      stopReason: out === undefined ? 'end_turn' : 'tool_use',
    };
  }

  calls(toolName: string): ToolCallRequest[] {
    return this.requests.filter((r) => r.tool.name === toolName);
  }
}

/** An invented two-page agreement. */
export const CONTRACT: SourceDocument = {
  pages: [
    {
      page: 1,
      text: [
        'MASTER SERVICES AGREEMENT',
        'This Master Services Agreement is made as of March 1, 2025 (the "Effective Date") between Northwind Logistics Ltd ("Customer") and Halden Software BV ("Supplier").',
        '2.1 Term. This Agreement continues for an initial term of two (2) years from the Effective Date.',
        'Signed by Supplier on March 2, 2025.',
      ].join('\n'),
    },
    {
      page: 2,
      text: [
        '2.2 Renewal. This Agreement renews automatically for successive periods of one (1) year unless either party gives the other written notice of non-renewal at least ninety (90) days before the end of the then-current term.',
        '4.1 Payment. Customer shall pay each invoice within thirty (30) days after the date of the invoice.',
        '9.4 Non-renewal by Customer. Customer may prevent renewal by notice given at least sixty (60) days before the end of the then-current term.',
      ].join('\n'),
    },
  ],
};

export const QUOTES = {
  effective: 'This Master Services Agreement is made as of March 1, 2025 (the "Effective Date")',
  term: 'This Agreement continues for an initial term of two (2) years from the Effective Date.',
  renewal: 'This Agreement renews automatically for successive periods of one (1) year',
  notice:
    'unless either party gives the other written notice of non-renewal at least ninety (90) days before the end of the then-current term.',
  payment: 'Customer shall pay each invoice within thirty (30) days after the date of the invoice.',
  notice60: 'Customer may prevent renewal by notice given at least sixty (60) days before the end of the then-current term.',
  signed: 'Signed by Supplier on March 2, 2025.',
};

export const noticeRule = (over: Record<string, unknown> = {}) => ({
  kind: 'renewal_notice',
  responsibleParty: 'Either party',
  summary: 'Give written notice of non-renewal before the term ends.',
  anchor: 'term_end',
  anchorDescription: null,
  offset: { count: 90, unit: 'day', direction: 'before' },
  recurrence: null,
  quote: QUOTES.notice,
  page: 7, // wrong on purpose: code derives the page
  confidence: 'high',
  ...over,
});

export const paymentRule = (over: Record<string, unknown> = {}) => ({
  kind: 'payment',
  responsibleParty: 'Customer',
  summary: 'Pay each invoice.',
  anchor: 'event',
  anchorDescription: 'date of the invoice',
  offset: { count: 30, unit: 'day', direction: 'after' },
  recurrence: null,
  quote: QUOTES.payment,
  page: 2,
  confidence: 'high',
  ...over,
});

export const terms = (over: Record<string, unknown> = {}) => ({
  effectiveDate: { dateText: 'March 1, 2025', event: null, quote: QUOTES.effective, page: 1, confidence: 'high' },
  term: { kind: 'fixed_length', length: { count: 2, unit: 'year' }, endDateText: null, quote: QUOTES.term, page: 1, confidence: 'high' },
  renewal: { automatic: true, length: { count: 1, unit: 'year' }, quote: QUOTES.renewal, page: 2, confidence: 'high' },
  ...over,
});

export const reading = (over: Record<string, unknown> = {}) => ({
  ...terms(),
  obligations: [noticeRule(), paymentRule()],
  ...over,
});
