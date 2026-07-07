// Tile grid. Unlike the design mockup's version, this has no click-to-expand
// detail chart — every indicator's series90d is null until the macro
// history endpoint exists (gap #18), so there is nothing yet to expand into.
// Revisit once GET /api/macro/:id?range=90d lands.

import type { IndicatorVM, IndicatorGroup } from './data'
import { Label } from '@/components/next/ui'

const GROUPS: Array<{ id: IndicatorGroup; title: string }> = [
  { id: 'liquidity', title: 'Liquidity & rates' },
  { id: 'economy', title: 'Economy' },
  { id: 'markets', title: 'Benchmarks & FX' },
  { id: 'energy', title: 'Energy & commodities' },
]

export function MacroGrid({ indicators }: { indicators: IndicatorVM[] }) {
  return (
    <div className="space-y-6">
      {GROUPS.map((g) => {
        const rows = indicators.filter((i) => i.group === g.id)
        if (rows.length === 0) return null
        return (
          <section key={g.id}>
            <Label className="mb-2">{g.title}</Label>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {rows.map((i) => <IndicatorTile key={i.id} i={i} />)}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function IndicatorTile({ i }: { i: IndicatorVM }) {
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
    <div id={i.id} className="rounded-card border border-hairline bg-surface px-4 py-3">
      <Label>{i.label}</Label>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="tnum text-[22px] font-semibold leading-7 text-ink">{i.display}</span>
        {/* Crossed tripwire replaces the delta with a status icon+label —
            the regime's tripwires made visible (never color alone). */}
        {i.crossed && i.threshold ? (
          <span className="text-[11px] font-semibold" style={{ color: '#ec835a' }}>
            ⚠ {i.threshold.kind === 'below' ? '<' : '>'} {i.threshold.level}
          </span>
        ) : i.deltaPct !== null ? (
          <span className="tnum text-[12px] text-ink-3">
            {i.deltaPct > 0 ? '+' : ''}{i.deltaPct.toFixed(1)}% {i.deltaLabel}
          </span>
        ) : null}
      </div>
      <div className="mt-1.5 text-[11px] text-ink-3">no history — gap #18</div>
      {i.footnote && <div className="mt-1 text-[11px] leading-4 text-ink-3">{i.footnote}</div>}
    </div>
  )
}
