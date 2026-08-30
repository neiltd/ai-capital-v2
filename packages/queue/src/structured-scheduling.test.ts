import { describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  STRUCTURED_INGESTION_SCHEDULE_ENV,
  plannedStructuredIngestion,
  submitScheduledStructuredIngestion,
} from './structured-scheduling.js'
import { DAILY_PIPELINE } from './jobs.js'
import { resolveSkips } from './submit.js'

describe('structured-ingestion scheduling', () => {
  it('is dormant by default and touches no queue, run record, fetcher, or quota path', async () => {
    const add = vi.fn()
    const recordStart = vi.fn()

    expect(plannedStructuredIngestion({})).toBeNull()
    expect(await submitScheduledStructuredIngestion({}, {
      add,
      recordStart,
      recordEnd: vi.fn(),
    })).toBeNull()
    expect(add).not.toHaveBeenCalled()
    expect(recordStart).not.toHaveBeenCalled()
  })

  it('one explicit setting plans only the independent structured job', () => {
    const env = { [STRUCTURED_INGESTION_SCHEDULE_ENV]: 'true' }
    expect(plannedStructuredIngestion(env)?.name).toBe('world-intel-pipeline')
  })

  it('11. dormant: no queue add, no run record, and therefore no fetch or quota path is reachable', async () => {
    const add = vi.fn()
    const recordStart = vi.fn()
    const recordEnd = vi.fn()
    await submitScheduledStructuredIngestion({}, { add, recordStart, recordEnd })
    // The only path from scheduling to a source fetch is the queued job; with no
    // job enqueued there is nothing that can reach a collector, and no run row
    // is opened either.
    expect(add).not.toHaveBeenCalled()
    expect(recordStart).not.toHaveBeenCalled()
    expect(recordEnd).not.toHaveBeenCalled()
  })

  it('11b. an unrelated or malformed value leaves it dormant — the flag is opt-in', async () => {
    for (const v of [undefined, '', 'false', '1', 'yes', 'TRUE ']) {
      expect(plannedStructuredIngestion({ [STRUCTURED_INGESTION_SCHEDULE_ENV]: v as string })).toBeNull()
    }
  })

  it('12. enabling submits exactly one independent structured job under its own run authority', async () => {
    const add = vi.fn().mockResolvedValue({ id: 'job-1' })
    const recordStart = vi.fn().mockReturnValue('structured-run-1')
    const env = { [STRUCTURED_INGESTION_SCHEDULE_ENV]: 'true' }

    const result = await submitScheduledStructuredIngestion(env, { add, recordStart, recordEnd: vi.fn() })

    expect(add).toHaveBeenCalledTimes(1)
    const [name, data] = add.mock.calls[0]
    expect(name).toBe('world-intel-pipeline')
    // isRoot: its own flow, not a child of the daily parent — so its failure has
    // no dependency path into the article flow.
    expect(data.isRoot).toBe(true)
    expect(data.parentRunId).toBe('structured-run-1')
    expect(result).toEqual({ parentRunId: 'structured-run-1', jobId: 'job-1' })
  })

  it('13. enabling changes scheduling only — the article topology is byte-identical', () => {
    const before = JSON.stringify(resolveSkips(DAILY_PIPELINE).map(s => [s.name, s.dependsOn ?? null]))
    process.env[STRUCTURED_INGESTION_SCHEDULE_ENV] = 'true'
    try {
      const after = JSON.stringify(resolveSkips(DAILY_PIPELINE).map(s => [s.name, s.dependsOn ?? null]))
      expect(after).toBe(before)
      // And the structured job never re-enters the daily flow.
      expect(resolveSkips(DAILY_PIPELINE).some(s => s.name === 'world-intel-pipeline')).toBe(false)
    } finally {
      delete process.env[STRUCTURED_INGESTION_SCHEDULE_ENV]
    }
  })

  it('14. the manual entrypoint survives dormancy and is independent of the flag', () => {
    const pkg = JSON.parse(readFileSync(
      resolve(__dirname, '..', '..', '..', 'apps', 'world-intelligence-data-hub-', 'package.json'), 'utf-8'))
    expect(pkg.scripts.pipeline).toBe('tsx run.ts')
    // The manual path reads no scheduling flag anywhere.
    const runSrc = readFileSync(
      resolve(__dirname, '..', '..', '..', 'apps', 'world-intelligence-data-hub-', 'run.ts'), 'utf-8')
    expect(runSrc).not.toContain(STRUCTURED_INGESTION_SCHEDULE_ENV)
  })

  it('scheduling authority: the legacy daemon refuses to start unless explicitly opted in', () => {
    const src = readFileSync(
      resolve(__dirname, '..', '..', '..', 'apps', 'world-intelligence-data-hub-', 'ingestion', 'scheduler.ts'), 'utf-8')
    expect(src).toContain("RUN_LEGACY_WORLD_INTEL_SCHEDULER !== 'true'")
    expect(src).toMatch(/Refusing to start/)
  })

  it('the source contract is DORMANT / ACTIVATION-READY, not one-flag-operational', () => {
    const runDaily = readFileSync(resolve(__dirname, '..', 'bin', 'run-daily.ts'), 'utf-8')
    // The operator line must not present the flag as sufficient on its own.
    expect(runDaily).toMatch(/structured worker installed and verified/)
    expect(runDaily).toMatch(/activation requires/i)

    // The worker exists as source plus an UNREGISTERED launchd definition.
    const plist = resolve(__dirname, '..', '..', '..', 'ops', 'launchd-proposed',
      'com.thanapol.ai-capital.structured-worker.plist')
    expect(existsSync(plist)).toBe(true)
    expect(readFileSync(plist, 'utf-8')).toMatch(/PROPOSED — NOT LOADED/)
    expect(existsSync(resolve(__dirname, '..', 'bin', 'structured-worker.ts'))).toBe(true)
  })
})
