import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decideIsolation, requireIsolation, PartialIsolationError } from '../src/isolation.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = '/Users/thanapold/Desktop/Projects.nosync'
const ISO = { REDIS_URL: 'redis://127.0.0.1:6399', PIPELINE_RUNS_DB: '/tmp/iso/runs.db', AI_CAPITAL_ROOT: '/tmp/iso' }
const PROD = { REDIS_URL: 'redis://localhost:6379', PIPELINE_RUNS_DB: `${REPO}/data/pipeline-runs.db`, AI_CAPITAL_ROOT: REPO }

describe('all-or-nothing isolation', () => {
  it('fully isolated is `isolated`', async () => {
    const d = await decideIsolation(ISO as NodeJS.ProcessEnv)
    expect(d.mode).toBe('isolated')
    expect(d.notificationsDisabled).toBe(true)
  })

  it('fully production is `production`', async () => {
    expect((await decideIsolation(PROD as NodeJS.ProcessEnv)).mode).toBe('production')
  })

  it('PARTIAL isolation is REFUSED — every combination', async () => {
    const dims: Array<keyof typeof ISO> = ['REDIS_URL', 'PIPELINE_RUNS_DB', 'AI_CAPITAL_ROOT']
    for (const d of dims) {
      // one isolated, two production
      await expect(decideIsolation({ ...PROD, [d]: ISO[d] } as NodeJS.ProcessEnv),
        `only ${d} isolated must be refused`).rejects.toThrow(PartialIsolationError)
      // two isolated, one production
      await expect(decideIsolation({ ...ISO, [d]: PROD[d] } as NodeJS.ProcessEnv),
        `all but ${d} isolated must be refused`).rejects.toThrow(PartialIsolationError)
    }
  })

  it('the exact 2026-08-27 configuration — filesystem only — is refused', async () => {
    await expect(decideIsolation({ AI_CAPITAL_ROOT: '/tmp/x' } as NodeJS.ProcessEnv))
      .rejects.toThrow(PartialIsolationError)
  })

  it('UNSET variables count as production, never as isolated', async () => {
    // The dangerous default: no env at all resolves to production Redis and the
    // production database, so an empty environment must not read as isolated.
    expect((await decideIsolation({} as NodeJS.ProcessEnv)).mode).toBe('production')
  })

  it('requireIsolation refuses a production environment', async () => {
    await expect(requireIsolation(PROD as NodeJS.ProcessEnv)).rejects.toThrow(PartialIsolationError)
  })
})

describe('meta: no queue test may construct a client without the isolation setup', () => {
  it('every test constructing Queue/Worker/FlowProducer loads the integration setup', () => {
    // Match the IMPORT, not just the call. A test that imports getQueue has
    // already taken on the risk — the call may be one refactor away, and an
    // earlier version of this check required the call and passed vacuously
    // against a decoy that merely referenced the symbol.
    const CONSTRUCTS = new RegExp([
      'new\\s+(Queue|Worker|FlowProducer|QueueEvents)\\s*\\(',
      'getQueue|getQueueEvents|createWorker|connectionOptions',
      "from\\s+'bullmq'",
      "from\\s+'\\.\\./src/queue\\.js'",
    ].join('|'))
    const SETUP = 'queue-integration-setup'
    const offenders: string[] = []
    for (const f of readdirSync(HERE)) {
      if (!f.endsWith('.test.ts')) continue
      const src = readFileSync(join(HERE, f), 'utf-8')
      if (!CONSTRUCTS.test(src)) continue
      const cfg = readFileSync(join(HERE, '..', 'vitest.config.ts'), 'utf-8')
      const covered = src.includes(SETUP) || cfg.includes(SETUP)
      if (!covered) offenders.push(f)
    }
    expect(offenders,
      `these tests construct a queue client without the isolation setup: ${offenders.join(', ')}`).toEqual([])
  })

  it('the integration setup exists and calls requireIsolation', () => {
    const p = join(HERE, '..', 'testing', 'queue-integration-setup.ts')
    expect(existsSync(p)).toBe(true)
    expect(readFileSync(p, 'utf-8')).toContain('requireIsolation')
  })
})
