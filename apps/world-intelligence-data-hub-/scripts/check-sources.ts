// Validate all enabled RSS sources and print a health table.
// Usage: npm run check-sources
//
// Makes one HTTP GET per source (parallel). Records results to
// intelligence/sources/source-health.json.
// Does not scrape article content.

import { SourceHealthMonitor }     from '../intelligence/sources/health.ts';
import { validateAllRssSources }   from '../intelligence/sources/validator.ts';
import { loadRegistry, rssSources } from '../intelligence/sources/registry.ts';
import { PATHS }                    from '../lib/paths.ts';

// ── Formatting helpers ────────────────────────────────────────────────────────

const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GRAY   = '\x1b[90m';
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';

const isTTY = process.stdout.isTTY;
function c(color: string, text: string): string {
  return isTTY ? `${color}${text}${RESET}` : text;
}

function padEnd(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const all     = loadRegistry();
const enabled = rssSources();
const disabled = all.filter(s => !s.enabled || !s.rss_url);

console.log('');
console.log(c(BOLD, 'World Intelligence — Source Health Check'));
console.log(`Checking ${enabled.length} enabled RSS sources in parallel…`);
console.log('');

const health  = new SourceHealthMonitor();
const results = await validateAllRssSources(health);

// ── Table ─────────────────────────────────────────────────────────────────────

const COL = { id: 28, status: 10, http: 6, time: 8, feed: 12, note: 0 };

const header =
  padEnd('Source ID', COL.id) +
  padEnd('Status',    COL.status) +
  padEnd('HTTP',      COL.http) +
  padEnd('Time',      COL.time) +
  'Feed / Error';
console.log(c(BOLD, header));
console.log('─'.repeat(90));

let passed  = 0;
let failed  = 0;

for (const r of results) {
  const ok     = r.reachable && r.is_valid_feed;
  const icon   = ok ? c(GREEN, '✓') : c(RED, '✗');
  const status = ok ? c(GREEN, 'OK') : c(RED, 'FAIL');
  const http   = r.http_status ? String(r.http_status) : '—';
  const time   = fmtMs(r.response_ms);
  const detail = ok ? c(GRAY, 'RSS/Atom') : c(YELLOW, r.error?.slice(0, 50) ?? 'unknown');

  console.log(
    `${icon}  ` +
    padEnd(r.source_id, COL.id - 3) +
    padEnd(status,      COL.status) +
    padEnd(http,        COL.http) +
    padEnd(time,        COL.time) +
    detail,
  );

  if (ok) passed++; else failed++;
}

// Disabled sources
if (disabled.length > 0) {
  console.log('');
  for (const s of disabled) {
    console.log(
      c(GRAY, `○  ${padEnd(s.id, COL.id - 3)}disabled`),
    );
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('─'.repeat(90));
console.log('');
console.log(
  `${c(GREEN, `${passed} reachable`)}  ` +
  (failed > 0 ? c(RED, `${failed} failed`) + '  ' : '') +
  c(GRAY, `${disabled.length} disabled`) +
  `  |  ${enabled.length} checked`,
);
console.log('');
console.log(c(GRAY, `Health data → ${PATHS.intelligence.sourceHealth}`));
console.log('');

// Exit 1 if more than half the sources are unreachable (network problem, not source problem)
if (failed > enabled.length / 2) {
  console.error('More than half the sources failed — check network connectivity.');
  process.exit(1);
}
