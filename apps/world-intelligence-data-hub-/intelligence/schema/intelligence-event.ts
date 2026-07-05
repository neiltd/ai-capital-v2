import { z } from 'zod';

// ── Primitive validators ──────────────────────────────────────────────────────

const IsoDatetime = z.string().datetime({ offset: true });
const IsoDate     = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Iso3Country = z.string().regex(/^[A-Z]{2,3}$/);       // alpha-3 or 'GLOBAL' / 'UNK'

const Severity = z.union([
  z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5),
]);

const ConfidenceScore = z.number().min(0).max(1);
const RelevanceScore  = z.number().min(0).max(1);

// ── Enums ─────────────────────────────────────────────────────────────────────

export const EventTypeEnum = z.enum([
  'armed_conflict', 'airstrike', 'missile_attack', 'military_operation',
  'military_exercise', 'nuclear_incident', 'assassination', 'terrorist_attack',
  'coup', 'election', 'protest', 'regime_change',
  'diplomatic_incident', 'sanctions', 'treaty', 'peace_negotiation', 'referendum',
  'supply_disruption', 'trade_dispute', 'market_crash', 'central_bank_action',
  'economic_data_release',   // CPI, GDP, employment reports — triggers market reaction but is a data point
  'debt_crisis', 'commodity_price_move', 'opec_decision', 'energy_infrastructure',
  'humanitarian_crisis', 'refugee_movement', 'natural_disaster', 'epidemic',
  'other',
]);

export const EventStatusEnum = z.enum([
  'developing', 'ongoing', 'concluded', 'disputed', 'unverified',
]);

export const TimePrecisionEnum = z.enum([
  'exact', 'hour', 'day', 'week', 'approximate',
]);

export const ActorTypeEnum = z.enum([
  'government_official', 'military_commander', 'rebel_leader',
  'diplomat', 'intelligence_official', 'corporate_executive',
  'journalist', 'international_official', 'civilian', 'unknown',
]);

export const OrgTypeEnum = z.enum([
  'government', 'military', 'militia', 'terrorist_group',
  'international_body', 'regional_body', 'ngo',
  'corporation', 'media_outlet', 'political_party',
  'financial_institution', 'unknown',
]);

export const ProcessingStatusEnum = z.enum([
  'extracted', 'scored', 'linked', 'analyzed', 'archived', 'retraction',
]);

// Deterministic lifecycle state — computed purely from observable metadata, no AI.
// Priority: contested > confirmed > developing > emerging.
export const EventStateEnum = z.enum([
  'emerging',   // runs_seen == 1, single source — just appeared, unverified
  'developing', // multi-run or multi-source — accumulating evidence
  'confirmed',  // ≥3 sources, ≥2 runs, high confidence, no review flag
  'contested',  // human_review_required — extraordinary claim or source conflict
]);

// ── Sub-schemas ───────────────────────────────────────────────────────────────

export const ActorSchema = z.object({
  name:       z.string().min(1),
  role:       z.string().optional(),
  country:    Iso3Country.optional(),
  actor_type: ActorTypeEnum,
  aliases:    z.array(z.string()).optional(),
});

export const OrganizationSchema = z.object({
  name:     z.string().min(1),
  org_type: OrgTypeEnum,
  country:  Iso3Country.optional(),
  aliases:  z.array(z.string()).optional(),
});

export const CoordinatesSchema = z.object({
  lat:       z.number().min(-90).max(90),
  lng:       z.number().min(-180).max(180),
  precision: z.enum(['exact', 'city', 'region', 'country', 'approximate']),
});

export const MarketImpactSchema = z.object({
  relevance:        RelevanceScore,
  direction:        z.enum(['bullish', 'bearish', 'neutral', 'uncertain']),
  commodities:      z.array(z.string()).optional(),
  sectors:          z.array(z.string()).optional(),
  companies:        z.array(z.string()).optional(),
  related_tickers:  z.array(z.string()).optional(),
  oil_price_signal: z.enum(['up', 'down', 'neutral', 'uncertain']).optional(),
  notes:            z.string().optional(),
});

export const GeopoliticalScoresSchema = z.object({
  relevance:            RelevanceScore,
  strategic_importance: RelevanceScore,
  escalation_potential: RelevanceScore,
  stability_impact:     RelevanceScore.optional(),
});

export const NarrativePerspectiveSchema = z.object({
  source_id:               z.string(),
  source_name:             z.string(),
  reliability_tier:        z.union([z.literal(1), z.literal(2), z.literal(3)]),
  perspective:             z.string(),
  sentiment:               z.enum(['neutral', 'positive', 'negative', 'mixed']).optional(),
  diverges_from_consensus: z.boolean().optional(),
  potential_bias_signal:   z.string().optional(),
});

export const ArticleRefSchema = z.object({
  article_id:       z.string(),
  source_id:        z.string(),
  source_name:      z.string(),
  reliability_tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  title:            z.string(),
  url:              z.string().url(),
  published_at:     IsoDatetime,
  relevance_score:  z.number().min(0).max(100).optional(),
});

// Typed causal link between two events. The memory-agent populates these with
// "this event caused/was-caused-by that one" judgments plus a confidence and a
// one-sentence rationale, so the briefing can render a real "why now" chain.
export const CausalLinkSchema = z.object({
  event_id:   z.string(),
  // 'caused_by': the linked event is upstream — it set conditions for this one.
  // 'expected_consequence': the linked event is downstream — the memory-agent
  //  identified this event as a likely cause of that one. Reciprocal links are
  //  the responsibility of the agent (not auto-mirrored at schema level).
  kind:       z.enum(['caused_by', 'expected_consequence']),
  confidence: z.number().min(0).max(1),
  rationale:  z.string().min(1),
});

export const EventGraphSchema = z.object({
  related_event_ids: z.array(z.string()).default([]),
  predecessor_ids:   z.array(z.string()).default([]),
  successor_ids:     z.array(z.string()).default([]),

  // Memory-agent enrichment — defaults to empty so legacy events stay valid.
  causal_links:           z.array(CausalLinkSchema).default([]),
  // Free-text predictions the agent made at link time. Each string is one
  // expected near-term consequence (e.g. "WTI re-prices toward $100 within
  // 2 weeks if Hormuz partial closure persists").
  expected_consequences:  z.array(z.string()).default([]),
  // 0..1 — agent's self-rated confidence in the overall causal structure for
  // this event. Surfaces in the briefing as "X% causal confidence".
  causal_confidence:      z.number().min(0).max(1).optional(),
  // Counterfactual — "if this event hadn't happened, what would be different?"
  // The agent's one-paragraph reasoning. Magnitude indicator for the briefing:
  // an event whose counterfactual is "nothing material would change" probably
  // doesn't deserve the front page.
  counterfactual:         z.string().optional(),

  thread_id:         z.string().optional(),
  relation_notes:    z.string().optional(),
  graph_version:     z.number().int().nonnegative().default(0),
});

// ── Main schema ───────────────────────────────────────────────────────────────

export const IntelligenceEventSchema = z.object({

  // Top-level identity — deterministic
  event_id:       z.string().min(1),
  schema_version: z.literal('1.0'),

  // ── identity: extraction provenance + lineage ─────────────────────────────
  identity: z.object({
    extraction_model:   z.string(),
    extraction_version: z.string(),
    prompt_version:     z.string().optional(),
    extracted_at:       IsoDatetime,
    first_seen_at:      IsoDatetime,
    updated_at:         IsoDatetime,
    // Lineage tracking — incremented on every meaningful update
    event_revision:          z.number().int().nonnegative().default(0),
    updated_from_sources:    z.array(z.string()).optional(), // article_ids added in last update
    last_enriched_at:        IsoDatetime.optional(),        // when sources were last added
  }),

  // ── event: core description — AI-generated ────────────────────────────────
  event: z.object({
    title:               z.string().min(5).max(200),
    summary:             z.string().min(20).max(1000),
    event_type:          EventTypeEnum,
    severity:            Severity,
    confidence_score:    ConfidenceScore,
    status:              EventStatusEnum,
    event_time:          IsoDatetime.optional(),
    event_time_precision: TimePrecisionEnum.optional(),
    ongoing_since:       IsoDate.optional(),
    key_facts:           z.array(z.string().max(200)).max(8).optional(),
  }),

  // ── geography — AI-generated ──────────────────────────────────────────────
  geography: z.object({
    countries:            z.array(Iso3Country).min(1),
    regions:              z.array(z.string()).optional(),
    location_description: z.string().optional(),
    coordinates:          CoordinatesSchema.optional(),
  }),

  // ── actors — AI-generated ─────────────────────────────────────────────────
  actors: z.object({
    individuals:   z.array(ActorSchema).optional(),
    organizations: z.array(OrganizationSchema).optional(),
  }),

  // ── market_impact — AI-generated ─────────────────────────────────────────
  market_impact: MarketImpactSchema.nullable(),

  // ── geopolitical_scores — AI-generated ───────────────────────────────────
  geopolitical_scores: GeopoliticalScoresSchema,

  // ── tags — AI-generated ───────────────────────────────────────────────────
  tags: z.object({
    geopolitical: z.array(z.string()).optional(),
    economic:     z.array(z.string()).optional(),
    narrative:    z.array(z.string()).optional(),
    event:        z.array(z.string()).optional(),
  }),

  // ── sources — deterministic + AI narrative layers ─────────────────────────
  sources: z.object({
    source_ids:              z.array(z.string()).min(1),
    source_count:            z.number().int().min(1),
    extracted_from:          z.array(ArticleRefSchema).min(1),
    evidence_quotes:         z.array(z.string().max(300)).max(5).optional(),
    human_review_required:   z.boolean().optional(),
    human_review_reason:     z.string().optional(),
    merged_from_event_ids:   z.array(z.string()).optional(),
    // Persistence tracking — maintained by reporter and dedup
    runs_seen:               z.number().int().min(1).default(1), // pipeline runs contributing to this event
    latest_seen_at:          IsoDatetime.optional(),              // last run that added sources
    narrative_perspectives:  z.array(NarrativePerspectiveSchema).optional(),
    consensus_exists:        z.boolean().optional(),
    censorship_signal:       z.boolean().optional(),
  }),

  // ── graph — populated by memory-agent, starts empty ──────────────────────
  graph: EventGraphSchema,

  // ── lifecycle — deterministic ─────────────────────────────────────────────
  lifecycle: z.object({
    processing_status:  ProcessingStatusEnum,
    event_state:        EventStateEnum.optional(),
    storyline_id:       z.string().optional(), // set by storyline linker after cross-day matching
    requires_reextract: z.boolean().optional(),
    retraction_reason:  z.string().optional(),
    linked_at:          IsoDatetime.optional(),
    analyzed_at:        IsoDatetime.optional(),
  }),
});

// ── Event state computation ───────────────────────────────────────────────────
// Pure function — no AI, no side effects. Call whenever persistence fields change.

export function computeEventState(opts: {
  runs_seen:             number;
  source_count:          number;
  confidence_score:      number;
  human_review_required: boolean;
}): z.infer<typeof EventStateEnum> {
  const { runs_seen, source_count, confidence_score, human_review_required } = opts;
  if (human_review_required)                                           return 'contested';
  if (source_count >= 3 && runs_seen >= 2 && confidence_score >= 0.75) return 'confirmed';
  if (runs_seen >= 2 || source_count >= 2)                             return 'developing';
  return 'emerging';
}

// ── Inferred TypeScript types ─────────────────────────────────────────────────

export type IntelligenceEvent     = z.infer<typeof IntelligenceEventSchema>;
export type EventType             = z.infer<typeof EventTypeEnum>;
export type EventStatus           = z.infer<typeof EventStatusEnum>;
export type TimePrecision         = z.infer<typeof TimePrecisionEnum>;
export type ActorType             = z.infer<typeof ActorTypeEnum>;
export type OrgType               = z.infer<typeof OrgTypeEnum>;
export type ProcessingStatus      = z.infer<typeof ProcessingStatusEnum>;
export type EventState            = z.infer<typeof EventStateEnum>;
export type Actor                 = z.infer<typeof ActorSchema>;
export type Organization          = z.infer<typeof OrganizationSchema>;
export type Coordinates           = z.infer<typeof CoordinatesSchema>;
export type MarketImpact          = z.infer<typeof MarketImpactSchema>;
export type GeopoliticalScores    = z.infer<typeof GeopoliticalScoresSchema>;
export type NarrativePerspective  = z.infer<typeof NarrativePerspectiveSchema>;
export type ArticleRef            = z.infer<typeof ArticleRefSchema>;
export type EventGraph            = z.infer<typeof EventGraphSchema>;

// ── Factory helpers ───────────────────────────────────────────────────────────
// These produce correctly-shaped defaults so the reporter-agent has a clean
// starting point. AI fills in the non-default fields.

export function emptyGraph(): EventGraph {
  return {
    related_event_ids:     [],
    predecessor_ids:       [],
    successor_ids:         [],
    causal_links:          [],
    expected_consequences: [],
    graph_version:         0,
  };
}

// Also export CausalLink for the memory-agent.
export type CausalLink            = z.infer<typeof CausalLinkSchema>;

export function validateEvent(raw: unknown): { success: true; data: IntelligenceEvent } | { success: false; error: string } {
  const result = IntelligenceEventSchema.safeParse(raw);
  if (result.success) return { success: true, data: result.data };
  const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
  return { success: false, error: issues };
}

// ── Event ID generation ───────────────────────────────────────────────────────
// Fully deterministic from structured metadata — never derived from AI-generated text.
//
// Algorithm: sha256(primaryArticleId + ':' + eventType + ':' + date)[:24]
//
// primaryArticleId: the highest-scoring source article in the extraction batch.
//   This is stable within a day (article scores don't change after scoring).
//   If the same event is extracted again, the primary article stays the same,
//   so the event_id stays the same — enabling safe merge detection.
//
// eventType: one of the 29 fixed enum values — deterministic.
// date:      YYYY-MM-DD of the pipeline run — deterministic.

import { createHash } from 'crypto';

export function generateEventId(
  primaryArticleId: string,
  eventType:        string,
  date:             string,  // YYYY-MM-DD or full ISO — we take first 10 chars
): string {
  const seed = `${primaryArticleId}:${eventType}:${date.slice(0, 10)}`;
  return createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 24);
}
