// Manual inspection CLI for extracted intelligence events.
// Usage:
//   npm run review                        — today's events
//   npm run review -- 2026-05-12          — specific date
//   npm run review -- --filter=review     — only events flagged for human review
//   npm run review -- --min-severity=4    — only severity 4+
//   npm run review -- --min-confidence=0.7 — only high-confidence events
//   npm run review -- --json              — output machine-readable JSON

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { IntelligenceEvent } from '../intelligence/schema/intelligence-event.ts';
import { PATHS }  from '../lib/paths.ts';

// ── Args ──────────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const dateArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
const date    = dateArg ?? new Date().toISOString().slice(0, 10);
const jsonOut = args.includes('--json');
const filterReview = args.includes('--filter=review');
const minSeverity  = parseInt(args.find(a => a.startsWith('--min-severity='))?.split('=')[1] ?? '1', 10);
const minConf      = parseFloat(args.find(a => a.startsWith('--min-confidence='))?.split('=')[1] ?? '0');

// ── Colors (TTY only) ─────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY && !jsonOut;
const col   = (c: string, s: string) => isTTY ? `${c}${s}\x1b[0m` : s;
const G  = (s: string) => col('\x1b[32m', s);
const R  = (s: string) => col('\x1b[31m', s);
const Y  = (s: string) => col('\x1b[33m', s);
const C  = (s: string) => col('\x1b[36m', s);
const D  = (s: string) => col('\x1b[90m', s);
const B  = (s: string) => col('\x1b[1m',  s);
const W  = (s: string) => col('\x1b[33;1m', s);   // warning / amber bold

// ── Load events ───────────────────────────────────────────────────────────────

const eventPath = join(PATHS.intelligence.outputEvents, `${date}.json`);
if (!existsSync(eventPath)) {
  console.error(`No events found for ${date}. Run: npm run report -- ${date}`);
  process.exit(1);
}

const file = JSON.parse(readFileSync(eventPath, 'utf-8')) as {
  date: string;
  generated_at: string;
  model: string;
  prompt_version: string;
  stats: {
    articles_processed: number;
    events_extracted:   number;
    human_review_count: number;
    estimated_cost_usd: number;
    tokens: { input: number; output: number; cache_write: number; cache_read: number };
  };
  events: IntelligenceEvent[];
};

// ── Filter ────────────────────────────────────────────────────────────────────

let events = file.events;
if (filterReview)     events = events.filter(e => e.sources.human_review_required);
if (minSeverity > 1)  events = events.filter(e => e.event.severity >= minSeverity);
if (minConf > 0)      events = events.filter(e => e.event.confidence_score >= minConf);
events = events.sort((a, b) => b.event.severity - a.event.severity || b.event.confidence_score - a.event.confidence_score);

// ── JSON output ───────────────────────────────────────────────────────────────

if (jsonOut) {
  console.log(JSON.stringify({ date, events }, null, 2));
  process.exit(0);
}

// ── Human-readable output ─────────────────────────────────────────────────────

function stars(n: number): string {
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

function confBar(score: number): string {
  const filled = Math.round(score * 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function fmtSeverity(s: number): string {
  if (s >= 5) return R(stars(s));
  if (s >= 4) return Y(stars(s));
  if (s >= 3) return C(stars(s));
  return D(stars(s));
}

function fmtConf(score: number): string {
  const bar = confBar(score);
  if (score >= 0.7) return G(bar) + ' ' + score.toFixed(2);
  if (score >= 0.5) return Y(bar) + ' ' + score.toFixed(2);
  return R(bar) + ' ' + score.toFixed(2);
}

const divider = '─'.repeat(72);

// Header
console.log('');
console.log(B('═'.repeat(72)));
console.log(B(`  World Intelligence — Event Review │ ${date}`));
console.log(B('═'.repeat(72)));
console.log(
  `  ${G(String(file.events.length))} events total` +
  `  │  ${file.stats.human_review_count > 0 ? W(`${file.stats.human_review_count} need review`) : D('0 need review')}` +
  `  │  est. cost ${D('$' + (file.stats.estimated_cost_usd ?? 0).toFixed(4))}` +
  `  │  ${D(file.model)} ${D(file.prompt_version)}`,
);

if (events.length < file.events.length) {
  console.log(D(`  Showing ${events.length}/${file.events.length} after filters`));
}
console.log('');

if (events.length === 0) {
  console.log(D('  No events match the current filters.'));
  console.log('');
  process.exit(0);
}

// Events
for (let i = 0; i < events.length; i++) {
  const ev = events[i]!;
  const needsReview = ev.sources.human_review_required;
  const reviewFlag  = needsReview ? ' ' + W('⚠ REVIEW') : '';

  // Section header
  const typeLabel = ev.event.event_type.replace(/_/g, ' ');
  console.log(divider);
  console.log(
    `${B(`[${i + 1}/${events.length}]`)}  ` +
    C(typeLabel) + reviewFlag +
    `  ${fmtSeverity(ev.event.severity)}` +
    `  ${D('conf')} ${fmtConf(ev.event.confidence_score)}`,
  );
  console.log('');

  // Title
  console.log(`  ${B(ev.event.title)}`);
  console.log('');

  // Geography + scores
  console.log(
    `  Countries:   ${ev.geography.countries.join(', ')}` +
    (ev.geography.location_description ? `  (${D(ev.geography.location_description.slice(0, 60))})` : ''),
  );
  console.log(
    `  Geo:         ${ev.geopolitical_scores.relevance.toFixed(2)}` +
    `  │  Market: ${(ev.market_impact?.relevance ?? 0).toFixed(2)}` +
    `  │  Escalation: ${ev.geopolitical_scores.escalation_potential.toFixed(2)}`,
  );

  // Sources
  const sourceNames = [...new Set(ev.sources.extracted_from.map(r => r.source_id))];
  console.log(
    `  Sources:     ${sourceNames.join(', ')} ` +
    D(`(${ev.sources.source_count} article${ev.sources.source_count !== 1 ? 's' : ''})`),
  );

  // Evidence quotes
  if (ev.sources.evidence_quotes && ev.sources.evidence_quotes.length > 0) {
    for (const q of ev.sources.evidence_quotes.slice(0, 2)) {
      console.log(`  Evidence:    ${D('"' + q.slice(0, 80) + (q.length > 80 ? '…' : '') + '"')}`);
    }
  }

  // Actors
  const individuals   = ev.actors.individuals ?? [];
  const organizations = ev.actors.organizations ?? [];
  const allActors     = [
    ...individuals.map(a => `${a.name}${a.role ? ` (${a.role})` : ''}`),
    ...organizations.map(o => o.name),
  ];
  if (allActors.length > 0) {
    console.log(`  Actors:      ${allActors.slice(0, 4).join(', ')}`);
  }

  // Review flag
  if (needsReview) {
    console.log('');
    console.log(`  ${W('⚠ HUMAN REVIEW:')} ${ev.sources.human_review_reason ?? 'see event details'}`);
  }

  // Graph status
  const graphLinks = (ev.graph.related_event_ids?.length ?? 0) +
                     (ev.graph.predecessor_ids?.length ?? 0) +
                     (ev.graph.successor_ids?.length ?? 0);
  if (graphLinks > 0) {
    console.log(`  Graph:       ${graphLinks} link${graphLinks !== 1 ? 's' : ''} (memory-agent)`);
  } else {
    console.log(`  ${D('Graph:       unlinked (memory-agent pending)')}`);
  }

  // Metadata
  console.log('');
  console.log(D(`  ID: ${ev.event_id}  │  extracted: ${ev.identity.extracted_at.slice(0, 19).replace('T', ' ')}  │  v: ${ev.identity.prompt_version ?? '—'}`));
  console.log('');
}

console.log(divider);
console.log('');

// Footer summary
const byType   = events.reduce<Record<string, number>>((acc, e) => {
  acc[e.event.event_type] = (acc[e.event.event_type] ?? 0) + 1;
  return acc;
}, {});
const topTypes = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log(B('Event types:  ') + topTypes.map(([t, n]) => `${t.replace(/_/g, ' ')} (${n})`).join('  ·  '));

const avgConf  = events.reduce((s, e) => s + e.event.confidence_score, 0) / events.length;
const avgSev   = events.reduce((s, e) => s + e.event.severity, 0) / events.length;
const highConf = events.filter(e => e.event.confidence_score >= 0.7).length;
console.log(
  `Avg confidence: ${avgConf.toFixed(2)}` +
  `  │  High confidence (≥0.7): ${G(String(highConf))}` +
  `  │  Avg severity: ${avgSev.toFixed(1)}`,
);
console.log('');
