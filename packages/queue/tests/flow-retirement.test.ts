// RETIRING A FAILED FLOW: what must be measured, bound and refused.
//
// THE OPERATION THIS GUARDS. Removing BullMQ jobs by hand is the most dangerous
// thing in this repository: `removeJob` SREMs the job from its parent's dependency
// set, and an emptied set moves the parent from `waiting-children` to `wait`, where
// a live worker EXECUTES it. Reproduced on an isolated Redis on 2026-08-27. So the
// removal order is a safety property, not a preference, and these cases pin it
// alongside the token that binds everything the decision was made against.
//
// NOTHING HERE TOUCHES PRODUCTION. The plan, binding and token are pure functions
// over fixtures; the WAL case uses a throwaway SQLite file.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { planFlowRemoval, type JobRef } from '../src/flow-cleanup.js'
import {
  FORBIDDEN_STATES, INTENT_PREFIX, OUTCOME_PREFIX, RETIREMENT_BINDING_VERSION,
  RETIREMENT_TOKEN_PREFIX, RetirementRefused, assertRetirable, planDigest,
  retirementBindingDocument, retirementPlan, retirementToken,
  type RetirementBinding, type ScheduledRow,
} from '../src/flow-retirement.js'
import { REVIEWED_PREFIXES } from '@common/db/pg-copy'

const PARENT = '2191e266-78a1-4951-9807-bf4260563463'
const FAILED_A = '6a35fa36-a84d-4344-adc0-27b4446fa769'
const FAILED_B = '235dbf5a-bef1-43e4-b8aa-d73587ab0cbf'

/** The production shape: eleven parked ancestors and two failed leaves. */
const census = (over: Partial<JobRef>[] = []): JobRef[] => {
  const parked = ['morning-status', 'investment-brief', 'risk-metrics', 'tax-harvest',
    'ai-analysis-engine', 'thesis-memory', 'capital-ingestion', 'world-intel-link',
    'briefing-backtest', 'world-intel-dedup', 'world-intel-export']
  const rows: JobRef[] = parked.map((name, i) => ({
    id: `parked-${String(i).padStart(2, '0')}`, name,
    state: 'waiting-children', hasParent: i !== 0,
  }))
  rows.push({ id: FAILED_A, name: 'scenario-simulate', state: 'failed', hasParent: true })
  rows.push({ id: FAILED_B, name: 'world-intel-report', state: 'failed', hasParent: true })
  for (const o of over) {
    const at = rows.findIndex(r => r.id === o.id)
    if (at >= 0) rows[at] = { ...(rows[at] as JobRef), ...o }
    else rows.push(o as JobRef)
  }
  return rows
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

const binding = (over: Partial<RetirementBinding> = {}): RetirementBinding => {
  const c = over.census ?? census()
  return {
    bindingVersion: RETIREMENT_BINDING_VERSION,
    implementationHead: 'a'.repeat(40),
    parentRunId: PARENT,
    queue: 'daily-pipeline',
    row: row(),
    census: c,
    planDigest: planDigest(retirementPlan(PARENT, c)),
    expectedFailedIds: [FAILED_A, FAILED_B],
    redis: { host: '127.0.0.1', port: 6379, db: 0 },
    evidenceRoot: '/Users/x/evidence',
    evidenceRootDeviceInode: '16777229:137253857',
    intent: `supersede-scheduled-run:${PARENT}`,
    ...over,
  }
}

const ok = () => ({
  parentRunId: PARENT, logicalDate: '2026-09-28', row: row(),
  census: census(), expectedFailedIds: [FAILED_A, FAILED_B],
})

describe('the removal plan is ancestors-first', () => {
  it('places every parked ancestor before every failed leaf', () => {
    const plan = retirementPlan(PARENT, census())
    const order = plan.order.map(s => s.state)
    const lastAncestor = order.lastIndexOf('waiting-children')
    const firstLeaf = order.indexOf('failed')
    expect(plan.ancestorsFirst).toBe(true)
    expect(lastAncestor, 'an ancestor is present').toBeGreaterThan(-1)
    expect(firstLeaf, 'a leaf is present').toBeGreaterThan(-1)
    // THE WHOLE SAFETY PROPERTY: removing a leaf first can release its parent.
    expect(lastAncestor).toBeLessThan(firstLeaf)
  })

  it('places the root ancestor before the nested ones', () => {
    const plan = retirementPlan(PARENT, census())
    const rootAt = plan.order.findIndex(s => s.id === 'parked-00')
    const nested = plan.order.findIndex(s => s.id === 'parked-01')
    expect(rootAt).toBeLessThan(nested)
  })

  it('covers every job exactly once', () => {
    const c = census()
    const plan = retirementPlan(PARENT, c)
    expect(plan.order).toHaveLength(c.length)
    expect(new Set(plan.order.map(s => s.id)).size).toBe(c.length)
  })

  it('reorders the plan digest when the order changes', () => {
    const c = census()
    const real = planDigest(retirementPlan(PARENT, c))
    const reversed = planDigest({
      parentRunId: PARENT, ancestorsFirst: true,
      order: [...retirementPlan(PARENT, c).order].reverse(),
    })
    expect(reversed).not.toBe(real)
  })

  it('uses flow-cleanup\'s planner, not a local ordering', () => {
    const c = census()
    expect(retirementPlan(PARENT, c)).toEqual(planFlowRemoval(PARENT, [...c]))
  })
})

describe('what may be retired, and what may not', () => {
  it('accepts the reviewed production shape', () => {
    expect(() => assertRetirable(ok())).not.toThrow()
  })

  // THE STATES ARE LISTED LITERALLY, NOT ITERATED FROM THE CONSTANT.
  //
  // Driving this loop from `FORBIDDEN_STATES` made it vacuous under the one
  // mutation it exists to catch: emptying that array produced ZERO cases and a
  // green run. Measured. The constant is asserted to equal this list separately,
  // so widening or narrowing it is still caught.
  for (const state of ['active', 'wait', 'delayed', 'prioritized'] as const) {
    it(`REFUSES a flow containing a job in ${state}`, () => {
      const c = census([{ id: 'live-1', name: 'x', state, hasParent: true }])
      expect(() => assertRetirable({ ...ok(), census: c })).toThrow(RetirementRefused)
      expect(() => assertRetirable({ ...ok(), census: c })).toThrow(new RegExp(state))
    })
  }

  it('REFUSES an unexpected failed leaf', () => {
    const c = census([{ id: 'surprise', name: 'other', state: 'failed', hasParent: true }])
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

describe('the forbidden-state set itself', () => {
  it('is exactly the four runnable or running states', () => {
    expect([...FORBIDDEN_STATES].sort())
      .toEqual(['active', 'delayed', 'prioritized', 'wait'])
  })

  it('excludes the terminal and parked states a retirement targets', () => {
    for (const ok of ['failed', 'completed', 'waiting-children']) {
      expect(FORBIDDEN_STATES, ok).not.toContain(ok)
    }
  })
})

describe('the confirmation token binds every decided field', () => {
  it('is prefixed and hex', () => {
    expect(retirementToken(binding())).toMatch(
      new RegExp(`^${RETIREMENT_TOKEN_PREFIX}[0-9a-f]{64}$`))
  })

  it('is deterministic for an unchanged world', () => {
    expect(retirementToken(binding())).toBe(retirementToken(binding()))
  })

  /** Every field, one at a time. A field that does not move the token is unbound. */
  const variants: Array<[string, Partial<RetirementBinding>]> = [
    ['implementation head', { implementationHead: 'b'.repeat(40) }],
    ['parent run id', { parentRunId: '00000000-0000-0000-0000-000000000000' }],
    ['queue name', { queue: 'structured-ingestion' }],
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

  // THE PLAN DIGEST IS PINNED IN THESE TWO, DELIBERATELY.
  //
  // A changed job state also changes the removal plan, so leaving both free let
  // the token move for the PLAN's sake while the census contributed nothing —
  // and a mutation dropping `state` and `has_parent` from the census document
  // survived. Measured. Holding the plan digest constant isolates the census.
  it('moves when a job STATE changes, with the same job set and plan', () => {
    const base = binding()
    const changed = census().map(j =>
      j.id === FAILED_A ? { ...j, state: 'completed' } : j)
    expect(retirementToken(binding({ census: changed, planDigest: base.planDigest })))
      .not.toBe(retirementToken(base))
  })

  it('moves when a PARENT RELATIONSHIP changes, with the same plan', () => {
    const base = binding()
    const changed = census().map(j =>
      j.id === 'parked-01' ? { ...j, hasParent: false } : j)
    expect(retirementToken(binding({ census: changed, planDigest: base.planDigest })))
      .not.toBe(retirementToken(base))
  })

  it('does NOT move when the census is merely reported in another order', () => {
    // The census is sorted before digesting; the PLAN's order is bound separately.
    const shuffled = [...census()].reverse()
    expect(retirementToken(binding({ census: shuffled, planDigest: binding().planDigest })))
      .toBe(retirementToken(binding()))
  })
})

describe('the bound document carries no payload, environment or credential', () => {
  it('records identities and states only', () => {
    const text = JSON.stringify(retirementBindingDocument(binding()))
    for (const forbidden of ['"data"', 'password', 'ANTHROPIC', 'postgres://', 'redis://', 'PIPELINE_CREDENTIAL']) {
      expect(text, forbidden).not.toContain(forbidden)
    }
    // …and it does carry what it must.
    expect(text).toContain('removal_plan_digest')
    expect(text).toContain('evidence_root_device_inode')
  })

  it('the CLI never reads a job payload into evidence', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../bin/retire-failed-flow.ts', import.meta.url)), 'utf-8')
    const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    expect(code).not.toMatch(/\.data\b/)
    expect(code).not.toMatch(/process\.env\[/)
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

describe('the evidence is crash-truthful', () => {
  it('publishes the INTENT before the first mutation, and the outcome after', () => {
    // THE ORDERING IS THE PROPERTY. One bundle written at the end cannot tell
    // "nothing happened" from "something happened and was not recorded". Asserted
    // against the CLI's own source because that is where the order lives.
    const src = readFileSync(
      fileURLToPath(new URL('../bin/retire-failed-flow.ts', import.meta.url)), 'utf-8')
    const intentAt = src.indexOf(`prefix: INTENT_PREFIX`)
    const removeAt = src.indexOf('removeFlow(writeQueue')
    const supersedeAt = src.indexOf('UPDATE pipeline_runs SET superseded_at')
    const outcomeAt = src.indexOf(`prefix: OUTCOME_PREFIX`)
    for (const [what, at] of [['intent', intentAt], ['removal', removeAt],
                              ['supersede', supersedeAt], ['outcome', outcomeAt]] as const) {
      expect(at, `the CLI contains the ${what} step`).toBeGreaterThan(-1)
    }
    expect(intentAt, 'intent precedes the removal').toBeLessThan(removeAt)
    expect(intentAt, 'intent precedes the supersession').toBeLessThan(supersedeAt)
    expect(removeAt, 'the outcome is published after the removal').toBeLessThan(outcomeAt)
    expect(supersedeAt, 'and after the supersession').toBeLessThan(outcomeAt)
  })

  it('distinguishes all four outcomes', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../bin/retire-failed-flow.ts', import.meta.url)), 'utf-8')
    for (const outcome of ['complete', 'partial', 'refused', 'unknown']) {
      expect(src, outcome).toContain(`'${outcome}'`)
    }
    // …and `unknown` is the state an exception produces, not a silent success.
    expect(src).toMatch(/outcome = 'unknown'/)
  })

  it('never removes ancestors after descendants', () => {
    // The plan is the only ordering the CLI uses; it passes `plan.order` straight
    // to flow-cleanup's remover and never reverses or sorts it locally.
    const src = readFileSync(
      fileURLToPath(new URL('../bin/retire-failed-flow.ts', import.meta.url)), 'utf-8')
    const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    expect(code).toContain('removeFlow(')
    expect(code).not.toMatch(/\.reverse\(\)/)
    expect(code).not.toMatch(/order\.sort\(/)
  })
})

// ── The WAL regression, structural half ────────────────────────────────────
//
// The BEHAVIOURAL half lives in @common/pipeline-runs, which owns the store and
// its better-sqlite3 dependency: see tests/wal-aware-read.test.ts there, where a
// row committed through an active WAL is found by the read-only handle and missed
// by `immutable=1`. This half pins the retirement reader to that path.

describe('the scheduled-run reader is WAL-aware', () => {
  it('opens read-only WITHOUT immutable', () => {
    // Structural, because the mutation this kills is a one-word change to the
    // open. `openDbReadOnly` is the WAL-aware path; `immutable` must appear
    // nowhere in the retirement code.
    const cli = readFileSync(
      fileURLToPath(new URL('../bin/retire-failed-flow.ts', import.meta.url)), 'utf-8')
    const code = cli.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    expect(code).toContain('openDbReadOnly(')
    expect(code).not.toContain('immutable')
  })
})
