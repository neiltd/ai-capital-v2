export const dynamic = 'force-dynamic'

import { readGovFlow } from '@/lib/data'
import { PageHeader, MetaDot } from '@/components/capital/ui/PageHeader'
import { Card, CardHeader } from '@/components/capital/ui/Card'
import { EmptyState } from '@/components/capital/ui/EmptyState'
import { Badge, type BadgeTone } from '@/components/capital/ui/Badge'

const USD = (n: number) =>
  n >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(1)}M`
    : `$${(n / 1_000).toFixed(0)}K`

const TREND_TONE: Record<string, BadgeTone> = {
  rising:  'success',
  stable:  'neutral',
  falling: 'danger',
}

const TREND_ARROW: Record<string, string> = {
  rising:  '▲',
  stable:  '◆',
  falling: '▼',
}

export default function GovPage() {
  const data = readGovFlow()

  if (!data) {
    return (
      <div className="max-w-4xl">
        <PageHeader title="Government Flows" subtitle="Federal contract awards and budget signals" />
        <EmptyState
          tone="warning"
          title="No government flow data"
          description="govflow.json was not found at the configured data root."
          hint={<>Run <code className="font-mono text-indigo-active">npm run pipeline</code> in government-flow-monitor.</>}
        />
      </div>
    )
  }

  return (
    <div className="max-w-6xl space-y-7">
      <PageHeader
        title="Government Flows"
        subtitle="Federal contract awards and budget signals"
        meta={
          <>
            <span>as of {data.asOf}</span>
            <MetaDot />
            <span>{data.watchlistAwards.length} portfolio matches</span>
            <MetaDot />
            <span>{data.agencyFlows.length} agencies tracked</span>
          </>
        }
      />

      {/* Watchlist contract awards */}
      {data.watchlistAwards.length > 0 && (
        <Card>
          <CardHeader title="Contract Awards · Portfolio Tickers" meta="30-day window" />
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-bg-subtle border-b border-border-subtle">
                  {['Ticker', 'Company', 'Total 30d', 'Awards', 'Top Agency'].map((h, i) => (
                    <th
                      key={h}
                      className={`text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive px-4 py-2.5 ${
                        i === 2 || i === 3 ? 'text-right' : 'text-left'
                      }`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.watchlistAwards.map((a, idx) => (
                  <tr
                    key={a.ticker}
                    className={`border-b border-border-subtle last:border-0 hover:bg-bg-card-hover/40 transition-colors ${
                      idx % 2 === 1 ? 'bg-bg-row-alt/30' : ''
                    }`}
                  >
                    <td className="px-4 py-3 text-[13px] font-semibold text-indigo-active tracking-tight">{a.ticker}</td>
                    <td className="px-4 py-3 text-[12px] text-text-secondary">{a.company}</td>
                    <td className="px-4 py-3 text-[12px] font-semibold text-green-signal tabular-nums text-right">
                      {USD(a.total30d)}
                    </td>
                    <td className="px-4 py-3 text-[12px] text-text-secondary tabular-nums text-right">{a.awardCount}</td>
                    <td className="px-4 py-3 text-[11px] text-text-muted">{a.topAgency}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Agency flows */}
      {data.agencyFlows.length > 0 && (
        <Card>
          <CardHeader title="Top Agencies by Spend" meta="30-day window" />
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-bg-subtle border-b border-border-subtle">
                  {['Agency', 'Total 30d', 'Trend'].map((h, i) => (
                    <th
                      key={h}
                      className={`text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive px-4 py-2.5 ${
                        i === 1 ? 'text-right' : 'text-left'
                      }`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.agencyFlows.map((a, idx) => (
                  <tr
                    key={a.agencyId}
                    className={`border-b border-border-subtle last:border-0 hover:bg-bg-card-hover/40 transition-colors ${
                      idx % 2 === 1 ? 'bg-bg-row-alt/30' : ''
                    }`}
                  >
                    <td className="px-4 py-3 text-[12px] text-text-secondary">{a.agency}</td>
                    <td className="px-4 py-3 text-[12px] text-text-primary tabular-nums text-right">{USD(a.total30d)}</td>
                    <td className="px-4 py-3">
                      <Badge tone={TREND_TONE[a.trend] ?? 'neutral'} size="sm" uppercase>
                        <span className="text-[9px]">{TREND_ARROW[a.trend] ?? '◆'}</span>
                        {a.trend}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Budget signals — govflow.json has been observed to emit duplicate rows
          per billNumber (same bill from multiple tracking passes); dedupe
          defensively so the list and React keys stay correct regardless. */}
      {(() => {
        const uniqueBudgetSignals = Array.from(new Map(data.budgetSignals.map(b => [b.billNumber, b] as const)).values())
        return uniqueBudgetSignals.length > 0 && (
        <Card>
          <CardHeader title="Budget Signals" meta={`${uniqueBudgetSignals.length} bills`} />
          <div className="divide-y divide-border-subtle">
            {uniqueBudgetSignals.map(b => (
              <div key={b.billNumber} className="px-4 py-3.5 hover:bg-bg-card-hover/30 transition-colors">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                      <span className="text-[11px] font-mono font-medium text-text-secondary bg-bg-elevated border border-border-subtle rounded px-1.5 py-0.5">
                        {b.billNumber}
                      </span>
                      <Badge tone="neutral" size="xs" uppercase>{b.status}</Badge>
                      {typeof b.totalFunding === 'number' && Number.isFinite(b.totalFunding) && (
                        <Badge tone="success" size="xs">{USD(b.totalFunding)}</Badge>
                      )}
                    </div>
                    <p className="text-[13px] font-medium text-text-primary mb-1 leading-snug">{b.title}</p>
                    <p className="text-[11px] text-text-muted leading-relaxed line-clamp-2">{b.summary}</p>
                  </div>
                  {b.relevantTickers.length > 0 && (
                    <div className="flex flex-wrap gap-1 shrink-0 max-w-[120px] justify-end">
                      {b.relevantTickers.map(t => (
                        <Badge key={t} tone="accent" size="xs">{t}</Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
        )
      })()}
    </div>
  )
}
