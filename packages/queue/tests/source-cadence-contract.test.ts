import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DAILY_PIPELINE } from '../src/jobs.js'

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

describe('world-intel source bounds match the DAG cadence', () => {
  const stage = DAILY_PIPELINE.find(j => j.name === 'world-intel-pipeline')!

  it('world-intel-pipeline is a DAILY stage', () => {
    expect(stage, 'the GDELT-fetching stage disappeared').toBeTruthy()
    expect(stage.skipIf, 'stage became conditional — the daily-cadence bounds below no longer hold').toBeUndefined()
    expect(stage.cwd).toBe('apps/world-intelligence-data-hub-')
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
