import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import { join }  from 'path';
import { PATHS } from '../../lib/paths.ts';
import type { HumanIntelRecord } from './store.ts';
import type { EventAnalysis, ActorGoal, BlocPerspective } from '../../admin/types.ts';

const client = new Anthropic();

function loadExportContext(): string {
  const wiPath = join(PATHS.exports.worldMap, 'intelligence.json');
  if (!existsSync(wiPath)) return 'No existing intelligence data.';
  try {
    const wi = JSON.parse(readFileSync(wiPath, 'utf-8')) as Record<string, unknown>;
    const storylines = ((wi['storylines'] as Array<Record<string, unknown>>) ?? [])
      .slice(0, 8)
      .map(s => `  [${s['storylineId']}] "${s['title']}" — ${s['storylineState']}`)
      .join('\n');
    return `Active storylines:\n${storylines || '  (none)'}`;
  } catch {
    return 'Export context unavailable.';
  }
}

const SYSTEM_PROMPT = `You are a senior geopolitical analyst with expertise in:
- Political science: realism, liberalism, constructivism, power transition theory, democratic peace theory
- Social science: social movement theory, identity politics, ethnic conflict, collective action problems
- Historical analysis: path dependency, imperial legacies, post-colonial dynamics, long-run institutional change

Produce a structured deep analysis of the submitted intelligence event.
Respond ONLY with valid JSON. No markdown fences. No text outside the JSON object.

JSON schema (follow exactly):
{
  "what_happened": "2-3 sentence factual summary — who did what, where, when",
  "historical_context": "Specific historical roots: name treaties, conflicts, empires, turning points that explain why this is happening now. Go back 10-100 years.",
  "political_analysis": "Power dynamics: which actors gain or lose power, what regime interests are served, how alliance structures are implicated. Apply at least two of: realist (power/security), liberal (institutions/trade), constructivist (identity/norms) lenses.",
  "social_analysis": "Social forces: identity dynamics, popular grievances, class interests, ethnic/religious fault lines, mobilization patterns and their structural roots.",
  "actor_goals": [
    {
      "name": "actor or state name",
      "stated_goal": "what they publicly say they want",
      "real_goal": "what their behavior and incentives reveal they actually want",
      "red_lines": "what they will not accept — their escalation triggers"
    }
  ],
  "bloc_perspectives": [
    {
      "bloc": "bloc name",
      "how_they_see_it": "their narrative and interpretation of this event",
      "their_interest": "what they gain, lose, or fear from this development",
      "internal_tension": "where members of this bloc disagree on this issue"
    }
  ],
  "what_to_watch": [
    "specific, concrete signal — include timeframe when possible"
  ],
  "confidence": {
    "score": 0.0,
    "reasoning": "what is unknown or uncertain that limits this analysis"
  }
}

For bloc_perspectives, always consider these blocs and include all that are materially affected:
- US-led West (NATO / Five Eyes)
- Russia-China axis
- EU (when position differs from US-led West)
- Japan-South Korea
- ASEAN
- Gulf States
- Global South / Non-Aligned

Minimum 3 blocs. Omit blocs not meaningfully affected.

For what_to_watch — be specific and time-bound:
BAD: "Watch the situation"
GOOD: "Whether Saudi Arabia calls an emergency OPEC meeting within 48 hours of the Iranian announcement"

Confidence scoring:
0.9+ = well-documented, multiple corroborating sources, clear actor incentives
0.7-0.9 = solid evidence, some uncertainty about intentions or timing
0.5-0.7 = plausible but limited evidence, significant uncertainty
< 0.5 = speculative — include only with explicit reasoning`;

type ParsedAnalysis = {
  what_happened:      string;
  historical_context: string;
  political_analysis: string;
  social_analysis:    string;
  actor_goals:        ActorGoal[];
  bloc_perspectives:  BlocPerspective[];
  what_to_watch:      string[];
  confidence:         { score: number; reasoning: string };
};

export async function analyseEvent(record: HumanIntelRecord): Promise<EventAnalysis> {
  const context = loadExportContext();
  const now = new Date().toISOString();

  const userMessage = [
    `Source: ${record.source_platform}`,
    record.source_url ? `URL: ${record.source_url}` : null,
    `Countries: ${record.extracted.countries.join(', ')}`,
    `Topic: ${record.extracted.topic}`,
    `Initial extraction: ${record.extracted.title}`,
    '',
    'Raw submitted text:',
    '---',
    record.raw_text,
    '---',
    '',
    'Current intelligence context for cross-referencing:',
    context,
  ].filter((l): l is string => l !== null).join('\n');

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 4000,
    system:     SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: userMessage }],
  });

  const block = response.content[0];
  if (block.type !== 'text') throw new Error('Unexpected Claude response type');
  let parsed: ParsedAnalysis;
  try {
    parsed = JSON.parse(block.text) as ParsedAnalysis;
  } catch {
    throw new Error(`Claude returned non-JSON response. Raw: ${block.text.slice(0, 300)}`);
  }

  return {
    event_id:           record.id,
    what_happened:      parsed.what_happened,
    historical_context: parsed.historical_context,
    political_analysis: parsed.political_analysis,
    social_analysis:    parsed.social_analysis,
    actor_goals:        parsed.actor_goals,
    bloc_perspectives:  parsed.bloc_perspectives,
    what_to_watch:      parsed.what_to_watch,
    confidence:         parsed.confidence,
    created_at:         now,
    last_edited:        now,
    reviewed:           false,
  };
}
