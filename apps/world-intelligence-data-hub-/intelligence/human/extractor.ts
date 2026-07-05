import Anthropic        from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import { join }         from 'path';
import { PATHS }        from '../../lib/paths.ts';
import { generateHumanIntelId } from './store.ts';
import type { HumanIntelRecord } from './store.ts';

const client = new Anthropic();

function loadExportContext(): string {
  const wiPath = join(PATHS.exports.worldMap, 'intelligence.json');
  if (!existsSync(wiPath)) return 'No existing intelligence data.';
  try {
    const wi = JSON.parse(readFileSync(wiPath, 'utf-8'));
    const storylines = (wi.storylines ?? []).slice(0, 12).map((s: Record<string, unknown>) =>
      `  [${s['storylineId']}] "${s['title']}" — ${s['storylineState']}, ${s['totalEvents']} events, countries: ${(s['countries'] as string[] ?? []).join(', ')}`
    ).join('\n');
    const events = (wi.events ?? []).slice(0, 15).map((e: Record<string, unknown>) =>
      `  [${e['eventId']}] "${e['title']}" — ${e['eventType']}, severity ${e['severity']}`
    ).join('\n');
    return `Active storylines:\n${storylines || '  (none)'}\n\nRecent events:\n${events || '  (none)'}`;
  } catch {
    return 'Export context unavailable.';
  }
}

const SYSTEM_PROMPT = `You are an intelligence analyst for a geopolitical data hub.
Given user-submitted content from any source, you must:
1. Extract structured intelligence (title, topic, countries, actors, event_type, confidence, tags)
2. Assess credibility (source tier, bias flags, plausibility against existing intel)
3. Cross-reference against the current intelligence database
4. List follow-up questions the user should go verify manually

Respond ONLY with valid JSON. No markdown. No explanation.

Schema:
{
  "extracted": {
    "title": "concise title, max 120 chars",
    "topic": "geopolitical|economic|technology|social|energy|other",
    "countries": ["ISO alpha-3 e.g. USA IRN CHN"],
    "actors": ["named individuals or organizations"],
    "event_type": "one type from the list below, or null",
    "confidence": 0.0,
    "tags": ["relevant tags"]
  },
  "credibility": {
    "source_tier": "unverified|social|news|primary",
    "bias_flags": ["state_narrative|unverified_claim|single_source|sensationalist|speculation"],
    "cross_references": ["storylineId or eventId from the database that this relates to"],
    "assessment": "plain text: plausibility, contradictions, confirmations"
  },
  "follow_up_requests": ["specific things to verify from sources you cannot access"]
}

Valid event_type values: armed_conflict, airstrike, missile_attack, military_operation,
military_exercise, nuclear_incident, assassination, terrorist_attack, coup, election,
protest, regime_change, diplomatic_incident, sanctions, treaty, peace_negotiation,
referendum, supply_disruption, trade_dispute, market_crash, central_bank_action,
economic_data_release, debt_crisis, commodity_price_move, opec_decision,
energy_infrastructure, humanitarian_crisis, refugee_movement, natural_disaster,
epidemic, other. Use null if nothing fits.

Source tiers: primary=official docs/verified eyewitness, news=established outlets,
social=TikTok/YouTube/podcasts/informal, unverified=anonymous/speculative.`;

export async function extractHumanIntel(opts: {
  rawText:        string;
  sourcePlatform: HumanIntelRecord['source_platform'];
  sourceUrl?:     string;
}): Promise<HumanIntelRecord> {
  const { rawText, sourcePlatform, sourceUrl } = opts;
  const submittedAt = new Date().toISOString();
  const id = generateHumanIntelId(rawText, submittedAt);
  const exportContext = loadExportContext();

  const userMessage = [
    `Source platform: ${sourcePlatform}`,
    sourceUrl ? `Source URL: ${sourceUrl}` : null,
    '',
    'Submitted content:',
    '---',
    rawText,
    '---',
    '',
    'Current intelligence database for cross-referencing:',
    exportContext,
  ].filter(l => l !== null).join('\n');

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 2000,
    system:     SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: userMessage }],
  });

  const block = response.content[0];
  if (block.type !== 'text') throw new Error('Unexpected Claude response type');

  type ParsedResponse = {
    extracted:          HumanIntelRecord['extracted'];
    credibility:        HumanIntelRecord['credibility'];
    follow_up_requests: string[];
  };
  const parsed = JSON.parse(block.text) as ParsedResponse;

  return {
    id,
    submitted_at:              submittedAt,
    source_platform:           sourcePlatform,
    source_url:                sourceUrl,
    raw_text:                  rawText,
    extracted:                 parsed.extracted,
    credibility:               parsed.credibility,
    follow_up_requests:        parsed.follow_up_requests ?? [],
    economist_quick_analysis:  '',   // filled by economist.ts
    exported:                  false,
  };
}
