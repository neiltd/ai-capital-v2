export const dynamic = 'force-dynamic'

import { readWaveActions, readWavePortfolio, readWaves } from '@/lib/data'
import { TradeSignalRow } from '@/components/capital/TradeSignalRow'
import { TradePositionRow } from '@/components/capital/TradePositionRow'
import { ShortSetupsTable } from '@/components/capital/ShortSetupsTable'
import { PageHeader, MetaDot } from '@/components/capital/ui/PageHeader'
import { StatCard } from '@/components/capital/ui/StatCard'
import { Card, CardHeader } from '@/components/capital/ui/Card'
import { EmptyState } from '@/components/capital/ui/EmptyState'

const SIGNAL_HEADERS = ['Ticker', 'Signal', 'Wave', 'Confidence', 'R:R', 'Risk Geometry', 'Entry Zone', 'Stop', 'Target', '30D']
const POSITION_HEADERS = ['Ticker', 'Direction', 'Entry', 'Stop', 'Target', 'Shares', 'P&L', 'To Target']

function TableShell({
  title,
  meta,
  headers,
  children,
}: {
  title: string
  meta?: string
  headers: string[]
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader title={title} meta={meta} />
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-bg-subtle border-b border-border-subtle">
              {headers.map(h => (
                <th
                  key={h}
                  className="text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive px-4 py-2.5 whitespace-nowrap"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </Card>
  )
}

export default function TradePage() {
  const waveActions   = readWaveActions()
  const wavePortfolio = readWavePortfolio()
  const waves         = readWaves()

  const sparkByTicker = new Map<string, number[]>()
  for (const asset of waves?.assets ?? []) {
    const closes = asset.candles.slice(-30).map(c => c.close)
    if (closes.length >= 2) sparkByTicker.set(asset.ticker, closes)
  }

  const signals = (waveActions?.actions ?? [])
    .filter(a => a.signal !== 'no-signal')
    .sort((a, b) => b.confidence - a.confidence || (b.riskReward ?? 0) - (a.riskReward ?? 0))

  const longSignals  = signals.filter(a => a.signal === 'buy')
  const shortSignals = signals.filter(a => a.signal === 'sell')

  const openPositions   = wavePortfolio?.openPositions   ?? []
  const closedPositions = wavePortfolio?.closedPositions ?? []
  const totalPnl        = wavePortfolio?.totalPnl        ?? 0

  // P&L metrics
  const totalCost = openPositions.reduce((s, p) => s + p.entryPrice * p.shares, 0)
  const openPnl   = openPositions.reduce((s, p) => s + (p.pnl ?? 0), 0)
  const pnlPct    = totalCost > 0 ? (openPnl / totalCost) * 100 : null

  const empty = signals.length === 0 && openPositions.length === 0 && closedPositions.length === 0

  return (
    <div className="max-w-7xl space-y-7">
      <PageHeader
        title="Trade"
        subtitle="Elliott Wave trade signals and open positions"
        meta={
          <>
            <span>{signals.length} active signals</span>
            <MetaDot />
            <span>{openPositions.length} open positions</span>
            <MetaDot />
            <span>{closedPositions.length} closed</span>
          </>
        }
      />

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          label="Active Signals"
          value={signals.length}
          sub={signals.length > 0 ? `top conf ${signals[0]?.confidence ?? 0}%` : 'awaiting setup'}
          tone="accent"
        />
        <StatCard
          label="Open Positions"
          value={openPositions.length}
          sub={openPositions.length > 0 ? `$${totalCost.toLocaleString('en-US', { maximumFractionDigits: 0 })} deployed` : 'no exposure'}
          tone="neutral"
          delta={pnlPct}
        />
        <StatCard
          label="Closed P&L"
          value={
            <span className="inline-flex items-center gap-1.5">
              <span className="text-[16px]">{totalPnl >= 0 ? '▲' : '▼'}</span>
              {totalPnl >= 0 ? '+' : ''}${Math.abs(totalPnl).toLocaleString('en-US', { maximumFractionDigits: 0 })}
            </span>
          }
          sub={`${closedPositions.length} trade${closedPositions.length === 1 ? '' : 's'} settled`}
          tone={totalPnl >= 0 ? 'positive' : 'negative'}
        />
      </div>

      {longSignals.length > 0 && (
        <TableShell
          title="Long Setups"
          meta={`${longSignals.length} · ranked by confidence × R:R`}
          headers={SIGNAL_HEADERS}
        >
          {longSignals.map(a => <TradeSignalRow key={a.ticker} action={a} sparkValues={sparkByTicker.get(a.ticker)} />)}
        </TableShell>
      )}

      {shortSignals.length > 0 && (
        <ShortSetupsTable signals={shortSignals} sparkByTicker={sparkByTicker} />
      )}

      {openPositions.length > 0 && (
        <TableShell
          title="Open Positions"
          meta={`${openPositions.length} live`}
          headers={POSITION_HEADERS}
        >
          {openPositions.map(p => <TradePositionRow key={p.id} position={p} />)}
        </TableShell>
      )}

      {closedPositions.length > 0 && (
        <TableShell
          title="Closed Trades"
          meta="Last 20"
          headers={POSITION_HEADERS}
        >
          {closedPositions.map(p => <TradePositionRow key={p.id} position={p} />)}
        </TableShell>
      )}

      {empty && (
        <EmptyState
          icon="⚡"
          title="No wave signals or positions yet"
          description="The wave analyzer hasn't produced any actionable setups."
          hint={<>Run <code className="font-mono text-indigo-active">npm run analyze</code> in wave-analyzer to generate signals.</>}
        />
      )}
    </div>
  )
}
