import type { PortfolioPosition, AssetClass } from '@/types'
import { Card, CardHeader } from './ui/Card'
import { Badge } from './ui/Badge'

interface AllSeasonGapProps {
  positions: PortfolioPosition[]
  usdThb: number
}

/** Ray Dalio All Weather target weights (in percent of total portfolio). */
const TARGETS = {
  equities:    30,
  longBonds:   40,
  midBonds:    15,
  gold:         7.5,
  cashAlts:     7.5,
} as const

type Bucket = 'equities' | 'longBonds' | 'midBonds' | 'gold' | 'cashAlts'

interface Row {
  key: Bucket
  category: string
  target: number
  current: number
  /** Tickers contributing to this bucket (largest first). */
  contributors: { ticker: string; pct: number }[]
  action: string
  actionTone: 'success' | 'warning' | 'danger' | 'neutral'
  instruments?: string
}

function classOf(p: PortfolioPosition): AssetClass {
  return p.assetClass ?? 'us_equity'
}

function currencyOf(p: PortfolioPosition): 'USD' | 'THB' {
  return p.currency ?? 'USD'
}

function toUsd(amount: number, currency: 'USD' | 'THB', usdThb: number): number {
  if (currency === 'USD') return amount
  if (!usdThb || usdThb <= 0) return 0
  return amount / usdThb
}

function positionUsdValue(p: PortfolioPosition, usdThb: number): number {
  const cls = classOf(p)
  const cur = currencyOf(p)
  if (cls === 'cash') return toUsd(p.shares, cur, usdThb)
  const price = p.currentPrice > 0 ? p.currentPrice : p.avgCost
  return toUsd(price * p.shares, cur, usdThb)
}

/** Map this portfolio's asset classes to All Weather buckets. */
function bucketOf(cls: AssetClass): Bucket {
  switch (cls) {
    case 'us_equity':
    case 'th_equity':
    case 'th_fund':
      return 'equities'
    case 'gold':
      return 'gold'
    case 'cash':
      return 'cashAlts'
  }
}

export function AllSeasonGap({ positions, usdThb }: AllSeasonGapProps) {
  // Total USD and per-bucket USD totals.
  const totalUsd = positions.reduce((s, p) => s + positionUsdValue(p, usdThb), 0)

  const bucketTotals: Record<Bucket, number> = {
    equities: 0, longBonds: 0, midBonds: 0, gold: 0, cashAlts: 0,
  }
  // Track per-position contribution so we can call out biggest equity holdings.
  const bucketPositions: Record<Bucket, { ticker: string; usd: number }[]> = {
    equities: [], longBonds: [], midBonds: [], gold: [], cashAlts: [],
  }
  for (const p of positions) {
    const usd = positionUsdValue(p, usdThb)
    const b = bucketOf(classOf(p))
    bucketTotals[b] += usd
    bucketPositions[b].push({ ticker: p.ticker, usd })
  }

  function pctOf(usd: number): number {
    return totalUsd > 0 ? (usd / totalUsd) * 100 : 0
  }

  const equitiesPct = pctOf(bucketTotals.equities)
  const goldPct     = pctOf(bucketTotals.gold)
  const cashPct     = pctOf(bucketTotals.cashAlts)

  // Build the gap rows. Action tone follows directional gap (negative = need to add, etc.).
  const rows: Row[] = [
    {
      key: 'equities',
      category: 'Equities (Global)',
      target: TARGETS.equities,
      current: equitiesPct,
      contributors: bucketPositions.equities
        .sort((a, b) => b.usd - a.usd)
        .slice(0, 3)
        .map(c => ({ ticker: c.ticker, pct: pctOf(c.usd) })),
      action: equitiesPct > TARGETS.equities + 2 ? 'Trim'
            : equitiesPct < TARGETS.equities - 2 ? 'Add'
            : 'Hold',
      actionTone: equitiesPct > TARGETS.equities + 2 ? 'warning'
                : equitiesPct < TARGETS.equities - 2 ? 'success'
                : 'neutral',
    },
    {
      key: 'longBonds',
      category: 'Long-term Bonds',
      target: TARGETS.longBonds,
      current: pctOf(bucketTotals.longBonds),
      contributors: [],
      action: 'Add',
      actionTone: 'success',
      instruments: 'TLT, EDV',
    },
    {
      key: 'midBonds',
      category: 'Mid-term Bonds',
      target: TARGETS.midBonds,
      current: pctOf(bucketTotals.midBonds),
      contributors: [],
      action: 'Add',
      actionTone: 'success',
      instruments: 'IEI, VGIT',
    },
    {
      key: 'gold',
      category: 'Gold',
      target: TARGETS.gold,
      current: goldPct,
      contributors: bucketPositions.gold
        .sort((a, b) => b.usd - a.usd)
        .slice(0, 2)
        .map(c => ({ ticker: c.ticker, pct: pctOf(c.usd) })),
      action: goldPct > TARGETS.gold + 1.5 ? 'Trim'
            : goldPct < TARGETS.gold - 1.5 ? 'Add'
            : 'Hold',
      actionTone: goldPct > TARGETS.gold + 1.5 ? 'warning'
                : goldPct < TARGETS.gold - 1.5 ? 'success'
                : 'neutral',
      instruments: 'GLD, GOLD_MTS',
    },
    {
      key: 'cashAlts',
      category: 'Cash / Alts',
      target: TARGETS.cashAlts,
      current: cashPct,
      contributors: bucketPositions.cashAlts
        .sort((a, b) => b.usd - a.usd)
        .slice(0, 2)
        .map(c => ({ ticker: c.ticker, pct: pctOf(c.usd) })),
      action: cashPct > TARGETS.cashAlts + 2 ? 'Reallocate'
            : cashPct < TARGETS.cashAlts - 2 ? 'Add'
            : 'Hold',
      actionTone: cashPct > TARGETS.cashAlts + 2 ? 'warning'
                : cashPct < TARGETS.cashAlts - 2 ? 'success'
                : 'neutral',
      instruments: 'DBC, PDBC (commodities)',
    },
  ]

  // Build plain-English rebalancing notes.
  const notes: string[] = []
  if (equitiesPct > TARGETS.equities) {
    const over = equitiesPct - TARGETS.equities
    const top = rows[0].contributors.map(c => c.ticker).slice(0, 3).join(', ')
    notes.push(
      `You are ${over.toFixed(1)}% overweight equities${top ? ` (largest: ${top})` : ''}. ` +
      `Consider trimming into bond exposure before the cycle turns.`
    )
  } else if (equitiesPct < TARGETS.equities - 2) {
    notes.push(
      `Equities are ${(TARGETS.equities - equitiesPct).toFixed(1)}% under target. ` +
      `Add broad index exposure (VT, VTI) if your conviction supports it.`
    )
  }

  if (bucketTotals.longBonds === 0 && bucketTotals.midBonds === 0) {
    notes.push(
      `You have no bond exposure (target: ${TARGETS.longBonds + TARGETS.midBonds}%). ` +
      `TLT (20yr) and IEF (7-10yr) are the classic All Weather instruments — long bonds carry the deflation hedge.`
    )
  } else if (bucketTotals.longBonds === 0) {
    notes.push(
      `Long-term bonds are missing (target: ${TARGETS.longBonds}%). ` +
      `TLT or EDV provide the duration the All Weather model relies on for deflation/recession regimes.`
    )
  }

  if (goldPct < TARGETS.gold - 1.5) {
    notes.push(
      `Gold is ${(TARGETS.gold - goldPct).toFixed(1)}% underweight. ` +
      `GOLD_MTS (THB futures) or GLD (USD ETF) can close the gap.`
    )
  } else if (goldPct > TARGETS.gold + 2.5) {
    notes.push(
      `Gold is ${(goldPct - TARGETS.gold).toFixed(1)}% overweight. ` +
      `Reasonable in a late-cycle stance, but the canonical All Weather weight is ${TARGETS.gold}%.`
    )
  }

  if (cashPct > TARGETS.cashAlts + 5) {
    notes.push(
      `Cash is ${(cashPct - TARGETS.cashAlts).toFixed(1)}% over its placeholder target. ` +
      `Cash is acting as the commodity sleeve here — diversified commodities (DBC, PDBC) would complete the model.`
    )
  }

  const fmtPct = (v: number) => `${v.toFixed(1)}%`
  const fmtGap = (target: number, current: number) => {
    const gap = current - target
    const sign = gap >= 0 ? '+' : ''
    return `${sign}${gap.toFixed(1)}%`
  }

  return (
    <Card>
      <CardHeader
        title="All-Season Gap Analysis"
        meta="Ray Dalio All Weather target · current portfolio"
      />

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-bg-subtle border-b border-border-subtle">
              <th className="px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive">Category</th>
              <th className="px-4 py-2.5 text-right text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive">Target</th>
              <th className="px-4 py-2.5 text-right text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive">Current</th>
              <th className="px-4 py-2.5 text-right text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive">Gap</th>
              <th className="px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive">Distance</th>
              <th className="px-4 py-2.5 text-right text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => {
              const gap = row.current - row.target
              const gapAbs = Math.abs(gap)
              // Distance bar: bar width = how far off target, max 50% of the row.
              const distancePct = Math.min((gapAbs / Math.max(row.target, 10)) * 100, 100)
              const barColor = gap >= 0 ? '#fbbf24' : '#60a5fa'  // amber if overweight, blue if underweight
              const gapColor = gapAbs <= 1.5 ? 'text-text-secondary'
                             : gap > 0 ? 'text-amber-signal'
                             : 'text-blue-signal'

              return (
                <tr
                  key={row.key}
                  className={`border-b border-border-subtle last:border-0 ${idx % 2 === 1 ? 'bg-bg-row-alt/30' : ''}`}
                >
                  <td className="px-4 py-3 text-[12px]">
                    <div className="text-text-primary font-medium">{row.category}</div>
                    {row.instruments && (
                      <div className="text-[10px] text-text-faint mt-0.5">{row.instruments}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-[12px] text-text-secondary text-right tabular-nums">
                    {fmtPct(row.target)}
                  </td>
                  <td className="px-4 py-3 text-[12px] text-text-secondary text-right tabular-nums">
                    {fmtPct(row.current)}
                  </td>
                  <td className={`px-4 py-3 text-[12px] text-right font-semibold tabular-nums ${gapColor}`}>
                    {fmtGap(row.target, row.current)}
                  </td>
                  <td className="px-4 py-3 w-[160px]">
                    <div className="h-1.5 bg-bg-elevated rounded-sm overflow-hidden border border-border-subtle">
                      <div
                        className="h-full rounded-sm"
                        style={{
                          width: `${distancePct}%`,
                          backgroundColor: barColor,
                          opacity: 0.8,
                        }}
                      />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Badge tone={row.actionTone} size="sm">{row.action}</Badge>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {notes.length > 0 && (
        <div className="border-t border-border-subtle px-4 py-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-inactive mb-2.5">
            Rebalancing Actions
          </div>
          <ul className="space-y-2">
            {notes.map((note, i) => (
              <li key={i} className="flex gap-2 text-[12px] text-text-secondary leading-relaxed">
                <span className="text-indigo-active flex-shrink-0">→</span>
                <span>{note}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}
