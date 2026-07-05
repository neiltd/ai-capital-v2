'use client'

import { useState } from 'react'
import type { PortfolioPosition, AssetClass } from '@/types'
import { Card } from './ui/Card'

interface SankeyChartProps {
  positions: PortfolioPosition[]
  usdThb: number
}

interface BucketMeta {
  label: string
  hex: string
}

const BUCKET_ORDER: AssetClass[] = ['us_equity', 'th_equity', 'th_fund', 'gold', 'cash']

const BUCKETS: Record<AssetClass, BucketMeta> = {
  us_equity: { label: 'US Equities',   hex: '#a5b4fc' },
  th_equity: { label: 'Thai Equities', hex: '#4ade80' },
  th_fund:   { label: 'Asian Funds',   hex: '#fbbf24' },
  gold:      { label: 'Gold',          hex: '#fde047' },
  cash:      { label: 'Cash',          hex: '#64748b' },
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

/** Position value in USD. Cash uses `shares` as the cash amount; others use price × shares. */
function positionUsdValue(p: PortfolioPosition, usdThb: number): number {
  const cls = classOf(p)
  const cur = currencyOf(p)
  if (cls === 'cash') return toUsd(p.shares, cur, usdThb)
  const price = p.currentPrice > 0 ? p.currentPrice : p.avgCost
  return toUsd(price * p.shares, cur, usdThb)
}

/** Compact label for a position node. */
function compactLabel(ticker: string): string {
  if (ticker === 'CASH_THB') return 'Cash THB'
  if (ticker === 'CASH_USD') return 'Cash USD'
  if (ticker === 'GOLD_OZ') return 'Gold'
  // Fund names: strip the bloated -THAIESG suffix; keep the rest (including .BK) as-is.
  return ticker.replace(/-THAIESG$/i, '')
}

/** Cubic-bezier ribbon: straight on top, straight on bottom, curve on left and right edges. */
function ribbonPath(
  sx: number, sy0: number, sy1: number,
  tx: number, ty0: number, ty1: number,
): string {
  const mid = (sx + tx) / 2
  return [
    `M ${sx} ${sy0}`,
    `C ${mid} ${sy0}, ${mid} ${ty0}, ${tx} ${ty0}`,
    `L ${tx} ${ty1}`,
    `C ${mid} ${ty1}, ${mid} ${sy1}, ${sx} ${sy1}`,
    'Z',
  ].join(' ')
}

const fmtUsd = (v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`

export function SankeyChart({ positions, usdThb }: SankeyChartProps) {
  const [expanded, setExpanded] = useState(false)

  // ---- 1. Compute per-position USD value and group by class. ----
  interface Item { p: PortfolioPosition; usd: number; cls: AssetClass }
  const items: Item[] = positions
    .map(p => ({ p, usd: positionUsdValue(p, usdThb), cls: classOf(p) }))
    .filter(it => it.usd > 0)

  const byClass: Record<AssetClass, Item[]> = {
    us_equity: [], th_equity: [], th_fund: [], gold: [], cash: [],
  }
  for (const it of items) byClass[it.cls].push(it)
  // 2. Sort positions within each class descending by USD value.
  for (const k of BUCKET_ORDER) byClass[k].sort((a, b) => b.usd - a.usd)

  // 3. Compute class totals and grand total.
  const classTotals: Record<AssetClass, number> = {
    us_equity: 0, th_equity: 0, th_fund: 0, gold: 0, cash: 0,
  }
  for (const it of items) classTotals[it.cls] += it.usd
  const grandTotal = BUCKET_ORDER.reduce((s, k) => s + classTotals[k], 0)
  const activeClasses = BUCKET_ORDER.filter(c => classTotals[c] > 0)

  // ---- SVG dimensions. ----
  const WIDTH = 1100
  const positionCount = items.length
  const classCount = activeClasses.length
  const rawHeight = positionCount * 32 + classCount * 50 + 120
  const HEIGHT = Math.max(560, Math.min(1400, rawHeight))

  // ---- Layout constants. ----
  const COL0_X = 60
  const COL1_X = 380
  const COL2_X = 720
  const NODE_W = 16
  const MIN_NODE_H = 24
  const GAP = 8
  const CLASS_GAP = 16
  const TOP_Y = 60
  const HEADER_Y = 44
  const BOTTOM_RESERVED = 40 // legend strip at HEIGHT - 20

  const availableH = HEIGHT - TOP_Y - BOTTOM_RESERVED

  // Shared collapsible header used in both empty and populated states.
  const isEmpty = grandTotal === 0 || classCount === 0
  const headerMeta = isEmpty
    ? 'Portfolio → Asset Class → Position'
    : `Portfolio → Asset Class → Position · ${fmtUsd(grandTotal)} total`

  const Header = (
    <button
      type="button"
      onClick={() => setExpanded(v => !v)}
      className="w-full px-4 py-3 border-b border-border-subtle flex items-center justify-between gap-3 text-left hover:bg-bg-elevated/30 transition-colors"
      aria-expanded={expanded}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="inline-block w-1 h-3.5 bg-accent-primary/70 rounded-full flex-shrink-0" />
        <h3 className="text-[12px] font-semibold uppercase tracking-[0.12em] text-text-secondary truncate">
          Flow Diagram
        </h3>
        <span className="text-[11px] text-text-inactive">{headerMeta}</span>
      </div>
      <span
        className="text-[12px] text-text-muted flex-shrink-0 select-none"
        aria-hidden
      >
        {expanded ? '▼' : '▶'}
      </span>
    </button>
  )

  if (isEmpty) {
    return (
      <Card>
        {Header}
        {expanded && (
          <div className="p-6 text-[12px] text-text-inactive">
            No positions to display.
          </div>
        )}
      </Card>
    )
  }

  // ---- 4. Compute pxPerUsd using leftover space after minimum-height enforcement. ----
  // Total vertical gaps in col2: between positions inside each class (GAP) plus CLASS_GAP between classes.
  const col2Gaps = Math.max(0, positionCount - classCount) * GAP
    + Math.max(0, classCount - 1) * CLASS_GAP
  // Sum of minimum heights for every position node.
  const minPositionsH = positionCount * MIN_NODE_H
  // Pixels remaining for proportional sizing.
  const remainingForScale = Math.max(0, availableH - col2Gaps - minPositionsH)
  // Each USD distributes the remaining pixels (above the MIN_NODE_H floor).
  // Effective node height = MIN_NODE_H + extraPxPerUsd * usd.
  const extraPxPerUsd = grandTotal > 0 ? remainingForScale / grandTotal : 0

  // ---- 5. Layout col2 (position nodes). ----
  interface PosLayout { item: Item; y: number; h: number }
  const posLayouts: Record<string, PosLayout> = {}
  // First pass: compute heights only.
  const heightOf = (usd: number) => MIN_NODE_H + extraPxPerUsd * usd

  // ---- 6. Layout col1 (class nodes): height = sum of children heights + (childCount-1) * GAP. ----
  interface ClassLayout { c: AssetClass; y: number; h: number }
  const classLayouts: Record<string, ClassLayout> = {}
  const col1Heights: Record<string, number> = {}
  for (const c of activeClasses) {
    const group = byClass[c]
    const sumChildren = group.reduce((s, it) => s + heightOf(it.usd), 0)
    col1Heights[c] = sumChildren + Math.max(0, group.length - 1) * GAP
  }

  // ---- 7. Layout col0 (portfolio node): height = sum of class node heights + (classCount-1) * GAP. ----
  const portfolioH = activeClasses.reduce((s, c) => s + col1Heights[c], 0)
    + Math.max(0, classCount - 1) * GAP

  // Col2 total stack height (positions + intra-class GAPs + inter-class CLASS_GAPs).
  const col2TotalH = activeClasses.reduce((s, c) => {
    const group = byClass[c]
    const sumChildren = group.reduce((acc, it) => acc + heightOf(it.usd), 0)
    return s + sumChildren + Math.max(0, group.length - 1) * GAP
  }, 0) + Math.max(0, classCount - 1) * CLASS_GAP

  // ---- 8. Center each column vertically within [TOP_Y, HEIGHT - BOTTOM_RESERVED]. ----
  const portfolioY = TOP_Y + Math.max(0, (availableH - portfolioH) / 2)
  // Col1 uses the same vertical centering metric as col0 since it shares the same total height.
  const col1TotalH = portfolioH // by construction
  const col1TopY = TOP_Y + Math.max(0, (availableH - col1TotalH) / 2)
  const col2TopY = TOP_Y + Math.max(0, (availableH - col2TotalH) / 2)

  // Place col1 class nodes.
  {
    let y = col1TopY
    for (const c of activeClasses) {
      classLayouts[c] = { c, y, h: col1Heights[c] }
      y += col1Heights[c] + GAP
    }
  }

  // Place col2 position nodes.
  {
    let y = col2TopY
    for (const c of activeClasses) {
      const group = byClass[c]
      for (let i = 0; i < group.length; i++) {
        const it = group[i]
        const h = heightOf(it.usd)
        posLayouts[it.p.ticker] = { item: it, y, h }
        y += h
        if (i < group.length - 1) y += GAP
      }
      y += CLASS_GAP
    }
  }

  // ---- 9. Build ribbons (drawn before nodes so nodes sit on top). ----
  interface Ribbon { d: string; color: string; key: string }
  const ribbons: Ribbon[] = []

  // Col0 → col1 ribbons.
  // Source slice height inside the portfolio node = classTotal / grandTotal * portfolioH.
  let portfolioOutOffset = 0
  for (const c of activeClasses) {
    const cls = classLayouts[c]
    const sliceH = (classTotals[c] / grandTotal) * portfolioH
    const sx = COL0_X + NODE_W
    const sy0 = portfolioY + portfolioOutOffset
    const sy1 = sy0 + sliceH
    portfolioOutOffset += sliceH

    // Target ribbon spans the full height of the class node.
    const tx = COL1_X
    const ty0 = cls.y
    const ty1 = cls.y + cls.h

    ribbons.push({
      d: ribbonPath(sx, sy0, sy1, tx, ty0, ty1),
      color: BUCKETS[c].hex,
      key: `p-${c}`,
    })
  }

  // Col1 → col2 ribbons.
  for (const c of activeClasses) {
    const cls = classLayouts[c]
    const group = byClass[c]
    let classOutOffset = 0
    for (const it of group) {
      const pos = posLayouts[it.p.ticker]
      // Source slice height inside the class node = posUsd / classTotal * classNodeHeight.
      const sliceH = (it.usd / classTotals[c]) * cls.h
      const sx = COL1_X + NODE_W
      const sy0 = cls.y + classOutOffset
      const sy1 = sy0 + sliceH
      classOutOffset += sliceH

      // Target ribbon spans the full height of the position node.
      const tx = COL2_X
      const ty0 = pos.y
      const ty1 = pos.y + pos.h

      ribbons.push({
        d: ribbonPath(sx, sy0, sy1, tx, ty0, ty1),
        color: BUCKETS[c].hex,
        key: `c-${c}-${it.p.ticker}`,
      })
    }
  }

  // ---- Legend layout (bottom strip). ----
  const LEGEND_Y = HEIGHT - 20
  const LEGEND_SWATCH = 12
  const LEGEND_GAP_BETWEEN = 18  // gap between items
  // Compute total legend width to center it.
  const ctx = (typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null)
  if (ctx) ctx.font = '10px sans-serif'
  const legendItems = BUCKET_ORDER.map(c => ({
    c,
    label: BUCKETS[c].label,
    color: BUCKETS[c].hex,
  }))
  // Approximate label widths (avg 6.2 px per char at 10px sans-serif).
  const approxTextW = (s: string) => s.length * 6.2
  const itemWidths = legendItems.map(it => LEGEND_SWATCH + 6 + approxTextW(it.label))
  const totalLegendW = itemWidths.reduce((s, w) => s + w, 0)
    + (legendItems.length - 1) * LEGEND_GAP_BETWEEN
  let legendCursor = WIDTH / 2 - totalLegendW / 2

  return (
    <Card>
      {Header}
      {expanded && (
      <div className="p-3 overflow-x-auto">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          width="100%"
          height={HEIGHT}
          preserveAspectRatio="xMidYMid meet"
          className="block"
          style={{ maxWidth: '100%' }}
        >
          {/* Column headers */}
          <g style={{ fontSize: '10px', letterSpacing: '0.12em', fill: '#94a3b8' }}>
            <text x={COL0_X} y={HEADER_Y} textAnchor="start">PORTFOLIO</text>
            <text x={COL1_X + NODE_W / 2} y={HEADER_Y} textAnchor="middle">ASSET CLASS</text>
            <text x={COL2_X + NODE_W / 2} y={HEADER_Y} textAnchor="middle">POSITIONS</text>
          </g>

          {/* Ribbons (drawn first so nodes sit on top) */}
          <g>
            {ribbons.map(r => (
              <path
                key={r.key}
                d={r.d}
                fill={r.color}
                fillOpacity={0.2}
                stroke="none"
              />
            ))}
          </g>

          {/* Portfolio node */}
          <g>
            <rect
              x={COL0_X}
              y={portfolioY}
              width={NODE_W}
              height={portfolioH}
              fill="#94a3b8"
              opacity={0.95}
              rx={2}
            />
            <text
              x={COL0_X + NODE_W + 10}
              y={portfolioY + portfolioH / 2 - 4}
              style={{ fontSize: '12px', fontWeight: 600, fill: '#e2e8f0' }}
              dominantBaseline="middle"
            >
              Portfolio
            </text>
            <text
              x={COL0_X + NODE_W + 10}
              y={portfolioY + portfolioH / 2 + 10}
              style={{ fontSize: '10px', fill: '#94a3b8' }}
              dominantBaseline="middle"
            >
              {fmtUsd(grandTotal)}
            </text>
          </g>

          {/* Class nodes (col1) — labels to the LEFT */}
          <g>
            {activeClasses.map(c => {
              const cls = classLayouts[c]
              const pct = grandTotal > 0 ? (classTotals[c] / grandTotal) * 100 : 0
              const meta = BUCKETS[c]
              return (
                <g key={`class-${c}`}>
                  <rect
                    x={COL1_X}
                    y={cls.y}
                    width={NODE_W}
                    height={cls.h}
                    fill={meta.hex}
                    opacity={0.95}
                    rx={2}
                  />
                  <text
                    x={COL1_X - 10}
                    y={cls.y + cls.h / 2 - 6}
                    textAnchor="end"
                    style={{ fontSize: '11px', fontWeight: 600, fill: '#e2e8f0' }}
                    dominantBaseline="middle"
                  >
                    {meta.label}
                  </text>
                  <text
                    x={COL1_X - 10}
                    y={cls.y + cls.h / 2 + 6}
                    textAnchor="end"
                    style={{ fontSize: '10px', fill: '#94a3b8' }}
                    dominantBaseline="middle"
                  >
                    {`${fmtUsd(classTotals[c])} · ${pct.toFixed(0)}%`}
                  </text>
                </g>
              )
            })}
          </g>

          {/* Position nodes (col2) — labels to the RIGHT */}
          <g>
            {activeClasses.flatMap(c =>
              byClass[c].map(it => {
                const pos = posLayouts[it.p.ticker]
                const showValueLine = pos.h >= 20
                const meta = BUCKETS[c]
                const posPct = grandTotal > 0 ? (it.usd / grandTotal) * 100 : 0
                return (
                  <g key={`pos-${it.p.ticker}`}>
                    <rect
                      x={COL2_X}
                      y={pos.y}
                      width={NODE_W}
                      height={pos.h}
                      fill={meta.hex}
                      opacity={0.95}
                      rx={2}
                    />
                    <text
                      x={COL2_X + NODE_W + 10}
                      y={showValueLine ? pos.y + pos.h / 2 - 4 : pos.y + pos.h / 2}
                      style={{ fontSize: '11px', fontWeight: 600, fill: '#e2e8f0' }}
                      dominantBaseline="middle"
                    >
                      {compactLabel(it.p.ticker)}
                    </text>
                    {showValueLine && (
                      <text
                        x={COL2_X + NODE_W + 10}
                        y={pos.y + pos.h / 2 + 8}
                        style={{ fontSize: '9px', fill: '#94a3b8' }}
                        dominantBaseline="middle"
                      >
                        {`${fmtUsd(it.usd)} · ${posPct.toFixed(1)}%`}
                      </text>
                    )}
                  </g>
                )
              })
            )}
          </g>

          {/* Color legend (bottom, centered) */}
          <g>
            {legendItems.map((it, i) => {
              const itemX = legendCursor
              const swatchY = LEGEND_Y - LEGEND_SWATCH / 2 - 2
              const node = (
                <g key={`legend-${it.c}`}>
                  <rect
                    x={itemX}
                    y={swatchY}
                    width={LEGEND_SWATCH}
                    height={LEGEND_SWATCH}
                    fill={it.color}
                    rx={1}
                  />
                  <text
                    x={itemX + LEGEND_SWATCH + 6}
                    y={LEGEND_Y}
                    style={{ fontSize: '10px', fill: '#94a3b8' }}
                    dominantBaseline="middle"
                  >
                    {it.label}
                  </text>
                </g>
              )
              legendCursor += itemWidths[i] + LEGEND_GAP_BETWEEN
              return node
            })}
          </g>
        </svg>
      </div>
      )}
    </Card>
  )
}
