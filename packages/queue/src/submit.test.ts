import { describe, it, expect } from 'vitest'
import { resolveSkips, buildDAGTree } from './submit.js'
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
