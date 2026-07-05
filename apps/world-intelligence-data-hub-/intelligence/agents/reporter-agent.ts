import Anthropic           from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join }            from 'path';
import type { ArticleRecord }       from '../../lib/types.ts';
import type { IntelligenceEvent, ActorType, OrgType } from '../schema/intelligence-event.ts';
import { generateEventId, emptyGraph, validateEvent, computeEventState } from '../schema/intelligence-event.ts';
import { requireKey }      from '../../lib/env.ts';
import { logger }          from '../../lib/logger.ts';
import { PATHS }           from '../../lib/paths.ts';
import { writeJsonAtomic } from '../../lib/atomic-fs.ts';
import { updateExtractionMetrics } from '../metrics/metrics-store.ts';
import { recordArticleEvents }     from '../metrics/article-event-map.ts';
import {
  MODEL, EXTRACTION_VERSION, PROMPT_VERSION, MAX_TOKENS, BATCH_SIZE,
  SYSTEM_PROMPT, EXTRACTION_TOOL, PRICING,
} from './prompts/extractor-v2.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExtractedEvent {
  title:                  string;
  event_type:             string;
  short_summary:          string;
  countries:              string[];
  individuals?:           Array<{ name: string; role?: string; country?: string; actor_type: string }>;
  organizations?:         Array<{ name: string; country?: string; org_type: string }>;
  severity:               1 | 2 | 3 | 4 | 5;
  confidence_score:       number;
  geopolitical_relevance: number;
  escalation_potential:   number;
  market_relevance:       number;
  evidence_quotes:        string[];
  article_ids:            string[];
  human_review_required:  boolean;
  human_review_reason?:   string;
}

interface SourceArticleFile {
  source_id:   string;
  date:        string;
  stats:       Record<string, number>;
  articles:    ArticleRecord[];
}

interface EventOutputFile {
  date:               string;
  generated_at:       string;
  extraction_version: string;
  prompt_version:     string;
  model:              string;
  stats: {
    articles_processed: number;
    batches_run:        number;
    events_extracted:   number;
    events_merged:      number;
    human_review_count: number;
    tokens: {
      input:        number;
      output:       number;
      cache_write:  number;
      cache_read:   number;
    };
    estimated_cost_usd: number;
  };
  events: IntelligenceEvent[];
}

export interface ReporterRunResult {
  articles_processed:   number;
  batches_run:          number;
  events_extracted:     number;
  events_merged:        number;
  human_review_count:   number;
  estimated_cost_usd:   number;
  output_path:          string;
}

// ── Article loading ───────────────────────────────────────────────────────────

function loadPendingArticles(date: string): {
  articles: ArticleRecord[];
  bySource: Map<string, { filePath: string; file: SourceArticleFile }>;
} {
  const dir = join(PATHS.intelligence.outputArticles, date);
  if (!existsSync(dir)) return { articles: [], bySource: new Map() };

  const bySource = new Map<string, { filePath: string; file: SourceArticleFile }>();
  const pending: ArticleRecord[] = [];

  for (const fname of readdirSync(dir).filter(f => f.endsWith('.json') && !f.includes('scoring'))) {
    const fp = join(dir, fname);
    const file = JSON.parse(readFileSync(fp, 'utf-8')) as SourceArticleFile;
    bySource.set(file.source_id, { filePath: fp, file });
    for (const a of file.articles) {
      if (a.lifecycle.ai_status === 'pending' && a.scoring?.recommended_for_ai === true) {
        pending.push(a);
      }
    }
  }

  return { articles: pending, bySource };
}

// ── Batching ──────────────────────────────────────────────────────────────────

function batchArticles(articles: ArticleRecord[], size: number): ArticleRecord[][] {
  const batches: ArticleRecord[][] = [];
  for (let i = 0; i < articles.length; i += size) {
    batches.push(articles.slice(i, i + size));
  }
  return batches;
}

// ── Prompt builder ────────────────────────────────────────────────────────────

// Raw article title/description are untrusted third-party text. Strip angle
// brackets before splicing into the <article> tags below so a malicious
// article body can't fake a closing tag and break out of its own boundary.
function escapeForArticleTag(s: string): string {
  return s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildUserPrompt(batch: ArticleRecord[]): string {
  const lines: string[] = [
    `Extract intelligence events from the following ${batch.length} article${batch.length > 1 ? 's' : ''}.\n`,
  ];

  for (let i = 0; i < batch.length; i++) {
    const a = batch[i]!;
    const escTitle = escapeForArticleTag(a.title);
    const escDesc  = a.description ? escapeForArticleTag(a.description.slice(0, 350)) : '';
    const score = a.scoring ? ` | relevance=${a.scoring.relevance_score}` : '';
    lines.push(
      `Source: ${a.source_name} (Tier ${a.reliability_tier}${score})`,
      `Published: ${a.published_at}`,
      `URL: ${a.url}`,
      `<article index="${i + 1}" id="${a.id}">`,
      `<title>${escTitle}</title>`,
      ...(escDesc ? [`<description>${escDesc}</description>`] : []),
      `</article>`,
      '',
    );
  }

  lines.push('Call extract_events with all events found, or an empty array if none are relevant.');
  return lines.join('\n');
}

// ── Claude API call ───────────────────────────────────────────────────────────

interface BatchCallResult {
  events:       ExtractedEvent[];
  inputTokens:  number;
  outputTokens: number;
  cacheWrite:   number;
  cacheRead:    number;
}

async function callClaude(
  batch:      ArticleRecord[],
  anthropic:  Anthropic,
): Promise<BatchCallResult> {
  const userPrompt = buildUserPrompt(batch);

  const response = await anthropic.messages.create({
    model:      MODEL,
    max_tokens: MAX_TOKENS,
    // Cache the system prompt — stable across all batch calls.
    // Sonnet 4.6 minimum cache prefix: 2048 tokens.
    // System + tool definition together should comfortably exceed this.
    system: [
      {
        type:          'text',
        text:          SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userPrompt }],
    tools:       [EXTRACTION_TOOL as unknown as Anthropic.Tool],
    tool_choice: { type: 'tool', name: 'extract_events' },
  });

  const toolBlock = response.content.find(b => b.type === 'tool_use');
  if (!toolBlock || toolBlock.type !== 'tool_use') {
    throw new Error('Claude did not call extract_events tool');
  }

  const input = toolBlock.input as { events: ExtractedEvent[] };
  if (!Array.isArray(input.events)) {
    throw new Error('Tool response missing events array');
  }

  const u = response.usage;
  return {
    events:       input.events,
    inputTokens:  u.input_tokens,
    outputTokens: u.output_tokens,
    cacheWrite:   (u as Anthropic.Usage & { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0,
    cacheRead:    (u as Anthropic.Usage & { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0,
  };
}

// ── Event construction ────────────────────────────────────────────────────────

function buildIntelligenceEvent(
  extracted:  ExtractedEvent,
  articleMap: Map<string, ArticleRecord>,
  date:       string,
  now:        string,
): IntelligenceEvent | null {
  const sourceArticles = extracted.article_ids
    .map(id => articleMap.get(id))
    .filter((a): a is ArticleRecord => !!a);

  if (sourceArticles.length === 0) {
    logger.warn('reporter', 'Event references unknown article_ids — skipping');
    return null;
  }

  // Primary article = highest relevance_score in the source set.
  // This is stable within a day — used as the anchor for deterministic event_id.
  const primaryArticle = [...sourceArticles]
    .sort((a, b) => (b.scoring?.relevance_score ?? 0) - (a.scoring?.relevance_score ?? 0))[0]!;
  const primaryArticleId = primaryArticle.id;

  // event_id is derived from structured metadata only — no AI text involved.
  const eventId = generateEventId(primaryArticleId, extracted.event_type, date);

  // Use Claude's title directly — safety slice only, no sentence splitting
  const title = extracted.title.trim().slice(0, 200);

  // Earliest published_at across source articles
  const firstSeenAt = sourceArticles
    .map(a => a.published_at)
    .sort()[0] ?? now;

  // Use Claude's actor classifications directly — no keyword heuristic
  const individuals: IntelligenceEvent['actors']['individuals'] = (extracted.individuals ?? []).map(a => ({
    name:       a.name,
    role:       a.role,
    country:    a.country,
    actor_type: a.actor_type as ActorType,
  }));

  const organizations: IntelligenceEvent['actors']['organizations'] = (extracted.organizations ?? []).map(o => ({
    name:     o.name,
    org_type: o.org_type as OrgType,
    country:  o.country,
  }));

  const articleRefs = sourceArticles.map(a => ({
    article_id:       a.id,
    source_id:        a.source_id,
    source_name:      a.source_name,
    reliability_tier: a.reliability_tier,
    title:            a.title,
    url:              a.url,
    published_at:     a.published_at,
    relevance_score:  a.scoring?.relevance_score,
  }));

  const event: IntelligenceEvent = {
    event_id:       eventId,
    schema_version: '1.0',

    identity: {
      extraction_model:   MODEL,
      extraction_version: EXTRACTION_VERSION,
      prompt_version:     PROMPT_VERSION,
      extracted_at:       now,
      first_seen_at:      firstSeenAt,
      updated_at:         now,
      event_revision:     0,
      last_enriched_at:   now,
    },

    event: {
      title,
      summary:          extracted.short_summary,
      event_type:       extracted.event_type as IntelligenceEvent['event']['event_type'],
      severity:         extracted.severity,
      confidence_score: extracted.confidence_score,
      status:           'developing',
    },

    geography: {
      countries: extracted.countries.filter(c => /^[A-Z]{2,3}$/.test(c)),
    },

    actors: {
      individuals:   individuals.length > 0   ? individuals   : undefined,
      organizations: organizations.length > 0 ? organizations : undefined,
    },

    market_impact: {
      relevance:  extracted.market_relevance,
      direction:  'uncertain',
    },

    geopolitical_scores: {
      relevance:            extracted.geopolitical_relevance,
      strategic_importance: extracted.geopolitical_relevance,  // proxy for MVP
      escalation_potential: extracted.escalation_potential,
    },

    tags: {},

    sources: {
      source_ids:            sourceArticles.map(a => a.id),
      source_count:          sourceArticles.length,
      extracted_from:        articleRefs,
      evidence_quotes:       extracted.evidence_quotes.length > 0 ? extracted.evidence_quotes : undefined,
      human_review_required: extracted.human_review_required
        || sourceArticles.some(a => a.scoring?.cross_reference_required)
        || undefined,
      human_review_reason: extracted.human_review_reason
        || (sourceArticles.some(a => a.scoring?.cross_reference_required)
            ? 'Contains Tier 3 state media source — cross-reference required'
            : undefined),
      runs_seen:       1,
      latest_seen_at:  now,
    },

    graph: emptyGraph(),

    lifecycle: {
      processing_status: 'extracted',
      event_state: computeEventState({
        runs_seen:             1,
        source_count:          sourceArticles.length,
        confidence_score:      extracted.confidence_score,
        human_review_required: extracted.human_review_required
          || sourceArticles.some(a => a.scoring?.cross_reference_required),
      }),
    },
  };

  // Validate against full schema
  const check = validateEvent(event);
  if (!check.success) {
    logger.warn('reporter', `Event failed schema validation — skipping: ${check.error}`);
    return null;
  }

  return check.data;
}

// ── Event merge ───────────────────────────────────────────────────────────────

function mergeEvents(
  existing: IntelligenceEvent[],
  incoming: IntelligenceEvent[],
  now:      string,
): { merged: IntelligenceEvent[]; newCount: number; mergedCount: number } {
  const byId = new Map(existing.map(e => [e.event_id, e]));
  let newCount    = 0;
  let mergedCount = 0;

  for (const ev of incoming) {
    const old = byId.get(ev.event_id);
    if (!old) {
      byId.set(ev.event_id, ev);
      newCount++;
      continue;
    }

    // Merge: add source articles not already recorded
    const existingIds = new Set(old.sources.source_ids);
    const newIds      = ev.sources.source_ids.filter(id => !existingIds.has(id));
    if (newIds.length > 0) {
      byId.set(ev.event_id, {
        ...old,
        identity: {
          ...old.identity,
          updated_at:           now,
          event_revision:       (old.identity.event_revision ?? 0) + 1,
          updated_from_sources: newIds,
          last_enriched_at:     now,
        },
        sources: {
          ...old.sources,
          source_ids:    [...old.sources.source_ids, ...newIds],
          source_count:  old.sources.source_count + newIds.length,
          extracted_from: [
            ...old.sources.extracted_from,
            ...ev.sources.extracted_from.filter(r => !existingIds.has(r.article_id)),
          ],
          evidence_quotes: old.sources.evidence_quotes,
          runs_seen:      (old.sources.runs_seen ?? 1) + 1,
          latest_seen_at: now,
        },
        lifecycle: {
          ...old.lifecycle,
          requires_reextract: true,
          event_state: computeEventState({
            runs_seen:             (old.sources.runs_seen ?? 1) + 1,
            source_count:          old.sources.source_count + newIds.length,
            confidence_score:      old.event.confidence_score,
            human_review_required: old.sources.human_review_required ?? false,
          }),
        },
      });
      mergedCount++;
    }
  }

  return { merged: [...byId.values()], newCount, mergedCount };
}

// ── Persistence ───────────────────────────────────────────────────────────────

function loadEventFile(date: string): EventOutputFile | null {
  const p = join(PATHS.intelligence.outputEvents, `${date}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as EventOutputFile;
  } catch {
    return null;
  }
}

function saveEventFile(file: EventOutputFile): string {
  const p = join(PATHS.intelligence.outputEvents, `${file.date}.json`);
  writeJsonAtomic(p, file);
  return p;
}

// Merges accumulated events with the existing on-disk set and saves the
// result via writeJsonAtomic. Safe to call after every batch — writeJsonAtomic
// does a full atomic overwrite each time, so re-running this with a growing
// `allExtracted` array is idempotent and bounds any crash's data loss to at
// most the batch currently in flight, not the whole day's run.
function persistProgress(
  date:              string,
  now:               string,
  existingEvents:    IntelligenceEvent[],
  allExtracted:      IntelligenceEvent[],
  batchesRun:        number,
  articlesProcessed: number,
  tokenTotals:       { input: number; output: number; cache_write: number; cache_read: number },
): {
  outputPath:     string;
  merged:         IntelligenceEvent[];
  newCount:       number;
  mergedCount:    number;
  humanReviewCount: number;
  estimatedCost:  number;
} {
  const { merged, newCount, mergedCount } = mergeEvents(existingEvents, allExtracted, now);
  const humanReviewCount = merged.filter(e => e.sources.human_review_required).length;
  const estimatedCost    = calcCost(tokenTotals);

  const outputFile: EventOutputFile = {
    date,
    generated_at:       now,
    extraction_version: EXTRACTION_VERSION,
    prompt_version:     PROMPT_VERSION,
    model:              MODEL,
    stats: {
      articles_processed: articlesProcessed,
      batches_run:        batchesRun,
      events_extracted:   newCount,
      events_merged:      mergedCount,
      human_review_count: humanReviewCount,
      tokens:             tokenTotals,
      estimated_cost_usd: estimatedCost,
    },
    events: merged,
  };

  const outputPath = saveEventFile(outputFile);
  return { outputPath, merged, newCount, mergedCount, humanReviewCount, estimatedCost };
}

function updateArticleStatuses(
  bySource:     Map<string, { filePath: string; file: SourceArticleFile }>,
  processedIds: Set<string>,
): void {
  for (const { filePath, file } of bySource.values()) {
    let dirty = false;
    for (const article of file.articles) {
      if (processedIds.has(article.id)) {
        article.lifecycle.ai_status = 'extracted';
        dirty = true;
      }
    }
    if (dirty) {
      writeFileSync(filePath, JSON.stringify(file, null, 2));
    }
  }
}

// ── Cost calculation ──────────────────────────────────────────────────────────

function calcCost(tokens: { input: number; output: number; cache_write: number; cache_read: number }): number {
  return (
    tokens.input       * PRICING.input       +
    tokens.output      * PRICING.output      +
    tokens.cache_write * PRICING.cacheWrite  +
    tokens.cache_read  * PRICING.cacheRead
  ) / 1_000_000;
}

// ── Main run ──────────────────────────────────────────────────────────────────

export interface RunOpts {
  dryRun?:   boolean;
  batchSize?: number;
}

export async function run(date: string, opts: RunOpts = {}): Promise<ReporterRunResult> {
  const { dryRun = false, batchSize = BATCH_SIZE } = opts;
  const now = new Date().toISOString();

  // 1. Load pending articles
  const { articles, bySource } = loadPendingArticles(date);

  if (articles.length === 0) {
    logger.info('reporter', `No pending articles for ${date}`);
    return {
      articles_processed: 0, batches_run: 0, events_extracted: 0,
      events_merged: 0, human_review_count: 0, estimated_cost_usd: 0,
      output_path: '',
    };
  }

  logger.info('reporter', `${articles.length} pending articles for ${date}`);

  // 2. Batch
  const batches = batchArticles(articles, batchSize);
  logger.info('reporter', `${batches.length} batches of ≤${batchSize} articles each`);

  if (dryRun) {
    logger.info('reporter', '-- DRY RUN: would process --');
    for (let i = 0; i < batches.length; i++) {
      const b = batches[i]!;
      logger.info('reporter', `Batch ${i + 1}/${batches.length} (${b.length} articles):`);
      for (const a of b) {
        logger.info('reporter', `  [${a.scoring?.relevance_score ?? '?'}] ${a.title.slice(0, 70)}`);
      }
    }
    // Rough cost estimate (assume ~1400 input + 500 output per batch)
    const roughCost = batches.length * calcCost({ input: 1400, output: 500, cache_write: 800, cache_read: 600 });
    logger.info('reporter', `Estimated cost: ~$${roughCost.toFixed(4)}`);
    return {
      articles_processed: articles.length, batches_run: 0, events_extracted: 0,
      events_merged: 0, human_review_count: 0, estimated_cost_usd: roughCost,
      output_path: '',
    };
  }

  // 3. Init Anthropic client
  const apiKey   = requireKey('ANTHROPIC_API_KEY', 'reporter-agent');
  const anthropic = new Anthropic({ apiKey });

  // 4. Build article lookup map
  const articleMap = new Map(articles.map(a => [a.id, a]));

  // 5. Load existing event file (for merge)
  const existing = loadEventFile(date);
  const existingEvents = existing?.events ?? [];

  // 6. Process batches
  const allExtracted: IntelligenceEvent[] = [];
  const processedIds  = new Set<string>();
  const tokenTotals   = { input: 0, output: 0, cache_write: 0, cache_read: 0 };
  let batchesRun      = 0;
  let eventFailures   = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    logger.info('reporter', `Batch ${i + 1}/${batches.length} — calling Claude (${batch.length} articles)…`);

    let result: BatchCallResult;
    try {
      result = await callClaude(batch, anthropic);
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        logger.warn('reporter', 'Rate limited — waiting 60s');
        await new Promise(r => setTimeout(r, 60_000));
        try {
          result = await callClaude(batch, anthropic);
        } catch (retryErr) {
          logger.error('reporter', `Batch ${i + 1} failed after rate-limit retry: ${(retryErr as Error).message} — skipping batch`);
          continue;
        }
      } else {
        logger.error('reporter', `Batch ${i + 1} failed: ${(err as Error).message} — skipping batch`);
        continue;
      }
    }

    batchesRun++;
    tokenTotals.input       += result.inputTokens;
    tokenTotals.output      += result.outputTokens;
    tokenTotals.cache_write += result.cacheWrite;
    tokenTotals.cache_read  += result.cacheRead;

    logger.info('reporter', `Batch ${i + 1}: ${result.events.length} events extracted | ` +
      `tokens in=${result.inputTokens} out=${result.outputTokens} ` +
      `cache_write=${result.cacheWrite} cache_read=${result.cacheRead}`);

    // Mark all batch articles as processed
    for (const a of batch) processedIds.add(a.id);

    // Build IntelligenceEvents — one malformed event from the LLM must not
    // take down the rest of the batch (or the whole run).
    for (let j = 0; j < result.events.length; j++) {
      const extracted = result.events[j]!;
      try {
        const event = buildIntelligenceEvent(extracted, articleMap, date, now);
        if (event) allExtracted.push(event);
      } catch (err) {
        eventFailures++;
        logger.error(
          'reporter',
          `Batch ${i + 1}, event ${j + 1} (article_ids=${(extracted.article_ids ?? []).join(',') || 'unknown'}) ` +
          `failed to build — skipping: ${(err as Error).message}`,
        );
      }
    }

    // Incremental persistence — save after every batch so a crash anywhere
    // in the loop loses at most the batch currently in progress, never the
    // whole day's run. writeJsonAtomic (inside persistProgress → saveEventFile)
    // does a full atomic overwrite, so re-saving the growing accumulated
    // array on each iteration is safe and idempotent.
    persistProgress(date, now, existingEvents, allExtracted, batchesRun, articles.length, tokenTotals);
  }

  if (eventFailures > 0) {
    logger.warn('reporter', `${eventFailures} event(s) failed to build and were skipped`);
  }

  // 7. Final merge + save (recomputes from the fully accumulated state —
  // same idempotent persistProgress path used incrementally above).
  const { outputPath, merged, newCount, mergedCount, humanReviewCount, estimatedCost } =
    persistProgress(date, now, existingEvents, allExtracted, batchesRun, articles.length, tokenTotals);
  logger.info('reporter', `Events saved → ${outputPath}`);

  // 9. Persist article ↔ event mapping
  for (const event of merged) {
    const articleIds = event.sources.source_ids;
    recordArticleEvents(articleIds, event.event_id, event.event.event_type, date);
  }
  logger.debug('reporter', `Article-event map updated (${merged.length} events)`);

  // 10. Update article ai_status
  updateArticleStatuses(bySource, processedIds);
  logger.info('reporter', `Updated ai_status on ${processedIds.size} articles`);

  // 11. Record extraction metrics
  const lowConfCount = allExtracted.filter(e => e.event.confidence_score < 0.5).length;
  updateExtractionMetrics(date, {
    articles_sent_to_ai: articles.length,
    batches_run:         batchesRun,
    events_extracted:    newCount,
    events_merged:       mergedCount,
    low_confidence:      lowConfCount,
    human_review:        humanReviewCount,
    api_tokens: {
      input:       tokenTotals.input,
      output:      tokenTotals.output,
      cache_write: tokenTotals.cache_write,
      cache_read:  tokenTotals.cache_read,
    },
    estimated_cost_usd: estimatedCost,
  });

  return {
    articles_processed: articles.length,
    batches_run:        batchesRun,
    events_extracted:   newCount,
    events_merged:      mergedCount,
    human_review_count: humanReviewCount,
    estimated_cost_usd: estimatedCost,
    output_path:        outputPath,
  };
}
