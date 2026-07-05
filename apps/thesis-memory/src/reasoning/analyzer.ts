// src/reasoning/analyzer.ts
import Anthropic from '@anthropic-ai/sdk'
import type { ProposalResponse } from '../types.js'

const TOOL: Anthropic.Tool = {
  name: 'propose_thesis_update',
  description: 'Propose structured changes to an investment thesis based on evidence analysis.',
  input_schema: {
    type: 'object' as const,
    properties: {
      assumption_changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            old_status: { type: 'string', enum: ['strengthening', 'stable', 'weakening', 'broken'] },
            new_status: { type: 'string', enum: ['strengthening', 'stable', 'weakening', 'broken'] },
            reasoning: { type: 'string' },
            evidence_quotes: { type: 'array', items: { type: 'string' } },
          },
          required: ['label', 'old_status', 'new_status', 'reasoning', 'evidence_quotes'],
        },
      },
      narrative_update: { type: 'string' },
      portfolio_action: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['buy', 'add', 'hold', 'reduce', 'sell', 'rotate'] },
          reasoning: { type: 'string' },
          conviction: { type: 'number' },
        },
        required: ['action', 'reasoning', 'conviction'],
      },
    },
    required: ['assumption_changes', 'narrative_update'],
  },
}

export interface Analyzer {
  analyze(prompt: string, ticker: string): Promise<ProposalResponse>
}

export function createAnalyzer(apiKey: string): Analyzer {
  const client = new Anthropic({ apiKey })

  return {
    async analyze(prompt, ticker) {
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: 'propose_thesis_update' },
        messages: [{ role: 'user', content: prompt }],
      })

      const toolUse = response.content.find(b => b.type === 'tool_use' && b.name === 'propose_thesis_update')
      if (!toolUse || toolUse.type !== 'tool_use') {
        throw new Error(`[Analyzer] No tool use response for ${ticker}`)
      }

      return toolUse.input as ProposalResponse
    },
  }
}
