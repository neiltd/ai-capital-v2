// Adversarial review of discovery picks.
//
// After analyzeCandidate produces a bull thesis (scenarios + buy/watch action),
// reviewCandidate runs a SECOND Claude call playing devil's advocate. It
// critiques each scenario, identifies what the bull case ignored, scores the
// bear case strength, and suggests whether the recommendation should be
// downgraded.
//
// The combined output (bull score minus bear adjustment) is the final score
// used to size positions. This catches the AVGO-style "everything looks great
// until you ask the bear" trap that bull-only analysis misses.

import Anthropic from '@anthropic-ai/sdk'
import type { ScoredCandidate, DiscoveryScenario, DiscoveryAction } from './types.js'

const client = new Anthropic()

const BEAR_SYSTEM_PROMPT = `You are a contrarian short-seller and devil's advocate analyst.
You have been given a bull thesis for a stock that another analyst has rated bullish.
Your job is to ARGUE THE OPPOSITE — find every reason this pick will disappoint, every
overlooked risk, every weak link in the supply chain, every cycle peak indicator, every
margin compression mechanism the bull case ignored.

Be specific and concrete. Vague concerns like "macro risk" or "valuation" without
specifics do not count. Tie each concern to a named mechanism, comparable company's
recent miss, sector dynamic, or structural change. Cite specific events when possible.

You are not pessimistic just for the sake of it — you are honest about what could go
wrong. A weak bear case (bearScore <= 30) is a reasonable outcome if the bull thesis is
actually strong. A strong bear case (bearScore >= 70) means the bull is over-confident
and the recommendation should be downgraded.`

interface RawBearScenarioCritique {
  scenarioType:     string  // 'best' | 'base' | 'disruption'
  weakness:         string
}

interface RawBearReview {
  bearScore:           number  // 0-100; higher = stronger bear case
  topConcerns:         string[]
  scenariosCritiqued:  RawBearScenarioCritique[]
  suggestedAdjustment: 'maintain' | 'downgrade-conviction' | 'flip-to-watch' | 'reject'
  bearNarrative:       string
}

export interface AdversarialReview {
  ticker:              string
  bearScore:           number
  topConcerns:         string[]
  scenariosCritiqued:  RawBearScenarioCritique[]
  suggestedAdjustment: RawBearReview['suggestedAdjustment']
  bearNarrative:       string
}

export interface AdjustedRecommendation {
  /** Original action verbatim (recommendation + conviction + rationale) */
  bull:        DiscoveryAction
  /** Bear-side findings from this review */
  bear:        AdversarialReview
  /** Post-adversarial action — conviction downgraded if bear is strong */
  adjusted:    DiscoveryAction
  /** True when bear was strong enough to change the recommendation */
  wasAdjusted: boolean
}

export async function reviewCandidate(
  candidate:    ScoredCandidate,
  currentPrice: number,
  macroRegime:  string,
  macroSignals: string,
  bullScenarios:DiscoveryScenario[],
  bullAction:   DiscoveryAction,
): Promise<AdversarialReview | null> {
  const bullScenarioSummary = bullScenarios
    .map(s => `### ${s.scenarioType.toUpperCase()} (${s.probability}%): ${s.title}\n${s.narrative}\nTriggers: ${s.triggers.join('; ')}`)
    .join('\n\n')

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: [{ type: 'text', text: BEAR_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools: [{
      name: 'submit_bear_review',
      description: 'Submit your devil\'s-advocate review of the bull thesis',
      input_schema: {
        type: 'object',
        properties: {
          bearScore: {
            type:        'integer',
            minimum:     0,
            maximum:     100,
            description: '0-100. 0 = bull thesis is airtight. 30 = mild concerns. 50 = real risks. 70 = bull is over-confident. 90 = avoid.',
          },
          topConcerns: {
            type:        'array',
            items:       { type: 'string' },
            description: '3-5 SPECIFIC, named concerns. Each tied to a mechanism, peer comparison, or structural change.',
          },
          scenariosCritiqued: {
            type:        'array',
            description: 'For each of the bull\'s 3 scenarios, identify the specific weakness.',
            items: {
              type: 'object',
              properties: {
                scenarioType: { type: 'string', enum: ['best', 'base', 'disruption'] },
                weakness:     { type: 'string' },
              },
              required: ['scenarioType', 'weakness'],
            },
          },
          suggestedAdjustment: {
            type:        'string',
            enum:        ['maintain', 'downgrade-conviction', 'flip-to-watch', 'reject'],
            description: 'What should happen to the bull recommendation given your review',
          },
          bearNarrative: {
            type:        'string',
            description: '2-3 paragraphs telling the bear story',
          },
        },
        required: ['bearScore', 'topConcerns', 'scenariosCritiqued', 'suggestedAdjustment', 'bearNarrative'],
      },
    }],
    tool_choice: { type: 'tool', name: 'submit_bear_review' },
    messages: [{
      role: 'user',
      content: [
        `Ticker: ${candidate.ticker} — ${candidate.company}`,
        `Current price: $${currentPrice.toFixed(2)}`,
        `Current macro regime: ${macroRegime}`,
        `Key macro signals:\n${macroSignals}`,
        ``,
        `# Bull thesis to critique`,
        `Light filter score: ${candidate.score}/100`,
        `Light filter rationale: ${candidate.rationale}`,
        ``,
        `## Bull's recommendation: ${bullAction.recommendation.toUpperCase()} at ${bullAction.conviction.toUpperCase()} conviction`,
        `${bullAction.rationale}`,
        ``,
        `## Bull's scenarios`,
        bullScenarioSummary,
        ``,
        `Now submit your bear review.`,
      ].join('\n'),
    }],
  })

  const toolUse = response.content.find(b => b.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') return null
  const r = toolUse.input as RawBearReview

  return {
    ticker:              candidate.ticker,
    bearScore:           Math.min(100, Math.max(0, Math.round(r.bearScore))),
    topConcerns:         r.topConcerns ?? [],
    scenariosCritiqued:  r.scenariosCritiqued ?? [],
    suggestedAdjustment: r.suggestedAdjustment,
    bearNarrative:       r.bearNarrative ?? '',
  }
}

/**
 * Combine the bull action with the bear review and produce an adjusted action.
 * Bear strength drives conviction downgrade or recommendation flip.
 */
export function adjustForBear(bull: DiscoveryAction, bear: AdversarialReview): AdjustedRecommendation {
  let adjusted: DiscoveryAction = { ...bull }
  let wasAdjusted = false

  if (bear.suggestedAdjustment === 'reject' || bear.bearScore >= 75) {
    adjusted = {
      ...bull,
      recommendation: 'watch',
      conviction:     'low',
      rationale:      `[ADVERSARIAL: bear score ${bear.bearScore}, rejected] ${bear.topConcerns.slice(0, 3).join(' · ')}`,
    }
    wasAdjusted = true
  } else if (bear.suggestedAdjustment === 'flip-to-watch' || (bear.bearScore >= 55 && bull.recommendation === 'buy')) {
    adjusted = {
      ...bull,
      recommendation: 'watch',
      conviction:     bull.conviction === 'high' ? 'medium' : 'low',
      rationale:      `[ADVERSARIAL: bear score ${bear.bearScore}, flipped to watch] ${bull.rationale} — Bear: ${bear.topConcerns.slice(0, 2).join('; ')}`,
    }
    wasAdjusted = true
  } else if (bear.suggestedAdjustment === 'downgrade-conviction' || bear.bearScore >= 40) {
    const downgraded = bull.conviction === 'high' ? 'medium' : bull.conviction === 'medium' ? 'low' : 'low'
    if (downgraded !== bull.conviction) {
      adjusted = {
        ...bull,
        conviction: downgraded,
        rationale:  `[ADVERSARIAL: bear score ${bear.bearScore}, conviction downgraded] ${bull.rationale} — Bear: ${bear.topConcerns.slice(0, 2).join('; ')}`,
      }
      wasAdjusted = true
    }
  }

  return { bull, bear, adjusted, wasAdjusted }
}
