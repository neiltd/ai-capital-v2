export const dynamic = 'force-dynamic'

import { readDiscovery, readGraph } from '@/lib/data'
import type { DiscoveryPosition, DiscoveryScenario, DiscoveryAction, DiscoveryExportCandidate, GraphEdge, GraphNode } from '@/types'
import { PageHeader, MetaDot, SectionTitle } from '@/components/capital/ui/PageHeader'
import { Card, CardHeader } from '@/components/capital/ui/Card'
import { StatCard } from '@/components/capital/ui/StatCard'
import { EmptyState } from '@/components/capital/ui/EmptyState'
import { Badge } from '@/components/capital/ui/Badge'
import { ScoreRing } from '@/components/capital/ui/ScoreRing'
import { RationaleModal } from '@/components/capital/RationaleModal'

// ─── helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'UTC', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch { return iso }
}

// ─── small components ─────────────────────────────────────────────────────────

function ScoreBadge({ score }: { score: number }) {
  const cls = score >= 80
    ? 'bg-green-signal/10 text-green-signal border border-green-signal/20'
    : 'bg-amber-signal/10 text-amber-signal border border-amber-signal/20'
  return <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${cls}`}>{score}</span>
}

function PnlCell({ value, pct }: { value: number; pct: number }) {
  const cls = value >= 0 ? 'text-green-signal' : 'text-red-signal'
  const sign = value >= 0 ? '+' : ''
  return (
    <div className={`${cls} font-medium text-right`}>
      <div className="text-xs">{sign}${Math.abs(value).toFixed(2)}</div>
      <div className="text-[10px] opacity-70">{sign}{pct.toFixed(1)}%</div>
    </div>
  )
}

function SourceTag({ source }: { source: string }) {
  const isNews = source === 'news_mention'
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
      isNews
        ? 'bg-accent-primary/10 text-indigo-active border-accent-primary/20'
        : 'bg-border-subtle text-text-muted border-border-subtle'
    }`}>
      {isNews ? 'news' : 'tracked'}
    </span>
  )
}

function ActionBadge({ action }: { action: DiscoveryAction | undefined; large?: boolean }) {
  if (!action) return <span className="text-text-muted text-[10px]">—</span>
  const isBuy = action.recommendation === 'buy'
  const cls = isBuy
    ? 'bg-green-signal/10 text-green-signal border border-green-signal/20'
    : 'bg-amber-signal/10 text-amber-signal border border-amber-signal/20'
  const conv = action.conviction === 'high' ? 'H' : action.conviction === 'medium' ? 'M' : 'L'
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded ${cls}`}>
      {isBuy ? 'Buy' : 'Watch'} · {conv}
    </span>
  )
}

// ─── scenario cards ───────────────────────────────────────────────────────────

const SCENARIO_STYLES = {
  best:       { border: 'border-t-green-signal',  label: 'text-green-signal',  title: 'Best'        },
  base:       { border: 'border-t-amber-signal',  label: 'text-amber-signal',  title: 'Base'        },
  disruption: { border: 'border-t-red-signal',    label: 'text-red-signal',    title: 'Disruption'  },
} as const

function ScenarioSection({ position, scenarios }: { position: DiscoveryPosition; scenarios: DiscoveryScenario[] }) {
  const posScenarios = scenarios.filter(s => s.ticker === position.ticker)
  const ORDER = ['best', 'base', 'disruption'] as const
  const sorted = [...posScenarios].sort(
    (a, b) => ORDER.indexOf(a.scenarioType as typeof ORDER[number]) - ORDER.indexOf(b.scenarioType as typeof ORDER[number])
  )

  return (
    <div>
      <h2 className="text-xs font-semibold uppercase tracking-wide text-accent-primary mb-3">
        {position.ticker} — Scenario Analysis
      </h2>
      {posScenarios.length === 0 ? (
        <div className="bg-bg-card border border-border-subtle rounded-lg p-4 text-sm text-text-muted">
          Scenarios were generated when this position was opened ({position.openedAt.slice(0, 10)}).
          Run <code className="bg-border-subtle text-indigo-active px-1 py-0.5 rounded text-[10px]">npm run discover</code> again to refresh.
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {sorted.map(s => {
            const style = SCENARIO_STYLES[s.scenarioType as keyof typeof SCENARIO_STYLES] ??
              { border: 'border-t-text-muted', label: 'text-text-muted', title: s.scenarioType }
            return (
              <div key={s.id} className={`bg-bg-card border border-border-subtle rounded-lg p-4 border-t-2 ${style.border}`}>
                <div className={`text-[10px] font-semibold uppercase tracking-wide mb-1 ${style.label}`}>
                  {style.title} · {s.probability}%
                </div>
                <div className="text-xs font-medium text-text-primary mb-2">{s.title}</div>
                <div className="text-[11px] text-text-muted leading-relaxed mb-3">{s.narrative}</div>
                {s.triggers.length > 0 && (
                  <div className="border-t border-border-subtle pt-2 space-y-1">
                    <div className="text-[9px] text-text-inactive uppercase tracking-wide mb-1">Key triggers</div>
                    <div className="flex flex-wrap gap-1">
                      {s.triggers.map((t, i) => (
                        <span key={i} className="text-[9px] bg-bg-sidebar border border-border-subtle rounded px-1.5 py-0.5 text-text-inactive">
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── supply chain ─────────────────────────────────────────────────────────────

type EdgeGroup = {
  label: string
  direction: string
  edges: Array<{ node: GraphNode | undefined; edge: GraphEdge }>
  color: string
}

function supplyChainForTicker(
  ticker: string,
  edges: GraphEdge[],
  nodeMap: Map<string, GraphNode>
): EdgeGroup[] {
  const groups: EdgeGroup[] = [
    { label: 'Upstream', direction: '↑', color: 'text-indigo-active border-accent-primary/20 bg-accent-primary/5',
      edges: edges
        .filter(e => e.from === ticker && (e.type === 'supply_chain' || e.type === 'technology'))
        .map(e => ({ node: nodeMap.get(e.to), edge: e })) },
    { label: 'Downstream', direction: '↓', color: 'text-green-signal border-green-signal/20 bg-green-signal/5',
      edges: edges
        .filter(e => e.to === ticker && (e.type === 'supply_chain' || e.type === 'customer'))
        .map(e => ({ node: nodeMap.get(e.from), edge: e })) },
    { label: 'Customers', direction: '→', color: 'text-green-signal border-green-signal/20 bg-green-signal/5',
      edges: edges
        .filter(e => e.from === ticker && e.type === 'customer')
        .map(e => ({ node: nodeMap.get(e.to), edge: e })) },
    { label: 'Competitors', direction: '⇌', color: 'text-amber-signal border-amber-signal/20 bg-amber-signal/5',
      edges: [
        ...edges.filter(e => e.from === ticker && e.type === 'competitive').map(e => ({ node: nodeMap.get(e.to), edge: e })),
        ...edges.filter(e => e.to === ticker && e.type === 'competitive').map(e => ({ node: nodeMap.get(e.from), edge: e })),
      ] },
  ].filter(g => g.edges.length > 0)
  return groups
}

function SupplyChainSection({ ticker, edges, nodeMap }: {
  ticker: string
  edges: GraphEdge[]
  nodeMap: Map<string, GraphNode>
}) {
  const groups = supplyChainForTicker(ticker, edges, nodeMap)
  if (groups.length === 0) return null

  return (
    <div className="mt-3 pt-3 border-t border-border-subtle">
      <div className="text-[10px] text-text-inactive uppercase tracking-wide mb-2">Supply Chain Connections</div>
      <div className="space-y-2">
        {groups.map(group => (
          <div key={group.label}>
            <div className="text-[9px] text-text-inactive uppercase tracking-wide mb-1">
              {group.direction} {group.label}
            </div>
            <div className="space-y-1">
              {group.edges.map(({ node, edge }) => (
                <div
                  key={`${edge.from}-${edge.to}`}
                  className={`flex items-start gap-2 text-[11px] rounded px-2 py-1.5 border ${group.color}`}
                >
                  <div className="flex-shrink-0 font-semibold w-12">{node?.ticker ?? (edge.from === ticker ? edge.to : edge.from)}</div>
                  <div className="flex-1 text-text-muted leading-snug">{edge.description}</div>
                  <div className={`flex-shrink-0 text-[9px] opacity-60 capitalize`}>{edge.strength}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── scenario probability bar (segmented, matches mockup) ────────────────────

function ScenarioProbabilityBar({ scenarios }: { scenarios: DiscoveryScenario[] }) {
  const ORDER = ['best', 'base', 'disruption'] as const
  const ordered = ORDER.map(type => scenarios.find(s => s.scenarioType === type)).filter(
    (s): s is DiscoveryScenario => !!s
  )
  if (ordered.length === 0) return null

  const barColor = { best: 'bg-green-signal', base: 'bg-amber-signal', disruption: 'bg-red-signal' } as const
  const dotColor = { best: 'bg-green-signal', base: 'bg-amber-signal', disruption: 'bg-red-signal' } as const

  return (
    <div>
      <div className="text-[10px] text-text-inactive uppercase tracking-wide mb-2">Scenario probabilities</div>
      <div className="flex h-1.5 rounded-full overflow-hidden mb-3">
        {ordered.map(s => (
          <div
            key={s.id}
            className={barColor[s.scenarioType as keyof typeof barColor] ?? 'bg-text-inactive'}
            style={{ width: `${s.probability}%` }}
          />
        ))}
      </div>
      <div className="space-y-2">
        {ordered.map(s => (
          <div key={s.id} className="flex items-start gap-2">
            <span className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${dotColor[s.scenarioType as keyof typeof dotColor] ?? 'bg-text-inactive'}`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-1.5">
                <span className="text-[11px] font-semibold text-text-primary capitalize">{s.scenarioType}</span>
                <span className="text-[11px] font-bold text-text-primary tabular-nums">{s.probability}%</span>
              </div>
              <p className="text-[11px] text-text-muted leading-snug">{s.title}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── candidate detail card ────────────────────────────────────────────────────

function CandidateCard({ candidate, action, scenarios, edges, nodeMap, rank, total }: {
  candidate: DiscoveryExportCandidate
  action: DiscoveryAction | undefined
  scenarios: DiscoveryScenario[]
  edges: GraphEdge[]
  nodeMap: Map<string, GraphNode>
  rank: number
  total: number
}) {
  const candScenarios = scenarios.filter(s => s.ticker === candidate.ticker)
  const chainGroups = supplyChainForTicker(candidate.ticker, edges, nodeMap)
  const isBuy = candidate.action === 'buy'
  const triggers = candScenarios.flatMap(s => s.triggers)

  return (
    <div className="bg-bg-card border border-border-subtle rounded-lg overflow-hidden">
      {/* Header: score ring, ticker/company, rank, buy/watch verdict */}
      <div className="px-5 py-4 flex items-center justify-between border-b border-border-subtle">
        <div className="flex items-center gap-4">
          <ScoreRing score={candidate.score} size={56} label="score" />
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-base font-bold text-indigo-active">{candidate.ticker}</span>
              <span className="text-[13px] text-text-muted">{candidate.company}</span>
              <SourceTag source={candidate.source} />
            </div>
            <div className="text-[11px] text-text-inactive mt-0.5">rank {rank} of {total}</div>
          </div>
        </div>
        {action && (
          <Badge tone={isBuy ? 'success' : 'warning'} size="sm" uppercase>
            {action.recommendation} · {action.conviction}
          </Badge>
        )}
      </div>

      <div className="grid md:grid-cols-2 gap-6 px-5 py-4">
        {/* Left: how it got here — collapsed to what's actually timestamped */}
        <div>
          <div className="text-[10px] text-text-inactive uppercase tracking-wide mb-3">How it got here</div>
          <div className="space-y-3">
            <div className="flex gap-3">
              <div className="flex flex-col items-center flex-shrink-0 pt-0.5">
                <span className="w-2 h-2 rounded-full bg-indigo-active" />
                <span className="w-px flex-1 bg-border-subtle mt-1" />
              </div>
              <div className="pb-1">
                <div className="text-[11px] font-semibold text-text-primary">
                  Screener signal <span className="text-text-inactive font-normal">· {formatDate(candidate.discoveredAt)}</span>
                </div>
                <p className="text-[11px] text-text-secondary leading-relaxed mt-1">{candidate.rationale}</p>
              </div>
            </div>

            {candidate.newsSnippet && (
              <div className="flex gap-3">
                <div className="flex flex-col items-center flex-shrink-0 pt-0.5">
                  <span className="w-2 h-2 rounded-full bg-border-strong" />
                  {action && <span className="w-px flex-1 bg-border-subtle mt-1" />}
                </div>
                <div className="pb-1">
                  <div className="text-[11px] font-semibold text-text-primary">Surfaced by news</div>
                  <p className="text-[11px] text-text-muted leading-relaxed italic mt-1">&ldquo;{candidate.newsSnippet}&rdquo;</p>
                </div>
              </div>
            )}

            {action && (
              <div className="flex gap-3">
                <div className="flex flex-col items-center flex-shrink-0 pt-0.5">
                  <span className={`w-2 h-2 rounded-full ${isBuy ? 'bg-green-signal' : 'bg-amber-signal'}`} />
                </div>
                <div>
                  <div className="text-[11px] font-semibold text-text-primary">
                    Analyst verdict <span className="text-text-inactive font-normal">· {action.conviction} conviction</span>
                  </div>
                  <p className="text-[11px] text-text-secondary leading-relaxed mt-1">{action.rationale}</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right: scenario probabilities, key triggers, supply chain */}
        <div className="space-y-4">
          {candScenarios.length > 0 ? (
            <ScenarioProbabilityBar scenarios={candScenarios} />
          ) : (
            <div className="text-[11px] text-text-muted">
              Scenarios generate when a candidate crosses the buy/watch threshold — none yet for this ticker.
            </div>
          )}

          {triggers.length > 0 && (
            <div>
              <div className="text-[10px] text-text-inactive uppercase tracking-wide mb-1.5">Key triggers</div>
              <div className="flex flex-wrap gap-1.5">
                {Array.from(new Set(triggers)).map((t, i) => (
                  <span key={i} className="text-[10px] bg-bg-sidebar border border-border-subtle rounded px-2 py-1 text-text-secondary">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          {chainGroups.length > 0 && (
            <SupplyChainSection ticker={candidate.ticker} edges={edges} nodeMap={nodeMap} />
          )}
        </div>
      </div>
    </div>
  )
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default async function DiscoveryPage() {
  // Read data directly (server component — no API hop needed)
  const discovery = readDiscovery()
  let graph: { nodes: GraphNode[]; edges: GraphEdge[] } | null = null
  try { graph = readGraph() } catch { /* graph may not exist yet */ }

  if (!discovery) {
    return (
      <div className="max-w-4xl">
        <PageHeader
          title="Discovery"
          subtitle="Autonomous candidate screening · runs daily at 6:45 AM"
        />
        <EmptyState
          icon="✦"
          title="No discovery data yet"
          description="The autonomous screener hasn't produced any candidates."
          hint={<>Run <code className="font-mono text-indigo-active">npm run discover</code> in scenario-simulator to generate the first report.</>}
        />
      </div>
    )
  }

  const { candidates, discoveryPortfolio, scenarios, actions, config } = discovery

  // Build lookup maps
  const actionMap: Record<string, DiscoveryAction> = {}
  for (const a of actions) actionMap[a.ticker] = a

  const nodeMap = new Map<string, GraphNode>((graph?.nodes ?? []).map(n => [n.ticker, n]))
  const graphEdges: GraphEdge[] = graph?.edges ?? []

  const sortedCandidates = [...candidates].sort((a, b) => b.score - a.score)
  const firstPosition = discoveryPortfolio[0] ?? null

  const totalPnl = discoveryPortfolio.reduce((s, p) => s + p.unrealizedPnl, 0)
  const totalCost = discoveryPortfolio.reduce((s, p) => s + p.avgCost * p.shares, 0)
  const totalPnlPct = totalCost === 0 ? 0 : (totalPnl / totalCost) * 100

  return (
    <div className="max-w-6xl space-y-7">
      <PageHeader
        title="Discovery"
        subtitle="Autonomous candidate screening · runs daily at 6:45 AM"
        meta={
          <>
            <span>Last run: {formatDate(discovery.exportedAt)}</span>
            <MetaDot />
            <span>threshold {config.threshold}</span>
            <MetaDot />
            <span>budget ${config.paperBudget.toLocaleString()}</span>
            <MetaDot />
            <span>{(config.cashReservePct * 100).toFixed(0)}% cash reserve</span>
          </>
        }
        actions={
          <div className="text-[11px] text-text-muted bg-bg-card border border-border-subtle rounded-md px-3 py-1.5">
            <span className="text-text-primary font-semibold tabular-nums">{candidates.length}</span> passed
            <span className="text-text-faint mx-1.5">·</span>
            <span className="text-text-primary font-semibold tabular-nums">{discoveryPortfolio.length}</span> open
          </div>
        }
      />

      {/* Summary stats */}
      {discoveryPortfolio.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            label="Open Positions"
            value={discoveryPortfolio.length}
            tone="accent"
          />
          <StatCard
            label="Paper Deployed"
            value={`$${totalCost.toFixed(0)}`}
            sub="committed"
          />
          <StatCard
            label="Total P&L"
            value={
              <span className="inline-flex items-center gap-1.5">
                <span className="text-[16px]">{totalPnl >= 0 ? '▲' : '▼'}</span>
                {totalPnl >= 0 ? '+' : ''}${Math.abs(totalPnl).toFixed(2)}
              </span>
            }
            sub={`${totalPnlPct >= 0 ? '+' : ''}${totalPnlPct.toFixed(1)}%`}
            tone={totalPnl >= 0 ? 'positive' : 'negative'}
          />
          <StatCard
            label="Return"
            value={`${totalPnlPct >= 0 ? '+' : ''}${totalPnlPct.toFixed(1)}%`}
            tone={totalPnlPct >= 0 ? 'positive' : 'negative'}
          />
        </div>
      )}

      {/* Paper Positions table */}
      <Card>
        <CardHeader
          title="Paper Positions"
          meta={`${discoveryPortfolio.length} held`}
          actions={
            discoveryPortfolio.length > 0 ? (
              <span className={`text-[11px] font-semibold tabular-nums ${totalPnl >= 0 ? 'text-green-signal' : 'text-red-signal'}`}>
                {totalPnl >= 0 ? '▲' : '▼'} {totalPnl >= 0 ? '+' : ''}${Math.abs(totalPnl).toFixed(2)}
                <span className="opacity-70 ml-1">({totalPnlPct >= 0 ? '+' : ''}{totalPnlPct.toFixed(1)}%)</span>
              </span>
            ) : null
          }
        />
        {discoveryPortfolio.length === 0 ? (
          <div className="p-8 text-center text-[12px] text-text-muted">
            No paper positions yet — discovery runs daily at 6:45 AM.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-bg-subtle border-b border-border-subtle">
                  <th className="px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive">Ticker</th>
                  <th className="px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive">Company</th>
                  <th className="px-4 py-2.5 text-right text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive">Score</th>
                  <th className="px-4 py-2.5 text-right text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive">Shares</th>
                  <th className="px-4 py-2.5 text-right text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive">Avg Cost</th>
                  <th className="px-4 py-2.5 text-right text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive">Price</th>
                  <th className="px-4 py-2.5 text-right text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive">Value</th>
                  <th className="px-4 py-2.5 text-right text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive">P&L</th>
                  <th className="px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive">Why</th>
                  <th className="px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive">Source</th>
                  <th className="px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive">Signal</th>
                  <th className="px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive">Opened</th>
                </tr>
              </thead>
              <tbody>
                {discoveryPortfolio.map((p, idx) => {
                  const costBasis = p.avgCost * p.shares
                  const pnlPct = p.avgCost === 0 ? 0 : (p.unrealizedPnl / costBasis) * 100
                  const allocPct = config.paperBudget > 0 ? (costBasis / config.paperBudget) * 100 : 0
                  const sizingTier = p.score >= 90 ? 'high conviction (12%)' : p.score >= 80 ? 'medium (8%)' : 'low (5%)'
                  const action = actionMap[p.ticker]
                  return (
                    <tr
                      key={p.ticker}
                      className={`border-b border-border-subtle last:border-0 hover:bg-bg-card-hover/40 transition-colors ${
                        idx % 2 === 1 ? 'bg-bg-row-alt/30' : ''
                      }`}
                    >
                      <td className="px-4 py-3 text-[13px] font-semibold text-indigo-active tracking-tight">{p.ticker}</td>
                      <td className="px-4 py-3 text-[12px] text-text-secondary">{p.company}</td>
                      <td className="px-4 py-3 text-right"><ScoreBadge score={p.score} /></td>
                      <td className="px-4 py-3 text-[12px] text-text-secondary text-right tabular-nums">{p.shares.toFixed(4)}</td>
                      <td className="px-4 py-3 text-[12px] text-text-secondary text-right tabular-nums">${p.avgCost.toFixed(2)}</td>
                      <td className="px-4 py-3 text-[12px] text-text-secondary text-right tabular-nums">
                        {p.currentPrice === 0 ? <span className="text-text-faint">—</span> : `$${p.currentPrice.toFixed(2)}`}
                      </td>
                      <td className="px-4 py-3 text-[12px] text-text-primary text-right tabular-nums font-semibold">
                        ${p.currentValue.toFixed(2)}
                        <div className="text-[10px] text-text-inactive font-normal">{allocPct.toFixed(1)}% of budget</div>
                      </td>
                      <td className="px-4 py-3 text-right text-[12px]">
                        {p.currentPrice === 0 ? <span className="text-text-faint">—</span>
                          : <PnlCell value={p.unrealizedPnl} pct={pnlPct} />}
                      </td>
                      <td className="px-4 py-3 max-w-xs">
                        <RationaleModal
                          ticker={p.ticker}
                          company={p.company}
                          score={p.score}
                          source={p.source}
                          rationale={p.rationale}
                          analystRationale={action?.rationale ?? null}
                          conviction={action?.conviction ?? null}
                          sizingTier={sizingTier}
                          allocPct={allocPct}
                          paperBudget={config.paperBudget}
                          shares={p.shares}
                          currentValue={p.currentValue || costBasis}
                          openedAt={p.openedAt}
                        />
                      </td>
                      <td className="px-4 py-3"><SourceTag source={p.source} /></td>
                      <td className="px-4 py-3"><ActionBadge action={actionMap[p.ticker]} /></td>
                      <td className="px-4 py-3 text-[11px] text-text-inactive whitespace-nowrap tabular-nums">{formatDate(p.openedAt)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Scenario analysis for first position */}
      {firstPosition && (
        <ScenarioSection position={firstPosition} scenarios={scenarios} />
      )}

      {/* Today's candidates — rich cards */}
      {sortedCandidates.length > 0 && (
        <section>
          <SectionTitle
            count={sortedCandidates.length}
            action={
              <span className="text-[10px] text-text-inactive">
                scored ≥ {config.threshold} · sorted by score ↓
              </span>
            }
          >
            Today&apos;s Candidates
          </SectionTitle>
          <div className="space-y-3">
            {sortedCandidates.map((candidate, idx) => (
              <CandidateCard
                key={candidate.ticker}
                candidate={candidate}
                action={actionMap[candidate.ticker]}
                scenarios={scenarios}
                edges={graphEdges}
                nodeMap={nodeMap}
                rank={idx + 1}
                total={sortedCandidates.length}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
