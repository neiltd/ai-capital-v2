import Anthropic from '@anthropic-ai/sdk';
import { loadHumanStore } from './store.ts';
import { loadAnalysisStore } from './analysis-store.ts';
import type { CountryBrief, AlignmentMap } from '../../admin/types.ts';

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a senior geopolitical analyst writing a country intelligence brief.

Given recent intelligence events for a country, synthesize a concise rolling brief.
Respond ONLY with valid JSON. No markdown fences. No text outside the JSON object.

JSON schema (follow exactly):
{
  "situation_overview": "Current state in 2-3 sentences — what is happening right now",
  "key_dynamics": "The structural patterns driving events — the underlying logic, not just events themselves",
  "historical_roots": "Deep history shaping the present. Name specific empires, treaties, conflicts, leaders, turning points over 10-100 years.",
  "actor_map": "Who holds power (government, military, economic elites, civil society, opposition). Who is rising? Who is falling? Key intra-elite conflicts.",
  "alignment_map": {
    "primary_alignment": "which geopolitical bloc this country sits in and how firmly committed",
    "secondary_ties": "hedging relationships — other blocs or patrons maintained and why",
    "internal_factions": "domestic political groups that pull toward different external patrons",
    "fault_lines": "where alignment is contested, fragile, or actively shifting"
  },
  "watchlist": [
    "specific signal 1 to monitor",
    "specific signal 2 to monitor",
    "specific signal 3 to monitor"
  ]
}`;

type ParsedBrief = {
  situation_overview: string;
  key_dynamics:       string;
  historical_roots:   string;
  actor_map:          string;
  alignment_map:      AlignmentMap;
  watchlist:          string[];
};

export async function synthesiseBrief(iso3: string): Promise<CountryBrief> {
  const allRecords  = loadHumanStore();
  const allAnalyses = loadAnalysisStore();
  const analysisMap = new Map(allAnalyses.map(a => [a.event_id, a]));

  const countryRecords = allRecords.filter(r =>
    r.extracted.countries.includes(iso3)
  );

  if (countryRecords.length === 0) {
    throw new Error(`No intel records found for ${iso3} — submit some news events first`);
  }

  const eventSummaries = countryRecords.map(r => {
    const analysis = analysisMap.get(r.id);
    return [
      `Event: ${r.extracted.title}`,
      `Date: ${r.submitted_at.slice(0, 10)}`,
      `Topic: ${r.extracted.topic}`,
      analysis
        ? `Analysis: ${analysis.what_happened}`
        : `Raw: ${r.raw_text.slice(0, 200)}`,
    ].join('\n');
  }).join('\n\n---\n\n');

  const now = new Date().toISOString();

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 2000,
    system:     SYSTEM_PROMPT,
    messages: [{
      role:    'user',
      content: `Country ISO3: ${iso3}\nEvents to synthesize: ${countryRecords.length}\n\n${eventSummaries}`,
    }],
  });

  const block = response.content[0];
  if (block.type !== 'text') throw new Error('Unexpected Claude response type');
  let parsed: ParsedBrief;
  try {
    parsed = JSON.parse(block.text) as ParsedBrief;
  } catch {
    throw new Error(`Claude returned non-JSON response. Raw: ${block.text.slice(0, 300)}`);
  }

  return {
    iso3,
    situation_overview: parsed.situation_overview,
    key_dynamics:       parsed.key_dynamics,
    historical_roots:   parsed.historical_roots,
    actor_map:          parsed.actor_map,
    alignment_map:      parsed.alignment_map,
    watchlist:          parsed.watchlist,
    last_reviewed:      now.slice(0, 10),
    last_synthesized:   now,
  };
}
