// Spike S1, local half: fingerprint a PDF or DOCX on disk with the same parser the Forge function uses.
// Compare bytesSha256 and textSha256 with what the "Covenant spikes" panel shows for the same file.
//
//   npm run spike:local -- "C:\path\to\contract.pdf"
//
// Prints counts and hashes only. It never prints document text.
import { readFileSync } from 'node:fs';
import { fingerprint, parseDocument } from '../src/parse/document';

async function main(): Promise<void> {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error('usage: npm run spike:local -- <file.pdf|file.docx> [more files]');
    process.exit(2);
  }

  let failed = false;
  for (const path of paths) {
    try {
      const bytes = new Uint8Array(readFileSync(path));
      const started = Date.now();
      const parsed = await parseDocument(bytes);
      console.log(JSON.stringify({ file: path, parseMs: Date.now() - started, ...fingerprint(bytes, parsed) }, null, 2));
    } catch (error) {
      failed = true;
      console.error(`${path}: ${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
