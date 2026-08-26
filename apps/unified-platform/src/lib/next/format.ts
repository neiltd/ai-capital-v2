// Currency / number formatting for AI Capital.
// Everything user-facing is USD-normalized; THB natives are shown as
// secondary context, never silently mixed (see design-system.md §5 `Money`).

import type { Position } from './types'

export const fmtUsd = (v: number, opts: { cents?: boolean } = {}) =>
  v.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: opts.cents ? 2 : 0,
    minimumFractionDigits: opts.cents ? 2 : 0,
  })

export const fmtThb = (v: number) =>
  '฿' + v.toLocaleString('en-US', { maximumFractionDigits: 0 })

/**
 * A THB *unit price / NAV* (per-share cost, quote, or fund NAV) with
 * magnitude-scaled precision. Thai equities (฿6–152) and fund NAVs (฿8–14)
 * are low-nominal, so whole-baht rounding hides real avg-cost↔price
 * differences (HMPRO ฿6.66 vs ฿6.65 both collapsed to "฿7"). Aggregate THB
 * position *values* (thousands of baht) still use fmtThb — cents are noise
 * there. Uses the Thai baht sign ฿ (U+0E3F), not bitcoin ₿ (U+20BF).
 */
export const fmtThbPrice = (v: number) => {
  const digits = Math.abs(v) < 1 ? 4 : 2
  return (
    '฿' +
    v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  )
}

export const fmtSignedUsd = (v: number) =>
  (v > 0 ? '+' : v < 0 ? '−' : '') + fmtUsd(Math.abs(v))

export const fmtPct = (v: number, digits = 1) =>
  (v * 100).toFixed(digits) + '%'

export const fmtSignedPct = (v: number, digits = 1) =>
  (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(digits) + '%'

export const fmtQty = (v: number) =>
  v.toLocaleString('en-US', { maximumFractionDigits: 4 })

/** Native-currency position value → USD at the pipeline's FX rate. */
export const toUsd = (p: Pick<Position, 'currentValue' | 'currency'>, usdThb: number) =>
  p.currency === 'THB' ? p.currentValue / usdThb : p.currentValue

export const pnlUsd = (p: Pick<Position, 'unrealizedPnl' | 'currency'>, usdThb: number) =>
  p.currency === 'THB' ? p.unrealizedPnl / usdThb : p.unrealizedPnl

/** Cost basis in USD (for % return on a position). */
export const costUsd = (p: Position, usdThb: number) => {
  const cost = p.avgCost * p.shares
  return p.currency === 'THB' ? cost / usdThb : cost
}

export const relTime = (iso: string, now = new Date()) => {
  const mins = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60000))
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / 1440)}d ago`
}
