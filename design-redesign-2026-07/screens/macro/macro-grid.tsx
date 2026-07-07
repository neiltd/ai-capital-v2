'use client'

// Tile grid + full-width detail chart. Client component: tile click selects
// an indicator; the detail chart expands below its group. One indicator at a
// time — comparison across units uses small multiples, never dual axes.

import { useState } from 'react'
import type { IndicatorVM, IndicatorGroup } from './data'
import { Label } from '../_shared/ui'
import { Sparkline } from '../_shared/charts'

const GROUPS: Array<{ id: IndicatorGroup; title: string }> = [
  { id: 'liquidity', title: 'Liquidity & rates' },
  { id: 'markets', title: 'Benchmarks & FX' },
  { id: 'energy', title: 'Energy & commodities' },
]

export function MacroGrid({ indicators, initial }: { indicators: IndicatorVM[]; initial?: string }) {
  const [selectedId, setSelectedId] = useState<string | null>(initial ?? null)
  const selected = indicators.find((i) => i.id === selectedId) ?? null

  return (
    <div className="space-y-6">
      {GROUPS.map((g) => {
        const rows = indicators.filter((i) => i.group === g.id)
        return (
          <section key={g.id}>
            <Label className="mb-2">{g.title}</Label>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {rows.map((i) => (
                <IndicatorTile
                  key={i.id}
                  i={i}
                  selected={i.id === selectedId}
                  onClick={() => setSelectedId(i.id === selectedId ? null : i.id)}
                />
              ))}
            </div>
            {selected && selected.group === g.id && <DetailChart i={selected} />}
          </section>
        )
      })}
    </div>
  )
}

function IndicatorTile({
  i,
  selected,
  onClick,
}: {
  i: IndicatorVM
  selected: boolean
  onClick: () => void
}) {
  if (i.gap) {
    return (
      <div id={i.id} className="rounded-card border border-dashed border-hairline px-4 py-3">
        <Label>{i.label}</Label>
        <div className="mt-1 text-[22px] font-semibold leading-7 text-ink-3">—</div>
        <div className="mt-1 text-[11px] leading-4 text-ink-3">{i.gap}</div>
      </div>
    )
  }
  return (
    <button
      id={i.id}
      onClick={onClick}
      className={`rounded-card border bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-2 ${
        selected ? 'border-accent' : 'border-hairline'
      }`}
      aria-expanded={selected}
    >
      <Label>{i.label}</Label>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="tnum text-[22px] font-semibold leading-7 text-ink">{i.display}</span>
        {/* Crossed tripwire replaces the delta with a status icon+label —
            the regime's tripwires made visible (never color alone). */}
        {i.crossed && i.threshold ? (
          <span className="text-[11px] font-semibold" style={{ color: '#ec835a' }}>
            ⚠ {i.threshold.kind === 'below' ? '<' : '>'} {i.threshold.level}
          </span>
        ) : i.delta30d !== null ? (
          <span className="tnum text-[12px] text-ink-3">
            {i.delta30d > 0 ? '+' : ''}{(i.delta30d * 100).toFixed(1)}% 30d
          </span>
        ) : null}
      </div>
      <div className="mt-1.5">
        {/* Sparklines stay ink-3 (informational) — gain/loss color on a rate
            chart would falsely moralize it. */}
        {i.series90d ? <Sparkline points={i.series90d} width={120} height={26} /> : <span className="text-[11px] text-ink-3">no history — gap #18</span>}
      </div>
      {i.footnote && <div className="mt-1 text-[11px] leading-4 text-ink-3">{i.footnote}</div>}
    </button>
  )
}

/* ----------------------------- detail chart ------------------------------ */

const RANGES = ['30d', '90d', '1y', '5y'] as const

function DetailChart({ i }: { i: IndicatorVM }) {
  const [range, setRange] = useState<(typeof RANGES)[number]>('90d')
  const [asTable, setAsTable] = useState(false)
  if (!i.series90d) return null
  const pts = range === '30d' ? i.series90d.slice(-5) : i.series90d // sample data: weekly-ish points

  return (
    <div className="mt-4 rounded-card border border-hairline bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[15px] font-semibold text-ink">{i.label}</h3>
        {i.threshold && (
          <span className="text-[11px] text-ink-3">{i.threshold.label}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              disabled={r === '1y' || r === '5y'}
              title={r === '1y' || r === '5y' ? 'needs the macro history endpoint (gap #18)' : undefined}
              className={`rounded-chip px-2 py-0.5 text-[12px] ${
                range === r ? 'bg-surface-2 font-medium text-ink' : 'text-ink-3 hover:text-ink-2'
              } disabled:opacity-40`}
            >
              {r}
            </button>
          ))}
          <button
            onClick={() => setAsTable((v) => !v)}
            className="ml-2 rounded-chip border border-hairline px-2 py-0.5 text-[12px] text-ink-2 hover:bg-surface-2"
          >
            {asTable ? 'view as chart' : 'view as table'}
          </button>
        </div>
      </div>

      {asTable ? (
        <table className="mt-3 w-full max-w-md border-collapse">
          <tbody>
            {pts.map((v, idx) => (
              <tr key={idx} className="border-b border-hairline last:border-0">
                <td className="py-1 text-[12px] text-ink-3">t−{pts.length - 1 - idx}w</td>
                <td className="tnum py-1 text-right text-[12px] text-ink-2">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Line points={pts} threshold={i.threshold?.level} thresholdLabel={i.threshold?.label} />
      )}
      <p className="mt-2 text-[11px] leading-4 text-ink-3">
        Series shape is illustrative — snapshots only until the macro history endpoint lands
        (gap #18). Real chart: crosshair + tooltip per the dataviz interaction rules.
      </p>
    </div>
  )
}

function Line({ points, threshold, thresholdLabel }: { points: number[]; threshold?: number; thresholdLabel?: string }) {
  const W = 860, H = 220, PAD = { l: 48, r: 12, t: 12, b: 24 }
  const all = threshold !== undefined ? [...points, threshold] : points
  const min = Math.min(...all), max = Math.max(...all)
  const span = max - min || 1
  const x = (idx: number) => PAD.l + (idx / (points.length - 1)) * (W - PAD.l - PAD.r)
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - (v - min) / span)
  const d = points.map((v, idx) => `${idx === 0 ? 'M' : 'L'}${x(idx).toFixed(1)},${y(v).toFixed(1)}`).join(' ')

  return (
    <div className="overflow-x-auto">
      <svg width={W} height={H} role="img" aria-label="Indicator history" className="max-w-full">
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={PAD.l} x2={W - PAD.r} y1={y(min + span * f)} y2={y(min + span * f)} stroke="var(--grid)" strokeWidth={1} />
        ))}
        <line x1={PAD.l} x2={W - PAD.r} y1={y(min)} y2={y(min)} stroke="var(--ink-3)" strokeWidth={1} />
        {[0, 0.5, 1].map((f) => (
          <text key={f} x={PAD.l - 6} y={y(min + span * f) + 3.5} textAnchor="end" fontSize={10} fill="var(--ink-3)" className="tnum">
            {(min + span * f).toFixed(span < 10 ? 2 : 0)}
          </text>
        ))}
        {threshold !== undefined && (
          <g>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(threshold)} y2={y(threshold)} stroke="#ec835a" strokeWidth={1} strokeDasharray="4 4" />
            <text x={W - PAD.r} y={y(threshold) - 4} textAnchor="end" fontSize={10} fill="#ec835a">
              {thresholdLabel ?? threshold}
            </text>
          </g>
        )}
        <path d={d} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {points.map((v, idx) => (
          <circle key={idx} cx={x(idx)} cy={y(v)} r={points.length - 1 === idx ? 3 : 6} fill={points.length - 1 === idx ? 'var(--accent)' : 'transparent'}>
            <title>{`t−${points.length - 1 - idx}w: ${v}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  )
}
