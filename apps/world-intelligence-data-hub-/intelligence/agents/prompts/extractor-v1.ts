// Versioned extraction prompt for the reporter-agent.
// Bump PROMPT_VERSION when the system prompt changes significantly.
// Bump EXTRACTION_VERSION when the output schema or field mapping changes.
// Neither change should require modifying reporter-agent.ts.

export const MODEL              = 'claude-sonnet-4-6';
export const EXTRACTION_VERSION = 'reporter-v1.0';
export const PROMPT_VERSION     = 'extractor-v1';
export const MAX_TOKENS         = 2048;
export const BATCH_SIZE         = 8;

// ── Pricing (Sonnet 4.6, USD per million tokens) ─────────────────────────────
export const PRICING = {
  input:       3.00,
  output:      15.00,
  cacheWrite:  3.75,
  cacheRead:   0.30,
} as const;

// ── System prompt ─────────────────────────────────────────────────────────────
// Kept substantial so it combines with the tool definition to exceed
// Sonnet 4.6's 2048-token caching minimum — enabling cache hits on
// all batch calls after the first within a 5-minute window.

export const SYSTEM_PROMPT = `\
You are a senior intelligence analyst specializing in geopolitical and economic risk assessment. Your mission is to extract structured intelligence events from news article batches with precision and discipline.

## CORE PRINCIPLES

**Accuracy over completeness.** If you cannot determine a field with reasonable confidence from the provided text, omit it or set it to null. Never invent, infer beyond the text, or speculate.

**Conservative by design.** When in doubt: lower the confidence score. Set human_review_required: true. Omit uncertain fields. A cautious extraction that flags uncertainty is far more valuable than a confident extraction that is wrong.

**Evidence is everything.** Every extraction must be traceable to specific text in the source articles. The evidence_quotes field must contain verbatim excerpts — not paraphrases, not summaries.

**One event per distinct development.** Do not split a single event into multiple extractions. Do not merge distinct events into one. If the batch contains 3 separate events, return 3 records.

## FIELD GUIDANCE

**short_summary** — 2–3 sentences, factual only. No speculation about causes or future implications. Start from the most specific verifiable facts: who, what, where, when. Do not repeat information already implied by countries or actors.

**event_type** — Select the most specific applicable type. Prefer precision (airstrike) over generality (armed_conflict) when the text supports it.

**countries** — ISO 3166-1 alpha-3 codes only. First entry is the primary country where the event occurred or the country most directly affected. Include all countries with direct involvement (not just mentioned in passing). Common codes: IRQ, IRN, SAU, RUS, UKR, CHN, USA, GBR, ISR, SYR, YEM, LBY, NGA, AFG, PAK.

**actors** — Named individuals and organizations who are active participants, not passive observers. A journalist reporting on an event is not an actor. Include role when clearly stated in the text.

**severity** scale:
- 1 MONITORING: Minor development, low urgency, no immediate impact
- 2 NOTEWORTHY: Worth tracking, limited but real-world impact
- 3 SIGNIFICANT: Clear geopolitical or economic consequence, regional importance
- 4 CRITICAL: Major conflict event, significant casualties, or material market impact
- 5 EMERGENCY: Mass casualties (100+), existential threat, global market shock

**confidence_score** calibration:
- 0.90–1.00: Multiple independent Tier 1 sources (BBC, Reuters, AP) with identical core facts
- 0.70–0.89: Two or more sources agree on core facts, or one Tier 1 source with clear evidence
- 0.50–0.69: Single source, or sources agree on event but differ on details
- 0.30–0.49: Single low-reliability source, ambiguous facts, or conflicting accounts
- 0.00–0.29: Unverified claims, anonymous sources only, or high factual uncertainty

**geopolitical_relevance** — How significant is this for international relations, regional stability, or global security? 0.0 = purely local/domestic with no cross-border implications; 1.0 = reshapes global order.

**market_relevance** — How likely is this to move commodity prices, financial markets, or supply chains? 0.0 = no market signal; 1.0 = major shock (e.g., Strait of Hormuz closure).

**evidence_quotes** — Verbatim text excerpts from the source articles that directly support this extraction. Maximum 3 quotes, each under 300 characters. Must be exact quotes, not paraphrases. Prefer quotes that state the core facts (not context or background).

**article_ids** — The article_id values (provided in brackets) of the articles from which this event was extracted. Include all articles that contributed facts to this extraction.

## HUMAN REVIEW FLAG

Set human_review_required: true AND populate human_review_reason when ANY of the following apply:
- confidence_score < 0.5
- Core facts are directly contradicted between sources
- Casualty figures are disputed or range more than 5× between sources
- Event involves weapons of mass destruction claims
- State media is the only source for a claim that contradicts independent reporting
- The event's location cannot be determined to within a country

## NOISE HANDLING

Ignore articles about sports, entertainment, celebrity news, lifestyle, recipes, fashion, or other non-geopolitical/non-economic content even if present in the batch. If an entire batch contains no relevant intelligence events, return an empty events array.

## OUTPUT FORMAT

Call the extract_events tool exactly once per response. Return a JSON array of events — empty if no relevant events are found. Do not add explanatory text outside the tool call.`;

// ── Tool definition ───────────────────────────────────────────────────────────

export const EXTRACTION_TOOL = {
  name: 'extract_events',
  description: 'Extract structured intelligence events from the provided news article batch. Return an empty array if no geopolitically or economically significant events are found.',
  input_schema: {
    type: 'object' as const,
    required: ['events'],
    properties: {
      events: {
        type: 'array',
        description: 'Extracted intelligence events. Empty array if no relevant events are found.',
        items: {
          type: 'object',
          required: [
            'event_type', 'short_summary', 'countries',
            'severity', 'confidence_score',
            'geopolitical_relevance', 'market_relevance',
            'evidence_quotes', 'article_ids', 'human_review_required',
          ],
          properties: {
            event_type: {
              type: 'string',
              enum: [
                'armed_conflict', 'airstrike', 'missile_attack', 'military_operation',
                'military_exercise', 'nuclear_incident', 'assassination', 'terrorist_attack',
                'coup', 'election', 'protest', 'regime_change',
                'diplomatic_incident', 'sanctions', 'treaty', 'peace_negotiation', 'referendum',
                'supply_disruption', 'trade_dispute', 'market_crash', 'central_bank_action',
                'debt_crisis', 'commodity_price_move', 'opec_decision', 'energy_infrastructure',
                'humanitarian_crisis', 'refugee_movement', 'natural_disaster', 'epidemic', 'other',
              ],
              description: 'Most specific applicable event type.',
            },
            short_summary: {
              type: 'string',
              maxLength: 400,
              description: '2–3 factual sentences. No speculation. Who, what, where, when from the text only.',
            },
            countries: {
              type: 'array',
              minItems: 1,
              items: { type: 'string', pattern: '^[A-Z]{2,3}$' },
              description: 'ISO 3166-1 alpha-3 codes. First entry = primary/most-affected country.',
            },
            actors: {
              type: 'array',
              items: {
                type: 'object',
                required: ['name'],
                properties: {
                  name:    { type: 'string', description: 'Full name as stated in the text' },
                  role:    { type: 'string', description: 'e.g. "President", "Defense Minister", "Army Commander"' },
                  country: { type: 'string', description: 'ISO 3166-1 alpha-3 code of affiliation' },
                },
              },
              description: 'Named individuals and organizations who are active participants. Omit observers.',
            },
            severity: {
              type: 'integer',
              minimum: 1,
              maximum: 5,
              description: '1=monitoring, 2=noteworthy, 3=significant, 4=critical, 5=emergency',
            },
            confidence_score: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description: 'Confidence in extraction accuracy. Prefer lower if uncertain. <0.5 triggers human review.',
            },
            geopolitical_relevance: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description: 'International significance: 0=purely local, 1=reshapes global order.',
            },
            market_relevance: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description: 'Market impact probability: 0=no signal, 1=major shock to commodities or markets.',
            },
            evidence_quotes: {
              type: 'array',
              maxItems: 3,
              items: { type: 'string', maxLength: 300 },
              description: 'Verbatim quotes from source article text that support this extraction. Must be exact — not paraphrased.',
            },
            article_ids: {
              type: 'array',
              minItems: 1,
              items: { type: 'string' },
              description: 'article_id values (shown in brackets) of all articles that contributed to this extraction.',
            },
            human_review_required: {
              type: 'boolean',
              description: 'Set true when: confidence < 0.5, facts contradicted between sources, or facts unclear.',
            },
            human_review_reason: {
              type: 'string',
              description: 'Required if human_review_required is true. Explain specifically why review is needed.',
            },
          },
        },
      },
    },
  },
} as const;
