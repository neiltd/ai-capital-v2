import type { DiscoveryCandidate } from './types.js'

export function filterCandidates(
  candidates: DiscoveryCandidate[],
  openDiscoveryTickers: Set<string>
): DiscoveryCandidate[] {
  const seen = new Set<string>()
  const result: DiscoveryCandidate[] = []
  for (const candidate of candidates) {
    if (seen.has(candidate.ticker)) continue
    if (openDiscoveryTickers.has(candidate.ticker)) continue
    seen.add(candidate.ticker)
    result.push(candidate)
  }
  return result
}
