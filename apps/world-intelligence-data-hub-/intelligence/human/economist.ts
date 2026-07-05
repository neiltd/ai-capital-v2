import Anthropic    from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import { join }     from 'path';
import { PATHS }    from '../../lib/paths.ts';
import type { HumanIntelRecord } from './store.ts';

const client = new Anthropic();

function loadEconomicContext(): string {
  const parts: string[] = [];

  const oilPath = join(PATHS.exports.oilProject, 'intelligence.json');
  if (existsSync(oilPath)) {
    try {
      const oil = JSON.parse(readFileSync(oilPath, 'utf-8')) as Record<string, unknown>;
      const risk = (oil['hormuzRisk'] as Record<string, unknown> | undefined);
      if (risk) parts.push(`Hormuz risk: ${risk['riskLevel']}`);
      const sigs = (oil['commoditySignals'] as Array<Record<string, unknown>> | undefined) ?? [];
      if (sigs.length) parts.push(`Commodity signals: ${sigs.map(c => `${c['commodity']}:${c['signalDirection']}`).join(', ')}`);
    } catch { /* non-fatal */ }
  }

  const stockPath = join(PATHS.exports.stockProject, 'intelligence.json');
  if (existsSync(stockPath)) {
    try {
      const stock = JSON.parse(readFileSync(stockPath, 'utf-8')) as Record<string, unknown>;
      const macros = (stock['macroRiskSignals'] as Array<Record<string, unknown>> | undefined) ?? [];
      if (macros.length) parts.push(`Macro risks: ${macros.map(r => `${r['riskType']}(${Number(r['intensity']).toFixed(2)})`).join(', ')}`);
    } catch { /* non-fatal */ }
  }

  return parts.length ? parts.join('\n') : 'No economic context available.';
}

export async function generateQuickAnalysis(record: HumanIntelRecord): Promise<string> {
  const ctx = loadEconomicContext();

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 400,
    system:     `You are an economist specializing in geopolitical risk and second-order effects.
Given an intelligence event, write a 3–5 step consequence chain.
Format: "If [event] → [immediate effect] → [secondary effect] → [who gets hit and how]"
Be specific and directional. One paragraph. No headers. No bullet points.`,
    messages: [{
      role:    'user',
      content: `Event: ${record.extracted.title}
Topic: ${record.extracted.topic}
Countries: ${record.extracted.countries.join(', ')}
Confidence: ${record.extracted.confidence}
Current economic context:
${ctx}`,
    }],
  });

  const block = response.content[0];
  return block.type === 'text' ? block.text.trim() : '';
}

export interface ScenarioAnalysis {
  base_case:        string;
  bull_case:        string;
  bear_case:        string;
  affected_sectors: string[];
  key_variables:    string[];
  data_gaps:        string[];
}

export async function analyzeScenario(scenario: string): Promise<ScenarioAnalysis> {
  const oilPath   = join(PATHS.exports.oilProject,   'intelligence.json');
  const stockPath = join(PATHS.exports.stockProject,  'intelligence.json');
  const wiPath    = join(PATHS.exports.worldMap,      'intelligence.json');

  const contextParts: string[] = [];
  for (const [label, path] of [['Oil/energy', oilPath], ['Stock/macro', stockPath], ['World intel', wiPath]] as [string, string][]) {
    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
        contextParts.push(`${label}: ${JSON.stringify(data).slice(0, 800)}`);
      } catch { /* non-fatal */ }
    }
  }

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 2000,
    system:     `You are a senior economist specializing in geopolitical risk.
Analyze scenarios across multiple outcome paths.
Respond ONLY with valid JSON — no markdown:
{
  "base_case": "most likely economic outcome",
  "bull_case": "optimistic path — what must go right",
  "bear_case": "pessimistic path — what could go wrong",
  "affected_sectors": ["sector: brief exposure note"],
  "key_variables": ["3-5 signals that determine which case plays out"],
  "data_gaps": ["sources the user could check manually to sharpen the analysis"]
}`,
    messages: [{
      role:    'user',
      content: `Scenario: ${scenario}\n\nContext:\n${contextParts.join('\n\n')}`,
    }],
  });

  const block = response.content[0];
  if (block.type !== 'text') throw new Error('Unexpected Claude response');
  return JSON.parse(block.text) as ScenarioAnalysis;
}
