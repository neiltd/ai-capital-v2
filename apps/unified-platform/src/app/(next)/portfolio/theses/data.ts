// Loader for /portfolio/theses. Real disk/DB reads (no fetch — server
// component), per docs/frontend-migration-plan-2026-07-07.md §1.5.
//
// Real thesis.db has no "exited" position_size (0 rows) — the mockup's
// three-way held/watchlist/exited split collapses to two real buckets:
// held (core+satellite) and watchlist. There is no closed-thesis history
// to show yet (the exit-reason / "harvested vs broken" distinction the
// mockup demonstrates with CRWD/UNH doesn't exist in the current schema).
//
// Related names use a direct edge lookup against dependency-graph-engine's
// graph.json rather than the mockup's typed relation categories (the real
// GraphJSON edges carry a free-text `type`, not a fixed enum to group by).

import { readTheses, readProposals } from '@/lib/thesis-db'
import { readGraph } from '@/lib/data'
import type { AssumptionRow } from '@/lib/thesis-db'

export type ThesisStatus = 'strengthening' | 'stable' | 'weakening' | 'broken'

export interface ThesisRowVM {
  id: string
  ticker: string
  type: string
  positionSize: string
  status: ThesisStatus
  assumptions: AssumptionRow[]
  updatedAt: string
}

export interface RelatedName {
  ticker: string
  type: string
  description: string
}

export interface ProposalVM {
  id: string
  ticker: string
  changeType: string
  oldValue: string
  newValue: string
  reasoning: string
  evidenceQuotes: string[]
  createdAt: string
}

export interface ThesesViewModel {
  exportedAt: string
  proposals: ProposalVM[]
  held: ThesisRowVM[]
  watchlist: ThesisRowVM[]
  related: Record<string, RelatedName[]>
  graphExportedAt: string
  ungraphed: string[]
}

function aggregateStatus(assumptions: AssumptionRow[]): ThesisStatus {
  if (assumptions.some((a) => a.status === 'broken')) return 'broken'
  if (assumptions.some((a) => a.status === 'weakening')) return 'weakening'
  if (assumptions.some((a) => a.status === 'strengthening')) return 'strengthening'
  return 'stable'
}

const STATUS_ORDER: ThesisStatus[] = ['broken', 'weakening', 'stable', 'strengthening']

export function loadTheses(): ThesesViewModel | null {
  let data: ReturnType<typeof readTheses>
  try { data = readTheses() } catch { return null }

  const proposalsData = (() => { try { return readProposals() } catch { return { proposals: [], changes: [] } } })()
  const graph = (() => { try { return readGraph() } catch { return null } })()

  const rows: ThesisRowVM[] = data.theses.map((t) => {
    const assumptions = data.assumptions.filter((a) => a.thesisId === t.id)
    return {
      id: t.id,
      ticker: t.ticker,
      type: t.type,
      positionSize: t.positionSize,
      status: aggregateStatus(assumptions),
      assumptions,
      updatedAt: t.updatedAt,
    }
  })

  const sortByWeakest = (a: ThesisRowVM, b: ThesisRowVM) =>
    STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)

  const held = rows.filter((r) => r.positionSize === 'core' || r.positionSize === 'satellite').sort(sortByWeakest)
  const watchlist = rows.filter((r) => r.positionSize === 'watchlist').sort(sortByWeakest)

  // Pending-only — resolved proposals aren't a review-queue concern (real
  // proposal-history browsing is future work, not built here).
  const pending = proposalsData.proposals.filter((p) => p.status === 'pending')
  const thesisTicker = new Map(data.theses.map((t) => [t.id, t.ticker]))
  const proposals: ProposalVM[] = pending.map((p) => {
    const changes = proposalsData.changes.filter((c) => c.proposalId === p.id)
    const first = changes[0]
    return {
      id: p.id,
      ticker: thesisTicker.get(p.thesisId) ?? '?',
      changeType: first?.changeType ?? 'assumption_status',
      oldValue: first?.oldValue ?? '',
      newValue: first?.newValue ?? '',
      reasoning: p.claudeReasoning,
      evidenceQuotes: changes.flatMap((c) => c.evidenceQuotes),
      createdAt: p.createdAt,
    }
  })

  const related: Record<string, RelatedName[]> = {}
  const ungraphed: string[] = []
  if (graph) {
    for (const r of rows) {
      const edges = graph.edges.filter((e) => e.from === r.ticker || e.to === r.ticker)
      if (edges.length === 0) { ungraphed.push(r.ticker); continue }
      related[r.ticker] = edges.map((e) => ({
        ticker: e.from === r.ticker ? e.to : e.from,
        type: e.type,
        description: e.description ?? '',
      }))
    }
  }

  return {
    exportedAt: data.theses[0]?.updatedAt ?? new Date().toISOString(),
    proposals,
    held,
    watchlist,
    related,
    graphExportedAt: graph?.exportedAt ?? '',
    ungraphed,
  }
}
