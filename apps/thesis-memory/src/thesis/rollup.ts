// src/thesis/rollup.ts
import type { Assumption, ThemeMembership } from '../types.js'

const STATUS_WEIGHTS: Record<string, number> = {
  strengthening: 1.0,
  stable: 0.5,
  weakening: 0.0,
  broken: -0.5,
}

function companyScore(assumptions: Assumption[]): number {
  if (assumptions.length === 0) return 0.5
  const total = assumptions.reduce((sum, a) => sum + (STATUS_WEIGHTS[a.status] ?? 0.5), 0)
  return total / assumptions.length
}

export function computeThemeConviction(
  members: ThemeMembership[],
  assumptionsByTicker: Record<string, Assumption[]>
): number {
  if (members.length === 0) return 0.5

  const totalWeight = members.reduce((sum, m) => sum + m.weight, 0)
  let weighted = 0

  for (const member of members) {
    const assumptions = assumptionsByTicker[member.ticker] ?? []
    const score = companyScore(assumptions)
    weighted += score * (member.weight / totalWeight)
  }

  return weighted
}

export function convictionLabel(score: number): string {
  if (score >= 0.8) return 'strengthening'
  if (score >= 0.5) return 'stable'
  if (score >= 0.2) return 'weakening'
  return 'broken'
}

export function convictionBar(score: number, width = 10): string {
  const filled = Math.round(score * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}
