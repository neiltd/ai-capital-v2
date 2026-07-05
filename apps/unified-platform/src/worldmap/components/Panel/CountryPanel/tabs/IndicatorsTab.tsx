import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis,
  ResponsiveContainer, Tooltip as ChartTooltip,
} from 'recharts'
import type { Country } from '../../../../types/country'
import { Sec } from '../tokens'

// ── Indicator definitions — order controls radar chart axis order ──────────────
const INDICATORS = [
  { key: 'politicalStability',       label: 'Political Stability' },
  { key: 'economicDirection',        label: 'Economic Direction' },
  { key: 'investmentAttractiveness', label: 'Invest. Attractiveness' },
  { key: 'geopoliticalRisk',         label: 'Geopolitical Risk' },
  { key: 'educationQuality',         label: 'Education Quality' },
  { key: 'healthcareQuality',        label: 'Healthcare Quality' },
  { key: 'technologyInvestment',     label: 'Tech Investment' },
]

const TREND_ICON: Record<string, string> = { rising: '↑', improving: '↑', stable: '→', declining: '↓' }
const TREND_COL:  Record<string, string> = { rising: '#f87171', improving: '#4ade80', stable: '#475569', declining: '#f87171' }
const CONF_COL:   Record<string, string> = { high: '#4ade80', medium: '#f59e0b', low: '#f87171' }
const SCORE_COL = (s: number) => s >= 7 ? '#22c55e' : s >= 4 ? '#f59e0b' : '#ef4444'

interface Props {
  country: Country
  compare: Country | null
}

export default function IndicatorsTab({ country: c, compare: cc }: Props) {
  const radarData = INDICATORS.map(({ key, label }) => ({
    subject: label.split(' ')[0],
    A: c.indicators[key as keyof typeof c.indicators]?.score ?? 5,
    B: cc?.indicators[key as keyof typeof cc.indicators]?.score,
  }))

  return (
    <>
      {/* Radar chart */}
      <div style={{ height: 220, minHeight: 180, flexShrink: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={radarData} margin={{ top: 10, right: 35, bottom: 10, left: 35 }}>
            <PolarGrid stroke="#23252a" />
            <PolarAngleAxis dataKey="subject" tick={{ fill: '#4a4d52', fontSize: 10 }} />
            <Radar name={c.name} dataKey="A" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.18}
              dot={{ fill: '#3b82f6', r: 2.5 }} />
            {cc && (
              <Radar name={cc.name} dataKey="B" stroke="#a78bfa" fill="#a78bfa" fillOpacity={0.12}
                dot={{ fill: '#a78bfa', r: 2.5 }} />
            )}
            <ChartTooltip
              contentStyle={{ background: '#0f1011', border: '1px solid #23252a', borderRadius: 6, fontSize: 11 }}
              labelStyle={{ color: '#62666d' }}
              itemStyle={{ color: '#8a8f98' }}
            />
          </RadarChart>
        </ResponsiveContainer>
      </div>

      {/* Compare legend */}
      {cc && (
        <div className="flex flex-wrap gap-4">
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-blue-500 flex-shrink-0" />
            <span className="text-[11px] text-text-muted break-words">{c.name}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-violet-400 flex-shrink-0" />
            <span className="text-[11px] text-text-muted break-words">{cc.name}</span>
          </div>
        </div>
      )}

      {/* Score bars */}
      <Sec label="Scores 1–10">
        <div className="flex flex-col gap-3">
          {INDICATORS.map(({ key, label }) => {
            const ind = c.indicators[key as keyof typeof c.indicators]
            if (!ind) return null
            return (
              <div key={key}>
                <div className="flex items-center justify-between mb-1.5 gap-2 min-w-0">
                  <span className="text-[11px] text-text-muted min-w-0 flex-1 break-words">{label}</span>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-[10px]" style={{ color: CONF_COL[ind.confidence] }}>{ind.confidence}</span>
                    <span className="text-[10px]" style={{ color: TREND_COL[ind.trend] }}>
                      {TREND_ICON[ind.trend]} {ind.trend}
                    </span>
                    <span className="text-[12px] font-bold tabular-nums text-text-primary w-4 text-right">
                      {ind.score}
                    </span>
                  </div>
                </div>
                <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all"
                    style={{ width: `${(ind.score / 10) * 100}%`, background: SCORE_COL(ind.score) }} />
                </div>
                {ind.note && (
                  <p className="text-[11px] text-text-faint mt-1.5 leading-snug break-words">{ind.note}</p>
                )}
              </div>
            )
          })}
        </div>
      </Sec>
    </>
  )
}
