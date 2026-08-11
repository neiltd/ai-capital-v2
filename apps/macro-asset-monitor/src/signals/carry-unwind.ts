import type { MarketAsset, CarryUnwindSignal } from '../types.js'

// Yen carry-trade unwind trip-wire (per Atlas, 2026-08-11). A carry *unwind* is a
// violent yen SPIKE that forces global deleveraging — cf. Aug 2024: BoJ surprise
// hike → USD/JPY collapsed → Nikkei -12% in a day, S&P -6% in three, VIX toward 65.
// We fire on a large daily USD/JPY move OR a VIX spike, and escalate to 'tripwire'
// only when the Nikkei confirms the risk-off — so a VIX pop from a non-yen cause
// doesn't cry wolf on its own. "Big figure" = one whole yen of USD/JPY.
const BIG_FIGURE_TRIP    = 2.0   // > 2 big figures (yen) on the day = disorderly
const BIG_FIGURE_WATCH   = 1.5
const VIX_TRIP           = 25
const VIX_WATCH          = 20
const NIKKEI_CONFIRM_PCT = -3    // Nikkei daily % that confirms a disorderly move

export function computeCarryUnwindSignal(assets: MarketAsset[]): CarryUnwindSignal {
  const jpy = assets.find(a => a.ticker === 'JPY=X')
  const vixA = assets.find(a => a.ticker === '^VIX')
  const nk  = assets.find(a => a.ticker === '^N225')

  const usdJpy       = jpy?.close ?? null
  const usdJpyMove1d = jpy ? Math.abs(jpy.change1d) : null
  const vix          = vixA?.close ?? null
  const nikkeiPct1d  = nk?.changePct1d ?? null

  const jpyTrip   = usdJpyMove1d != null && usdJpyMove1d >= BIG_FIGURE_TRIP
  const jpyWatch  = usdJpyMove1d != null && usdJpyMove1d >= BIG_FIGURE_WATCH
  const vixTrip   = vix != null && vix >= VIX_TRIP
  const vixWatch  = vix != null && vix >= VIX_WATCH
  const nkConfirm = nikkeiPct1d != null && nikkeiPct1d <= NIKKEI_CONFIRM_PCT
  const primaryFire = jpyTrip || vixTrip

  const reasons: string[] = []
  let status: CarryUnwindSignal['status']

  if (primaryFire && nkConfirm) {
    status = 'tripwire'
    if (jpyTrip) reasons.push(`USD/JPY moved ${usdJpyMove1d!.toFixed(1)} yen on the day (> ${BIG_FIGURE_TRIP} big-figure)`)
    if (vixTrip) reasons.push(`VIX ${vix!.toFixed(1)} ≥ ${VIX_TRIP}`)
    reasons.push(`Nikkei ${nikkeiPct1d!.toFixed(1)}% confirms disorderly risk-off`)
  } else if (primaryFire || jpyWatch || vixWatch || nkConfirm) {
    status = 'watch'
    if (jpyTrip)       reasons.push(`USD/JPY moved ${usdJpyMove1d!.toFixed(1)} yen (> ${BIG_FIGURE_TRIP} big-figure) — Nikkei not confirming yet`)
    else if (jpyWatch) reasons.push(`USD/JPY moved ${usdJpyMove1d!.toFixed(1)} yen (elevated)`)
    if (vixTrip)       reasons.push(`VIX ${vix!.toFixed(1)} ≥ ${VIX_TRIP} — Nikkei not confirming yet`)
    else if (vixWatch) reasons.push(`VIX ${vix!.toFixed(1)} elevated (≥ ${VIX_WATCH})`)
    if (nkConfirm)     reasons.push(`Nikkei ${nikkeiPct1d!.toFixed(1)}% risk-off`)
  } else {
    status = 'calm'
  }

  if (usdJpy == null && vix == null) reasons.push('insufficient data — USD/JPY and VIX both missing')

  return { status, usdJpy, usdJpyMove1d, vix, nikkeiPct1d, reasons }
}
