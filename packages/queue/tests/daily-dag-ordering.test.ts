// THE DAILY DAG MUST ORDER EVERY PRODUCER AFTER WHAT IT READS.
//
// WHAT WENT WRONG, MEASURED IN PRODUCTION. `scenario-simulate` opens
// apps/ai-analysis-engine/data/analysis.json. It depended only on
// `scenario-refresh`, so nothing ordered it after the job that WRITES that file.
// On 2026-09-28 a scheduled run reached it before the analysis existed, it failed
// with ENOENT three times, and eleven parent jobs were left parked in
// `waiting-children` behind it permanently. The queue had to be retired by hand.
//
// A BULLMQ FLOW IS A TREE, which is the constraint that makes this a real design
// decision rather than an added edge: each job has exactly one parent, so a job
// may be depended on only ONCE. Adding `ai-analysis-engine` to
// `scenario-simulate` therefore required removing it from `investment-brief` —
// where the ordering is preserved transitively, through risk-metrics →
// tax-harvest → briefing-backtest → … → scenario-simulate.
//
// These cases assert the shape on BOTH cadences, because the Sunday-only jobs sit
// in the middle of exactly that transitive chain and a weekday run collapses it.

import { describe, it, expect } from 'vitest'

import { DAILY_PIPELINE } from '../src/jobs.js'
import { buildDAGTree, resolveSkips } from '../src/submit.js'
import type { JobSpec } from '../src/jobs.js'

interface Node { name: string; children?: Node[] }

const names = (n: Node, acc: string[] = []): string[] => {
  acc.push(n.name)
  for (const c of n.children ?? []) names(c, acc)
  return acc
}

const find = (n: Node, name: string): Node | undefined =>
  n.name === name ? n : (n.children ?? []).map(c => find(c, name)).find(Boolean)

/** Run a body with the weekday/Sunday clock the cadence rules read. */
function onDay<T>(sunday: boolean, body: () => T): T {
  const real = Date.prototype.getDay
  Date.prototype.getDay = function (): number { return sunday ? 0 : 3 }
  try { return body() } finally { Date.prototype.getDay = real }
}

const treeFor = (sunday: boolean, specs: JobSpec[] = [...DAILY_PIPELINE]) =>
  onDay(sunday, () => {
    const active = resolveSkips(specs)
    return { active, tree: buildDAGTree(active, 'probe') as unknown as Node }
  })

describe('the corrected daily DAG', () => {
  for (const [label, sunday] of [['a weekday', false], ['a Sunday', true]] as const) {
    describe(label, () => {
      it('is one tree containing every active job exactly once', () => {
        const { active, tree } = treeFor(sunday)
        const all = names(tree)
        expect(tree.name, 'the single root').toBe('morning-status')
        expect(all.length, 'one node per active job').toBe(active.length)
        expect(new Set(all).size, 'no job appears twice').toBe(all.length)
        // Non-vacuity: the two cadences really do differ in size.
        expect(active.length).toBeGreaterThan(10)
      })

      it('orders ai-analysis-engine BEFORE scenario-simulate', () => {
        const { tree } = treeFor(sunday)
        const sim = find(tree, 'scenario-simulate')
        expect(sim, 'scenario-simulate is in the tree').toBeDefined()
        // `children` == "this job's dependencies", so a descendant here is an
        // ANCESTOR in execution order: it runs first.
        expect(names(sim as Node), 'the analysis is a dependency of the simulation')
          .toContain('ai-analysis-engine')
      })

      it('keeps risk-metrics and wave-analyzer as the brief\'s direct dependencies', () => {
        const { tree } = treeFor(sunday)
        const brief = find(tree, 'investment-brief')
        expect((brief?.children ?? []).map(c => c.name).sort())
          .toEqual(['risk-metrics', 'wave-analyzer'])
      })

      it('still orders ai-analysis-engine before the brief, transitively', () => {
        const { tree } = treeFor(sunday)
        const brief = find(tree, 'investment-brief')
        expect(names(brief as Node)).toContain('ai-analysis-engine')
      })
    })
  }
})

describe('the graph this replaced is refused, not merely different', () => {
  /** The pre-correction edges, restored exactly. */
  const oldGraph = (): JobSpec[] => [...DAILY_PIPELINE].map(s => {
    if (s.name === 'scenario-simulate') return { ...s, dependsOn: 'scenario-refresh' }
    if (s.name === 'investment-brief') {
      return { ...s, dependsOn: ['ai-analysis-engine', 'risk-metrics', 'wave-analyzer'] }
    }
    return s
  })

  it('the OLD graph does not order the analysis before the simulation', () => {
    // THE DEFECT, REPRODUCED. This is what allowed the ENOENT: the old graph is a
    // perfectly valid tree, which is why nothing caught it — the ordering, not the
    // shape, was wrong.
    for (const sunday of [false, true]) {
      const { tree } = treeFor(sunday, oldGraph())
      const sim = find(tree, 'scenario-simulate')
      expect(names(sim as Node), `old graph, sunday=${String(sunday)}`)
        .not.toContain('ai-analysis-engine')
    }
  })

  it('keeping BOTH edges is refused, because a flow tree has no diamonds', () => {
    // The change is not "add an edge": adding it without removing the brief's
    // gives ai-analysis-engine two parents, and the builder says so.
    const both = [...DAILY_PIPELINE].map(s =>
      s.name === 'investment-brief'
        ? { ...s, dependsOn: ['ai-analysis-engine', 'risk-metrics', 'wave-analyzer'] }
        : s)
    for (const sunday of [false, true]) {
      expect(() => treeFor(sunday, both), `sunday=${String(sunday)}`)
        .toThrow(/reached twice|shared dependency|diamonds/)
    }
  })
})

describe('the builder refuses the shapes a flow cannot express', () => {
  const spec = (name: string, dependsOn?: string | string[]): JobSpec =>
    ({ name, cmd: ['true'], cwd: '.', ...(dependsOn === undefined ? {} : { dependsOn }) } as JobSpec)

  it('refuses a diamond', () => {
    expect(() => buildDAGTree([
      spec('root', ['a', 'b']), spec('a', 'shared'), spec('b', 'shared'), spec('shared'),
    ], 'p')).toThrow(/reached twice|shared dependency/)
  })

  it('refuses a cycle', () => {
    expect(() => buildDAGTree([spec('a', 'b'), spec('b', 'a')], 'p'))
      .toThrow(/no root job found|cycle/)
  })

  it('refuses more than one root', () => {
    expect(() => buildDAGTree([spec('a'), spec('b')], 'p')).toThrow(/exactly one root/)
  })
})
