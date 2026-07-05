// Collect articles from all enabled RSS sources.
// Usage:
//   npm run collect                       — all sources, 1h cache
//   npm run collect -- --force           — re-fetch even if cache is fresh
//   npm run collect -- bbc-world npr-news — specific sources only

import { collectAll }              from '../intelligence/sources/collector.ts';
import { PATHS }                   from '../lib/paths.ts';
import { logger }                  from '../lib/logger.ts';
import { updateCollectionMetrics } from '../intelligence/metrics/metrics-store.ts';
import { runTwitterCollector }     from '../intelligence/twitter/twitter-collector.ts';

// ── Args ──────────────────────────────────────────────────────────────────────

const args       = process.argv.slice(2);
const forceFlag  = args.includes('--force');
const sourceIds  = args.filter(a => !a.startsWith('--'));

// ── Colors ────────────────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY;
const G = (s: string) => isTTY ? `\x1b[32m${s}\x1b[0m` : s;
const R = (s: string) => isTTY ? `\x1b[31m${s}\x1b[0m` : s;
const Y = (s: string) => isTTY ? `\x1b[33m${s}\x1b[0m` : s;
const D = (s: string) => isTTY ? `\x1b[90m${s}\x1b[0m` : s;
const B = (s: string) => isTTY ? `\x1b[1m${s}\x1b[0m`  : s;

function padEnd(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('');
console.log(B('World Intelligence — Article Collector'));
if (forceFlag) console.log(Y('  --force: cache bypassed'));
if (sourceIds.length > 0) console.log(D(`  sources: ${sourceIds.join(', ')}`));
console.log('');

const summary = await collectAll({
  skipCache: forceFlag,
  sourceIds: sourceIds.length > 0 ? sourceIds : undefined,
});

// ── Results table ─────────────────────────────────────────────────────────────

const header = B(
  padEnd('Source ID', 30) +
  padEnd('Status', 10) +
  padEnd('New', 8) +
  padEnd('Dupes', 8) +
  padEnd('Synd', 8) +
  padEnd('Stale', 8) +
  'Time',
);
console.log(header);
console.log('─'.repeat(88));

for (const r of summary.results) {
  const icon = r.status === 'ok'      ? G('✓')
             : r.status === 'skipped' ? D('○')
             : R('✗');

  const status = r.status === 'ok'      ? G('ok')
               : r.status === 'skipped' ? D('skip')
               : R('fail');

  const time = r.duration_ms < 1000
    ? `${r.duration_ms}ms`
    : `${(r.duration_ms / 1000).toFixed(1)}s`;

  const staleStr = r.status === 'ok' && r.stale_skipped > 0
    ? Y(String(r.stale_skipped))
    : r.status === 'ok'
      ? '0'
      : '—';

  const note = r.status === 'failed'
    ? R(`  ${r.error?.slice(0, 50) ?? 'unknown'}`)
    : r.status === 'skipped'
      ? D('  (cache fresh)')
      : r.stale_feed
        ? Y('  ⚠ stale feed')
        : '';

  console.log(
    `${icon}  ` +
    padEnd(r.source_id, 28) +
    padEnd(status, 10) +
    padEnd(r.status === 'ok' ? String(r.new_articles)     : '—', 8) +
    padEnd(r.status === 'ok' ? String(r.exact_duplicates) : '—', 8) +
    padEnd(r.status === 'ok' ? String(r.syndicated)       : '—', 8) +
    padEnd(staleStr, 8) +
    D(time) +
    note,
  );
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('─'.repeat(88));
console.log('');
console.log(
  G(`${summary.total_new} new`) + '  ' +
  D(`${summary.total_dupes} exact dupes`) + '  ' +
  Y(`${summary.total_syndicated} syndicated`) + '  ' +
  (summary.total_stale > 0 ? Y(`${summary.total_stale} stale`) + '  ' : '') +
  `|  ${summary.sources_ok} sources ok` +
  (summary.sources_failed  > 0 ? '  ' + R(`${summary.sources_failed} failed`)  : '') +
  (summary.sources_skipped > 0 ? '  ' + D(`${summary.sources_skipped} skipped`) : '') +
  `  |  ${summary.duration_ms}ms total`,
);
if (summary.stale_feed_sources.length > 0) {
  console.log(Y(`  ⚠ Stale feeds (>50% old): ${summary.stale_feed_sources.join(', ')}`));
}
console.log('');
console.log(D(`Articles → ${PATHS.intelligence.outputArticles}/`));
console.log(D(`Raw      → ${PATHS.intelligence.rawArticles}/`));
console.log('');

// Record metrics for this collection run
const date = new Date().toISOString().slice(0, 10);
const bySource: Record<string, number> = {};
for (const r of summary.results) {
  if (r.status === 'ok') bySource[r.source_id] = r.new_articles;
}

const okResults = summary.results.filter(r => r.status === 'ok');
const avgAgeHours  = okResults.length > 0
  ? okResults.reduce((s, r) => s + r.avg_age_hours, 0) / okResults.length
  : 0;
const oldestDays = okResults.length > 0
  ? Math.max(...okResults.map(r => r.oldest_age_days))
  : 0;

updateCollectionMetrics(date, {
  total_articles:       summary.total_new,
  by_source:            bySource,
  failed_sources:       summary.results.filter(r => r.status === 'failed').map(r => r.source_id),
  skipped_sources:      summary.results.filter(r => r.status === 'skipped').map(r => r.source_id),
  stale_articles:       summary.total_stale,
  stale_feed_sources:   summary.stale_feed_sources,
  avg_article_age_hours: Math.round(avgAgeHours * 10) / 10,
  oldest_article_days:  Math.round(oldestDays * 10) / 10,
});

// ── Twitter collection ────────────────────────────────────────────────────────
if (process.env.TWITTERAPI_IO_KEY) {
  console.log('');
  console.log(B('Twitter / X'));
  console.log(B(
    padEnd('Account', 30) +
    padEnd('Status', 10) +
    padEnd('New', 8) +
    padEnd('Dupes', 8) +
    padEnd('Synd', 8) +
    padEnd('Stale', 8) +
    'Time',
  ));
  console.log('─'.repeat(88));
  const twitterResults = await runTwitterCollector(date);
  for (const r of twitterResults) {
    const icon   = r.status === 'ok' ? G('✓') : R('✗');
    const status = r.status === 'ok' ? G('ok') : R('fail');
    const note   = r.status === 'failed' ? R(`  ${r.error?.slice(0, 50) ?? 'unknown'}`) : '';
    console.log(
      `${icon}  ` +
      padEnd(r.source_id, 28) +
      padEnd(status, 10) +
      padEnd(r.status === 'ok' ? String(r.new_articles)     : '—', 8) +
      padEnd(r.status === 'ok' ? String(r.exact_duplicates) : '—', 8) +
      padEnd(r.status === 'ok' ? String(r.syndicated)       : '—', 8) +
      padEnd(r.status === 'ok' ? String(r.stale_skipped)    : '—', 8) +
      D(`${r.duration_ms}ms`) +
      note,
    );
  }
  console.log('─'.repeat(88));
  const twitterNew = twitterResults.reduce((s, r) => s + r.new_articles, 0);
  console.log(`${G(String(twitterNew) + ' new')}  |  ${twitterResults.filter(r => r.status === 'ok').length} accounts ok`);
  console.log('');
}

if (summary.sources_failed > 0 && summary.sources_ok === 0) {
  logger.error('collect', 'All sources failed');
  process.exit(1);
}
