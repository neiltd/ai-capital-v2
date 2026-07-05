import 'dotenv/config';
// Non-interactive human intel processor.
// Reads intelligence/human/inbox.md, extracts intel, runs economist analysis,
// appends to store, then re-runs exports.
// Usage: npm run human-intel

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { PATHS }             from '../lib/paths.ts';
import { logger }            from '../lib/logger.ts';
import { extractHumanIntel } from '../intelligence/human/extractor.ts';
import { generateQuickAnalysis } from '../intelligence/human/economist.ts';
import { appendHumanRecord } from '../intelligence/human/store.ts';
import { runExports }        from '../intelligence/exports/run-exports.ts';

const PROCESSED_MARKER = /^<!--\s*processed:/m;

function readInbox(): { text: string; sourcePlatform: 'web' } | null {
  if (!existsSync(PATHS.intelligence.human.inbox)) {
    logger.warn('human-intel', 'inbox.md not found — nothing to process');
    return null;
  }

  const raw = readFileSync(PATHS.intelligence.human.inbox, 'utf-8');

  // Content is everything after the last <!-- processed: ... --> line
  const lines = raw.split('\n');
  let contentStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (PROCESSED_MARKER.test(lines[i])) contentStart = i + 1;
  }

  // Filter out any HTML comment lines (header or processed markers) from the content slice
  const contentLines = lines.slice(contentStart).filter(l => !l.trim().startsWith('<!--'));
  const content = contentLines.join('\n').trim();
  if (!content) {
    logger.info('human-intel', 'inbox.md is empty — nothing to process');
    return null;
  }

  return { text: content, sourcePlatform: 'web' };
}

function clearInbox(): void {
  const now = new Date().toISOString();
  const existing = existsSync(PATHS.intelligence.human.inbox)
    ? readFileSync(PATHS.intelligence.human.inbox, 'utf-8')
    : '';

  // Keep all previous processed markers + add new one; clear content
  const prevMarkers = existing.split('\n').filter(l => PROCESSED_MARKER.test(l));
  const newContent = [...prevMarkers, `<!-- processed: ${now} -->`].join('\n') + '\n';
  writeFileSync(PATHS.intelligence.human.inbox, newContent);
}

async function main(): Promise<void> {
  const inbox = readInbox();
  if (!inbox) process.exit(0);

  logger.info('human-intel', `Processing inbox content (${inbox.text.length} chars)`);

  const record = await extractHumanIntel({
    rawText:        inbox.text,
    sourcePlatform: inbox.sourcePlatform,
  });

  logger.info('human-intel', `Extracted: "${record.extracted.title}" (confidence: ${record.extracted.confidence})`);

  record.economist_quick_analysis = await generateQuickAnalysis(record);
  logger.info('human-intel', 'Economist quick analysis complete');

  appendHumanRecord(record);
  logger.info('human-intel', `Record saved → ${record.id}`);

  clearInbox();
  logger.info('human-intel', 'Inbox cleared');

  const today = new Date().toISOString().slice(0, 10);
  try {
    runExports(today);
    logger.info('human-intel', 'Exports updated with new human-intel record');
  } catch (err) {
    logger.warn('human-intel', `Export step skipped: ${(err as Error).message}`);
  }

  console.log('\n=== Extraction result ===');
  console.log(`ID:         ${record.id}`);
  console.log(`Title:      ${record.extracted.title}`);
  console.log(`Topic:      ${record.extracted.topic}`);
  console.log(`Countries:  ${record.extracted.countries.join(', ')}`);
  console.log(`Confidence: ${record.extracted.confidence}`);
  console.log(`Assessment: ${record.credibility.assessment}`);
  if (record.follow_up_requests.length) {
    console.log('\nFollow-up needed:');
    record.follow_up_requests.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
  }
  console.log('\nEconomist analysis:');
  console.log(`  ${record.economist_quick_analysis}`);
}

main().catch(err => {
  logger.error('human-intel', (err as Error).message);
  process.exit(1);
});
