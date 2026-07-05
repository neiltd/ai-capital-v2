// Memory agent — fills in event.graph.causal_links + expected_consequences
// against the prior corpus, so the briefing can render "why now" chains.
//
// Operating principle: for each event in the target file, take the most
// recent N events in the same region (and a few thematic neighbors), pass
// them to Claude as candidate predecessors, and ask "which of these (if any)
// are causes? what consequences should we expect over the next 1-4 weeks?"
//
// We do not mutate prior events; reciprocal successor_ids are out of scope
// for the first pass (could be added by a second sweep later).

import Anthropic from '@anthropic-ai/sdk';
import type { IntelligenceEvent, CausalLink } from '../schema/intelligence-event.js';

const MODEL_DEFAULT = 'claude-sonnet-4-6';
const MAX_TOKENS    = 2048;

// How many candidate predecessors we hand to Claude. Trade-off: more = better
// recall on chains, but bigger context windows + cost. 30 fits comfortably for
// Sonnet and is enough to cover ~3 weeks of dense regional reporting.
const CANDIDATE_K = 30;

export interface MemoryAgentOptions {
  apiKey:       string;
  model?:       string;
  /** Don't write back; just print what we would set. Useful for dry runs. */
  dryRun?:      boolean;
}

export interface MemoryAgentResult {
  eventId:              string;
  causalLinks:          CausalLink[];
  expectedConsequences: string[];
  causalConfidence:     number;
  counterfactual:       string;
}

interface CandidateSummary {
  event_id:    string;
  title:       string;
  summary:     string;
  event_type:  string;
  severity:    number;
  countries:   string[];
  first_seen:  string;
}

function toCandidate(e: IntelligenceEvent): CandidateSummary {
  return {
    event_id:   e.event_id,
    title:      e.event.title,
    summary:    e.event.summary,
    event_type: e.event.event_type,
    severity:   e.event.severity,
    countries:  e.geography.countries ?? [],
    first_seen: e.identity.first_seen_at,
  };
}

/**
 * Pick the most plausible predecessor candidates for `target` from a pool.
 * Heuristics, no ML:
 *  1. Must be strictly older than `target` (first_seen_at < target.first_seen_at).
 *  2. Score by:
 *      +3 per overlapping country
 *      +1 per overlapping event_type
 *      +1 if severity >= 3
 *      decay 1.0 → 0 over 90 days (newer is more relevant)
 *  3. Return top K by score.
 */
function selectCandidates(target: IntelligenceEvent, pool: IntelligenceEvent[], k: number): IntelligenceEvent[] {
  const targetTime      = new Date(target.identity.first_seen_at).getTime();
  const targetCountries = new Set(target.geography.countries ?? []);
  const targetType      = target.event.event_type;
  const NINETY_DAYS_MS  = 90 * 24 * 60 * 60 * 1000;

  const scored: Array<{ ev: IntelligenceEvent; score: number }> = [];
  for (const ev of pool) {
    if (ev.event_id === target.event_id) continue;
    const evTime = new Date(ev.identity.first_seen_at).getTime();
    if (!Number.isFinite(evTime) || evTime >= targetTime) continue;

    const ageMs = targetTime - evTime;
    if (ageMs > NINETY_DAYS_MS) continue;
    const recency = 1 - ageMs / NINETY_DAYS_MS;

    let score = recency;
    for (const c of (ev.geography.countries ?? [])) {
      if (targetCountries.has(c)) score += 3;
    }
    if (ev.event.event_type === targetType) score += 1;
    if (ev.event.severity >= 3)              score += 1;

    scored.push({ ev, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map(s => s.ev);
}

const SYSTEM_PROMPT = `You are an intelligence memory agent. Your job is to reason about causality
between geopolitical events.

You receive:
  - TARGET event: title, summary, type, severity, countries, timestamp
  - CANDIDATE predecessor events (strictly older than the target)

For each candidate that you assess as a *plausible cause* of the target event,
emit a causal_link. For each near-term consequence you expect (next 1-4 weeks),
emit a string in expected_consequences.

Hard rules:
- Be conservative. If you cannot defend the causal link in one sentence, do NOT
  emit it. False positives degrade the briefing quality.
- causal_link.confidence is your honest probability (0..1) that the link is
  real and material, not just "topically related".
- Use ONLY the provided event_ids in causal_link.event_id. Never invent IDs.
- expected_consequences are short concrete predictions, not platitudes. Each
  should name a measurable outcome (price level, policy action, vote, alliance,
  troop movement, etc.) with a vague timeframe.

Output a single JSON object with exactly these fields:
{
  "causal_links": [
    { "event_id": "...", "kind": "caused_by", "confidence": 0.0..1.0, "rationale": "one sentence" }
  ],
  "expected_consequences": [ "one-line prediction", ... ],
  "causal_confidence": 0.0..1.0,
  "counterfactual": "one paragraph: if this target event had NOT happened, what would be different right now and over the next 1-4 weeks? Be specific — if nothing material would change, say so plainly."
}

No prose, no markdown fences. If no plausible causes exist, emit an empty causal_links array.`;

function extractJson(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/gi, '').trim();
  const start = stripped.indexOf('{');
  const end   = stripped.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('no JSON object in response');
  return JSON.parse(stripped.slice(start, end + 1));
}

export async function enrichEvent(
  target: IntelligenceEvent,
  pool:   IntelligenceEvent[],
  opts:   MemoryAgentOptions,
): Promise<MemoryAgentResult> {
  const candidates = selectCandidates(target, pool, CANDIDATE_K).map(toCandidate);
  const client = new Anthropic({ apiKey: opts.apiKey });

  const userPayload = JSON.stringify({
    target: toCandidate(target),
    candidates,
  });

  const res = await client.messages.create({
    model:      opts.model ?? MODEL_DEFAULT,
    max_tokens: MAX_TOKENS,
    system:     SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: userPayload }],
  });
  const text = res.content.find(b => b.type === 'text')?.text ?? '';
  const parsed = extractJson(text) as {
    causal_links?:           Array<{ event_id: string; kind?: string; confidence: number; rationale: string }>;
    expected_consequences?:  string[];
    causal_confidence?:      number;
    counterfactual?:         string;
  };

  const candidateIdSet = new Set(candidates.map(c => c.event_id));
  const causalLinks: CausalLink[] = (parsed.causal_links ?? [])
    .filter(l => candidateIdSet.has(l.event_id))   // discard hallucinated IDs
    .map(l => ({
      event_id:   l.event_id,
      kind:       (l.kind === 'expected_consequence' ? 'expected_consequence' : 'caused_by') as CausalLink['kind'],
      confidence: Math.max(0, Math.min(1, Number(l.confidence) || 0)),
      rationale:  String(l.rationale ?? '').trim(),
    }))
    .filter(l => l.rationale.length > 0);

  return {
    eventId:              target.event_id,
    causalLinks,
    expectedConsequences: (parsed.expected_consequences ?? []).filter(s => typeof s === 'string' && s.trim().length > 0),
    causalConfidence:     Math.max(0, Math.min(1, Number(parsed.causal_confidence) || 0)),
    counterfactual:       String(parsed.counterfactual ?? '').trim(),
  };
}
