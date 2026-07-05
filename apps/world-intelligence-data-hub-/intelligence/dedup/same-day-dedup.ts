// Same-day event deduplication — deterministic, no AI.
//
// Problem: when N batches run on the same day, the same real-world event
// (e.g. the Hormuz blockade) can be extracted from multiple source articles
// in separate batches, producing duplicate events with different event_ids.
//
// Solution: after extraction, scan the day's event file for events that match
// on event_type + primary country + text similarity + actor overlap, and merge
// them into a single canonical event.
//
// Merge criteria (all required):
//   1. Same event_type
//   2. Same primary country (geography.countries[0])
//   3. Actor name overlap, OR both events have no actors
//   4. Combined title+summary word Jaccard ≥ SIMILARITY_THRESHOLD
//
// Merge outcome:
//   - Canonical = highest confidence_score event in the group
//   - Severity, escalation_potential, confidence: take max
//   - Countries, actors, source_ids, evidence_quotes: union (deduplicated)
//   - merged_from_event_ids: list of absorbed event IDs
//   - Risky flag: set when actor sets are both non-empty and fully disjoint

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join }                                    from 'path';
import type { IntelligenceEvent }                  from '../schema/intelligence-event.ts';
import { computeEventState }                       from '../schema/intelligence-event.ts';
import { PATHS }                                   from '../../lib/paths.ts';
import { logger }                                  from '../../lib/logger.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

// Minimum word-Jaccard on combined title+summary to be merge candidates.
// Tuned so that same-event duplicates (~0.28–0.45) merge while thematically
// similar but distinct events (~0.10–0.20) do not.
const SIMILARITY_THRESHOLD = 0.25;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MergeRecord {
  canonical_id:    string;
  merged_ids:      string[];
  canonical_title: string;
  merged_titles:   string[];
  similarity:      number;
  match_reasons:   string[];
  risky:           boolean;
  risk_reason?:    string;
}

export interface DedupResult {
  date:             string;
  events_before:    number;
  events_after:     number;
  merges:           MergeRecord[];
  uncertain_merges: MergeRecord[];
  final_events:     IntelligenceEvent[];  // post-dedup list (not written if dry-run)
}

interface EventOutputFile {
  date:               string;
  generated_at:       string;
  extraction_version: string;
  prompt_version:     string;
  model:              string;
  stats:              Record<string, unknown>;
  events:             IntelligenceEvent[];
}

// ── Text similarity ───────────────────────────────────────────────────────────

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Words longer than 3 chars — removes most stop words without a word list.
function meaningfulWords(text: string): Set<string> {
  return new Set(normalizeText(text).split(' ').filter(w => w.length > 3));
}

function wordJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

// Title-only similarity — tighter signal than combined text.
// Summaries can diverge significantly for the same event when different
// source articles emphasize different angles; titles converge on core facts.
function eventTextWords(e: IntelligenceEvent): Set<string> {
  return meaningfulWords(e.event.title);
}

// ── Actor overlap ─────────────────────────────────────────────────────────────

function actorNameWords(e: IntelligenceEvent): Set<string>[] {
  return [
    ...(e.actors.individuals   ?? []).map(a => meaningfulWords(a.name)),
    ...(e.actors.organizations ?? []).map(o => meaningfulWords(o.name)),
  ];
}

function hasActors(e: IntelligenceEvent): boolean {
  return (e.actors.individuals?.length ?? 0) > 0
      || (e.actors.organizations?.length ?? 0) > 0;
}

// True if any actor word-set from A shares at least one word with any from B,
// OR if either event has no actors (actors can't discriminate without data).
function actorSetsOverlap(a: IntelligenceEvent, b: IntelligenceEvent): boolean {
  if (!hasActors(a) || !hasActors(b)) return true;  // no data → non-discriminating
  const aSets = actorNameWords(a);
  const bSets = actorNameWords(b);
  for (const aW of aSets) {
    for (const bW of bSets) {
      for (const w of aW) if (bW.has(w)) return true;
    }
  }
  return false;
}

// True only when BOTH events have actors AND no word overlaps at all.
function actorSetsDisjoint(a: IntelligenceEvent, b: IntelligenceEvent): boolean {
  return hasActors(a) && hasActors(b) && !actorSetsOverlap(a, b);
}

// ── Candidate detection ───────────────────────────────────────────────────────

interface Candidate { i: number; j: number; sim: number; risky: boolean; riskReason?: string }

function findCandidates(events: IntelligenceEvent[]): Candidate[] {
  const wordSets = events.map(eventTextWords);
  const out: Candidate[] = [];

  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i]!, b = events[j]!;

      if (a.event.event_type !== b.event.event_type)         continue;
      if (a.geography.countries[0] !== b.geography.countries[0]) continue;
      if (!actorSetsOverlap(a, b))                           continue;

      const sim = wordJaccard(wordSets[i]!, wordSets[j]!);
      if (sim < SIMILARITY_THRESHOLD) continue;

      const risky      = actorSetsDisjoint(a, b);
      const riskReason = risky
        ? 'Both events have actors but no actor name overlap — verify these are the same event'
        : undefined;

      out.push({ i, j, sim, risky, riskReason });
    }
  }
  return out;
}

// ── Union-find (transitive grouping) ──────────────────────────────────────────

function buildGroups(n: number, candidates: Candidate[]): number[][] {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]!; }
    return x;
  };
  for (const { i, j } of candidates) parent[find(i)] = find(j);

  const map = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!map.has(r)) map.set(r, []);
    map.get(r)!.push(i);
  }
  return [...map.values()].filter(g => g.length > 1);
}

// ── Merge helpers ─────────────────────────────────────────────────────────────

function dedupeByKey<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter(t => { const k = key(t); if (seen.has(k)) return false; seen.add(k); return true; });
}

function mergeGroup(
  group: number[],
  events: IntelligenceEvent[],
  candidates: Candidate[],
  now: string,
): { merged: IntelligenceEvent; record: MergeRecord } {
  const groupEvts = group.map(i => events[i]!);

  // Canonical = highest confidence
  const canonical = [...groupEvts].sort(
    (a, b) => b.event.confidence_score - a.event.confidence_score,
  )[0]!;
  const others = groupEvts.filter(e => e.event_id !== canonical.event_id);

  const groupCands  = candidates.filter(c => group.includes(c.i) && group.includes(c.j));
  const maxSim      = Math.max(...groupCands.map(c => c.sim));
  const risky       = groupCands.some(c => c.risky);
  const riskReason  = groupCands.find(c => c.riskReason)?.riskReason;

  // Countries: canonical first, then union
  const primary   = canonical.geography.countries[0]!;
  const countries = [primary, ...new Set(groupEvts.flatMap(e => e.geography.countries).filter(c => c !== primary))];

  // Actors: union by normalized name
  const individuals = dedupeByKey(
    groupEvts.flatMap(e => e.actors.individuals ?? []),
    a => normalizeText(a.name),
  );
  const organizations = dedupeByKey(
    groupEvts.flatMap(e => e.actors.organizations ?? []),
    o => normalizeText(o.name),
  );

  // Sources: union by article_id
  const extractedFrom = dedupeByKey(
    groupEvts.flatMap(e => e.sources.extracted_from),
    r => r.article_id,
  );
  const sourceIds = extractedFrom.map(r => r.article_id);

  // Evidence quotes: union, dedup on first 60 normalized chars, cap at schema max (5)
  const quotes = dedupeByKey(
    [
      ...(canonical.sources.evidence_quotes ?? []),
      ...others.flatMap(e => e.sources.evidence_quotes ?? []),
    ],
    q => normalizeText(q).slice(0, 60),
  ).slice(0, 5);

  // Scalar maximums
  const maxSev  = Math.max(...groupEvts.map(e => e.event.severity)) as 1|2|3|4|5;
  const maxConf = Math.max(...groupEvts.map(e => e.event.confidence_score));
  const maxEsc  = Math.max(...groupEvts.map(e => e.geopolitical_scores.escalation_potential));
  const maxGeo  = Math.max(...groupEvts.map(e => e.geopolitical_scores.relevance));
  const maxStrat = Math.max(...groupEvts.map(e => e.geopolitical_scores.strategic_importance));
  const maxMkt  = Math.max(...groupEvts.map(e => e.market_impact?.relevance ?? 0));

  // Human review: OR across all; concatenate distinct reasons
  const humanReview = groupEvts.some(e => e.sources.human_review_required);
  const reviewReason = [...new Set(
    groupEvts.map(e => e.sources.human_review_reason).filter((r): r is string => Boolean(r))
  )].join(' | ') || undefined;

  const mergedFromIds = others.map(e => e.event_id);

  const absorbedSourceIds = others.flatMap(e => e.sources.source_ids);

  const mergedRunsSeen    = Math.max(...groupEvts.map(e => e.sources.runs_seen ?? 1));
  const mergedSourceCount = sourceIds.length;
  const mergedConfidence  = maxConf;
  const mergedHumanReview = groupEvts.some(e => e.sources.human_review_required);

  const merged: IntelligenceEvent = {
    ...canonical,
    identity: {
      ...canonical.identity,
      updated_at:           now,
      event_revision:       (canonical.identity.event_revision ?? 0) + 1,
      updated_from_sources: absorbedSourceIds,
      last_enriched_at:     now,
    },
    event: {
      ...canonical.event,
      severity:         maxSev,
      confidence_score: maxConf,
    },
    geography: { ...canonical.geography, countries },
    actors: {
      individuals:   individuals.length   > 0 ? individuals   : undefined,
      organizations: organizations.length > 0 ? organizations : undefined,
    },
    market_impact: canonical.market_impact
      ? { ...canonical.market_impact, relevance: maxMkt }
      : null,
    geopolitical_scores: {
      ...canonical.geopolitical_scores,
      relevance:            maxGeo,
      strategic_importance: maxStrat,
      escalation_potential: maxEsc,
    },
    sources: {
      ...canonical.sources,
      source_ids:            sourceIds,
      source_count:          sourceIds.length,
      extracted_from:        extractedFrom,
      evidence_quotes:       quotes.length > 0 ? quotes : undefined,
      human_review_required: humanReview || undefined,
      human_review_reason:   reviewReason,
      merged_from_event_ids: mergedFromIds,
      runs_seen:             mergedRunsSeen,
      latest_seen_at:        now,
    },
    lifecycle: {
      ...canonical.lifecycle,
      event_state: computeEventState({
        runs_seen:             mergedRunsSeen,
        source_count:          mergedSourceCount,
        confidence_score:      mergedConfidence,
        human_review_required: mergedHumanReview,
      }),
    },
  };

  const matchReasons = [
    `event_type=${canonical.event.event_type}`,
    `primary_country=${primary}`,
    `jaccard=${maxSim.toFixed(2)}`,
    ...(hasActors(canonical) ? ['actor_overlap=yes'] : ['actors=none']),
  ];

  const record: MergeRecord = {
    canonical_id:    canonical.event_id,
    merged_ids:      mergedFromIds,
    canonical_title: canonical.event.title,
    merged_titles:   others.map(e => e.event.title),
    similarity:      maxSim,
    match_reasons:   matchReasons,
    risky,
    risk_reason:     riskReason,
  };

  return { merged, record };
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function deduplicateEvents(date: string, dryRun = false): DedupResult {
  const p = join(PATHS.intelligence.outputEvents, `${date}.json`);

  if (!existsSync(p)) {
    logger.warn('dedup', `No event file for ${date}`);
    return { date, events_before: 0, events_after: 0, merges: [], uncertain_merges: [], final_events: [] };
  }

  const file   = JSON.parse(readFileSync(p, 'utf-8')) as EventOutputFile;
  const events = file.events;
  const before = events.length;

  if (before < 2) {
    logger.info('dedup', `${date}: ${before} event(s) — nothing to deduplicate`);
    return { date, events_before: before, events_after: before, merges: [], uncertain_merges: [], final_events: events };
  }

  // Backfill event_state for events created before this field existed
  let backfilled = 0;
  for (const e of events) {
    if (!e.lifecycle?.event_state) {
      e.lifecycle = {
        ...e.lifecycle,
        event_state: computeEventState({
          runs_seen:             e.sources.runs_seen    ?? 1,
          source_count:          e.sources.source_count ?? 1,
          confidence_score:      e.event.confidence_score,
          human_review_required: e.sources.human_review_required ?? false,
        }),
      };
      backfilled++;
    }
  }
  if (backfilled > 0) logger.info('dedup', `Backfilled event_state on ${backfilled} existing events`);

  const candidates = findCandidates(events);

  if (candidates.length === 0) {
    logger.info('dedup', `${date}: ${before} events — no merge candidates found`);
    // Still write if we backfilled event_state on existing events
    if (!dryRun && backfilled > 0) {
      writeFileSync(p, JSON.stringify({ ...file, events }, null, 2));
    }
    return { date, events_before: before, events_after: before, merges: [], uncertain_merges: [], final_events: events };
  }

  const groups       = buildGroups(events.length, candidates);
  const now          = new Date().toISOString();
  const mergeRecords: MergeRecord[] = [];
  const mergedIdxs   = new Set<number>();

  const replacements: IntelligenceEvent[] = [];
  for (const group of groups) {
    const { merged, record } = mergeGroup(group, events, candidates, now);
    replacements.push(merged);
    mergeRecords.push(record);
    group.forEach(i => mergedIdxs.add(i));
  }

  const kept        = events.filter((_, i) => !mergedIdxs.has(i));
  const finalEvents = [...kept, ...replacements];
  const after       = finalEvents.length;

  if (!dryRun) {
    const updated: EventOutputFile = {
      ...file,
      stats: {
        ...(file.stats as object),
        events_after_dedup:  after,
        dedup_merges_applied: mergeRecords.length,
      },
      events: finalEvents,
    };
    writeFileSync(p, JSON.stringify(updated, null, 2));
  }

  for (const r of mergeRecords) {
    const tag = r.risky ? ' [RISKY]' : '';
    logger.info('dedup', `Merged${tag}: "${r.canonical_title.slice(0, 70)}" (sim=${r.similarity.toFixed(2)})`);
    for (const t of r.merged_titles) {
      logger.info('dedup', `  absorbed: "${t.slice(0, 70)}"`);
    }
    if (r.risky) logger.warn('dedup', `  ⚠ ${r.risk_reason}`);
  }

  const uncertain = mergeRecords.filter(r => r.risky);
  logger.info('dedup', `${date}: ${before} → ${after} events | ${mergeRecords.length} merge(s)${uncertain.length > 0 ? ` | ${uncertain.length} uncertain` : ''}`);

  return { date, events_before: before, events_after: after, merges: mergeRecords, uncertain_merges: uncertain, final_events: finalEvents };
}
