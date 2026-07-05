// Operational metrics dashboard — shows daily pipeline stats.
// Usage:
//   npm run metrics              — last 7 days
//   npm run metrics -- --days=30 — last 30 days
//   npm run metrics -- --json    — machine-readable output

import { getDailyMetrics, listMetricDates } from '../intelligence/metrics/metrics-store.ts';

// ── Args ──────────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const jsonOut = args.includes('--json');
const daysArg = args.find(a => a.startsWith('--days='));
const days    = daysArg ? parseInt(daysArg.split('=')[1]!, 10) : 7;

// ── Colors ────────────────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY && !jsonOut;
const col   = (c: string, s: string) => isTTY ? `${c}${s}\x1b[0m` : s;
const G = (s: string) => col('\x1b[32m', s);
const R = (s: string) => col('\x1b[31m', s);
const Y = (s: string) => col('\x1b[33m', s);
const D = (s: string) => col('\x1b[90m', s);
const B = (s: string) => col('\x1b[1m',  s);

// ── Load data ─────────────────────────────────────────────────────────────────

const allDates = listMetricDates().slice(0, days);

if (allDates.length === 0) {
  console.log('No metrics available yet. Run the pipeline first.');
  process.exit(0);
}

const rows = allDates.map(d => ({ date: d, metrics: getDailyMetrics(d) })).filter(r => r.metrics);

if (jsonOut) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

// ── Formatters ────────────────────────────────────────────────────────────────

function n(v: number | undefined, fallback = '—'): string {
  return v !== undefined ? String(v) : fallback;
}

function pct(num: number | undefined, den: number | undefined): string {
  if (!num || !den) return '—';
  return `${Math.round((num / den) * 100)}%`;
}

function pad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}

function money(v: number | undefined): string {
  if (!v) return '—';
  return `$${v.toFixed(3)}`;
}

// ── Table ─────────────────────────────────────────────────────────────────────

console.log('');
console.log(B('World Intelligence — Metrics Dashboard'));
console.log(D(`Showing last ${allDates.length} day${allDates.length !== 1 ? 's' : ''}`));
console.log('');

// Column headers
const header =
  pad('Date',       12) +
  pad('Collected',  11) +
  pad('Scored',     9)  +
  pad('Rec. (%)',   11) +
  pad('AI sent',   10)  +
  pad('Events',    9)   +
  pad('Review',    9)   +
  pad('Cost',      9)   +
  pad('Cache%',    8);
console.log(B(header));
console.log('─'.repeat(88));

let totalCollected = 0;
let totalRecommended = 0;
let totalAiSent   = 0;
let totalEvents   = 0;
let totalReview   = 0;
let totalCost     = 0;
let totalInput    = 0;
let totalCacheRead = 0;

for (const { date, metrics } of rows) {
  const c   = metrics?.collection;
  const s   = metrics?.scoring;
  const e   = metrics?.extraction;

  const collected  = c?.total_articles ?? 0;
  const recommended = s?.recommended ?? 0;
  const aiSent     = e?.articles_sent_to_ai ?? 0;
  const events     = e?.events_extracted ?? 0;
  const review     = e?.human_review ?? 0;
  const cost       = e?.estimated_cost_usd ?? 0;
  const inp        = (e?.api_tokens.input ?? 0) + (e?.api_tokens.cache_write ?? 0);
  const cached     = e?.api_tokens.cache_read ?? 0;
  const cachePct   = inp + cached > 0 ? Math.round((cached / (inp + cached)) * 100) : 0;

  totalCollected   += collected;
  totalRecommended += recommended;
  totalAiSent      += aiSent;
  totalEvents      += events;
  totalReview      += review;
  totalCost        += cost;
  totalInput       += inp;
  totalCacheRead   += cached;

  const recPct = collected > 0 ? Math.round((recommended / collected) * 100) : 0;
  const reviewColor = review > 0 ? Y : D;
  const cachePctStr = cachePct > 0 ? G(`${cachePct}%`) : D('—');

  console.log(
    pad(date, 12) +
    pad(collected > 0 ? String(collected) : D('—'), 11) +
    pad(s ? String(s.total_scored) : D('—'), 9) +
    pad(recommended > 0 ? `${recommended} (${recPct}%)` : D('—'), 11) +
    pad(aiSent > 0 ? String(aiSent) : D('—'), 10) +
    pad(events > 0 ? G(String(events)) : D('—'), 9) +
    pad(review > 0 ? reviewColor(String(review)) : D('—'), 9) +
    pad(cost > 0 ? money(cost) : D('—'), 9) +
    cachePctStr,
  );
}

console.log('─'.repeat(88));

// Totals row
const totalRecPct = totalCollected > 0 ? Math.round((totalRecommended / totalCollected) * 100) : 0;
const totalCachePct = totalInput + totalCacheRead > 0
  ? Math.round((totalCacheRead / (totalInput + totalCacheRead)) * 100)
  : 0;

console.log(B(
  pad('TOTAL', 12) +
  pad(String(totalCollected), 11) +
  pad('—', 9) +
  pad(`${totalRecommended} (${totalRecPct}%)`, 11) +
  pad(String(totalAiSent), 10) +
  pad(G(String(totalEvents)), 9) +
  pad(totalReview > 0 ? Y(String(totalReview)) : '0', 9) +
  pad(money(totalCost), 9) +
  G(`${totalCachePct}%`),
));
console.log('');

// ── Per-source breakdown (latest day) ─────────────────────────────────────────

const latest = rows[0];
if (latest?.metrics?.scoring?.by_source) {
  console.log(B('Per-source recommendation rate (latest day):'));
  const bySource = latest.metrics.scoring.by_source;
  const sorted   = Object.entries(bySource)
    .sort((a, b) => (b[1].recommended / b[1].total) - (a[1].recommended / a[1].total));
  for (const [src, counts] of sorted) {
    const pctVal  = Math.round((counts.recommended / counts.total) * 100);
    const bar     = '█'.repeat(Math.round(pctVal / 5)) + '░'.repeat(20 - Math.round(pctVal / 5));
    const pctCol  = pctVal >= 20 ? G : pctVal >= 10 ? Y : D;
    console.log(`  ${pad(src, 26)}  ${D(bar)}  ${pctCol(String(pctVal).padStart(3) + '%')}  ${D(`${counts.recommended}/${counts.total}`)}`);
  }
  console.log('');
}

// ── Score distribution (latest day) ──────────────────────────────────────────

if (latest?.metrics?.scoring?.score_distribution) {
  const dist  = latest.metrics.scoring.score_distribution;
  const total = Object.values(dist).reduce((s, v) => s + v, 0);
  console.log(B('Score distribution (latest day):'));
  const bands = [
    { key: 'urgent',   label: '80-100 urgent',   color: G },
    { key: 'high',     label: '60-79  high',      color: (s: string) => col('\x1b[36m', s) },
    { key: 'relevant', label: '40-59  relevant',  color: Y },
    { key: 'marginal', label: '20-39  marginal',  color: D },
    { key: 'noise',    label: '0-19   noise',     color: R },
  ] as const;
  for (const { key, label, color } of bands) {
    const count   = (dist as Record<string, number>)[key] ?? 0;
    const pctNum  = total > 0 ? Math.round((count / total) * 100) : 0;
    const filled  = Math.round(pctNum / 3);
    const bar     = '█'.repeat(filled) + '░'.repeat(33 - filled);
    console.log(`  ${pad(label, 18)}  ${D(bar)}  ${color(String(count).padStart(4))}  ${D(`(${pctNum}%)`)}`);
  }
  console.log('');
}

// ── Extraction quality ────────────────────────────────────────────────────────

if (rows.some(r => r.metrics?.extraction)) {
  const totalLowConf = rows.reduce((s, r) => s + (r.metrics?.extraction?.low_confidence ?? 0), 0);
  const reviewRate   = totalEvents > 0 ? Math.round((totalReview / totalEvents) * 100) : 0;
  console.log(B('Extraction quality summary:'));
  console.log(`  Total events extracted:   ${G(String(totalEvents))}`);
  console.log(`  Human review required:    ${totalReview > 0 ? Y(String(totalReview)) : '0'}  (${reviewRate}% rate)`);
  console.log(`  Low confidence (<0.5):    ${D(String(totalLowConf))}`);
  console.log(`  Total API cost:           ${money(totalCost)}`);
  console.log(`  Cache hit rate:           ${totalCachePct > 0 ? G(`${totalCachePct}%`) : D('—')}  (prompt caching)`);
  console.log('');
}
