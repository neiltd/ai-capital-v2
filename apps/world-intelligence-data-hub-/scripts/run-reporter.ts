// Run the reporter-agent on a specific date's scored articles.
// Usage:
//   npm run report                       — today, live API calls
//   npm run report -- --dry-run          — show batches + cost estimate, no API calls
//   npm run report -- 2026-05-12         — specific date
//   npm run report -- --batch-size=5     — override default batch size of 8

import { run }    from '../intelligence/agents/reporter-agent.ts';
import { logger } from '../lib/logger.ts';
import { PATHS }  from '../lib/paths.ts';
import { BATCH_SIZE, MODEL, PROMPT_VERSION, EXTRACTION_VERSION } from '../intelligence/agents/prompts/extractor-v2.ts';

// ── Args ──────────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const dryRun    = args.includes('--dry-run');
const dateArg   = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
const date      = dateArg ?? new Date().toISOString().slice(0, 10);
const batchArg  = args.find(a => a.startsWith('--batch-size='));
const batchSize = batchArg ? parseInt(batchArg.split('=')[1]!, 10) : BATCH_SIZE;

// ── Colors ────────────────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY;
const G  = (s: string) => isTTY ? `\x1b[32m${s}\x1b[0m` : s;
const R  = (s: string) => isTTY ? `\x1b[31m${s}\x1b[0m` : s;
const Y  = (s: string) => isTTY ? `\x1b[33m${s}\x1b[0m` : s;
const D  = (s: string) => isTTY ? `\x1b[90m${s}\x1b[0m` : s;
const B  = (s: string) => isTTY ? `\x1b[1m${s}\x1b[0m`  : s;

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('');
console.log(B('World Intelligence — Reporter Agent'));
console.log(D(`Date: ${date}  |  Model: ${MODEL}  |  Batch: ${batchSize}  |  Prompt: ${PROMPT_VERSION}  |  Extraction: ${EXTRACTION_VERSION}`));
if (dryRun) console.log(Y('  DRY RUN — no API calls will be made'));
console.log('');

const result = await run(date, { dryRun, batchSize });

// ── Summary ───────────────────────────────────────────────────────────────────

if (dryRun) {
  console.log(B('Dry-run complete.'));
  console.log(`  Would process: ${result.articles_processed} articles in estimated batches`);
  console.log(`  Estimated cost: ~$${result.estimated_cost_usd.toFixed(4)}`);
  console.log('');
  process.exit(0);
}

if (result.articles_processed === 0) {
  console.log(D('No pending articles found. Run `npm run score` first.'));
  console.log('');
  process.exit(0);
}

console.log('');
console.log(B('Results:'));
console.log(`  Articles processed:  ${result.articles_processed}`);
console.log(`  Batches run:         ${result.batches_run}`);
console.log(`  Events extracted:    ${G(String(result.events_extracted))}`);
console.log(`  Events merged:       ${D(String(result.events_merged))}`);
console.log(
  `  Human review:       ` +
  (result.human_review_count > 0 ? Y(String(result.human_review_count)) : D('0'))
);
console.log(`  Estimated cost:      $${result.estimated_cost_usd.toFixed(4)}`);
console.log('');
console.log(D(`Events → ${PATHS.intelligence.outputEvents}/${date}.json`));
console.log('');

if (result.human_review_count > 0) {
  logger.warn('reporter', `${result.human_review_count} event(s) flagged for human review — inspect the events file`);
}
