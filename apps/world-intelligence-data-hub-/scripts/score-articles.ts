// Score collected articles by geopolitical/economic relevance.
// Usage:
//   npm run score                     — score today's articles
//   npm run score -- 2026-05-12       — score a specific date
//   npm run score -- --dry-run        — show scores without writing files

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { scoreArticles, RECOMMENDATION_THRESHOLD } from '../intelligence/scoring/article-scorer.ts';
import type { ArticleRecord } from '../lib/types.ts';
import { PATHS }                from '../lib/paths.ts';
import { logger }               from '../lib/logger.ts';
import { updateScoringMetrics } from '../intelligence/metrics/metrics-store.ts';

// ── Args ──────────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const dryRun  = args.includes('--dry-run');
const dateArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
const date    = dateArg ?? new Date().toISOString().slice(0, 10);

// ── Colors ────────────────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY;
const col   = (c: string, s: string) => isTTY ? `${c}${s}\x1b[0m` : s;
const G  = (s: string) => col('\x1b[32m', s);
const R  = (s: string) => col('\x1b[31m', s);
const Y  = (s: string) => col('\x1b[33m', s);
const C  = (s: string) => col('\x1b[36m', s);
const D  = (s: string) => col('\x1b[90m', s);
const B  = (s: string) => col('\x1b[1m',  s);

function bar(n: number, total: number, width = 20): string {
  const filled = Math.round((n / total) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function padEnd(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

// ── Source output file structure ──────────────────────────────────────────────

interface SourceOutputFile {
  source_id:    string;
  date:         string;
  generated_at: string;
  stats:        Record<string, number>;
  articles:     ArticleRecord[];
}

// ── Load all article files for the date ──────────────────────────────────────

const articleDir = join(PATHS.intelligence.outputArticles, date);
if (!existsSync(articleDir)) {
  logger.error('score', `No articles found for ${date} — run npm run collect first`);
  process.exit(1);
}

const sourceFiles = readdirSync(articleDir)
  .filter(f => f.endsWith('.json') && f !== 'scoring-summary.json');

if (sourceFiles.length === 0) {
  logger.error('score', `No source files in ${articleDir}`);
  process.exit(1);
}

// ── Score all articles ────────────────────────────────────────────────────────

console.log('');
console.log(B('World Intelligence — Article Scorer'));
console.log(D(`Date: ${date}  |  Threshold: ${RECOMMENDATION_THRESHOLD}${dryRun ? '  |  DRY RUN' : ''}`));
console.log('');

let allArticles: ArticleRecord[] = [];

for (const file of sourceFiles) {
  const raw = JSON.parse(readFileSync(join(articleDir, file), 'utf-8')) as SourceOutputFile;
  allArticles = allArticles.concat(raw.articles);
}

const total = allArticles.length;
logger.info('score', `Scoring ${total} articles from ${sourceFiles.length} sources…`);

const scored = scoreArticles(allArticles);

// ── Score distribution ────────────────────────────────────────────────────────

const bands = [
  { label: '80-100',  min: 80,  max: 100, tag: 'urgent',   color: G },
  { label: '60-79',   min: 60,  max: 79,  tag: 'high',     color: C },
  { label: '40-59',   min: 40,  max: 59,  tag: 'relevant', color: Y },
  { label: '20-39',   min: 20,  max: 39,  tag: 'marginal', color: D },
  { label: '0-19',    min: 0,   max: 19,  tag: 'noise',    color: R },
] as const;

const recommended     = scored.filter(a => a.scoring!.recommended_for_ai).length;
const narrativeCount  = scored.filter(a => a.scoring!.narrative_source).length;
const standardCount   = recommended - narrativeCount;
const filtered        = total - recommended;

console.log(B('Score distribution:'));
console.log('');
for (const band of bands) {
  const count = scored.filter(a => {
    const s = a.scoring!.relevance_score;
    return s >= band.min && s <= band.max;
  }).length;
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  const b   = bar(count, total);
  console.log(
    `  ${band.color(padEnd(band.label, 8))}  ` +
    `${D(b)}  ` +
    `${String(count).padStart(4)}  (${String(pct).padStart(2)}%)  ` +
    D(band.tag),
  );
}

console.log('');
console.log(
  B('Recommended for AI:  ') +
  G(`${recommended}`) + D(`/${total}`) +
  `  (${Math.round((recommended / total) * 100)}%)`,
);
console.log(
  B('  Standard track:    ') +
  G(`${standardCount}`) + D('  (score ≥ 35)'),
);
if (narrativeCount > 0) {
  console.log(
    B('  Narrative track:   ') +
    Y(`${narrativeCount}`) + D('  (Tier 3 state media, score 25–34, cross-ref required)'),
  );
}
console.log(
  B('Filtered out:        ') +
  R(`${filtered}`) + D(`/${total}`) +
  `  (${Math.round((filtered / total) * 100)}%)`,
);

// ── Top scoring articles ──────────────────────────────────────────────────────

const topN = scored
  .filter(a => a.scoring!.recommended_for_ai)
  .sort((a, b) => b.scoring!.relevance_score - a.scoring!.relevance_score)
  .slice(0, 8);

if (topN.length > 0) {
  console.log('');
  console.log(B('Top articles:'));
  for (const a of topN) {
    const s = a.scoring!.relevance_score;
    const scoreCol = s >= 80 ? G : s >= 60 ? C : Y;
    console.log(
      `  [${scoreCol(String(s).padStart(3))}]  ` +
      `${a.title.slice(0, 65).padEnd(65)}  ` +
      D(a.source_id),
    );
  }
}

// ── Lowest scoring articles (excluded) ───────────────────────────────────────

const bottomN = scored
  .filter(a => !a.scoring!.recommended_for_ai)
  .sort((a, b) => a.scoring!.relevance_score - b.scoring!.relevance_score)
  .slice(0, 5);

if (bottomN.length > 0) {
  console.log('');
  console.log(B('Lowest scoring (filtered):'));
  for (const a of bottomN) {
    const s = a.scoring!.relevance_score;
    console.log(
      `  [${R(String(s).padStart(3))}]  ` +
      `${a.title.slice(0, 65).padEnd(65)}  ` +
      D(a.source_id),
    );
  }
}

// ── Per-source breakdown ──────────────────────────────────────────────────────

const bySource: Record<string, { total: number; recommended: number; narrative: number }> = {};
for (const a of scored) {
  const src = a.source_id;
  if (!bySource[src]) bySource[src] = { total: 0, recommended: 0, narrative: 0 };
  bySource[src].total++;
  if (a.scoring!.recommended_for_ai) bySource[src].recommended++;
  if (a.scoring!.narrative_source)   bySource[src].narrative++;
}

console.log('');
console.log(B('Per-source:'));
for (const [src, counts] of Object.entries(bySource).sort((a, b) => b[1].recommended - a[1].recommended)) {
  const pct      = Math.round((counts.recommended / counts.total) * 100);
  const bar2     = bar(counts.recommended, counts.total, 15);
  const narrNote = counts.narrative > 0 ? Y(` +${counts.narrative} narrative`) : '';
  console.log(
    `  ${padEnd(src, 26)}  ${D(bar2)}  ` +
    `${counts.recommended}/${counts.total} (${pct}%)` + narrNote,
  );
}

// ── Write back scored articles ────────────────────────────────────────────────

if (!dryRun) {
  // Group scored articles back by source
  const bySourceMap: Record<string, ArticleRecord[]> = {};
  for (const a of scored) {
    if (!bySourceMap[a.source_id]) bySourceMap[a.source_id] = [];
    bySourceMap[a.source_id].push(a);
  }

  for (const file of sourceFiles) {
    const sourceId = file.replace('.json', '');
    const sourceArticles = bySourceMap[sourceId] ?? [];
    const filePath = join(articleDir, file);
    const original = JSON.parse(readFileSync(filePath, 'utf-8')) as SourceOutputFile;

    const updated: SourceOutputFile = {
      ...original,
      generated_at: new Date().toISOString(),
      stats: {
        ...original.stats,
        scored:          sourceArticles.length,
        recommended:     sourceArticles.filter(a => a.scoring!.recommended_for_ai).length,
        filtered:        sourceArticles.filter(a => !a.scoring!.recommended_for_ai).length,
        avg_score:       Math.round(
          sourceArticles.reduce((s, a) => s + a.scoring!.relevance_score, 0) /
          (sourceArticles.length || 1),
        ),
      },
      articles: sourceArticles,
    };

    writeFileSync(filePath, JSON.stringify(updated, null, 2));
  }

  // Write scoring summary
  const summary = {
    date,
    scored_at:    new Date().toISOString(),
    threshold:    RECOMMENDATION_THRESHOLD,
    total:        total,
    recommended:  recommended,
    filtered:     filtered,
    reduction_pct: Math.round((filtered / total) * 100),
    by_source:    bySource,
    score_distribution: Object.fromEntries(
      bands.map(b => [b.tag, scored.filter(a => {
        const s = a.scoring!.relevance_score;
        return s >= b.min && s <= b.max;
      }).length])
    ),
  };

  const summaryPath = join(articleDir, 'scoring-summary.json');
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  // Record scoring metrics
  const sourceScoringMetrics: Record<string, { total: number; recommended: number }> = {};
  for (const [src, counts] of Object.entries(summary.by_source)) {
    sourceScoringMetrics[src] = counts as { total: number; recommended: number };
  }
  updateScoringMetrics(date, {
    total_scored:       summary.total,
    recommended:        summary.recommended,
    filtered:           summary.filtered,
    reduction_pct:      summary.reduction_pct,
    score_distribution: {
      urgent:   (summary.score_distribution as Record<string, number>)['urgent']   ?? 0,
      high:     (summary.score_distribution as Record<string, number>)['high']     ?? 0,
      relevant: (summary.score_distribution as Record<string, number>)['relevant'] ?? 0,
      marginal: (summary.score_distribution as Record<string, number>)['marginal'] ?? 0,
      noise:    (summary.score_distribution as Record<string, number>)['noise']    ?? 0,
    },
    by_source: sourceScoringMetrics,
  });

  console.log('');
  console.log(D(`Scored articles written back to ${articleDir}/`));
  console.log(D(`Summary → ${summaryPath}`));
}

console.log('');
