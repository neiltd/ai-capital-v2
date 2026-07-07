import { notFound } from 'next/navigation'
import Link from 'next/link'
import { readWaves } from '@/lib/data'
import { readWaveActions } from '@/lib/data'
import { WaveChart } from '@/components/capital/WaveChart'
import { TradePlanCard } from '@/components/capital/TradePlanCard'

export const dynamic = 'force-dynamic'

export default async function WaveDetailPage({
  params,
}: {
  params: { ticker: string }
}) {
  const ticker = decodeURIComponent(params.ticker)

  let waves
  try { waves = readWaves() } catch { waves = null }
  if (!waves) return notFound()

  const asset = waves.assets.find(a => a.ticker === ticker)
  if (!asset) return notFound()

  const waveActions = readWaveActions()
  const tradeAction = waveActions?.actions.find(a => a.ticker === ticker) ?? null

  const waveColor = ['1','3','5'].includes(asset.currentWave ?? '')
    ? '#22c55e' : ['2','4'].includes(asset.currentWave ?? '') ? '#f59e0b' : '#ef4444'
  const confColor = asset.confidence >= 75 ? '#22c55e' : asset.confidence >= 50 ? '#f59e0b' : '#ef4444'

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <Link href="/capital/waves"
          className="text-[11px] text-[#8a8f98] hover:text-[#d0d6e0] transition-colors">
          ← All assets
        </Link>
        <h1 className="text-[15px] font-semibold text-[#f7f8f8]">{asset.ticker}</h1>
        {asset.label !== asset.ticker && (
          <span className="text-[12px] text-[#8a8f98]">{asset.label}</span>
        )}
        {asset.currentWave && (
          <span className="text-[11px] font-medium rounded px-2 py-0.5"
            style={{ background: waveColor + '22', color: waveColor }}>
            Wave {asset.currentWave} {asset.waveDirection === 'up' ? '↑' : '↓'}
          </span>
        )}
        {asset.confidence > 0 && (
          <span className="text-[11px] rounded px-2 py-0.5"
            style={{ background: confColor + '22', color: confColor }}>
            {asset.confidence}% confidence
          </span>
        )}
        <span className="text-[10px] text-[#62666d] border border-[#23252a] rounded px-1.5 py-0.5 ml-auto">
          {asset.source}
        </span>
      </div>

      <WaveChart asset={asset} />

      {asset.fibChecks.length > 0 && (
        <div className="mt-5">
          <h2 className="text-[11px] font-semibold text-[#8a8f98] uppercase tracking-wider mb-2">
            Fibonacci Checks
          </h2>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-[11px] text-[#62666d] border-b border-[#23252a]">
                <th className="text-left py-1.5 pr-4 font-medium">Rule</th>
                <th className="text-right py-1.5 pr-4 font-medium">Expected</th>
                <th className="text-right py-1.5 pr-4 font-medium">Actual</th>
                <th className="text-right py-1.5 font-medium">Pass</th>
              </tr>
            </thead>
            <tbody>
              {asset.fibChecks.map((fc) => (
                <tr key={fc.description} className="border-b border-[#1a1c20]">
                  <td className="py-1.5 pr-4 text-[#d0d6e0]">{fc.description}</td>
                  <td className="py-1.5 pr-4 text-right text-[#8a8f98]">{fc.expectedRange}</td>
                  <td className="py-1.5 pr-4 text-right text-[#8a8f98]">{fc.actual.toFixed(3)}</td>
                  <td className="py-1.5 text-right">
                    <span style={{ color: fc.pass ? '#22c55e' : '#ef4444' }}>
                      {fc.pass ? '✓' : '✗'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tradeAction && <TradePlanCard action={tradeAction} />}
    </div>
  )
}
