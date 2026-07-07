// /portfolio/tax — Tax & Harvesting.
// Spec: design-redesign-2026-07/screens/specs/tax.md (no mockup existed to
// port — built directly from the spec + real harvest.json).
//
// Layout (12-col):
//   ┌ StatTiles: YTD gains · YTD losses · Net taxable (hero) · Harvestable now ┐
//   ├ Wash-sale windows (full width, AlertBanners w/ countdown)                ┤
//   ├ Harvest opportunities table (8)          │ Jurisdiction explainer (4)    ┤
//   └───────────────────────────────────────────────────────────────────────────┘
//
// "Plan harvest" mutation dialog (spec) is deferred — it needs the user's
// marginal Thai PIT bracket, which "currently nowhere in the system" per the
// spec's own backend-gaps note. Shipping read-only rather than a dialog that
// can't compute real offset math.

export const dynamic = 'force-dynamic'

import { loadHarvest, harvestableNowUsd } from './data'
import { StatTile, SectionCard, AlertBanner, Th, Td, JurisdictionTag, StrategyTag } from '@/components/next/ui'
import { fmtUsd, fmtThb } from '@/lib/next/format'

const WASH_SALE_CRITICAL_DAYS = 2

const JURISDICTION_LEGEND: Array<{ j: string; label: string; note: string }> = [
  { j: 'thai-exempt', label: 'TH exempt', note: 'SET equity — gains/losses invisible to Thai tax; harvesting provides no cash benefit.' },
  { j: 'thai-taxable', label: 'TH taxable', note: 'Thai funds — realized losses offset fund gains within the same tax year.' },
  { j: 'us-taxable', label: 'US taxable', note: 'US equity — standard capital-gains rules; wash-sale rules apply on rebuy.' },
  { j: 'tax-locked', label: 'locked', note: 'THAIESG / PFM009 — locked for tax benefit eligibility; never sell.' },
]

export default function TaxPage() {
  const h = loadHarvest()

  if (!h) {
    return (
      <main className="mx-auto max-w-[1520px] p-6">
        <AlertBanner level="warning" title="Tax data unavailable" detail="harvest.json not found — has today's pipeline run?" />
      </main>
    )
  }

  const harvestableNow = harvestableNowUsd(h)
  const sortedOpportunities = [...h.harvestOpportunities].sort((a, b) => {
    if (a.harvestable !== b.harvestable) return a.harvestable ? -1 : 1
    return Math.abs(b.unrealizedLossUSD) - Math.abs(a.unrealizedLossUSD)
  })

  return (
    <main className="mx-auto max-w-[1520px] space-y-6 p-6">
      <header className="flex items-end justify-between">
        <h1 className="text-[20px] font-semibold text-ink">Tax &amp; Harvesting</h1>
        <span className="tnum text-[12px] text-ink-3">FX {h.fxRateUsdThb}</span>
      </header>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile label="YTD realized gains" value={fmtUsd(h.realizedYTD.gainsUSD)} />
        <StatTile
          label="YTD realized losses"
          value={fmtUsd(h.realizedYTD.lossesUSD)}
          footnote="removed positions may under-count losses — avg_cost lost at removal (gap #14)"
        />
        <StatTile label="Net taxable" value={fmtUsd(h.realizedYTD.netTaxableUSD)} hero footnote={`${h.realizedYTD.trades} trades YTD`} />
        <StatTile
          label="Harvestable now"
          value={fmtUsd(harvestableNow)}
          footnote="excludes Thai-exempt, tax-locked, wash-sale-blocked"
        />
      </div>

      {h.washSaleAlerts.length > 0 && (
        <div className="space-y-2">
          {h.washSaleAlerts.map((w, i) => (
            <AlertBanner
              key={`${w.ticker}-${w.soldAt}-${i}`}
              level={w.daysRemaining <= WASH_SALE_CRITICAL_DAYS ? 'critical' : 'warning'}
              title={`${w.ticker} — do not rebuy before ${w.doNotRebuyBefore}`}
              detail={`sold ${w.soldShares} sh at ${fmtUsd(w.soldPrice)} on ${w.soldAt}`}
              trailing={<span className="tnum text-[12px] font-semibold text-ink">{w.daysRemaining}d</span>}
            />
          ))}
        </div>
      )}

      <div className="grid grid-cols-12 gap-6">
        {/* ------------------------- harvest opportunities ----------------------- */}
        <SectionCard title="Harvest opportunities" asOf={h.generatedAt} className="col-span-12 xl:col-span-8">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Ticker</Th>
                  <Th>Jurisdiction</Th>
                  <Th>Strategy</Th>
                  <Th align="right">Unrealized loss</Th>
                  <Th align="right">Harvestable</Th>
                </tr>
              </thead>
              <tbody>
                {sortedOpportunities.map((o) => (
                  <tr key={o.ticker} className="border-b border-hairline last:border-0 hover:bg-surface-2">
                    <Td><span className="font-semibold text-ink">{o.ticker}</span></Td>
                    <Td><JurisdictionTag j={o.taxJurisdiction} /></Td>
                    <Td><StrategyTag strategy={o.strategy} /></Td>
                    <Td align="right" className={o.harvestable ? 'font-medium text-loss' : 'text-ink-3'}>
                      {fmtUsd(o.unrealizedLossUSD)}
                      {o.currency === 'THB' && (
                        <span className="ml-1.5 text-[11px] text-ink-3">{fmtThb(o.unrealizedLoss)}</span>
                      )}
                    </Td>
                    <Td align="right">
                      {o.harvestable ? (
                        <span className="text-gain">✓</span>
                      ) : (
                        <span className="text-ink-3" title={o.washSaleRisk ? 'wash-sale blocked' : undefined}>✗</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 space-y-2">
            {sortedOpportunities.map((o) => (
              <details key={`notes-${o.ticker}`} className="rounded-chip bg-surface-2 px-2.5 py-1.5 text-[12px]">
                <summary className="cursor-pointer text-ink-3">{o.ticker} — notes</summary>
                <p className="mt-1 leading-4 text-ink-2">{o.notes}</p>
              </details>
            ))}
          </div>
        </SectionCard>

        {/* --------------------------- jurisdiction legend ------------------------ */}
        <SectionCard title="Jurisdiction rules" className="col-span-12 xl:col-span-4">
          <ul className="space-y-3">
            {JURISDICTION_LEGEND.map((row) => (
              <li key={row.j} className="flex items-start gap-2">
                <JurisdictionTag j={row.j} />
                <p className="text-[12px] leading-4 text-ink-3">{row.note}</p>
              </li>
            ))}
          </ul>
        </SectionCard>
      </div>
    </main>
  )
}
