export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { todayLocal, readSimulation, readHarvest } from '@/lib/data'
import { getRecentRuns } from '@common/pipeline-runs'

// Wash-sale chips surface automatically once the do-not-rebuy window is
// inside a week — see design-system.md's global status strip spec.
const WASH_SALE_ALERT_DAYS = 7

// The pipeline's terminal stage (packages/queue/src/jobs.ts) — its most
// recent run is the single freshness signal for "did today's pipeline work".
const FRESHNESS_STAGE = 'morning-status'
const FRESHNESS_STALE_AFTER_MS = 24 * 60 * 60 * 1000

export async function GET() {
  const root = process.env.DATA_ROOT
  if (!root) return NextResponse.json({ stale: true, reason: 'DATA_ROOT not set' })

  const today = todayLocal()
  const briefingPath = path.join(root, `investment-analyst-agents/briefings/${today}.md`)
  const stale = !fs.existsSync(briefingPath)

  let netWorthUsd: number | null = null
  let usdThb: number | null = null
  try {
    const sim = readSimulation()
    usdThb = sim.usdThb ?? null
    netWorthUsd = sim.portfolio.reduce((sum, p) => {
      if (typeof p.currentValue !== 'number') return sum
      const currency = p.currency ?? 'USD'
      if (currency === 'THB' && usdThb) return sum + p.currentValue / usdThb
      return sum + p.currentValue
    }, 0)
  } catch {
    // simulation.json missing/unparseable — leave both null, UI renders '—'
  }

  const harvest = readHarvest()
  const washSale = (harvest?.washSaleAlerts ?? [])
    .filter((a) => a.daysRemaining <= WASH_SALE_ALERT_DAYS)
    .map((a) => ({ ticker: a.ticker, daysRemaining: a.daysRemaining }))

  let freshness: { lastRunAt: string | null; ok: boolean } = { lastRunAt: null, ok: false }
  try {
    const [latest] = getRecentRuns(FRESHNESS_STAGE, 1)
    if (latest) {
      const lastRunAt = latest.endedAt ?? latest.startedAt
      const ageMs = Date.now() - new Date(lastRunAt).getTime()
      freshness = {
        lastRunAt,
        ok: latest.status === 'success' && ageMs < FRESHNESS_STALE_AFTER_MS,
      }
    }
  } catch {
    // pipeline-runs.db missing — leave freshness at the false default
  }

  return NextResponse.json({ stale, date: today, netWorthUsd, usdThb, washSale, freshness })
}
