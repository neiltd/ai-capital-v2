// /markets — Macro & Prices. (Supersedes screens/specs/macro-markets.md.)
//
// Layout:
//   ┌ Regime strip: regime · confidence · key-indicator chips (→ tiles) ───┐
//   ├ Liquidity & rates tile group                                          ┤
//   ├ Benchmarks & FX tile group        (tile click → full-width detail)    ┤
//   ├ Energy & commodities tile group                                       ┤
//   └─────────────────────────────────────────────────────────────────────────┘
//
// Design intents:
// - The tile grid IS the screen. Each indicator: current value, Δ30d,
//   90d sparkline (ink-3 — informational, never moralized with gain/loss).
// - Briefing tripwires (VIX>20, 10Y>4.7, sentiment<45, WTI>100) render as
//   dashed reference lines on detail charts AND flip the tile's delta to a
//   status icon+label when crossed — sentiment 44.8 demonstrates the
//   crossed state live.
// - Regime strip ties numbers to narrative: same keyIndicator chips as
//   /today, each deep-linking to its tile.

import { loadMacro } from './data'
import { MacroGrid } from './macro-grid'
import { AsOf } from '../_shared/ui'

const CONFIDENCE_TONE: Record<string, string> = {
  high: 'text-gain',
  medium: 'text-status-warning',
  low: 'text-status-serious',
}

export default async function MacroPage() {
  const m = await loadMacro()
  const crossed = m.indicators.filter((i) => i.crossed)

  return (
    <main className="mx-auto max-w-[1520px] space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold text-ink">Macro &amp; prices</h1>
          <p className="mt-0.5 text-[13px] text-ink-2">
            The numbers behind the regime call. Click any tile for history + tripwire lines.
          </p>
        </div>
        <AsOf iso={m.exportedAt} />
      </header>

      {/* ------------------------------ regime strip ----------------------------- */}
      <div className="flex flex-wrap items-center gap-3 rounded-card border border-hairline bg-surface px-4 py-3">
        <span className="text-[14px] font-semibold text-ink">{m.regime.regime}</span>
        <span className={`text-[12px] font-medium uppercase ${CONFIDENCE_TONE[m.regime.confidence]}`}>
          {m.regime.confidence} confidence
        </span>
        <span className="hidden text-ink-3 sm:inline">·</span>
        {m.regime.keyIndicators.map((k) => (
          <a
            key={k.label}
            href={k.indicatorId ? `#${k.indicatorId}` : '/today'}
            className="tnum rounded-chip bg-surface-2 px-2 py-0.5 text-[11px] text-ink-3 hover:text-accent"
          >
            {k.label}
          </a>
        ))}
        <a href="/today" className="ml-auto text-[12px] text-accent">Briefing →</a>
      </div>

      {crossed.length > 0 && (
        <div
          role="alert"
          className="flex items-center gap-2.5 rounded-card border px-3 py-2"
          style={{ borderColor: '#ec835a' }}
        >
          <span aria-hidden style={{ color: '#ec835a' }}>⚠</span>
          <span className="text-[13px] text-ink">
            <b>{crossed.length} tripwire{crossed.length > 1 ? 's' : ''} crossed:</b>{' '}
            {crossed.map((i) => `${i.label} ${i.display} (${i.threshold!.label.replace('briefing tripwire: ', '')})`).join(' · ')}
            <span className="ml-2 text-ink-3">— the briefing watches the same levels.</span>
          </span>
        </div>
      )}

      <MacroGrid indicators={m.indicators} />
    </main>
  )
}
