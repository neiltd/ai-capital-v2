export const dynamic = 'force-dynamic'

import { PortfolioTable } from '@/components/capital/PortfolioTable'
import { ScenarioCards } from '@/components/capital/ScenarioCards'
import { PortfolioOverview } from '@/components/capital/PortfolioOverview'
import { AllSeasonGap } from '@/components/capital/AllSeasonGap'
import { SankeyChart } from '@/components/capital/SankeyChart'
import type { SimulationJSON, PortfolioPosition } from '@/types'
import { readSimulation } from '@/lib/data'
import { PageHeader, MetaDot, SectionTitle } from '@/components/capital/ui/PageHeader'
import { StatCard } from '@/components/capital/ui/StatCard'
import { EmptyState } from '@/components/capital/ui/EmptyState'
import { RefreshPricesButton } from '@/components/capital/RefreshPricesButton'
import { isMarketOpen } from '@/lib/market-hours'

/** Convert a position's value/cost/pnl into USD using the supplied THB→USD rate. */
function inUsd(value: number, currency: PortfolioPosition['currency'], usdThb: number | null): number {
  if (currency !== 'THB') return value
  if (!usdThb || usdThb <= 0) return 0
  return value / usdThb
}

export default async function PortfolioPage() {
  let simulation: SimulationJSON | null = null
  let fetchError: string | null = null

  try {
    simulation = readSimulation()
  } catch (e) {
    fetchError = e instanceof Error ? e.message : 'Failed to load portfolio data'
  }

  if (fetchError || !simulation) {
    return (
      <div className="max-w-4xl">
        <PageHeader title="Portfolio" subtitle="Current positions, scenario impact, and recommended actions" />
        <EmptyState
          tone="error"
          title="Portfolio data unavailable"
          description={fetchError ?? 'Failed to load data'}
        />
      </div>
    )
  }

  const positions = simulation.portfolio ?? []
  const scenarios = simulation.scenarios ?? []
  const actions = simulation.actions ?? []
  const usdThb = simulation.usdThb ?? null

  // Aggregate stats — all normalized to USD using the FX rate.
  const totalValue = positions.reduce((s, p) => {
    const cls = p.assetClass ?? 'us_equity'
    // Cash uses `shares` as the cash amount; others use price * shares.
    if (cls === 'cash') return s + inUsd(p.shares, p.currency, usdThb)
    const price = p.currentPrice > 0 ? p.currentPrice : p.avgCost
    return s + inUsd(price * p.shares, p.currency, usdThb)
  }, 0)

  // Cash % — sum of all cash-class positions in USD.
  const cashUsd = positions.reduce((s, p) => {
    const cls = p.assetClass ?? 'us_equity'
    if (cls !== 'cash') return s
    return s + inUsd(p.shares, p.currency, usdThb)
  }, 0)
  const cashPct = totalValue > 0 ? (cashUsd / totalValue) * 100 : 0

  // Largest holding by USD value.
  interface Ranked { ticker: string; usd: number }
  const ranked: Ranked[] = positions.map(p => {
    const cls = p.assetClass ?? 'us_equity'
    const usd = cls === 'cash'
      ? inUsd(p.shares, p.currency, usdThb)
      : inUsd(
          (p.currentPrice > 0 ? p.currentPrice : p.avgCost) * p.shares,
          p.currency,
          usdThb,
        )
    return { ticker: p.ticker, usd }
  })
  const largest = ranked.reduce<Ranked | null>(
    (best, r) => (best === null || r.usd > best.usd ? r : best),
    null,
  )

  // Count of non-cash positions.
  const nonCashCount = positions.filter(
    p => (p.assetClass ?? 'us_equity') !== 'cash',
  ).length

  return (
    <div className="max-w-6xl space-y-7">
      <PageHeader
        title="Portfolio"
        subtitle="Multi-asset positions across US, Thai, and Asian markets — scenario impact and recommended actions"
        meta={
          <>
            <span>{positions.length} position{positions.length === 1 ? '' : 's'}</span>
            <MetaDot />
            <span>{scenarios.length} scenario{scenarios.length === 1 ? '' : 's'} modeled</span>
            {usdThb !== null && (
              <>
                <MetaDot />
                <span>1 USD = {usdThb.toFixed(2)} THB</span>
              </>
            )}
          </>
        }
        actions={<RefreshPricesButton marketOpen={isMarketOpen()} />}
      />

      {positions.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard
            label="Total Value (USD)"
            value={`$${totalValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}`}
            tone="accent"
          />
          <StatCard
            label="Cash %"
            value={`${cashPct.toFixed(1)}%`}
            sub={`$${cashUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`}
          />
          <StatCard
            label="Largest Holding"
            value={largest ? largest.ticker : '—'}
            sub={
              largest
                ? `$${largest.usd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
                : undefined
            }
          />
          <StatCard
            label="Positions"
            value={`${nonCashCount}`}
            sub={`${positions.length} total`}
          />
        </div>
      )}

      {positions.length > 0 && (
        <>
          <PortfolioOverview positions={positions} usdThb={usdThb ?? 33} />
          <AllSeasonGap positions={positions} usdThb={usdThb ?? 33} />
          <SankeyChart positions={positions} usdThb={usdThb ?? 33} />
        </>
      )}

      <PortfolioTable
        positions={positions}
        scenarios={scenarios}
        actions={actions}
        usdThb={usdThb}
      />

      {scenarios.length > 0 && (
        <section>
          <SectionTitle count={scenarios.length}>Scenarios</SectionTitle>
          <ScenarioCards scenarios={scenarios} actions={actions} />
        </section>
      )}
    </div>
  )
}
