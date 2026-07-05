// Same-day event deduplication CLI.
// Usage:
//   npm run dedup                  — deduplicate today's events (live write)
//   npm run dedup -- 2026-05-13   — specific date
//   npm run dedup -- --dry-run    — show what would merge without writing

import { deduplicateEvents } from '../intelligence/dedup/same-day-dedup.ts';
import { readFileSync, existsSync } from 'fs';
import { join }                     from 'path';
import { PATHS }                    from '../lib/paths.ts';
import type { IntelligenceEvent }   from '../intelligence/schema/intelligence-event.ts';

// ── Args ──────────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const dryRun  = args.includes('--dry-run');
const dateArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
const date    = dateArg ?? new Date().toISOString().slice(0, 10);

// ── Colors ────────────────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY;
const G  = (s: string) => isTTY ? `\x1b[32m${s}\x1b[0m` : s;
const R  = (s: string) => isTTY ? `\x1b[31m${s}\x1b[0m` : s;
const Y  = (s: string) => isTTY ? `\x1b[33m${s}\x1b[0m` : s;
const D  = (s: string) => isTTY ? `\x1b[90m${s}\x1b[0m` : s;
const B  = (s: string) => isTTY ? `\x1b[1m${s}\x1b[0m`  : s;
const C  = (s: string) => isTTY ? `\x1b[36m${s}\x1b[0m` : s;  // cyan

function padEnd(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

// ── Load events before dedup ──────────────────────────────────────────────────

function loadEvents(date: string): IntelligenceEvent[] {
  const p = join(PATHS.intelligence.outputEvents, `${date}.json`);
  if (!existsSync(p)) return [];
  try {
    const f = JSON.parse(readFileSync(p, 'utf-8')) as { events: IntelligenceEvent[] };
    return f.events ?? [];
  } catch {
    return [];
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('');
console.log(B('World Intelligence — Event Deduplicator'));
console.log(D(`Date: ${date}${dryRun ? '  |  DRY RUN — no writes' : ''}`));
console.log('');

const before = loadEvents(date);

if (before.length === 0) {
  console.log(D('No events found. Run `npm run report` first.'));
  console.log('');
  process.exit(0);
}

// ── Run dedup ─────────────────────────────────────────────────────────────────

const result = deduplicateEvents(date, dryRun);

// ── Before table ──────────────────────────────────────────────────────────────

console.log(B(`Events BEFORE dedup  (${result.events_before} total)`));
console.log('─'.repeat(100));

const beforeHeader = D(
  padEnd('ID', 26) +
  padEnd('Type', 22) +
  padEnd('Country', 8) +
  padEnd('Conf', 6) +
  padEnd('Esc', 6) +
  'Title',
);
console.log(beforeHeader);

for (const e of before) {
  const conf = e.event.confidence_score.toFixed(2);
  const esc  = e.geopolitical_scores.escalation_potential.toFixed(2);
  const ver  = e.identity.prompt_version ?? 'v?';
  const idStr = D(e.event_id.slice(0, 8) + '…') + ' ' + D(`[${ver}]`);
  console.log(
    padEnd(idStr, 35) +    // 26 visible + ansi escape overhead
    padEnd(e.event.event_type, 22) +
    padEnd(e.geography.countries[0] ?? '???', 8) +
    padEnd(conf, 6) +
    padEnd(esc, 6) +
    e.event.title.slice(0, 50),
  );
}

console.log('');

// ── Merge decisions ───────────────────────────────────────────────────────────

if (result.merges.length === 0) {
  console.log(G('✓ No duplicates found — all events are distinct.'));
  console.log('');
  process.exit(0);
}

console.log(B(`Merge decisions  (${result.merges.length} merge${result.merges.length !== 1 ? 's' : ''})`));
console.log('─'.repeat(100));

for (const m of result.merges) {
  const riskTag   = m.risky ? ' ' + R('[RISKY]') : '';
  const simColor  = m.similarity >= 0.40 ? G : m.similarity >= 0.30 ? Y : R;
  const simStr    = simColor(`sim=${m.similarity.toFixed(2)}`);

  console.log('');
  console.log(
    C('▶ CANONICAL') + riskTag + '  ' + simStr + '  ' + D(`[${m.match_reasons.join(', ')}]`)
  );
  console.log(`  ${G('✓')} ${B(m.canonical_title)}`);
  console.log(`  ${D(m.canonical_id)}`);

  for (const [i, title] of m.merged_titles.entries()) {
    console.log(`  ${Y('←')} ${title}`);
    console.log(`  ${D(m.merged_ids[i] ?? '')}`);
  }

  if (m.risky) {
    console.log(`  ${R('⚠')} ${R(m.risk_reason ?? 'Risky merge — verify manually')}`);
  }
}

// ── Uncertain merges summary ──────────────────────────────────────────────────

if (result.uncertain_merges.length > 0) {
  console.log('');
  console.log(R(`⚠  ${result.uncertain_merges.length} uncertain merge(s) above — verify before relying on these events.`));
}

// ── After table ───────────────────────────────────────────────────────────────

// Use result.final_events so the table is accurate in dry-run mode too.
const afterEvents = result.final_events;

console.log('');
console.log(B(`Events AFTER dedup  (${result.events_after} total, ${result.events_before - result.events_after} removed)`));
console.log('─'.repeat(100));
console.log(beforeHeader);

for (const e of afterEvents) {
  const conf    = e.event.confidence_score.toFixed(2);
  const esc     = e.geopolitical_scores.escalation_potential.toFixed(2);
  const ver     = e.identity.prompt_version ?? 'v?';
  const isMerge = (e.sources.merged_from_event_ids?.length ?? 0) > 0;
  const mergeTag = isMerge ? ' ' + C(`[+${e.sources.merged_from_event_ids!.length}]`) : '';
  const idStr   = D(e.event_id.slice(0, 8) + '…') + ' ' + D(`[${ver}]`);
  console.log(
    padEnd(idStr, 35) +
    padEnd(e.event.event_type, 22) +
    padEnd(e.geography.countries[0] ?? '???', 8) +
    padEnd(conf, 6) +
    padEnd(esc, 6) +
    e.event.title.slice(0, 50) +
    mergeTag,
  );
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('');
console.log(
  `${G(String(result.events_after))} events after dedup  ` +
  `(${D(String(result.events_before))} before, ` +
  `${Y(String(result.merges.length))} merge${result.merges.length !== 1 ? 's' : ''} applied` +
  (result.uncertain_merges.length > 0 ? ', ' + R(`${result.uncertain_merges.length} uncertain`) : '') +
  ')',
);

if (dryRun) {
  console.log(Y('  DRY RUN — event file not modified.'));
}

console.log('');
console.log(D(`Events → ${PATHS.intelligence.outputEvents}/${date}.json`));
console.log('');
