// RETIRING A FAILED FLOW: what must be measured, bound and refused.
//
// THE OPERATION THIS GUARDS. Removing BullMQ jobs by hand is the most dangerous
// thing in this repository: `removeJob` SREMs the job from its parent's dependency
// set, and an emptied set moves the parent from `waiting-children` to `wait`, where
// a live worker EXECUTES it. Reproduced on an isolated Redis on 2026-08-27.
//
// THREE THINGS THE FIRST VERSION GOT WRONG, each pinned below:
//
//   * it bound a commit read from an operator-supplied directory, proving nothing
//     about the code actually executing;
//   * it recorded parenthood as a BOOLEAN, so rewiring a job from one parent to
//     another left the token identical and the plan different;
//   * it validated one census and then let the remover collect and delete a
//     different one, while claiming drift was refused.
//
// NOTHING HERE TOUCHES PRODUCTION. The plan, binding and token are pure functions
// over fixtures; the authority cases run git against throwaway repositories.

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { FlowTopologyRefused, planFlowRemoval, type JobRef } from '../src/flow-cleanup.js'
import {
  FORBIDDEN_STATES, INTENT_PREFIX, OUTCOME_PREFIX, REVIEWED_IMPLEMENTATION_PATHS,
  RETIREMENT_BINDING_VERSION, RETIREMENT_TOKEN_PREFIX, RetirementRefused,
  TERMINAL_OR_PARKED, assertRetirable, measureImplementationAuthority, planDigest,
  retirementBindingDocument, retirementPlan, retirementToken,
  type ImplementationAuthority, type RetirementBinding, type ScheduledRow,
} from '../src/flow-retirement.js'
import { REVIEWED_PREFIXES } from '@common/db/pg-copy'

const PARENT = '2191e266-78a1-4951-9807-bf4260563463'
const FAILED_A = '6a35fa36-a84d-4344-adc0-27b4446fa769'
const FAILED_B = '235dbf5a-bef1-43e4-b8aa-d73587ab0cbf'
const QUEUE = 'daily-pipeline'

/**
 * A REAL TREE, not a bag of jobs.
 *
 * Every node names its exact parent, because that is what the census now records
 * and what the plan is derived from. The shape mirrors production: one parked root,
 * a parked spine, two failed leaves and some completed siblings.
 */
const census = (edit: (rows: JobRef[]) => JobRef[] = r => r): JobRef[] => {
  const node = (id: string, name: string, state: string, parentId: string | null): JobRef =>
    ({ id, name, state, parentId, parentQueue: parentId === null ? null : QUEUE })
  const rows: JobRef[] = [
    node('p-root', 'morning-status', 'waiting-children', null),
    node('p-brief', 'investment-brief', 'waiting-children', 'p-root'),
    node('p-risk', 'risk-metrics', 'waiting-children', 'p-brief'),
    node('p-tax', 'tax-harvest', 'waiting-children', 'p-risk'),
    node('p-back', 'briefing-backtest', 'waiting-children', 'p-tax'),
    node('p-ai', 'ai-analysis-engine', 'waiting-children', 'p-back'),
    node('c-wave', 'wave-analyzer', 'completed', 'p-brief'),
    node('c-refresh', 'scenario-refresh', 'completed', 'p-back'),
    node(FAILED_A, 'scenario-simulate', 'failed', 'p-back'),
    node(FAILED_B, 'world-intel-report', 'failed', 'p-ai'),
  ]
  return edit(rows)
}

const row = (over: Partial<ScheduledRow> = {}): ScheduledRow => ({
  id: PARENT, parentRunId: null, stage: 'daily-pipeline', source: 'queue',
  status: 'failed', logicalDate: '2026-09-28', supersededAt: null,
  failedStage: 'world-intel-report',
  children: [
    { id: 'c1', stage: 'scenario-simulate', status: 'failed' },
    { id: 'c2', stage: 'world-intel-report', status: 'failed' },
  ],
  ...over,
})

const authority = (over: Partial<ImplementationAuthority> = {}): ImplementationAuthority => ({
  root: '/Users/x/ai-capital-runtime', head: 'a'.repeat(40),
  reviewedPaths: REVIEWED_IMPLEMENTATION_PATHS, ...over,
})

const binding = (over: Partial<RetirementBinding> = {}): RetirementBinding => {
  const c = over.census ?? census()
  return {
    bindingVersion: RETIREMENT_BINDING_VERSION,
    implementation: authority(),
    parentRunId: PARENT,
    queue: QUEUE,
    row: row(),
    census: c,
    planDigest: planDigest(retirementPlan(PARENT, c)),
    workersPresent: 0,
    expectedFailedIds: [FAILED_A, FAILED_B],
    redis: { host: '127.0.0.1', port: 6379, db: 0 },
    evidenceRoot: '/Users/x/evidence',
    evidenceRootDeviceInode: '16777229:137253857',
    intent: `supersede-scheduled-run:${PARENT}`,
    ...over,
  }
}

const ok = () => ({
  parentRunId: PARENT, logicalDate: '2026-09-28', queue: QUEUE, row: row(),
  census: census(), expectedFailedIds: [FAILED_A, FAILED_B], workersPresent: 0,
})

// ── A. The implementation actually executing ────────────────────────────────

describe('the binding names the implementation that is running', () => {
  const realRoot = execFileSync('/usr/bin/git',
    ['-C', fileURLToPath(new URL('.', import.meta.url)), 'rev-parse', '--show-toplevel'],
    { encoding: 'utf-8' }).trim()

  /**
   * THE ROOT IS DERIVED FROM THIS MODULE, and that part holds whatever the worktree
   * looks like.
   *
   * Acceptance itself is asserted against a scratch repository below, deliberately:
   * asserting it here would make the case fail for anyone with local edits — it did,
   * on the very run that added it — which is a test measuring the developer's
   * worktree rather than the contract.
   */
  it('derives the repository root from the executing module, not from the option', () => {
    let refusal = ''
    try {
      const a = measureImplementationAuthority(realRoot, import.meta.url)
      expect(a.root).toBe(realRoot)
      expect(a.head).toMatch(/^[0-9a-f]{40}$/)
      expect(a.reviewedPaths).toEqual(REVIEWED_IMPLEMENTATION_PATHS)
    } catch (e) {
      // A dirty local tree is a legitimate state for a developer; what must be true
      // either way is that the refusal is about cleanliness, having already agreed
      // the supplied checkout IS this repository.
      refusal = (e as Error).message
      expect(refusal).toMatch(/tracked modifications|untracked file sits inside/)
      expect(refusal, 'the root itself was accepted').not.toMatch(/not the repository/)
    }
  })

  /**
   * A DIFFERENT CHECKOUT IS REFUSED.
   *
   * The previous version ran `git -C <supplied> rev-parse HEAD` and bound whatever
   * came back, so a token could certify a commit from a repository that had nothing
   * to do with the code performing the removal.
   */
  it('REFUSES a checkout that is not the repository containing this code', () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'other-checkout-')))
    try {
      execFileSync('/usr/bin/git', ['-C', other, 'init', '-q'])
      execFileSync('/usr/bin/git', ['-C', other, 'config', 'user.email', 'x@example.invalid'])
      execFileSync('/usr/bin/git', ['-C', other, 'config', 'user.name', 'x'])
      writeFileSync(join(other, 'f'), 'x\n')
      execFileSync('/usr/bin/git', ['-C', other, 'add', 'f'])
      execFileSync('/usr/bin/git', ['-C', other, 'commit', '-qm', 'x'])
      expect(() => measureImplementationAuthority(other, import.meta.url))
        .toThrow(/not the repository containing the running code/)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('REFUSES a checkout that cannot be resolved', () => {
    expect(() => measureImplementationAuthority('/nope/does/not/exist', import.meta.url))
      .toThrow(/cannot be resolved/)
  })

  it('REFUSES when the executing module is not in a repository at all', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'no-repo-')))
    try {
      expect(() => measureImplementationAuthority(
        outside, pathToFileURL(join(outside, 'fake.ts')).href))
        .toThrow(/not inside a git repository/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  /**
   * CLEANLINESS IS PART OF IDENTITY, and it is scoped.
   *
   * A commit identifier describes a tree; a dirty worktree means the executing files
   * are not that tree. Both cases below run against a throwaway repository laid out
   * like this one, so the real checkout is never dirtied.
   */

  const scratchRepo = (): string => {
    // REALPATH, BECAUSE THE AUTHORITY DOES. On macOS `mkdtemp` hands back a
    // /var/folders path while `/var` is a symlink to `/private/var`, so comparing an
    // un-resolved fixture path against the resolved root passes under one TMPDIR and
    // fails under another. Measured: this case passed in one run and failed in the
    // mutation matrix, whose TMPDIR was spelled the other way.
    const r = realpathSync(mkdtempSync(join(tmpdir(), 'authority-repo-')))
    execFileSync('/usr/bin/git', ['-C', r, 'init', '-q'])
    execFileSync('/usr/bin/git', ['-C', r, 'config', 'user.email', 'x@example.invalid'])
    execFileSync('/usr/bin/git', ['-C', r, 'config', 'user.name', 'x'])
    for (const d of REVIEWED_IMPLEMENTATION_PATHS) {
      mkdirSync(join(r, d), { recursive: true })
      writeFileSync(join(r, d, 'kept.ts'), 'export const x = 1\n')
    }
    mkdirSync(join(r, 'apps/elsewhere'), { recursive: true })
    execFileSync('/usr/bin/git', ['-C', r, 'add', '-A'])
    execFileSync('/usr/bin/git', ['-C', r, 'commit', '-qm', 'base'])
    return r
  }

  it('accepts a CLEAN actual checkout', () => {
    const r = scratchRepo()
    try {
      const a = measureImplementationAuthority(
        r, pathToFileURL(join(r, 'packages/queue/src/kept.ts')).href)
      expect(a.root).toBe(r)
      expect(a.head).toMatch(/^[0-9a-f]{40}$/)
      expect(a.reviewedPaths).toEqual(REVIEWED_IMPLEMENTATION_PATHS)
    } finally { rmSync(r, { recursive: true, force: true }) }
  })

  it('REFUSES a tracked modification in the reviewed implementation', () => {
    const r = scratchRepo()
    try {
      const f = join(r, 'packages/queue/src/kept.ts')
      writeFileSync(f, 'export const x = 2\n')
      expect(() => measureImplementationAuthority(r, pathToFileURL(f).href))
        .toThrow(/tracked modifications/)
    } finally { rmSync(r, { recursive: true, force: true }) }
  })

  it('REFUSES a STAGED modification too', () => {
    const r = scratchRepo()
    try {
      const f = join(r, 'packages/queue/src/kept.ts')
      writeFileSync(f, 'export const x = 3\n')
      execFileSync('/usr/bin/git', ['-C', r, 'add', 'packages/queue/src/kept.ts'])
      expect(() => measureImplementationAuthority(r, pathToFileURL(f).href))
        .toThrow(/tracked modifications/)
    } finally { rmSync(r, { recursive: true, force: true }) }
  })

  it('REFUSES an untracked file inside the reviewed implementation', () => {
    const r = scratchRepo()
    try {
      writeFileSync(join(r, 'packages/queue/src/sneaked-in.ts'), 'export const y = 1\n')
      expect(() => measureImplementationAuthority(
        r, pathToFileURL(join(r, 'packages/queue/src/kept.ts')).href))
        .toThrow(/untracked file sits inside the reviewed implementation/)
    } finally { rmSync(r, { recursive: true, force: true }) }
  })

  /** …and an approved untracked artefact ELSEWHERE is not a refusal. */
  it('accepts an untracked file outside the reviewed implementation', () => {
    const r = scratchRepo()
    try {
      writeFileSync(join(r, 'apps/elsewhere/2026-09-29.json'), '{}\n')
      const a = measureImplementationAuthority(
        r, pathToFileURL(join(r, 'packages/queue/src/kept.ts')).href)
      expect(a.root).toBe(r)
    } finally { rmSync(r, { recursive: true, force: true }) }
  })

  it('the reviewed set is the implementation source, and nothing wider', () => {
    expect([...REVIEWED_IMPLEMENTATION_PATHS].sort()).toEqual([
      'packages/db/src/pg-copy', 'packages/pipeline-runs/src',
      'packages/queue/bin', 'packages/queue/src',
    ])
  })
})

// ── B. Exact topology ───────────────────────────────────────────────────────

describe('the removal plan is a true parent-before-child order', () => {
  it('emits every parent strictly before its own children', () => {
    const plan = retirementPlan(PARENT, census())
    const at = new Map(plan.order.map((s, i) => [s.id, i]))
    for (const s of plan.order) {
      if (s.parentId === null) continue
      expect(at.get(s.parentId), `${s.id} after its parent ${s.parentId}`)
        .toBeLessThan(at.get(s.id) as number)
    }
    expect(plan.order[0]?.id, 'the root goes first').toBe('p-root')
    expect(plan.ancestorsFirst).toBe(true)
  })

  it('covers every job exactly once', () => {
    const c = census()
    const plan = retirementPlan(PARENT, c)
    expect(plan.order).toHaveLength(c.length)
    expect(new Set(plan.order.map(s => s.id)).size).toBe(c.length)
  })

  it('is stable against the order Redis answers in', () => {
    const a = planDigest(retirementPlan(PARENT, census()))
    const b = planDigest(retirementPlan(PARENT, census(r => [...r].reverse())))
    expect(b).toBe(a)
  })

  /**
   * REWIRING A JOB TO ANOTHER PARENT IS VISIBLE.
   *
   * Under the old boolean census this job still "had a parent", so the token was
   * byte-identical while the removal order was different. That is the defect.
   */
  /**
   * A REWIRING THAT DOES NOT CHANGE THE ORDER still moves the digest.
   *
   * The broader rewiring case below also changes the emitted order, so the digest
   * moved for that reason and a mutation dropping `parent_id` from the digest
   * document survived. Measured. Here the order is byte-identical and only the
   * parent differs: a chain r->b->c reparented to r->b, r->c emits r, b, c either
   * way.
   */
  it('moves the plan digest for a rewiring that preserves the order', () => {
    const chain: JobRef[] = [
      { id: 'r', name: 'root', state: 'waiting-children', parentId: null, parentQueue: null },
      { id: 'b', name: 'mid', state: 'waiting-children', parentId: 'r', parentQueue: QUEUE },
      { id: 'c', name: 'leaf', state: 'failed', parentId: 'b', parentQueue: QUEUE },
    ]
    const flat: JobRef[] = chain.map(j => j.id === 'c' ? { ...j, parentId: 'r' } : j)
    const orderOf = (rows: JobRef[]) => planFlowRemoval(PARENT, rows).order.map(x => x.id)
    expect(orderOf(flat), 'the emitted order is identical').toEqual(orderOf(chain))
    expect(planDigest(planFlowRemoval(PARENT, flat)))
      .not.toBe(planDigest(planFlowRemoval(PARENT, chain)))
  })

  it('moves the plan digest when a job is rewired to another parent', () => {
    const rewired = census(r => r.map(j =>
      j.id === FAILED_A ? { ...j, parentId: 'p-ai' } : j))
    expect(planDigest(retirementPlan(PARENT, rewired)))
      .not.toBe(planDigest(retirementPlan(PARENT, census())))
  })

  it('moves the TOKEN when a job is rewired, with the same job set and states', () => {
    const rewired = census(r => r.map(j =>
      j.id === FAILED_A ? { ...j, parentId: 'p-ai' } : j))
    // Every id, name and state is unchanged; only the parent differs.
    expect(rewired.map(j => `${j.id}:${j.name}:${j.state}`).sort())
      .toEqual(census().map(j => `${j.id}:${j.name}:${j.state}`).sort())
    expect(retirementToken(binding({ census: rewired })))
      .not.toBe(retirementToken(binding()))
  })

  for (const [what, edit, pattern] of [
    ['a duplicate job id', (r: JobRef[]) => [...r, r[0] as JobRef], /appears twice/],
    ['a self-parent', (r: JobRef[]) => r.map(j =>
      j.id === 'p-risk' ? { ...j, parentId: 'p-risk' } : j), /its own parent/],
    ['a missing parent', (r: JobRef[]) => r.map(j =>
      j.id === 'p-risk' ? { ...j, parentId: 'ghost' } : j), /outside the measured census/],
    ['two roots', (r: JobRef[]) => r.map(j =>
      j.id === 'p-brief' ? { ...j, parentId: null, parentQueue: null } : j), /more than one root/],
    ['no root at all', (r: JobRef[]) => r.map(j =>
      j.id === 'p-root' ? { ...j, parentId: 'p-brief', parentQueue: QUEUE } : j), /no root/],
  ] as const) {
    it(`REFUSES ${what}`, () => {
      expect(() => planFlowRemoval(PARENT, census(edit as never)))
        .toThrow(FlowTopologyRefused)
      expect(() => planFlowRemoval(PARENT, census(edit as never))).toThrow(pattern)
    })
  }

  it('REFUSES a disconnected fragment', () => {
    // A second little tree whose own root is not the flow's root.
    const detached = census(r => [...r,
      { id: 'd-root', name: 'x', state: 'completed', parentId: 'd-mid', parentQueue: QUEUE },
      { id: 'd-mid', name: 'y', state: 'completed', parentId: 'd-root', parentQueue: QUEUE }])
    expect(() => planFlowRemoval(PARENT, detached)).toThrow(/cycle|disconnected/)
  })

  it('REFUSES a cycle among otherwise-connected jobs', () => {
    const cyclic = census(r => r.map(j =>
      j.id === 'p-root' ? { ...j, parentId: 'p-ai', parentQueue: QUEUE } : j))
    expect(() => planFlowRemoval(PARENT, cyclic)).toThrow(/no root|cycle/)
  })
})

// ── The safety gate ─────────────────────────────────────────────────────────

describe('what may be retired, and what may not', () => {
  it('accepts the reviewed production shape', () => {
    expect(() => assertRetirable(ok())).not.toThrow()
  })

  for (const state of ['active', 'wait', 'delayed', 'prioritized'] as const) {
    it(`REFUSES a flow containing a job in ${state}`, () => {
      const c = census(r => r.map(j => j.id === 'c-wave' ? { ...j, state } : j))
      expect(() => assertRetirable({ ...ok(), census: c })).toThrow(new RegExp(state))
    })
  }

  it('REFUSES a state outside the reviewed vocabulary', () => {
    const c = census(r => r.map(j => j.id === 'c-wave' ? { ...j, state: 'paused' } : j))
    expect(() => assertRetirable({ ...ok(), census: c }))
      .toThrow(/state this tool does not review/)
  })

  it('REFUSES a parent on another queue', () => {
    const c = census(r => r.map(j =>
      j.id === FAILED_A ? { ...j, parentQueue: 'structured-ingestion' } : j))
    expect(() => assertRetirable({ ...ok(), census: c })).toThrow(/parent is on another queue/)
  })

  it('REFUSES a malformed topology before any plan is produced', () => {
    const c = census(r => r.map(j => j.id === 'p-risk' ? { ...j, parentId: 'ghost' } : j))
    expect(() => assertRetirable({ ...ok(), census: c }))
      .toThrow(/topology is not reviewable/)
  })

  /** A WORKER IS A REFUSAL, because a released parent would be executed. */
  // TITLES WITHOUT REGEX METACHARACTERS.
  //
  // `worker(s)` reads as a capture group when a runner filters by name, so a scoped
  // run matched nothing and passed vacuously — the mutation that removes the worker
  // refusal survived because of a pair of parentheses in a test title. Measured.
  for (const n of [1, 2]) {
    it(`REFUSES when ${n} worker could advance the queue`, () => {
      expect(() => assertRetirable({ ...ok(), workersPresent: n }))
        .toThrow(/worker is able to advance this queue/)
    })
  }

  it('REFUSES an unexpected failed leaf', () => {
    const c = census(r => r.map(j => j.id === 'c-wave' ? { ...j, state: 'failed' } : j))
    expect(() => assertRetirable({ ...ok(), census: c }))
      .toThrow(/failed jobs in the flow are not the ones named/)
  })

  it('REFUSES an expected failed id that is not there', () => {
    expect(() => assertRetirable({ ...ok(), expectedFailedIds: [FAILED_A] }))
      .toThrow(/failed jobs in the flow are not the ones named/)
  })

  it('REFUSES a row that is not the one named', () => {
    expect(() => assertRetirable({ ...ok(), row: row({ id: 'another-id' }) }))
      .toThrow(/not the one named/)
  })

  it('REFUSES a row for another logical date', () => {
    expect(() => assertRetirable({ ...ok(), row: row({ logicalDate: '2026-09-27' }) }))
      .toThrow(/another logical date/)
  })

  it('REFUSES a row that is not failed', () => {
    for (const status of ['success', 'running', 'unknown']) {
      expect(() => assertRetirable({ ...ok(), row: row({ status }) }))
        .toThrow(/only a failed scheduled run/)
    }
  })

  it('REFUSES a row that is already superseded', () => {
    expect(() => assertRetirable({ ...ok(), row: row({ supersededAt: '2026-09-29T00:00:00Z' }) }))
      .toThrow(/already superseded/)
  })

  it('REFUSES an empty census', () => {
    expect(() => assertRetirable({ ...ok(), census: [] }))
      .toThrow(/no job in this queue belongs to that parent run/)
  })
})

describe('the reviewed state vocabularies', () => {
  it('forbid exactly the four runnable or running states', () => {
    expect([...FORBIDDEN_STATES].sort()).toEqual(['active', 'delayed', 'prioritized', 'wait'])
  })

  it('permit exactly the terminal and parked states', () => {
    expect([...TERMINAL_OR_PARKED].sort())
      .toEqual(['completed', 'failed', 'waiting-children'])
  })

  it('do not overlap', () => {
    for (const s of TERMINAL_OR_PARKED) expect(FORBIDDEN_STATES).not.toContain(s)
  })
})

// ── The token ───────────────────────────────────────────────────────────────

describe('the confirmation token binds every decided field', () => {
  it('is prefixed and hex', () => {
    expect(retirementToken(binding())).toMatch(
      new RegExp(`^${RETIREMENT_TOKEN_PREFIX}[0-9a-f]{64}$`))
  })

  it('is deterministic for an unchanged world', () => {
    expect(retirementToken(binding())).toBe(retirementToken(binding()))
  })

  const variants: Array<[string, Partial<RetirementBinding>]> = [
    ['implementation head', { implementation: authority({ head: 'b'.repeat(40) }) }],
    ['implementation root', { implementation: authority({ root: '/Users/x/elsewhere' }) }],
    ['reviewed path set', { implementation: authority({ reviewedPaths: ['packages/queue/src'] }) }],
    ['parent run id', { parentRunId: '00000000-0000-0000-0000-000000000000' }],
    ['queue name', { queue: 'structured-ingestion' }],
    ['worker count', { workersPresent: 1 }],
    ['row status', { row: row({ status: 'success' }) }],
    ['row logical date', { row: row({ logicalDate: '2026-09-27' }) }],
    ['row superseded_at', { row: row({ supersededAt: '2026-09-29T00:00:00Z' }) }],
    ['row failed stage', { row: row({ failedStage: 'scenario-simulate' }) }],
    ['row child set', { row: row({ children: [{ id: 'c1', stage: 's', status: 'failed' }] }) }],
    ['row child STATE', { row: row({ children: [
      { id: 'c1', stage: 'scenario-simulate', status: 'success' },
      { id: 'c2', stage: 'world-intel-report', status: 'failed' }] }) }],
    ['expected failed ids', { expectedFailedIds: [FAILED_A] }],
    ['redis host', { redis: { host: '127.0.0.2', port: 6379, db: 0 } }],
    ['redis port', { redis: { host: '127.0.0.1', port: 6380, db: 0 } }],
    ['redis db', { redis: { host: '127.0.0.1', port: 6379, db: 1 } }],
    ['evidence root', { evidenceRoot: '/Users/x/elsewhere' }],
    ['evidence root device:inode', { evidenceRootDeviceInode: '16777229:999' }],
    ['intent', { intent: 'something-else' }],
    ['plan digest', { planDigest: 'c'.repeat(64) }],
    ['binding version', { bindingVersion: RETIREMENT_BINDING_VERSION + 1 }],
  ]

  for (const [what, over] of variants) {
    it(`moves when the ${what} changes`, () => {
      expect(retirementToken(binding(over))).not.toBe(retirementToken(binding()))
    })
  }

  // THE PLAN DIGEST IS PINNED IN THESE, so only the census can move the token.
  it('moves when a job STATE changes, with the same job set and plan', () => {
    const base = binding()
    const changed = census(r => r.map(j => j.id === 'c-wave' ? { ...j, state: 'failed' } : j))
    expect(retirementToken(binding({ census: changed, planDigest: base.planDigest })))
      .not.toBe(retirementToken(base))
  })

  it('moves when a PARENT IDENTITY changes, with the same plan digest', () => {
    const base = binding()
    const changed = census(r => r.map(j =>
      j.id === FAILED_A ? { ...j, parentId: 'p-ai' } : j))
    expect(retirementToken(binding({ census: changed, planDigest: base.planDigest })))
      .not.toBe(retirementToken(base))
  })

  it('moves when a PARENT QUEUE changes', () => {
    const base = binding()
    const changed = census(r => r.map(j =>
      j.id === FAILED_A ? { ...j, parentQueue: 'other' } : j))
    expect(retirementToken(binding({ census: changed, planDigest: base.planDigest })))
      .not.toBe(retirementToken(base))
  })

  it('does NOT move when the census is merely reported in another order', () => {
    const shuffled = census(r => [...r].reverse())
    expect(retirementToken(binding({ census: shuffled })))
      .toBe(retirementToken(binding()))
  })
})

describe('the bound document carries no payload, environment or credential', () => {
  it('records identities, states and topology only', () => {
    const text = JSON.stringify(retirementBindingDocument(binding()))
    for (const forbidden of ['"data"', 'password', 'ANTHROPIC', 'postgres://', 'redis://',
                             'PIPELINE_CREDENTIAL']) {
      expect(text, forbidden).not.toContain(forbidden)
    }
    for (const required of ['removal_plan_digest', 'evidence_root_device_inode',
                            'parent_id', 'workers_able_to_advance_the_queue',
                            'tracked_worktree_clean']) {
      expect(text, required).toContain(required)
    }
  })

  it('the CLI never reads a job payload into evidence', () => {
    const code = cliCode()
    expect(code).not.toMatch(/\.data\b/)
    expect(code).not.toMatch(/process\.env\[/)
  })
})

// ── C. One measured census, consumed ────────────────────────────────────────

const cliSource = (): string => readFileSync(
  fileURLToPath(new URL('../bin/retire-failed-flow.ts', import.meta.url)), 'utf-8')
const cliCode = (): string =>
  cliSource().split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

describe('the census that is deleted is the census that was checked', () => {
  /**
   * THE DEFECT THIS PINS. The old sequence measured a census, validated it, then
   * called `removeFlow`, which collected a THIRD census of its own and deleted that
   * — unvalidated and uncompared. One world was checked and another was deleted.
   */
  it('consumes the measured plan and never re-collects for deletion', () => {
    const code = cliCode()
    expect(code, 'the planned remover is used').toContain('removePlannedFlow(writeQueue, freshPlan)')
    expect(code, 'and the self-collecting one is not').not.toContain('removeFlow(')
  })

  it('compares the post-intent plan digest and token before removing', () => {
    const code = cliCode()
    const digestAt = code.indexOf('freshDigest !== binding.planDigest')
    const tokenAt = code.indexOf('retirementToken({ ...binding')
    const removeAt = code.indexOf('removePlannedFlow(')
    expect(digestAt).toBeGreaterThan(-1)
    expect(tokenAt).toBeGreaterThan(-1)
    expect(digestAt, 'the plan is compared before removal').toBeLessThan(removeAt)
    expect(tokenAt, 'the token is compared before removal').toBeLessThan(removeAt)
  })

  it('rechecks worker absence immediately before the first removal', () => {
    const code = cliCode()
    const recheck = code.indexOf('await writeQueue.getWorkers()')
    const removeAt = code.indexOf('removePlannedFlow(')
    expect(recheck, 'the recheck exists').toBeGreaterThan(-1)
    expect(recheck, 'and precedes the removal').toBeLessThan(removeAt)
  })

  it('closes the writable run-store handle on every path', () => {
    const code = cliCode()
    expect(code).toContain('closeDb()')
    // …in a finally, not on the happy path only.
    expect(code).toMatch(/finally \{[\s\S]{0,200}closeDb\(\)/)
  })

  it('states the residual boundary instead of claiming total atomicity', () => {
    const src = cliSource() + readFileSync(
      fileURLToPath(new URL('../src/flow-retirement.ts', import.meta.url)), 'utf-8')
    expect(src).toMatch(/RESIDUAL BOUNDARY/)
    expect(src).toMatch(/NOT store-side atomic/)
    // The absolute claim must be gone.
    expect(src).not.toMatch(/refusal on any drift/)
  })
})

describe('the evidence is crash-truthful', () => {
  it('publishes the INTENT before the first mutation, and the outcome after', () => {
    const src = cliSource()
    const intentAt = src.indexOf('prefix: INTENT_PREFIX')
    const removeAt = src.indexOf('removePlannedFlow(')
    const supersedeAt = src.indexOf('UPDATE pipeline_runs SET superseded_at')
    const outcomeAt = src.indexOf('prefix: OUTCOME_PREFIX')
    for (const [what, at] of [['intent', intentAt], ['removal', removeAt],
                              ['supersede', supersedeAt], ['outcome', outcomeAt]] as const) {
      expect(at, `the CLI contains the ${what} step`).toBeGreaterThan(-1)
    }
    expect(intentAt).toBeLessThan(removeAt)
    expect(intentAt).toBeLessThan(supersedeAt)
    expect(removeAt).toBeLessThan(outcomeAt)
    expect(supersedeAt).toBeLessThan(outcomeAt)
  })

  it('distinguishes all four outcomes', () => {
    const src = cliSource()
    for (const outcome of ['complete', 'partial', 'refused', 'unknown']) {
      expect(src, outcome).toContain(`'${outcome}'`)
    }
    expect(src).toMatch(/outcome = 'unknown'/)
    expect(src).toMatch(/outcome = 'refused'/)
  })

  it('never reverses or re-sorts the authorized order', () => {
    const code = cliCode()
    expect(code).not.toMatch(/\.reverse\(\)/)
    expect(code).not.toMatch(/order\.sort\(/)
  })
})

describe('the two evidence prefixes are reviewed', () => {
  it('are both in the publisher\'s reviewed set', () => {
    expect(REVIEWED_PREFIXES).toContain(INTENT_PREFIX)
    expect(REVIEWED_PREFIXES).toContain(OUTCOME_PREFIX)
  })

  it('are two distinct records, so an outcome cannot overwrite an intent', () => {
    expect(INTENT_PREFIX).not.toBe(OUTCOME_PREFIX)
  })
})

describe('the scheduled-run reader is WAL-aware', () => {
  it('opens read-only WITHOUT immutable', () => {
    // The behavioural half lives in @common/pipeline-runs, against a row committed
    // only through an active WAL.
    const code = cliCode()
    expect(code).toContain('openDbReadOnly(')
    expect(code).not.toContain('immutable')
  })
})

describe('the binding version moved with the shape', () => {
  it('is 2, because version 1 bound a boolean and an unverified checkout', () => {
    expect(RETIREMENT_BINDING_VERSION).toBe(2)
  })
})
