import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordStart, recordEnd } from '@common/pipeline-runs'
import {
  openParents, assessFlow, applyTransitions, classifyQueueHealth, routeParentAssessment,
  DAILY_PARENT_STAGE, STRUCTURED_PARENT_STAGE, DAILY_FLOW_POLICY, STRUCTURED_FLOW_POLICY,
} from '../src/reconcile.js'
import { openDb, openDbReadOnly } from '@common/pipeline-runs'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { STRUCTURED_PARENT_STAGE } from '../src/structured-scheduling.js'

// Independently scheduled structured runs open their OWN parent rows. Before
// this, reconciliation selected only `daily-pipeline`, so a structured job that
// died outside the normal processor failure path left its parent `running`
// forever — the same permanently-open-parent defect reconciliation was built to
// fix, in a lane it could not see.
//
// Isolated: a temp pipeline-runs database per test. No Redis, no production DB.

let dbPath: string
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'recon-')); dbPath = join(dir, 'runs.db') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const emptySnap = () => ({
  active: [], wait: [], delayed: [], prioritized: [], waitingChildren: [], failed: [], completed: [],
})

describe('structured parents are visible to reconciliation', () => {
  it('are selected by their own stage, and never by the daily query', () => {
    const daily = recordStart({ stage: DAILY_PARENT_STAGE, source: 'queue' }, dbPath)
    const structured = recordStart({ stage: STRUCTURED_PARENT_STAGE, source: 'queue' }, dbPath)

    const dailyOpen = openParents(dbPath).map(p => p.id)
    const structuredOpen = openParents(dbPath, STRUCTURED_PARENT_STAGE).map(p => p.id)

    expect(dailyOpen).toEqual([daily])
    expect(structuredOpen).toEqual([structured])
    // Disjoint sets — this is what makes cross-contamination impossible.
    expect(dailyOpen).not.toContain(structured)
    expect(structuredOpen).not.toContain(daily)
  })

  it('an orphaned structured parent reaches a truthful terminal assessment', () => {
    const id = recordStart({ stage: STRUCTURED_PARENT_STAGE, source: 'queue' }, dbPath)
    const [row] = openParents(dbPath, STRUCTURED_PARENT_STAGE)
    // Job vanished from its queue (stall + retention expiry) — the shape that
    // previously left the row running forever.
    const a = assessFlow(row.id, row.status, row.started_at, emptySnap())
    expect(a.parentRunId).toBe(id)
    expect(a.assessment).toBe('terminal_removed')
    expect(a.proposedTransition).toBe('running -> failed')
  })

  it('a structured parent whose root completed is assessed successful', () => {
    const id = recordStart({ stage: STRUCTURED_PARENT_STAGE, source: 'queue' }, dbPath)
    const snap = { ...emptySnap(), completed: [{ name: 'world-intel-pipeline', data: { parentRunId: id, isRoot: true } }] }
    const a = assessFlow(id, 'running', new Date().toISOString(), snap)
    expect(a.assessment).toBe('terminal_success')
  })

  it('a structured job still retrying is not called terminal', () => {
    const id = recordStart({ stage: STRUCTURED_PARENT_STAGE, source: 'queue' }, dbPath)
    const snap = { ...emptySnap(), delayed: [{ name: 'world-intel-pipeline', data: { parentRunId: id } }] }
    expect(assessFlow(id, 'running', new Date().toISOString(), snap).assessment).toBe('in_progress')
  })

  it('closed structured parents drop out of the open set', () => {
    const id = recordStart({ stage: STRUCTURED_PARENT_STAGE, source: 'queue' }, dbPath)
    expect(openParents(dbPath, STRUCTURED_PARENT_STAGE)).toHaveLength(1)
    recordEnd(id, { status: 'failed', error: { message: 'orphaned' } }, dbPath)
    expect(openParents(dbPath, STRUCTURED_PARENT_STAGE)).toHaveLength(0)
  })
})

describe('structured reconciliation cannot touch the main daily parent', () => {
  it('assessing a structured parent against its own snapshot says nothing about the daily one', () => {
    const daily = recordStart({ stage: DAILY_PARENT_STAGE, source: 'queue' }, dbPath)
    const structured = recordStart({ stage: STRUCTURED_PARENT_STAGE, source: 'queue' }, dbPath)

    const results = openParents(dbPath, STRUCTURED_PARENT_STAGE)
      .map(p => assessFlow(p.id, p.status, p.started_at, emptySnap()))

    expect(results.map(r => r.parentRunId)).toEqual([structured])
    expect(results.map(r => r.parentRunId)).not.toContain(daily)
    // The daily row is untouched and still open for its own reconciliation.
    expect(openParents(dbPath, DAILY_PARENT_STAGE).map(p => p.id)).toEqual([daily])
  })

  it('a healthy daily parent is unaffected by a dead structured lane', () => {
    const daily = recordStart({ stage: DAILY_PARENT_STAGE, source: 'queue' }, dbPath)
    recordStart({ stage: STRUCTURED_PARENT_STAGE, source: 'queue' }, dbPath)

    // Daily has a live job; structured has nothing. Each assessed on its own snapshot.
    const dailySnap = { ...emptySnap(), active: [{ name: 'world-intel-collect', data: { parentRunId: daily } }] }
    const dailyResult = assessFlow(daily, 'running', new Date().toISOString(), dailySnap)
    expect(dailyResult.assessment).toBe('in_progress')
    expect(dailyResult.proposedTransition).toBeNull()
  })
})

// ── The retained-failure shape (removeOnFail: false) ────────────────────────
//
// The structured job is submitted with removeOnFail: false, so a failed root
// STAYS in the queue. That produces failed=1, runnable=0, waiting-children=0,
// rootCompleted=false — which the conservative daily policy calls `unknown`,
// leaving the parent row `running` forever. The earlier "removed" test never
// covered this shape because it asserted an EMPTY queue.

const rootJob = (parentRunId: string) => ({ name: 'world-intel-pipeline', data: { parentRunId, isRoot: true } })

describe('1. a retained, definitively failed structured root is terminal', () => {
  it('is terminal_failed under the structured policy', () => {
    const id = 'structured-1'
    const snap = { ...emptySnap(), failed: [rootJob(id)] }
    const a = assessFlow(id, 'running', new Date().toISOString(), snap, STRUCTURED_FLOW_POLICY)
    expect(a.failed).toBe(1)
    expect(a.runnable).toBe(0)
    expect(a.blocked).toBe(0)
    expect(a.rootCompleted).toBe(false)
    expect(a.assessment).toBe('terminal_failed')
    expect(a.proposedTransition).toBe('running -> failed')
  })

  it('4/8. the SAME shape stays conservative under the daily policy', () => {
    const id = 'daily-1'
    const snap = { ...emptySnap(), failed: [rootJob(id)] }
    const a = assessFlow(id, 'running', new Date().toISOString(), snap, DAILY_FLOW_POLICY)
    expect(a.assessment).toBe('unknown')
    expect(a.proposedTransition).toBeNull()
  })

  it('the daily policy is the default, so existing daily behaviour is unchanged', () => {
    const id = 'daily-2'
    const snap = { ...emptySnap(), failed: [rootJob(id)] }
    expect(assessFlow(id, 'running', new Date().toISOString(), snap).assessment).toBe('unknown')
  })

  it('a failed NON-root structured job alone is not treated as a terminal root', () => {
    const id = 'structured-2'
    const snap = { ...emptySnap(), failed: [{ name: 'world-intel-pipeline', data: { parentRunId: id } }] }
    expect(assessFlow(id, 'running', new Date().toISOString(), snap, STRUCTURED_FLOW_POLICY).assessment).toBe('unknown')
  })
})

describe('2/3. retry and live work always win over terminality', () => {
  it.each([
    ['delayed (pending retry)', 'delayed'],
    ['active', 'active'],
    ['waiting', 'wait'],
    ['prioritized', 'prioritized'],
  ])('%s structured work stays in_progress even with a failed root present', (_label, bucket) => {
    const id = 'structured-3'
    const snap = { ...emptySnap(), failed: [rootJob(id)], [bucket]: [rootJob(id)] } as never
    const a = assessFlow(id, 'running', new Date().toISOString(), snap, STRUCTURED_FLOW_POLICY)
    expect(a.assessment).toBe('in_progress')
    expect(a.proposedTransition).toBeNull()
  })
})

// ── Apply semantics ────────────────────────────────────────────────────────

describe('5/6/7. apply writes only under an explicit writable connection', () => {
  it('6. an explicit apply performs the real SQL transition in a temp database', () => {
    const id = recordStart({ stage: STRUCTURED_PARENT_STAGE, source: 'queue' }, dbPath)
    const [row] = openParents(dbPath, STRUCTURED_PARENT_STAGE)
    const assessment = assessFlow(row.id, row.status, row.started_at,
      { ...emptySnap(), failed: [rootJob(id)] }, STRUCTURED_FLOW_POLICY)

    const db = openDb(dbPath)
    expect(applyTransitions([assessment], db)).toBe(1)

    const after = openDbReadOnly(dbPath)
      .prepare('SELECT status, ended_at, error_message FROM pipeline_runs WHERE id = ?')
      .get(id) as { status: string; ended_at: string | null; error_message: string | null }
    expect(after.status).toBe('failed')
    expect(after.ended_at).toBeTruthy()
    expect(after.error_message).toMatch(/^reconciled: /)
    expect(openParents(dbPath, STRUCTURED_PARENT_STAGE)).toHaveLength(0)
  })

  it('5. non-terminal assessments never reach the database at all', () => {
    const guard = { prepare: () => { throw new Error('dry-run must not write') } }
    const inProgress = assessFlow('x', 'running', new Date().toISOString(),
      { ...emptySnap(), active: [rootJob('x')] }, STRUCTURED_FLOW_POLICY)
    expect(() => applyTransitions([inProgress], guard)).not.toThrow()
    expect(applyTransitions([inProgress], guard)).toBe(0)
  })

  it('5. the CLI opens a writable handle only inside the --apply branch', () => {
    const cli = readFileSync(resolve(__dirname, '..', 'bin', 'reconcile.ts'), 'utf-8')
    const applyIdx = cli.indexOf('if (APPLY)')
    expect(applyIdx).toBeGreaterThan(-1)
    // openDb( appears, and only after the apply guard.
    expect(cli.indexOf('openDb(resolveDbPath())')).toBeGreaterThan(applyIdx)
    // The pre-apply section must not construct a writable handle.
    expect(cli.slice(0, applyIdx)).not.toMatch(/openDb\(/)
  })

  it('7. applying a structured assessment cannot close a daily parent', () => {
    const daily = recordStart({ stage: DAILY_PARENT_STAGE, source: 'queue' }, dbPath)
    const structured = recordStart({ stage: STRUCTURED_PARENT_STAGE, source: 'queue' }, dbPath)

    const structuredAssessment = assessFlow(structured, 'running', new Date().toISOString(),
      { ...emptySnap(), failed: [rootJob(structured)] }, STRUCTURED_FLOW_POLICY)
    applyTransitions([structuredAssessment], openDb(dbPath))

    const dailyRow = openDbReadOnly(dbPath)
      .prepare('SELECT status FROM pipeline_runs WHERE id = ?').get(daily) as { status: string }
    expect(dailyRow.status).toBe('running')                       // untouched
    expect(openParents(dbPath, DAILY_PARENT_STAGE).map(p => p.id)).toEqual([daily])
  })
})

// ── Queue health, per lane ─────────────────────────────────────────────────

describe('9-12. queue health assesses each lane against its own snapshot', () => {
  const parentRow = (id: string): { id: string; started_at: string; status: string } =>
    ({ id, started_at: new Date().toISOString(), status: 'running' })

  it('10. a dead structured run makes health unhealthy', () => {
    const r = classifyQueueHealth({
      main:       { snap: emptySnap(), parents: [] },
      structured: { snap: { ...emptySnap(), failed: [rootJob('s1')] }, parents: [parentRow('s1')] },
    })
    expect(r.healthy).toBe(false)
    expect(r.structuredStuck).toHaveLength(1)
    expect(r.problems.join(' ')).toMatch(/structured run\(s\) terminally failed or removed/)
  })

  it('11. retrying structured work does not produce a false unhealthy verdict', () => {
    const r = classifyQueueHealth({
      main:       { snap: emptySnap(), parents: [] },
      structured: { snap: { ...emptySnap(), delayed: [rootJob('s2')] }, parents: [parentRow('s2')] },
    })
    expect(r.healthy).toBe(true)
    expect(r.structuredStuck).toHaveLength(0)
  })

  it('12. a dead structured run does not make the DAILY lane look unhealthy', () => {
    const r = classifyQueueHealth({
      main:       { snap: { ...emptySnap(), active: [rootJob('d1')] }, parents: [parentRow('d1')] },
      structured: { snap: { ...emptySnap(), failed: [rootJob('s3')] }, parents: [parentRow('s3')] },
    })
    expect(r.dailyStuck).toHaveLength(0)          // daily assessed on the MAIN snapshot only
    expect(r.structuredStuck).toHaveLength(1)
    expect(r.problems.join(' ')).not.toMatch(/daily parent/)
  })

  it('9. a healthy pair of lanes is healthy', () => {
    expect(classifyQueueHealth({
      main:       { snap: emptySnap(), parents: [] },
      structured: { snap: emptySnap(), parents: [] },
    })).toMatchObject({ healthy: true, problems: [] })
  })

  it('a daily parent with a dead DAG is still reported, using the daily policy', () => {
    const r = classifyQueueHealth({
      main:       { snap: { ...emptySnap(), waitingChildren: [rootJob('d2')] }, parents: [parentRow('d2')] },
      structured: { snap: emptySnap(), parents: [] },
    })
    expect(r.dailyStuck).toHaveLength(1)
    expect(r.problems.join(' ')).toMatch(/daily parent row/)
  })
})

// ── Explicit --parent routing, by stage ────────────────────────────────────
//
// `--parent` previously selected a row WITHOUT its stage, put it in the daily
// collection and assessed it against the MAIN snapshot. A structured parent has
// no jobs there, so a live structured run read as `terminal_removed` — and with
// --apply the CLI would have closed it as failed.

const row = (id: string, stage: string, status = 'running') =>
  ({ id, stage, status, started_at: new Date().toISOString() })

describe('explicit-parent routing is stage-aware', () => {
  const lanes = (mainJobs: Record<string, unknown[]> = {}, structuredJobs: Record<string, unknown[]> = {}) => ({
    main:       { ...emptySnap(), ...mainJobs } as never,
    structured: { ...emptySnap(), ...structuredJobs } as never,
  })

  it('1. an ACTIVE structured parent is assessed on the structured snapshot and stays in_progress', () => {
    const id = 's-active'
    // Deliberately empty main snapshot: the old routing would call this terminal_removed.
    const r = routeParentAssessment(row(id, STRUCTURED_PARENT_STAGE), lanes({}, { active: [rootJob(id)] }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.stage).toBe(STRUCTURED_PARENT_STAGE)
    expect(r.assessment.assessment).toBe('in_progress')
    expect(r.assessment.proposedTransition).toBeNull()
  })

  it('2. a DELAYED (retrying) structured parent stays in_progress', () => {
    const id = 's-retry'
    const r = routeParentAssessment(row(id, STRUCTURED_PARENT_STAGE), lanes({}, { delayed: [rootJob(id)] }))
    expect(r.ok && r.assessment.assessment).toBe('in_progress')
  })

  it('3. a retained failed structured root becomes terminal_failed', () => {
    const id = 's-failed'
    const r = routeParentAssessment(row(id, STRUCTURED_PARENT_STAGE), lanes({}, { failed: [rootJob(id)] }))
    expect(r.ok && r.assessment.assessment).toBe('terminal_failed')
  })

  it('4. a completed structured root becomes terminal_success', () => {
    const id = 's-done'
    const r = routeParentAssessment(row(id, STRUCTURED_PARENT_STAGE), lanes({}, { completed: [rootJob(id)] }))
    expect(r.ok && r.assessment.assessment).toBe('terminal_success')
  })

  it('5. a daily parent is assessed on the MAIN snapshot with the daily policy', () => {
    const id = 'd-1'
    // Live on main, absent from structured — the mirror of the structured case.
    const live = routeParentAssessment(row(id, DAILY_PARENT_STAGE), lanes({ active: [rootJob(id)] }, {}))
    expect(live.ok && live.assessment.assessment).toBe('in_progress')

    // Failed-only on main stays conservative under the daily policy.
    const failedOnly = routeParentAssessment(row(id, DAILY_PARENT_STAGE), lanes({ failed: [rootJob(id)] }, {}))
    expect(failedOnly.ok && failedOnly.assessment.assessment).toBe('unknown')
  })

  it('a structured parent is never assessed against the main snapshot', () => {
    const id = 's-cross'
    // Job lives on MAIN only (impossible in practice) — routing must ignore it.
    const r = routeParentAssessment(row(id, STRUCTURED_PARENT_STAGE), lanes({ active: [rootJob(id)] }, {}))
    expect(r.ok && r.assessment.runnable).toBe(0)
    expect(r.ok && r.assessment.assessment).toBe('terminal_removed')
  })

  it('6. an unsupported stage is refused, not defaulted to a lane', () => {
    const r = routeParentAssessment(row('x', 'capital-ingestion'), lanes())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/not a reconcilable flow parent/)
    expect(r.error).toMatch(/refusing to guess/)
  })

  it('works for an already-closed forensic row without changing routing', () => {
    const id = 's-closed'
    const r = routeParentAssessment(row(id, STRUCTURED_PARENT_STAGE, 'failed'), lanes({}, { completed: [rootJob(id)] }))
    expect(r.ok && r.stage).toBe(STRUCTURED_PARENT_STAGE)
    expect(r.ok && r.assessment.dbStatus).toBe('failed')
  })
})

describe('7-9. explicit routing + apply cannot cross lanes', () => {
  it('7. --parent --apply cannot close a LIVE structured parent', () => {
    const id = recordStart({ stage: STRUCTURED_PARENT_STAGE, source: 'queue' }, dbPath)
    const [r] = openParents(dbPath, STRUCTURED_PARENT_STAGE)
    const routed = routeParentAssessment({ ...r, stage: STRUCTURED_PARENT_STAGE },
      { main: emptySnap(), structured: { ...emptySnap(), active: [rootJob(id)] } })
    expect(routed.ok && routed.assessment.assessment).toBe('in_progress')

    // in_progress is not terminal, so apply writes nothing and the row stays open.
    expect(applyTransitions(routed.ok ? [routed.assessment] : [], openDb(dbPath))).toBe(0)
    expect(openParents(dbPath, STRUCTURED_PARENT_STAGE).map(p => p.id)).toEqual([id])
  })

  it('9. applying a DAILY assessment cannot alter a structured parent', () => {
    const daily = recordStart({ stage: DAILY_PARENT_STAGE, source: 'queue' }, dbPath)
    const structured = recordStart({ stage: STRUCTURED_PARENT_STAGE, source: 'queue' }, dbPath)

    const dailyAssessment = assessFlow(daily, 'running', new Date().toISOString(), emptySnap(), DAILY_FLOW_POLICY)
    expect(dailyAssessment.assessment).toBe('terminal_removed')
    expect(applyTransitions([dailyAssessment], openDb(dbPath))).toBe(1)

    const structuredRow = openDbReadOnly(dbPath)
      .prepare('SELECT status FROM pipeline_runs WHERE id = ?').get(structured) as { status: string }
    expect(structuredRow.status).toBe('running')
    expect(openParents(dbPath, STRUCTURED_PARENT_STAGE).map(p => p.id)).toEqual([structured])
  })
})

// ── Applied accounting ─────────────────────────────────────────────────────

describe('10-12. the applied count reflects rows SQLite actually changed', () => {
  const terminalFor = (id: string) =>
    assessFlow(id, 'running', new Date().toISOString(), emptySnap(), DAILY_FLOW_POLICY)

  it('11. a real transition counts one', () => {
    const id = recordStart({ stage: DAILY_PARENT_STAGE, source: 'queue' }, dbPath)
    expect(applyTransitions([terminalFor(id)], openDb(dbPath))).toBe(1)
  })

  it('10. a row already closed by someone else counts ZERO, not one', () => {
    const id = recordStart({ stage: DAILY_PARENT_STAGE, source: 'queue' }, dbPath)
    // Another process closes it between assessment and apply.
    const assessment = terminalFor(id)
    recordEnd(id, { status: 'success' }, dbPath)

    expect(applyTransitions([assessment], openDb(dbPath))).toBe(0)
    // The compare-and-set guard preserved the other process's outcome.
    const after = openDbReadOnly(dbPath)
      .prepare('SELECT status FROM pipeline_runs WHERE id = ?').get(id) as { status: string }
    expect(after.status).toBe('success')
  })

  it('12. combined accounting across lanes and skipped assessments is correct', () => {
    const openDaily      = recordStart({ stage: DAILY_PARENT_STAGE, source: 'queue' }, dbPath)
    const openStructured = recordStart({ stage: STRUCTURED_PARENT_STAGE, source: 'queue' }, dbPath)
    const alreadyClosed  = recordStart({ stage: DAILY_PARENT_STAGE, source: 'queue' }, dbPath)
    recordEnd(alreadyClosed, { status: 'failed' }, dbPath)

    const all = [
      terminalFor(openDaily),                                                            // writes
      assessFlow(openStructured, 'running', new Date().toISOString(),
        { ...emptySnap(), failed: [rootJob(openStructured)] }, STRUCTURED_FLOW_POLICY),  // writes
      terminalFor(alreadyClosed),                                                        // 0 rows
      assessFlow('live', 'running', new Date().toISOString(),
        { ...emptySnap(), active: [rootJob('live')] }, STRUCTURED_FLOW_POLICY),          // skipped
    ]

    const changed = applyTransitions(all, openDb(dbPath))
    expect(changed).toBe(2)
    expect(all.length - changed).toBe(2)          // the CLI's "left untouched" arithmetic
  })

  it('a store reporting no changes field is treated as zero, never as one', () => {
    const noChanges = { prepare: () => ({ run: () => ({}) }) }
    expect(applyTransitions([terminalFor('anything')], noChanges)).toBe(0)
  })
})

// Supplementary to the behavioural routing proofs above: confirm the CLI is
// actually wired to the helper and no longer suppresses the structured lane.
describe('the reconcile CLI uses stage routing', () => {
  const cli = readFileSync(resolve(__dirname, '..', 'bin', 'reconcile.ts'), 'utf-8')

  it('selects the stage column for an explicit parent', () => {
    expect(cli).toMatch(/SELECT id, stage, started_at, status FROM pipeline_runs WHERE id = \?/)
  })

  it('dispatches through routeParentAssessment and exits non-zero on an unsupported stage', () => {
    expect(cli).toContain('routeParentAssessment(row, lanes)')
    expect(cli).toMatch(/if \(!routed\.ok\)[\s\S]{0,120}process\.exit\(2\)/)
  })

  it('no longer blanks the structured lane whenever --parent is present', () => {
    expect(cli).not.toMatch(/explicit !== -1 \? \[\] :/)
  })

  it('snapshots both lanes before routing', () => {
    expect(cli).toContain('const lanes = { main: snap, structured: structuredSnap }')
  })
})
