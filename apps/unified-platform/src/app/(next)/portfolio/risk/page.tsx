// /portfolio/risk — Risk dashboard.
//
// Layout:
//   ┌ honesty banner: "priced subset $26.1K of $74.6K NW" ────────────────┐
//   ├ StatTiles: Sharpe · Vol · Max DD · 1d VaR · β ───────────────────────┤
//   ├ Concentration (weight bars, 30% line) ┬ Risk map (vol × weight)     ┤
//   ├ Correlation (pending #4)              │ Per-ticker table            ┤
//   └──────────────────────────────────────────────────────────────────────┘
//
// Design intents (design-redesign-2026-07/screens/risk):
// - The analyzed-subset caveat is a first-class banner, not a footnote —
//   this exact ambiguity produced the 7x-inflated NW bug on 2026-07-06.
// - Status colors appear ONLY on breaches (AOT > 30%); healthy rows stay
//   neutral so the one red thing on screen is the thing that matters.
// - Correlation pairs/clusters need correlation.json (backend-gaps #4 — the
//   correlation engine only emits a markdown report today). Shipped as an
//   explicit pending state rather than fabricated or scraped from markdown.

export const dynamic = 'force-dynamic'

import { loadRisk } from './data'
import { StatTile, SectionCard, AlertBanner, Th, Td } from '@/components/next/ui'
import { HBar } from '@/components/next/charts'
import { fmtUsd, fmtPct, fmtSignedPct } from '@/lib/next/format'

const CONCENTRATION_LIMIT = 0.3

export default function RiskPage() {
  const r = loadRisk()

  if (!r) {
    return (
      <main className="mx-auto max-w-[1520px] p-page-pad">
        <AlertBanner level="warning" title="Risk data unavailable" detail="risk.json not found — has today's pipeline run?" />
      </main>
    )
  }

  const breaches = r.perTicker.filter((t) => t.weight > CONCENTRATION_LIMIT)

  return (
    <main className="mx-auto max-w-[1520px] space-y-sec-gap p-page-pad">
      <header className="flex items-end justify-between">
        <h1 className="text-[20px] font-semibold text-ink">Risk</h1>
        <span className="tnum text-[12px] text-ink-3">
          {r.windowDays}d window · benchmark {r.benchmark} · FX {r.fxRateUsdThb}
        </span>
      </header>

      {/* Basis honesty — which dollars these metrics describe. */}
      <AlertBanner
        level="info"
        title={`Metrics cover the priced securities book: ${fmtUsd(r.portfolioValueUSD)}`}
        detail={
          r.totalNetWorthUsd != null
            ? `of ${fmtUsd(r.totalNetWorthUsd)} total net worth — Thai fund NAVs and cash are excluded from vol/β/VaR (no daily price series).`
            : 'Thai fund NAVs and cash are excluded from vol/β/VaR (no daily price series).'
        }
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <StatTile label="Sharpe (90d)" value={r.sharpeRatio.toFixed(2)} footnote="risk-adjusted return vs T-bill" />
        <StatTile label="Volatility (ann.)" value={fmtPct(r.portfolioVolatility)} />
        <StatTile label="Max drawdown" value={fmtPct(r.maxDrawdown)} />
        <StatTile label="1d VaR (95%)" value={fmtUsd(r.oneDayVAR95)} footnote="worst expected day, 19 of 20" />
        <StatTile label={`β vs ${r.benchmark}`} value={r.portfolioBeta.toFixed(2)} footnote="≪1 — largely uncorrelated to S&P" />
      </div>

      {breaches.map((b) => (
        <AlertBanner
          key={b.ticker}
          level="serious"
          title={`Concentration: ${b.ticker} is ${fmtPct(b.weight)} of the priced book`}
          detail={`above the ${fmtPct(CONCENTRATION_LIMIT, 0)} single-position limit`}
          trailing={<a href={`/portfolio?ticker=${b.ticker}`} className="text-[12px] text-accent">Position →</a>}
        />
      ))}

      <div className="grid grid-cols-12 gap-sec-gap">
        {/* --------------------------- concentration --------------------------- */}
        <SectionCard title="Position weights" asOf={r.generatedAt} className="col-span-12 xl:col-span-5">
          {[...r.perTicker]
            .sort((a, b) => b.weight - a.weight)
            .map((t) => (
              <HBar
                key={t.ticker}
                label={<a href={`/portfolio?ticker=${t.ticker}`} className="hover:text-accent">{t.ticker}</a>}
                value={t.weight}
                display={fmtPct(t.weight)}
                color={t.weight > CONCENTRATION_LIMIT ? '#ec835a' : 'var(--accent)'}
                threshold={CONCENTRATION_LIMIT}
              />
            ))}
          <p className="mt-2 text-[11px] leading-4 text-ink-3">
            Red tick = {fmtPct(CONCENTRATION_LIMIT, 0)} single-position limit. Bars turn amber only on breach.
          </p>
        </SectionCard>

        {/* ------------------------------ risk map ------------------------------ */}
        <SectionCard title="Risk map — volatility × weight" asOf={r.generatedAt} className="col-span-12 xl:col-span-7">
          <RiskScatter perTicker={r.perTicker} limit={CONCENTRATION_LIMIT} />
          <p className="mt-1 text-[11px] leading-4 text-ink-3">
            Top-right is where risk lives: big and volatile. Every point is labeled; hover for exact values.
          </p>
        </SectionCard>

        {/* ---------------------------- correlation ---------------------------- */}
        <SectionCard title="Correlation structure" className="col-span-12 xl:col-span-5">
          <AlertBanner
            level="info"
            title="Pairwise correlation matrix pending"
            detail="the correlation engine only emits a markdown report today (backend-gaps #4) — see the daily briefing's correlation section for the current narrative."
          />
        </SectionCard>

        {/* ------------------------------- table -------------------------------- */}
        <SectionCard title="Per-position metrics" asOf={r.generatedAt} className="col-span-12 xl:col-span-7">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Ticker</Th>
                  <Th align="right">Weight</Th>
                  <Th align="right">Vol (ann.)</Th>
                  <Th align="right">β</Th>
                  <Th align="right">Corr {r.benchmark}</Th>
                  <Th align="right">Return (90d)</Th>
                </tr>
              </thead>
              <tbody>
                {[...r.perTicker]
                  .sort((a, b) => b.weight - a.weight)
                  .map((t) => (
                    <tr key={t.ticker} className="border-b border-hairline last:border-0 hover:bg-surface-2">
                      <Td><span className="font-semibold text-ink">{t.ticker}</span></Td>
                      <Td align="right" className={t.weight > CONCENTRATION_LIMIT ? 'font-semibold text-status-serious' : ''}>
                        {fmtPct(t.weight)}
                      </Td>
                      <Td align="right" className={t.volatility > 0.5 ? 'text-status-warning' : ''}>{fmtPct(t.volatility)}</Td>
                      <Td align="right">{t.beta.toFixed(2)}</Td>
                      <Td align="right">{t.correlation.toFixed(2)}</Td>
                      <Td align="right">
                        <span className={t.totalReturn > 0 ? 'text-gain' : t.totalReturn < 0 ? 'text-loss' : 'text-ink-3'}>
                          {fmtSignedPct(t.totalReturn)}
                        </span>
                      </Td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      </div>
    </main>
  )
}

/* ------------------------- vol × weight scatter (SVG) ------------------------ */

function RiskScatter({
  perTicker,
  limit,
}: {
  perTicker: Array<{ ticker: string; weight: number; volatility: number }>
  limit: number
}) {
  const W = 620, H = 300, PAD = { l: 44, r: 16, t: 12, b: 32 }
  const maxVol = Math.max(...perTicker.map((t) => t.volatility)) * 1.1
  const maxW = Math.max(limit * 1.2, Math.max(...perTicker.map((t) => t.weight)) * 1.1)
  const x = (vol: number) => PAD.l + (vol / maxVol) * (W - PAD.l - PAD.r)
  const y = (wt: number) => H - PAD.b - (wt / maxW) * (H - PAD.t - PAD.b)

  return (
    <div className="overflow-x-auto">
      <svg width={W} height={H} role="img" aria-label="Scatter of position volatility versus portfolio weight" className="max-w-full">
        {/* recessive grid + single pair of axes */}
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={PAD.l} x2={W - PAD.r} y1={y(maxW * f)} y2={y(maxW * f)} stroke="var(--grid)" strokeWidth={1} />
        ))}
        <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="var(--ink-3)" strokeWidth={1} />
        <line x1={PAD.l} x2={PAD.l} y1={PAD.t} y2={y(0)} stroke="var(--ink-3)" strokeWidth={1} />
        {/* concentration limit line */}
        <line x1={PAD.l} x2={W - PAD.r} y1={y(limit)} y2={y(limit)} stroke="#ec835a" strokeWidth={1} strokeDasharray="4 4" />
        <text x={W - PAD.r} y={y(limit) - 4} textAnchor="end" fontSize={10} fill="#ec835a">
          {Math.round(limit * 100)}% limit
        </text>
        {/* axis labels */}
        <text x={(PAD.l + W - PAD.r) / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--ink-3)">
          annualized volatility →
        </text>
        <text x={12} y={(PAD.t + H - PAD.b) / 2} fontSize={11} fill="var(--ink-3)" transform={`rotate(-90 12 ${(PAD.t + H - PAD.b) / 2})`} textAnchor="middle">
          weight →
        </text>
        {[0.25, 0.5, 0.75].map((f) => (
          <text key={f} x={x(maxVol * f)} y={H - PAD.b + 14} textAnchor="middle" fontSize={10} fill="var(--ink-3)" className="tnum">
            {Math.round(maxVol * f * 100)}%
          </text>
        ))}
        {/* marks: ≥8px targets, 2px surface ring, every point direct-labeled */}
        {perTicker.map((t) => (
          <g key={t.ticker}>
            <circle
              cx={x(t.volatility)}
              cy={y(t.weight)}
              r={5}
              fill={t.weight > limit ? '#ec835a' : 'var(--accent)'}
              stroke="var(--surface)"
              strokeWidth={2}
            >
              <title>{`${t.ticker} — vol ${(t.volatility * 100).toFixed(1)}%, weight ${(t.weight * 100).toFixed(1)}%`}</title>
            </circle>
            <text x={x(t.volatility) + 8} y={y(t.weight) + 3.5} fontSize={11} fill="var(--ink-2)">
              {t.ticker}
            </text>
          </g>
        ))}
      </svg>
    </div>
  )
}
