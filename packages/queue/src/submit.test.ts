import { describe, it, expect } from 'vitest'
import { resolveSkips, buildDAGTree } from './submit.js'
import { DAILY_PIPELINE, STRUCTURED_INGESTION_JOB } from './jobs.js'
import type { JobSpec } from './types.js'

const job = (name: string, opts: Partial<JobSpec> = {}): JobSpec => ({
  name,
  cmd: ['true'],
  cwd: '.',
  ...opts,
})

describe('resolveSkips', () => {
  it('rewires a downstream job past a skipped middle job to its live ancestor', () => {
    const specs = [
      job('a'),
      job('b', { dependsOn: 'a', skipIf: () => true }),
      job('c', { dependsOn: 'b' }),
    ]
    const active = resolveSkips(specs)
    expect(active.map(s => s.name)).toEqual(['a', 'c'])
    const c = active.find(s => s.name === 'c')!
    expect(c.dependsOn).toBe('a')
  })

  it('collapses dependsOn to undefined when every ancestor is skipped', () => {
    const specs = [
      job('a', { skipIf: () => true }),
      job('b', { dependsOn: 'a' }),
    ]
    const active = resolveSkips(specs)
    const b = active.find(s => s.name === 'b')!
    expect(b.dependsOn).toBeUndefined()
  })
})

describe('buildDAGTree', () => {
  // Names present anywhere in a built BullMQ flow tree.
  const namesIn = (node: ReturnType<typeof buildDAGTree>): string[] => {
    const out: string[] = [node.name]
    for (const c of (node.children ?? [])) out.push(...namesIn(c as ReturnType<typeof buildDAGTree>))
    return out
  }

  it('1/3. builds one valid single-root daily flow that still reaches article collection', () => {
    const active = resolveSkips(DAILY_PIPELINE)
    const tree = buildDAGTree(active, 'run-1')          // throws on 0 or >1 roots
    expect(namesIn(tree)).toContain('world-intel-collect')
  })

  it('2/8/9. structured ingestion is absent from the daily flow entirely, so it cannot be an ancestor of anything', () => {
    const active = resolveSkips(DAILY_PIPELINE)
    // Absent from the spec list...
    expect(active.some(s => s.name === 'world-intel-pipeline')).toBe(false)
    // ...and from the built tree, so no article stage can be blocked behind it
    // and it cannot fail the daily parent through dependency ancestry.
    expect(namesIn(buildDAGTree(active, 'run-1'))).not.toContain('world-intel-pipeline')
    // Nothing depends on it either.
    expect(active.filter(s => {
      const d = s.dependsOn
      return Array.isArray(d) ? d.includes('world-intel-pipeline') : d === 'world-intel-pipeline'
    })).toEqual([])
  })

  it('4. article ordering is unchanged: collect -> score -> report -> dedup -> link', () => {
    const byName = new Map(resolveSkips(DAILY_PIPELINE).map(spec => [spec.name, spec]))
    expect(byName.get('world-intel-collect')?.dependsOn).toBeUndefined()
    expect(byName.get('world-intel-score')?.dependsOn).toBe('world-intel-collect')
    expect(byName.get('world-intel-report')?.dependsOn).toBe('world-intel-score')
    expect(byName.get('world-intel-dedup')?.dependsOn).toBe('world-intel-report')
    expect(byName.get('world-intel-link')?.dependsOn).toBe('world-intel-dedup')
  })

  it('5. on a weekday the Sunday-only memory stage is skipped and export rewires to link', () => {
    const prev = process.env.FORCE_SUNDAY
    delete process.env.FORCE_SUNDAY
    const realDay = Date.prototype.getDay
    // eslint-disable-next-line no-extend-native
    Date.prototype.getDay = function () { return 3 }        // Wednesday
    try {
      const byName = new Map(resolveSkips(DAILY_PIPELINE).map(s => [s.name, s]))
      expect(byName.has('world-intel-memory')).toBe(false)
      expect(byName.get('world-intel-export')?.dependsOn).toBe('world-intel-link')
    } finally {
      Date.prototype.getDay = realDay
      if (prev !== undefined) process.env.FORCE_SUNDAY = prev
    }
  })

  it('6. on Sunday the chain remains link -> memory -> export', () => {
    const prev = process.env.FORCE_SUNDAY
    process.env.FORCE_SUNDAY = '1'
    try {
      const byName = new Map(resolveSkips(DAILY_PIPELINE).map(s => [s.name, s]))
      expect(byName.get('world-intel-memory')?.dependsOn).toBe('world-intel-link')
      expect(byName.get('world-intel-export')?.dependsOn).toBe('world-intel-memory')
    } finally {
      if (prev === undefined) delete process.env.FORCE_SUNDAY
      else process.env.FORCE_SUNDAY = prev
    }
  })

  it('7. the independent structured job is a structurally valid single-root flow on its own', () => {
    const tree = buildDAGTree([STRUCTURED_INGESTION_JOB], 'structured-1')
    expect(tree.name).toBe('world-intel-pipeline')
    expect(tree.children ?? []).toHaveLength(0)
  })

  it('preserves the structured job\'s existing timeout and command contract', () => {
    expect(STRUCTURED_INGESTION_JOB.cmd).toEqual(['npm', 'run', 'pipeline'])
    expect(STRUCTURED_INGESTION_JOB.cwd).toBe('apps/world-intelligence-data-hub-')
    expect(STRUCTURED_INGESTION_JOB.timeoutMs).toBe(30 * 60 * 1000)
  })

  it('throws when the DAG has a cycle (no root found)', () => {
    const specs = [
      job('a', { dependsOn: 'b' }),
      job('b', { dependsOn: 'a' }),
    ]
    expect(() => buildDAGTree(specs, 'run-1')).toThrow(/cycle/)
  })

  it('throws when a job is reachable via two paths (diamond dependency)', () => {
    const specs = [
      job('root', { dependsOn: ['b', 'c'] }),
      job('b', { dependsOn: 'd' }),
      job('c', { dependsOn: 'd' }),
      job('d'),
    ]
    expect(() => buildDAGTree(specs, 'run-1')).toThrow(/reached twice/)
  })
})
