// Storyline schema — lightweight cross-day event continuity layer.
//
// A storyline groups related events across adjacent days into persistent
// geopolitical narratives. Matching is deterministic (no AI): actor overlap,
// country overlap, event_type family, title similarity.
//
// Design constraints:
//   - No graph database
//   - No AI reasoning (heuristics only; uncertain matches logged for review)
//   - Preserves existing event_id logic unchanged
//   - All state transitions are pure functions of observable metadata

import { z }             from 'zod';
import { createHash }    from 'crypto';

// ── Enums ─────────────────────────────────────────────────────────────────────

export const StorylineStateEnum = z.enum([
  'emerging',     // 1–2 events, ≤1 day active
  'active',       // ≥3 events, stable escalation, seen recently
  'escalating',   // avg_escalation > 0.65 or rising trend
  'stabilizing',  // was escalating, now de-escalating
  'fading',       // no new events for > 3 days
]);

export type StorylineState = z.infer<typeof StorylineStateEnum>;

// ── Event type family groupings ───────────────────────────────────────────────
// Used for partial type matching (+1 vs exact match +3).

export const EVENT_TYPE_FAMILIES: Record<string, string> = {
  armed_conflict:        'military',
  airstrike:             'military',
  missile_attack:        'military',
  military_operation:    'military',
  military_exercise:     'military',
  nuclear_incident:      'military',
  assassination:         'military',
  terrorist_attack:      'military',
  diplomatic_incident:   'diplomatic',
  peace_negotiation:     'diplomatic',
  treaty:                'diplomatic',
  sanctions:             'diplomatic',
  referendum:            'diplomatic',
  coup:                  'diplomatic',
  election:              'diplomatic',
  protest:               'diplomatic',
  regime_change:         'diplomatic',
  supply_disruption:     'economic',
  trade_dispute:         'economic',
  market_crash:          'economic',
  central_bank_action:   'economic',
  economic_data_release: 'economic',
  debt_crisis:           'economic',
  commodity_price_move:  'economic',
  opec_decision:         'economic',
  energy_infrastructure: 'economic',
  humanitarian_crisis:   'humanitarian',
  refugee_movement:      'humanitarian',
  natural_disaster:      'humanitarian',
  epidemic:              'humanitarian',
};

// ── Type-specific continuity rules ────────────────────────────────────────────
// Penalty applied to raw match score for certain event_type combinations.
// Keeps distinct phenomena from collapsing into the same storyline.

function dominantFamily(storylineEventTypes: string[]): string | null {
  const counts: Record<string, number> = {};
  for (const t of storylineEventTypes) {
    const f = EVENT_TYPE_FAMILIES[t] ?? 'other';
    counts[f] = (counts[f] ?? 0) + 1;
  }
  let max = 0;
  let dominant: string | null = null;
  for (const [fam, n] of Object.entries(counts)) {
    if (n > max) { max = n; dominant = fam; }
  }
  return dominant;
}

// Returns a negative score adjustment (0 = no penalty).
// Applied after base scoring; effective score = base + penalty.
export function computeTypePenalty(
  eventType:       string,
  storylineTypes:  string[],
): number {
  const eventFamily  = EVENT_TYPE_FAMILIES[eventType] ?? 'other';
  const dominant     = dominantFamily(storylineTypes);
  const hasType      = storylineTypes.includes(eventType);
  const hasFamily    = storylineTypes.some(t => (EVENT_TYPE_FAMILIES[t] ?? 'other') === eventFamily);

  switch (eventType) {
    case 'natural_disaster':
      // Disasters are isolated events — require strong independent evidence to
      // link to a non-disaster storyline. Prevent Tehran earthquake merging
      // into Iran war storylines purely on country overlap.
      return hasType ? 0 : -3;

    case 'economic_data_release':
      // Data releases belong in economic storylines. Resist linking to
      // military or diplomatic threads unless actor/title similarity is high.
      return (!hasFamily && dominant !== 'economic') ? -2 : 0;

    case 'military_operation':
    case 'airstrike':
    case 'missile_attack':
    case 'armed_conflict':
    case 'nuclear_incident':
      // Military events resist purely-diplomatic storylines and vice versa,
      // preventing war coverage from consuming negotiation threads.
      return (dominant === 'diplomatic' && !hasFamily) ? -1 : 0;

    case 'diplomatic_incident':
    case 'peace_negotiation':
    case 'treaty':
    case 'sanctions':
      return (dominant === 'military' && !hasFamily) ? -1 : 0;

    default:
      return 0;
  }
}

// ── Storyline schema ──────────────────────────────────────────────────────────

export const StorylineSchema = z.object({
  storyline_id:   z.string(),    // sha256('storyline:' + anchor_event_id)[:16]
  title:          z.string(),    // from highest-confidence event in the storyline

  // Matching dimensions — union across all linked events
  event_types:    z.array(z.string()),  // all event_types seen
  countries:      z.array(z.string()),  // ISO3 codes (union)
  actor_names:    z.array(z.string()),  // normalized meaningful words from actor names

  // Accumulation
  event_ids:         z.array(z.string()),
  total_events:      z.number().int().min(1),
  total_sources:     z.number().int().min(1),
  runs_seen:         z.number().int().min(1),
  first_seen_at:     z.string(),    // ISO datetime of first event
  latest_seen_at:    z.string(),    // ISO datetime of most recent event
  last_event_date:   z.string(),    // YYYY-MM-DD of most recent event

  // Quality
  avg_confidence:  z.number().min(0).max(1),
  max_severity:    z.number().int().min(1).max(5),

  // Escalation tracking
  escalation_history: z.array(z.number()),  // chronological escalation_potential values
  avg_escalation:     z.number().min(0).max(1),

  // Lifecycle
  storyline_state: StorylineStateEnum,
  days_active:     z.number().int().min(0),

  // Source diversity — distinct RSS source IDs contributing to this storyline
  unique_source_ids: z.array(z.string()).default([]),

  // Event family composition — current snapshot (family → event count)
  family_composition: z.record(z.string(), z.number()).default({}),

  // Family composition history — one entry per day when composition changes.
  // Enables tracking how a storyline's thematic focus evolves over time.
  family_history: z.array(z.object({
    date:         z.string(),           // YYYY-MM-DD
    composition:  z.record(z.string(), z.number()),
    total_events: z.number().int(),
    dominant:     z.string(),           // dominant family on this date
  })).default([]),

  // Primary cohesion signal — what drives most links into this storyline.
  // Observed across all link decisions: 'country' | 'actor' | 'type' | 'title' | 'mixed'
  cohesion_signal: z.string().optional(),
});

export type Storyline = z.infer<typeof StorylineSchema>;

export const StorylineStoreSchema = z.object({
  schema_version: z.literal('1.0'),
  generated_at:   z.string(),
  storylines:     z.array(StorylineSchema),
});

export type StorylineStore = z.infer<typeof StorylineStoreSchema>;

// ── ID generation ─────────────────────────────────────────────────────────────

export function generateStorylineId(anchorEventId: string): string {
  return createHash('sha256')
    .update(`storyline:${anchorEventId}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

// ── State computation ─────────────────────────────────────────────────────────
// Pure function — deterministic from observable metadata.

export function computeStorylineState(s: {
  total_events:       number;
  days_active:        number;
  days_since_last:    number;
  avg_escalation:     number;
  escalation_history: number[];
}): StorylineState {
  const { total_events, days_active, days_since_last, avg_escalation, escalation_history } = s;

  if (days_since_last > 3) return 'fading';
  if (total_events <= 2 && days_active <= 1) return 'emerging';

  // Escalation trend: compare recent half vs earlier half of history
  let trend = 0;
  if (escalation_history.length >= 4) {
    const mid   = Math.floor(escalation_history.length / 2);
    const early = escalation_history.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
    const late  = escalation_history.slice(mid).reduce((a, b)  => a + b, 0) / (escalation_history.length - mid);
    trend = late - early;
  }

  if (trend > 0.10 || avg_escalation > 0.65)          return 'escalating';
  if (trend < -0.10 && avg_escalation < 0.50)          return 'stabilizing';
  return 'active';
}

// ── Match scoring ─────────────────────────────────────────────────────────────

export const MATCH_THRESHOLD = 5;

// Detailed breakdown of what drove a match score.
// Enables observing whether storylines cohere around geography, actors, or theme.
export interface SignalBreakdown {
  country:  number;  // 0 or +3
  actor:    number;  // 0 or +2
  type:     number;  // 0, +1 (family), or +3 (exact)
  title:    number;  // 0 or +2
  temporal: number;  // 0 or +1
  penalty:  number;  // 0, -1, -2, or -3 (type-specific continuity rule)
  total:    number;  // sum of all signals + penalty
  // Which single signal contributed most (for cohesion analysis)
  primary:  'country' | 'actor' | 'type' | 'title' | 'temporal' | 'none';
}

export function scoreEventAgainstStoryline(
  eventCountries:    string[],
  eventActorWords:   Set<string>,
  eventType:         string,
  eventTitleWords:   Set<string>,
  storyline:         Storyline,
  temporalProximity: boolean,
): SignalBreakdown {
  // Country overlap
  const country = eventCountries.some(c => storyline.countries.includes(c)) ? 3 : 0;

  // Actor overlap — word-level intersection
  const storyActorSet = new Set(storyline.actor_names);
  const actor = [...eventActorWords].some(w => storyActorSet.has(w)) ? 2 : 0;

  // Event type: exact match (+3) or family match (+1)
  let type = 0;
  if (storyline.event_types.includes(eventType)) {
    type = 3;
  } else {
    const eventFamily = EVENT_TYPE_FAMILIES[eventType];
    if (eventFamily && storyline.event_types.some(t => EVENT_TYPE_FAMILIES[t] === eventFamily)) {
      type = 1;
    }
  }

  // Title similarity
  const storyTitleWords = meaningfulWords(storyline.title);
  const title = jaccard(eventTitleWords, storyTitleWords) >= 0.20 ? 2 : 0;

  // Temporal proximity
  const temporal = temporalProximity ? 1 : 0;

  // Type-specific penalty
  const penalty = computeTypePenalty(eventType, storyline.event_types);

  const total = country + actor + type + title + temporal + penalty;

  // Primary signal — highest contributing individual signal
  const signals: Array<[number, SignalBreakdown['primary']]> = [
    [country, 'country'], [actor, 'actor'], [type, 'type'],
    [title, 'title'],     [temporal, 'temporal'],
  ];
  const best = signals.reduce((m, s) => s[0] > m[0] ? s : m, [0, 'none'] as [number, SignalBreakdown['primary']]);
  const primary = best[0] > 0 ? best[1] : 'none';

  return { country, actor, type, title, temporal, penalty, total, primary };
}

// ── Text utilities ────────────────────────────────────────────────────────────

export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function meaningfulWords(text: string): Set<string> {
  return new Set(normalizeText(text).split(' ').filter(w => w.length > 3));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}
