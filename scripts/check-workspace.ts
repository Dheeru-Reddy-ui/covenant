// Builds the three sample-workspace contracts for today, parses them the way the app
// will, and checks every key clause is found word for word.
//
//   npm run samples:workspace              # parse and verify clauses
//   npm run samples:workspace -- --extract # also run the real extractor (needs ANTHROPIC_API_KEY, about $0.02)
//
// Prints counts and dates only.
import { extractContract, locateQuote, noticeWindow } from '../packages/core/src';
import { sampleWorkspace } from '../samples/fictional/workspace';
import { AnthropicLlmClient } from '../eval/src/anthropic-client';
import { parseDocument } from '../src/parse/document';
import { buildContractDocx } from '../src/sample/docx';

async function main(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const extract = process.argv.includes('--extract');
  const llm = extract ? AnthropicLlmClient.fromEnvironment() : null;
  let ok = true;

  for (const contract of sampleWorkspace(today)) {
    const bytes = await buildContractDocx(contract.title, contract.sections);
    const parsed = await parseDocument(bytes);
    console.log(`\n${contract.fileName}: ${bytes.byteLength} bytes, expected notice deadline ${contract.expectedNoticeDeadline}`);
    for (const [name, clause] of Object.entries(contract.keyClauses)) {
      const found = locateQuote(clause, parsed.source).status === 'verified';
      ok &&= found;
      console.log(`  ${found ? 'found  ' : 'MISSING'} ${name}`);
    }

    if (llm !== null) {
      const outcome = await extractContract(parsed.source, llm);
      if (outcome.status !== 'ok') {
        ok = false;
        console.log(`  extraction failed: ${outcome.reason}`);
        continue;
      }
      const notices = outcome.obligations.filter((o) => o.rule.kind === 'renewal_notice' && o.status === 'ready').map((o) => ({ id: o.id, rule: o.rule }));
      const autoRenew = outcome.renewal?.status === 'ready' && outcome.renewal.value?.automatic === true;
      const win = noticeWindow(notices, { terms: outcome.contractTerms, autoRenew, minTermIndex: 0, today, leadDays: 60 });
      const deadline = 'deadline' in win ? win.deadline : `none (${win.status})`;
      const match = deadline === contract.expectedNoticeDeadline;
      ok &&= match;
      console.log(
        `  extracted: ${outcome.obligations.length} obligations (${outcome.obligations.map((o) => `${o.rule.kind}:${o.status}`).join(', ')}), ` +
          `quotes ${outcome.grounding.quotesVerified}/${outcome.grounding.quotesReturned}, tokens ${outcome.usage.inputTokens}/${outcome.usage.outputTokens}`,
      );
      console.log(`  ${match ? 'deadline matches' : 'DEADLINE DIFFERS'}: ${deadline}`);
    }
  }

  if (!ok) {
    console.error('\nA check failed.');
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
