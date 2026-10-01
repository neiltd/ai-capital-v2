// K7-B: ONE supervisor transaction covers Stage 1, Stage 2, verification and the
// release. Two things make that claim checkable rather than hoped for:
//
//   - Stage 2 ADOPTS the caller's fence instead of taking a second one, and
//   - every stage seam re-proves that the same backend still holds it.
//
// `proveFence` alone is not enough: it shows the LOCKS are held by a pid, and a
// pid outlives nothing. `backend_start` is what distinguishes the backend that
// fenced from a different one that reconnected and inherited its number.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  BACKEND_START_SQL, SESSION_IDENTITY_SQL, applyInputFor,
  assertFencedSupervisorUnchanged,
} from '../src/pg-copy/lifecycle.js'
import { runSourceStages } from '../src/pg-copy/stage2.js'
import {
  FENCE_ADVISORY_SQL, FENCE_BEGIN_SQL, FENCE_LOCK_TIMEOUT_SQL,
} from '../src/pg-copy/source-fence.js'

const FENCE = { supervisorPid: '41512', backendStart: '2026-09-30 10:00:00.123456-07' }

/** A session that answers only the two questions this proof asks. */
const session = (pid: string, start: string, role = 'thanapold') => ({
  send: async (sql: string) => {
    if (sql === SESSION_IDENTITY_SQL) return { rows: [[pid, role, start]], error: null }
    return { rows: [], error: null }
  },
})

/** A prover that also answers "when did THAT pid start", as an outsider. */
const prover = (pid: string, start: string, observed: string | null) => ({
  send: async (sql: string) => {
    if (sql === SESSION_IDENTITY_SQL) return { rows: [[pid, 'thanapold', start]], error: null }
    if (sql === BACKEND_START_SQL(FENCE.supervisorPid)) {
      return { rows: observed === null ? [] : [[observed]], error: null }
    }
    return { rows: [], error: null }
  },
})

describe('K7-B: supervisor continuity across a stage seam', () => {
  const OTHER = '2026-09-30 11:30:00.000000-07'

  it('accepts the same backend, proved from both sides', async () => {
    await expect(assertFencedSupervisorUnchanged(
      session(FENCE.supervisorPid, FENCE.backendStart),
      prover('99999', OTHER, FENCE.backendStart) as never,
      FENCE,
    )).resolves.toBeUndefined()
  })

  it('REFUSES a changed supervisor pid', async () => {
    await expect(assertFencedSupervisorUnchanged(
      session('41999', FENCE.backendStart),
      prover('99999', OTHER, FENCE.backendStart) as never,
      FENCE,
    )).rejects.toThrow(/not the backend that held the fence/)
  })

  it('REFUSES a recycled pid whose backend_start moved', async () => {
    // The pid is right and the locks would still look held. Only the start
    // distinguishes this from the backend that fenced.
    await expect(assertFencedSupervisorUnchanged(
      session(FENCE.supervisorPid, OTHER),
      prover('99999', OTHER, OTHER) as never,
      FENCE,
    )).rejects.toThrow(/not the backend that held the fence/)
  })

  it('REFUSES when the INDEPENDENT side disagrees about the start', async () => {
    // The supervisor says the right things about itself; the outsider does not
    // corroborate. A session cannot detect its own replacement, which is why
    // this second reading exists.
    await expect(assertFencedSupervisorUnchanged(
      session(FENCE.supervisorPid, FENCE.backendStart),
      prover('99999', OTHER, OTHER) as never,
      FENCE,
    )).rejects.toThrow(/not the backend that held the fence/)
  })

  it('REFUSES when the prover cannot see that backend at all', async () => {
    await expect(assertFencedSupervisorUnchanged(
      session(FENCE.supervisorPid, FENCE.backendStart),
      prover('99999', OTHER, null) as never,
      FENCE,
    )).rejects.toThrow(/not the backend that held the fence/)
  })

  it('REFUSES a prover that is the supervisor', async () => {
    await expect(assertFencedSupervisorUnchanged(
      session(FENCE.supervisorPid, FENCE.backendStart),
      prover(FENCE.supervisorPid, FENCE.backendStart, FENCE.backendStart) as never,
      FENCE,
    )).rejects.toThrow(/fence was not proved held/)
  })
})

const STAGE2 = readFileSync(
  fileURLToPath(new URL('../src/pg-copy/stage2.ts', import.meta.url)), 'utf-8')

/**
 * The body of ONE function, bounded at the next top-level declaration.
 *
 * An earlier version of these cases sliced from the function to end-of-file and
 * then counted call sites, which silently included a later function's calls -
 * the count said 2 and meant nothing about runSourceStages.
 */
const bodyOf = (name: string): string => {
  const from = STAGE2.indexOf(`export async function ${name}`)
  expect(from).toBeGreaterThan(-1)
  const rest = STAGE2.slice(from + 1)
  const next = rest.indexOf('\nexport ')
  return next === -1 ? rest : rest.slice(0, next)
}

describe('K7-B: Stage 2 adopts a pre-acquired fence, never a second one', () => {
  it('takes the fence ONLY when none was supplied', () => {
    const body = bodyOf('runSourceStages')
    const adopt = body.indexOf('if (i.preAcquiredFence !== undefined)')
    const take = body.indexOf('await acquireSourceFence(i.supervisor)')
    expect(adopt).toBeGreaterThan(-1)
    expect(take).toBeGreaterThan(-1)
    // The acquisition is inside the else, so it is unreachable once a fence
    // was handed in.
    expect(adopt).toBeLessThan(take)
    expect(body.match(/await acquireSourceFence\(/g)?.length).toBe(1)
  })

  it('adopts the supplied object itself rather than rebuilding one', () => {
    // A reconstructed fence would carry whatever a second read reported, and
    // the Stage-1-to-release chain would stop being evidence about one fence.
    const body = bodyOf('runSourceStages')
    expect(body).toContain('fence = i.preAcquiredFence')
  })

  it('PROVES the fence from an independent backend on BOTH paths', () => {
    // A3 sits after the adopt/take branch closes, so it is not skippable by
    // supplying a fence.
    const body = bodyOf('runSourceStages')
    const branchEnd = body.indexOf('// A3.')
    const prove = body.indexOf('await proveFence(i.prover, fence)')
    expect(branchEnd).toBeGreaterThan(-1)
    expect(prove).toBeGreaterThan(branchEnd)
    expect(body.match(/await proveFence\(/g)?.length).toBe(1)
  })
})

// ── BEHAVIOURAL: a second acquisition is detectable, not merely un-asserted ──
//
// The source-order cases above prove the BRANCH is shaped correctly. They
// cannot prove the running code never issues a second `BEGIN` - and that is the
// failure that matters, because re-locking a supervisor that already holds the
// fence SUCCEEDS silently. So this drives `runSourceStages` and inspects what
// the supervisor was actually asked.
describe('K7-B: adopting a fence issues NO acquisition statements', () => {
  const ADOPTED = {
    supervisorPid: '41512',
    backendStart: '2026-09-30 10:00:00.123456-07',
    mechanism: 'S3' as const,
  }

  /** Records every statement, and refuses the fence proof so A3 ends the run. */
  const recordingSupervisor = (): { sent: string[]; send: (s: string) => Promise<{
    rows: string[][]; error: 'statement-refused' | null }> } => {
    const sent: string[] = []
    return {
      sent,
      send: async (sql: string) => {
        sent.push(sql)
        // A plausible pid for the identity statement; everything else empty.
        return { rows: [[ADOPTED.supervisorPid, ADOPTED.backendStart]], error: null }
      },
    }
  }
  const refusingProver = {
    send: async () => ({ rows: [] as string[][], error: 'statement-refused' as const }),
  }

  const run = async (fence?: typeof ADOPTED): Promise<string[]> => {
    const sup = recordingSupervisor()
    const base = {
      supervisor: sup as never,
      prover: refusingProver as never,
      source: {} as never,
      operator: {} as never,
      sourceBeginSql: 'BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ',
      reviewedTarget: {} as never,
    }
    const input = (fence === undefined ? base : { ...base, preAcquiredFence: fence })
    // A3 refuses on purpose; what the supervisor was ASKED is the measurement.
    await runSourceStages(input as never, {} as never).catch(() => undefined)
    return sup.sent
  }

  it('sends NO BEGIN, no lock_timeout and no advisory lock when a fence is supplied', async () => {
    const sent = await run(ADOPTED)
    expect(sent).not.toContain(FENCE_BEGIN_SQL)
    expect(sent).not.toContain(FENCE_LOCK_TIMEOUT_SQL)
    expect(sent).not.toContain(FENCE_ADVISORY_SQL)
    // Nor any table/sequence LOCK, which is the rest of the acquisition.
    expect(sent.filter(q => /^LOCK TABLE/i.test(q))).toEqual([])
  })

  it('DOES acquire when no fence is supplied, so the control is not vacuous', async () => {
    // Without this, the case above would pass against code that never reached
    // the branch at all.
    const sent = await run()
    expect(sent).toContain(FENCE_BEGIN_SQL)
    expect(sent).toContain(FENCE_ADVISORY_SQL)
  })
})

describe('K7-B: the lifecycle FORWARDS the fence it was handed', () => {
  // The seam `runLifecycle` → `runApply` cannot be reached without two live
  // clusters, so a mutant that deleted the forwarding survived every runnable
  // test while the production path silently took a second fence. The input
  // construction is a function now, and this is what kills that mutant.
  const FENCE = {
    supervisorPid: '41512',
    backendStart: '2026-09-30 10:00:00.123456-07',
    mechanism: 'S3' as const,
  }
  const base = {
    supervisor: {} as never, prover: {} as never,
    openStageSource: async () => ({}) as never,
    openStageTarget: async () => ({}) as never,
    openVerifySource: async () => ({}) as never,
    openVerifyTarget: async () => ({}) as never,
    bundleDir: '/ev/source-manifest-x',
    reviewedTarget: { digest: 'd' } as never,
    operator: {} as never,
    sourceBeginSql: 'BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ',
    targetExpectation: {} as never,
    confirmation: `PGCOPY-COPY-${'a'.repeat(64)}`,
    quiescence: {} as never, queue: {} as never,
    restorationAuthority: { kind: 'manual-stop' as const },
    destinations: {} as never,
    expectedProducers: [] as never,
    evidenceRoot: '/ev',
  }

  it('carries the SAME fence object through to the Stage-2 input', () => {
    const out = applyInputFor({ ...base, preAcquiredFence: FENCE } as never, {} as never)
    expect(out.preAcquiredFence).toBe(FENCE)      // identity, not a copy
  })

  it('OMITS the key entirely when no fence was handed in', () => {
    // Omitted rather than undefined, so the disposable path still reaches
    // acquireSourceFence exactly as before.
    const out = applyInputFor(base as never, {} as never)
    expect('preAcquiredFence' in out).toBe(false)
  })

  it('passes the borrowed supervisor and prover through unchanged', () => {
    const sup = { s: 1 } as never
    const prv = { p: 2 } as never
    const out = applyInputFor(
      { ...base, supervisor: sup, prover: prv, preAcquiredFence: FENCE } as never,
      {} as never)
    expect(out.supervisor).toBe(sup)
    expect(out.prover).toBe(prv)
  })
})
