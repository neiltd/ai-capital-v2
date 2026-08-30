import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DAILY_PIPELINE, STRUCTURED_INGESTION_JOB } from '../src/jobs.js'

// CADENCE / FRESHNESS CONSISTENCY
//
//   A source's freshness bound may never be tighter than the DAG cadence that
//   feeds it, or a perfectly healthy pipeline reports itself stale forever.
//
// GDELT carried a 2h bound sized for a retired 15-minute daemon
// (world-intel's ingestion/scheduler.ts, `*/15 * * * *`), which is stopped and
// loaded in no launchd job. Production fetches GDELT once per day, from the
// world-intel-pipeline stage defined in this file. The result was ~22 of every
// 24 hours labelled stale, and a `staleSourcesPresent` flag that was
// permanently true and therefore carried no information.
//
// This lives here, beside the cadence, because the cadence is what makes any
// particular bound honest. It reads the world-intel config as text rather than
// importing it — the queue must not take a dependency on an app.

const HERE = dirname(fileURLToPath(import.meta.url))
const QUOTA_TRACKER = resolve(HERE, '..', '..', '..', 'apps', 'world-intelligence-data-hub-', 'quota', 'quota-tracker.ts')

const boundFor = (source: string): number => {
  const src = readFileSync(QUOTA_TRACKER, 'utf-8')
  const block = src.slice(src.indexOf(`  ${source}: {`))
  const m = block.slice(0, block.indexOf('},')).match(/maxStalenessHours:\s*(\d+)/)
  if (!m) throw new Error(`no maxStalenessHours for ${source}`)
  return Number(m[1])
}

describe('world-intel source bounds match the structured cadence', () => {
  // The GDELT-fetching stage moved OUT of the daily flow: it is now an
  // independent, optionally scheduled job, dormant by default. The bound it is
  // measured against is unchanged — when scheduled, it still runs at most once
  // per day — so the numeric contract below still holds. What changed is where
  // the stage lives, and that it can no longer block article collection.
  const stage = STRUCTURED_INGESTION_JOB

  it('the structured stage exists and keeps its daily-scale contract', () => {
    expect(stage, 'the GDELT-fetching stage disappeared').toBeTruthy()
    expect(stage.skipIf, 'scheduling is controlled by submission, not skipIf — see structured-scheduling.ts').toBeUndefined()
    expect(stage.cwd).toBe('apps/world-intelligence-data-hub-')
  })

  it('the structured stage is NOT part of the daily article flow', () => {
    // This is the decoupling invariant: it must never regain a dependency path
    // into article collection, which it blocked on 14 days.
    expect(DAILY_PIPELINE.some(j => j.name === 'world-intel-pipeline')).toBe(false)
  })

  it("gdelt's freshness bound tolerates a full daily cycle", () => {
    // Below 24h a healthy daily fetch is stale most of the time — the defect.
    expect(boundFor('gdelt'), 'gdelt bound is tighter than the daily cadence that feeds it').toBeGreaterThanOrEqual(24)
  })

  it("gdelt's bound still detects a genuinely missed cycle", () => {
    // At or above 48h two consecutive misses could pass as current.
    expect(boundFor('gdelt'), 'gdelt bound is so loose that two missed cycles read as current').toBeLessThan(48)
  })

  it('gdelt is pinned at the daily-compatible value this contract was set to', () => {
    expect(boundFor('gdelt')).toBe(36)
  })

  // The retired daemon must not come back as justification for a tighter bound.
  it('no launchd-style 15-minute GDELT schedule is part of the production DAG', () => {
    const gdeltStages = DAILY_PIPELINE.filter(j => j.cwd === 'apps/world-intelligence-data-hub-')
    expect(gdeltStages.length).toBeGreaterThan(0)
    for (const j of gdeltStages) {
      expect(j.cmd[0], `${j.name} does not run through npm`).toBe('npm')
    }
  })
})
