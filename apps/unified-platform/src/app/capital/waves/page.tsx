import { readWaves, readWaveActions } from '@/lib/data'
import { WaveCard } from '@/components/capital/WaveCard'
import { TradeSignalRow } from '@/components/capital/TradeSignalRow'
import Link from 'next/link'
import { PageHeader, MetaDot, SectionTitle } from '@/components/capital/ui/PageHeader'
import { Card, CardHeader } from '@/components/capital/ui/Card'
import { EmptyState } from '@/components/capital/ui/EmptyState'

export const dynamic = 'force-dynamic'

export default async function WavesPage() {
  let data
  let actions
  try { data = readWaves() } catch { data = null }
  try { actions = readWaveActions() } catch { actions = null }

  if (!data) {
    return (
      <div className="max-w-4xl">
        <PageHeader title="Wave Analysis" subtitle="Elliott Wave counts and trade-grade pattern recognition" />
        <EmptyState
          tone="warning"
          title="No wave data available"
          description="The daily wave analysis pipeline has not produced output yet."
          hint={<>Run the daily pipeline to generate wave counts.</>}
        />
      </div>
    )
  }

  const signals = (actions?.actions ?? [])
    .filter(a => a.signal === 'buy' || a.signal === 'sell')
    .sort((a, b) => b.confidence - a.confidence)

  return (
    <div className="max-w-7xl space-y-7">
      <PageHeader
        title="Wave Analysis"
        subtitle="Elliott Wave counts and trade-grade pattern recognition"
        meta={
          <>
            <span>as of {data.asOf}</span>
            <MetaDot />
            <span>{data.assets.length} assets tracked</span>
            <MetaDot />
            <span>{signals.length} active signals</span>
          </>
        }
        actions={
          signals.length > 0 ? (
            <Link
              href="/capital/trade"
              className="text-[12px] font-medium text-indigo-active hover:text-indigo-soft transition-colors inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-accent-primary/20 bg-accent-primary/[0.06] hover:bg-accent-primary/[0.1]"
            >
              View all signals
              <span aria-hidden>→</span>
            </Link>
          ) : null
        }
      />

      {signals.length > 0 && (
        <section>
          <Card>
            <CardHeader title="Active Signals" meta={`${signals.length} live`} />
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-bg-subtle border-b border-border-subtle">
                    {['Ticker','Signal','Wave','Confidence','R:R','Entry Zone','Stop','Target'].map(h => (
                      <th
                        key={h}
                        className="text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive px-4 py-2.5 whitespace-nowrap"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {signals.map(a => <TradeSignalRow key={a.ticker} action={a} />)}
                </tbody>
              </table>
            </div>
          </Card>
        </section>
      )}

      <section>
        <SectionTitle count={data.assets.length}>All Assets</SectionTitle>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {data.assets.map(asset => (
            <WaveCard key={asset.ticker} asset={asset} />
          ))}
        </div>
      </section>
    </div>
  )
}
