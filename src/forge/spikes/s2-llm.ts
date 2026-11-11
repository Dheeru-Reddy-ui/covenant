import { type Message, type ToolSchema, chat, list } from '@forge/llm';
import {
  type ObligationRule,
  ObligationRuleSchema,
  type SourceDocument,
  locateQuote,
  obligationRuleJsonSchema,
  resolveRule,
} from '../../../packages/core/src';

/**
 * S2: call the Forge LLMs API with a tool schema and get one valid rule back
 * for one clause.
 *
 * Pass: schemaValid and quoteVerified are both true, and the usage shows in the
 * developer console. Fallback if it fails: run extraction through the Rovo agent.
 *
 * Forge LLMs has no JSON mode, so structure is forced by declaring one tool and
 * naming it in tool_choice. The clause below is invented for this spike.
 */

// The only Haiku model Forge offers. Its "retire not sooner than" date was 15 Oct 2026,
// so the result also lists what Forge says is active right now.
export const SPIKE_MODEL = 'claude-haiku-4-5-20251001';
export const FALLBACK_MODEL = 'claude-sonnet-4-6';

const SAMPLE: SourceDocument = {
  pages: [
    {
      page: 1,
      text: [
        'MASTER SERVICES AGREEMENT between Northwind Logistics Ltd ("Customer") and Halden Software BV ("Supplier").',
        '2.1 Term. This Agreement commences on 1 March 2025 (the "Effective Date") and continues for an initial term of two (2) years.',
        '2.2 Renewal. This Agreement renews automatically for successive periods of one (1) year unless either party gives the other written notice of non-renewal at least ninety (90) days before the end of the then-current term.',
      ].join('\n'),
    },
  ],
};

const SYSTEM = [
  'You read contract text and report obligations as structured rules.',
  'Never work out or state a calendar date. Report the anchor, the offset and any recurrence exactly as the text gives them.',
  'A deadline measured from the end of the term uses anchor term_end with recurrence null, even when the contract renews: the date engine rolls the term forward itself.',
  'The quote must be copied from the text character for character.',
  'Call the record_obligation tool exactly once, for the renewal notice obligation.',
].join(' ');

const TOOL_NAME = 'record_obligation';

interface Attempt {
  finishReason: string | null;
  toolCalled: boolean;
  argumentsType: string;
  schemaValid: boolean;
  schemaIssues: string[];
  usage: { input?: number; output?: number };
}

export interface LlmSpikeResult {
  model: string;
  activeModels: string[] | string;
  /** One entry per model call. A second entry means the first answer failed validation and was sent back once. */
  attempts: Attempt[];
  schemaValid: boolean;
  quoteVerified: boolean;
  /** What the date engine made of the model's rule, to show the whole chain once. */
  resolvedDate: string | null;
  usage: { input: number; output: number };
  ms: number;
}

async function activeModels(): Promise<string[] | string> {
  try {
    const { models } = await list();
    return models.filter((m) => m.status === 'active').map((m) => m.model);
  } catch (error) {
    return `list() failed: ${error instanceof Error ? error.name : 'unknown error'}`;
  }
}

/** Tool arguments arrive as a JSON string on the wire, although the SDK types say object. Accept both. */
function readArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export async function runLlmSpike(model: string = SPIKE_MODEL): Promise<LlmSpikeResult> {
  const started = Date.now();
  const models = await activeModels();

  const { $schema: _dropped, ...parameters } = obligationRuleJsonSchema();
  const tools: ToolSchema[] = [
    {
      type: 'function',
      function: {
        name: TOOL_NAME,
        description: 'Record one obligation found in the contract text as a rule. Never include a calendar date.',
        parameters,
      },
    },
  ];
  const messages: Message[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Contract text, page 1:

${SAMPLE.pages[0]?.text ?? ''}` },
  ];

  const attempts: Attempt[] = [];
  let rule: ObligationRule | null = null;
  for (let attempt = 0; attempt < 2 && rule === null; attempt += 1) {
    const response = await chat({
      model,
      temperature: 0,
      max_completion_tokens: 1024,
      messages,
      tools,
      tool_choice: { type: 'function', function: { name: TOOL_NAME } },
    });
    const choice = response.choices[0];
    const call = choice?.message.tool_calls?.[0];
    const parsed = ObligationRuleSchema.safeParse(readArguments(call?.function.arguments));
    const issues = parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    attempts.push({
      finishReason: choice?.finish_reason ?? null,
      toolCalled: call !== undefined,
      argumentsType: typeof call?.function.arguments,
      schemaValid: parsed.success,
      schemaIssues: issues,
      usage: { input: response.usage?.input_tokens, output: response.usage?.output_tokens },
    });
    if (parsed.success) {
      rule = parsed.data;
    } else if (choice && call) {
      // One repair turn: hand the validation errors back as the tool's result and ask again.
      messages.push(choice.message);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: TOOL_NAME,
        content: `Rejected. Fix these problems and call ${TOOL_NAME} again: ${issues.join('; ')}`,
      });
    }
  }

  let quoteVerified = false;
  let resolvedDate: string | null = null;
  if (rule !== null) {
    quoteVerified = locateQuote(rule.quote, SAMPLE, rule.page).status === 'verified';
    const resolution = resolveRule(rule, {
      terms: {
        effectiveDate: '2025-03-01',
        initialTerm: { count: 2, unit: 'year' },
        initialTermEnd: null,
        renewalTerm: { count: 1, unit: 'year' },
      },
      termIndex: 0,
    });
    resolvedDate = resolution.status === 'resolved' ? (resolution.occurrences[0]?.date ?? null) : `unresolved: ${resolution.reason}`;
  }

  return {
    model,
    activeModels: models,
    attempts,
    schemaValid: rule !== null,
    quoteVerified,
    resolvedDate,
    usage: {
      input: attempts.reduce((sum, a) => sum + (a.usage.input ?? 0), 0),
      output: attempts.reduce((sum, a) => sum + (a.usage.output ?? 0), 0),
    },
    ms: Date.now() - started,
  };
}
