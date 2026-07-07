// /markets — Macro & Prices.
//
// Layout:
//   ┌ Regime strip: regime · confidence · rationale (expand) ───────────────┐
//   ├ Liquidity & rates / Economy tile groups                                ┤
//   ├ Benchmarks & FX tile group                                             ┤
//   ├ Energy & commodities tile group                                        ┤
//   └─────────────────────────────────────────────────────────────────────────┘
//
// Adapted from design-redesign-2026-07/screens/macro — real analysis.json's
// latestRegime.keyIndicators are full narrative sentences, not the mockup's
// assumed short deep-linkable chips, so the regime strip shows a truncated
// rationale (expand via <details>) instead of forcing prose into pills.

export const dynamic = 'force-dynamic'

import { loadMacro } from './data'
import { MacroGrid } from './macro-grid'
import { AsOf } from '@/components/next/ui'

const CONFIDENCE_TONE: Record<string, string> = {
  high: 'text-gain',
  medium: 'text-status-warning',
  low: 'text-status-serious',
}

export default function MacroPage() {
  const m = loadMacro()
  const crossed = m.indicators.filter((i) => i.crossed)

  return (
    <main className="mx-auto max-w-[1520px] space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold text-ink">Macro &amp; prices</h1>
          <p className="mt-0.5 text-[13px] text-ink-2">The numbers behind the regime call.</p>
        </div>
        <AsOf iso={m.exportedAt} />
      </header>

      {/* ------------------------------ regime strip ----------------------------- */}
      <details className="rounded-card border border-hairline bg-surface px-4 py-3">
        <summary className="flex flex-wrap cursor-pointer items-center gap-3 list-none">
          <span className="text-[14px] font-semibold text-ink">{m.regime.regime}</span>
          <span className={`text-[12px] font-medium uppercase ${CONFIDENCE_TONE[m.regime.confidence]}`}>
            {m.regime.confidence} confidence
          </span>
          <span className="ml-auto text-[12px] text-accent">rationale ▾</span>
        </summary>
        <p className="mt-2 border-t border-hairline pt-2 text-[13px] leading-5 text-ink-2">{m.regime.rationale}</p>
        <a href="/capital/briefing" className="mt-2 inline-block text-[12px] text-accent">Full briefing →</a>
      </details>

      {crossed.length > 0 && (
        <div role="alert" className="flex items-center gap-2.5 rounded-card border px-3 py-2" style={{ borderColor: '#ec835a' }}>
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
