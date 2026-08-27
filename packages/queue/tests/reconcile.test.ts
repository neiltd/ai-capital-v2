import { describe, it, expect } from 'vitest'
import { assessFlow, type QueueSnapshot } from '../src/reconcile.js'

// Terminal-event reconciliation cases.
//
// The invariant: if a DAG can no longer make progress, its persisted parent must
// eventually stop saying `running` — but a STALL is not terminal. A stall
// followed by legitimate redelivery is the ordinary case on a laptop that
// suspends, and concluding `failed` from it would be worse than concluding late.

const P = 'parent-run-1'
const OTHER = 'parent-run-2'
const empty: QueueSnapshot = {
  active: [], wait: [], delayed: [], prioritized: [], waitingChildren: [], failed: [], completed: [],
}
const job = (name: string, parentRunId = P, isRoot = false) => ({ id: `${name}-id`, name, data: { parentRunId, isRoot } })
const snap = (o: Partial<QueueSnapshot>): QueueSnapshot => ({ ...empty, ...o })
const assess = (s: QueueSnapshot) => assessFlow(P, 'running', '2026-08-27T14:00:00Z', s)

describe('root completion', () => {
  it('is terminal success', () => {
    const a = assess(snap({ completed: [job('morning-status', P, true), job('investment-brief')] }))
    expect(a.assessment).toBe('terminal_success')
    expect(a.proposedTransition).toBe('running -> success')
  })
  it('another flow\'s root does not close this one', () => {
    const a = assess(snap({ completed: [job('morning-status', OTHER, true)], waitingChildren: [job('investment-brief')] }))
    expect(a.assessment).toBe('terminal_failed')
  })
})

describe('a stall is NOT terminal', () => {
  it('a pending retry in `delayed` keeps the flow in progress', () => {
    // The exact shape of stall-then-redelivery. Reading this as terminal would
    // fail a run that is about to continue normally.
    const a = assess(snap({ delayed: [job('world-intel-pipeline')], waitingChildren: [job('investment-brief')] }))
    expect(a.assessment).toBe('in_progress')
    expect(a.proposedTransition).toBeNull()
  })
  it('an active job keeps the flow in progress even with failures present', () => {
    const a = assess(snap({ active: [job('capital-ingestion')], failed: [job('world-intel-pipeline')] }))
    expect(a.assessment).toBe('in_progress')
  })
  it('a job in wait keeps the flow in progress', () => {
    expect(assess(snap({ wait: [job('thesis-memory')] })).assessment).toBe('in_progress')
  })
  it('runnable always wins, whatever else is true', () => {
    const a = assess(snap({
      prioritized: [job('x')], waitingChildren: [job('y')], failed: [job('z')], completed: [job('w')],
    }))
    expect(a.assessment).toBe('in_progress')
  })
})

describe('permanently blocked dependency chain', () => {
  it('is terminal failed — the 2026-08-26 and 2026-08-27 shape', () => {
    const a = assess(snap({
      waitingChildren: [job('investment-brief'), job('morning-status')],
      failed: [job('world-intel-pipeline')],
      completed: [job('capital-ingestion')],
    }))
    expect(a.assessment).toBe('terminal_failed')
    expect(a.reason).toMatch(/can never be released/)
  })
  it('reports the evidence it used, not just a verdict', () => {
    const a = assess(snap({ waitingChildren: [job('a'), job('b')], failed: [job('c')] }))
    expect(a.blocked).toBe(2)
    expect(a.failed).toBe(1)
    expect(a.runnable).toBe(0)
  })
})

describe('explicit flow removal / worker disappearance', () => {
  it('no jobs at all is terminal removed', () => {
    const a = assess(empty)
    expect(a.assessment).toBe('terminal_removed')
    expect(a.proposedTransition).toBe('running -> failed')
  })
  it('another flow\'s jobs do not count as this flow\'s', () => {
    const a = assess(snap({ active: [job('x', OTHER)], waitingChildren: [job('y', OTHER)] }))
    expect(a.assessment).toBe('terminal_removed')
  })
})

describe('refuses to guess', () => {
  it('failures with nothing parked, nothing runnable and no root is UNKNOWN', () => {
    // Not a shape we have observed. A wrong `failed` on a live run is worse
    // than a late one on a dead run, so this reports and changes nothing.
    const a = assess(snap({ failed: [job('a')], completed: [job('b')] }))
    expect(a.assessment).toBe('unknown')
    expect(a.proposedTransition).toBeNull()
    expect(a.reason).toMatch(/refusing to guess/)
  })
  it('unknown never proposes a transition', () => {
    expect(assess(snap({ failed: [job('a')] })).proposedTransition).toBeNull()
  })
})

describe('acceptance fixtures from the real incidents', () => {
  it('2026-08-26: 11 blocked, 1 failed, 8 completed, no root -> terminal_failed', () => {
    const a = assess(snap({
      waitingChildren: Array.from({ length: 11 }, (_, i) => job(`parked-${i}`)),
      failed: [job('world-intel-pipeline')],
      completed: Array.from({ length: 8 }, (_, i) => job(`done-${i}`)),
    }))
    expect(a.assessment).toBe('terminal_failed')
    expect(a.blocked).toBe(11)
  })
  it('2026-08-27: 7 blocked, 2 failed, 11 completed, no root -> terminal_failed', () => {
    const a = assess(snap({
      waitingChildren: Array.from({ length: 7 }, (_, i) => job(`parked-${i}`)),
      failed: [job('a'), job('b')],
      completed: Array.from({ length: 11 }, (_, i) => job(`done-${i}`)),
    }))
    expect(a.assessment).toBe('terminal_failed')
    expect(a.blocked).toBe(7)
    expect(a.failed).toBe(2)
  })
})
