import type { EconomicIndicator } from '@/types'

function trendColor(trend: string): string {
  if (trend === 'rising')  return 'text-green-signal'
  if (trend === 'falling') return 'text-red-signal'
  return 'text-text-muted'
}

function alertColor(indicator: EconomicIndicator): string {
  if (indicator.seriesId === 'DRCCLACBS'  && indicator.value > 2.5) return 'text-amber-signal'
  if (indicator.seriesId === 'DRSFRMACBS' && indicator.value > 1.5) return 'text-amber-signal'
  if (indicator.seriesId === 'UNRATE'     && indicator.value > 4.5) return 'text-amber-signal'
  return 'text-text-primary'
}

const TREND_ARROW: Record<string, string> = { rising: '↑', falling: '↓', stable: '→' }

export function MacroIndicatorRow({ indicator }: { indicator: EconomicIndicator }) {
  return (
    <tr className="border-b border-border-subtle last:border-0">
      <td className="py-2 pr-4 text-xs text-text-secondary">{indicator.label}</td>
      <td className={`py-2 pr-4 text-xs font-semibold tabular-nums ${alertColor(indicator)}`}>
        {indicator.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}{indicator.unit === 'Thousands' ? 'K' : indicator.unit === 'Percent' ? '%' : ''}
      </td>
      <td className="py-2 pr-4 text-[10px] text-text-inactive">{indicator.releaseDate}</td>
      <td className={`py-2 text-xs ${trendColor(indicator.trend)}`}>
        {TREND_ARROW[indicator.trend]} {indicator.trend}
      </td>
    </tr>
  )
}
